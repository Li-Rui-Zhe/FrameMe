const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.runtime/retention-evidence');
fs.mkdirSync(output, { recursive: true });
const results = [], errors = [];
let browser, context, page, first, second, third;
async function test(id, name, action) {
  try { await action(); results.push({ id, name, status: 'PASS' }); console.log('PASS ' + id + ' ' + name); }
  catch (error) { results.push({ id, name, status: 'FAIL', error: error.message }); throw error; }
}
async function ready(target = page) { await target.waitForFunction(() => { try { return !restoringWorkspace && !state.busy && !state.importing && !document.querySelector('#top-upload').disabled; } catch { return false; } }); }
async function history(target = page, count) {
  await target.locator('[data-tool="history"]').click();
  await target.waitForFunction(() => document.querySelector('#history-storage').textContent.includes('任务文件'));
  if (count !== undefined) await target.waitForFunction(count => document.querySelectorAll('.history-card').length === count, count);
}
async function generate(prefix) {
  await page.locator('#prefix').fill(prefix);
  const pending = page.waitForResponse(response => response.url().endsWith('/api/process') && response.request().method() === 'POST');
  await page.locator('#process-button').click(); const response = await pending;
  assert.equal(response.status(), 201); const job = await response.json();
  await page.waitForFunction(() => !document.querySelector('#quick-download').disabled);
  return job;
}
function row(id) { return page.locator('.history-card[data-job-id="' + id + '"]'); }
async function deletion() {
  const pending = page.waitForResponse(response => response.url().includes('/jobs') && response.request().method() === 'DELETE');
  await page.locator('#delete-history-confirm').click(); const response = await pending;
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => !document.querySelector('#delete-history-dialog').open);
  return response.json();
}
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.FRAMELAB_BROWSER_PATH || undefined });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message));
  await test('KEEP-01', '界面显示长期保存，上传原图、参数和结果仍正常', async () => {
    await page.goto('http://127.0.0.1:7860/?tool=rename', { waitUntil: 'networkidle' }); await ready();
    assert.ok((await page.locator('.storage-note').textContent()).includes('长期保留'));
    await page.locator('#file-input').setInputFiles([1, 2].map(number => path.join(root, 'web/static/examples/bytepet/frames/calm_000' + number + '.png')));
    await page.waitForFunction(() => !document.querySelector('#process-button').disabled);
    first = await generate('keep_first'); second = await generate('keep_second');
    assert.equal(first.expires_at, null); assert.equal(second.expires_at, null);
  });
  await test('KEEP-02', '九十天前的旧任务与旧过期缓存不再被禁用', async () => {
    const manifest = path.join(root, '.runtime/jobs', first.id, 'manifest.json');
    assert.match(first.id, /^[a-f0-9]{32}$/);
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8')); data.created_at = Date.now() / 1000 - 90 * 86400;
    fs.writeFileSync(manifest, JSON.stringify(data)); fs.utimesSync(manifest, data.created_at, data.created_at);
    await page.evaluate(id => {
      const history = JSON.parse(sessionStorage.getItem('framelab-history-v2')); history.find(item => item.id === id).expires_at = 1;
      sessionStorage.setItem('framelab-history-v2', JSON.stringify(history));
    }, first.id);
    await history(page, 2);
    assert.equal(await row(first.id).locator('button').first().isDisabled(), false);
    assert.equal(await page.locator('.expired-label').count(), 0);
    assert.equal((await page.request.get('http://127.0.0.1:7860' + first.zip_url)).status(), 200);
  });
  await test('KEEP-03', '历史显示真实任务占用和导入草稿占用', async () => {
    assert.ok((await page.locator('#history-storage').textContent()).includes('导入草稿'));
    const tab = await page.evaluate(() => sessionStorage.getItem('framelab-tab-v1'));
    const data = await (await page.request.get('http://127.0.0.1:7860/api/workspaces/' + tab + '/jobs')).json();
    assert.ok(data.bytes > 0 && data.draft_bytes > 0);
    assert.ok((await row(first.id).textContent()).includes('长期保存'));
    await page.screenshot({ path: path.join(output, 'permanent-history.png'), fullPage: true });
  });
  await test('KEEP-04', '打开长期任务可恢复原图副本、参数并重新处理', async () => {
    await row(first.id).getByRole('button', { name: '打开任务', exact: true }).click(); await ready();
    await page.waitForFunction(() => document.querySelector('#prefix').value === 'keep_first' && !document.querySelector('#process-button').disabled);
    assert.equal(await page.locator('#prefix').inputValue(), 'keep_first');
    assert.equal(await page.locator('.upload-item').count(), 2);
    assert.equal(await page.locator('#process-button').isDisabled(), false);
    third = await generate('keep_again');
    await history(page, 3);
  });
  await test('KEEP-05', '丢失浏览器历史缓存后仍可从本地任务找回', async () => {
    await page.evaluate(() => sessionStorage.removeItem('framelab-history-v2'));
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    await history(page, 3);
    assert.equal(await page.locator('#history-count').textContent(), '3');
  });
  await test('KEEP-06', '新标签默认隔离，主动查看所有工作区后才能导入旧结果', async () => {
    const other = await context.newPage(); await other.goto('http://127.0.0.1:7860/editor?tool=history', { waitUntil: 'networkidle' }); await ready(other); await history(other, 0);
    assert.equal(await other.locator('#history-count').textContent(), '0');
    await other.locator('#history-scope').selectOption('all');
    await other.waitForFunction(() => document.querySelectorAll('.history-card').length === 3);
    await other.locator('.history-card[data-job-id="' + first.id + '"]').getByRole('button', { name: '打开任务', exact: true }).click(); await ready(other);
    await other.waitForFunction(() => document.querySelector('#prefix').value === 'keep_first' && !document.querySelector('#process-button').disabled);
    assert.equal(await other.locator('.upload-item').count(), 2);
    assert.equal(await other.locator('#prefix').inputValue(), 'keep_first');
    await other.close();
  });
  await test('KEEP-07', '保留 Cookie 的新浏览器窗口可找回关闭工作区的任务', async () => {
    const state = await context.storageState();
    assert.ok(state.cookies.find(cookie => cookie.name === 'framelab_session').expires > Date.now() / 1000 + 86400);
    const restored = await browser.newContext({ storageState: state }); const other = await restored.newPage();
    await other.goto('http://127.0.0.1:7860/editor?tool=history', { waitUntil: 'networkidle' }); await ready(other); await history(other, 0);
    await other.locator('#history-scope').selectOption('all'); await other.waitForFunction(() => document.querySelectorAll('.history-card').length === 3);
    await restored.close();
  });
  await test('KEEP-08', '删除前会确认，取消不会删除任何结果', async () => {
    await row(third.id).getByRole('button', { name: '删除', exact: true }).click();
    assert.equal(await page.locator('#delete-history-dialog').isVisible(), true);
    assert.ok((await page.locator('#delete-history-summary').textContent()).includes('无法撤销'));
    await page.locator('#delete-history-cancel').click();
    assert.equal((await page.request.get('http://127.0.0.1:7860/api/jobs/' + third.id)).status(), 200);
    assert.equal(await page.locator('.history-card').count(), 3);
  });
  await test('KEEP-09', '单独删除当前结果，刷新后仍保留原图和处理参数', async () => {
    await row(third.id).getByRole('button', { name: '删除', exact: true }).click(); await deletion();
    await page.waitForFunction(() => document.querySelectorAll('.history-card').length === 2);
    assert.equal((await page.request.get('http://127.0.0.1:7860/api/jobs/' + third.id)).status(), 404);
    await page.locator('[data-tool="rename"]').click(); await ready();
    assert.equal(await page.locator('#process-button').isDisabled(), false);
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
    assert.equal(await page.locator('.upload-item').count(), 2);
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    assert.equal(await page.locator('.upload-item').count(), 2);
    assert.equal(await page.locator('#prefix').inputValue(), 'keep_again');
    await history(page, 2);
  });
  await test('KEEP-10', '批量选择显示数量与占用，删除后空间统计归零', async () => {
    await page.locator('#history-select-all').check();
    assert.ok((await page.locator('#history-selected').textContent()).includes('已选 2 项'));
    await page.locator('#delete-history-selected').click();
    await page.screenshot({ path: path.join(output, 'delete-confirm.png') });
    const result = await deletion(); assert.equal(result.deleted.length, 2);
    await page.waitForFunction(() => document.querySelectorAll('.history-card').length === 0);
    assert.ok((await page.locator('#history-storage').textContent()).includes('任务文件 0 B'));
    assert.equal(await page.locator('#delete-history-selected').isDisabled(), true);
  });
  await test('KEEP-11', '没有工作区归属的旧任务可从旧历史自动迁移', async () => {
    const response = await page.request.post('http://127.0.0.1:7860/api/process', { multipart: {
      options: JSON.stringify({ mode: 'rename', prefix: 'legacy_keep' }),
      files: { name: 'legacy.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(root, 'web/static/examples/bytepet/frames/calm_0001.png')) },
    } });
    assert.equal(response.status(), 201); first = await response.json();
    await page.evaluate(job => sessionStorage.setItem('framelab-history-v2', JSON.stringify([{ id: job.id, created_at: job.created_at, expires_at: 1, mode: 'rename', name: 'legacy.png', count: 1 }])), first);
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready(); await history(page, 1);
    assert.equal(await row(first.id).getByRole('button', { name: '打开任务', exact: true }).isDisabled(), false);
  });
  await test('KEEP-12', '其他浏览器身份无法查看或删除这些长期任务', async () => {
    const foreign = await browser.newContext(); const other = await foreign.newPage();
    await other.goto('http://127.0.0.1:7860/editor?tool=history', { waitUntil: 'networkidle' }); await ready(other);
    const tab = await other.evaluate(() => sessionStorage.getItem('framelab-tab-v1'));
    const base = 'http://127.0.0.1:7860/api/workspaces/' + tab + '/jobs';
    assert.deepEqual((await (await other.request.get(base + '?scope=all')).json()).jobs, []);
    assert.equal((await other.request.delete(base, { data: { ids: [first.id] } })).status(), 404);
    assert.equal((await page.request.get('http://127.0.0.1:7860/api/jobs/' + first.id)).status(), 200);
    await foreign.close();
  });
  await test('KEEP-13', '删除接口失败不会假装成功，任务和选择均保留供重试', async () => {
    await row(first.id).locator('input[type=checkbox]').check(); await page.locator('#delete-history-selected').click();
    await page.route('**/api/workspaces/*/jobs', route => route.request().method() === 'DELETE' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '测试服务暂不可用' }) }) : route.continue());
    await page.locator('#delete-history-confirm').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('删除未完成'));
    assert.equal(await page.locator('#delete-history-dialog').isVisible(), true);
    assert.equal(await page.locator('.history-card').count(), 1);
    await page.unroute('**/api/workspaces/*/jobs'); await page.locator('#delete-history-cancel').click();
  });
  await test('KEEP-14', '手机深色任务列表与批量管理不横向溢出', async () => {
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.locator('#theme-button').click();
    for (const width of [768, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, width + ' overflow');
      if (width === 390) await page.screenshot({ path: path.join(output, 'history-mobile-dark.png'), fullPage: true });
    }
  });
  await test('KEEP-15', '长期保存及删除流程没有 JavaScript 异常', async () => { assert.deepEqual(errors, []); });
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(output, 'retention-results.json'), JSON.stringify({ results, errors, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status === 'FAIL').length }, null, 2));
  if (browser) await browser.close();
});
