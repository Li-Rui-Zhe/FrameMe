import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

from PIL import Image
import app as server
from tools.workspace_store import SQLiteWorkspaceStore


def png():
    stream = io.BytesIO()
    Image.new('RGBA', (12, 10), (160, 80, 40, 180)).save(stream, 'PNG')
    return stream.getvalue()


class PermanentStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='.runtime', prefix='test-retention-')
        self.root = Path(self.temp.name).resolve()
        self.old_dir, self.old_store = server.DATA_DIR, server.WORKSPACE_STORE
        server.DATA_DIR = self.root / 'jobs'
        self.database = self.root / 'workspaces.sqlite3'
        server.WORKSPACE_STORE = SQLiteWorkspaceStore(self.database)
        self.client, self.foreign = server.app.test_client(), server.app.test_client()
        self.client.get('/'); self.foreign.get('/')
        self.tab, self.other = uuid.uuid4().hex, uuid.uuid4().hex
        self.base = '/api/workspaces/' + self.tab
        self.responses = []
        with self.client.session_transaction() as session:
            self.owner = session['owner']
        self.scope = hashlib.sha256(('framelab-drafts:' + self.owner).encode()).hexdigest()

    def tearDown(self):
        for response in self.responses:
            response.close()
        server.DATA_DIR, server.WORKSPACE_STORE = self.old_dir, self.old_store
        self.temp.cleanup()

    def request(self, method, url, client=None, **kwargs):
        response = (client or self.client).open(url, method=method, **kwargs)
        self.responses.append(response)
        return response

    def process(self, tab=None, client=None, mode='rename'):
        body = {'options': json.dumps({'mode': mode}), 'files': (io.BytesIO(png()), 'input.png')}
        if tab is not False:
            body['tab'] = tab or self.tab
        result = self.request('POST', '/api/process', client, data=body)
        self.assertEqual(result.status_code, 201)
        return result.json

    def listing(self, tab=None, scope='tab', client=None):
        response = self.request('GET', '/api/workspaces/' + (tab or self.tab) + '/jobs?scope=' + scope, client)
        self.assertEqual(response.status_code, 200)
        return response.json

    def test_old_results_are_readable_and_exportable_without_modifying_files(self):
        job = self.process()
        manifest = server.DATA_DIR / job['id'] / 'manifest.json'
        before = manifest.read_bytes()
        old = time.time() - 365 * 86400
        os.utime(manifest, (old, old))
        server.cleanup_jobs()
        result = self.request('GET', '/api/jobs/' + job['id'])
        self.assertEqual(result.status_code, 200)
        self.assertIsNone(result.json['expires_at'])
        self.assertEqual(manifest.read_bytes(), before)
        for url in [job['zip_url'], job['sheet_url'], job['groups'][0]['source_url'], job['groups'][0]['frames'][0]['url']]:
            response = self.request('GET', url)
            self.assertEqual(response.status_code, 200)
            response.close()

    def test_legacy_expired_sql_rows_survive_migration_and_restart(self):
        store = server.WORKSPACE_STORE
        item = dict(name='input.png', mime='image/png', last_modified=1, content=png())
        draft = store.put_files(self.owner, self.tab, [item])
        state = dict(schema=1, scope=self.scope, tab=self.tab, savedAt=1, activeTool='rename', workspaces={'rename': {'draftKey': draft}}, examples={})
        store.save_state(self.owner, self.tab, state)
        with store.connection() as connection:
            connection.execute('UPDATE drafts SET expires_at=1')
            connection.execute('UPDATE workspaces SET expires_at=1')
        store = SQLiteWorkspaceStore(self.database)
        self.assertEqual(store.state(self.owner, self.tab), state)
        self.assertEqual(store.file(self.owner, self.tab, draft, 0)[2], png())
        with store.connection() as connection:
            self.assertEqual(connection.execute('SELECT expires_at FROM drafts').fetchone()[0], 0)
            self.assertEqual(connection.execute('SELECT expires_at FROM workspaces').fetchone()[0], 0)

    def test_listing_is_tab_scoped_unless_all_is_explicitly_selected(self):
        first, second = self.process(), self.process(tab=self.other)
        self.assertEqual([job['id'] for job in self.listing()['jobs']], [first['id']])
        all_jobs = self.listing(scope='all')['jobs']
        self.assertEqual({job['id'] for job in all_jobs}, {first['id'], second['id']})
        self.assertEqual(sum(job['current_workspace'] for job in all_jobs), 1)
        self.assertEqual(self.listing(scope='all', client=self.foreign)['jobs'], [])

    def test_legacy_import_only_claims_owned_results_and_keeps_manifest(self):
        legacy = self.process(tab=False)
        manifest = server.DATA_DIR / legacy['id'] / 'manifest.json'
        before = manifest.read_bytes()
        self.assertEqual(self.listing()['jobs'], [])
        self.assertEqual(len(self.listing(scope='all')['jobs']), 1)
        response = self.request('POST', self.base + '/jobs', json={'ids': [legacy['id']]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.listing()['jobs'][0]['id'], legacy['id'])
        self.assertEqual(manifest.read_bytes(), before)
        self.assertEqual(self.request('POST', self.base + '/jobs', self.foreign, json={'ids': [legacy['id']]}).status_code, 404)

    def test_history_has_no_twelve_item_limit_and_survives_store_reopen(self):
        ids = {self.process()['id'] for _ in range(14)}
        server.WORKSPACE_STORE = SQLiteWorkspaceStore(self.database)
        self.assertEqual({job['id'] for job in self.listing()['jobs']}, ids)

    def test_byte_counts_match_actual_task_files_and_original_blobs(self):
        job = self.process()
        draft = server.WORKSPACE_STORE.put_files(self.owner, self.tab, [dict(name='source.png', mime='image/png', last_modified=0, content=png())])
        stats = self.listing()
        expected = sum(path.stat().st_size for path in (server.DATA_DIR / job['id']).iterdir())
        self.assertEqual(stats['bytes'], expected)
        self.assertEqual(stats['draft_bytes'], len(png()))
        self.assertEqual(stats['jobs'][0]['bytes'], expected)
        self.assertTrue(draft)

    def test_delete_removes_result_but_preserves_draft_and_clears_saved_reference(self):
        job = self.process()
        draft = server.WORKSPACE_STORE.put_files(self.owner, self.tab, [dict(name='source.png', mime='image/png', last_modified=0, content=png())])
        state = dict(savedAt=time.time() * 1000, workspaces={'rename': dict(jobId=job['id'], draftKey=draft)})
        server.WORKSPACE_STORE.save_state(self.owner, self.tab, state)
        response = self.request('DELETE', self.base + '/jobs', json={'ids': [job['id']]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['deleted'], [job['id']])
        self.assertEqual(self.request('GET', '/api/jobs/' + job['id']).status_code, 404)
        self.assertEqual(self.listing()['jobs'], [])
        saved = server.WORKSPACE_STORE.state(self.owner, self.tab)
        self.assertIsNone(saved['workspaces']['rename']['jobId'])
        self.assertEqual(saved['workspaces']['rename']['draftKey'], draft)
        self.assertEqual(server.WORKSPACE_STORE.file(self.owner, self.tab, draft, 0)[2], png())

    def test_mixed_owner_batch_is_rejected_before_any_deletion(self):
        mine, theirs = self.process(), self.process(client=self.foreign)
        response = self.request('DELETE', self.base + '/jobs', json={'ids': [mine['id'], theirs['id']]})
        self.assertEqual(response.status_code, 404)
        self.assertTrue((server.DATA_DIR / mine['id']).exists())
        self.assertTrue((server.DATA_DIR / theirs['id']).exists())

    def test_batch_delete_and_failure_keep_accurate_results(self):
        first, second = self.process(), self.process()
        with patch('app.shutil.rmtree', side_effect=PermissionError('busy')):
            response = self.request('DELETE', self.base + '/jobs', json={'ids': [first['id']]})
        self.assertEqual(response.json['deleted'], [])
        self.assertEqual(response.json['failed'], [first['id']])
        self.assertEqual(len(self.listing()['jobs']), 2)
        response = self.request('DELETE', self.base + '/jobs', json={'ids': [first['id'], second['id']]})
        self.assertEqual(set(response.json['deleted']), {first['id'], second['id']})

    def test_invalid_delete_scope_and_cross_origin_are_rejected(self):
        for ids in [[], ['../outside'], ['0' * 32] * 129, None, [True]]:
            self.assertEqual(self.request('DELETE', self.base + '/jobs', json={'ids': ids}).status_code, 400)
        self.assertEqual(self.request('GET', self.base + '/jobs?scope=foreign').status_code, 400)
        self.assertEqual(self.request('DELETE', self.base + '/jobs', json={'ids': ['0' * 32]}, headers={'Origin': 'https://foreign.example'}).status_code, 403)

    def test_cleanup_only_removes_old_incomplete_work_not_saved_results(self):
        saved = self.process()
        old, fresh = server.DATA_DIR / uuid.uuid4().hex, server.DATA_DIR / uuid.uuid4().hex
        old.mkdir(); fresh.mkdir()
        (old / 'partial.png').write_bytes(png())
        stamp = time.time() - 3 * 86400
        os.utime(old, (stamp, stamp))
        manifest = server.DATA_DIR / saved['id'] / 'manifest.json'
        os.utime(manifest, (stamp, stamp))
        server.cleanup_jobs()
        self.assertFalse(old.exists())
        self.assertTrue(fresh.exists())
        self.assertTrue(manifest.exists())

    def test_cookie_survives_browser_restart_without_sharing_other_identity(self):
        self.assertIsNotNone(self.client.get_cookie('framelab_session').expires)
        job = self.process()
        cookie = self.client.get_cookie('framelab_session')
        restored = server.app.test_client()
        restored.set_cookie('framelab_session', cookie.value)
        self.assertEqual(self.request('GET', '/api/jobs/' + job['id'], restored).status_code, 200)
        self.assertEqual(self.request('GET', '/api/jobs/' + job['id'], self.foreign).status_code, 404)


if __name__ == '__main__':
    unittest.main()
