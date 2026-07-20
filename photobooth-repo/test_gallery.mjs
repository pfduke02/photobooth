// V0.6 test: seed a session via the booth, then verify /api/sessions and the
// gallery page render it (cards + detail modal with strip and original frames).
import { chromium } from 'playwright';
import fs from 'node:fs';

const BOOTH = process.env.PB_URL || 'http://localhost:8099/?fast=1&collect=local';
const GAL = 'http://localhost:8099/gallery.html?local=1';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const opts={ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;

const browser=await chromium.launch(opts);
const ctx=await browser.newContext({ permissions:['camera'] });
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('[pageerror]',e.message));

// seed one session
await page.goto(BOOTH,{waitUntil:'load'});
await page.waitForFunction(()=>window.__PB&&window.__PB.ready,null,{timeout:15000});
await page.click('#startBtn');
await page.waitForFunction(()=>window.__PB&&window.__PB.done,null,{timeout:30000});
await page.waitForFunction(()=>window.__PB.upload&&window.__PB.upload.status==='saved',null,{timeout:15000});
const up=await page.evaluate(()=>window.__PB.upload);
console.log('seeded session:', up.id);

// verify the wedding background is present in the app
const hasWedding=await page.evaluate(()=>!!document.querySelector('#galleryLink') && typeof BGS!=='undefined');
const weddingInList=await page.evaluate(()=>{ try { return JSON.stringify(BGS).includes('wedding.jpg'); } catch { return null; } });
// BGS is module-scoped (not global) so weddingInList may be null; check the asset instead
const weddingAsset=await page.evaluate(async()=>{ const r=await fetch('/assets/backgrounds/wedding.jpg'); return r.ok && (r.headers.get('content-type')||'').includes('image'); });
console.log('gallery button present:', hasWedding, ' wedding asset served:', weddingAsset);

// /api/sessions
const api=await page.evaluate(async()=>await (await fetch('/api/sessions',{cache:'no-store'})).json());
console.log('api sessions:', api.sessions.length);
const s0=api.sessions.find(s=>s.id===up.id)||api.sessions[0];
const stripHead=await page.evaluate(async(u)=>{ const r=await fetch(u); return {ok:r.ok, type:r.headers.get('content-type')}; }, s0.strip);
console.log('session0:', JSON.stringify({id:s0.id, strip:s0.strip, frames:s0.frames.length, numPhotos:s0.numPhotos}), ' stripHead:', JSON.stringify(stripHead));

// gallery page
const gp=await ctx.newPage();
await gp.goto(GAL,{waitUntil:'load'});
await gp.waitForSelector('.card',{timeout:10000});
const cards=await gp.$$eval('.card',els=>els.length);
await gp.click('.card');
await gp.waitForSelector('#modal.show',{timeout:5000});
// ---- filter smoke test: 'wedding' matches none of the classic-theme seeds ----
await gp.click('#mClose').catch(()=>{});
await gp.selectOption('#fTheme', { index: 0 }).catch(()=>{});
const optVals=await gp.$$eval('#fTheme option', els=>els.map(o=>o.value));
console.log('theme options:', JSON.stringify(optVals));
const before=await gp.$$eval('.card',els=>els.length);
const hasWeddingOpt=optVals.includes('wedding');
let filterOk=true;
if(optVals.includes('classic')){
  await gp.selectOption('#fTheme','classic'); await gp.waitForTimeout(150);
  const cl=await gp.$$eval('.card',els=>els.length);
  if(cl<1){ console.error('FAIL: classic filter hid everything'); filterOk=false; }
  if(!hasWeddingOpt){
    // no wedding sessions seeded → picking nothing else to test; reset
  }
  await gp.selectOption('#fTheme',''); await gp.waitForTimeout(150);
  const back=await gp.$$eval('.card',els=>els.length);
  if(back!==before){ console.error('FAIL: filter reset mismatch'); filterOk=false; }
  const cnt=await gp.$eval('#fCount',el=>el.textContent);
  console.log('filter smoke: classic→'+cl+' reset→'+back+'  count="'+cnt+'"');
} else { console.log('filter smoke skipped (no classic option?)'); filterOk=false; }
await gp.click('.card');
await gp.waitForSelector('#modal.show',{timeout:5000});
await gp.waitForFunction(()=>{ const i=document.querySelector('#mStrip'); return i&&i.complete&&i.naturalWidth>0; },null,{timeout:8000}).catch(()=>{});
const bigLoaded=await gp.$eval('#mStrip',el=>el.complete&&el.naturalWidth>0);
const frameThumbs=await gp.$$eval('#mFrames img',els=>els.length);
const thumbLoaded=await gp.$eval('#mFrames img',el=>el.complete&&el.naturalWidth>0).catch(()=>false);
console.log('gallery cards:', cards, ' strip img loaded:', bigLoaded, ' frame thumbs:', frameThumbs, ' thumb loaded:', thumbLoaded);

await browser.close();

let ok=true;
if(!weddingAsset){ console.error('FAIL: wedding.jpg not served'); ok=false; }
if(!(api.sessions.length>=1)){ console.error('FAIL: no sessions from API'); ok=false; }
if(!s0.strip || s0.frames.length!==4 || s0.numPhotos!==4){ console.error('FAIL: session shape'); ok=false; }
if(!stripHead.ok || !/image\/png/.test(stripHead.type||'')){ console.error('FAIL: strip not served as png'); ok=false; }
if(!(cards>=1)){ console.error('FAIL: no gallery cards'); ok=false; }
if(!bigLoaded || frameThumbs!==4 || !thumbLoaded){ console.error('FAIL: detail modal images'); ok=false; }
if(!filterOk){ console.error('FAIL: filter smoke'); ok=false; }
console.log(ok?'PASS ✅':'FAIL ❌');
process.exit(ok?0:1);
