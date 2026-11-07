// Two SELPHYs: the printer switch (alternate / only one / pause), skipping a stopped
// printer, steering around a jam, moving stuck sheets, reprints to a chosen printer.
// Fake macOS (lpstat/lp/lpmove/cupsenable) and a fake cloud queue: nothing real prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createWorker } = createRequire(import.meta.url)('../printserver.js');

const A = 'Canon_SELPHY_CP1500', B = 'Canon_SELPHY_CP1500_2';

async function rig(t, { jobs = 4, settings = { printMode: 'alternate' }, controlDown = false } = {}) {
  const spool = await mkdtemp(path.join(os.tmpdir(), 'pb-printers-test-'));
  t.after(() => rm(spool, { recursive: true, force: true }));
  const queue = Array.from({ length: jobs }, (_, i) => ({
    id: `2026-11-07_${String(i + 1).padStart(12, '0')}`, status: 'pending', copies: 1,
    image_path: `prints/${i + 1}.jpg`, meta: {}, created_at: new Date(Date.now() + i).toISOString(),
  }));
  const mac = { [A]: { state: 'idle', queued: [] }, [B]: { state: 'idle', queued: [] }, 'Office_Laser': { state: 'idle', queued: [] } };
  const log = { sent: [], moved: [], resumed: [], beats: [] };
  let n = 100;
  const fetch = async (url, options = {}) => {
    if (url.includes('/storage/')) return new Response('image');
    const params = new URL(url).searchParams;
    if (options.method === 'PATCH') {
      const job = queue.find(j => `eq.${j.id}` === params.get('id'));
      if (!job || `eq.${job.status}` !== params.get('status')) return Response.json([]);
      Object.assign(job, JSON.parse(options.body));
      return Response.json([job]);
    }
    let rows = queue.filter(j => !params.has('status') || `eq.${j.status}` === params.get('status'));
    if (params.has('id')) rows = rows.filter(j => `eq.${j.id}` === params.get('id'));
    return Response.json(rows.slice(0, 1).map(j => ({ ...j })));
  };
  const exec = async (cmd, args) => {
    if (cmd === 'lpstat' && args[0] === '-p') {
      const names = args.length > 1 ? args.slice(1) : Object.keys(mac);
      return names.filter(x => mac[x]).map(x => `printer ${x} ${mac[x].state === 'stopped' ? 'disabled since today -' : mac[x].state === 'printing' ? `now printing ${x}-1.  enabled since today` : 'is idle.  enabled since today'}`).join('\n');
    }
    if (cmd === 'lpstat' && args[0] === '-o') return args.slice(1).flatMap(x => (mac[x]?.queued || []).map(id => `${id}  pete  12345  Sat Nov  7`)).join('\n');
    if (cmd === 'lpmove') {
      const [id, dest] = args; const from = id.replace(/-\d+$/, '');
      mac[from].queued = mac[from].queued.filter(q => q !== id); mac[dest].queued.push(`${dest}-${n++}`);
      log.moved.push([from, dest]); return '';
    }
    if (cmd === 'cupsenable') { mac[args[0]].state = 'idle'; log.resumed.push(args[0]); return ''; }
    throw new Error(`unexpected ${cmd}`);
  };
  const control = async (kind, payload) => {
    if (controlDown) throw new Error('offline');
    if (kind === 'status') { log.beats.push(payload); return { ok: true }; }
    return { ok: true, ...settings };
  };
  const print = async (file, copies, dest) => { log.sent.push(dest); return `request id is ${dest}-${n++}`; };
  return { queue, mac, log, settings, spool, fetchImpl: fetch, execImpl: exec, controlImpl: control, printImpl: print };
}
const drain = async (worker, n) => { for (let i = 0; i < n; i++) await worker.tick(); };

test('alternate mode takes turns between the two SELPHYs (and ignores other printers)', async t => {
  const r = await rig(t);
  const w = createWorker({ ...wOpts(r), printers: [A, B] });
  await drain(w, 4);
  assert.deepEqual(r.log.sent, [A, B, A, B]);
  assert.deepEqual(r.queue.map(j => j.printer), [A, B, A, B]);
  assert.ok(r.queue.every(j => j.status === 'done'));
});

test('without a fixed list the worker finds every SELPHY queue on its own', async t => {
  const r = await rig(t);
  const w = createWorker({ ...wOpts(r), print: undefined });
  const states = await w._states();
  assert.deepEqual(Object.keys(states), [A, B]);
});

test('"only" mode sends every sheet to the chosen printer', async t => {
  const r = await rig(t, { settings: { printMode: 'only', printOnly: B } });
  const w = createWorker({ ...wOpts(r), printers: [A, B] });
  await drain(w, 3);
  assert.deepEqual(r.log.sent, [B, B, B]);
});

test('pause leaves jobs waiting in the cloud queue', async t => {
  const r = await rig(t, { settings: { printMode: 'pause' } });
  const w = createWorker({ ...wOpts(r), printers: [A, B] });
  await drain(w, 3);
  assert.deepEqual(r.log.sent, []);
  assert.ok(r.queue.every(j => j.status === 'pending'));
  r.settings.printMode = 'alternate';
  await new Promise(res => setTimeout(res, 2600));   // the switch is re-read every few seconds
  await drain(w, 1);
  assert.equal(r.log.sent.length, 1);
});

test('a printer macOS has stopped (jam, paper, ink) is skipped', async t => {
  const r = await rig(t);
  r.mac[A].state = 'stopped';
  const w = createWorker({ ...wOpts(r), printers: [A, B] });
  await drain(w, 3);
  assert.deepEqual(r.log.sent, [B, B, B]);
});

test('a printer with sheets piling up gets the next job less often', async t => {
  const r = await rig(t);
  r.mac[A].queued = [`${A}-1`, `${A}-2`];
  const w = createWorker({ ...wOpts(r), printers: [A, B] });
  await drain(w, 1);
  assert.deepEqual(r.log.sent, [B]);
});

test('sheets stuck on a stopped printer are moved to the working one', async t => {
  const r = await rig(t, { jobs: 0 });
  r.mac[A].state = 'stopped'; r.mac[A].queued = [`${A}-7`, `${A}-8`];
  const w = createWorker({ ...wOpts(r), printers: [A, B] });
  await w.tick();
  assert.deepEqual(r.log.moved, [[A, B], [A, B]]);
  assert.equal(r.mac[A].queued.length, 0);
  assert.equal(r.mac[B].queued.length, 2);
});

test('switching to "only B" moves sheets still waiting on A', async t => {
  const r = await rig(t, { jobs: 0, settings: { printMode: 'only', printOnly: B } });
  r.mac[A].queued = [`${A}-3`];
  const w = createWorker({ ...wOpts(r), printers: [A, B] });
  await w.tick();
  assert.deepEqual(r.log.moved, [[A, B]]);
});

test('a reprint aimed at a printer goes to that printer', async t => {
  const r = await rig(t, { jobs: 2 });
  r.queue[0].meta = { printer: B };
  const w = createWorker({ ...wOpts(r), printers: [A, B] });
  await drain(w, 1);
  assert.deepEqual(r.log.sent, [B]);
});

test('if the printer switch is unreachable it keeps printing (alternate)', async t => {
  const r = await rig(t, { controlDown: true });
  const w = createWorker({ ...wOpts(r), printers: [A, B] });
  await drain(w, 2);
  assert.deepEqual(r.log.sent, [A, B]);
});

test('status reports reach the admin page and a resume request restarts a stopped printer', async t => {
  const r = await rig(t, { jobs: 1, settings: { printMode: 'alternate', resume: { seq: 1, printers: [A], at: new Date().toISOString() } } });
  r.mac[A].state = 'stopped';
  const w = createWorker({ ...wOpts(r), printers: [A, B] });
  await w.tick();
  assert.deepEqual(r.log.resumed, [A]);
  r.mac[A].state = 'stopped';                     // stops again later: no automatic re-resume
  await new Promise(res => setTimeout(res, 2600)); await w.tick();
  assert.deepEqual(r.log.resumed, [A]);
  assert.equal(r.log.beats.length, 1);
  assert.deepEqual(r.log.beats[0].printers.map(p => p.name), [A, B]);
});

function wOpts(r) {
  return {
    url: 'https://example.test', spool: r.spool, log: () => {},
    fetch: r.fetchImpl, exec: r.execImpl, control: r.controlImpl, print: r.printImpl,
  };
}
