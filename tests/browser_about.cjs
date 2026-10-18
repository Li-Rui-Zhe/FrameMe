const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.runtime/about-evidence');
fs.mkdirSync(output, { recursive: true });
const results = [], errors = [];
let browser, page, context, job, tab;
async function test(id, name, action) {
  try { await action(); results.push({ id, name, status: 'PASS' }); console.log('PASS ' + id + ' ' + name); }
  catch (error) { results.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
async function ready() { await page.waitForFunction(() => { try { return !restoringWorkspace && !state.busy && !state.importing && !document.querySelector('#top-upload').disabled; } catch { return false; } }); }
async function about() { await page.locator('#about-link').click(); await page.waitForURL(url => url.pathname === '/about'); await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true'); }
async function editor(link) { await page.locator(link).click(); await page.waitForURL(url => url.pathname === '/editor'); await ready(); }
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.FRAMELAB_BROWSER_PATH || undefined });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(response.status() + ' ' + response.url()); });
  await test('ABOUT-01', '根地址保持工作台，项目介绍位于序列帧上方', async () => {
    await page.goto('http://127.0.0.1:7860/', { waitUntil: 'networkidle' }); await ready();
    assert.equal(await page.locator('body').getAttribute('data-page'), 'editor');
    const order = await page.locator('.tool-nav>.nav-item').evaluateAll(nodes => nodes.map(node => node.textContent.trim()));
    assert.ok(order[0].startsWith('项目介绍')); assert.ok(order[1].startsWith('序列帧切割'));
    assert.equal(await page.locator('#about-link').getAttribute('href'), '/about');
  });
  await test('ABOUT-02', '介绍前先处理自己的图片并保存参数', async () => {
    await page.locator('[data-tool="cutout"]').click(); await ready();
    await page.locator('#file-input').setInputFiles(path.join(root, 'web/static/examples/bytepet/originals/star_uploaded_input.png'));
    await page.waitForFunction(() => !document.querySelector('#process-button').disabled);
    await page.locator('#prefix').fill('about_check');
    const pending = page.waitForResponse(response => response.url().endsWith('/api/process') && response.request().method() === 'POST');
    await page.locator('#process-button').click(); const response = await pending; assert.equal(response.status(), 201); job = await response.json();
    await page.waitForFunction(() => !document.querySelector('#quick-download').disabled);
    tab = await page.evaluate(() => sessionStorage.getItem('framelab-tab-v1'));
  });
  await test('ABOUT-03', '介绍覆盖项目功能且使用正确的原始素材', async () => {
    await about();
    assert.equal(await page.locator('#about-link').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.about-tool').count(), 3);
    assert.equal(await page.locator('#preview-canvas, #settings-form').count(), 0);
    const text = await page.locator('main').textContent();
    for (const word of ['序列帧切割', '手动', '批量命名', '精灵图', 'GIF', '长期保存在本机']) assert.ok(text.includes(word), word);
    for (const word of ['一张图', '1 张长条图 → 6 张动作帧', '生图工具', '同一张图']) assert.ok(text.includes(word), word);
    assert.equal(await page.locator('#about-frame-flow .frame-flow-frames img').count(), 6);
    await page.waitForFunction(() => [...document.querySelectorAll('#about-frame-flow img')].every(image => image.complete && image.naturalWidth > 0));
    await page.waitForFunction(() => [...document.querySelectorAll('.about-hero img')].every(image => image.complete && image.naturalWidth > 0));
    assert.equal(await page.evaluate(() => sessionStorage.getItem('framelab-tab-v1')), tab);
    await page.screenshot({ path: path.join(output, 'about-light.png'), fullPage: true });
  });
  await test('ABOUT-04', '返回工作台保留当前工具、素材、参数与下载结果', async () => {
    await editor('.about-hero-copy>a');
    assert.equal(await page.locator('[data-tool="cutout"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#prefix').inputValue(), 'about_check');
    assert.equal(await page.locator('.upload-item').count(), 1);
    assert.equal(await page.locator('#quick-download').isDisabled(), false);
    const image = await page.request.get('http://127.0.0.1:7860' + job.groups[0].frames[0].url); assert.equal(image.status(), 200);
  });
  await test('ABOUT-05', '三项功能按钮分别进入对应工具', async () => {
    for (const tool of ['split', 'rename', 'cutout']) {
      await about(); await editor('[data-feature="' + tool + '"]>a');
      assert.equal(await page.locator('[data-tool="' + tool + '"]').getAttribute('aria-current'), 'page');
      assert.equal(new URL(page.url()).searchParams.get('tool'), tool);
    }
  });
  await test('ABOUT-06', '刷新、前进后退保持介绍页与编辑进度', async () => {
    await about(); await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
    assert.equal(new URL(page.url()).pathname, '/about');
    await page.goBack({ waitUntil: 'domcontentloaded' }); await ready();
    assert.equal(await page.locator('#prefix').inputValue(), 'about_check');
    await page.goForward({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
    assert.equal(await page.locator('#about-title').isVisible(), true);
  });
  await test('ABOUT-07', '介绍页 FAQ 可展开，指南入口能到达使用流程', async () => {
    await page.locator('.about-faq summary').first().click();
    assert.equal(await page.locator('.about-faq details').first().getAttribute('open'), '');
    await page.locator('.sidebar-guide').click();
    assert.equal(new URL(page.url()).hash, '#about-how');
  });
  await test('ABOUT-08', '浅深主题与桌面、平板、手机布局无溢出', async () => {
    for (const dark of [true, false]) {
      if (await page.locator('body').evaluate(node => node.classList.contains('dark')) !== dark) await page.locator('#theme-button').click();
      for (const width of [1920, 1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, width + ' overflow');
        if (width <= 760) {
          for (const node of await page.locator('.tool-nav .nav-item').all()) assert.equal(await node.isVisible(), true);
        }
        if (width === 390 && dark) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(output, 'about-mobile-dark.png'), fullPage: true }); }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      if (dark) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(output, 'about-dark.png'), fullPage: true }); }
    }
  });
  await test('ABOUT-09', '从介绍页打开新标签也不能带入原标签的素材', async () => {
    const [other] = await Promise.all([page.waitForEvent('popup'), page.evaluate(() => window.open('/about', '_blank'))]);
    await other.waitForLoadState('networkidle');
    const otherTab = await other.evaluate(() => sessionStorage.getItem('framelab-tab-v1')); assert.notEqual(otherTab, tab);
    await other.locator('.about-hero-copy>a').click(); await other.waitForURL(url => url.pathname === '/editor');
    await other.waitForFunction(() => !document.querySelector('#top-upload').disabled);
    assert.equal(await other.locator('.upload-item').count(), 0); await other.close();
  });
  await test('ABOUT-10', '介绍页的真实示例入口可生成并下载结果', async () => {
    const pending = page.waitForResponse(response => response.url().endsWith('/api/process') && response.request().method() === 'POST');
    await page.locator('.sidebar-sample').click(); const response = await pending; assert.equal(response.status(), 201);
    await page.waitForFunction(() => !document.querySelector('#quick-download').disabled);
    assert.equal(await page.locator('.frame-card').count(), 6);
    assert.equal(new URL(page.url()).searchParams.has('demo'), false);
  });
  await test('ABOUT-11', '没有 JavaScript 异常与失败的页面资源', async () => { assert.deepEqual(errors, []); });
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'about-results.json'), JSON.stringify({ results, errors, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status === 'FAIL').length }, null, 2));
  if (browser) await browser.close();
});
