/* Integration check: keep this browser open while restarting the local server.
   Wait for restart-ready.json, restart app.py, then create restart-resume.flag. */
const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.runtime/refresh-evidence');
const flag = path.join(output, 'restart-resume.flag');
const ready = path.join(output, 'restart-ready.json');
fs.mkdirSync(output, { recursive: true });
for (const file of [flag, ready]) if (fs.existsSync(file)) fs.unlinkSync(file);
let browser;
const record = { id: 'SQLITE-RESTART-01', name: '真实服务重启后从 SQLite 恢复原图、参数并继续生成', status: 'FAIL' };
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.FRAMELAB_BROWSER_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:7860/?tool=cutout', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#top-upload').disabled);
  await page.locator('#file-input').setInputFiles(path.join(root, 'web/static/examples/bytepet/originals/comfort_0001_uploaded_input.png'));
  await page.waitForFunction(() => !document.querySelector('#process-button').disabled);
  await page.locator('#prefix').fill('sqlite_restart');
  await page.waitForLoadState('networkidle');
  const tab = await page.evaluate(() => sessionStorage.getItem('framelab-tab-v1'));
  const state = await page.request.get('http://127.0.0.1:7860/api/workspaces/' + tab + '/state');
  assert.equal((await state.json()).state.workspaces.cutout.formValues.prefix, 'sqlite_restart');
  // Prove recovery uses the database rather than the browser's pending copy.
  await page.evaluate(() => sessionStorage.removeItem('framelab-workspaces-v1'));
  fs.writeFileSync(ready, JSON.stringify({ ready: true, database: '.runtime/workspaces/workspaces.sqlite3' }));
  console.log('READY for local server restart');
  const deadline = Date.now() + 120000;
  while (!fs.existsSync(flag) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(fs.existsSync(flag), '未收到服务重启完成信号');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.querySelector('#top-upload').disabled);
  assert.equal(await page.locator('.upload-item').count(), 1);
  assert.equal(await page.locator('#stage-label').textContent(), 'comfort_0001_uploaded_input.png');
  assert.equal(await page.locator('#prefix').inputValue(), 'sqlite_restart');
  const pending = page.waitForResponse(response => response.url().endsWith('/api/process') && response.request().method() === 'POST');
  await page.locator('#process-button').click();
  const response = await pending;
  assert.equal(response.status(), 201);
  await page.waitForFunction(() => !document.querySelector('#quick-download').disabled);
  assert.deepEqual(errors, []);
  record.status = 'PASS';
  console.log('PASS ' + record.id + ' ' + record.name);
})().catch(error => { record.error = error.message; console.error(error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'restart-results.json'), JSON.stringify(record, null, 2));
  if (browser) await browser.close();
});
