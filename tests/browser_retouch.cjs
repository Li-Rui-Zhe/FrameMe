const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.runtime/retouch-evidence');
fs.mkdirSync(output, { recursive: true });
const results = [], errors = [];
let browser, page, job, edited, point, background;
async function test(id, name, action) {
  try { await action(); results.push({ id, name, status: 'PASS' }); console.log('PASS ' + id + ' ' + name); }
  catch (error) { results.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
async function generate() {
  const pending = page.waitForResponse(r => r.url().endsWith('/api/process') && r.request().method() === 'POST');
  await page.locator('#process-button').click();
  const response = await pending; assert.equal(response.status(), 201);
  const data = await response.json();
  await page.waitForFunction(() => !document.querySelector('#retouch-open').disabled);
  return data;
}
async function pixels(url) {
  return page.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const values = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let foreground;
    for (let y = Math.round(canvas.height * .4); y < canvas.height * .7 && !foreground; y++) for (let x = Math.round(canvas.width * .45); x < canvas.width * .65; x++) {
      if (values[(y * canvas.width + x) * 4 + 3] === 255) { foreground = { x, y }; break; }
    }
    return { width: canvas.width, height: canvas.height, foreground, alpha: foreground ? values[(foreground.y * canvas.width + foreground.x) * 4 + 3] : null };
  }, url);
}
async function pixel(target, at) {
  return page.evaluate(async ({ target, at }) => {
    let canvas;
    if (target.startsWith('#')) canvas = document.querySelector(target);
    else {
      const image = new Image(); image.src = target; await image.decode();
      canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
    }
    return [...canvas.getContext('2d').getImageData(at.x, at.y, 1, 1).data];
  }, { target, at });
}
async function brush(at, tool = 'erase') {
  await page.locator('[data-brush="' + tool + '"]').click();
  await page.locator('#retouch-size').evaluate(node => { node.value = '35'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  const position = await page.locator('#retouch-canvas').evaluate((node, at) => {
    const box = node.getBoundingClientRect();
    return { x: box.x + at.x / node.width * box.width, y: box.y + at.y / node.height * box.height };
  }, at);
  await page.mouse.move(position.x, position.y); await page.mouse.down();
  await page.mouse.move(position.x + 1, position.y + 1, { steps: 3 }); await page.mouse.up();
}
async function open() {
  await page.locator('#retouch-open').click();
  await page.waitForFunction(() => document.querySelector('#retouch-canvas').width > 1 && !document.querySelector('#retouch-size').disabled);
}
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.FRAMELAB_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', hasTouch: true });
  page = await context.newPage(); page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push(error.message));
  await test('RETOUCH-01', '根地址直接进入工作台，可选择背景移除', async () => {
    await page.goto('http://127.0.0.1:7860/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.querySelector('#top-upload').disabled);
    await page.locator('[data-tool="cutout"]').click();
    assert.equal(await page.locator('#creation-tool-name').textContent(), '背景移除');
    assert.equal(await page.locator('#welcome-view, #editor-home').count(), 0);
    assert.equal(await page.locator('#upload-zone').isVisible(), true);
    await page.screenshot({ path: path.join(output, 'connected-start.png'), fullPage: true });
  });
  await test('RETOUCH-02', '上传后保留流程顶部、素材名称，收起无关示例', async () => {
    const pending = page.waitForEvent('filechooser'); await page.locator('#top-upload').click();
    await (await pending).setFiles(path.join(root, 'web/static/examples/bytepet/originals/star_uploaded_input.png'));
    await page.waitForFunction(() => !document.querySelector('#process-button').disabled);
    assert.equal(await page.locator('#welcome-view').isVisible(), false);
    assert.equal(await page.locator('.creation-context').isVisible(), true);
    assert.equal(await page.locator('#creation-tool-name').textContent(), '背景移除');
    assert.equal(await page.locator('#page-title').textContent(), 'star_uploaded_input.png');
    assert.equal(await page.locator('#bytepet-example').isVisible(), false);
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.equal(await page.locator('#step-settings').getAttribute('aria-current'), 'step');
    assert.equal(await page.locator('#retouch-open').isDisabled(), true);
    await page.screenshot({ path: path.join(output, 'connected-upload.png'), fullPage: true });
  });
  await test('RETOUCH-03', '自动去底后直接提供修补入口', async () => {
    job = await generate();
    assert.equal(await page.locator('#retouch-open').isDisabled(), false);
    assert.equal(await page.locator('#step-export').getAttribute('aria-current'), 'step');
    const info = await pixels(job.groups[0].frames[0].url);
    point = info.foreground; assert.ok(point); background = { x: 30, y: 30 };
  });
  await test('RETOUCH-04', '打开修补画布，保存前保持原结果', async () => {
    await open();
    assert.equal(await page.locator('#retouch-dialog').isVisible(), true);
    assert.equal(await page.locator('#retouch-save').isDisabled(), true);
    assert.equal((await pixel('#retouch-canvas', point))[3], 255);
    await page.screenshot({ path: path.join(output, 'manual-retouch-clean.png') });
  });
  await test('RETOUCH-05', '画笔涂抹实际擦除 Alpha，撤销重做还原像素', async () => {
    await brush(point);
    assert.equal((await pixel('#retouch-canvas', point))[3], 0);
    await page.locator('#retouch-undo').click();
    assert.equal((await pixel('#retouch-canvas', point))[3], 255);
    await page.locator('#retouch-redo').click();
    assert.equal((await pixel('#retouch-canvas', point))[3], 0);
  });
  await test('RETOUCH-06', '恢复画笔还原主体，也能找回自动算法删除的内容', async () => {
    await brush(point, 'restore');
    assert.deepEqual(await pixel('#retouch-canvas', point), await pixel('/api/jobs/' + job.id + '/retouch-base/0', point));
    assert.equal((await pixel('#retouch-canvas', background))[3], 0);
    await brush(background, 'restore');
    assert.deepEqual(await pixel('#retouch-canvas', background), await pixel('/api/jobs/' + job.id + '/retouch-base/0', background));
    await brush(point);
  });
  await test('RETOUCH-07', '原图对比不会覆盖修补，快捷键可撤销重做', async () => {
    await page.locator('#retouch-compare').click();
    assert.equal((await pixel('#retouch-canvas', point))[3], 255);
    await page.locator('#retouch-compare').click();
    assert.equal((await pixel('#retouch-canvas', point))[3], 0);
    await page.locator('#retouch-canvas').click({ position: { x: 2, y: 2 } });
    await page.locator('#retouch-undo').focus();
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+z');
    assert.equal((await pixel('#retouch-canvas', point))[3], 0);
  });
  await test('RETOUCH-08', '缩放与移动画布后仍能对齐像素', async () => {
    await page.locator('#retouch-zoom').evaluate(node => { node.value = '250'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.locator('#retouch-zoom-value').textContent(), '250%');
    await page.locator('[data-brush="pan"]').click();
    const box = await page.locator('#retouch-viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 50, { steps: 5 }); await page.mouse.up();
    assert.ok(await page.locator('#retouch-viewport').evaluate(node => node.scrollLeft > 0 || node.scrollTop > 0));
    await page.locator('#retouch-fit').click();
    await brush(point, 'restore'); assert.equal((await pixel('#retouch-canvas', point))[3], 255);
    await brush(point); assert.equal((await pixel('#retouch-canvas', point))[3], 0);
    await page.screenshot({ path: path.join(output, 'manual-retouch.png') });
  });
  await test('RETOUCH-09', '保存失败保留画笔记录，可以重试', async () => {
    await page.route('**/api/jobs/*/retouch', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '测试断线' }) }));
    await page.locator('#retouch-save').click();
    await page.waitForFunction(() => document.querySelector('#retouch-status').textContent.includes('保存失败'));
    assert.equal(await page.locator('#retouch-dialog').isVisible(), true);
    assert.equal((await pixel('#retouch-canvas', point))[3], 0);
    assert.equal(await page.locator('#retouch-save').isDisabled(), false);
    await page.unroute('**/api/jobs/*/retouch');
  });
  await test('RETOUCH-10', '保存生成独立新结果，下载包含修补', async () => {
    const pending = page.waitForResponse(r => /\/retouch$/.test(r.url()) && r.request().method() === 'POST');
    await page.locator('#retouch-save').click();
    const response = await pending; assert.equal(response.status(), 201); edited = await response.json();
    await page.waitForFunction(() => !document.querySelector('#retouch-dialog').open && !document.querySelector('#quick-download').disabled);
    assert.notEqual(job.id, edited.id);
    assert.equal((await pixel(job.groups[0].frames[0].url, point))[3], 255);
    assert.equal((await pixel(edited.groups[0].frames[0].url, point))[3], 0);
    assert.equal((await pixel(edited.groups[0].frames[0].url, background))[3], 255);
    const download = page.waitForEvent('download'); await page.locator('#quick-download').click();
    await (await download).saveAs(path.join(output, 'retouched-download.png'));
    fs.writeFileSync(path.join(output, 'pixel-expectations.json'), JSON.stringify({ point, background, job: job.id, edited: edited.id }, null, 2));
    await page.screenshot({ path: path.join(output, 'retouched-result.png'), fullPage: true });
  });
  await test('RETOUCH-11', '刷新及点击品牌后恢复修补结果', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#retouch-open').disabled);
    assert.ok((await page.locator('#retouch-entry-hint').textContent()).includes('修补已保存'));
    await open(); assert.equal((await pixel('#retouch-canvas', point))[3], 0);
    await page.locator('#retouch-cancel').click();
    await page.locator('#brand-home').click(); await page.waitForURL(url => url.pathname === '/editor');
    await page.waitForFunction(() => { try { return !restoringWorkspace && !state.busy && !state.importing; } catch { return false; } });
    assert.equal(await page.locator('#retouch-open').isDisabled(), false);
  });
  await test('RETOUCH-12', '取消修补不写入结果，换工具不串内容', async () => {
    await open(); await brush(point, 'restore'); await page.locator('#retouch-cancel').click();
    await open(); assert.equal((await pixel('#retouch-canvas', point))[3], 0); await page.keyboard.press('Escape');
    await page.locator('[data-tool="rename"]').click();
    assert.equal(await page.locator('#retouch-entry').isVisible(), false);
    await page.locator('[data-tool="cutout"]').click();
    await page.waitForFunction(() => !document.querySelector('#retouch-open').disabled);
    assert.ok((await page.locator('#retouch-entry-hint').textContent()).includes('修补已保存'));
  });
  await test('RETOUCH-13', '触摸涂抹、手机布局和深色修补可用', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#theme-button').click(); await open();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(await page.locator('#retouch-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    const touch = await page.locator('#retouch-canvas').evaluate((node, at) => { const b = node.getBoundingClientRect(); return { x: b.x + at.x / node.width * b.width, y: b.y + at.y / node.height * b.height }; }, background);
    await page.touchscreen.tap(touch.x, touch.y);
    assert.equal((await pixel('#retouch-canvas', background))[3], 0);
    await page.screenshot({ path: path.join(output, 'retouch-mobile-dark.png') });
    await page.locator('#retouch-cancel').click();
  });
  await test('RETOUCH-14', '工作台与修补操作没有 JavaScript 异常', async () => { assert.deepEqual(errors, []); });
  await test('RETOUCH-15', '多图仅修补当前素材，保存与刷新保持选中素材', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const pending = page.waitForEvent('filechooser'); await page.locator('#top-upload').click();
    await (await pending).setFiles(path.join(root, 'web/static/examples/bytepet/originals/comfort_0001_uploaded_input.png'));
    await page.waitForFunction(() => !document.querySelector('#process-button').disabled);
    const multiple = await generate();
    assert.equal(multiple.groups.length, 2);
    await page.locator('#group-select').selectOption('1');
    await page.waitForFunction(() => document.querySelector('#stage-label').textContent === 'comfort_0001_uploaded_input.png' && !document.querySelector('#retouch-open').disabled);
    const secondPoint = (await pixels(multiple.groups[1].frames[0].url)).foreground;
    await open(); await brush(secondPoint);
    const response = page.waitForResponse(r => /\/retouch$/.test(r.url()) && r.request().method() === 'POST');
    await page.locator('#retouch-save').click();
    const revision = await (await response).json();
    await page.waitForFunction(() => !document.querySelector('#retouch-dialog').open && document.querySelector('#group-select').value === '1');
    assert.equal((await pixel(revision.groups[1].frames[0].url, secondPoint))[3], 0);
    assert.equal((await pixel(multiple.groups[1].frames[0].url, secondPoint))[3], 255);
    const firstPoint = (await pixels(multiple.groups[0].frames[0].url)).foreground;
    assert.deepEqual(await pixel(revision.groups[0].frames[0].url, firstPoint), await pixel(multiple.groups[0].frames[0].url, firstPoint));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#retouch-open').disabled);
    assert.equal(await page.locator('#group-select').inputValue(), '1');
  });
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'retouch-results.json'), JSON.stringify({ results, errors, passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length }, null, 2));
  if (browser) await browser.close();
});
