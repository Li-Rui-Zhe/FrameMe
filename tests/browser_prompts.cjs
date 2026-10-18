const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname,'../.runtime/prompt-evidence');
fs.mkdirSync(output,{recursive:true});
const results=[], errors=[];
let browser,page,job;
async function test(id,name,action) { try { await action(); results.push({id,name,status:'PASS'}); console.log('PASS '+id+' '+name); } catch(e) { results.push({id,name,status:'FAIL',error:e.message}); throw e; } }
async function ready() { await page.waitForFunction(() => { try { return !restoringWorkspace && !state.busy && !state.importing && !document.querySelector('#top-upload').disabled; } catch { return false; } }); }
async function promptReady() { await page.waitForFunction(() => document.body.dataset.workspaceReady==='true' && !document.querySelector('#copy-prompt').disabled); }
async function run() {
  const response=page.waitForResponse(r=>r.url().endsWith('/api/process') && r.request().method()==='POST');
  await page.locator('#process-button').click(); const r=await response; assert.equal(r.status(),201); job=await r.json();
  await page.waitForFunction(()=>!document.querySelector('#quick-download').disabled); return job;
}
async function download(kind,filename) {
  await page.locator('#export-format').selectOption(kind); const pending=page.waitForEvent('download'); await page.locator('#quick-download').click();
  const file=await pending; assert.equal(await file.failure(),null); await file.saveAs(path.join(output,filename));
  await page.waitForFunction(()=>!document.querySelector('#quick-download').disabled);
}
(async()=>{
  browser=await chromium.launch({headless:true,executablePath:process.env.FRAMELAB_BROWSER_PATH||undefined});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write'],acceptDownloads:true});
  page=await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{ if(r.status()>=400) errors.push(r.status()+' '+r.url()); });
  await test('PROMPT-01','新浏览器可直接打开，导航位于批量命名下方',async()=>{
    const response=await page.goto('http://127.0.0.1:7860/prompts',{waitUntil:'domcontentloaded'}); assert.equal(response.status(),200); await promptReady();
    assert.equal(response.headers()['cache-control'],'no-store');
    const nav=await page.locator('.tool-nav>.nav-item').allTextContents(); assert.match(nav[3],/批量命名/); assert.match(nav[4],/Prompt 示例/);
    assert.equal(await page.locator('#prompts-link').getAttribute('aria-current'),'page'); assert.equal(await page.locator('#about-link').getAttribute('aria-current'),null);
  });
  await test('PROMPT-02','三个作者示例完整且无待填写占位符',async()=>{
    for(const key of ['chibi','realistic','natasha']) {
      await page.locator('[data-template='+key+']').click(); const text=await page.locator('#prompt-output').inputValue();
      for(const word of ['角色外观要求','六帧动作节奏','#33ff00','底部锚点','完整显示全身']) assert.ok(text.includes(word),word);
      assert.doesNotMatch(text,/\[填写|\[动作名称\]/);
      assert.equal(await page.locator('#prompt-layout').inputValue(),'strip');
    }
    assert.match(await page.locator('#prompt-output').inputValue(),/深棕色皮肤.*Q 版/);
  });
  await test('PROMPT-03','一键复制的剪贴板内容与完整 Prompt 一致',async()=>{
    await page.locator('#copy-prompt').click(); assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),await page.locator('#prompt-output').inputValue());
    assert.match(await page.locator('#copy-status').textContent(),/已复制/);
  });
  await test('PROMPT-04','编辑即时更新，切换模板保留本页修改，可恢复默认',async()=>{
    await page.locator('#prompt-details>summary').click();
    await page.locator('#prompt-character').fill('我的红色小狐狸 <img src=x onerror=alert(1)>');
    await page.locator('#prompt-action').fill('打招呼');
    assert.match(await page.locator('#prompt-output').inputValue(),/我的红色小狐狸/); assert.equal(await page.locator('.prompt-preview img').count(),0);
    await page.locator('[data-template=realistic]').click(); await page.locator('[data-template=natasha]').click();
    assert.equal(await page.locator('#prompt-action').inputValue(),'打招呼'); await page.locator('#reset-prompt').click();
    assert.equal(await page.locator('#prompt-action').inputValue(),'打哈欠');
  });
  await test('PROMPT-05','长条与独立图约束互斥，处理入口对应正确工具',async()=>{
    await page.locator('#prompt-layout').selectOption('images');
    assert.match(await page.locator('#prompt-output').inputValue(),/正好 6 张独立图片/);
    assert.match(await page.locator('#prompt-processing-hint').textContent(),/直接去底/);
    assert.match(await page.locator('#prompt-process-link').getAttribute('href'),/tool=cutout&format=zip&recipe=images/);
    await page.locator('#prompt-layout').selectOption('strip');
    assert.match(await page.locator('#prompt-output').inputValue(),/3072×512/);
    assert.match(await page.locator('#prompt-process-link').getAttribute('href'),/tool=split&format=gif&recipe=strip/);
  });
  await test('PROMPT-06','指南说明模型限制、完整资源包与两个开源链接',async()=>{
    const text=await page.locator('main').textContent(); for(const word of ['生图需在你自己的生图工具','不会在批量命名中合成 GIF','不是完整角色包','原始笔记未被修改']) assert.ok(text.includes(word),word);
    assert.equal(await page.locator('.prompt-project-grid a').count(),2);
    const links=await page.locator('.prompt-project-grid a').evaluateAll(nodes=>nodes.map(n=>n.href));
    assert.ok(links.some(x=>x.includes('Li-Rui-Zhe/FrameMe'))); assert.ok(links.some(x=>x.includes('Li-Rui-Zhe/BytePet')));
    await page.locator('.sidebar-guide').click(); assert.equal(new URL(page.url()).hash,'#prompt-guide');
  });
  await test('PROMPT-07','浅深色与320至1920像素布局正常',async()=>{
    for(const dark of [false,true]) {
      if(await page.locator('body').evaluate(e=>e.classList.contains('dark'))!==dark) await page.locator('#theme-button').click();
      for(const width of [1920,1440,1024,768,390,320]) {
        await page.setViewportSize({width,height:1000}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,String(width));
        assert.equal(await page.locator('#prompts-link').isVisible(),true);
        if(width===390&&dark) await page.screenshot({path:path.join(output,'prompts-mobile.png'),fullPage:true});
      }
      await page.setViewportSize({width:1440,height:1000}); await page.evaluate(()=>scrollTo(0,0));
      await page.screenshot({path:path.join(output,dark?'prompts-dark.png':'prompts-light.png'),fullPage:true});
    }
  });
  await test('PROMPT-08','生成长条入口保留配方，刷新后上传自动设置六帧去底',async()=>{
    await page.locator('#prompt-process-link').click(); await ready();
    await page.reload({waitUntil:'domcontentloaded'}); await ready();
    await page.locator('#file-input').setInputFiles(path.join(output,'input-strip.png')); await ready();
    assert.equal(await page.locator('#frames').inputValue(),'6'); assert.equal(await page.locator('#remove-bg').isChecked(),true);
    assert.equal(await page.locator('#auto-color').isChecked(),false); assert.equal(await page.locator('#color').inputValue(),'#33ff00');
    assert.equal(await page.locator('#size').inputValue(),'512'); assert.equal(await page.locator('#fps').inputValue(),'4');
  });
  await test('PROMPT-09','真实BytePet原帧绿幕长条可处理为六帧透明图和GIF',async()=>{
    await run(); assert.equal(job.frame_count,6); assert.equal(job.options.remove_bg,true);
    await download('gif','prompt-animation.gif'); await download('zip','prompt-frames.zip');
    assert.equal(await page.locator('.frame-card').count(),6);
  });
  await test('PROMPT-10','工作台到Prompt页往返保留当前素材、任务与参数',async()=>{
    const id=job.id; await page.locator('#prompts-link').click(); await promptReady();
    await page.locator('.topbar a[href="/editor"]').click(); await ready();
    assert.equal(await page.evaluate(()=>state.job.id),id); assert.equal(await page.locator('#frames').inputValue(),'6'); assert.equal(await page.locator('.upload-item').count(),1);
  });
  await test('PROMPT-11','独立图片入口六图批量去底并下载PNG ZIP',async()=>{
    await page.locator('#prompts-link').click(); await promptReady(); await page.locator('[data-template=realistic]').click();
    await page.locator('#prompt-details>summary').click(); await page.locator('#prompt-layout').selectOption('images');
    await page.locator('#prompt-process-link').click(); await ready();
    await page.locator('#file-input').setInputFiles(Array.from({length:6},(_,i)=>path.join(output,'input_'+String(i+1).padStart(4,'0')+'.png'))); await ready();
    assert.equal(await page.locator('#export-format').inputValue(),'zip'); await run(); assert.equal(job.frame_count,6);
    await download('zip','independent-frames.zip');
  });
  await test('PROMPT-12','无剪贴板权限时选中全文，提供手动复制提示',async()=>{
    await page.locator('#prompts-link').click(); await promptReady();
    await page.evaluate(()=>{ Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied');}}}); document.execCommand=()=>false; });
    await page.locator('#copy-prompt').click(); assert.match(await page.locator('#copy-status').textContent(),/未允许自动复制/);
    const selected=await page.locator('#prompt-output').evaluate(el=>el.selectionEnd-el.selectionStart); assert.equal(selected,(await page.locator('#prompt-output').inputValue()).length);
    await page.locator('#select-prompt').click(); assert.match(await page.locator('#copy-status').textContent(),/已选中全文/);
  });
  await test('PROMPT-13','页面资源和复制、处理流程没有JavaScript异常',async()=>{assert.deepEqual(errors,[]);});
  await test('PROMPT-14','配方入口保留已有结果，上传时才生效且只应用一次',async()=>{
    await page.locator('#prompt-process-link').click(); await ready();
    assert.equal(await page.locator('.upload-item').count(),1); assert.equal(await page.locator('#quick-download').isDisabled(),false);
    const id=await page.evaluate(()=>state.job.id); assert.ok(id);
    assert.equal(await page.evaluate(()=>state.promptRecipe),'strip');
    await page.locator('#frames').fill('3');
    await page.locator('#file-input').setInputFiles({name:'second-strip.png',mimeType:'image/png',buffer:fs.readFileSync(path.join(output,'input-strip.png'))}); await ready();
    assert.equal(await page.locator('#frames').inputValue(),'6'); assert.equal(await page.evaluate(()=>state.promptRecipe),null);
    await page.locator('#frames').fill('4');
    await page.locator('#file-input').setInputFiles({name:'third-strip.png',mimeType:'image/png',buffer:fs.readFileSync(path.join(output,'input-strip.png'))}); await ready();
    assert.equal(await page.locator('#frames').inputValue(),'4'); assert.deepEqual(errors,[]);
  });
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results,errors},null,2)); if(browser) await browser.close();
});
