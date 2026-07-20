// Retake test: review opens after the 4th shot; retaking slot 2 replaces that
// frame; confirm composes ONE strip and saves exactly ONE local session.
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
const OUT='/root/photobooth';
function findChromium(){ const root='/opt/pw-browsers'; try{ for(const d of fs.readdirSync(root)){ const p=`${root}/${d}/chrome-linux/chrome`; if(fs.existsSync(p)) return p; } }catch{} return null; }
const opts={ args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--no-sandbox'] };
const exe=findChromium(); if(exe) opts.executablePath=exe;
const browser=await chromium.launch(opts);
const ctx=await browser.newContext({ permissions:['camera'] });
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('[pageerror]',e.message));

const before = fs.existsSync(path.join(OUT,'sessions')) ? fs.readdirSync(path.join(OUT,'sessions')).length : 0;

await page.goto('http://localhost:8099/?fast=1&collect=local',{waitUntil:'load'});
await page.waitForFunction(()=>window.__PB&&window.__PB.ready,null,{timeout:15000});
await page.click('#startBtn');

// review should open after the shots
await page.waitForFunction(()=>window.__PB.review&&window.__PB.review.open,null,{timeout:30000});
const reviewVisible=await page.$eval('#review',el=>getComputedStyle(el).display!=='none');
const thumbs=await page.$$eval('#rvThumbs .rvThumb',els=>els.length);
const srcBefore=await page.$$eval('#rvThumbs img',els=>els.map(i=>i.src.length));
console.log('review open:', reviewVisible, ' thumbs:', thumbs);

// retake slot 2 (index 1)
await page.evaluate(()=>window.__PB.retake(1));
await page.waitForFunction(()=>window.__PB.review&&window.__PB.review.open,null,{timeout:20000});
const srcAfter=await page.$$eval('#rvThumbs img',els=>els.map(i=>i.src.length));
const changed = srcBefore[1]!==srcAfter[1];   // synthetic feed animates → new capture differs
console.log('slot2 thumb bytes before/after:', srcBefore[1], srcAfter[1], ' changed:', changed);

// confirm and finish
await page.evaluate(()=>window.__PB.confirmReview());
await page.waitForFunction(()=>window.__PB.done,null,{timeout:30000});
await page.waitForFunction(()=>window.__PB.upload&&['saved','failed'].includes(window.__PB.upload.status),null,{timeout:15000});
const up=await page.evaluate(()=>window.__PB.upload);
const dims=await page.evaluate(()=>new Promise(res=>{const i=new Image();i.onload=()=>res({w:i.naturalWidth,h:i.naturalHeight});i.src=window.__PB.lastStrip;}));
const after = fs.readdirSync(path.join(OUT,'sessions')).length;
console.log('upload:', up.status, ' dims:', JSON.stringify(dims), ` sessions ${before}->${after}`);

await browser.close();
let ok=true;
if(!reviewVisible||thumbs!==4){ console.error('FAIL: review UI'); ok=false; }
if(!changed){ console.error('FAIL: retake did not replace the frame'); ok=false; }
if(up.status!=='saved'){ console.error('FAIL: session not saved'); ok=false; }
if(!dims||dims.w!==1200||dims.h!==3600){ console.error('FAIL: strip dims'); ok=false; }
if(after-before!==1){ console.error(`FAIL: expected exactly ONE new session, got ${after-before}`); ok=false; }
console.log(ok?'PASS ✅':'FAIL ❌');
process.exit(ok?0:1);
