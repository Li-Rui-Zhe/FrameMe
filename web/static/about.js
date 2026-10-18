'use strict';

(() => {
  const store = new FrameLabDraftStore(document.querySelector('meta[name="framelab-workspace-scope"]').content);
  // Keep the tab claim while reading the introduction too. Opening it in a new
  // tab must not allow a copied sessionStorage ID to inherit another tab's files.
  const ready = store.initialize().then(async () => {
    const data = await store.json(await fetch(store.url('/jobs')));
    document.querySelector('#history-count').textContent = data.jobs.length;
    document.body.dataset.workspaceReady = 'true';
  });
  ready.catch(() => {
    const toast = document.querySelector('#toast');
    toast.textContent = '工作区暂时无法读取，请检查本地服务后刷新。'; toast.hidden = false;
  });
  for (const link of document.querySelectorAll('a[href^="/editor"], a[href="/about"], a[href="/prompts"]')) link.addEventListener('click', async event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const destination = link.href;
    event.preventDefault();
    try { await ready; location.assign(destination); } catch { /* Preserve identity until the service is available. */ }
  });
  const button = document.querySelector('#theme-button');
  function theme(dark) {
    document.body.classList.toggle('dark', dark);
    button.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
    button.setAttribute('aria-label', dark ? '切换浅色主题' : '切换深色主题');
  }
  try { theme(localStorage.getItem('framelab-theme') === 'dark'); } catch { theme(false); }
  button.addEventListener('click', () => {
    const dark = !document.body.classList.contains('dark'); theme(dark);
    try { localStorage.setItem('framelab-theme', dark ? 'dark' : 'light'); } catch {}
  });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();
