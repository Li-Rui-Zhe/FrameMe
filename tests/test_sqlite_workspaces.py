import io
import json
from pathlib import Path
import re
import tempfile
import time
import unittest
import uuid

from PIL import Image
import app as server
from tools.workspace_store import SQLiteWorkspaceStore


class SQLiteWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=server.BASE_DIR / '.runtime', prefix='test-sqlite-')
        self.previous = server.WORKSPACE_STORE
        self.path = Path(self.directory.name) / 'workspaces.sqlite3'
        server.WORKSPACE_STORE = SQLiteWorkspaceStore(self.path)
        self.a, self.b = server.app.test_client(), server.app.test_client()
        self.responses = []
        self.tab, self.other_tab = uuid.uuid4().hex, uuid.uuid4().hex
        self.base = '/api/workspaces/' + self.tab
        response = self.request(self.a, 'GET', '/')
        self.scope = re.search(rb'name="framelab-workspace-scope" content="([a-f0-9]{64})"', response.data).group(1).decode()
        self.request(self.b, 'GET', '/')
        buffer = io.BytesIO()
        Image.new('RGBA', (8, 8), (17, 29, 101, 123)).save(buffer, 'PNG')
        self.image = buffer.getvalue()

    def tearDown(self):
        for response in self.responses:
            response.close()
            stream = response.request.environ.get('wsgi.input')
            if stream:
                stream.close()
        server.WORKSPACE_STORE = self.previous
        self.directory.cleanup()

    def request(self, client, method, url, **kwargs):
        response = client.open(url, method=method, **kwargs)
        self.responses.append(response)
        return response

    def upload(self, files=None, client=None):
        files = files or [(self.image, '原始图片.png')]
        return self.request(client or self.a, 'POST', self.base + '/files', data={
            'files': [(io.BytesIO(content), name) for content, name in files],
            'last_modified': json.dumps([1700000000000] * len(files)),
        })

    def state(self, **kwargs):
        return dict(schema=1, scope=self.scope, tab=self.tab, savedAt=time.time() * 1000,
                    activeTool='cutout', examples={'cutout': 'star'}, workspaces={
                        'cutout': {'formValues': {'prefix': 'my_image'}, **kwargs},
                    })

    def test_original_bytes_filename_and_time_are_preserved(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201)
        url = self.base + '/files/' + response.json['id']
        listing = self.request(self.a, 'GET', url).json
        self.assertEqual(listing['files'][0]['name'], '原始图片.png')
        self.assertEqual(listing['files'][0]['last_modified'], 1700000000000)
        self.assertEqual(self.request(self.a, 'GET', listing['files'][0]['url']).data, self.image)
        self.assertEqual(self.request(self.a, 'GET', listing['files'][0]['url']).mimetype, 'image/png')

    def test_state_is_stored_in_sqlite_and_restores_without_browser_copy(self):
        state = self.state(draftKey=self.upload().json['id'])
        self.assertEqual(self.request(self.a, 'POST', self.base + '/state', json=state).status_code, 200)
        self.assertEqual(self.request(self.a, 'GET', self.base + '/state').json['state'], state)
        with server.WORKSPACE_STORE.connection() as connection:
            row = connection.execute('SELECT state FROM workspaces').fetchone()
        self.assertEqual(json.loads(row[0]), state)

    def test_other_browser_cannot_read_or_delete_originals(self):
        url = self.base + '/files/' + self.upload().json['id']
        for method, target in [('GET', url), ('GET', url + '/0'), ('DELETE', url)]:
            self.assertEqual(self.request(self.b, method, target).status_code, 404)
        self.assertEqual(self.request(self.a, 'GET', url + '/0').data, self.image)

    def test_same_browser_other_tab_cannot_read_or_delete_originals(self):
        draft_id = self.upload().json['id']
        url = '/api/workspaces/' + self.other_tab + '/files/' + draft_id
        for method, target in [('GET', url), ('GET', url + '/0'), ('DELETE', url)]:
            self.assertEqual(self.request(self.a, method, target).status_code, 404)

    def test_workspace_state_is_isolated_by_owner_and_tab(self):
        state = self.state()
        self.request(self.a, 'POST', self.base + '/state', json=state)
        self.assertIsNone(self.request(self.b, 'GET', self.base + '/state').json['state'])
        self.assertIsNone(self.request(self.a, 'GET', '/api/workspaces/' + self.other_tab + '/state').json['state'])

    def test_reopening_database_keeps_files_and_state(self):
        draft_id = self.upload().json['id']
        state = self.state(draftKey=draft_id)
        self.request(self.a, 'POST', self.base + '/state', json=state)
        server.WORKSPACE_STORE = SQLiteWorkspaceStore(self.path)
        self.assertEqual(self.request(self.a, 'GET', self.base + '/files/' + draft_id + '/0').data, self.image)
        self.assertEqual(self.request(self.a, 'GET', self.base + '/state').json['state'], state)

    def test_legacy_expiry_does_not_delete_files_or_state(self):
        draft_id = self.upload().json['id']
        self.request(self.a, 'POST', self.base + '/state', json=self.state(draftKey=draft_id))
        with server.WORKSPACE_STORE.connection() as connection:
            connection.execute('UPDATE drafts SET expires_at=0')
            connection.execute('UPDATE workspaces SET expires_at=0')
        self.assertEqual(self.request(self.a, 'GET', self.base + '/files/' + draft_id).status_code, 200)
        self.assertIsNotNone(self.request(self.a, 'GET', self.base + '/state').json['state'])
        with server.WORKSPACE_STORE.connection() as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM draft_files').fetchone()[0], 1)

    def test_stale_request_cannot_overwrite_newer_snapshot(self):
        newest = self.state()
        newest['activeTool'] = 'rename'
        self.request(self.a, 'POST', self.base + '/state', json=newest)
        stale = self.state()
        stale['savedAt'] = newest['savedAt'] - 1000
        self.request(self.a, 'POST', self.base + '/state', json=stale)
        self.assertEqual(self.request(self.a, 'GET', self.base + '/state').json['state'], newest)

    def test_invalid_image_batch_is_atomic(self):
        response = self.upload([(self.image, 'valid.png'), (b'broken png', 'broken.png')])
        self.assertEqual(response.status_code, 400)
        with server.WORKSPACE_STORE.connection() as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM drafts').fetchone()[0], 0)

    def test_upload_limit_and_tampered_state_are_rejected(self):
        self.assertEqual(self.upload([(self.image, f'image_{index}.png') for index in range(13)]).status_code, 400)
        state = self.state()
        state['scope'] = '0' * 64
        self.assertEqual(self.request(self.a, 'POST', self.base + '/state', json=state).status_code, 400)
        state['scope'] = self.scope
        state['tab'] = self.other_tab
        self.assertEqual(self.request(self.a, 'POST', self.base + '/state', json=state).status_code, 400)

    def test_original_delete_requires_correct_owner_and_cascades_files(self):
        url = self.base + '/files/' + self.upload().json['id']
        self.assertEqual(self.request(self.a, 'DELETE', url).status_code, 200)
        self.assertEqual(self.request(self.a, 'GET', url + '/0').status_code, 404)
        with server.WORKSPACE_STORE.connection() as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM draft_files').fetchone()[0], 0)

    def test_unsafe_identifiers_and_cross_origin_writes_are_rejected(self):
        self.assertEqual(self.request(self.a, 'GET', '/api/workspaces/invalid/state').status_code, 404)
        response = self.request(self.a, 'POST', self.base + '/state', json=self.state(), headers={'Origin': 'https://other.example'})
        self.assertEqual(response.status_code, 403)
