import { chromium } from 'playwright'; import fs from 'node:fs';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const opts={ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;
const browser=await chromium.launch(opts);

// 1) review overlay
{
  const ctx=await browser.newContext({ permissions:['camera'], viewport:{width:1180,height:800} });
  const page=await ctx.newPage();
  await page.goto('http://localhost:8099/?fast=1&collect=local',{waitUntil:'load'});
  await page.waitForFunction(()=>window.__PB&&window.__PB.ready,null,{timeout:15000});
  await page.click('#startBtn');
  await page.waitForFunction(()=>window.__PB.review&&window.__PB.review.open,null,{timeout:30000});
  await page.waitForTimeout(250);
  await page.screenshot({path:'/root/photobooth/review_screen.png'});
  await page.evaluate(()=>window.__PB.confirmReview());
  await ctx.close();
}
// 2) admin gallery (offline routes)
{
  const ROWS=[
    { id:'2026-07-19_bbbbbb', created_at:'2026-07-19T15:00:00+00:00', num_photos:4, background:'wedding', strip_theme:'wedding', ai_enabled:true, favorite:true, tags:['dance'], note:'', strip_path:'b/strip.png', frame_paths:['b/frame-1.jpg','b/frame-2.jpg','b/frame-3.jpg','b/frame-4.jpg'] },
    { id:'2026-07-10_aaaaaa', created_at:'2026-07-10T10:00:00+00:00', num_photos:4, background:'none', strip_theme:'classic', ai_enabled:false, favorite:false, tags:[], note:'', strip_path:'a/strip.png', frame_paths:['a/frame-1.jpg'] },
  ];
  const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
  const ctx=await browser.newContext({ viewport:{width:1280,height:840} });
  await ctx.route('https://xjnqnxorqhobikyzshrt.supabase.co/**', (route)=>{
    const p=new URL(route.request().url()).pathname;
    if(p.startsWith('/rest/v1/sessions')) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(ROWS)});
    if(p.startsWith('/storage/')) return route.fulfill({status:200,contentType:'image/png',body:PNG});
    return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
  });
  const page=await ctx.newPage();
  await page.goto('http://localhost:8099/gallery.html?admin=demo',{waitUntil:'load'});
  await page.waitForSelector('.card',{timeout:10000});
  await page.click('.card');
  await page.waitForSelector('#modal.show');
  await page.waitForTimeout(250);
  await page.screenshot({path:'/root/photobooth/admin_screen.png'});
  await ctx.close();
}
await browser.close();
console.log('screenshots done');
