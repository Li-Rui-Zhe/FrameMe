/* Run against a local FrameLab: reload must resume files, controls and results. */
const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.runtime/refresh-evidence');
const material = path.join(root, 'web/static/examples/bytepet');
const comfort = path.join(material, 'originals/comfort_0001_uploaded_input.png');
const star = path.join(material, 'originals/star_uploaded_input.png');
const rawFrames = [path.join(material, 'frames/calm_0001.png'), path.join(material, 'frames/happy_0001.png')];
const results = [], errors = [];
let browser, context, page;
fs.mkdirSync(output, { recursive: true });
async function test(id, name, action) {
  try { await action(); results.push({ id, name, status: 'PASS' }); console.log('PASS ' + id + ' ' + name); }
  catch (error) { results.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
async function ready(target = page) {
  await target.waitForFunction(() => { try { return !restoringWorkspace && !state.busy && !state.importing && !document.querySelector('#top-upload').disabled; } catch { return false; } });
}
async function reload(target = page) {
  await target.reload({ waitUntil: 'domcontentloaded' }); await ready(target);
}
async function switchTool(tool) {
  await page.locator('[data-tool="' + tool + '"]').click(); await ready();
}
async function upload(files, name, target = page) {
  await target.locator('#file-input').setInputFiles(files);
  await target.waitForFunction(name => document.querySelector('#stage-label').textContent === name && !document.querySelector('#process-button').disabled, name);
}
async function generate() {
  const pending = page.waitForResponse(response => response.url().endsWith('/api/process') && response.request().method() === 'POST');
  await page.locator('#process-button').click();
  const response = await pending;
  const job = await response.json();
  assert.equal(response.status(), 201, JSON.stringify(job));
  await page.waitForFunction(() => !document.querySelector('#process-button').disabled && !document.querySelector('#quick-download').disabled && document.querySelector('.frame-card'));
  return job;
}
async function screenshot(name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, name), fullPage: true });
}

(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.FRAMELAB_BROWSER_PATH || undefined });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  let cutoutJob, renameJob;
  await test('REFRESH-01', '未处理的上传图片及参数刷新后仍在，原图可继续处理', async () => {
    await page.goto('http://127.0.0.1:7860/?tool=cutout', { waitUntil: 'networkidle' }); await ready();
    await upload(comfort, 'comfort_0001_uploaded_input.png');
    await page.locator('#prefix').fill('my_character');
    await page.locator('#advanced-settings summary').click();
    await page.locator('#tolerance').fill('27');
    await page.locator('#size').selectOption('256');
    await page.locator('[data-background="white"]').click();
    await reload();
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.locator('#stage-label').textContent(), 'comfort_0001_uploaded_input.png');
    assert.equal(await page.locator('#canvas-info').textContent(), '1254 × 1254 px');
    assert.equal(await page.locator('#prefix').inputValue(), 'my_character');
    assert.equal(await page.locator('#tolerance').inputValue(), '27');
    assert.equal(await page.locator('#size').inputValue(), '256');
    assert.equal(await page.locator('#advanced-settings').evaluate(node => node.open), true);
    assert.equal(await page.locator('#preview-stage').getAttribute('data-background'), 'white');
    assert.equal(await page.locator('#process-button').isDisabled(), false);
    assert.equal(await page.locator('.frame-card').count(), 0);
    await screenshot('unprocessed-after-refresh.png');
  });
  await test('REFRESH-02', '已生成结果刷新后恢复，能直接下载同一任务', async () => {
    cutoutJob = await generate();
    await reload();
    assert.equal(await page.locator('.frame-card').count(), 1);
    assert.equal(await page.locator('#canvas-info').textContent(), '256 × 256 px');
    assert.equal(await page.locator('#quick-download').isDisabled(), false);
    const pending = page.waitForEvent('download');
    await page.locator('#quick-download').click();
    const file = await pending;
    await file.saveAs(path.join(output, 'restored-cutout.png'));
    assert.equal(await file.failure(), null);
    const request = await context.request.get('http://127.0.0.1:7860/api/jobs/' + cutoutJob.id);
    assert.equal(request.status(), 200);
    await screenshot('processed-after-refresh.png');
  });
  await test('REFRESH-03', '参数已修改但未重新生成的状态刷新后仍正确禁用旧结果下载', async () => {
    await page.locator('#prefix').fill('changed_character');
    await page.locator('[data-view="source"]').click();
    await reload();
    assert.equal(await page.locator('#prefix').inputValue(), 'changed_character');
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
    assert.equal(await page.locator('#preview-badge').textContent(), '待重新生成');
    assert.equal(await page.locator('#canvas-info').textContent(), '1254 × 1254 px');
    assert.equal(await page.locator('.frame-card').count(), 1);
    assert.equal(await page.locator('#process-button').isDisabled(), false);
  });
  await test('REFRESH-04', '刷新后保留切帧工具、帧数、精确裁剪和播放速度', async () => {
    await switchTool('split');
    await upload(path.join(material, 'calm-strip.png'), 'calm-strip.png');
    await page.locator('#prefix').fill('my_motion');
    await page.locator('#frames').fill('6');
    await page.locator('#fps').selectOption('8');
    await page.locator('#crop-button').click();
    await page.locator('#crop-fields input').first().fill('520');
    await page.locator('#crop-form [type="submit"]').click();
    await reload();
    assert.equal(await page.locator('[data-tool="split"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#frames').inputValue(), '6');
    assert.equal(await page.locator('#fps').inputValue(), '8');
    assert.equal(await page.locator('#prefix').inputValue(), 'my_motion');
    await page.locator('#crop-button').click();
    assert.equal(await page.locator('#crop-fields input').first().inputValue(), '520');
    await page.keyboard.press('Escape');
    const job = await generate();
    assert.equal(job.options.bounds[0], 520);
    assert.equal(job.frame_count, 6);
  });
  await test('REFRESH-05', '三种工具的素材与参数分别恢复，不混入其他工具', async () => {
    await switchTool('rename');
    await upload(rawFrames, 'calm_0001.png');
    await page.locator('#prefix').fill('my_assets');
    renameJob = await generate();
    await page.locator('.frame-card').nth(1).click();
    await reload();
    assert.equal(await page.locator('[data-tool="rename"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.upload-item').count(), 2);
    assert.equal(await page.locator('#prefix').inputValue(), 'my_assets');
    assert.equal(await page.locator('.frame-card.active').getAttribute('title'), 'happy_0001.png → my_assets_0002.png');
    await switchTool('cutout');
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.locator('#prefix').inputValue(), 'changed_character');
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
    await switchTool('split');
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.locator('#prefix').inputValue(), 'my_motion');
    assert.equal(await page.locator('.frame-card').count(), 6);
  });
  await test('REFRESH-06', '刷新后可继续追加素材，文件仍能正常处理', async () => {
    await switchTool('cutout');
    await upload(star, 'star_uploaded_input.png');
    await reload();
    assert.equal(await page.locator('.upload-item').count(), 2);
    assert.equal(await page.locator('#stage-label').textContent(), 'star_uploaded_input.png');
    const job = await generate();
    assert.equal(job.frame_count, 2);
    assert.deepEqual(job.groups.map(group => group.name), ['comfort_0001_uploaded_input.png', 'star_uploaded_input.png']);
    await page.locator('#group-select').selectOption('1');
    await page.waitForFunction(() => document.querySelector('#stage-label').textContent === 'star_uploaded_input.png');
    await reload();
    assert.equal(await page.locator('#group-select').inputValue(), '1');
    assert.equal(await page.locator('#stage-label').textContent(), 'star_uploaded_input.png');
  });
  await test('REFRESH-07', '新标签页不会读取其他标签页的草稿和任务历史', async () => {
    const other = await context.newPage();
    await other.goto('http://127.0.0.1:7860/?tool=cutout', { waitUntil: 'networkidle' }); await ready(other);
    assert.equal(await other.locator('.upload-item').count(), 0);
    assert.equal(await other.locator('#history-count').textContent(), '0');
    await upload(star, 'star_uploaded_input.png', other);
    await reload(other);
    assert.equal(await other.locator('.upload-item').count(), 1);
    await reload();
    assert.equal(await page.locator('.upload-item').count(), 2);
    await other.close();
  });
  await test('REFRESH-08', '由当前页面打开的新标签页不会继承复制的 sessionStorage 草稿', async () => {
    const pending = context.waitForEvent('page');
    await page.evaluate(() => window.open(location.href));
    const other = await pending;
    await other.waitForLoadState('networkidle'); await ready(other);
    assert.equal(await other.locator('.upload-item').count(), 0);
    assert.equal(await other.locator('#history-count').textContent(), '0');
    await other.close(); await reload();
    assert.equal(await page.locator('.upload-item').count(), 2);
  });
  await test('REFRESH-09', '结果文件不可用时恢复原始图片，能重新生成而不是回到示例', async () => {
    await switchTool('rename');
    await page.route('**/api/jobs/' + renameJob.id, route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
    await reload();
    assert.equal(await page.locator('.upload-item').count(), 2);
    assert.equal(await page.locator('.frame-card').count(), 0);
    assert.equal(await page.locator('#stage-label').textContent(), 'calm_0001.png');
    assert.equal(await page.locator('#process-button').isDisabled(), false);
    await page.unroute('**/api/jobs/' + renameJob.id);
    const job = await generate(); assert.equal(job.frame_count, 2);
  });
  await test('REFRESH-10', '移除素材后刷新不会把已移除图片恢复回来', async () => {
    await page.getByRole('button', { name: '移除 calm_0001.png', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#top-upload').disabled);
    await reload();
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.locator('#stage-label').textContent(), 'happy_0001.png');
  });
  await test('REFRESH-11', 'Cookie 被清除后不会恢复原浏览器身份的草稿和历史', async () => {
    await context.clearCookies();
    await reload();
    assert.equal(await page.locator('.upload-item').count(), 0);
    assert.equal(await page.locator('#history-count').textContent(), '0');
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
    assert.equal((await context.request.get('http://127.0.0.1:7860/api/jobs/' + cutoutJob.id)).status(), 404);
  });
  await test('REFRESH-12', '手机上传并刷新后仍显示自己的原图，页面没有横向溢出', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await switchTool('cutout');
    await upload(comfort, 'comfort_0001_uploaded_input.png');
    await reload();
    assert.equal(await page.locator('#stage-label').textContent(), 'comfort_0001_uploaded_input.png');
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot('mobile-after-refresh.png');
  });
  await test('REFRESH-14', '清除浏览器临时快照后仍能从 SQLite 恢复原图和工作区', async () => {
    await page.evaluate(() => sessionStorage.removeItem('framelab-workspaces-v1'));
    await reload();
    assert.equal(await page.locator('#stage-label').textContent(), 'comfort_0001_uploaded_input.png');
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.locator('#process-button').isDisabled(), false);
  });
  await test('REFRESH-13', '全部刷新与恢复流程没有 JavaScript 异常', async () => { assert.deepEqual(errors, []); });
  fs.writeFileSync(path.join(output, 'browser-environment.json'), JSON.stringify({ browser: await browser.version(), platform: process.platform }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'refresh-results.json'), JSON.stringify({ results, errors, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status === 'FAIL').length }, null, 2));
  if (browser) await browser.close();
});
