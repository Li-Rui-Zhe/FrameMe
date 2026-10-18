'use strict';

// SQLite stores files and workspace snapshots on the local server. The browser
// keeps a tab ID and a short-lived recovery copy until a snapshot is committed.
window.FrameLabDraftStore = class {
  constructor(scope) {
    this.scope = scope;
    this.metaKey = 'framelab-workspaces-v1';
    this.tabKey = 'framelab-tab-v1';
    this.pending = null;
    this.writing = null;
    this.lastSavedAt = 0;
  }

  id() {
    return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async initialize() {
    this.tab = sessionStorage.getItem(this.tabKey) || this.id();
    if (navigator.locks) {
      const claim = async tab => new Promise((resolve, reject) => {
        navigator.locks.request('framelab-tab-' + tab, { ifAvailable: true }, lock => {
          resolve(!!lock);
          if (lock) return new Promise(release => { this.release = release; });
        }).catch(reject);
      });
      if (!await claim(this.tab)) {
        // Opening/duplicating a tab can copy sessionStorage from its opener.
        // A live tab already owns that ID, so the new tab must start separately.
        this.tab = this.id();
        sessionStorage.removeItem(this.metaKey);
        sessionStorage.removeItem('framelab-history-v2');
        await claim(this.tab);
      }
    } else if (window.opener && performance.getEntriesByType('navigation')[0]?.type !== 'reload') {
      this.tab = this.id();
      sessionStorage.removeItem(this.metaKey);
      sessionStorage.removeItem('framelab-history-v2');
    }
    sessionStorage.setItem(this.tabKey, this.tab);
    const previousScope = sessionStorage.getItem('framelab-scope-v1');
    if (previousScope && previousScope !== this.scope) {
      sessionStorage.removeItem(this.metaKey);
      sessionStorage.removeItem('framelab-history-v2');
    }
    sessionStorage.setItem('framelab-scope-v1', this.scope);
    window.addEventListener('pagehide', () => this.release?.(), { once: true });
    let metadata;
    try { metadata = JSON.parse(sessionStorage.getItem(this.metaKey) || 'null'); } catch { metadata = null; }
    if (metadata && (metadata.scope !== this.scope || metadata.tab !== this.tab)) {
      if (metadata.scope !== this.scope) sessionStorage.removeItem('framelab-history-v2');
      sessionStorage.removeItem(this.metaKey);
      metadata = null;
    }
    const response = await fetch(this.url('/state'));
    const remote = await this.json(response);
    if (remote.state && (!metadata || remote.state.savedAt > metadata.savedAt)) metadata = remote.state;
    this.lastSavedAt = metadata?.savedAt || 0;
    if (metadata && (!remote.state || metadata.savedAt > remote.state.savedAt)) {
      this.pending = metadata;
      await this.flush();
    }
    return metadata;
  }

  url(path) { return '/api/workspaces/' + this.tab + path; }

  async json(response) {
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '工作区保存失败');
    return data;
  }

  async put(files) {
    this.onStatus?.('saving');
    const body = new FormData();
    files.forEach(file => body.append('files', file));
    body.set('last_modified', JSON.stringify(files.map(file => file.lastModified)));
    const response = await fetch(this.url('/files'), { method: 'POST', body });
    return (await this.json(response)).id;
  }

  async get(id) {
    const response = await fetch(this.url('/files/' + encodeURIComponent(id)));
    if (response.status === 404) return null;
    const data = await this.json(response);
    return Promise.all(data.files.map(async file => {
      const response = await fetch(file.url);
      if (!response.ok) throw new Error('原图草稿无法读取');
      return new File([await response.blob()], file.name, { type: file.mime, lastModified: file.last_modified });
    }));
  }

  async remove(id) {
    if (!id) return;
    const response = await fetch(this.url('/files/' + encodeURIComponent(id)), { method: 'DELETE' });
    if (response.status !== 404) await this.json(response);
  }

  save(workspaces, activeTool, examples) {
    this.onStatus?.('saving');
    this.lastSavedAt = Math.max(Date.now(), this.lastSavedAt + 1);
    this.pending = { schema: 1, scope: this.scope, tab: this.tab, savedAt: this.lastSavedAt, revision: this.id(), activeTool, examples, workspaces };
    sessionStorage.setItem(this.metaKey, JSON.stringify(this.pending));
    this.flush().catch(() => this.onError?.());
  }

  async flush() {
    if (this.writing) return this.writing;
    this.writing = (async () => {
      while (this.pending) {
        const snapshot = this.pending;
        this.pending = null;
        try {
          const response = await fetch(this.url('/state'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot), keepalive: true });
          await this.json(response);
          const recovery = JSON.parse(sessionStorage.getItem(this.metaKey) || 'null');
          if (recovery?.revision === snapshot.revision) sessionStorage.removeItem(this.metaKey);
        } catch (error) {
          this.onStatus?.('error');
          if (!this.pending) this.pending = snapshot;
          throw error;
        }
      }
      this.onStatus?.('saved');
    })();
    try { await this.writing; }
    finally { this.writing = null; }
  }
};
