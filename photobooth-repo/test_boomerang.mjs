// Boomerang test: a session produces an encoded ping-pong video (MediaRecorder),
// it saves to the local session folder, and the review screen shows the theme
// rail (live previews) + boomerang preview.
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
const OUT='/root/photobooth';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const opts={ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;
const browser=await chromium.launch(opts);
const ctx=await browser.newContext({ permissions:['camera'] });
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('[pageerror]',e.message));

await page.goto('http://localhost:8099/?fast=1&collect=local',{waitUntil:'load'});
await page.waitForFunction(()=>window.__PB&&window.__PB.ready,null,{timeout:15000});
await page.click('#startBtn');

// review opens; theme rail rendered; boomerang preview canvas visible
await page.waitForFunction(()=>window.__PB.review&&window.__PB.review.open,null,{timeout:30000});
const railCount=await page.$$eval('#rvRail .rvTheme',els=>els.length);
const railImgsLoaded=await page.$$eval('#rvRail .rvTheme img',els=>els.every(i=>i.complete&&i.naturalWidth>0));
const boomVisible=await page.$eval('#rvBoom',el=>getComputedStyle(el).display!=='none');
// tap a theme in the rail (wedding)
await page.$$eval('#rvRail .rvTheme', els=>{ const w=els.find(e=>e.textContent.includes('Wedding')); if(w) w.click(); });
const selIsWedding=await page.$$eval('#rvRail .rvTheme.sel', els=>els.length===1 && els[0].textContent.includes('Wedding'));
console.log('rail themes:',railCount,' previews loaded:',railImgsLoaded,' boom preview visible:',boomVisible,' wedding selected:',selIsWedding);

await page.evaluate(()=>window.__PB.confirmReview());
await page.waitForFunction(()=>window.__PB.done,null,{timeout:30000});
await page.waitForFunction(()=>window.__PB.upload&&['saved','failed'].includes(window.__PB.upload.status),null,{timeout:20000});
const up=await page.evaluate(()=>window.__PB.upload);
const boomInfo=await page.evaluate(()=>window.__PB.boomerang);
const boomBtn=await page.$eval('#boomSave',el=>getComputedStyle(el).display!=='none');
const vidShown=await page.$eval('#boomVid',el=>getComputedStyle(el).display!=='none' && !!el.src);
console.log('upload:',up.status,up.id,' boomerang:',JSON.stringify(boomInfo),' save-btn:',boomBtn,' video shown:',vidShown);

let ok=true;
if(railCount!==6||!railImgsLoaded){ console.error('FAIL: theme rail'); ok=false; }
if(!boomVisible){ console.error('FAIL: boom preview'); ok=false; }
if(!selIsWedding){ console.error('FAIL: rail selection'); ok=false; }
if(up.status!=='saved'){ console.error('FAIL: not saved'); ok=false; }
if(!boomInfo||!(boomInfo.size>1000)){ console.error('FAIL: boomerang not encoded'); ok=false; }
if(!boomBtn||!vidShown){ console.error('FAIL: result boomerang UI'); ok=false; }
if(up.id){
  const dir=path.join(OUT,'sessions',up.id);
  const files=fs.readdirSync(dir);
  const boomFile=files.find(f=>/^boomerang\.(webm|mp4)$/.test(f));
  const metaJ=JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'),'utf8'));
  console.log('session files:',files.sort().join(', '));
  if(!boomFile){ console.error('FAIL: boomerang file not written locally'); ok=false; }
  else if(fs.statSync(path.join(dir,boomFile)).size<1000){ console.error('FAIL: boomerang file tiny'); ok=false; }
  if(!metaJ.boomerangPath){ console.error('FAIL: boomerangPath missing from metadata'); ok=false; }
  if(metaJ.stripTheme!=='wedding'){ console.error('FAIL: theme from rail not recorded, got '+metaJ.stripTheme); ok=false; }
}
await browser.close();
console.log(ok?'PASS ✅':'FAIL ❌');
process.exit(ok?0:1);
