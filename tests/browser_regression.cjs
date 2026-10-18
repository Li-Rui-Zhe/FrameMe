/* Run against a running local FrameLab. Playwright is a QA dependency only. */
const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const evidence = path.join(root, '.runtime/test-evidence');
const material = path.join(root, 'web/static/examples/bytepet');
fs.mkdirSync(evidence, { recursive: true });
const results = [];
const errors = [];
let browser;

async function test(id, name, action) {
  const started = Date.now();
  try { await action(); results.push({ id, name, status: 'PASS', seconds: (Date.now() - started) / 1000 }); }
  catch (error) { results.push({ id, name, status: 'FAIL', error: error.message, seconds: (Date.now() - started) / 1000 }); throw error; }
  console.log(results.at(-1).status + ' ' + id + ' ' + name);
}

(async () => {
  const options = { headless: true };
  if (process.env.FRAMELAB_BROWSER_PATH) options.executablePath = process.env.FRAMELAB_BROWSER_PATH;
  browser = await chromium.launch(options);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const goto = async tool => {
    await page.evaluate(() => { sessionStorage.removeItem('framelab-workspaces-v1'); sessionStorage.removeItem('framelab-tab-v1'); }).catch(() => {});
    await page.goto('http://127.0.0.1:7860/?tool=' + tool, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.querySelector('#example-load').disabled);
    await page.waitForFunction(tool => document.querySelector('[data-tool="' + tool + '"]').classList.contains('active'), tool);
    if (tool !== 'rename') await page.locator('#advanced-settings').evaluate(details => { details.open = true; });
  };
  const load = async () => {
    await page.locator(await page.locator('#example-load').isVisible() ? '#example-load' : '#empty-demo').click();
    await page.waitForFunction(() => !document.querySelector('#process-button').disabled);
    if (await page.locator('#advanced-settings').isVisible()) await page.locator('#advanced-settings').evaluate(details => { details.open = true; });
  };
  const run = async () => {
    const responseEvent = page.waitForResponse(response => response.url().endsWith('/api/process') && response.request().method() === 'POST');
    await page.locator('#process-button').click();
    const response = await responseEvent;
    const job = await response.json();
    assert.equal(response.status(), 201, JSON.stringify(job));
    await page.waitForFunction(() => !document.querySelector('#quick-download').disabled && document.querySelector('.frame-card'));
    return job;
  };
  const download = async (kind, name) => {
    await page.locator('#export-format').selectOption(kind);
    const event = page.waitForEvent('download');
    await page.locator('#quick-download').click();
    const file = await event;
    const filename = name || file.suggestedFilename();
    await file.saveAs(path.join(evidence, filename));
    assert.equal(await file.failure(), null);
    return filename;
  };
  const removeAll = async () => {
    while (await page.locator('.upload-item button[aria-label^="移除 "]').count()) await page.locator('.upload-item button[aria-label^="移除 "]').first().click();
  };
  const snapshot = async options => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.waitForTimeout(200);
    await page.screenshot(options);
  };
  let job;
  await test('UI-01', '空工作台以选图为主，处理前不展示示例画布', async () => {
    await goto('split');
    assert.equal(await page.locator('#upload-zone').isVisible(), true);
    assert.equal(await page.locator('#preview-canvas').isVisible(), false);
  });
  await test('SPLIT-01', '载入长条并保留切帧工具', async () => {
    await load(); assert.equal(await page.locator('[data-tool="split"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.upload-item').count(), 1);
  });
  await test('SPLIT-02', '横向切帧输出 6 张 512px PNG', async () => {
    job = await run(); assert.equal(job.frame_count, 6); assert.equal(job.groups[0].frames[0].width, 512);
    await snapshot({ path: path.join(evidence, 'split-desktop.png'), fullPage: true });
  });
  await test('SPLIT-03', '播放暂停、逐帧与时间轴', async () => {
    await page.locator('#next-frame').click(); assert.equal(await page.locator('#play-button').getAttribute('aria-label'), '播放动画');
    await page.locator('#frame-scrub').fill('3'); assert.equal(await page.locator('#frame-indicator').textContent(), 'FRAME 04 / 06');
    await page.locator('#play-button').click(); assert.equal(await page.locator('#play-button').getAttribute('aria-label'), '暂停动画');
  });
  await test('EXPORT-01', '普通 ZIP 真实浏览器下载', async () => { await download('zip', 'split-frames.zip'); });
  await test('EXPORT-02', '动作目录 ZIP 真实浏览器下载', async () => { await download('folders', 'split-folders.zip'); });
  await test('EXPORT-03', '精灵图 PNG 真实浏览器下载', async () => { await download('sheet', 'split-sheet.png'); });
  await test('EXPORT-04', 'GIF 真实浏览器下载', async () => { await download('gif', 'split-animation.gif'); });
  await test('SPLIT-04', '帧数增减与参数变动使结果失效', async () => {
    await page.locator('#increase-frames').click(); assert.equal(await page.locator('#frames').inputValue(), '7');
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
    await page.locator('#decrease-frames').click(); assert.equal(await page.locator('#frames').inputValue(), '6');
  });
  await test('SPLIT-05', '精确裁剪线保存到 API', async () => {
    await page.locator('[data-view="source"]').click(); await page.locator('#crop-button').click();
    await page.locator('#crop-fields input').first().fill('500'); await page.locator('#crop-form button[type="submit"]').click();
    job = await run(); assert.equal(job.groups[0].frames[0].width, 500);
  });
  await test('SPLIT-06', '恢复等分与主体对齐画布', async () => {
    await page.locator('[data-view="source"]').click(); await page.locator('#crop-button').click(); await page.locator('#reset-crops').click();
    await page.locator('#size').selectOption('512'); await page.locator('#align').check({ force: true });
    await page.locator('#padding').fill('20'); await page.locator('#ratio').fill('70');
    job = await run(); assert.equal(job.options.align, true); assert.equal(job.options.ratio, 70); assert.equal(job.groups[0].frames[0].width, 512);
  });
  await test('SPLIT-07', '真实原帧纵向排列的切割', async () => {
    await goto('split'); await page.locator('#file-input').setInputFiles(path.join(evidence, 'bytepet-vertical.png'));
    await page.waitForFunction(() => !document.querySelector('#process-button').disabled);
    await page.locator('input[name="layout"][value="vertical"]').check({ force: true }); await page.locator('#size').selectOption('0');
    job = await run(); assert.equal(job.frame_count, 6); assert.deepEqual([job.groups[0].frames[0].width, job.groups[0].frames[0].height], [512, 512]);
  });
  await test('SPLIT-08', '真实原帧网格排列的切割', async () => {
    await goto('split'); await page.locator('#file-input').setInputFiles(path.join(evidence, 'bytepet-grid.png'));
    await page.waitForFunction(() => !document.querySelector('#process-button').disabled);
    await page.locator('input[name="layout"][value="grid"]').check({ force: true }); await page.locator('#size').selectOption('0');
    job = await run(); assert.equal(job.frame_count, 6); assert.deepEqual([job.groups[0].frames[5].width, job.groups[0].frames[5].height], [512, 512]);
  });
  await test('CUTOUT-01', '抠图演示使用真实绿幕原图', async () => {
    await goto('cutout'); await page.waitForFunction(() => document.querySelector('#example-details').textContent.includes('星球图标'));
    assert.equal(await page.locator('#example-project-link').isVisible(), false);
    assert.equal(await page.locator('.playback').isVisible(), false);
    await load();
    const autoColorLabel = await page.locator('#auto-color').locator('..').locator('span').first().boundingBox();
    assert.ok(autoColorLabel.width > 80 && autoColorLabel.height < 40, '自动识别背景色应正常横排');
    assert.equal(await page.locator('[data-tool="cutout"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.upload-item').count(), 1);
    await snapshot({ path: path.join(evidence, 'cutout-before.png'), fullPage: true });
  });
  await test('CUTOUT-02', '自动识别移除原始绿幕背景', async () => {
    job = await run(); assert.equal(job.options.mode, 'cutout'); assert.equal(job.frame_count, 1);
    assert.equal(job.groups[0].frames[0].width, 1254); await download('png', 'star-cutout.png');
    await snapshot({ path: path.join(evidence, 'cutout-after.png'), fullPage: true });
  });
  await test('CUTOUT-03', '原图与结果切换', async () => {
    await page.locator('[data-view="source"]').click(); assert.equal(await page.locator('#frame-indicator').textContent(), 'SOURCE IMAGE');
    await page.locator('[data-view="animation"]').click(); assert.ok((await page.locator('#frame-indicator').textContent()).startsWith('IMAGE'));
  });
  await test('CUTOUT-04', '从真实绿幕图取色并手动处理', async () => {
    await page.locator('#pick-color').click(); const box = await page.locator('#preview-canvas').boundingBox();
    await page.mouse.click(box.x + box.width / 2 - 100, box.y + box.height / 2 - 100);
    assert.equal(await page.locator('#auto-color').isChecked(), false);
    job = await run(); assert.equal(job.options.auto_color, false); await download('png', 'star-cutout-manual.png');
  });
  await test('CUTOUT-05', '容差和柔化参数被采用', async () => {
    await page.locator('#tolerance').fill('25'); await page.locator('#feather').fill('20');
    assert.equal(await page.locator('#quick-download').isDisabled(), true);
    job = await run(); assert.equal(job.options.tolerance, 25); assert.equal(job.options.feather, 20);
  });
  await test('CUTOUT-06', '人物立绘原图抠图不跳工具', async () => {
    await page.locator('#example-select').selectOption('comfort');
    await page.waitForFunction(() => document.querySelector('#example-details').textContent.includes('人物立绘') && !document.querySelector('#example-load').disabled);
    await load(); job = await run(); assert.equal(job.options.mode, 'cutout'); await download('png', 'portrait-cutout.png');
  });
  await test('CUTOUT-07', '两张真实绿幕素材批量处理', async () => {
    await removeAll();
    await page.locator('#file-input').setInputFiles([path.join(material, 'originals/star_uploaded_input.png'), path.join(material, 'originals/comfort_0001_uploaded_input.png')]);
    await page.waitForFunction(() => document.querySelectorAll('.upload-item').length === 2);
    job = await run(); assert.equal(job.frame_count, 2); await page.locator('#group-select').selectOption('1');
    await page.waitForFunction(() => document.querySelector('.frame-card img')?.src.includes('_02_'));
  });
  await test('RENAME-01', '命名演示载入六张独立原始 PNG', async () => {
    await goto('rename'); await page.waitForFunction(() => document.querySelector('#example-details').textContent.includes('独立 PNG'));
    await load(); assert.equal(await page.locator('[data-tool="rename"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.upload-item').count(), 6); assert.equal(await page.locator('#filename-example').textContent(), 'asset_0001.png');
  });
  await test('RENAME-02', '批量命名和六张结果列表', async () => {
    job = await run(); assert.equal(job.frame_count, 6);
    assert.deepEqual(job.groups.map(group => group.frames[0].filename), Array.from({ length: 6 }, (_, i) => 'asset_' + String(i + 1).padStart(4, '0') + '.png'));
    assert.equal(await page.locator('.frame-card').count(), 6);
    assert.ok((await page.locator('.frame-card').first().getAttribute('title')).includes('calm_0001.png → asset_0001.png'));
    await snapshot({ path: path.join(evidence, 'rename-desktop.png'), fullPage: true });
  });
  await test('RENAME-03', '新前缀含连字符连续编号', async () => {
    await page.locator('#prefix').fill('image-set'); job = await run(); assert.equal(job.groups[5].frames[0].filename, 'image-set_0006.png');
  });
  await test('RENAME-04', '查看第三张并下载对应 PNG', async () => {
    await page.locator('.frame-card').nth(2).click(); const filename = await download('png', 'rename-third.png');
    assert.equal(filename, 'rename-third.png'); await download('zip', 'rename-six.zip');
  });
  await test('RENAME-05', '无效命名前缀被表单阻止', async () => {
    await page.locator('#prefix').fill('../bad'); assert.equal(await page.locator('#prefix').evaluate(input => input.validity.valid), false);
    assert.equal(await page.locator('#quick-download').isDisabled(), true); await page.locator('#prefix').fill('image-set');
  });
  await test('RENAME-06', 'JPEG 与 WebP 转 PNG', async () => {
    await removeAll(); await page.locator('#file-input').setInputFiles([path.join(evidence, 'bytepet-original.jpg'), path.join(evidence, 'bytepet-original.webp')]);
    await page.waitForFunction(() => document.querySelectorAll('.upload-item').length === 2);
    job = await run(); assert.equal(job.frame_count, 2); await download('zip', 'rename-mixed.zip');
  });
  await test('UI-02', '预览背景白色与深色', async () => {
    await page.locator('button[data-background="dark"]').click(); assert.equal(await page.locator('#preview-stage').getAttribute('data-background'), 'dark');
    await page.locator('button[data-background="white"]').click(); assert.equal(await page.locator('#preview-stage').getAttribute('data-background'), 'white');
  });
  await test('UI-03', '最近任务打开并保留命名结果', async () => {
    await page.locator('[data-tool="history"]').click(); assert.ok(await page.locator('.history-card').count() > 0);
    await page.locator('.history-card .button').first().click();
    await page.waitForFunction(() => !document.querySelector('#workspace-view').hidden && !document.querySelector('#quick-download').disabled && document.querySelectorAll('.frame-card').length === 2);
    assert.equal(await page.locator('[data-tool="rename"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.frame-card').count(), 2);
  });
  await test('UI-04', '深色主题与帮助弹窗', async () => {
    await page.locator('#theme-button').click(); assert.equal(await page.locator('body').evaluate(body => body.classList.contains('dark')), true);
    await page.locator('#help-button').click(); assert.equal(await page.locator('#help-dialog').isVisible(), true); await page.keyboard.press('Escape');
    await snapshot({ path: path.join(evidence, 'rename-dark.png'), fullPage: true }); await page.locator('#theme-button').click();
  });
  await test('UI-05', '三个工具的 390px 手机布局', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tool of ['split', 'cutout', 'rename']) {
      await goto(tool); await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await snapshot({ path: path.join(evidence, tool + '-mobile.png'), fullPage: true });
    }
  });
  await test('UI-06', '768px 平板布局', async () => {
    await page.setViewportSize({ width: 768, height: 1024 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });
  await test('UPLOAD-01', '超出 12 张的上传给出提示', async () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(material, 'example.json')));
    const files = catalog.states.flatMap(entry => entry.frame_files.map(file => path.join(material, file))).slice(0, 13);
    await goto('rename'); await page.locator('#file-input').setInputFiles(files);
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('最多上传 12'));
    assert.equal(await page.locator('.upload-item').count(), 0);
  });
  await test('UPLOAD-02', '移除全部素材后处理按钮禁用', async () => {
    await load(); await removeAll(); assert.equal(await page.locator('#process-button').isDisabled(), true);
  });
  await test('UI-07', '页面 JavaScript 与控制台无异常', async () => { assert.deepEqual(errors, []); });
  fs.writeFileSync(path.join(evidence, 'browser-environment.json'), JSON.stringify({ browser: await browser.version(), viewport: [1440, 1100], mobile: [390, 844], platform: process.platform, source: 'real local green inputs and pinned BytePet frames' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(evidence, 'browser-results.json'), JSON.stringify({ results, errors, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status === 'FAIL').length }, null, 2));
  if (browser) await browser.close();
});
