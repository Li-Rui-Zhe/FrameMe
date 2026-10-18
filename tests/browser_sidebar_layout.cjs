const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname, '../.runtime/sidebar-evidence');
fs.mkdirSync(output, { recursive: true });
const results = [];
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.FRAMELAB_BROWSER_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 768 }, reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:7860/editor', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#top-upload').disabled);
  for (const dark of [false, true]) {
    if (await page.locator('body').evaluate(node => node.classList.contains('dark')) !== dark) await page.locator('#theme-button').click();
    for (const [width, height] of [[1440, 900], [1440, 780], [1440, 768], [1440, 650], [1440, 600], [1440, 500], [1100, 600], [1024, 500], [390, 600]]) {
      await page.setViewportSize({ width, height });
      const id = `${dark ? 'dark' : 'light'}-${width}x${height}`;
      try {
        await page.locator('.sidebar').evaluate(node => { node.scrollTop = 0; });
        const metrics = await page.evaluate(() => {
          const sidebar = document.querySelector('.sidebar');
          const card = document.querySelector('.sidebar-note');
          const button = document.querySelector('#sidebar-demo');
          const footer = document.querySelector('.sidebar-bottom');
          return { sidebarHeight: sidebar.getBoundingClientRect().height,
            cardVisible: getComputedStyle(card).display !== 'none',
            cardHeight: card.clientHeight, cardContent: card.scrollHeight,
            cardBottom: card.getBoundingClientRect().bottom, buttonBottom: button.getBoundingClientRect().bottom,
            footerTop: footer.getBoundingClientRect().top, overflow: document.documentElement.scrollWidth > innerWidth };
        });
        assert.equal(metrics.overflow, false, '页面横向溢出');
        if (width > 760) assert.ok(Math.abs(metrics.sidebarHeight - height) <= 1, '侧栏应适配实际窗口高度');
        if (metrics.cardVisible) {
          assert.ok(metrics.cardContent <= metrics.cardHeight + 1, '示例卡片内容被压缩裁切: ' + JSON.stringify(metrics));
          assert.ok(metrics.buttonBottom < metrics.cardBottom, '示例入口必须完整位于卡片内');
          assert.ok(metrics.footerTop >= metrics.cardBottom + 10, '使用指南与卡片间需保留间距');
          await page.locator('#help-button').scrollIntoViewIfNeeded();
          const help = await page.locator('#help-button').boundingBox();
          assert.ok(help.y >= 0 && help.y + help.height <= height, '使用指南必须可滚动到视口中');
          if (height >= 600) assert.equal(await page.locator('.sidebar').evaluate(node => node.scrollTop), 0, '常见笔记本高度无需滚动侧栏');
          if (height === 768 || height === 600) await page.screenshot({ path: path.join(output, `${id}.png`) });
        }
        results.push({ id, status: 'PASS' });
        console.log('PASS ' + id);
      } catch (error) { results.push({ id, status: 'FAIL', error: error.message }); throw error; }
    }
  }
  await page.setViewportSize({ width: 1440, height: 768 });
  await page.locator('#help-button').click();
  assert.equal(await page.locator('#help-dialog').isVisible(), true);
  await page.keyboard.press('Escape');
  await page.locator('#sidebar-demo').click();
  await page.waitForFunction(() => !document.querySelector('#quick-download').disabled);
  results.push({ id: 'sidebar-actions', status: 'PASS' });
  console.log('PASS sidebar-actions');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'sidebar-results.json'), JSON.stringify({ results, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status === 'FAIL').length }, null, 2));
  if (browser) await browser.close();
});
