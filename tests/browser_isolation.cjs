const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.runtime/session-evidence');
fs.mkdirSync(output, { recursive: true });
let browser;
const results = [];
const errors = [];

async function test(id, name, action) {
  try { await action(); results.push({ id, name, status: 'PASS' }); console.log('PASS ' + id + ' ' + name); }
  catch (error) { results.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}

(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.FRAMELAB_BROWSER_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const readyExample = async () => {
    await page.waitForFunction(() => !document.querySelector('#example-load').disabled && document.querySelector('#example-details').textContent.length > 0);
  };
  const tryExample = async () => {
    await readyExample();
    const response = page.waitForResponse(response => response.url().endsWith('/api/process') && response.request().method() === 'POST');
    await page.locator(await page.locator('#example-load').isVisible() ? '#example-load' : '#empty-demo').click();
    const result = await (await response).json();
    assert.equal(result.ok, true);
    await page.waitForFunction(() => !document.querySelector('#quick-download').disabled && document.querySelector('.frame-card'));
    return result;
  };
  const switchTool = async tool => {
    await page.locator('[data-tool="' + tool + '"]').click();
    await readyExample();
  };
  const quickDownload = async filename => {
    const event = page.waitForEvent('download');
    await page.locator('#quick-download').click();
    const file = await event;
    await file.saveAs(path.join(output, filename));
    assert.equal(await file.failure(), null);
  };
  const screenshot = async filename => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.screenshot({ path: path.join(output, filename), fullPage: true });
  };
  let split, cutout, rename;
  await test('EASY-01', '默认收起高级设置，示例入口明确', async () => {
    await page.goto('http://127.0.0.1:7860/editor', { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#advanced-settings').evaluate(node => node.open), false);
    assert.equal((await page.locator('#example-load').textContent()).trim(), '一键试用');
  });
  await test('EASY-02', '切帧示例一次点击就生成可下载结果', async () => {
    split = await tryExample(); assert.equal(split.frame_count, 6);
    assert.equal(split.options.mode, 'split');
    await screenshot('split-one-click.png');
  });
  await test('EASY-03', '结果直接下载，无需再选格式', async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const box = await page.locator('#quick-download').boundingBox();
    assert.ok(box.y + box.height < 1050, '下载结果应显示在预览上方，无需向下寻找');
    await quickDownload('split-direct.zip');
    assert.equal(await page.locator('#export-dialog').count(), 0);
  });
  await test('STATE-01', '切帧工作区记录参数、素材和视图', async () => {
    await page.locator('#frames').fill('4');
    await page.locator('#advanced-settings summary').click();
    await page.locator('#size').selectOption('128');
    await page.locator('#prefix').fill('split_only');
    await page.locator('#fps').selectOption('8');
    await page.locator('[data-view="source"]').click();
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
  });
  await test('EASY-04', '抠图使用自己的默认工作区和一键示例', async () => {
    await switchTool('cutout'); assert.equal(await page.locator('.upload-item').count(), 0);
    assert.equal(await page.locator('#advanced-settings').evaluate(node => node.open), false);
    cutout = await tryExample(); assert.equal(cutout.options.mode, 'cutout');
    assert.equal(cutout.frame_count, 1); assert.equal(cutout.groups[0].frames[0].width, 1254);
    await quickDownload('cutout-direct.png'); await screenshot('cutout-one-click.png');
  });
  await test('STATE-02', '抠图设置与切帧参数独立', async () => {
    await page.locator('#advanced-settings summary').click();
    await page.locator('#tolerance').fill('27');
    await page.locator('#prefix').fill('cutout_only');
    await switchTool('split');
    assert.equal(await page.locator('#frames').inputValue(), '4');
    assert.equal(await page.locator('#size').inputValue(), '128');
    assert.equal(await page.locator('#prefix').inputValue(), 'split_only');
    assert.equal(await page.locator('#fps').inputValue(), '8');
    assert.ok((await page.locator('.upload-item').textContent()).includes('calm-bytepet-strip.png'));
    assert.ok(!(await page.locator('.upload-item').textContent()).includes('star'));
    assert.equal(await page.locator('#advanced-settings').evaluate(node => node.open), true);
  });
  await test('STATE-03', '切回抠图恢复抠图素材和设置', async () => {
    await switchTool('cutout');
    assert.equal(await page.locator('#tolerance').inputValue(), '27');
    assert.equal(await page.locator('#prefix').inputValue(), 'cutout_only');
    assert.ok((await page.locator('.upload-item').textContent()).includes('star_uploaded_input.png'));
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
  });
  await test('EASY-05', '批量命名一键得到六张结果并直接下载', async () => {
    await switchTool('rename'); assert.equal(await page.locator('.upload-item').count(), 0);
    rename = await tryExample(); assert.equal(rename.options.mode, 'rename');
    assert.equal(rename.frame_count, 6); assert.equal(await page.locator('.frame-card').count(), 6);
    assert.equal(await page.locator('#advanced-settings').isVisible(), false);
    await quickDownload('rename-direct.zip'); await screenshot('rename-one-click.png');
  });
  await test('STATE-04', '三工具往返不混用工作区', async () => {
    for (const tool of ['split', 'cutout', 'rename', 'split', 'rename']) await switchTool(tool);
    assert.equal(await page.locator('#prefix').inputValue(), 'asset');
    assert.equal(await page.locator('.upload-item').count(), 6);
    assert.equal(await page.locator('#quick-download').isDisabled(), false);
  });
  await test('RACE-01', '迟到的示例请求不能覆盖另一个工具', async () => {
    await switchTool('split');
    await page.route('**/run_right-strip.png', async route => { await new Promise(resolve => setTimeout(resolve, 500)); await route.continue(); });
    await page.locator('#example-select').selectOption('run_right');
    await page.locator('[data-tool="rename"]').click();
    await new Promise(resolve => setTimeout(resolve, 800));
    await readyExample();
    assert.equal(await page.locator('[data-tool="rename"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.upload-item').count(), 6);
    assert.equal(await page.locator('#prefix').inputValue(), 'asset');
    await page.unroute('**/run_right-strip.png');
  });
  await test('SESSION-01', '同一浏览器的新标签页不共享任务记录或工作区', async () => {
    const second = await context.newPage();
    await second.goto('http://127.0.0.1:7860/editor', { waitUntil: 'networkidle' });
    assert.equal(await second.locator('#history-count').textContent(), '0');
    assert.equal(await second.locator('.upload-item').count(), 0);
    assert.ok(Number(await page.locator('#history-count').textContent()) >= 3);
    await second.close();
  });
  await test('SESSION-02', '另一浏览器会话不能读取已知任务链接', async () => {
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto('http://127.0.0.1:7860/editor');
    for (const url of ['/api/jobs/' + split.id, split.groups[0].source_url, split.groups[0].frames[0].url, split.zip_url, split.sheet_url, split.gif_url]) {
      assert.equal((await other.request.get('http://127.0.0.1:7860' + url)).status(), 404);
    }
    await other.close();
  });
  await test('SESSION-03', '刷新保留当前标签页历史与本会话访问权限', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    assert.ok(Number(await page.locator('#history-count').textContent()) >= 3);
    assert.equal((await context.request.get('http://127.0.0.1:7860/api/jobs/' + rename.id)).status(), 200);
  });
  await test('RACE-02', '迟到的历史响应不会强行切换当前工具', async () => {
    await page.locator('[data-tool="history"]').click();
    await page.route('**/api/jobs/' + rename.id, async route => { await new Promise(resolve => setTimeout(resolve, 500)); await route.continue(); });
    await page.locator('.history-card .button').first().click();
    await page.locator('[data-tool="split"]').click();
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(await page.locator('[data-tool="split"]').getAttribute('aria-current'), 'page');
    await page.unroute('**/api/jobs/' + rename.id);
  });
  await test('EASY-06', '手机一键示例和直接下载可用', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await switchTool('cutout'); await tryExample();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await quickDownload('mobile-cutout.png'); await screenshot('mobile-one-click.png');
  });
  await test('UI-01', '控制台无 JavaScript 异常', async () => { assert.deepEqual(errors, []); });
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'isolation-results.json'), JSON.stringify({ results, errors, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status === 'FAIL').length }, null, 2));
  if (browser) await browser.close();
});
