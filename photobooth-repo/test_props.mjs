// Props test (Phase 2A): ?fakeface=1 feeds synthetic landmarks, so the prop
// engine runs headlessly with no CDN/model. Asserts: picker row (5 options),
// 🕶 composites dark lenses onto #proc at the fake eye position, a session
// records meta.prop + per-shot props, and 🎲 surprise rolls a real prop per shot.
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
const OUT='/root/photobooth';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const opts={ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;
const browser=await chromium.launch(opts);
const ctx=await browser.newContext({ permissions:['camera'] });
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('[pageerror]',e.message));

await page.goto('http://localhost:8099/?fast=1&collect=local&fakeface=1',{waitUntil:'load'});
await page.waitForFunction(()=>window.__PB&&window.__PB.ready,null,{timeout:15000});
let ok=true;

// picker row: visible, 5 options, crown first among props
const props=await page.$$eval('#propSeg button',els=>els.map(b=>b.dataset.prop));
console.log('prop options:',props.join(','));
if(props.join(',')!=='none,crown,tophat,glasses,surprise'){ console.error('FAIL: prop row options'); ok=false; }

// select 🕶 via the UI; fakeface → ready instantly, draws every frame
await page.click('#propSeg button[data-prop="glasses"]');
await page.waitForFunction(()=>window.__PB.propsReady,null,{timeout:5000});
await page.waitForFunction(()=>window.__PB.propDraws>5,null,{timeout:5000});
// pixel probe at the fake left-eye center — vector lens = near-black there
const px=await page.evaluate(()=>{ const p=document.querySelector('#proc');
  const x=Math.round(p.width*0.40), y=Math.round(p.height*0.45);
  const d=p.getContext('2d').getImageData(x,y,1,1).data; return {r:d[0],g:d[1],b:d[2]}; });
console.log('lens pixel:',JSON.stringify(px),' propDraws:',await page.evaluate(()=>window.__PB.propDraws));
if(!(px.r<70&&px.g<70&&px.b<70)){ console.error('FAIL: glasses not composited (pixel not dark)'); ok=false; }

// session 1 — fixed prop recorded per shot
await page.click('#startBtn');
await page.waitForFunction(()=>window.__PB.review&&window.__PB.review.open,null,{timeout:30000});
await page.evaluate(()=>window.__PB.confirmReview());
await page.waitForFunction(()=>window.__PB.done,null,{timeout:30000});
await page.waitForFunction(()=>window.__PB.upload&&['saved','failed'].includes(window.__PB.upload.status),null,{timeout:20000});
const up1=await page.evaluate(()=>window.__PB.upload);
if(up1.status!=='saved'){ console.error('FAIL: session 1 not saved'); ok=false; }
else{
  const meta=JSON.parse(fs.readFileSync(path.join(OUT,'sessions',up1.id,'metadata.json'),'utf8'));
  console.log('session1 prop:',meta.prop,' shots:',JSON.stringify(meta.propShots));
  if(meta.prop!=='glasses'){ console.error('FAIL: meta.prop'); ok=false; }
  if(!Array.isArray(meta.propShots)||meta.propShots.length!==4||!meta.propShots.every(p=>p==='glasses')){ console.error('FAIL: propShots'); ok=false; }
}
await page.click('#closeResult').catch(()=>{});
await page.waitForTimeout(200);

// session 2 — 🎲 surprise rolls a real prop each shot
await page.click('#propSeg button[data-prop="surprise"]');
await page.click('#startBtn');
await page.waitForFunction(()=>window.__PB.review&&window.__PB.review.open,null,{timeout:30000});
await page.evaluate(()=>window.__PB.confirmReview());
await page.waitForFunction(()=>window.__PB.done,null,{timeout:30000});
await page.waitForFunction(()=>window.__PB.upload&&['saved','failed'].includes(window.__PB.upload.status),null,{timeout:20000});
const up2=await page.evaluate(()=>window.__PB.upload);
if(up2.status!=='saved'){ console.error('FAIL: session 2 not saved'); ok=false; }
else{
  const meta=JSON.parse(fs.readFileSync(path.join(OUT,'sessions',up2.id,'metadata.json'),'utf8'));
  console.log('session2 prop:',meta.prop,' shots:',JSON.stringify(meta.propShots));
  if(meta.prop!=='surprise'){ console.error('FAIL: meta.prop surprise'); ok=false; }
  const pool=['crown','tophat','glasses'];
  if(!Array.isArray(meta.propShots)||meta.propShots.length!==4||!meta.propShots.every(p=>pool.includes(p))){ console.error('FAIL: surprise propShots'); ok=false; }
}

await browser.close();
console.log(ok?'PASS ✅':'FAIL ❌');
process.exit(ok?0:1);
