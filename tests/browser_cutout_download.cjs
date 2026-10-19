const { chromium } = require(process.env.FRAMELAB_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const dir = path.resolve(__dirname, '../.runtime/cutout-download-evidence');
fs.mkdirSync(dir, {recursive:true});
async function ready(page) {
  await page.waitForFunction(() => { try { return !restoringWorkspace && !state.busy && !state.importing && !document.querySelector('#top-upload').disabled; } catch { return false; } });
}
(async () => {
  const browser = await chromium.launch({headless: true, executablePath: process.env.FRAMELAB_BROWSER_PATH});
  try {
    const page = await browser.newPage({acceptDownloads: true, viewport: {width:1440,height:1000}});
    for (const [name,width,height] of [['wide',321,67],['tall',91,203]]) {
      const png = await page.evaluate(({width,height})=>{
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#00ff00';ctx.fillRect(0,0,width,height);
        ctx.fillStyle='red';ctx.fillRect(20,20,31,21);
        return canvas.toDataURL('image/png').split(',')[1];
      },{width,height});
      fs.writeFileSync(path.join(dir,name+'.png'),Buffer.from(png,'base64'));
    }
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:7860/editor?tool=cutout'); await ready(page);
    await page.evaluate(() => {
      state.exportFormat='zip';
      state.formValues={size:'512',align:true,trim:true}; restoreForm(); updateFields();
    });
    assert.equal(await page.locator('#size').inputValue(), '0');
    assert.equal(await page.locator('#canvas-settings').isVisible(), false);
    assert.equal(await page.locator('.format-picker').isVisible(), false);
    console.log('PASS old cutout preferences normalized, canvas and format picker hidden');
    await page.locator('#file-input').setInputFiles(path.join(dir,'wide.png')); await ready(page);
    async function process() {
      const response=page.waitForResponse(r=>r.url().endsWith('/api/process') && r.request().method()==='POST');
      await page.locator('#process-button').click();
      assert.equal((await response).status(),201); await ready(page);
    }
    async function download(name) {
      const pending=page.waitForEvent('download'); await page.locator('#quick-download').click();
      const file=await pending; await file.saveAs(path.join(dir,name));
      assert.equal(await file.failure(),null); await ready(page);
    }
    await process();
    assert.equal(await page.locator('#export-format').inputValue(),'png');
    assert.deepEqual(await page.evaluate(()=>[state.groups[0].frames[0].width,state.groups[0].frames[0].height]),[321,67]);
    await download('single-output.png'); console.log('PASS single cutout direct PNG download preserves 321x67');
    await page.evaluate(()=>draftStore.flush()); await page.reload({waitUntil:'domcontentloaded'}); await ready(page);
    assert.equal(await page.locator('.format-picker').isVisible(),false);
    assert.equal(await page.locator('#export-format').inputValue(),'png');
    console.log('PASS refresh preserves simple cutout download');
    await page.locator('#file-input').setInputFiles(path.join(dir,'tall.png')); await ready(page); await process();
    assert.equal(await page.locator('#export-format').inputValue(),'zip');
    assert.equal(await page.locator('.format-picker').isVisible(),false);
    await download('batch-output.zip'); console.log('PASS batch cutout downloads ZIP directly');
    await page.locator('[data-tool="split"]').click(); await ready(page);
    assert.equal(await page.locator('.format-picker').evaluate(el=>el.hidden),false);
    assert.equal(await page.locator('#canvas-settings').evaluate(el=>el.hidden),false);
    assert.equal(await page.locator('#export-format').inputValue(),'gif');
    assert.deepEqual(errors,[]); console.log('PASS split keeps its own export and sizing controls; no browser errors');
    assert.equal(await page.locator('#align').isVisible(),true);
    assert.equal(await page.locator('#align').isChecked(),true);
    assert.equal(await page.locator('#align').isDisabled(),false);
    const strip=await page.evaluate(()=>{
      const canvas=document.createElement('canvas');canvas.width=480;canvas.height=60;
      const ctx=canvas.getContext('2d');ctx.fillStyle='red';
      for(let i=0;i<6;i++)ctx.fillRect(i*80+2+i*3,5+i*2,10,20);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('#file-input').setInputFiles({name:'offset-strip.png',mimeType:'image/png',buffer:Buffer.from(strip,'base64')});await ready(page);
    await process();
    async function boxes() {
      return page.evaluate(async()=>Promise.all(state.groups[0].frames.map(async frame=>{
        const image=new Image();image.src=frame.url;await image.decode();
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
        const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const data=ctx.getImageData(0,0,image.width,image.height).data;
        let left=image.width,top=image.height,right=0,bottom=0;
        for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)if(data[(y*image.width+x)*4+3]>10){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}
        return [image.width,image.height,left,top,right,bottom];
      })));
    }
    assert.deepEqual(await boxes(),Array.from({length:6},()=>[80,60,35,20,45,40]));
    console.log('PASS six off-centre poses centred without resizing');
    await page.locator('#align').uncheck();await process();
    assert.deepEqual(await boxes(),Array.from({length:6},(_,i)=>[80,60,2+i*3,5+i*2,12+i*3,25+i*2]));
    console.log('PASS disabling centring preserves original motion positions');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
