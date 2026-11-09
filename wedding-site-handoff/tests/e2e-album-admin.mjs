// End-to-end for the album and admin pages (bundle copies, API swapped to the staging slug),
// against the demo event. Expects uploads from e2e-guest.mjs / smoke-api.mjs to exist and the
// public ones to be approved (done by SQL before this runs). OWNER = the demo event's owner key.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const S = path.resolve(import.meta.dirname, '..');
const EVENT = process.env.EVENT || '12d4d64f73d342f2865aaa28';
const OWNER = process.env.OWNER || '';
const API = process.env.API || 'https://hseupjbneifqxaykxltt.supabase.co/functions/v1/api-next';
const LIVE_API = 'https://hseupjbneifqxaykxltt.supabase.co/functions/v1/api';
const out = path.join(S, 'tests', 'out'); fs.mkdirSync(out, { recursive: true });
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
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 900 }, deviceScaleFactor: 1 });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const check = (cond, msg) => { if (cond) log('  ✓', msg); else { failures++; log('  ✗', msg); } };
const wire = (page) => {
  page.on('pageerror', (e) => log('  [pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('  [console.error]', m.text().slice(0, 200)); });
};

// approve the test uploads so the album has something to show (the server refuses the private ones)
if (OWNER) {
  const call = async (body) => (await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ e: EVENT, owner: OWNER, ...body }) })).json();
  const g = await call({ action: 'gallery', filter: 'unapproved', limit: 500 });
  const ids = (g.items || []).filter((i) => /^(E2E Test|Smoke Test)$/.test(i.contributor)).map((i) => i.uploadId);
  if (ids.length) { const a = await call({ action: 'approve', uploadIds: ids, approved: true }); log('approved', (a.uploadIds || []).length, 'test uploads for the album'); }
}

// ---------- album ----------
log('album page');
let page = await ctx.newPage(); wire(page);
await page.goto(base + '/photos/album/?e=' + EVENT);
await page.waitForFunction(() => document.querySelectorAll('#grid .tile').length > 0 || !document.getElementById('msg').hidden, null, { timeout: 30000 });
const count = await page.textContent('#count');
log('  count:', count);
check(/video/.test(count), 'count mentions videos');
const tiles = await page.$$eval('#grid .tile', (t) => t.map((x) => ({ label: x.getAttribute('aria-label'), play: x.querySelector('.play')?.textContent || null, img: !!x.querySelector('img'), vph: !!x.querySelector('.vph') })));
log('  tiles:', JSON.stringify(tiles.slice(0, 12)));
const vid = tiles.findIndex((t) => t.play);
check(vid >= 0, 'a video tile with a play badge is in the album');
check(!tiles.some((t) => /private|family/i.test(t.label || '')), 'no private item in the album');
if (vid >= 0) {
  await page.click(`#grid .tile >> nth=${vid}`);
  await page.waitForSelector('#lb[open]');
  const v = await page.$eval('#lbVid', (e) => ({ hidden: e.hidden, src: e.currentSrc || e.src, poster: e.poster }));
  const imgHidden = await page.$eval('#lbImg', (e) => e.hidden);
  log('  lightbox video:', JSON.stringify({ hidden: v.hidden, hasSrc: !!v.src, hasPoster: !!v.poster, imgHidden }));
  check(!v.hidden && !!v.src && imgHidden, 'lightbox shows a <video> with a source for a video item');
  check(/\d+:\d\d/.test(await page.textContent('#lbCaption')), 'caption carries the duration');
  check(/download=/.test(await page.getAttribute('#lbDownload', 'href')), 'download link present');
  await page.screenshot({ path: path.join(out, 'album-video.png') });
  // step to a neighbour and back: photo shows an <img>, video element paused/hidden
  await page.click('#next');
  await page.waitForTimeout(300);
  const after = await page.$eval('#lbVid', (e) => e.hidden) ;
  log('  after next: video hidden =', after);
  await page.keyboard.press('Escape');
}
await page.screenshot({ path: path.join(out, 'album.png'), fullPage: true });
await page.close();

// ---------- admin ----------
if (!OWNER) { log('admin page: OWNER not set, skipping'); }
else {
  log('admin page');
  page = await ctx.newPage(); wire(page);
  await page.goto(base + '/photos/admin/?e=' + EVENT + '#k=' + OWNER);
  await page.waitForFunction(() => document.querySelectorAll('#stats .stat').length > 0 || document.querySelector('#app .msg'), null, { timeout: 30000 });
  const stats = await page.$$eval('#stats .stat', (s) => s.map((x) => x.querySelector('span').textContent + '=' + x.querySelector('b').textContent));
  log('  stats:', JSON.stringify(stats));
  check(stats.some((s) => s.startsWith('videos=')), 'videos stat present');
  check(stats.some((s) => s.startsWith('family only=')), 'family-only stat present');
  await page.waitForFunction(() => document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 30000 });
  const all = await page.$$eval('#grid .tile', (t) => t.map((x) => (x.querySelector('.tags')?.textContent || '') + ' | ' + x.querySelector('.open').getAttribute('aria-label')));
  log('  all (first 8):', JSON.stringify(all.slice(0, 8)));
  check(all.some((s) => /▶/.test(s)), 'video tag on video tiles');
  check(all.some((s) => /Family only/.test(s)), 'family-only tag on private tiles');
  // switching a filter: wait for that filter's answer, then for the grid to redraw
  const switchFilter = async (v) => {
    const resp = page.waitForResponse((r) => r.url().startsWith(API) && (r.request().postData() || '').includes('"filter":"' + v + '"'), { timeout: 30000 });
    await page.selectOption('#filter', v); await resp; await page.waitForTimeout(400);
  };
  // Videos filter
  await switchFilter('videos');
  await page.waitForFunction(() => [...document.querySelectorAll('#grid .tile')].every((t) => /▶/.test(t.querySelector('.tags')?.textContent || '')) && document.querySelectorAll('#grid .tile').length > 0, null, { timeout: 30000 });
  log('  videos filter:', await page.$$eval('#grid .tile', (t) => t.length), 'tiles');
  check(true, 'videos filter shows only videos');
  // Private filter + lightbox
  await switchFilter('private');
  const priv = await page.$$eval('#grid .tile', (t) => t.map((x) => x.querySelector('.tags')?.textContent || ''));
  log('  private filter:', JSON.stringify(priv));
  check(priv.every((s) => /Family only/.test(s)), 'private filter shows only family-only items');
  await page.click('#grid .tile .open >> nth=0');
  await page.waitForSelector('#lb[open]');
  const ab = await page.$eval('#lbAlbum', (b) => ({ disabled: b.disabled, text: b.textContent }));
  log('  lightbox album button:', JSON.stringify(ab), '| who:', await page.textContent('#lbWho'));
  check(ab.disabled && /Family only/.test(ab.text), 'private item cannot be added to the album');
  check(!(await page.$eval('#lbPriv', (e) => e.hidden)), 'private note shown');
  const isVideoOpen = !(await page.$eval('#lbVid', (e) => e.hidden));
  log('  opened item is a video:', isVideoOpen);
  await page.screenshot({ path: path.join(out, 'admin-private.png') });
  await page.keyboard.press('Escape');
  // approve a private item through the API must be refused
  const r = await page.evaluate(async ({ api, e, owner }) => {
    const g = await (await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ e, owner, action: 'gallery', filter: 'private', limit: 5 }) })).json();
    const ids = (g.items || []).map((i) => i.uploadId);
    const a = await (await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ e, owner, action: 'approve', uploadIds: ids, approved: true }) })).json();
    return { ids, approved: a.uploadIds, skipped: a.skipped };
  }, { api: API, e: EVENT, owner: OWNER });
  log('  approve private via API:', JSON.stringify(r));
  check(r.ids.length > 0 && r.approved.length === 0 && r.skipped.length === r.ids.length, 'server refuses to approve private items');
  // video links section
  await switchFilter('all');
  const vids = await page.$eval('#vids', (s) => ({ hidden: s.hidden, links: [...s.querySelectorAll('a')].map((a) => a.href) }));
  log('  video links section:', JSON.stringify(vids));
  check(!vids.hidden && vids.links.some((l) => /icloud/.test(l)), 'pasted video link is listed for admins');
  await page.screenshot({ path: path.join(out, 'admin.png'), fullPage: true });
  await page.close();
}

await browser.close(); server.close();
log(failures ? failures + ' CHECK(S) FAILED' : 'all checks passed');
process.exit(failures ? 1 : 0);
