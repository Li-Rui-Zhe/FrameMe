const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.runtime/brand-evidence');
fs.mkdirSync(output, { recursive: true });
const results = [], errors = [];
let browser, page;
async function test(id, name, action) {
  try { await action(); results.push({ id, name, status: 'PASS' }); console.log('PASS ' + id + ' ' + name); }
  catch (error) { results.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
async function ready() {
  await page.waitForFunction(() => !document.querySelector('#top-upload').disabled);
  await page.waitForLoadState('networkidle');
}
async function snapshot(name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(output, name), fullPage: true });
}
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.FRAMELAB_BROWSER_PATH || undefined });
  page = await browser.newPage({ viewport: { width: 1600, height: 1120 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await test('BRAND-01', '帧的么 FrameMe 标题、品牌与 API 标识统一', async () => {
    await page.goto('http://127.0.0.1:7860/editor', { waitUntil: 'networkidle' }); await ready();
    assert.ok((await page.title()).includes('帧的么 FrameMe'));
    assert.ok((await page.locator('.brand').textContent()).includes('FrameMe'));
    assert.equal((await (await page.request.get('http://127.0.0.1:7860/api/health')).json()).name, 'FrameMe');
    assert.equal(await page.locator('#save-indicator').getAttribute('data-status'), 'saved');
    await snapshot('frameme-light.png');
  });
  await test('BRAND-02', '浅色、深色主题和三个工具都能正常展示', async () => {
    await page.locator('#theme-button').click(); await snapshot('frameme-dark.png');
    assert.equal(await page.locator('body').evaluate(node => node.classList.contains('dark')), true);
    for (const tool of ['cutout', 'rename', 'split']) {
      await page.locator('[data-tool="' + tool + '"]').click(); await ready();
      assert.equal(await page.locator('body').getAttribute('data-workspace-tool'), tool);
      assert.equal(await page.locator('#workspace-view').isVisible(), true);
    }
    await page.locator('#theme-button').click();
  });
  await test('BRAND-03', '桌面、平板及窄屏没有横向溢出，手机显示工具文字', async () => {
    for (const width of [1920, 1440, 1024, 768, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, width + 'px overflow');
      if (width <= 760) {
        for (const tool of ['split', 'cutout', 'rename']) assert.equal(await page.locator('.tool-nav [data-tool="' + tool + '"]>span').first().isVisible(), true);
      }
      if (width === 390) await snapshot('frameme-mobile.png');
    }
    await page.setViewportSize({ width: 1600, height: 1120 });
  });
  await test('BRAND-04', '一键示例生成、直接下载和自动保存状态可用', async () => {
    await page.locator('#sidebar-demo').click();
    await page.waitForFunction(() => !document.querySelector('#quick-download').disabled && document.querySelector('.frame-card'));
    await page.waitForFunction(() => document.querySelector('#save-indicator').dataset.status === 'saved');
    const pending = page.waitForEvent('download');
    await page.locator('#quick-download').click();
    const file = await pending;
    await file.saveAs(path.join(output, 'frameme-example.zip'));
    assert.equal(await file.failure(), null);
    await snapshot('frameme-result.png');
  });
  await test('BRAND-05', '保存失败有真实反馈，恢复连接后能重新保存', async () => {
    await page.route('**/api/workspaces/*/state', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'QA: simulated outage' }) }) : route.continue());
    await page.locator('#prefix').fill('save_feedback');
    await page.waitForFunction(() => document.querySelector('#save-indicator').dataset.status === 'error');
    await page.unroute('**/api/workspaces/*/state');
    await page.locator('#prefix').fill('recovered_save');
    await page.waitForFunction(() => document.querySelector('#save-indicator').dataset.status === 'saved');
    await page.reload({ waitUntil: 'networkidle' }); await ready();
    assert.equal(await page.locator('#prefix').inputValue(), 'recovered_save');
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
    assert.equal(await page.locator('.frame-card').count(), 6);
  });
  await test('BRAND-07', '浅深主题的主要文字对比度达到 4.5:1，键盘焦点可见', async () => {
    for (const dark of [false, true]) {
      if (await page.locator('body').evaluate(node => node.classList.contains('dark')) !== dark) await page.locator('#theme-button').click();
      const checks = await page.evaluate(() => {
        const luminance = rgb => rgb.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const rgb = color => color.match(/[\d.]+/g).map(Number);
        return ['h1', '.intro p', '.panel-title', '.field>label', '.case-badge', '.segmented button.selected', '.nav-item.active'].map(selector => {
          const node = document.querySelector(selector);
          const foreground = luminance(rgb(getComputedStyle(node).color));
          let ancestor = node, background;
          while (ancestor) {
            const color = rgb(getComputedStyle(ancestor).backgroundColor);
            if (color.length < 4 || color[3] === 1) { background = luminance(color); break; }
            ancestor = ancestor.parentElement;
          }
          return { selector, ratio: (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) };
        });
      });
      for (const check of checks) assert.ok(check.ratio >= 4.5, JSON.stringify({ dark, ...check }));
    }
    await page.locator('#theme-button').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#top-upload').evaluate(node => document.activeElement === node), true);
    assert.notEqual(await page.locator('#top-upload').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
  });
  await test('BRAND-06', '新界面没有 JavaScript 异常', async () => { assert.deepEqual(errors, []); });
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'brand-results.json'), JSON.stringify({ results, errors, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status === 'FAIL').length }, null, 2));
  if (browser) await browser.close();
});
