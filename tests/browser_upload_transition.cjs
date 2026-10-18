/* Real-browser regression for example -> user uploads, including overlapping requests. */
const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.runtime/upload-evidence');
const material = path.join(root, 'web/static/examples/bytepet');
const star = path.join(material, 'originals/star_uploaded_input.png');
const comfort = path.join(material, 'originals/comfort_0001_uploaded_input.png');
const catalog = JSON.parse(fs.readFileSync(path.join(material, 'example.json')));
const frames = catalog.states.flatMap(entry => entry.frame_files.map(file => path.join(material, file)));
const results = [], errors = [];
let browser, page;
fs.mkdirSync(output, { recursive: true });
async function test(id, name, action) {
  try { await action(); results.push({ id, name, status: 'PASS' }); console.log('PASS ' + id + ' ' + name); }
  catch (error) { results.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
async function ready(tool) {
  await page.evaluate(() => { sessionStorage.removeItem('framelab-workspaces-v1'); sessionStorage.removeItem('framelab-tab-v1'); }).catch(() => {});
  await page.goto('http://127.0.0.1:7860/?tool=' + tool, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#example-load').disabled);
}
async function generate(button = '#process-button') {
  if (button === '#example-load' && !await page.locator('#example-load').isVisible()) button = '#empty-demo';
  const pending = page.waitForResponse(response => response.url().endsWith('/api/process') && response.request().method() === 'POST');
  await page.locator(button).click();
  const response = await pending;
  const job = await response.json();
  assert.equal(response.status(), 201, JSON.stringify(job));
  await page.waitForFunction(() => !document.querySelector('#process-button').disabled && !document.querySelector('#quick-download').disabled && document.querySelector('.frame-card'));
  return job;
}
async function upload(files, name) {
  await page.locator('#file-input').setInputFiles(files);
  await page.waitForFunction(name => document.querySelector('#stage-label').textContent === name && !document.querySelector('#process-button').disabled, name);
  assert.equal(await page.locator('[data-view="source"]').getAttribute('class'), 'selected');
  assert.equal(await page.locator('#file-input').inputValue(), '');
}
async function screenshot(filename) {
  await page.locator('.preview-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, filename), fullPage: true });
}
async function download(filename) {
  const pending = page.waitForEvent('download');
  await page.locator('#quick-download').click();
  const file = await pending;
  await file.saveAs(path.join(output, filename));
  assert.equal(await file.failure(), null);
}

(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.FRAMELAB_BROWSER_PATH || undefined });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  let splitJob, cutoutJob, renameJob;
  await test('UPLOAD-01', '切帧试用后上传原图：替换示例并立即预览新图', async () => {
    await ready('split'); await generate('#example-load');
    await upload(star, 'star_uploaded_input.png');
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.locator('#canvas-info').textContent(), '1254 × 1254 px');
    assert.equal(await page.locator('.frame-card').count(), 0);
    assert.equal(await page.locator('.output-bar').isVisible(), false);
    assert.equal(await page.locator('#frames').inputValue(), '1');
    assert.equal(await page.locator('#prefix').inputValue(), 'frame');
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
    const box = await page.locator('#preview-canvas').boundingBox();
    assert.ok(box.y >= 0 && box.y < 1050, '上传后应回到预览区域');
    await screenshot('split-user-upload.png');
  });
  await test('UPLOAD-02', '继续追加自己的图片：保留已有素材与设置，显示新上传图片', async () => {
    await page.locator('#prefix').fill('my_art');
    await upload(comfort, 'comfort_0001_uploaded_input.png');
    assert.equal(await page.locator('.upload-item').count(), 2);
    assert.equal(await page.locator('#prefix').inputValue(), 'my_art');
    assert.equal(await page.locator('.upload-preview[aria-pressed="true"]').getAttribute('aria-label'), '预览原图 comfort_0001_uploaded_input.png');
  });
  await test('UPLOAD-03', '点击素材名称切换原图，移除其他素材仍保持正确预览', async () => {
    await page.getByRole('button', { name: '预览原图 star_uploaded_input.png', exact: true }).click();
    assert.equal(await page.locator('#stage-label').textContent(), 'star_uploaded_input.png');
    await page.getByRole('button', { name: '预览原图 comfort_0001_uploaded_input.png', exact: true }).click();
    await page.getByRole('button', { name: '移除 star_uploaded_input.png', exact: true }).click();
    assert.equal(await page.locator('#stage-label').textContent(), 'comfort_0001_uploaded_input.png');
    assert.equal(await page.locator('.upload-item').count(), 1);
  });
  await test('UPLOAD-04', '新上传素材能重新生成并下载，不带示例文件', async () => {
    splitJob = await generate();
    assert.equal(splitJob.frame_count, 1);
    assert.equal(splitJob.groups[0].name, 'comfort_0001_uploaded_input.png');
    assert.equal(splitJob.groups[0].frames[0].width, 1254);
    await download('uploaded-split.zip');
  });
  await test('UPLOAD-05', '损坏图片导入失败时保留当前素材和可下载结果', async () => {
    await page.locator('#file-input').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a PNG') });
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('无法读取图片') && !document.querySelector('#process-button').disabled);
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.locator('#quick-download').isDisabled(), false);
    assert.ok((await page.locator('.upload-item').textContent()).includes('comfort_0001_uploaded_input.png'));
  });
  await test('UPLOAD-06', '抠图试用后上传新绿幕原图并下载新结果', async () => {
    await ready('cutout'); await generate('#example-load');
    await upload(comfort, 'comfort_0001_uploaded_input.png');
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.locator('#prefix').inputValue(), 'image');
    cutoutJob = await generate();
    assert.equal(cutoutJob.frame_count, 1);
    assert.equal(cutoutJob.options.mode, 'cutout');
    assert.equal(cutoutJob.groups[0].name, 'comfort_0001_uploaded_input.png');
    await download('uploaded-cutout.png');
    await screenshot('cutout-user-result.png');
  });
  await test('UPLOAD-07', '命名试用后上传十二张自己的图片，示例不占上传限额', async () => {
    await ready('rename'); await generate('#example-load');
    await upload(frames.slice(0, 12), path.basename(frames[0]));
    assert.equal(await page.locator('.upload-item').count(), 12);
    assert.equal(await page.locator('.frame-card').count(), 0);
    renameJob = await generate();
    assert.equal(renameJob.frame_count, 12);
    assert.equal(renameJob.options.mode, 'rename');
    await download('uploaded-rename.zip');
  });
  await test('UPLOAD-08', '重复上传不会重复加入，也不会错误恢复示例', async () => {
    await page.locator('#file-input').setInputFiles(frames[0]);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已经在上传列表'));
    assert.equal(await page.locator('.upload-item').count(), 12);
    assert.equal(await page.locator('#quick-download').isDisabled(), false);
  });
  await test('UPLOAD-15', '命名结果生成后仍可切换原图，预览尺寸与所选素材一致', async () => {
    while (await page.locator('.upload-item button[aria-label^="移除 "]').count()) await page.locator('.upload-item button[aria-label^="移除 "]').first().click();
    await upload([star, frames[0]], 'star_uploaded_input.png');
    await generate();
    await page.getByRole('button', { name: '预览原图 ' + path.basename(frames[0]), exact: true }).click();
    assert.equal(await page.locator('#canvas-info').textContent(), '512 × 512 px');
    assert.equal(await page.locator('#stage-label').textContent(), path.basename(frames[0]));
    assert.equal(await page.locator('#quick-download').isDisabled(), false);
  });
  await test('UPLOAD-09', '示例生成中收到上传：保留图片并在结束后自动切换', async () => {
    await ready('split');
    let release, reached;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { reached = resolve; });
    await page.route('**/api/process', async route => { reached(); await gate; await route.continue(); });
    await page.locator('#sidebar-demo').click(); await started;
    try {
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#upload-zone').click();
      await (await chooser).setFiles(star);
      assert.ok((await page.locator('#toast').textContent()).includes('已收到你的图片'));
    } finally { release(); }
    await page.waitForFunction(() => document.querySelector('#stage-label').textContent === 'star_uploaded_input.png' && !document.querySelector('#process-button').disabled);
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.locator('.frame-card').count(), 0);
    assert.equal(await page.locator('.output-bar').isVisible(), false);
    await page.unroute('**/api/process');
  });
  await test('UPLOAD-10', '示例素材加载中收到上传：显示用户图片，不自动处理为示例', async () => {
    await ready('split');
    let release, reached, posts = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { reached = resolve; });
    const listener = request => { if (request.url().endsWith('/api/process') && request.method() === 'POST') posts++; };
    page.on('request', listener);
    await page.route('**/static/examples/bytepet/calm-strip.png', async route => { reached(); await gate; await route.continue(); });
    await page.locator('#sidebar-demo').click(); await started;
    try {
      await page.locator('#file-input').setInputFiles(comfort);
      assert.ok((await page.locator('#toast').textContent()).includes('已收到你的图片'));
    } finally { release(); }
    await page.waitForFunction(() => document.querySelector('#stage-label').textContent === 'comfort_0001_uploaded_input.png' && !document.querySelector('#process-button').disabled);
    await page.waitForLoadState('networkidle');
    assert.equal(posts, 0);
    assert.equal(await page.locator('.upload-item').count(), 1);
    await page.unroute('**/static/examples/bytepet/calm-strip.png');
    page.off('request', listener);
  });
  await test('UPLOAD-11', '拖入文件也会替换试用素材并显示新原图', async () => {
    await ready('split'); await generate('#example-load');
    const bytes = [...fs.readFileSync(star)];
    await page.evaluate(bytes => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'dropped-star.png', { type: 'image/png' }));
      document.querySelector('#upload-zone').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
    }, bytes);
    await page.waitForFunction(() => document.querySelector('#stage-label').textContent === 'dropped-star.png' && !document.querySelector('#process-button').disabled);
    assert.equal(await page.locator('.upload-item').count(), 1);
  });
  await test('UPLOAD-12', '工具来回切换后仍保留各自原图，不混入示例', async () => {
    await page.locator('[data-tool="cutout"]').click();
    await page.waitForFunction(() => !document.querySelector('#example-load').disabled);
    await generate('#example-load');
    await upload(comfort, 'comfort_0001_uploaded_input.png');
    await page.locator('[data-tool="split"]').click();
    await page.waitForFunction(() => !document.querySelector('#example-load').disabled);
    assert.equal(await page.locator('#stage-label').textContent(), 'dropped-star.png');
    await page.locator('[data-tool="cutout"]').click();
    await page.waitForFunction(() => !document.querySelector('#example-load').disabled);
    assert.equal(await page.locator('#stage-label').textContent(), 'comfort_0001_uploaded_input.png');
    assert.equal(await page.locator('.upload-item').count(), 1);
  });
  await test('UPLOAD-13', '手机试用后上传：自动显示新图片且没有横向溢出', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ready('cutout'); await generate('#example-load');
    await upload(comfort, 'comfort_0001_uploaded_input.png');
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const box = await page.locator('#preview-canvas').boundingBox();
    assert.ok(box.y >= 0 && box.y < 844);
    await screenshot('mobile-user-upload.png');
  });
  await test('UPLOAD-14', '上传流程没有 JavaScript 异常', async () => { assert.deepEqual(errors, []); });
  fs.writeFileSync(path.join(output, 'jobs.json'), JSON.stringify({ splitJob, cutoutJob, renameJob }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'upload-results.json'), JSON.stringify({ results, errors, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status === 'FAIL').length }, null, 2));
  if (browser) await browser.close();
});
