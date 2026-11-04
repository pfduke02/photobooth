import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let browser, server, sessions;
const origin = 'http://127.0.0.1:18099';
before(async () => {
  sessions = await mkdtemp(path.join(os.tmpdir(), 'pb-sessions-test-'));
  server = spawn(process.execPath, ['photobooth-repo/server.mjs'], {
    env: { ...process.env, PORT: '18099', SESSIONS_DIR: sessions }, stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', data => { if (String(data).includes('saves')) resolve(); });
    server.once('exit', code => reject(new Error(`Server exited ${code}`)));
    server.once('error', reject);
  });
  browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
});
after(async () => { await browser?.close(); server?.kill(); await rm(sessions, { recursive: true, force: true }); });

async function booth(t, settings = {}) {
  const context = await browser.newContext({ permissions: ['camera'] });
  if (settings.noStorage) await context.addInitScript(() => {
    indexedDB.open = () => { throw new Error('Storage blocked'); };
  });
  t.after(() => context.close());
  const calls = { saves: [], prints: [], failSave: false, failPrint: false, delaySave: null, status: 'pending', ...settings };
  await context.route('https://**/*', async route => {
    const url = route.request().url();
    if (url.endsWith('/functions/v1/session')) {
      const body = route.request().postDataJSON(); calls.saves.push(body);
      if (calls.delaySave) await calls.delaySave;
      if (calls.failSave) return route.fulfill({ status: 503, json: { ok: false, error: 'offline' } });
      return route.fulfill({ json: { ok: true, id: body.id, strip: `https://example.test/${body.id}/strip.png` } });
    }
    if (url.endsWith('/functions/v1/print')) {
      const body = route.request().postDataJSON(); calls.prints.push(body);
      if (calls.failPrint) return route.fulfill({ status: 503, json: { ok: false, error: 'offline' } });
      return route.fulfill({ json: { ok: true, jobId: body.id } });
    }
    if (url.includes('/rest/v1/print_jobs')) return route.fulfill({ json: [{ status: calls.status }] });
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'no uncaught browser errors'));
  const open = async (target = 'cloud') => {
    await page.goto(`${origin}/?fast=1&collect=${target}`);
    await page.waitForFunction(() => window.__PB?.ready);
  };
  const capture = async () => {
    await page.click('#startBtn');
    await page.waitForFunction(() => window.__PB?.done && !!lastSession);
  };
  return { page, calls, open, capture };
}

test('capture saves to Supabase before print; queue is not reported as physical completion', async t => {
  const { page, calls, open, capture } = await booth(t);
  await open(); await capture();
  await page.waitForFunction(() => window.__PB.upload?.status === 'saved');
  await page.click('#printBtn');
  await page.waitForFunction(() => document.querySelector('#printStatus').textContent.includes('waiting for the booth Mac'));
  assert.equal(calls.saves.length, 1); assert.equal(calls.prints.length, 1);
  assert.equal(calls.prints[0].meta.sessionId, calls.saves[0].id);
  assert.match(await page.locator('#uploadStatus').innerText(), /Supabase ✓/);
  assert.equal(await page.locator('#printBtn').isDisabled(), true);
  const dimensions = await page.evaluate(async image => {
    const img = new Image(); img.src = image; await img.decode(); return [img.width, img.height];
  }, calls.prints[0].image);
  assert.deepEqual(dimensions, [2400, 3600]);
  calls.status = 'done';
  await page.waitForFunction(() => document.querySelector('#printStatus').textContent.includes('SELPHY print queue'));
});

test('offline session and print intent survive reload and retry with the same IDs', async t => {
  const { page, calls, open, capture } = await booth(t, { failSave: true });
  await open(); await capture();
  await page.waitForFunction(() => window.__PB.upload?.status === 'failed');
  await page.click('#printBtn');
  await page.waitForFunction(() => document.querySelector('#printBtn').textContent.includes('Retry'));
  const id = calls.saves[0].id;
  const printId = await page.evaluate(() => delivery.records.get(lastSession.id).print.id);
  assert.equal(calls.prints.length, 0, 'do not print an unarchived strip');
  calls.failSave = false;
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#pendingDelivery').textContent === '');
  // Wait for recovery, rather than the initial blank pending indicator.
  await page.waitForFunction(async () => {
    await delivery.ready;
    return [...delivery.records.values()].some(r => r.print?.result?.ok);
  });
  assert.ok(calls.saves.every(s => s.id === id));
  assert.equal(calls.prints.length, 1);
  assert.equal(calls.prints[0].id, printId);
});

test('a lost print response retries only the print with the original ID', async t => {
  const { page, calls, open, capture } = await booth(t, { failPrint: true });
  await open(); await capture();
  await page.waitForFunction(() => window.__PB.upload?.status === 'saved');
  await page.click('#printBtn');
  await page.waitForFunction(() => document.querySelector('#printBtn').textContent.includes('Retry'));
  calls.failPrint = false;
  await page.click('#printBtn');
  await page.waitForFunction(() => document.querySelector('#printBtn').textContent.includes('requested'));
  assert.equal(calls.saves.length, 1);
  assert.equal(calls.prints.length, 2);
  assert.equal(calls.prints[0].id, calls.prints[1].id);
});

test('local success is not cloud success; retry reuses the local session ID', async t => {
  const { page, calls, open, capture } = await booth(t, { failSave: true });
  await open('both'); await capture();
  await page.waitForFunction(() => window.__PB.upload?.status === 'partial');
  const id = calls.saves[0].id;
  assert.equal(await page.evaluate(() => window.__PB.upload.targets.local.id), id);
  const before = (await readdir(sessions)).length;
  calls.failSave = false;
  await page.click('#retryUpload');
  await page.waitForFunction(() => window.__PB.upload?.status === 'saved');
  assert.equal((await readdir(sessions)).length, before);
});

test('late upload from a previous guest cannot replace the current status or QR', async t => {
  const { page, open } = await booth(t);
  await open();
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 10; canvas.height = 30;
    const old = buildSession([canvas], canvas.toDataURL());
    const current = buildSession([canvas], canvas.toDataURL());
    const realFetch = window.fetch;
    let release;
    window.fetch = (url, options) => {
      if (options?.body && JSON.parse(options.body).id === old.id)
        return new Promise(resolve => { release = () => resolve(Response.json({ ok: true, id: old.id, strip: 'https://example.test/old.png' })); });
      return realFetch(url, options);
    };
    const pending = uploadSession(old);
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    await uploadSession(current);
    release(); await pending;
    return { shown: window.__PB.upload.id, expected: current.id };
  });
  assert.equal(result.shown, result.expected);
});

test('an early print click is persisted while the initial archive upload is still running', async t => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const { page, calls, open, capture } = await booth(t, { delaySave: delayed });
  await open(); await capture();
  await page.click('#printBtn');
  await page.waitForFunction(async () => {
    const db = await new Promise(resolve => { const req = indexedDB.open('photobooth-delivery', 1); req.onsuccess = () => resolve(req.result); });
    const records = await new Promise(resolve => { const req = db.transaction('pending').objectStore('pending').getAll(); req.onsuccess = () => resolve(req.result); });
    db.close();
    return records.some(record => record.print?.id);
  });
  assert.equal(calls.prints.length, 0);
  release();
  await page.waitForFunction(() => document.querySelector('#printBtn').textContent.includes('requested'));
  assert.equal(calls.prints.length, 1);
});

test('blocked browser storage shows an honest warning and still permits an online retry', async t => {
  const { page, calls, open, capture } = await booth(t, { noStorage: true, failSave: true });
  await open(); await capture();
  await page.waitForFunction(() => window.__PB.upload?.status === 'failed');
  assert.match(await page.locator('#uploadStatus').innerText(), /Keep this tab open/);
  calls.failSave = false;
  await page.click('#retryUpload');
  await page.waitForFunction(() => window.__PB.upload?.status === 'saved');
  assert.match(await page.locator('#uploadStatus').innerText(), /Supabase ✓/);
});
