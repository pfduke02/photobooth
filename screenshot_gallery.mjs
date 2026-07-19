import { chromium } from 'playwright'; import fs from 'node:fs';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const opts={ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;
const browser=await chromium.launch(opts);
const ctx=await browser.newContext({ permissions:['camera'], viewport:{width:1280,height:820} });
const page=await ctx.newPage();
await page.goto('http://localhost:8099/?fast=1',{waitUntil:'load'});
await page.waitForFunction(()=>window.__PB&&window.__PB.ready,null,{timeout:15000});
for(let i=0;i<3;i++){
  await page.click('#startBtn');
  await page.waitForFunction(()=>window.__PB.done,null,{timeout:30000});
  await page.waitForFunction(()=>window.__PB.upload&&['saved','failed'].includes(window.__PB.upload.status),null,{timeout:15000});
  await page.click('#closeResult').catch(()=>{});
  await page.waitForTimeout(150);
}
const gp=await ctx.newPage();
await gp.goto('http://localhost:8099/gallery.html',{waitUntil:'load'});
await gp.waitForSelector('.card',{timeout:10000});
await gp.waitForTimeout(700);
await gp.screenshot({path:'/root/photobooth/gallery_grid.png'});
await gp.click('.card'); await gp.waitForSelector('#modal.show'); await gp.waitForTimeout(700);
await gp.screenshot({path:'/root/photobooth/gallery_detail.png'});
await browser.close();
console.log('screenshots done');
