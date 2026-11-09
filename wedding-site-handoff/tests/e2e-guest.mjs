// End-to-end: the real guest page (bundle/photos/index.html, API swapped to the staging slug),
// in headless Chromium, against the demo event on the real backend.
//   scenario 1: a private photo + a short video (poster path), then the 70 MB video (resumable path)
//   scenario 2: a 70 MB video interrupted by closing the tab → the page offers to send it again,
//               and the server ends up with ONE row for it
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const S = path.resolve(import.meta.dirname, '..');
const EVENT = process.env.EVENT || '12d4d64f73d342f2865aaa28';
const API = process.env.API || 'https://hseupjbneifqxaykxltt.supabase.co/functions/v1/api-next';
const LIVE_API = 'https://hseupjbneifqxaykxltt.supabase.co/functions/v1/api';
import { execFileSync } from 'node:child_process';
const out = path.join(S, 'tests', 'out'); fs.mkdirSync(out, { recursive: true });
// Fresh files every run: the server de-duplicates by content, so re-using files would just
// report "Already shared" instead of exercising the upload paths.
const media = path.join(out, 'run-' + Date.now()); fs.mkdirSync(media, { recursive: true });
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
const seed = Math.floor(Math.random() * 1e9);
execFileSync('python3', ['-c', `from PIL import Image, ImageDraw\nim=Image.new('RGB',(1600,1200),(${seed % 200 + 30},${(seed >> 8) % 200 + 30},${(seed >> 16) % 200 + 30}))\nImageDraw.Draw(im).text((100,100),'run ${seed}',fill=(0,0,0))\nim.save('${path.join(media, 'photo-b.jpg')}','JPEG',quality=92)`]);
ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-vf', `hue=h=${seed % 360},noise=alls=${20 + seed % 40}:allf=t+u`, '-t', '3', '-c:v', 'libvpx-vp9', '-b:v', '300k', path.join(media, 'clip-3s.webm')]);
ff(['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '640x360', '-r', '30', '-i', '/dev/urandom', '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8M', '-maxrate', '8M', '-bufsize', '16M', '-movflags', '+faststart', path.join(media, 'clip-40s-big.mp4')]);
ff(['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '640x360', '-r', '30', '-i', '/dev/urandom', '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8M', '-maxrate', '8M', '-bufsize', '16M', '-movflags', '+faststart', path.join(media, 'clip-40s-b.mp4')]);
const big = path.join(S, 'media', 'clip-70s-big.mp4');
if (!fs.existsSync(big)) { fs.mkdirSync(path.dirname(big), { recursive: true }); ff(['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '640x360', '-r', '30', '-i', '/dev/urandom', '-t', '70', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8M', '-maxrate', '8M', '-bufsize', '16M', '-movflags', '+faststart', big]); }
fs.copyFileSync(big, path.join(media, 'clip-70s-big.mp4'));

// ---- a static server for the bundle, with the API constant swapped to the staging slug ----
const root = path.join(S, 'bundle');
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.normalize(path.join(root, p));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  let body = fs.readFileSync(f);
  const type = f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
  if (f.endsWith('.html')) body = Buffer.from(body.toString().split(LIVE_API).join(API));
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
const browser = await chromium.launch({ proxy });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 900 }, deviceScaleFactor: 1 });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const wire = (page) => {
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log('  [console.' + m.type() + ']', m.text().slice(0, 240)); });
  page.on('pageerror', (e) => log('  [pageerror]', e.message));
  page.on('requestfailed', (r) => { if (!/favicon|^blob:/.test(r.url())) log('  [requestfailed]', r.method(), r.url().slice(0, 120), r.failure()?.errorText); });
};
const states = (page) => page.$$eval('#trayGrid .tile', (t) => t.map((x) => x.dataset.state + (x.classList.contains('video') ? '(video)' : '') + ' ' + (x.querySelector('.badges')?.textContent || '').trim() + (x.querySelector('.why')?.textContent ? ' why=' + x.querySelector('.why').textContent : '')));
const settled = (n) => { const t = [...document.querySelectorAll('#trayGrid .tile')]; return t.length === n && t.every((x) => ['done', 'failed', 'dup'].includes(x.dataset.state)); };
let failures = 0;
const check = (cond, msg) => { if (cond) log('  ✓', msg); else { failures++; log('  ✗', msg); } };

// ---------- scenario 1 ----------
log('scenario 1: private photo + short video, then the 70 MB video');
let page = await ctx.newPage(); wire(page);
await page.goto(base + '/photos/?e=' + EVENT);
await page.waitForFunction(() => /shared so far|Be the first|trouble/.test(document.getElementById('proof').textContent), null, { timeout: 30000 });
log('  proof:', await page.textContent('#proof'));
log('  fine:', await page.textContent('#fine'));
check(await page.evaluate(() => typeof window.tus !== 'undefined'), 'tus library loaded');
await page.fill('#name', 'E2E Test');
await page.click('#whoFamily');
check((await page.textContent('#pick')).includes('for the family'), 'family mode shows on the button');
await page.setInputFiles('#file', [path.join(media, 'photo-b.jpg'), path.join(media, 'clip-3s.webm')]);
await page.waitForFunction(settled, 2, { timeout: 180000 });
let st = await states(page); log('  batch 1:', JSON.stringify(st));
check(st.every((s) => s.startsWith('done')), 'photo and short video received');
check(st.some((s) => s.includes('(video)') && s.includes('▶ 0:03')), 'video badge shows the duration');
check(st.every((s) => s.includes('family')), 'both carry the family badge');
check(await page.$eval('#trayGrid .tile.video img', (i) => !!i && i.naturalWidth > 0).catch(() => false), 'video poster was generated on the page');
log('  mine:', await page.textContent('#mineTitle'));

await page.click('#whoAlbum');
await page.setInputFiles('#file', [path.join(media, 'clip-40s-big.mp4')]);
const t0 = Date.now();
await page.waitForFunction(settled, 3, { timeout: 900000 });
st = await states(page); log('  batch 2:', JSON.stringify(st), ((Date.now() - t0) / 1000).toFixed(0) + 's');
check(st[2].startsWith('done'), '40 MB video received (resumable path)');
await page.setInputFiles('#file', [path.join(media, 'clip-70s-big.mp4')]);
await page.waitForFunction(settled, 4, { timeout: 900000 });
st = await states(page); log('  batch 3 (70 MB, needs the project limit raised):', JSON.stringify(st[3]));
log(st[3].startsWith('done') ? '  ✓ 70 MB video received — project upload limit has been raised' : '  ! 70 MB video refused — raise the Supabase project upload limit (Settings → Storage) to 2048 MB');
log('  status:', await page.textContent('#trayStatus'));
await page.screenshot({ path: path.join(out, 'guest-1.png'), fullPage: true });
await page.reload();
await page.waitForFunction(() => !document.getElementById('mine').hidden, null, { timeout: 30000 });
const bigFailed = !st[3].startsWith('done');
const bannerHidden = await page.$eval('#resume', (e) => e.hidden);
check(bannerHidden === !bigFailed, bigFailed ? 'resume banner offers the refused 70 MB clip again (it never finished)' : 'no resume banner after everything was received');
log('  after reload:', await page.textContent('#mineTitle'));
const deviceKey1 = await page.evaluate((e) => localStorage.getItem('lp-photos-device-' + e.slice(0, 8)), EVENT);
await page.close();

// ---------- scenario 2 ----------
log('scenario 2: interrupt the 70 MB video, come back, send it again');
page = await ctx.newPage(); wire(page);
await page.goto(base + '/photos/?e=' + EVENT);
await page.waitForFunction(() => !document.getElementById('mine').hidden, null, { timeout: 30000 });
// a different file name so it is not a duplicate of scenario 1
const copy = path.join(out, 'clip-40s-copy.mp4'); fs.copyFileSync(path.join(media, 'clip-40s-b.mp4'), copy); // different content: not a duplicate
await page.setInputFiles('#file', [copy]);
await page.waitForFunction(() => { const m = document.querySelector('#trayGrid .tile .meter span'); return m && parseInt(m.style.width) >= 25; }, null, { timeout: 300000 });
log('  at', await page.$eval('#trayGrid .tile .meter span', (m) => m.style.width), '— closing the tab');
await page.close();
page = await ctx.newPage(); wire(page);
await page.goto(base + '/photos/?e=' + EVENT);
await page.waitForFunction(() => !document.getElementById('resume').hidden || !document.getElementById('mine').hidden, null, { timeout: 30000 });
await page.waitForTimeout(1500);
const bannerShown = await page.$eval('#resume', (e) => !e.hidden);
check(bannerShown, 'resume banner appears on the next visit');
log('  banner:', (await page.textContent('#resumeText')).trim());
const canSend = bannerShown && !(await page.$eval('#resumeSend', (b) => b.hidden));
check(canSend, 'the file is still on the device ("Send it now")');
if (canSend) {
  const t1 = Date.now();
  await page.click('#resumeSend');
  const nTiles = await page.$$eval('#trayGrid .tile', (t) => t.length); // the refused 70 MB clip is re-sent too
  await page.waitForFunction(settled, nTiles, { timeout: 900000 });
  st = await states(page); log('  resumed:', JSON.stringify(st), ((Date.now() - t1) / 1000).toFixed(0) + 's');
  const resumed = st.find((x) => x.includes('▶ 0:40'));
  check(resumed && resumed.startsWith('done'), 'interrupted video received after resume');
  check(await page.$eval('#resume', (e) => e.hidden), 'banner gone once received');
}
await page.screenshot({ path: path.join(out, 'guest-2.png'), fullPage: true });

// ---------- server view ----------
const r = await page.evaluate(async ({ api, e, dk }) => {
  const res = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ e, action: 'mine', deviceKey: dk }) });
  return res.json();
}, { api: API, e: EVENT, dk: deviceKey1 });
log('  server mine:', JSON.stringify(r.items.map((i) => [i.name, i.kind, i.private ? 'private' : 'album', i.duration])), 'unfinished:', JSON.stringify(r.unfinished.map((u) => u.name)));
check(r.items.filter((i) => i.name === 'clip-40s-copy.mp4').length === 1, 'exactly one row for the interrupted video');
check(r.unfinished.every((u) => u.name === 'clip-70s-big.mp4'), 'nothing left unfinished for this device except the over-limit 70 MB clip');

await browser.close(); server.close();
log(failures ? failures + ' CHECK(S) FAILED' : 'all checks passed');
process.exit(failures ? 1 : 0);
