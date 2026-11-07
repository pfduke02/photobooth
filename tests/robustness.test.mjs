// Booth robustness: things that go wrong at a real party (a bumped webcam cable, a
// stuck model, a busy camera, a long night of guests) must never leave the booth
// stuck or silently photographing a frozen frame. Simulated camera, mocked Supabase.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let browser, server, sessions;
const origin = 'http://127.0.0.1:18098';
before(async () => {
  sessions = await mkdtemp(path.join(os.tmpdir(), 'pb-robust-test-'));
  server = spawn(process.execPath, ['photobooth-repo/server.mjs'], {
    env: { ...process.env, PORT: '18098', SESSIONS_DIR: sessions }, stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', data => { if (String(data).includes('saves')) resolve(); });
    server.once('exit', code => reject(new Error(`Server exited ${code}`)));
    server.once('error', reject);
  });
  browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
});
after(async () => { await browser?.close(); server?.kill(); await rm(sessions, { recursive: true, force: true }); });

async function booth(t, { init } = {}) {
  const context = await browser.newContext({ permissions: ['camera', 'screen-wake-lock'] });
  context.setDefaultTimeout(20000);
  if (init) await context.addInitScript(init);
  t.after(() => context.close());
  const saves = [];
  await context.route('https://**/*', route => {
    const url = route.request().url();
    if (url.endsWith('/functions/v1/session')) {
      const body = route.request().postDataJSON(); saves.push(body);
      return route.fulfill({ json: { ok: true, id: body.id, strip: `https://example.test/${body.id}/strip.png` } });
    }
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'no uncaught browser errors'));
  await page.goto(`${origin}/?fast=1&collect=cloud`);
  if (!init) await page.waitForFunction(() => window.__PB?.ready);
  const capture = async () => {
    await page.click('#startBtn');
    await page.waitForFunction(() => window.__PB.done);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#startBtn').disabled && !state.busy);
  };
  const unplug = () => page.evaluate(() => {
    const track = state.stream.getVideoTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended'));
  });
  const cameraLive = () => page.evaluate(() => !!state.stream && state.stream.getVideoTracks().some(x => x.readyState === 'live'));
  return { page, saves, capture, unplug, cameraLive };
}

test('an error partway through a session never leaves the booth stuck', async t => {
  const { page, saves, capture } = await booth(t);
  await page.evaluate(() => {
    const real = window.composeStrip; let calls = 0;
    window.composeStrip = (...args) => { if (calls++ === 0) throw new Error('simulated failure'); return real(...args); };
  });
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__PB.sessionErrors === 1);
  await page.waitForFunction(() => !state.busy && !document.querySelector('#startBtn').disabled);
  assert.equal(await page.evaluate(() => document.body.classList.contains('capturing')), false);
  await capture();
  await page.waitForFunction(() => window.__PB.upload?.status === 'saved');
  assert.equal(saves.length, 1);
});

test('an unplugged camera reconnects on its own while the booth is idle', async t => {
  const { page, unplug, cameraLive, capture } = await booth(t);
  await unplug();
  await page.waitForFunction(() => window.__PB.cameraRestarts >= 1);
  await page.waitForFunction(() => state.stream?.getVideoTracks().some(x => x.readyState === 'live') && !document.querySelector('#camError').classList.contains('show'));
  assert.equal(await cameraLive(), true);
  await capture();
});

test('a camera that drops mid-session is reconnected before the next shot', async t => {
  const { page, unplug, cameraLive } = await booth(t);
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__PB.count >= 1);
  await unplug();
  await page.waitForFunction(() => window.__PB.done);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !state.busy && !document.querySelector('#startBtn').disabled);
  assert.equal(await cameraLive(), true);
});

test('a camera busy at startup is retried without anyone tapping Retry', async t => {
  const { page } = await booth(t, { init: () => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); let failures = 2;
    navigator.mediaDevices.getUserMedia = c => failures-- > 0
      ? Promise.reject(Object.assign(new Error('busy'), { name: 'NotReadableError' })) : real(c);
  } });
  await page.waitForFunction(() => document.querySelector('#camError').classList.contains('show'));
  await page.waitForFunction(() => window.__PB?.ready && !document.querySelector('#camError').classList.contains('show'));
});

test('a stuck background model does not freeze the live picture', async t => {
  const { page, capture } = await booth(t);
  assert.equal(await page.evaluate(() => window.__PB.enableAI()), true);
  await page.evaluate(() => { seg.send = () => new Promise(() => {}); });
  const sample = () => page.evaluate(() => {
    const c = document.querySelector('#proc'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let sum = 0; for (let i = 0; i < d.length; i += 4097) sum += d[i]; return sum;
  });
  await page.waitForTimeout(2000); const a = await sample();
  await page.waitForTimeout(1500); const b = await sample();
  assert.notEqual(a, b, 'preview kept updating');
  await page.waitForFunction(() => window.__PB.segResets >= 1, null, { timeout: 15000 });
  await capture();
});

test('the booth asks to keep the screen awake', async t => {
  const { page } = await booth(t);
  await page.waitForFunction(() => !!window.__PB.wakeLock);
});

test('a long night of guests keeps memory bounded (thumbnails, not full strips)', async t => {
  const { page, capture } = await booth(t);
  for (let i = 0; i < 6; i++) await capture();
  await page.waitForFunction(() => memGallery.length === 6 && memGallery.every(x => x.thumb));
  const g = await page.evaluate(() => ({
    full: memGallery.filter(x => x.url).length,
    stored: JSON.parse(localStorage.getItem('photobooth.v0.strips') || '[]'),
  }));
  assert.ok(g.full <= 3, `${g.full} full-size strips held in memory`);
  assert.equal(g.stored.length, 6);
  assert.ok(g.stored.every(x => x.thumb && !x.url), 'only thumbnails are persisted');
});

test('a grainy, busy strip is encoded small enough for the cloud save and the print', async t => {
  const { page } = await booth(t);
  const r = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 3600;
    const ctx = c.getContext('2d'); const img = ctx.createImageData(1200, 3600);
    let seed = 7;
    for (let i = 0; i < img.data.length; i += 4) {
      for (let k = 0; k < 3; k++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; img.data[i + k] = 90 + (seed >>> 26); }
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const png = c.toDataURL('image/png').length;
    const strip = fitDataUrl(c);
    const sheet = await composePrintSheet(strip);
    return { png, strip: strip.length, stripMime: dataUrlMime(strip), sheet: sheet.length };
  });
  assert.ok(r.png > 12_000_000, `test image should be oversized as PNG (${r.png})`);
  assert.equal(r.stripMime, 'image/jpeg');
  assert.ok(r.strip <= 10_500_000, `strip ${r.strip}`);
  assert.ok(r.sheet <= 10_500_000, `print sheet ${r.sheet}`);
});
