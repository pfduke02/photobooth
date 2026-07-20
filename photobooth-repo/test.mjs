// Headless test-run of the photobooth using a SIMULATED webcam.
// Covers: base capture (4 & 3 shots) + the on-device background-replace pipeline.
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = '/root/photobooth';
const URL = process.env.PB_URL || 'http://localhost:8099/photobooth.html?fast=1&collect=local';

function findChromium() {
  const root = '/opt/pw-browsers';
  try { for (const d of fs.readdirSync(root)) { const p = `${root}/${d}/chrome-linux/chrome`; if (fs.existsSync(p)) return p; } } catch {}
  return null;
}
const launchOpts = { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] };
const exe = findChromium(); if (exe) { launchOpts.executablePath = exe; console.log('using chromium:', exe); }

const browser = await chromium.launch(launchOpts);
const context = await browser.newContext({ permissions: ['camera'] });
const page = await context.newPage();
page.on('console', (m) => console.log('[page]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

console.log('goto', URL);
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__PB && window.__PB.ready, null, { timeout: 15000 });
await page.evaluate(() => { try { localStorage.clear(); } catch {} });
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.__PB && window.__PB.ready, null, { timeout: 15000 });
console.log('camera ready ✓');

// ---- Run 1: base 4 shots ----
await page.click('#startBtn');
await page.waitForFunction(() => window.__PB && window.__PB.done, null, { timeout: 30000 });
const r1 = await page.evaluate(() => window.__PB.count);
const dataURL = await page.evaluate(() => window.__PB.lastStrip);
fs.writeFileSync(`${OUT}/sample_strip.png`, Buffer.from(dataURL.split(',')[1], 'base64'));
const dims = await page.evaluate(() => new Promise((res) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.src = window.__PB.lastStrip; }));
console.log('run1 (base): shots =', r1, ' strip dims =', JSON.stringify(dims));
await page.screenshot({ path: `${OUT}/app_screenshot.png` });

// ---- Run 2: 3 shots ----
await page.click('#closeResult');
await page.evaluate(()=>window.__PB.setShots(3));
await page.click('#startBtn');
await page.waitForFunction(() => window.__PB && window.__PB.done, null, { timeout: 30000 });
const r2 = await page.evaluate(() => window.__PB.count);
console.log('run2 (base): shots =', r2);
await page.click('#closeResult');
await page.evaluate(()=>window.__PB.setShots(4));

// ---- Run 3: AI background replacement ----
console.log('enabling background replace…');
const aiOk = await page.evaluate(async () => { try { return await window.__PB.enableAI(); } catch (e) { return false; } });
const aiReady = await page.evaluate(() => window.__PB.aiReady);
console.log('AI enabled =', aiOk, ' aiReady =', aiReady);

let aiStddev = null, r3 = null;
if (aiOk) {
  await page.evaluate(() => window.__PB.setBg('studio'));
  await page.waitForTimeout(1200); // let a few frames composite
  // measure variance of the composited proc canvas (should be non-uniform if a bg was drawn)
  aiStddev = await page.evaluate(() => {
    const c = document.querySelector('#proc'); const x = c.getContext('2d');
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let s = 0, s2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 997) { s += d[i]; s2 += d[i] * d[i]; n++; }
    const m = s / n; return Math.sqrt(Math.max(0, s2 / n - m * m));
  });
  console.log('composited proc stddev =', aiStddev.toFixed(2));
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__PB && window.__PB.done, null, { timeout: 30000 });
  r3 = await page.evaluate(() => window.__PB.count);
  const aiURL = await page.evaluate(() => window.__PB.lastStrip);
  fs.writeFileSync(`${OUT}/sample_strip_ai.png`, Buffer.from(aiURL.split(',')[1], 'base64'));
  console.log('run3 (AI): shots =', r3, ' wrote sample_strip_ai.png');
  await page.screenshot({ path: `${OUT}/app_ai_screenshot.png` });
}

await browser.close();

let ok = true;
if (r1 !== 4) { console.error('FAIL: base run1 expected 4'); ok = false; }
if (!dims || dims.w !== 1200 || dims.h !== 3600) { console.error(`FAIL: strip must be print-true 1200x3600 (2x6in @600dpi), got ${JSON.stringify(dims)}`); ok = false; }
if (r2 !== 3) { console.error('FAIL: base run2 expected 3'); ok = false; }
if (!aiOk) { console.error('FAIL: background-replace model did not initialize'); ok = false; }
if (aiOk && !(aiStddev > 2)) { console.error('FAIL: composited frame looks uniform (bg not drawn)'); ok = false; }
if (aiOk && r3 !== 4) { console.error('FAIL: AI run expected 4'); ok = false; }
console.log(ok ? 'PASS ✅' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
