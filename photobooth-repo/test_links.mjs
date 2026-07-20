// V2.4 link audit: crawl the booth and the gallery, extract every same-origin
// href/src, and verify each resolves (HTTP 200). Also checks the health
// endpoint and that unknown paths 404 (the SPA-fallback cache-poisoning guard).
import { chromium } from 'playwright'; import fs from 'node:fs';
const BASE='http://localhost:8099';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const opts={ args:['--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;
const browser=await chromium.launch(opts);
const page=await (await browser.newContext()).newPage();

let ok=true;
const seen=new Set(), bad=[];
for(const path of ['/', '/gallery.html?local=1']){
  await page.goto(BASE+path,{waitUntil:'load'});
  const urls=await page.evaluate(()=>{
    const out=new Set();
    document.querySelectorAll('[href],[src]').forEach(el=>{
      const u=el.getAttribute('href')||el.getAttribute('src');
      if(!u) return;
      if(/^(#|data:|blob:|mailto:|javascript:)/.test(u)) return;
      if(/^https?:\/\//.test(u) && !u.includes(location.host)) return;   // external: out of scope
      out.add(new URL(u, location.href).pathname + (new URL(u, location.href).search||''));
    });
    return [...out];
  });
  for(const u of urls){
    if(seen.has(u)) continue; seen.add(u);
    const r=await page.evaluate(async(u)=>{ try{ const r=await fetch(u,{cache:'no-store'}); return r.status; }catch{ return 0; } }, u);
    const good=r===200;
    if(!good){ bad.push(`${u} → ${r}`); ok=false; }
  }
  console.log(`${path}: checked ${urls.length} link(s)/asset(s)`);
}
// JS-loaded assets the DOM crawl can't see: backgrounds (Image objects), the
// mediapipe model files (locateFile), and button-driven navigation targets.
const CRITICAL=['/gallery.html',
  '/assets/qrcode.js',
  '/assets/backgrounds/studio.jpg','/assets/backgrounds/sunset.jpg','/assets/backgrounds/beach.jpg',
  '/assets/backgrounds/neon.jpg','/assets/backgrounds/bokeh.jpg','/assets/backgrounds/galaxy.jpg',
  '/assets/backgrounds/wedding.jpg','/assets/backgrounds/autumn.jpg','/assets/backgrounds/fireworks.jpg',
  '/assets/mediapipe/selfie_segmentation.js','/assets/mediapipe/selfie_segmentation.binarypb',
  '/assets/mediapipe/selfie_segmentation_landscape.tflite',
  '/assets/mediapipe/selfie_segmentation_solution_simd_wasm_bin.js',
  '/assets/mediapipe/selfie_segmentation_solution_simd_wasm_bin.wasm'];
for(const u of CRITICAL){
  if(seen.has(u)) continue; seen.add(u);
  const r=await page.evaluate(async(u)=>{ try{ const r=await fetch(u,{cache:'no-store'}); return r.status; }catch{ return 0; } }, u);
  if(r!==200){ bad.push(`${u} → ${r}`); ok=false; }
}
console.log('critical assets checked:', CRITICAL.length);
// key endpoints + 404 behavior
const health=await page.evaluate(async()=>{ try{ return (await (await fetch('/api/health')).json()).ok; }catch{ return false; } });
const bogus=await page.evaluate(async()=>{ try{ return (await fetch('/definitely-not-a-page',{cache:'no-store'})).status; }catch{ return 0; } });
const p404=await page.evaluate(async()=>{ try{ return (await fetch('/404.html',{cache:'no-store'})).status; }catch{ return 0; } });
console.log('health:',health,' bogus path status:',bogus,' 404.html:',p404,' total unique checked:',seen.size);
if(!health){ console.error('FAIL: /api/health'); ok=false; }
if(bogus!==404){ console.error('FAIL: unknown path should 404, got '+bogus); ok=false; }
if(p404!==200){ console.error('FAIL: 404.html missing'); ok=false; }
if(bad.length){ console.error('BROKEN LINKS:\n  '+bad.join('\n  ')); }
await browser.close();
console.log(ok?'PASS ✅':'FAIL ❌');
process.exit(ok?0:1);
