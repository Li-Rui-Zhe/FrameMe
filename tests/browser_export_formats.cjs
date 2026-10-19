/* Run against the local server. Downloads are decoded separately in the report. */
const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../.runtime/export-evidence');
fs.mkdirSync(output, { recursive: true });
const results = [], errors = [];
let browser, page;
async function test(id, name, action) {
  try { await action(); results.push({ id, name, status: 'PASS' }); console.log('PASS ' + id + ' ' + name); }
  catch (error) { results.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
async function ready() { await page.waitForFunction(() => { try { return !restoringWorkspace && !state.busy && !state.importing && !document.querySelector('#top-upload').disabled; } catch { return false; } }); }
async function demo(tool) {
  await page.locator('[data-tool="' + tool + '"]').click(); await ready();
  const response = page.waitForResponse(r => r.url().endsWith('/api/process') && r.request().method() === 'POST');
  await page.locator('#empty-demo').click(); assert.equal((await response).status(), 201);
  await page.waitForFunction(() => !document.querySelector('#quick-download').disabled);
}
async function download(kind, filename) {
  if (await page.locator('.format-picker').isVisible()) await page.locator('#export-format').selectOption(kind);
  else assert.equal(await page.locator('#export-format').inputValue(), kind);
  const pending = page.waitForEvent('download');
  await page.locator('#quick-download').click();
  const file = await pending;
  assert.equal(path.extname(file.suggestedFilename()), path.extname(filename));
  await file.saveAs(path.join(output, filename)); assert.equal(await file.failure(), null);
  await page.waitForFunction(() => !document.querySelector('#quick-download').disabled);
}
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.FRAMELAB_BROWSER_PATH || undefined });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  page.setDefaultTimeout(25000); page.on('pageerror', e => errors.push(e.message));
  await test('FORMAT-01', '空工作区不允许下载，移除更多格式弹窗', async () => {
    await page.goto('http://127.0.0.1:7860/editor?tool=split', { waitUntil: 'domcontentloaded' }); await ready();
    assert.equal(await page.locator('#export-button,#export-dialog').count(), 0);
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
  });
  await test('FORMAT-02', '序列帧示例默认 GIF，提示当前序列与速度', async () => {
    await demo('split'); assert.equal(await page.locator('#export-format').inputValue(), 'gif');
    assert.equal(await page.locator('#example-select').isDisabled(), false);
    assert.match(await page.locator('#output-description').textContent(), /当前选中序列.*4 FPS/);
  });
  for (const [kind, file] of [['gif','animation.gif'],['zip','frames.zip'],['png','frame.png'],['sheet','sheet.png'],['folders','folders.zip']]) {
    await test('FORMAT-' + String(results.length + 1).padStart(2,'0'), kind + ' 选择后直接下载真实文件', () => download(kind,file));
  }
  await test('FORMAT-08', '调整播放速度会同步提示并导出 GIF', async () => {
    await page.locator('#fps').selectOption('8'); await download('gif','animation-8fps.gif');
    assert.match(await page.locator('#output-description').textContent(), /8 FPS/);
  });
  await test('FORMAT-09', '格式选择随工作区刷新恢复', async () => {
    await page.locator('#export-format').selectOption('zip');
    await page.evaluate(() => draftStore.flush());
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    assert.equal(await page.locator('#export-format').inputValue(), 'zip');
  });
  await test('FORMAT-10', '设置改变后禁用下载，避免下载旧结果', async () => {
    await page.locator('#prefix').fill('new_frames');
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
    assert.equal(await page.locator('#export-format').isDisabled(), true);
  });
  await test('FORMAT-11', '免费去背景示例默认 PNG 并直接下载', async () => {
    await demo('cutout'); assert.equal(await page.locator('#export-format').inputValue(), 'png');
    await download('png','cutout.png');
  });
  await test('FORMAT-12', '导出失败保留格式并允许重试', async () => {
    await page.route('**/frame/*?download=1', route => route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'测试导出失败'})}));
    // Match the actual PNG URL rather than coupling to the route layout.
    const frameURL = await page.evaluate(() => state.groups[state.group].frames[state.frame].url + '?download=1');
    await page.route('**' + frameURL, route => route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'测试导出失败'})}));
    await page.locator('#quick-download').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('测试导出失败'));
    assert.equal(await page.locator('#quick-download').isDisabled(), false);
    assert.equal(await page.locator('#export-format').inputValue(), 'png');
    await page.unrouteAll(); await download('png','cutout-retry.png');
  });
  await test('FORMAT-13', '批量命名默认 ZIP，GIF 不可选', async () => {
    await demo('rename'); assert.equal(await page.locator('#export-format').inputValue(), 'zip');
    assert.equal(await page.locator('#export-format option[value=gif]').evaluate(option => option.disabled), true);
    await download('zip','renamed.zip');
  });
  await test('FORMAT-14', '导出区在浅深主题与小屏不横向溢出', async () => {
    for (const dark of [false,true]) {
      if (await page.locator('body').evaluate(el => el.classList.contains('dark')) !== dark) await page.locator('#theme-button').click();
      for (const width of [1440,768,390,320]) {
        await page.setViewportSize({width,height:1000});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, String(width));
        const bounds = await page.locator('.download-actions').boundingBox(); assert.ok(bounds.width > 0);
      }
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:path.join(output,'export-dark.png'),fullPage:true});
  });
  await test('FORMAT-15', '介绍页第三个创作入口直接选择 PNG 序列格式', async () => {
    await page.locator('#about-link').click(); await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
    await page.locator('[data-feature="frames"]>a').click(); await ready();
    assert.equal(await page.locator('#export-format').inputValue(), 'zip');
    assert.equal(await page.locator('[data-tool="split"]').getAttribute('aria-current'), 'page');
    assert.deepEqual(errors, []);
  });
})().catch(error => { console.error(error); process.exitCode=1; }).finally(async () => {
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results,errors},null,2));
  if(browser) await browser.close();
});
