#!/usr/bin/env node
// On-site Mac worker: cloud queue → local spool file → SELPHY via lp.
// DRY_RUN=1 only reads/downloads; it never consumes or acknowledges a job.
//
// Two SELPHYs: the worker finds every macOS print queue whose name contains
// "SELPHY" (or uses PRINTERS=a,b). The printer switch on the wedding admin page
// (sternfishmanwedding.com/photos/admin) picks the mode, read before every job:
//   alternate — each sheet goes to the less busy printer, taking turns on a tie
//   only      — every sheet goes to one named printer
//   pause     — jobs wait in the cloud queue; nothing is sent
// A printer macOS has stopped (jam, out of paper/ink, unreachable) is skipped,
// and sheets still waiting in a switched-off or stopped printer's macOS queue
// are moved to a working one with lpmove. Status is reported back to the admin
// page every ~15 s. Without the cloud switch it alternates over what it found.
'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xjnqnxorqhobikyzshrt.supabase.co';
const CONTROL_URL = process.env.CONTROL_URL || 'https://hseupjbneifqxaykxltt.supabase.co/functions/v1/api';
const CONTROL_EVENT = process.env.CONTROL_EVENT || 'bf4d479a7b1c16d5b088ede0';
const WORKER_KEY = 'lp1107-54db1816';
const VERSION = '3.0';
const ANON_KEY = process.env.ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqbnFueG9ycWhvYmlreXpzaHJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0NDkyMjUsImV4cCI6MjEwMDAyNTIyNX0.ihY85rnHCWyg7MknipFU9_bI2syCPYbwpQurVIe0scA';

function createWorker(options = {}) {
  const jobId = options.jobId || process.env.PRINT_JOB_ID;
  const validId = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}_[0-9a-f]{6,12}$/.test(value);
  if (jobId && !validId(jobId)) throw new Error('Invalid selected print job id');
  const base = options.url || SUPABASE_URL;
  const apiKey = options.apiKey || ANON_KEY;
  const fetcher = options.fetch || fetch;
  const printer = options.printer || process.env.PRINTER || 'Canon_SELPHY_CP1500';
  const run = options.exec || ((cmd, args) => new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 15000 }, (error, stdout, stderr) =>
      error ? reject(new Error((stderr || error.message).trim())) : resolve(String(stdout)))));
  // Tests that inject fetch/print stay single-printer and offline unless they opt in.
  const fixedPrinters = options.printers || (process.env.PRINTERS ? process.env.PRINTERS.split(',').map(x => x.trim()).filter(Boolean) : null);
  const detect = !fixedPrinters && !options.print;
  const control = options.control !== undefined ? options.control : (options.fetch ? null : defaultControl);
  const lpOptions = (process.env.LP_OPTS || 'media=Postcard.Fullbleed').split(/\s+/).filter(Boolean);
  const dryRun = options.dryRun ?? (process.env.DRY_RUN === '1');
  const spool = options.spool || process.env.PRINT_SPOOL_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Photobooth', 'print-spool');
  const log = options.log || ((...args) => console.log(new Date().toLocaleTimeString(), ...args));
  const headers = { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const rest = `${base}/rest/v1/print_jobs`;
  const print = options.print || ((file, copies, dest) => new Promise((resolve, reject) => {
    const args = ['-d', dest || printer, '-n', String(copies)];
    for (const option of lpOptions) args.push('-o', option);
    args.push(file);
    execFile('lp', args, { timeout: 30000 }, (error, stdout, stderr) =>
      error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout.trim()));
  }));
  async function request(url, options = {}) {
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return response;
  }
  async function patch(id, fields, status) {
    const response = await request(`${rest}?id=eq.${encodeURIComponent(id)}&status=eq.${status}`, {
      method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(fields),
    });
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid queue acknowledgement');
    return rows;
  }
  async function reconcile() {
    for (const file of await fs.readdir(spool)) {
      if (!file.endsWith('.receipt.json')) continue;
      if (jobId && file !== `${jobId}.receipt.json`) continue;
      let receipt;
      try { receipt = JSON.parse(await fs.readFile(path.join(spool, file), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!validId(receipt.id) || file !== `${receipt.id}.receipt.json` || !Number.isFinite(Date.parse(receipt.acceptedAt)))
        throw new Error(`Invalid local print receipt ${file}; host attention required`);
      // Retry the cloud acknowledgement, never the physical lp command.
      const updated = await patch(receipt.id, { status: 'done', printed_at: receipt.acceptedAt, error: null }, 'printing');
      if (!updated.length) {
        const response = await request(`${rest}?id=eq.${encodeURIComponent(receipt.id)}&select=id,status`, { headers });
        const current = (await response.json())[0];
        if (current?.id !== receipt.id || current.status !== 'done')
          throw new Error(`Print receipt ${receipt.id} could not be acknowledged; host attention required. Do not reprint this job.`);
      }
      const submittedPath = path.join(spool, `${receipt.id}.submitted.json`);
      try { await fs.rename(path.join(spool, file), submittedPath); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Another worker may have acknowledged this same receipt concurrently.
        const submitted = JSON.parse(await fs.readFile(submittedPath, 'utf8'));
        if (submitted.id !== receipt.id || submitted.acceptedAt !== receipt.acceptedAt) throw error;
      }
      log(`job ${receipt.id} acknowledged: ${receipt.output}`);
    }
  }
  // ---------- printers: discovery, health, choice ----------
  let known = fixedPrinters || [printer], detectedAt = 0, turn = 0;
  let settings = { mode: 'alternate', only: null, resume: [] }, settingsAt = 0, resumeDone = 0;
  const lastSent = {};
  let lastError = null, lastBeat = 0, moved = [];
  async function printerStates() {
    // { name: { state: idle|printing|stopped|unknown, queued: [jobIds] } }
    const states = {};
    if (detect && Date.now() - detectedAt > 60000) {
      try {
        const found = (await run('lpstat', ['-p'])).split('\n')
          .map(line => /^printer (\S+) /.exec(line)?.[1]).filter(name => name && /selphy/i.test(name)).sort();
        if (found.length) known = found;
      } catch { /* keep the last list */ }
      detectedAt = Date.now();
    }
    for (const name of known) states[name] = { state: 'unknown', queued: [] };
    try {
      for (const line of (await run('lpstat', ['-p', ...known])).split('\n')) {
        const m = /^printer (\S+) (is idle|now printing|disabled)/.exec(line);
        if (m && states[m[1]]) states[m[1]].state = m[2] === 'disabled' ? 'stopped' : m[2] === 'is idle' ? 'idle' : 'printing';
      }
      for (const line of (await run('lpstat', ['-o', ...known])).split('\n')) {
        const id = line.split(/\s+/)[0]; const queue = id && id.replace(/-\d+$/, '');
        if (queue && states[queue]) states[queue].queued.push(id);
      }
    } catch { /* lpstat unavailable: treat as unknown, still usable */ }
    return states;
  }
  async function readSettings() {
    if (!control) return settings;
    if (Date.now() - settingsAt < 2500) return settings;
    try {
      const s = await control('config');
      if (s && ['alternate', 'only', 'pause'].includes(s.printMode))
        settings = { mode: s.printMode, only: s.printOnly || null,
          // a one-shot "resume printer" press from the admin page: applied once, ignored after 5 minutes
          resume: (s.resume && Number(s.resume.seq) > resumeDone && Date.now() - Date.parse(s.resume.at) < 300000)
            ? { seq: Number(s.resume.seq), printers: Array.isArray(s.resume.printers) ? s.resume.printers : [] } : null };
      settingsAt = Date.now();
    } catch (error) { lastError = 'printer switch unreachable: ' + (error.message || error); }
    return settings;
  }
  function allowed(states, mode, only) {
    if (mode === 'only' && only) return [only];
    return Object.keys(states);
  }
  function choose(states, job, mode, only) {
    const names = allowed(states, mode, only);
    const want = job?.meta?.printer;
    if (want && names.includes(want) && states[want]?.state !== 'stopped') return want;
    const healthy = names.filter(name => states[name]?.state !== 'stopped');
    const pool = healthy.length ? healthy : names;
    if (pool.length === 1) return pool[0];
    // Least busy first (a jammed printer piles up), then take turns.
    const load = name => (states[name]?.queued.length || 0) + (states[name]?.state === 'printing' ? 1 : 0);
    const min = Math.min(...pool.map(load));
    const tied = pool.filter(name => load(name) === min);
    const pick = tied[turn % tied.length]; turn++;
    return pick;
  }
  async function rebalance(states, mode, only) {
    if (mode === 'pause' || dryRun) return;
    const names = allowed(states, mode, only);
    const targets = names.filter(name => states[name] && states[name].state !== 'stopped');
    if (!targets.length) return;
    for (const [name, st] of Object.entries(states)) {
      if (!st.queued.length) continue;
      const off = !names.includes(name) || st.state === 'stopped';
      if (!off) continue;
      for (const id of st.queued) {
        const dest = targets.filter(t => t !== name)[0]; if (!dest) break;
        try { await run('lpmove', [id, dest]); moved.push({ id, from: name, to: dest, at: new Date().toISOString() }); log(`moved ${id} from ${name} to ${dest}`); }
        catch (error) { lastError = `could not move ${id} off ${name}: ${error.message || error}`; }
      }
    }
    moved = moved.slice(-20);
  }
  async function resumeRequested(states, list) {
    for (const name of list) {
      if (!states[name] || states[name].state !== 'stopped') continue;
      try { await run('cupsenable', [name]); log(`resumed ${name}`); }
      catch (error) { lastError = `could not resume ${name}: ${error.message || error}`; }
    }
  }
  async function heartbeat(states, mode, only) {
    if (!control || Date.now() - lastBeat < 15000) return;
    lastBeat = Date.now();
    try {
      await control('status', { version: VERSION, host: os.hostname(), mode, only, lastError, moved,
        printers: Object.entries(states).map(([name, st]) => ({ name, state: st.state, queued: st.queued.length, lastSentAt: lastSent[name] || null })) });
    } catch { /* the admin page just shows the last report */ }
  }
  async function status() { const st = await printerStates(); const s = await readSettings(); return { states: st, settings: s }; }

  async function tick() {
    await fs.mkdir(spool, { recursive: true });
    const states = await printerStates();
    const { mode, only, resume } = await readSettings();
    if (resume && resume.seq > resumeDone) { resumeDone = resume.seq; await resumeRequested(states, resume.printers); }
    await rebalance(states, mode, only);
    await heartbeat(states, mode, only);
    if (mode === 'pause' && !jobId) { if (!dryRun) await reconcile(); return false; }
    if (!dryRun) await reconcile();
    const selection = jobId ? `&id=eq.${encodeURIComponent(jobId)}` : '';
    const response = await request(`${rest}?status=eq.pending${selection}&order=created_at.asc&limit=1`, { headers });
    let job = (await response.json())[0];
    if (!job) return false;
    if (!validId(job.id) || (jobId && job.id !== jobId)) throw new Error('Invalid print job id');
    if (!dryRun) {
      const submitted = await fs.access(path.join(spool, `${job.id}.submitted.json`)).then(() => true, () => false);
      if (submitted) throw new Error(`Job ${job.id} already has a local submission receipt; host attention required. Use a new job ID for an intentional reprint.`);
    }
    const dest = choose(states, job, mode, only);
    if (!dryRun) {
      // Compare-and-set: only the worker that claims a pending row may print it.
      const claimed = await patch(job.id, { status: 'printing', error: null, printer: dest }, 'pending');
      if (!claimed.length) return false;
      // Use the claimed row, not a possibly stale pre-claim copy/path.
      job = claimed[0];
    }
    let output, file;
    try {
      if (!Number.isInteger(job.copies) || job.copies < 1 || job.copies > 10) throw new Error('Invalid copy count');
      if (typeof job.image_path !== 'string' || !/^prints\/.+\.(png|jpe?g)$/.test(job.image_path) ||
        job.image_path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid print image path');
      const extension = /\.(png|jpe?g)$/.exec(job.image_path)[0];
      file = path.join(spool, `${job.id}${extension}`);
      const imagePath = job.image_path.split('/').map(encodeURIComponent).join('/');
      const image = await request(`${base}/storage/v1/object/public/sessions/${imagePath}`);
      await fs.writeFile(file, Buffer.from(await image.arrayBuffer()));
      if (dryRun) { log(`DRY_RUN: would print ${job.copies} sheet(s) to ${dest}; job ${job.id} unchanged`); return true; }
      output = await print(file, job.copies, dest);
      lastSent[dest] = new Date().toISOString();
      log(`job ${job.id} sent to ${dest}`);
    } catch (error) {
      lastError = `job ${job.id}: ${error.message || error}`;
      if (!dryRun) await patch(job.id, { status: 'error', error: String(error.message || error) }, 'printing');
      throw error;
    }
    // If anything fails AFTER lp accepts the sheet, leave the job claimed.
    // A durable receipt lets a restart acknowledge it without printing twice.
    const receipt = { id: job.id, acceptedAt: new Date().toISOString(), output };
    const receiptPath = path.join(spool, `${job.id}.receipt.json`);
    await fs.writeFile(receiptPath + '.tmp', JSON.stringify(receipt));
    await fs.rename(receiptPath + '.tmp', receiptPath);
    await reconcile();
    await fs.unlink(file).catch(() => {});
    return true;
  }
  return { tick, status, choose, _states: printerStates };
}

// The printer switch lives with the wedding admin page (same 6 personal links).
async function defaultControl(kind, payload) {
  const body = { e: CONTROL_EVENT, action: 'booth_config', workerKey: WORKER_KEY };
  if (kind === 'status') body.worker = payload;
  const response = await fetch(CONTROL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

if (require.main === module) {
  const once = process.argv.includes('--once');
  if (once && !process.env.PRINT_JOB_ID) {
    console.error('--once requires PRINT_JOB_ID so a controlled test cannot consume another guest\'s job.');
    process.exit(1);
  }
  const worker = createWorker();
  const pollMs = Number(process.env.POLL_MS || 3000);
  console.log(`Photobooth print worker ${VERSION} started. done = accepted by macOS, not physical completion.`);
  (async () => {
    if (once) {
      try {
        const found = await worker.tick();
        if (!found) { console.log('Selected job is not pending; nothing submitted.'); process.exitCode = 2; }
      } catch (error) { console.error('Print worker:', error.message || error); process.exitCode = 1; }
      return;
    }
    for (;;) {
      try { await worker.tick(); } catch (error) { console.error('Print worker:', error.message || error); }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  })();
}
module.exports = { createWorker };
