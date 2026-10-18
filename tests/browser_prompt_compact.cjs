const {chromium}=require(process.env.FRAMELAB_PLAYWRIGHT||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=path.resolve(__dirname,'../.runtime/prompt-compact-evidence');fs.mkdirSync(out,{recursive:true});
let browser,page;const results=[],errors=[];
async function test(id,name,action){try{await action();results.push({id,name,status:'PASS'});console.log('PASS '+id+' '+name);}catch(e){results.push({id,name,status:'FAIL',error:e.message});throw e;}}
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.FRAMELAB_BROWSER_PATH||undefined});
 const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
 page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:7860/prompts',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.body.dataset.workspaceReady==='true');
 await test('COMPACT-01','指南位于示例之前，默认折叠长文和编辑器，首屏可复制',async()=>{
  assert.equal(await page.locator('#prompt-guide').evaluate(el=>Boolean(el.compareDocumentPosition(document.querySelector('.prompt-builder'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
  assert.equal(await page.locator('#prompt-guide-details').getAttribute('open'),null);assert.equal(await page.locator('#prompt-details').getAttribute('open'),null);
  assert.equal(await page.locator('#prompt-output').isVisible(),false);assert.equal(await page.locator('#prompt-character').isVisible(),false);
  assert.match(await page.locator('.prompt-intro').textContent(),/一张包含 6 帧连续动作/);
  assert.match(await page.locator('#prompt-generation-hint').textContent(),/1 张图.*6 帧/);
  const bounds=await page.locator('#copy-prompt').boundingBox();assert.ok(bounds.y+bounds.height<=900,JSON.stringify(bounds));
  await page.screenshot({path:path.join(out,'compact-light.png'),fullPage:true});
 });
 await test('COMPACT-02','不展开详情即可复制三种模板完整文本，摘要同步切换',async()=>{
  for(const key of ['chibi','realistic','natasha']){
   await page.locator('[data-template='+key+']').click();await page.locator('#copy-prompt').click();
   assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),await page.locator('#prompt-output').inputValue());
   assert.equal(await page.locator('#prompt-details').getAttribute('open'),null);
   assert.match(await page.locator('#prompt-current-format').textContent(),/六帧长条/);
  }
 });
 await test('COMPACT-03','键盘可展开详情，编辑后收起仍能复制修改内容',async()=>{
  await page.locator('#prompt-details>summary').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#prompt-character').isVisible(),true);
  await page.locator('#prompt-action').fill('开心挥手');assert.equal(await page.locator('#prompt-short-description').textContent(),'开心挥手');
  await page.locator('#prompt-details>summary').click();await page.locator('#copy-prompt').click();assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/开心挥手/);
 });
 await test('COMPACT-04','完整指南按需展开，保留两种素材路线与限制',async()=>{
  assert.equal(await page.locator('.prompt-guide-steps').isVisible(),false);await page.locator('#prompt-guide-details>summary').click();assert.equal(await page.locator('.prompt-guide-steps').isVisible(),true);
  assert.equal(await page.locator('.prompt-guide-steps>li').count(),4);assert.match(await page.locator('.prompt-guide-steps').textContent(),/不会在批量命名中合成 GIF/);
  await page.locator('#prompt-guide-details>summary').click();
 });
 await test('COMPACT-05','浅深色及手机布局正常，详情收起后操作仍可达',async()=>{
  for(const dark of [true,false]){
   if(await page.locator('body').evaluate(el=>el.classList.contains('dark'))!==dark)await page.locator('#theme-button').click();
   for(const width of [1440,1024,768,390,320]){
    await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,String(width));
    assert.equal(await page.locator('#copy-prompt').isVisible(),true);assert.equal(await page.locator('#prompt-process-link').isVisible(),true);
    if(width===390&&dark)await page.screenshot({path:path.join(out,'compact-mobile-dark.png'),fullPage:true});
   }
   await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>scrollTo(0,0));if(dark)await page.screenshot({path:path.join(out,'compact-dark.png'),fullPage:true});
  }
  assert.deepEqual(errors,[]);
 });
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,errors},null,2));if(browser)await browser.close();});
