// "both" mode (default): each capture writes local AND cloud. In this sandbox
// the cloud is unreachable, so we assert local SUCCEEDS to disk, cloud fails
// gracefully, status is still "saved" (partial), and capture is unaffected.
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
const OUT='/root/photobooth';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const opts={ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;
const browser=await chromium.launch(opts); const ctx=await browser.newContext({ permissions:['camera'] }); const page=await ctx.newPage();
await page.goto('http://localhost:8099/?fast=1',{waitUntil:'load'});   // default target = both
await page.waitForFunction(()=>window.__PB&&window.__PB.ready,null,{timeout:15000});
const coll=await page.evaluate(()=>document.querySelector('#collState').textContent);
await page.click('#startBtn');
await page.waitForFunction(()=>window.__PB.done,null,{timeout:30000});
await page.waitForFunction(()=>window.__PB.upload&&['saved','failed'].includes(window.__PB.upload.status),null,{timeout:25000});
const up=await page.evaluate(()=>window.__PB.upload);
console.log('collState:', JSON.stringify(coll));
console.log('upload:', JSON.stringify(up));
let ok=true;
if(up.status!=='saved'){ console.error('FAIL: expected saved (local should succeed)'); ok=false; }
if(!(up.targets && up.targets.local && up.targets.local.ok===true)){ console.error('FAIL: local not ok'); ok=false; }
if(!(up.targets && up.targets.cloud && up.targets.cloud.ok===false)){ console.error('FAIL: cloud should fail (offline sandbox)'); ok=false; }
if(up.targets && up.targets.local && up.targets.local.id){
  const dir=path.join(OUT,'sessions',up.targets.local.id);
  const files=fs.existsSync(dir)?fs.readdirSync(dir).sort():[];
  console.log('local disk files:', files.join(', '));
  for(const f of ['strip.png','frame-1.jpg','metadata.json']){ if(!files.includes(f)){ console.error('FAIL missing '+f); ok=false; } }
}
if(!coll.includes('cloud + local')){ console.error('FAIL: collState should show cloud + local'); ok=false; }
await browser.close();
console.log(ok?'PASS ✅':'FAIL ❌');
process.exit(ok?0:1);
