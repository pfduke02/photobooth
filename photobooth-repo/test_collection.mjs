// V0.5 test: run a session against the local backend and verify the session
// landed on disk as sessions/<id>/{strip.png, frame-N.jpg, metadata.json};
// then verify the FAILURE path (simulated offline) still saves/shows the strip.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/root/photobooth';
const URL = process.env.PB_URL || 'http://localhost:8099/?fast=1&collect=local';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const opts={ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;

const browser=await chromium.launch(opts);
const ctx=await browser.newContext({ permissions:['camera'] });
const page=await ctx.newPage();
page.on('console',m=>console.log('[page]',m.type(),m.text()));
page.on('pageerror',e=>console.log('[pageerror]',e.message));

await page.goto(URL,{waitUntil:'load'});
await page.waitForFunction(()=>window.__PB&&window.__PB.ready,null,{timeout:15000});
await page.evaluate(()=>{ try{ localStorage.clear(); }catch{} });
await page.reload({waitUntil:'load'});
await page.waitForFunction(()=>window.__PB&&window.__PB.ready,null,{timeout:15000});
await page.waitForTimeout(300); // let health check resolve
const coll=await page.evaluate(()=>document.querySelector('#collState').textContent);
console.log('collState =', JSON.stringify(coll));

// ---- happy path: capture -> upload saved -> files on disk ----
await page.click('#startBtn');
await page.waitForFunction(()=>window.__PB&&window.__PB.done,null,{timeout:30000});
await page.waitForFunction(()=>window.__PB.upload&&['saved','failed'].includes(window.__PB.upload.status),null,{timeout:15000});
const up=await page.evaluate(()=>window.__PB.upload);
console.log('upload =', JSON.stringify(up));

let ok=true, meta=null;
if(up.status!=='saved'){ console.error('FAIL: expected upload saved'); ok=false; }
if(up.id){
  const dir=path.join(OUT,'sessions',up.id);
  const files=fs.existsSync(dir)?fs.readdirSync(dir).sort():[];
  console.log(`files in sessions/${up.id} =>`, files.join(', '));
  for(const f of ['frame-1.jpg','frame-2.jpg','frame-3.jpg','frame-4.jpg','metadata.json','strip.png']){
    if(!files.includes(f)){ console.error('FAIL missing '+f); ok=false; }
  }
  for(const f of files){ const sz=fs.statSync(path.join(dir,f)).size; if(sz<50){ console.error(`FAIL tiny file ${f} (${sz}b)`); ok=false; } }
  if(files.includes('metadata.json')){
    meta=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'),'utf8'));
    console.log('metadata =', JSON.stringify(meta));
    if(meta.numPhotos!==4){ console.error('FAIL meta.numPhotos'); ok=false; }
    if(!Array.isArray(meta.frames)||meta.frames.length!==4){ console.error('FAIL meta.frames length'); ok=false; }
    if(meta.strip!=='strip.png'){ console.error('FAIL meta.strip'); ok=false; }
  }
}

// ---- failure path: simulate offline; strip must still save + download ----
await page.click('#closeResult');
await page.evaluate(()=>{ const of=window.fetch.bind(window); window.fetch=(u,o)=> String(u).includes('api/session') ? Promise.reject(new Error('simulated offline')) : of(u,o); });
const galBefore=await page.evaluate(()=>document.querySelectorAll('#gallery .thumb').length);
await page.click('#startBtn');
await page.waitForFunction(()=>window.__PB&&window.__PB.done,null,{timeout:30000});
await page.waitForFunction(()=>window.__PB.upload&&window.__PB.upload.status==='failed',null,{timeout:15000});
const galAfter=await page.evaluate(()=>document.querySelectorAll('#gallery .thumb').length);
const hasStrip=await page.evaluate(()=>!!window.__PB.lastStrip);
const retryVisible=await page.evaluate(()=>getComputedStyle(document.querySelector('#retryUpload')).display!=='none');
console.log(`failure path: gallery ${galBefore} -> ${galAfter}, lastStrip=${hasStrip}, retryShown=${retryVisible}`);
if(!(galAfter>galBefore)){ console.error('FAIL: strip not saved to gallery on upload failure'); ok=false; }
if(!hasStrip){ console.error('FAIL: no downloadable strip on failure'); ok=false; }
if(!retryVisible){ console.error('FAIL: retry button not shown on failure'); ok=false; }

await browser.close();
console.log(ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok?0:1);
