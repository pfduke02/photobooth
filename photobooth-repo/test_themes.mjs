// Capture a strip under each theme (simulated webcam) to verify theming.
import { chromium } from 'playwright'; import fs from 'node:fs';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const opts={ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;
const browser=await chromium.launch(opts);
const ctx=await browser.newContext({ permissions:['camera'] });
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('[pageerror]',e.message));
await page.goto('http://localhost:8099/?fast=1&collect=local',{waitUntil:'load'});
await page.waitForFunction(()=>window.__PB&&window.__PB.ready,null,{timeout:15000});
const themes=['classic','noir','warm','wedding']; let ok=true;
for(const t of themes){
  const set=await page.evaluate((id)=>{ window.__PB.setTheme(id); return document.querySelector('#themeSel').value; }, t);
  await page.click('#startBtn');
  await page.waitForFunction(()=>window.__PB.done,null,{timeout:30000});
  const url=await page.evaluate(()=>window.__PB.lastStrip);
  if(!url){ console.error('FAIL: no strip for',t); ok=false; }
  else fs.writeFileSync(`/root/photobooth/strip_${t}.png`, Buffer.from(url.split(',')[1],'base64'));
  await page.waitForFunction(()=>window.__PB.upload&&['saved','failed'].includes(window.__PB.upload.status),null,{timeout:15000});
  await page.click('#closeResult').catch(()=>{});
  await page.waitForTimeout(150);
  console.log(`theme ${t}: select=${set} strip=${url?url.length+'b':'MISSING'}`);
}
await browser.close();
console.log(ok?'PASS ✅':'FAIL ❌');
process.exit(ok?0:1);
