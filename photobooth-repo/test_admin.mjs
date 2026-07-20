// Admin + date-filter test, fully offline: Playwright routes intercept the
// Supabase REST/storage/function calls, so we verify the gallery's admin UI
// sends the right payloads (update / delete / gc) and date filters work.
import { chromium } from 'playwright'; import fs from 'node:fs';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const opts={ args:['--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;

const ROWS=[
  { id:'2026-07-10_aaaaaa', created_at:'2026-07-10T10:00:00+00:00', num_photos:4, background:'none', strip_theme:'classic',
    ai_enabled:false, app_version:'1.3', favorite:false, tags:[], note:'', strip_path:'2026-07-10_aaaaaa/strip.png', frame_paths:['2026-07-10_aaaaaa/frame-1.jpg'] },
  { id:'2026-07-19_bbbbbb', created_at:'2026-07-19T15:00:00+00:00', num_photos:4, background:'wedding', strip_theme:'wedding',
    ai_enabled:true, app_version:'1.3', favorite:false, tags:['x'], note:'', strip_path:'2026-07-19_bbbbbb/strip.png', frame_paths:['2026-07-19_bbbbbb/frame-1.jpg'] },
];
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const adminCalls=[];

const browser=await chromium.launch(opts);
const ctx=await browser.newContext();
await ctx.route('https://xjnqnxorqhobikyzshrt.supabase.co/**', async (route)=>{
  const url=new URL(route.request().url());
  if(url.pathname.startsWith('/rest/v1/sessions')) return route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(ROWS) });
  if(url.pathname.startsWith('/storage/v1/object/public/')) return route.fulfill({ status:200, contentType:'image/png', body:PNG });
  if(url.pathname.startsWith('/functions/v1/admin')){
    const body=JSON.parse(route.request().postData()||'{}');
    adminCalls.push(body);
    const resp = body.action==='gc' ? {ok:true, removedPrefixes:['x'], removedFiles:2} : {ok:true};
    return route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(resp) });
  }
  return route.fulfill({ status:404, body:'nf' });
});
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('[pageerror]',e.message));

await page.goto('http://localhost:8099/gallery.html?admin=lpadmin-118779d070',{waitUntil:'load'});
await page.waitForSelector('.card',{timeout:10000});
let ok=true;
const cards0=await page.$$eval('.card',els=>els.length);
const badge=await page.$eval('#adminBadge',el=>getComputedStyle(el).display!=='none');
const gcVis=await page.$eval('#gcBtn',el=>getComputedStyle(el).display!=='none');
const urlClean=await page.evaluate(()=>location.search);
console.log('cards:',cards0,' adminBadge:',badge,' gcBtn:',gcVis,' url search:',JSON.stringify(urlClean));
if(cards0!==2||!badge||!gcVis){ console.error('FAIL: admin init'); ok=false; }
if(urlClean.includes('admin')){ console.error('FAIL: admin key not stripped from URL'); ok=false; }

// date filter: from 2026-07-15 → only the 7-19 session
await page.fill('#fFrom','2026-07-15'); await page.dispatchEvent('#fFrom','change'); await page.waitForTimeout(120);
const cardsFrom=await page.$$eval('.card',els=>els.length);
await page.fill('#fFrom','2099-01-01'); await page.dispatchEvent('#fFrom','change'); await page.waitForTimeout(120);
const emptyMsg=await page.$eval('#empty',el=>getComputedStyle(el).display!=='none');
await page.fill('#fFrom',''); await page.dispatchEvent('#fFrom','change'); await page.waitForTimeout(120);
console.log('date filter: from 07-15 →',cardsFrom,' future → empty:',emptyMsg);
if(cardsFrom!==1||!emptyMsg){ console.error('FAIL: date filter'); ok=false; }

// open first card (sorted desc? view order = ROWS order as fetched) — click card 0
await page.click('.card');
await page.waitForSelector('#modal.show');
const abVis=await page.$eval('#adminBox',el=>getComputedStyle(el).display!=='none');
if(!abVis){ console.error('FAIL: adminBox hidden'); ok=false; }

// favorite toggle
await page.click('#aFav'); await page.waitForTimeout(150);
// tags + note save
await page.fill('#aTags','fun, dance floor'); await page.fill('#aNote','great one');
await page.click('#aSave'); await page.waitForTimeout(150);
// two-step delete
await page.click('#aDelete'); await page.waitForTimeout(100);
const armedTxt=await page.$eval('#aDelete',el=>el.textContent);
await page.click('#aDelete'); await page.waitForTimeout(200);
const cardsAfterDel=await page.$$eval('.card',els=>els.length);
// gc
await page.click('#gcBtn'); await page.waitForTimeout(150);

console.log('admin calls:', JSON.stringify(adminCalls));
console.log('armed text:', JSON.stringify(armedTxt), ' cards after delete:', cardsAfterDel);
const [c1,c2,c3,c4]=adminCalls;
if(!(c1&&c1.action==='update'&&c1.favorite===true)){ console.error('FAIL: favorite call'); ok=false; }
if(!(c2&&c2.action==='update'&&Array.isArray(c2.tags)&&c2.tags.length===2&&c2.note==='great one')){ console.error('FAIL: save call'); ok=false; }
if(!(c3&&c3.action==='delete'&&typeof c3.id==='string')){ console.error('FAIL: delete call'); ok=false; }
if(!(c4&&c4.action==='gc')){ console.error('FAIL: gc call'); ok=false; }
if(!armedTxt.includes('Really')){ console.error('FAIL: two-step delete arm'); ok=false; }
if(cardsAfterDel!==1){ console.error('FAIL: card not removed after delete'); ok=false; }

await browser.close();
console.log(ok?'PASS ✅':'FAIL ❌');
process.exit(ok?0:1);
