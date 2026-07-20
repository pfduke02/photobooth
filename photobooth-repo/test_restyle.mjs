// Phase 2B restyle test — TRUE end-to-end against the real Python sidecar:
// spawns restyle_server.py if it isn't running, waits for /health, then runs a
// session, applies "sketch" to the hero frame on the review screen, switches to
// "oil" (must not compound — always restyled from the original), confirms, and
// checks the saved metadata.
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
import { spawn } from 'node:child_process';
const OUT='/root/photobooth';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function health(){ try{ const r=await fetch('http://127.0.0.1:8123/health'); const j=await r.json(); return j&&j.ok; }catch{ return false; } }
if(!await health()){
  spawn('python3',[path.join(OUT,'restyle_server.py')],{cwd:OUT,detached:true,stdio:'ignore'}).unref();
  let up=false; for(let i=0;i<40;i++){ if(await health()){ up=true; break; } await sleep(500); }
  if(!up){ console.error('FAIL: sidecar did not come up'); process.exit(1); }
}
console.log('sidecar healthy');

const opts={ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;
const browser=await chromium.launch(opts);
const ctx=await browser.newContext({ permissions:['camera'] });
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('[pageerror]',e.message));

await page.goto('http://localhost:8099/?fast=1&collect=local',{waitUntil:'load'});
await page.waitForFunction(()=>window.__PB&&window.__PB.ready,null,{timeout:15000});
await page.waitForFunction(()=>window.__PB.restyle&&window.__PB.restyle.available,null,{timeout:8000});
const styles=await page.evaluate(()=>window.__PB.restyle.styles);
console.log('styles offered:',styles.join(','));
let ok=true;
if(!styles.includes('oil')||!styles.includes('sketch')){ console.error('FAIL: classical styles missing'); ok=false; }

await page.click('#startBtn');
await page.waitForFunction(()=>window.__PB.review&&window.__PB.review.open,null,{timeout:30000});
const rowVisible=await page.$eval('#rvStyle',el=>getComputedStyle(el).display!=='none');
const chipCount=await page.$$eval('#rvStyle .rvChip',els=>els.length);
const heroBefore=await page.$$eval('#rvThumbs .rvThumb img',els=>els[els.length-1].src.length);

await page.evaluate(()=>window.__PB.setRestyle('sketch'));
await page.waitForFunction(()=>window.__PB.restyle.applied==='sketch',null,{timeout:25000});
const heroSketch=await page.$$eval('#rvThumbs .rvThumb img',els=>els[els.length-1].src.length);
// switch style — must restyle from the ORIGINAL, not the sketched frame
await page.evaluate(()=>window.__PB.setRestyle('oil'));
await page.waitForFunction(()=>window.__PB.restyle.applied==='oil',null,{timeout:25000});
const selChip=await page.$$eval('#rvStyle .rvChip.sel',els=>els.map(e=>e.textContent).join(','));
console.log('row:',rowVisible,' chips:',chipCount,' hero src bytes before/sketch:',heroBefore,heroSketch,' selected:',selChip);
if(!rowVisible||chipCount<4){ console.error('FAIL: style row'); ok=false; }
if(heroSketch===heroBefore){ console.error('FAIL: hero thumb unchanged after sketch'); ok=false; }
if(selChip!=='Oil paint'){ console.error('FAIL: selection chip'); ok=false; }

await page.evaluate(()=>window.__PB.confirmReview());
await page.waitForFunction(()=>window.__PB.done,null,{timeout:30000});
await page.waitForFunction(()=>window.__PB.upload&&['saved','failed'].includes(window.__PB.upload.status),null,{timeout:20000});
const up=await page.evaluate(()=>window.__PB.upload);
if(up.status!=='saved'){ console.error('FAIL: not saved'); ok=false; }
else{
  const meta=JSON.parse(fs.readFileSync(path.join(OUT,'sessions',up.id,'metadata.json'),'utf8'));
  console.log('meta.restyle:',meta.restyle,' ms:',meta.restyleMs);
  if(meta.restyle!=='oil'){ console.error('FAIL: metadata restyle'); ok=false; }
  if(typeof meta.restyleMs!=='number'){ console.error('FAIL: restyleMs missing'); ok=false; }
}
await browser.close();
console.log(ok?'PASS ✅':'FAIL ❌');
process.exit(ok?0:1);
