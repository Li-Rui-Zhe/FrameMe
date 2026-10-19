'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icons = {
  split: '序列帧切割', cutout: '背景移除', rename: '批量命名', history: '最近任务',
};
const titles = {
  split: ['一张长图，一段小动画。', '上传长条或网格素材，选好帧数。切割、预览、导出，让灵感连起来。'],
  cutout: ['去掉背景，让主角出场。', '为绿幕、白底等纯色图片留下透明背景，轻松准备下一份创作素材。'],
  rename: ['让素材，排得整整齐齐。', '统一名称，自动编号。把零散图片整理成随时可以使用的素材。'],
  history: ['留住进度，接着创作。', '回到最近的处理结果，继续预览、整理与导出。'],
};
function createWorkspace(tool) { return {
  tool, files: [], source: null, sourceIndex: 0, job: null, groups: [],
  group: 0, images: [], frame: 0, playing: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  view: 'animation', bounds: [], busy: false, dirty: false, demo: true,
  fps: 12, drag: -1, rect: null, picking: false, requestVersion: 0, importing: false,
  formValues: null, example: null, demoFrames: [], demoStrip: null, advanced: false, background: 'checker',
  inputOrigin: null, pendingUploads: [], draftKey: null, promptRecipe: null, exportFormat: tool === 'split' ? 'gif' : tool === 'cutout' ? 'png' : 'zip',
}; }
const workspaces = Object.fromEntries(['split', 'cutout', 'rename', 'history'].map(tool => [tool, createWorkspace(tool)]));
let state = workspaces.split;
let viewGeneration = 0;
let demoFrames = [];
let demoStrip = null;
let bytepetCatalog = null;
let bytepetExample = null;
let exampleVersion = 0;
let exampleLoadingVersion = 0;
const exampleSelections = { split: 'calm', cutout: 'star', rename: 'calm' };
let toastTimer;
let lastFrameTime = 0;
let restoringWorkspace = true;
let historyRows = [];
let historyScope = 'tab';
let historyVersion = 0;
let deletingHistory = false;
let pendingDeleteIds = [];
const historySelection = new Set();
let storageWarning = false;
let exporting = false;
const draftStore = new FrameLabDraftStore($('meta[name="framelab-workspace-scope"]').content);
const form = $('#settings-form');
const canvas = $('#preview-canvas');
const context = canvas.getContext('2d');
const pixelCanvas = document.createElement('canvas');
const pixelContext = pixelCanvas.getContext('2d', { willReadFrequently: true });
draftStore.onError = warnDraftStorage;
draftStore.onStatus = updateSaveStatus;

function updateSaveStatus(status) {
  $('#save-indicator').dataset.status = status;
  $('#save-status').textContent = status === 'saved' ? '工作区已保存' : status === 'error' ? '保存失败，请重试' : '正在保存…';
}

function warnDraftStorage() {
  updateSaveStatus('error');
  if (!storageWarning) {
    storageWarning = true;
    toast('工作区暂存失败，当前操作仍可继续；刷新前请下载结果。', 'warning');
  }
}

function persistWorkspaceState() {
  if (restoringWorkspace || state.importing) return;
  saveWorkspace();
  const saved = {};
  for (const [tool, workspace] of Object.entries(workspaces)) {
    if (tool === 'history') continue;
    saved[tool] = {
      draftKey: workspace.draftKey, fileCount: workspace.files.length, inputOrigin: workspace.inputOrigin,
      formValues: workspace.formValues, sourceIndex: workspace.sourceIndex, bounds: workspace.bounds,
      jobId: workspace.job?.id || null, group: workspace.group, frame: workspace.frame, view: workspace.view,
      dirty: workspace.dirty, fps: workspace.fps, playing: workspace.playing,
      advanced: workspace.advanced, background: workspace.background, exportFormat: workspace.exportFormat, promptRecipe: workspace.promptRecipe,
    };
  }
  try { draftStore.save(saved, state.tool, exampleSelections); return true; }
  catch { warnDraftStorage(); return false; }
}

async function cacheWorkspaceFiles(workspace = state) {
  const previous = workspace.draftKey;
  try {
    workspace.draftKey = workspace.files.length ? await draftStore.put(workspace.files.map(item => item.file)) : null;
    // Commit the reference before removing the previous file revision.
    const importing = workspace.importing;
    workspace.importing = false;
    const committed = persistWorkspaceState();
    workspace.importing = importing;
    if (committed) { await draftStore.flush(); await draftStore.remove(previous); }
  } catch { workspace.draftKey = null; warnDraftStorage(); }
}

function jobGroups(job, tool) {
  return tool === 'rename' ? [{ name: '已命名素材', source_url: job.groups[0].source_url,
    frames: job.groups.flatMap(group => group.frames.map(frame => ({ ...frame, source_name: group.name }))),
  }] : job.groups;
}

async function restoreWorkspaceState(metadata) {
  if (!metadata || metadata.schema !== 1) return;
  let missing = false;
  for (const tool of ['split', 'cutout', 'rename']) {
    const saved = metadata.workspaces?.[tool];
    if (!saved) continue;
    const workspace = workspaces[tool];
    Object.assign(workspace, {
      formValues: saved.formValues, inputOrigin: saved.inputOrigin,
      promptRecipe: ['strip', 'images'].includes(saved.promptRecipe) ? saved.promptRecipe : null,
      exportFormat: ['gif', 'zip', 'png', 'sheet', 'folders'].includes(saved.exportFormat) ? saved.exportFormat : workspace.exportFormat,
      bounds: Array.isArray(saved.bounds) ? saved.bounds : [], dirty: !!saved.dirty,
      fps: [4, 5, 6, 8, 12, 24, 30].includes(saved.fps) ? saved.fps : 12,
      playing: !!saved.playing && !matchMedia('(prefers-reduced-motion: reduce)').matches,
      advanced: !!saved.advanced, background: ['checker', 'white', 'dark'].includes(saved.background) ? saved.background : 'checker',
      view: saved.view === 'source' ? 'source' : 'animation',
    });
    try {
      if (saved.draftKey) {
        const files = await draftStore.get(saved.draftKey);
        if (!files || files.length > 12 || files.reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024) throw new Error('原图文件不可用');
        const loaded = [];
        try {
          for (const file of files) {
            const url = URL.createObjectURL(file);
            try { loaded.push({ file, url, image: await loadImage(url) }); }
            catch (error) { URL.revokeObjectURL(url); throw error; }
          }
        } catch (error) { loaded.forEach(item => URL.revokeObjectURL(item.url)); throw error; }
        workspace.files = loaded;
        workspace.draftKey = saved.draftKey;
        workspace.sourceIndex = Math.max(0, Math.min(saved.sourceIndex || 0, loaded.length - 1));
        workspace.source = loaded[workspace.sourceIndex]?.image || null;
        workspace.demo = !loaded.length;
      } else if (saved.fileCount) { missing = true; }
    } catch { missing = true; }
    if (saved.jobId && /^[a-f0-9]{32}$/.test(saved.jobId)) {
      try {
        const response = await fetch('/api/jobs/' + saved.jobId);
        if (!response.ok) throw new Error('任务文件不可用');
        const job = await response.json();
        if (job.options.mode !== tool) throw new Error('任务工具不匹配');
        workspace.job = job;
        workspace.groups = jobGroups(job, tool);
        workspace.group = Math.max(0, Math.min(saved.group || 0, workspace.groups.length - 1));
        const group = workspace.groups[workspace.group];
        const [source, ...images] = await Promise.all([loadImage(group.source_url), ...group.frames.map(frame => loadImage(frame.url))]);
        workspace.images = images;
        workspace.source = workspace.view === 'source' && workspace.files.length ? workspace.files[workspace.sourceIndex].image : source;
        workspace.frame = Math.max(0, Math.min(saved.frame || 0, images.length - 1));
        workspace.demo = false;
        if (!workspace.files.length) {
          workspace.files = await loadJobOriginals(job);
          workspace.draftKey = null;
          workspace.sourceIndex = Math.min(saved.sourceIndex || 0, workspace.files.length - 1);
          workspace.inputOrigin = 'upload';
          if (workspace.view === 'source') workspace.source = workspace.files[workspace.sourceIndex]?.image || source;
          await cacheWorkspaceFiles(workspace);
        }
      } catch {
        workspace.job = null; workspace.groups = []; workspace.images = [];
        workspace.dirty = false;
        if (workspace.files.length) workspace.view = 'source';
        missing = true;
      }
    } else if (workspace.files.length) workspace.view = 'source';
    if (!workspace.files.length && !workspace.job && (saved.fileCount || saved.jobId)) {
      // A missing draft is an empty user workspace, not a return to the demo.
      workspace.demo = false;
      workspace.view = 'source';
    }
    if (metadata.examples?.[tool]) exampleSelections[tool] = metadata.examples[tool];
  }
  if (missing) toast('部分文件已被删除或丢失；可用原图已恢复，可以继续处理。', 'warning');
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function toast(message, type = '') {
  clearTimeout(toastTimer);
  const element = $('#toast');
  element.textContent = message;
  element.className = 'toast' + (type ? ' ' + type : '');
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, type === 'error' ? 7000 : 4500);
}

function readHistory() {
  try {
    const history = JSON.parse(sessionStorage.getItem('framelab-history-v2') || '[]');
    return Array.isArray(history) ? history.filter(item => item && /^[a-f0-9]{32}$/.test(item.id) && Number.isFinite(item.created_at)).slice(0, 200) : [];
  } catch { return []; }
}

function writeHistory(items) {
  try { sessionStorage.setItem('framelab-history-v2', JSON.stringify(items)); } catch { /* Private browser storage may be unavailable. */ }
  $('#history-count').textContent = items.length;
}

function recordJob(job) {
  const items = readHistory().filter(item => item.id !== job.id);
  items.unshift({
    id: job.id, name: job.groups[0].name, count: job.frame_count, groupCount: job.groups.length,
    created_at: job.created_at, expires_at: job.expires_at, mode: job.options.mode,
    thumbnail: job.groups[0].frames[0].url, fps: state.fps,
  });
  writeHistory(items.slice(0, 200));
}

function getOptions() {
  const splitting = state.tool === 'split';
  const grid = splitting && form.elements.layout.value === 'grid';
  const naming = state.tool === 'rename';
  return {
    mode: state.tool, layout: splitting ? form.elements.layout.value : 'horizontal',
    frames: splitting && !grid ? Number($('#frames').value) : 1, rows: grid ? Number($('#rows').value) : 1, columns: grid ? Number($('#columns').value) : 1,
    size: naming ? 0 : Number($('#size').value), padding: naming ? 0 : Number($('#padding').value), ratio: Number($('#ratio').value),
    prefix: $('#prefix').value.trim(), remove_bg: $('#remove-bg').checked,
    align: $('#align').checked, trim: $('#trim').checked, auto_color: $('#auto-color').checked,
    color: $('#color').value, tolerance: Number($('#tolerance').value), feather: Number($('#feather').value),
    bounds: splitting && state.files.length === 1 && !grid ? state.bounds : [],
  };
}

function syncWorkspaceView() {
  const historyView = state.tool === 'history';
  $('#editor-intro').hidden = historyView;
  $('#workspace-view').hidden = historyView;
  $('#history-view').hidden = !historyView;
  $('#breadcrumb-tool').textContent = icons[state.tool];
  $('#empty-demo').hidden = historyView || !!state.files.length || !!state.job;
  $('#empty-demo').disabled = restoringWorkspace || state.busy || state.importing || !!exampleLoadingVersion && exampleLoadingVersion === exampleVersion;
  $('.creation-context').hidden = historyView;
  $('#creation-tool-name').textContent = icons[historyView ? 'split' : state.tool];
  $('#creation-tool-icon').replaceChildren(icon(state.tool === 'cutout' ? 'cut' : state.tool === 'rename' ? 'type' : 'split'));
  $('#creation-guidance').textContent = state.busy ? '正在处理你的素材…' : state.job && !state.dirty ? '结果已准备好，可以继续修整或直接下载。' : state.files.length ? '素材已就位，接着完成处理。' : '上传图片，开始这次创作。';
  $('#step-process-label').textContent = state.tool === 'cutout' ? '去底与修补' : state.tool === 'rename' ? '统一命名' : '切割与预览';
  if (!historyView) {
    $('#page-title').textContent = state.files.length ? state.files.length === 1 ? state.files[0].file.name : state.files.length + ' 张素材，接着创作。' : state.groups[state.group]?.name || '上传图片，开始这次创作。';
    $('#page-description').textContent = state.tool === 'cutout' ? '自动去底 → 手动修补 → 下载透明图片' : state.tool === 'split' ? '设置帧数 → 预览动画 → 下载素材' : '设置名称 → 连续编号 → 下载素材';
  }
  // A user's image is the focus of the editor. Sample details remain visible
  // only while actually working with a sample.
  $('#retouch-entry').hidden = state.tool !== 'cutout';
  $('#retouch-open').disabled = !state.job || state.dirty || state.busy || state.importing || !state.images.length;
  $('#retouch-entry-hint').textContent = !state.job ? '先点击“移除背景”，再用画笔修整结果。' : state.dirty ? '参数已改变，请重新生成后修补。' : state.job.retouched ? '修补已保存，下载会包含你的修改；也可以继续修补。' : '用画笔擦掉多余部分，也能恢复误删的内容。';
  $('.preview-panel').hidden = !state.files.length && !state.job;
  $('#upload-zone').classList.toggle('empty-upload', !state.files.length && !state.job);
  $('#bytepet-example').hidden = state.inputOrigin !== 'example';
  updateSteps();
}

async function openWorkbench(event) {
  const destination = event?.currentTarget?.href || '/editor';
  if (event?.ctrlKey || event?.metaKey || event?.shiftKey || event?.altKey) return;
  event?.preventDefault();
  if (state.busy || state.importing || restoringWorkspace) return;
  persistWorkspaceState();
  try { await draftStore.flush(); location.assign(destination); }
  catch { toast('进度暂存失败，请先下载结果或重试。', 'error'); }
}

function updateFields() {
  const mode = state.tool;
  $('.frames-heading > span').firstChild.nodeValue = mode === 'rename' ? '素材列表 ' : mode === 'cutout' ? '处理结果 ' : '帧序列 ';
  const layout = form.elements.layout.value;
  $('#split-settings').hidden = mode !== 'split';
  $('#split-settings').disabled = mode !== 'split' || state.busy || state.importing;
  $('#canvas-settings').hidden = mode !== 'split';
  $('#canvas-settings').disabled = mode !== 'split' || state.busy || state.importing;
  if (mode === 'cutout') {
    $('#size').value = '0'; $('#align').checked = false; $('#trim').checked = false;
  }
  $('#background-settings').hidden = mode === 'rename';
  $('#background-settings').disabled = mode === 'rename' || state.busy || state.importing;
  $('#remove-bg-row').hidden = mode === 'cutout';
  $('#background-fields').hidden = mode !== 'cutout' && !$('#remove-bg').checked;
  $('#color').disabled = $('#auto-color').checked || state.busy;
  $('#pick-color').disabled = state.busy || !state.source;
  $('#strip-fields').hidden = layout === 'grid';
  $('#grid-fields').hidden = layout !== 'grid';
  $('#align').disabled = mode !== 'split' || state.busy;
  $('#alignment-fields').hidden = !$('#align').checked || $('#size').value === '0';
  $('#padding').closest('.field').hidden = !$('#align').checked;
  $('#layout-hint').textContent = layout === 'grid' ? '按从左到右、从上到下的顺序切割。' : layout === 'horizontal' ? '从左到右等分；原图模式可拖动裁剪线。' : '从上到下等分；原图模式可拖动裁剪线。';
  $('#ratio-value').textContent = $('#ratio').value + '%';
  $('#tolerance-value').textContent = $('#tolerance').value;
  $('#feather-value').textContent = $('#feather').value;
  $('#color-value').textContent = $('#color').value.toUpperCase();
  $('#filename-number').textContent = mode === 'rename' ? '01' : mode === 'cutout' ? '03' : '04';
  $('#filename-example').textContent = ($('#prefix').value || 'frame') + (state.files.length > 1 && mode !== 'rename' ? '_01' : '') + '_0001.png';
  $('#rename-note').hidden = mode !== 'rename';
  $('#process-button').disabled = !state.files.length || state.busy || state.importing || restoringWorkspace;
  $('#process-button span').textContent = state.busy ? '正在生成…' : mode === 'rename' ? '批量改名' : mode === 'cutout' ? '移除背景' : '生成动画帧';
  $('#process-hint').textContent = state.busy ? '正在生成素材，请稍等片刻。' : state.files.length ? '已导入 ' + state.files.length + ' 张 · 输出透明 PNG' : '先导入素材，或载入示例试试看。';
  if (state.job?.retouched && state.files.length && !state.busy) $('#process-hint').textContent = '重新生成会替换当前修补，原版本可在“最近任务”中找回。';
  $('#processing-progress').hidden = !state.busy;
  $('#crop-button').hidden = !canCrop();
  $('.playback').hidden = mode !== 'split';
  $('[data-view="animation"]').textContent = mode === 'split' ? '动画' : mode === 'rename' ? '命名预览' : '处理结果';
  $('[data-view="source"]').textContent = mode === 'split' ? '原图 / 裁剪' : '原图';
  $('#play-button').disabled = mode !== 'split' || state.view === 'source' || state.images.length < 2;
  $('#previous-frame').disabled = state.view === 'source' || state.images.length < 2;
  $('#next-frame').disabled = state.view === 'source' || state.images.length < 2;
  $('#frame-scrub').disabled = state.view === 'source' || state.images.length < 2;
  updateExportControls();
  $('.output-bar').hidden = !state.job;
  $('#prefix').disabled = state.busy || state.importing;
  $('#advanced-settings').hidden = mode === 'rename';
  $('#cutout-simple-help').hidden = mode !== 'cutout';
  $$('[data-tool], #top-upload, #reset-settings').forEach(button => { button.disabled = state.busy || state.importing || restoringWorkspace; });
  $('#example-select').disabled = state.busy || state.importing || restoringWorkspace || !!exampleLoadingVersion && exampleLoadingVersion === exampleVersion;
  if (restoringWorkspace || exampleLoadingVersion && exampleLoadingVersion === exampleVersion) $$('#example-load, #load-demo, #sidebar-demo, #example-select').forEach(button => { button.disabled = true; });
  syncWorkspaceView();
}

function saveWorkspace() {
  if (state.tool === 'history') return;
  state.formValues = {};
  for (const element of form.elements) {
    if (!element.name || element.type === 'radio' && !element.checked) continue;
    state.formValues[element.name] = element.type === 'checkbox' ? element.checked : element.value;
  }
  state.demoFrames = demoFrames;
  state.formValues.centeringVersion = '1';
  state.demoStrip = demoStrip;
  state.example = bytepetExample;
  state.advanced = $('#advanced-settings').open;
  state.background = $('#preview-stage').dataset.background;
}

function restoreForm() {
  form.reset();
  $('#size').value = '0';
  $('#prefix').value = state.tool === 'rename' ? 'asset' : state.tool === 'cutout' ? 'image' : 'frame';
  $('#remove-bg').checked = state.tool === 'cutout';
  if (state.formValues) {
    for (const [key, value] of Object.entries(state.formValues)) {
      const element = form.elements.namedItem(key);
      if (!element) continue;
      if (element instanceof RadioNodeList) element.value = value;
      else if (element.type === 'checkbox') element.checked = value;
      else element.value = value;
    }
  }
  if (state.tool === 'split' && !state.formValues?.centeringVersion) $('#align').checked = true;
  $('#fps').value = String(state.fps);
  $('#advanced-settings').open = state.advanced;
  $('#preview-stage').dataset.background = state.background;
  $$('.bg-swatch').forEach(button => button.classList.toggle('selected', button.dataset.background === state.background));
}

function renderWorkspace() {
  restoreForm();
  renderUploads();
  renderFrames();
  $$('[data-view]').forEach(button => button.classList.toggle('selected', button.dataset.view === state.view));
  $('#preview-badge').textContent = state.dirty ? '待重新生成' : state.job?.retouched ? '已修补' : state.job ? '已生成' : state.files.length ? '原图' : state.demo ? '示例预览' : '等待导入';
  $('#preview-badge').classList.toggle('done', !!state.job && !state.dirty);
  $('#load-demo').hidden = !state.demo;
  $('#output-status').textContent = state.dirty ? '设置已改变，请重新生成' : state.job ? '结果已生成，可以下载了' : state.files.length ? '图片已准备好' : '先试试示例，或上传图片';
  $('#output-status').classList.toggle('ready', !!state.job && !state.dirty);
  $('#output-description').textContent = state.job ? '选择格式，点击下载即可保存。' : state.files.length ? '使用默认设置点击生成即可，高级选项可以稍后调整。' : '点击上方的一键试用，即可直接得到可下载的结果。';
  const select = $('#group-select');
  select.replaceChildren();
  state.groups.forEach((group, index) => {
    const option = document.createElement('option'); option.value = index; option.textContent = group.name; select.append(option);
  });
  select.hidden = state.groups.length < 2;
  select.value = String(state.group);
  updatePlayButton(); updateFields(); updateSteps(); draw();
  if (state.job && !state.images.length) chooseGroup(state.group);
}

function setTool(tool, { preserveJob = false } = {}) {
  if (state.busy || state.importing || !icons[tool]) return;
  const changed = state.tool !== tool;
  if (changed) {
    saveWorkspace();
    viewGeneration++;
    exampleVersion++;
    state = workspaces[tool];
    demoFrames = state.demoFrames;
    demoStrip = state.demoStrip;
    bytepetExample = state.example;
  }
  state.picking = false;
  canvas.classList.remove('pick-active');
  $$('[data-tool]').forEach(button => {
    button.classList.toggle('active', button.dataset.tool === tool);
    if (button.dataset.tool === tool) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
    button.setAttribute('title', icons[button.dataset.tool]);
    button.setAttribute('aria-label', icons[button.dataset.tool]);
  });
  $('#breadcrumb-tool').textContent = icons[tool];
  document.body.dataset.workspaceTool = tool;
  $('#page-title').textContent = titles[tool][0];
  $('#page-description').textContent = titles[tool][1];
  syncWorkspaceView();
  const url = new URL(location.href);
  if (url.searchParams.get('tool') !== tool) { url.searchParams.set('tool', tool); history.replaceState(null, '', url); }
  if (tool === 'history') { renderHistory(); persistWorkspaceState(); return; }
  renderWorkspace();
  if (bytepetCatalog && (changed || !bytepetExample)) {
    configureExampleSelector(tool);
    chooseBytePetExample(exampleSelections[tool]).catch(error => toast(error.message, 'error'));
  }
  persistWorkspaceState();
}


function clearResult() {
  state.requestVersion++;
  state.job = null;
  state.groups = [];
  state.group = 0;
  state.frame = 0;
  state.dirty = false;
  if (state.files.length) {
    state.demo = false;
    state.images = [];
    state.source = state.files[state.sourceIndex]?.image || state.files[0].image;
    setView('source');
  } else {
    state.inputOrigin = null;
    state.demo = true;
    state.images = demoFrames;
    state.source = demoStrip;
    setView('animation');
  }
  $('#group-select').hidden = true;
  $('#preview-badge').textContent = state.demo ? '示例' : '原图';
  $('#preview-badge').classList.remove('done');
  $('#load-demo').hidden = !state.demo;
  $('#output-status').textContent = state.files.length ? '素材已就位' : '等待导入素材';
  $('#output-status').classList.remove('ready');
  $('#output-description').textContent = state.files.length ? '默认设置已经准备好，点击生成即可。' : '点一键试用即可直接生成并下载结果。';
  updateSteps();
  renderFrames();
  updateFields();
}

function markDirty() {
  if (state.job) {
    state.dirty = true;
    $('#preview-badge').textContent = '上次结果';
    $('#output-status').textContent = '参数已调整';
    $('#output-description').textContent = '当前预览为上次结果，重新处理后即可导出。';
  }
  updateFields();
  updateSteps();
  persistWorkspaceState();
}

function updateSteps() {
  $('#step-upload').className = 'step ' + (state.files.length || state.job ? 'complete' : 'active');
  $('#step-settings').className = 'step ' + (state.job && !state.dirty ? 'complete' : state.files.length ? 'active' : '');
  $('#step-export').className = 'step ' + (state.job && !state.dirty ? 'active' : '');
  for (const step of $$('.creation-context .step')) {
    if (step.classList.contains('active')) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法读取图片，请检查图片是否完整。'));
    image.src = url;
  });
}

async function flushPendingUploads() {
  if (state.busy || state.importing || restoringWorkspace || !state.pendingUploads.length) return;
  const files = state.pendingUploads;
  state.pendingUploads = [];
  await addFiles(files);
}

async function addFiles(fileList, { internal = false, origin = 'upload' } = {}) {
  const incoming = [...fileList];
  if (!incoming.length) return false;
  if (incoming.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
    toast('请选择 PNG、JPG 或 WebP 图片。', 'error'); return false;
  }
  if (restoringWorkspace || state.busy || state.importing && !internal) {
    const queued = [...state.pendingUploads];
    for (const file of incoming) {
      if (!queued.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) queued.push(file);
    }
    if (queued.length > 12 || queued.reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024) {
      toast('待导入图片最多 12 张，总大小不能超过 40 MB。', 'error'); return false;
    }
    state.pendingUploads = queued;
    toast('已收到你的图片，当前任务结束后会自动显示。');
    return false;
  }
  if (state.tool === 'history') setTool('split');
  const workspace = state;
  const generation = viewGeneration;
  const replacing = origin === 'example' || state.inputOrigin === 'example';
  const fromWelcome = !state.files.length;
  const retained = replacing ? [] : state.files;
  const unique = [];
  for (const file of incoming) {
    if (![...retained.map(item => item.file), ...unique].some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) unique.push(file);
  }
  const totalBytes = [...retained.map(item => item.file), ...unique].reduce((sum, file) => sum + file.size, 0);
  if (retained.length + unique.length > 12) { toast('一次最多上传 12 张图片。', 'error'); return false; }
  if (totalBytes > 40 * 1024 * 1024) { toast('上传总大小不能超过 40 MB，请分批处理。', 'error'); return false; }
  if (!unique.length) { toast('这些素材已经在上传列表中了。'); return false; }
  if (!internal) { workspace.importing = true; updateFields(); }
  const added = [];
  try {
    for (const file of unique) {
      const url = URL.createObjectURL(file);
      try {
        const image = await loadImage(url);
        if (image.width * image.height > 24_000_000) throw new Error('原图不能超过 2400 万像素，请先缩小图片。');
        added.push({ file, url, image });
      } catch (error) { URL.revokeObjectURL(url); throw error; }
    }
    if (workspace !== state || generation !== viewGeneration) {
      added.forEach(item => URL.revokeObjectURL(item.url)); return false;
    }
    if (replacing) {
      state.files.forEach(item => URL.revokeObjectURL(item.url));
      state.files = [];
      if (origin === 'upload') {
        state.formValues = null;
        state.fps = 12;
        restoreForm();
        $('#frames').value = '1';
      }
    }
    state.sourceIndex = state.files.length;
    state.files.push(...added);
    state.inputOrigin = origin;
    state.bounds = [];
    state.picking = false;
    state.drag = -1;
    canvas.classList.remove('pick-active');
    if (origin === 'upload' && state.promptRecipe) {
      const recipe = state.promptRecipe;
      form.elements.layout.value = 'horizontal';
      $('#frames').value = recipe === 'strip' ? '6' : '1';
      $('#remove-bg').checked = true;
      $('#auto-color').checked = false;
      $('#color').value = '#33ff00';
      $('#size').value = '512';
      $('#align').checked = state.tool === 'split';
      $('#trim').checked = false;
      $('#tolerance').value = '18';
      $('#feather').value = '8';
      state.fps = 4;
      state.promptRecipe = null;
    }
    clearResult();
    renderUploads();
    await cacheWorkspaceFiles(workspace);
    if (!internal) {
      if (fromWelcome) window.scrollTo({ top: 0, behavior: 'instant' });
      else $('.preview-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    }
    toast((replacing && origin === 'upload' ? '已切换到你的图片，示例已移除。' : '已导入 ' + added.length + ' 张素材。') + (state.tool === 'split' && origin === 'upload' ? ' 如需切帧，请设置帧数后生成。' : ''));
    return true;
  } catch (error) {
    added.forEach(item => URL.revokeObjectURL(item.url));
    toast(error.message, 'error');
    return false;
  } finally {
    if (!internal) {
      workspace.importing = false;
      if (workspace === state) { updateFields(); renderUploads(); persistWorkspaceState(); await flushPendingUploads(); }
    }
  }
}

function renderUploads() {
  const container = $('#upload-list');
  container.replaceChildren();
  state.files.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'upload-item';
    const image = document.createElement('img');
    image.src = item.url;
    image.alt = '';
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'upload-preview';
    preview.setAttribute('aria-label', '预览原图 ' + item.file.name);
    preview.setAttribute('aria-pressed', String(index === state.sourceIndex && state.view === 'source'));
    preview.disabled = state.busy || state.importing;
    preview.addEventListener('click', () => {
      state.sourceIndex = index;
      state.source = item.image;
      setView('source');
      $('.preview-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    });
    const name = document.createElement('span');
    name.textContent = item.file.name;
    name.title = item.file.name;
    const dimensions = document.createElement('small');
    dimensions.textContent = item.image.width + '×' + item.image.height;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', '移除 ' + item.file.name);
    remove.append(icon('close'));
    remove.disabled = state.busy || state.importing;
    remove.addEventListener('click', async () => {
      const workspace = state;
      workspace.importing = true;
      URL.revokeObjectURL(item.url);
      state.files.splice(index, 1);
      state.sourceIndex = Math.max(0, state.sourceIndex - (index <= state.sourceIndex ? 1 : 0));
      state.bounds = [];
      clearResult();
      renderUploads();
      await cacheWorkspaceFiles(workspace);
      workspace.importing = false;
      updateFields(); renderUploads(); persistWorkspaceState(); await flushPendingUploads();
    });
    preview.append(image, name, dimensions);
    row.append(preview, remove);
    container.append(row);
  });
}

function canCrop() {
  return state.tool === 'split' && state.view === 'source' && state.files.length === 1 && form.elements.layout.value !== 'grid' && Number($('#frames').value) > 1 && !state.busy;
}

function cropBounds() {
  if (!state.source) return [];
  const extent = form.elements.layout.value === 'vertical' ? state.source.height : state.source.width;
  const count = Math.max(1, Math.min(128, Number($('#frames').value) || 1));
  if (state.bounds.length === count - 1) return [...state.bounds];
  return Array.from({ length: count - 1 }, (_, index) => Math.floor((index + 1) * extent / count));
}

function setView(view) {
  state.view = view;
  $$('[data-view]').forEach(button => button.classList.toggle('selected', button.dataset.view === view));
  updateFields();
  draw();
  renderUploads();
  persistWorkspaceState();
}

function renderFrames() {
  const container = $('#frame-list');
  container.replaceChildren();
  const frames = state.job ? state.groups[state.group]?.frames || [] : [];
  if (!state.images.length) {
    const note = document.createElement('span');
    note.className = 'muted frame-empty';
    note.textContent = state.tool === 'split' ? '处理完成后，切割结果会出现在这里。' : '处理完成后，透明 PNG 会出现在这里。';
    container.append(note);
  } else {
    state.images.forEach((image, index) => {
      const button = document.createElement('button');
      button.className = 'frame-card' + (index === state.frame ? ' active' : '');
      button.type = 'button';
      button.setAttribute('aria-label', '查看第 ' + (index + 1) + ' 帧');
      button.setAttribute('aria-pressed', index === state.frame ? 'true' : 'false');
      const thumb = document.createElement('img');
      thumb.src = image.src;
      thumb.alt = '';
      thumb.className = 'checker';
      const label = document.createElement('span');
      label.textContent = state.tool === 'rename' ? (frames[index]?.filename || ($('#prefix').value || 'asset') + '_' + String(index + 1).padStart(4, '0') + '.png') : String(index + 1).padStart(2, '0');
      if (state.tool === 'rename') button.classList.add('named-card');
      button.title = frames[index]?.filename || '示例帧 ' + (index + 1);
      button.append(thumb, label);
      if (state.tool === 'rename') {
        const before = document.createElement('small');
        before.className = 'frame-source-name';
        before.textContent = frames[index]?.source_name || bytepetExample?.frame_files?.[index]?.split('/').pop() || '';
        button.insertBefore(before, label);
        button.title = before.textContent + ' → ' + label.textContent;
      }
      button.addEventListener('click', () => {
        state.playing = false;
        state.frame = index;
        setView('animation');
        updatePlayButton();
        draw();
      });
      container.append(button);
    });
  }
  $('#frame-count').textContent = String(state.images.length).padStart(2, '0') + (state.tool === 'split' ? ' 帧' : ' 张');
  $('#frame-scrub').max = Math.max(0, state.images.length - 1);
  $('#frame-scrub').value = state.frame;
  $('#frames-hint').textContent = state.images.length ? '点击单帧查看细节' : '等待处理';
  updatePlayButton();
}

function updatePlayButton() {
  $('#play-button').replaceChildren(icon(state.playing ? 'pause' : 'play'));
  $('#play-button').setAttribute('aria-label', state.playing ? '暂停动画' : '播放动画');
}

function draw() {
  if (!context || $('#workspace-view').hidden) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  const image = state.view === 'source' ? state.source : state.images[state.frame];
  if (!image) {
    state.rect = null;
    context.fillStyle = '#99a18e';
    context.font = '12px "Segoe UI", "Microsoft YaHei"';
    context.textAlign = 'center';
    context.fillText('导入素材，开始你的创作', width / 2, height / 2);
    $('#canvas-info').textContent = '—';
    $('#frame-indicator').textContent = 'FRAME —';
    $('#stage-label').textContent = restoringWorkspace ? '正在恢复工作区…' : '等待导入素材';
    return;
  }
  const maxWidth = Math.max(1, width - 50);
  const maxHeight = height - 96;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, state.view === 'source' ? 3 : 1.15);
  const drawW = image.width * scale;
  const drawH = image.height * scale;
  const x = (width - drawW) / 2;
  const y = (height - drawH) / 2;
  state.rect = { x, y, w: drawW, h: drawH, scale };
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, x, y, drawW, drawH);
  if (state.view === 'source' && state.tool === 'split') {
    context.save();
    context.strokeStyle = '#da7547';
    context.lineWidth = 1.25;
    context.setLineDash([4, 4]);
    const layout = form.elements.layout.value;
    if (layout === 'grid') {
      const columns = Math.max(1, Math.min(32, Number($('#columns').value) || 1));
      const rows = Math.max(1, Math.min(32, Number($('#rows').value) || 1));
      for (let column = 1; column < columns; column++) {
        context.beginPath(); context.moveTo(x + drawW * column / columns, y); context.lineTo(x + drawW * column / columns, y + drawH); context.stroke();
      }
      for (let row = 1; row < rows; row++) {
        context.beginPath(); context.moveTo(x, y + drawH * row / rows); context.lineTo(x + drawW, y + drawH * row / rows); context.stroke();
      }
    } else {
      const horizontal = layout === 'horizontal';
      cropBounds().forEach((boundary, index) => {
        const lineX = horizontal ? x + boundary * scale : x;
        const lineY = horizontal ? y : y + boundary * scale;
        context.beginPath();
        context.moveTo(lineX, lineY);
        context.lineTo(horizontal ? lineX : x + drawW, horizontal ? y + drawH : lineY);
        context.stroke();
        if (canCrop()) {
          context.setLineDash([]);
          context.fillStyle = state.drag === index ? '#ad512c' : '#da7547';
          context.beginPath(); context.arc(lineX, lineY, 7, 0, Math.PI * 2); context.fill();
          context.fillStyle = '#fff'; context.font = '8px monospace'; context.textAlign = 'center';
          context.fillText(String(index + 1), lineX, lineY + 3);
          context.setLineDash([4, 4]);
        }
      });
    }
    context.restore();
  }
  $('#canvas-info').textContent = image.width + ' × ' + image.height + ' px';
  $('#frame-indicator').textContent = state.view === 'source' ? (canCrop() ? '拖动裁剪线调整' : 'SOURCE IMAGE') : (state.tool === 'split' ? 'FRAME ' : 'IMAGE ') + String(state.frame + 1).padStart(2, '0') + ' / ' + String(state.images.length).padStart(2, '0');
  $('#stage-label').textContent = state.demo ? (bytepetExample ? (state.tool === 'cutout' ? 'ORIGINAL / ' : 'BYTEPET / ') + bytepetExample.key.toUpperCase() : 'DEMO / FLOATING FRIEND') : state.view === 'source' && state.files.length ? state.files[state.sourceIndex]?.file.name : state.job && state.tool === 'rename' ? state.groups[0]?.frames[state.frame]?.filename : state.job ? state.groups[state.group]?.name : state.files[state.sourceIndex]?.file.name || '素材预览';
  if (state.view === 'animation') {
    $('#frame-scrub').value = state.frame;
    $$('.frame-card').forEach((card, index) => {
      const active = index === state.frame;
      if (card.classList.contains('active') !== active) {
        card.classList.toggle('active', active);
        card.setAttribute('aria-pressed', String(active));
      }
    });
  }
}

async function chooseGroup(index) {
  const workspace = state;
  const generation = viewGeneration;
  const version = ++state.requestVersion;
  state.group = index;
  const group = state.groups[index];
  if (!group) return;
  $('#group-select').value = String(index);
  if (state.files.length) state.sourceIndex = state.tool === 'rename' ? 0 : index;
  state.playing = false;
  state.images = [];
  state.frame = 0;
  renderFrames();
  draw();
  try {
    const [source, ...images] = await Promise.all([loadImage(group.source_url), ...group.frames.map(frame => loadImage(frame.url))]);
    if (workspace !== state || generation !== viewGeneration || version !== workspace.requestVersion) return;
    state.source = source;
    state.images = images;
    state.playing = state.tool === 'split' && images.length > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    setView('animation');
    renderFrames();
    updateFields();
    draw();
  } catch (error) { if (workspace === state && generation === viewGeneration && version === workspace.requestVersion) toast('预览加载失败，可以重新打开任务或直接下载 ZIP。', 'error'); }
}

async function showJob(job, { restore = false } = {}) {
  if (restore) {
    setTool(job.options.mode, { preserveJob: true });
    const remembered = readHistory().find(item => item.id === job.id);
    if (remembered && [4, 5, 6, 8, 12, 24, 30].includes(remembered.fps)) {
      state.fps = remembered.fps; $('#fps').value = String(remembered.fps);
    }
    form.reset();
    for (const [key, value] of Object.entries(job.options)) {
      const element = form.elements.namedItem(key);
      if (!element) continue;
      if (element instanceof RadioNodeList) element.value = value;
      else if (element.type === 'checkbox') element.checked = value;
      else element.value = String(value);
    }
    state.files.forEach(item => URL.revokeObjectURL(item.url));
    state.files = [];
    state.inputOrigin = null;
    state.bounds = [];
    renderUploads();
  }
  state.demo = false;
  state.dirty = false;
  state.job = job;
  state.groups = jobGroups(job, state.tool);
  $('#load-demo').hidden = true;
  $('#preview-badge').textContent = job.retouched ? '已修补' : '已处理';
  $('#preview-badge').classList.add('done');
  $('#output-status').textContent = job.frame_count + (state.tool === 'split' ? ' 帧' : ' 张') + '已生成，可以下载了';
  $('#output-status').classList.add('ready');
  updateExportControls();
  const select = $('#group-select');
  select.replaceChildren();
  state.groups.forEach((group, index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = group.name;
    select.append(option);
  });
  select.hidden = state.groups.length < 2;
  select.value = '0';
  recordJob(job);
  updateFields();
  updateSteps();
  if (restore) await cacheWorkspaceFiles();
  await chooseGroup(0);
  persistWorkspaceState();
  try { await draftStore.flush(); } catch { warnDraftStorage(); }
}

async function loadJobOriginals(job) {
  const originals = [];
  try {
    for (const group of job.groups) {
      const response = await fetch(group.source_url);
      if (!response.ok) throw new Error('任务的原图副本无法读取。');
      const file = new File([await response.blob()], group.name, { type: 'image/png' });
      const url = URL.createObjectURL(file);
      try { originals.push({ file, url, image: await loadImage(url) }); }
      catch (error) { URL.revokeObjectURL(url); throw error; }
    }
    return originals;
  } catch (error) { originals.forEach(item => URL.revokeObjectURL(item.url)); throw error; }
}

async function openSavedJob(job) {
  setTool(job.options.mode, { preserveJob: true });
  const workspace = state;
  workspace.busy = true; updateFields();
  let originals;
  try {
    originals = await loadJobOriginals(job);
    await showJob(job, { restore: true });
    workspace.files = originals;
    workspace.sourceIndex = 0;
    workspace.inputOrigin = 'upload';
    workspace.bounds = [...(job.options.bounds || [])];
    await cacheWorkspaceFiles(workspace);
    renderUploads(); persistWorkspaceState();
  } catch (error) {
    if (originals && workspace.files !== originals) originals.forEach(item => URL.revokeObjectURL(item.url));
    throw error;
  } finally { workspace.busy = false; updateFields(); await flushPendingUploads(); }
}

async function processFiles(event) {
  event.preventDefault();
  if (state.busy || state.importing || !state.files.length || !form.reportValidity()) return;
  state.busy = true;
  updateFields();
  $$('[data-tool], #top-upload, #sidebar-demo, #load-demo, #reset-settings, #example-select, #example-load').forEach(button => { button.disabled = true; });
  renderUploads();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 120_000);
  try {
    const payload = new FormData();
    payload.set('tab', draftStore.tab);
    payload.set('options', JSON.stringify(getOptions()));
    state.files.forEach(item => payload.append('files', item.file));
    const response = await fetch('/api/process', { method: 'POST', body: payload, signal: timeout.signal });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '处理失败，请稍后重试。');
    await showJob(data);
    toast(data.warnings.length ? data.warnings.join('；') : '生成完成，选好格式后点击下载即可保存。', data.warnings.length ? 'warning' : '');
  } catch (error) {
    toast(error.name === 'AbortError' ? '处理等待超时，请缩小图片或分批处理。' : error.message || '服务连接失败，请检查本地服务是否运行。', 'error');
  } finally {
    clearTimeout(timer);
    state.busy = false;
    $$('[data-tool], #top-upload, #sidebar-demo, #load-demo, #reset-settings, #example-select, #example-load').forEach(button => { button.disabled = false; });
    updateFields();
    renderUploads();
    updateSteps();
    persistWorkspaceState();
    await flushPendingUploads();
  }
}

function updateExportControls() {
  const picker = $('#export-format');
  const cutout = state.tool === 'cutout';
  const count = state.groups.reduce((total, group) => total + group.frames.length, 0);
  // Background removal downloads the processed images directly, without animation formats.
  picker.closest('.format-picker').hidden = cutout;
  if (cutout) state.exportFormat = count > 1 ? 'zip' : 'png';
  // Renaming keeps independent images; GIF exports one source sequence only.
  picker.querySelector('[value="gif"]').disabled = state.tool === 'rename';
  if (state.tool === 'rename' && state.exportFormat === 'gif') state.exportFormat = 'zip';
  picker.value = state.exportFormat;
  picker.disabled = $('#quick-download').disabled = !state.job || state.dirty || state.busy || state.importing || exporting;
  $('#quick-download').innerHTML = '<svg class="icon"><use href="#i-download"></use></svg> ' + (exporting ? '正在准备…' : '下载 ' + (['gif', 'png', 'sheet'].includes(picker.value) ? picker.value === 'gif' ? 'GIF' : 'PNG' : 'ZIP'));
  if (cutout && !exporting) $('#quick-download').innerHTML = '<svg class="icon"><use href="#i-download"></use></svg> ' + (count > 1 ? '下载全部透明图片（ZIP）' : '下载透明 PNG');
  const hints = {
    gif: '当前选中序列 · ' + state.fps + ' FPS · 循环播放；GIF 不保留半透明边缘',
    zip: '全部 PNG 逐帧图片 + 帧信息 JSON，打包下载',
    png: '仅下载预览中当前选中的图片，保留透明背景',
    sheet: '全部帧拼成一张透明 PNG，适合游戏与动画制作',
    folders: '全部 PNG 按原素材分目录打包下载',
  };
  if (state.job && !state.dirty) $('#output-description').textContent = hints[picker.value];
  if (cutout && state.job && !state.dirty) {
    const resized = state.groups.some(group => group.frames.some(frame => frame.width !== group.source_size[0] || frame.height !== group.source_size[1]));
    $('#output-description').textContent = resized ? '这是旧版已缩放的结果，请重新点击“移除背景”，以原图尺寸生成。' : count > 1 ? '仅打包去背景后的透明 PNG，不附带帧信息；每张图片保留原图尺寸。' : '下载去背景后的透明 PNG，保留原图尺寸与主体位置。';
  }
}

async function download(kind) {
  if (!state.job || state.dirty || state.busy || state.importing || exporting) return;
  const group = state.groups[state.group];
  const frame = group.frames[state.frame] || group.frames[0];
  const url = kind === 'png' ? frame.url + '?download=1' : kind === 'gif' ? state.job.gif_url + '?fps=' + state.fps + '&group=' + state.group : kind === 'sheet' ? state.job.sheet_url : kind === 'folders' ? state.job.folders_zip_url : state.job.zip_url;
  exporting = true;
  updateExportControls();
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || '导出失败，请稍后重试。');
    }
    const blob = await response.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    const disposition = response.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plain = disposition.match(/filename="?([^";]+)"?/i);
    link.download = encoded ? decodeURIComponent(encoded[1]) : plain ? plain[1] : 'frameme.' + (kind === 'sheet' ? 'png' : kind);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 10_000);
    toast('已开始下载。');
  } catch (error) { toast(error.message, 'error'); }
  finally { exporting = false; updateExportControls(); }
}

function formatStorage(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function importLegacyHistory() {
  const ids = [...new Set([...readHistory().map(item => item.id), ...Object.values(workspaces).map(workspace => workspace.job?.id).filter(Boolean)])];
  for (const id of ids) {
    const response = await fetch(draftStore.url('/jobs'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
    if (!response.ok && response.status !== 404) throw new Error('历史任务恢复失败');
  }
}

async function fetchLibrary(scope = 'tab') {
  const response = await fetch(draftStore.url('/jobs?scope=' + scope));
  const data = await draftStore.json(response);
  if (scope === 'tab') {
    const cached = new Map(readHistory().map(item => [item.id, item]));
    writeHistory(data.jobs.map(item => ({ ...cached.get(item.id), ...item, expires_at: null })).slice(0, 200));
    $('#history-count').textContent = data.jobs.length;
  }
  return data;
}

function updateHistorySelection() {
  const selected = historyRows.filter(item => historySelection.has(item.id));
  $('#history-selected').textContent = selected.length ? '已选 ' + selected.length + ' 项 · ' + formatStorage(selected.reduce((sum, item) => sum + item.bytes, 0)) : '选择任务后可批量删除';
  $('#delete-history-selected').disabled = !selected.length || deletingHistory;
  $('#history-select-all').checked = !!historyRows.length && historyRows.slice(0, 128).every(item => historySelection.has(item.id));
  $('#history-select-all').indeterminate = !!selected.length && !$('#history-select-all').checked;
  $('#history-select-all').disabled = !historyRows.length || deletingHistory;
}

function confirmHistoryDeletion(ids) {
  if (deletingHistory || !ids.length) return;
  pendingDeleteIds = [...ids];
  const bytes = historyRows.filter(item => ids.includes(item.id)).reduce((sum, item) => sum + item.bytes, 0);
  $('#delete-history-summary').textContent = '将删除 ' + ids.length + ' 个任务的原图副本与处理结果，任务文件占用约 ' + formatStorage(bytes) + '。此操作无法撤销。当前工作区导入的素材和已下载到其他位置的文件会保留。';
  $('#delete-history-dialog').showModal();
}

async function renderHistory() {
  if (restoringWorkspace || !draftStore.tab) return;
  const version = ++historyVersion;
  $('#history-storage').textContent = '正在读取本地任务…';
  $('#history-error').hidden = true;
  try {
    const data = await fetchLibrary(historyScope);
    if (version !== historyVersion || state.tool !== 'history') return;
    historyRows = data.jobs;
    for (const id of historySelection) if (!historyRows.some(item => item.id === id)) historySelection.delete(id);
    $('#history-storage').textContent = data.jobs.length + ' 个任务 · 任务文件 ' + formatStorage(data.bytes) + ' · 导入草稿 ' + formatStorage(data.draft_bytes);
    drawHistory();
  } catch (error) {
    if (version !== historyVersion || state.tool !== 'history') return;
    $('#history-storage').textContent = '任务列表读取失败';
    $('#history-error').hidden = false;
    $('#history-error').textContent = '暂时无法读取本地文件，请检查服务后重试。';
    $('#history-list').replaceChildren();
  }
}

function drawHistory() {
  const history = historyRows;
  const container = $('#history-list');
  container.replaceChildren();
  updateHistorySelection();
  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    const title = document.createElement('strong');
    title.textContent = '还没有处理记录';
    const note = document.createElement('p');
    note.textContent = historyScope === 'tab' ? '完成处理后会长期保留；之前关闭的工作区可从“此浏览器的所有工作区”查找。' : '这个浏览器身份还没有保存的任务。';
    empty.append(icon('history'), title, note);
    container.append(empty);
    return;
  }
  history.forEach(item => {
    const card = document.createElement('article');
    card.className = 'history-card panel';
    card.dataset.jobId = item.id;
    const selection = document.createElement('input');
    selection.type = 'checkbox'; selection.checked = historySelection.has(item.id);
    selection.setAttribute('aria-label', '选择任务 ' + item.name);
    selection.addEventListener('change', () => {
      if (selection.checked && historySelection.size >= 128) { selection.checked = false; toast('一次最多选择 128 个任务。'); return; }
      if (selection.checked) historySelection.add(item.id); else historySelection.delete(item.id);
      updateHistorySelection();
    });
    const thumbnail = document.createElement('img');
      thumbnail.className = 'history-thumbnail checker';
      thumbnail.alt = '';
      thumbnail.loading = 'lazy';
      thumbnail.src = item.thumbnail;
      thumbnail.addEventListener('error', () => { thumbnail.hidden = true; }, { once: true });
    const info = document.createElement('div');
    info.className = 'history-info';
    const title = document.createElement('h3');
    title.textContent = item.name;
    const note = document.createElement('p');
    note.textContent = (icons[item.mode] || '素材处理') + ' · ' + item.count + (item.mode === 'split' ? ' 帧' : ' 张') + ' · ' + formatStorage(item.bytes) + ' · ' + new Date(item.created_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const saved = document.createElement('p'); saved.className = 'history-retention'; saved.textContent = '长期保存' + (item.current_workspace ? '' : ' · 其他工作区');
    info.append(title, note, saved);
    const open = document.createElement('button');
    open.className = 'button secondary small';
    open.textContent = '打开任务';
    open.addEventListener('click', async () => {
      const generation = viewGeneration;
      open.disabled = true;
      open.textContent = '加载中…';
      try {
        const response = await fetch('/api/jobs/' + item.id);
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || '无法打开任务。');
        if (state.tool !== 'history' || generation !== viewGeneration) return;
        await openSavedJob(data);
      } catch (error) { toast(error.message, 'error'); }
      finally { open.disabled = false; open.textContent = '打开任务'; }
    });
    const remove = document.createElement('button'); remove.className = 'button secondary small'; remove.textContent = '删除';
    remove.addEventListener('click', () => confirmHistoryDeletion([item.id]));
    const actions = document.createElement('div'); actions.className = 'history-actions'; actions.append(open, remove);
    card.append(selection, thumbnail, info, actions);
    container.append(card);
  });
}

function openCropDialog() {
  if (!canCrop()) return;
  const extent = form.elements.layout.value === 'horizontal' ? state.source.width : state.source.height;
  const container = $('#crop-fields');
  container.replaceChildren();
  cropBounds().forEach((value, index) => {
    const label = document.createElement('label');
    label.textContent = '裁剪线 ' + (index + 1) + ' / px';
    const input = document.createElement('input');
    input.type = 'number'; input.value = value; input.min = 1; input.max = extent - 1; input.required = true; input.step = 1;
    label.append(input);
    container.append(label);
  });
  $('#crop-description').textContent = '原图' + (form.elements.layout.value === 'horizontal' ? '宽度 ' : '高度 ') + extent + ' px。坐标需递增，应用后重新处理即可生成新结果。';
  $('#crop-dialog').showModal();
}

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

canvas.addEventListener('pointerdown', event => {
  if (state.busy || !state.source || !state.rect) return;
  const point = pointerPosition(event);
  if (state.picking && state.view === 'source') {
    const { x, y, w, h, scale } = state.rect;
    if (point.x < x || point.x >= x + w || point.y < y || point.y >= y + h) return;
    pixelCanvas.width = state.source.width; pixelCanvas.height = state.source.height;
    pixelContext.drawImage(state.source, 0, 0);
    const pixel = pixelContext.getImageData(Math.floor((point.x - x) / scale), Math.floor((point.y - y) / scale), 1, 1).data;
    if (!pixel[3]) return toast('这个位置是透明像素，请点击有颜色的位置。');
    $('#color').value = '#' + [...pixel].slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('');
    $('#auto-color').checked = false;
    state.picking = false;
    canvas.classList.remove('pick-active');
    markDirty();
    toast('已选取背景颜色。');
    return;
  }
  if (!canCrop()) return;
  const horizontal = form.elements.layout.value === 'horizontal';
  const { x, y, w, h, scale } = state.rect;
  if (point.x < x - 10 || point.x > x + w + 10 || point.y < y - 10 || point.y > y + h + 10) return;
  const boundaries = cropBounds();
  const index = boundaries.findIndex(boundary => Math.abs((horizontal ? point.x - x : point.y - y) - boundary * scale) <= 12);
  if (index < 0) return;
  state.bounds = boundaries;
  state.drag = index;
  canvas.setPointerCapture(event.pointerId);
  draw();
});

canvas.addEventListener('pointermove', event => {
  if (state.drag < 0 || !state.rect) return;
  const point = pointerPosition(event);
  const horizontal = form.elements.layout.value === 'horizontal';
  const extent = horizontal ? state.source.width : state.source.height;
  const value = Math.round(((horizontal ? point.x - state.rect.x : point.y - state.rect.y)) / state.rect.scale);
  const low = state.drag ? state.bounds[state.drag - 1] + 1 : 1;
  const high = state.drag === state.bounds.length - 1 ? extent - 1 : state.bounds[state.drag + 1] - 1;
  state.bounds[state.drag] = Math.max(low, Math.min(high, value));
  draw();
});

for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(type, () => {
    if (state.drag >= 0) { state.drag = -1; markDirty(); draw(); }
  });
}

function roundRect(ctx, x, y, w, h, radius) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill();
}

function drawDemoFrame(index) {
  const frame = document.createElement('canvas');
  frame.width = frame.height = 256;
  const ctx = frame.getContext('2d');
  const phase = index / 6 * Math.PI * 2;
  const bob = Math.sin(phase) * 7;
  ctx.save();
  ctx.fillStyle = '#b8b5a636'; ctx.beginPath(); ctx.ellipse(128, 226, 37 - bob * .35, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.translate(0, bob);
  // A small illustrated explorer, drawn locally without external image assets.
  ctx.strokeStyle = '#a66a42'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(113, 190); ctx.lineTo(108, 207 + Math.sin(phase) * 3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(144, 190); ctx.lineTo(150, 207 - Math.sin(phase) * 3); ctx.stroke();
  ctx.fillStyle = '#546d59'; roundRect(ctx, 97, 203 + Math.sin(phase) * 3, 21, 10, 5); roundRect(ctx, 142, 203 - Math.sin(phase) * 3, 21, 10, 5);
  ctx.strokeStyle = '#d88b57'; ctx.lineWidth = 12;
  ctx.beginPath(); ctx.moveTo(89, 143); ctx.quadraticCurveTo(68, 148, 63, 163 + Math.sin(phase) * 10); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(168, 143); ctx.quadraticCurveTo(186, 139, 189, 123 + Math.cos(phase) * 10); ctx.stroke();
  ctx.fillStyle = '#f4c49c'; ctx.beginPath(); ctx.arc(63, 163 + Math.sin(phase) * 10, 8, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(189, 123 + Math.cos(phase) * 10, 8, 0, Math.PI * 2); ctx.fill();
  const gradient = ctx.createLinearGradient(76, 65, 170, 190);
  gradient.addColorStop(0, '#efb77b'); gradient.addColorStop(.45, '#e4a269'); gradient.addColorStop(1, '#cf8752');
  ctx.fillStyle = gradient;
  ctx.beginPath(); ctx.moveTo(83, 160); ctx.bezierCurveTo(72, 138, 82, 82, 96, 67); ctx.bezierCurveTo(116, 44, 156, 51, 171, 79); ctx.bezierCurveTo(184, 103, 184, 150, 172, 171); ctx.bezierCurveTo(160, 198, 100, 197, 83, 160); ctx.fill();
  ctx.fillStyle = '#f7d4a775'; ctx.beginPath(); ctx.ellipse(103, 91, 10, 22, .45, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#806c57'; roundRect(ctx, 90, 98, 78, 51, 23);
  ctx.fillStyle = '#f5eed8'; roundRect(ctx, 94, 101, 70, 44, 21);
  const blink = index === 4;
  ctx.fillStyle = '#4b5346';
  if (blink) {
    roundRect(ctx, 109, 122, 10, 3, 2); roundRect(ctx, 140, 122, 10, 3, 2);
  } else {
    roundRect(ctx, 112, 114, 7, 15, 4); roundRect(ctx, 140, 114, 7, 15, 4);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(115, 117, 1.4, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(143, 117, 1.4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#987557'; ctx.lineWidth = 1.7; ctx.beginPath(); ctx.arc(129, 129, 4, .2, Math.PI - .2); ctx.stroke();
  ctx.fillStyle = '#e1aa8b77'; ctx.beginPath(); ctx.ellipse(105, 129, 5, 3, 0, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.ellipse(153, 129, 5, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#b17d4c'; roundRect(ctx, 122, 163, 15, 11, 4);
  ctx.fillStyle = '#ded8ab'; ctx.beginPath(); ctx.arc(129.5, 168, 3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#756c4b'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(133, 59); ctx.lineTo(139, 39); ctx.stroke();
  ctx.fillStyle = '#91a981'; ctx.beginPath(); ctx.arc(140, 35, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#c0d0a1'; ctx.beginPath(); ctx.arc(138, 33, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  return frame;
}

async function useDemo() {
  if (state.busy || state.importing || restoringWorkspace) return;
  if (state.tool === 'history' && bytepetCatalog) {
    setTool('split');
    await chooseBytePetExample(exampleSelections.split);
  }
  if (bytepetExample) return useBytePetDemo();
  state.files.forEach(item => URL.revokeObjectURL(item.url));
  state.files = [];
  if (state.tool === 'history') setTool('split');
  if (state.tool !== 'split') setTool('split');
  form.reset();
  $('#prefix').value = 'float';
  const strip = document.createElement('canvas');
  strip.width = 256 * 6; strip.height = 256;
  const ctx = strip.getContext('2d');
  demoFrames.forEach((image, index) => ctx.drawImage(image, index * 256, 0));
  const blob = await new Promise(resolve => strip.toBlob(resolve, 'image/png'));
  if (!blob) return toast('示例素材生成失败，请重新载入。', 'error');
  state.bounds = [];
  await addFiles([new File([blob], 'floating-friend.png', { type: 'image/png' })], { origin: 'example' });
}

function configureExampleSelector(tool) {
  if (!bytepetCatalog || tool === 'history') return;
  const entries = tool === 'cutout' ? bytepetCatalog.cutout_states : bytepetCatalog.states;
  const select = $('#example-select');
  select.replaceChildren();
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.key; option.textContent = entry.label + (tool === 'cutout' ? '' : ' · ' + entry.key);
    select.append(option);
  }
  select.value = exampleSelections[tool];
  $('#example-select-label').textContent = tool === 'cutout' ? '选择原图' : tool === 'rename' ? '选择素材组' : '选择动作';
  $('#example-project-link').hidden = tool === 'cutout';
  $('#example-local-source').hidden = tool !== 'cutout';
  $('#example-badge').textContent = tool === 'cutout' ? '真实绿幕原图' : '真实项目案例';
  $('#example-purpose').textContent = tool === 'cutout' ? '原始绿幕图 → 移除背景 → 透明 PNG，可切换原图对比' : tool === 'rename' ? '多张原始 PNG → 统一前缀与连续编号，保留图像像素' : '长条切割 → 逐帧预览 → 动作目录导出';
}

async function chooseBytePetExample(key) {
  const workspace = state;
  const generation = viewGeneration;
  const tool = state.tool;
  if (!bytepetCatalog || tool === 'history') return;
  const entries = tool === 'cutout' ? bytepetCatalog.cutout_states : bytepetCatalog.states;
  const entry = entries.find(example => example.key === key);
  if (!entry || state.busy || state.importing) return;
  exampleSelections[tool] = key;
  const version = ++exampleVersion;
  exampleLoadingVersion = version;
  updateFields();
  $('#example-load').disabled = true;
  $('#load-demo').disabled = true;
  $('#sidebar-demo').disabled = true;
  try {
    let source, images;
    if (tool === 'cutout') {
      source = await loadImage('/static/examples/bytepet/' + entry.file);
      images = [source];
    } else if (tool === 'rename') {
      images = await Promise.all(entry.frame_files.map(file => loadImage('/static/examples/bytepet/' + file)));
      source = images[0];
    } else {
      source = await loadImage('/static/examples/bytepet/' + entry.strip);
      const thumbnails = [];
      for (let index = 0; index < entry.frames; index++) {
        const frame = document.createElement('canvas');
        frame.width = entry.width; frame.height = entry.height;
        frame.getContext('2d').drawImage(source, index * entry.width, 0, entry.width, entry.height, 0, 0, entry.width, entry.height);
        thumbnails.push(loadImage(frame.toDataURL('image/png')));
      }
      images = await Promise.all(thumbnails);
    }
    if (workspace !== state || generation !== viewGeneration || version !== exampleVersion) return;
    bytepetExample = { ...entry, tool };
    demoFrames = images;
    demoStrip = source;
    state.example = bytepetExample; state.demoFrames = images; state.demoStrip = source;
    $('#example-thumbnail').src = '/static/examples/bytepet/' + (tool === 'cutout' ? entry.file : entry.thumbnail);
    $('#example-details').textContent = tool === 'cutout' ? entry.label + ' · ' + entry.width + ' × ' + entry.height + ' px · 原始上传文件' : entry.label + ' · ' + entry.frames + (tool === 'rename' ? ' 张独立 PNG · ' : ' 帧 · ') + entry.width + ' × ' + entry.height + ' px' + (tool === 'split' ? ' · ' + entry.fps + ' FPS' : '');
    if (entry.source_kind === 'repaired') {
      $('#example-badge').textContent = '优化演示素材';
      $('#example-details').textContent += ' · 完整天线优化版';
      $('#example-purpose').textContent = tool === 'rename' ? 'BytePet 动作修补演示 → PNG 连续编号 · 原始素材另行保留' : 'BytePet 动作修补演示 → 切帧与动画导出 · 原始素材另行保留';
      $('#example-purpose').title = entry.source_note;
    } else {
      $('#example-badge').textContent = tool === 'cutout' ? '真实绿幕原图' : '真实项目案例';
      $('#example-purpose').title = '';
      $('#example-purpose').textContent = tool === 'cutout' ? '原始绿幕图 → 移除背景 → 透明 PNG，可切换原图对比' : tool === 'rename' ? '多张原始 PNG → 统一前缀与连续编号，保留图像像素' : '长条切割 → 逐帧预览 → 动作目录导出';
    }
    const caption = tool === 'cutout' ? '绿幕原图' : tool === 'rename' ? '批量命名素材' : 'BytePet 示例';
    $('#load-demo').replaceChildren(icon('spark'), document.createTextNode(' 一键试用 '), icon('arrow'));
    $('#sidebar-demo').replaceChildren(document.createTextNode('试试' + caption + ' '), icon('arrow'));
    if (state.demo && !state.files.length && !state.job) {
      state.source = source; state.images = images; state.frame = 0;
      state.playing = tool === 'split' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (tool === 'split') { state.fps = entry.fps; $('#fps').value = String(entry.fps); }
      setView(tool === 'cutout' ? 'source' : 'animation');
      renderFrames(); updateFields(); draw();
    }
  } finally {
    if (version === exampleVersion) {
      exampleLoadingVersion = 0;
      $('#example-load').disabled = state.busy || state.importing;
      $('#load-demo').disabled = state.busy || state.importing;
      $('#sidebar-demo').disabled = state.busy || state.importing;
      updateFields();
    }
  }
}

async function useBytePetDemo() {
  if (state.busy || state.importing || !bytepetExample) return;
  const entry = bytepetExample;
  const tool = state.tool;
  if (entry.tool !== tool) return;
  const button = $('#example-load');
  state.importing = true;
  updateFields();
  button.disabled = true;
  let imported = false;
  try {
    const paths = tool === 'cutout' ? [entry.file] : tool === 'rename' ? entry.frame_files : [entry.strip];
    const files = await Promise.all(paths.map(async (path) => {
      const response = await fetch('/static/examples/bytepet/' + path);
      if (!response.ok) throw new Error('原始示例素材暂时无法读取，请重试。');
      const blob = await response.blob();
      return new File([blob], tool === 'split' ? entry.key + '-bytepet-strip.png' : path.split('/').pop(), { type: 'image/png' });
    }));
    form.reset();
    $('#frames').value = tool === 'split' ? entry.frames : 1;
    $('#size').value = '0';
    $('#prefix').value = tool === 'rename' ? 'asset' : entry.key;
    $('#align').checked = tool === 'split';
    if (tool === 'split') { state.fps = entry.fps; $('#fps').value = String(entry.fps); }
    if (tool === 'cutout') {
      $('#remove-bg').checked = true; $('#tolerance').value = entry.tolerance; $('#feather').value = entry.feather;
    }
    state.bounds = [];
    imported = await addFiles(files, { internal: true, origin: 'example' });
  } catch (error) { toast(error.message, 'error'); }
  finally { state.importing = false; button.disabled = state.busy; updateFields(); renderUploads(); persistWorkspaceState(); await flushPendingUploads(); }
  if (imported && state.inputOrigin === 'example') await processFiles({ preventDefault() {} });
}


function animate(time) {
    if (state.tool === 'split' && state.playing && state.view === 'animation' && state.images.length > 1 && !document.hidden && !$('#workspace-view').hidden) {
    if (time - lastFrameTime >= 1000 / state.fps) {
      state.frame = (state.frame + 1) % state.images.length;
      lastFrameTime = time;
      draw();
    }
  }
  requestAnimationFrame(animate);
}

// Bind interactions before loading the optional demonstration.
$('#brand-home').addEventListener('click', openWorkbench);
$('#about-link').addEventListener('click', openWorkbench);
$('#prompts-link').addEventListener('click', openWorkbench);
$('#empty-demo').addEventListener('click', useDemo);
$$('[data-tool]').forEach(button => button.addEventListener('click', () => setTool(button.dataset.tool)));
$$('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$$('[data-background]').filter(button => button.tagName === 'BUTTON').forEach(button => button.addEventListener('click', () => {
  $('#preview-stage').dataset.background = button.dataset.background;
  $$('.bg-swatch').forEach(swatch => swatch.classList.toggle('selected', swatch === button));
  persistWorkspaceState();
}));
$('#top-upload').addEventListener('click', () => $('#file-input').click());
const uploadZone = $('#upload-zone');
uploadZone.addEventListener('click', () => $('#file-input').click());
uploadZone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#file-input').click(); } });
for (const type of ['dragenter', 'dragover']) uploadZone.addEventListener(type, event => { event.preventDefault(); uploadZone.classList.add('drag-over'); });
for (const type of ['dragleave', 'drop']) uploadZone.addEventListener(type, event => { event.preventDefault(); uploadZone.classList.remove('drag-over'); });
uploadZone.addEventListener('drop', event => addFiles(event.dataTransfer.files));
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => event.preventDefault());
$('#file-input').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; addFiles(files); });
$('#sidebar-demo').addEventListener('click', useDemo);
$('#load-demo').addEventListener('click', useDemo);
$('#example-load').addEventListener('click', useDemo);
$('#example-select').addEventListener('change', event => {
  chooseBytePetExample(event.target.value).catch(error => toast(error.message, 'error'));
});
form.addEventListener('submit', processFiles);
form.addEventListener('input', event => {
  if (['layout', 'frames', 'rows', 'columns'].includes(event.target.name)) state.bounds = [];
  markDirty(); updateSteps(); draw();
});
$('#reset-settings').addEventListener('click', () => { form.reset(); state.bounds = []; $('#size').value = '0'; markDirty(); draw(); toast('已恢复默认参数。'); });
for (const [id, delta] of [['decrease-frames', -1], ['increase-frames', 1]]) {
  $('#' + id).addEventListener('click', () => { $('#frames').value = Math.max(1, Math.min(128, (Number($('#frames').value) || 1) + delta)); state.bounds = []; markDirty(); draw(); });
}
$('#play-button').addEventListener('click', () => { state.playing = !state.playing; lastFrameTime = performance.now(); updatePlayButton(); persistWorkspaceState(); });
function stepFrame(delta) {
  if (!state.images.length || state.view !== 'animation') return;
  state.playing = false; state.frame = (state.frame + delta + state.images.length) % state.images.length;
  updatePlayButton(); draw();
  persistWorkspaceState();
}
$('#previous-frame').addEventListener('click', () => stepFrame(-1));
$('#next-frame').addEventListener('click', () => stepFrame(1));
$('#frame-scrub').addEventListener('input', event => { state.playing = false; state.frame = Number(event.target.value); updatePlayButton(); draw(); persistWorkspaceState(); });
$('#fps').addEventListener('change', event => { state.fps = Number(event.target.value); updateExportControls(); lastFrameTime = performance.now(); persistWorkspaceState(); });
$('#group-select').addEventListener('change', event => chooseGroup(Number(event.target.value)));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.picking) { state.picking = false; canvas.classList.remove('pick-active'); return; }
  if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName) || $('dialog[open]') || state.view !== 'animation' || state.tool === 'history') return;
  if (event.key === ' ' && state.images.length > 1) { event.preventDefault(); $('#play-button').click(); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); stepFrame(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); stepFrame(1); }
});
$('#crop-button').addEventListener('click', openCropDialog);
$('#crop-form').addEventListener('submit', event => {
  event.preventDefault();
  const values = $$('#crop-fields input').map(input => Number(input.value));
  if (values.some((value, index) => !Number.isInteger(value) || (index && value <= values[index - 1]))) return toast('裁剪线坐标必须是递增的整数。', 'error');
  state.bounds = values;
  $('#crop-dialog').close(); markDirty(); draw(); toast('裁剪线已更新，点击开始处理生成新结果。');
});
$('#reset-crops').addEventListener('click', () => { state.bounds = []; $('#crop-dialog').close(); markDirty(); draw(); toast('已恢复等分裁剪。'); });
$('#pick-color').addEventListener('click', () => { state.picking = true; setView('source'); canvas.classList.add('pick-active'); toast('点击原图中的背景颜色；按 Esc 取消。'); });
$('#export-format').addEventListener('change', event => {
  state.exportFormat = event.target.value; updateExportControls(); persistWorkspaceState();
});
$('#quick-download').addEventListener('click', () => download(state.exportFormat));
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$$('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog:not(#retouch-dialog):not(#delete-history-dialog)').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('#history-scope').addEventListener('change', event => { historyScope = event.target.value; historySelection.clear(); renderHistory(); });
$('#refresh-history').addEventListener('click', renderHistory);
$('#history-select-all').addEventListener('change', event => {
  historySelection.clear();
  if (event.target.checked) historyRows.slice(0, 128).forEach(item => historySelection.add(item.id));
  drawHistory();
});
$('#delete-history-selected').addEventListener('click', () => confirmHistoryDeletion([...historySelection]));
$('#delete-history-confirm').addEventListener('click', async () => {
  if (deletingHistory || !pendingDeleteIds.length) return;
  deletingHistory = true;
  $('#delete-history-confirm').disabled = $('#delete-history-cancel').disabled = true;
  $('#delete-history-confirm').textContent = '正在删除…';
  try {
    const response = await fetch(draftStore.url('/jobs'), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: pendingDeleteIds }) });
    const data = await draftStore.json(response);
    const deleted = new Set(data.deleted);
    for (const workspace of Object.values(workspaces)) {
      if (!deleted.has(workspace.job?.id)) continue;
      workspace.requestVersion++;
      Object.assign(workspace, { job: null, groups: [], images: [], frame: 0, group: 0, dirty: false, demo: false, view: 'source', playing: false });
      workspace.source = workspace.files[workspace.sourceIndex]?.image || null;
    }
    writeHistory(readHistory().filter(item => !deleted.has(item.id)));
    const remote = await draftStore.json(await fetch(draftStore.url('/state')));
    draftStore.lastSavedAt = Math.max(draftStore.lastSavedAt, remote.state?.savedAt || 0);
    persistWorkspaceState(); await draftStore.flush();
    historySelection.clear(); pendingDeleteIds = [];
    $('#delete-history-dialog').close();
    await renderHistory();
    toast(data.failed.length ? '部分文件被占用，未能删除的任务仍保留，可稍后重试。' : '已删除 ' + deleted.size + ' 个任务，导入素材仍保留。', data.failed.length ? 'warning' : '');
  } catch (error) {
    toast('删除未完成：' + (error.message || '请检查本地服务后重试。'), 'error');
  } finally {
    deletingHistory = false;
    $('#delete-history-confirm').disabled = $('#delete-history-cancel').disabled = false;
    $('#delete-history-confirm').textContent = '永久删除';
    updateHistorySelection();
  }
});
$('#delete-history-cancel').addEventListener('click', () => { if (!deletingHistory) $('#delete-history-dialog').close(); });
$('#delete-history-dialog').addEventListener('cancel', event => { if (deletingHistory) event.preventDefault(); });
function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  $('#theme-button').replaceChildren(icon(dark ? 'sun' : 'moon'));
  $('#theme-button').setAttribute('aria-label', dark ? '切换浅色主题' : '切换深色主题');
}
try { applyTheme(localStorage.getItem('framelab-theme') === 'dark'); } catch { applyTheme(false); }
$('#theme-button').addEventListener('click', () => { const dark = !document.body.classList.contains('dark'); applyTheme(dark); try { localStorage.setItem('framelab-theme', dark ? 'dark' : 'light'); } catch {} });
new ResizeObserver(() => draw()).observe($('#preview-stage'));
let retouchTarget = null;
const retouchEditor = new FrameMeRetouch(async blob => {
  const target = retouchTarget;
  if (!target || target.workspace !== state || state.job?.id !== target.jobId || state.dirty) throw new Error('当前素材已变化，请重新打开修补。');
  state.busy = true; updateFields();
  const payload = new FormData();
  payload.set('tab', draftStore.tab);
  payload.set('group', String(target.group)); payload.set('image', blob, 'retouched.png');
  try {
    const response = await fetch('/api/jobs/' + target.jobId + '/retouch', { method: 'POST', body: payload });
    const job = await response.json();
    if (!response.ok || !job.ok) throw new Error(job.error || '无法保存，请稍后重试。');
    await showJob(job);
    if (target.group) await chooseGroup(target.group);
    persistWorkspaceState();
    toast('修补已保存，下载结果会包含你的修改。');
  } finally { state.busy = false; updateFields(); await flushPendingUploads(); }
});
$('#retouch-open').addEventListener('click', () => {
  if (!state.job || state.tool !== 'cutout' || state.dirty || state.busy || state.importing || !state.images.length) return;
  state.playing = false;
  retouchTarget = { workspace: state, jobId: state.job.id, group: state.group };
  const group = state.groups[state.group];
  retouchEditor.open({ image: group.frames[0].url, original: '/api/jobs/' + state.job.id + '/retouch-base/' + state.group, name: group.name });
});
$('#advanced-settings').addEventListener('toggle', persistWorkspaceState);
window.addEventListener('pagehide', event => {
  persistWorkspaceState();
  if (!event.persisted) Object.values(workspaces).forEach(workspace => workspace.files.forEach(item => URL.revokeObjectURL(item.url)));
});
document.addEventListener('visibilitychange', () => { if (document.hidden) persistWorkspaceState(); });

async function init() {
  let metadata = null;
  let rememberedTool;
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftStore.metaKey) || 'null');
    if (saved?.scope === draftStore.scope) rememberedTool = saved.activeTool;
  } catch { /* Storage may be disabled. */ }
  const tool = new URLSearchParams(location.search).get('tool');
  setTool(icons[tool] ? tool : icons[rememberedTool] ? rememberedTool : 'split');
  updateFields();
  try {
    metadata = await draftStore.initialize();
    await restoreWorkspaceState(metadata);
    await importLegacyHistory();
    await fetchLibrary();
    if (!icons[tool]) {
      const homeTool = metadata?.activeTool !== 'history' && icons[metadata?.activeTool] ? metadata.activeTool : 'split';
      state = workspaces[homeTool];
      demoFrames = state.demoFrames; demoStrip = state.demoStrip; bytepetExample = state.example;
      setTool(state.tool);
    }
  } catch { warnDraftStorage(); }
  const requestedFormat = new URLSearchParams(location.search).get('format');
  if (['gif', 'zip', 'png', 'sheet', 'folders'].includes(requestedFormat)) state.exportFormat = requestedFormat;
  if (state.tool !== 'history') renderWorkspace();
  try {
    const canvases = Array.from({ length: 6 }, (_, index) => drawDemoFrame(index));
    demoFrames = await Promise.all(canvases.map(frame => loadImage(frame.toDataURL('image/png'))));
    const strip = document.createElement('canvas'); strip.width = 1536; strip.height = 256;
    const ctx = strip.getContext('2d'); canvases.forEach((frame, index) => ctx.drawImage(frame, index * 256, 0));
    demoStrip = await loadImage(strip.toDataURL('image/png'));
    if (state.demo && !state.files.length && !state.job) {
      state.images = demoFrames; state.source = demoStrip; renderFrames(); draw();
    }
  } catch { toast('示例预览加载失败，你仍可上传自己的素材。', 'warning'); }
  try {
    const response = await fetch('/static/examples/bytepet/example.json');
    if (!response.ok) throw new Error('Example catalog unavailable');
    bytepetCatalog = await response.json();
    if (state.tool !== 'history') {
      configureExampleSelector(state.tool);
      await chooseBytePetExample($('#example-select').value);
    }
  } catch {
    $('#bytepet-example').hidden = true;
    bytepetCatalog = null; bytepetExample = null;
  }
  restoringWorkspace = false;
  const recipe = new URLSearchParams(location.search).get('recipe');
  if ((recipe === 'strip' && state.tool === 'split') || (recipe === 'images' && state.tool === 'cutout')) {
    state.promptRecipe = recipe;
    const cleanURL = new URL(location.href); cleanURL.searchParams.delete('recipe'); history.replaceState(null, '', cleanURL);
    toast('Prompt 设置已准备好，上传图片后自动应用；现有素材与结果已保留。');
  }
  $$('#example-load, #load-demo, #sidebar-demo, #example-select').forEach(button => { button.disabled = false; });
  setTool(state.tool);
  updateFields();
  draw();
  persistWorkspaceState();
  await flushPendingUploads();
  requestAnimationFrame(animate);
  const entry = new URL(location.href);
  if (entry.searchParams.get('demo') === '1') {
    entry.searchParams.delete('demo'); history.replaceState(null, '', entry);
    await useDemo();
  }
}
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
init();
