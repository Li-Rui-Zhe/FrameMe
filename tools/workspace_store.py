"""Private, per-tab workspace snapshots and original image blobs in SQLite."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import threading
import time
import uuid


class SQLiteWorkspaceStore:
    def __init__(self, path, ttl=None):
        self.path = Path(path)
        self.ttl = ttl
        self._schema_lock = threading.Lock()
        self._initialized = False

    @contextmanager
    def connection(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=10)
        connection.execute('PRAGMA foreign_keys=ON')
        try:
            with self._schema_lock:
                if not self._initialized:
                    connection.execute('PRAGMA journal_mode=WAL')
                    connection.executescript('''
                        CREATE TABLE IF NOT EXISTS drafts (
                            id TEXT PRIMARY KEY, owner TEXT NOT NULL,
                            tab TEXT NOT NULL, expires_at REAL NOT NULL
                        );
                        CREATE INDEX IF NOT EXISTS drafts_expiry ON drafts(expires_at);
                        CREATE TABLE IF NOT EXISTS draft_files (
                            draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
                            position INTEGER NOT NULL, name TEXT NOT NULL,
                            mime TEXT NOT NULL, last_modified INTEGER NOT NULL,
                            content BLOB NOT NULL, PRIMARY KEY(draft_id, position)
                        );
                        CREATE TABLE IF NOT EXISTS workspaces (
                            owner TEXT NOT NULL, tab TEXT NOT NULL,
                            state TEXT NOT NULL, updated_ms REAL NOT NULL,
                            expires_at REAL NOT NULL, PRIMARY KEY(owner, tab)
                        );
                        CREATE INDEX IF NOT EXISTS workspaces_expiry ON workspaces(expires_at);
                        CREATE TABLE IF NOT EXISTS job_tabs (
                            job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, tab TEXT NOT NULL
                        );
                    ''')
                    if self.ttl is None:
                        # Preserve legacy rows, including expired rows that have
                        # not been physically cleaned yet. Zero means permanent.
                        connection.execute('UPDATE drafts SET expires_at=0')
                        connection.execute('UPDATE workspaces SET expires_at=0')
                        connection.commit()
                    self._initialized = True
            with connection:
                yield connection
        finally:
            connection.close()

    def cleanup(self, connection):
        if self.ttl is None:
            return
        now = time.time()
        connection.execute('DELETE FROM drafts WHERE expires_at > 0 AND expires_at <= ?', (now,))
        connection.execute('DELETE FROM workspaces WHERE expires_at > 0 AND expires_at <= ?', (now,))

    def expiry(self):
        return 0 if self.ttl is None else time.time() + self.ttl

    def put_files(self, owner, tab, files):
        draft_id = uuid.uuid4().hex
        with self.connection() as connection:
            self.cleanup(connection)
            connection.execute('INSERT INTO drafts VALUES (?, ?, ?, ?)', (draft_id, owner, tab, self.expiry()))
            connection.executemany('INSERT INTO draft_files VALUES (?, ?, ?, ?, ?, ?)', [
                (draft_id, index, item['name'], item['mime'], item['last_modified'], item['content'])
                for index, item in enumerate(files)
            ])
        return draft_id

    def files(self, owner, tab, draft_id):
        with self.connection() as connection:
            self.cleanup(connection)
            if not connection.execute('SELECT 1 FROM drafts WHERE id=? AND owner=? AND tab=?', (draft_id, owner, tab)).fetchone():
                raise FileNotFoundError('原图草稿不存在或不属于当前工作区')
            rows = connection.execute('SELECT position, name, mime, last_modified, length(content) FROM draft_files WHERE draft_id=? ORDER BY position', (draft_id,)).fetchall()
        return [{'position': row[0], 'name': row[1], 'mime': row[2], 'last_modified': row[3], 'size': row[4]} for row in rows]

    def file(self, owner, tab, draft_id, position):
        with self.connection() as connection:
            self.cleanup(connection)
            row = connection.execute('''SELECT f.name, f.mime, f.content FROM draft_files f
                JOIN drafts d ON d.id=f.draft_id WHERE d.id=? AND d.owner=? AND d.tab=? AND f.position=?''',
                (draft_id, owner, tab, position)).fetchone()
        if row is None:
            raise FileNotFoundError('原图草稿不存在或不属于当前工作区')
        return row

    def remove_files(self, owner, tab, draft_id):
        with self.connection() as connection:
            self.cleanup(connection)
            cursor = connection.execute('DELETE FROM drafts WHERE id=? AND owner=? AND tab=?', (draft_id, owner, tab))
            if not cursor.rowcount:
                raise FileNotFoundError('原图草稿不存在或不属于当前工作区')

    def state(self, owner, tab):
        with self.connection() as connection:
            self.cleanup(connection)
            row = connection.execute('SELECT state FROM workspaces WHERE owner=? AND tab=?', (owner, tab)).fetchone()
        return json.loads(row[0]) if row else None

    def save_state(self, owner, tab, state):
        # Late requests from a document being refreshed cannot overwrite a newer
        # snapshot already saved by its successor.
        with self.connection() as connection:
            self.cleanup(connection)
            connection.execute('''INSERT INTO workspaces VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(owner, tab) DO UPDATE SET state=excluded.state,
                updated_ms=excluded.updated_ms, expires_at=excluded.expires_at
                WHERE excluded.updated_ms >= workspaces.updated_ms''',
                (owner, tab, json.dumps(state, ensure_ascii=False), state['savedAt'], self.expiry()))

    def register_jobs(self, owner, tab, ids):
        with self.connection() as connection:
            connection.executemany('INSERT OR IGNORE INTO job_tabs VALUES (?, ?, ?)', [(job_id, owner, tab) for job_id in ids])

    def job_tabs(self, owner):
        with self.connection() as connection:
            return dict(connection.execute('SELECT job_id, tab FROM job_tabs WHERE owner=?', (owner,)))

    def draft_bytes(self, owner, tab=None):
        with self.connection() as connection:
            query = 'SELECT COALESCE(SUM(length(f.content)), 0) FROM draft_files f JOIN drafts d ON d.id=f.draft_id WHERE d.owner=?'
            args = [owner]
            if tab is not None:
                query += ' AND d.tab=?'
                args.append(tab)
            return connection.execute(query, args).fetchone()[0]

    def forget_jobs(self, owner, ids):
        removed = set(ids)
        with self.connection() as connection:
            connection.executemany('DELETE FROM job_tabs WHERE job_id=? AND owner=?', [(job_id, owner) for job_id in ids])
            for tab, raw, updated_ms in connection.execute('SELECT tab, state, updated_ms FROM workspaces WHERE owner=?', (owner,)).fetchall():
                state = json.loads(raw)
                changed = False
                for workspace in state.get('workspaces', {}).values():
                    if workspace.get('jobId') in removed:
                        workspace.update(jobId=None, dirty=False, view='source', group=0, frame=0)
                        changed = True
                if changed:
                    state['savedAt'] = max(time.time() * 1000, updated_ms + 1)
                    connection.execute('UPDATE workspaces SET state=?, updated_ms=? WHERE owner=? AND tab=?',
                                       (json.dumps(state, ensure_ascii=False), state['savedAt'], owner, tab))
