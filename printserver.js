#!/usr/bin/env node
// On-site Mac worker: cloud queue → local spool file → SELPHY via lp.
// DRY_RUN=1 only reads/downloads; it never consumes or acknowledges a job.
'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xjnqnxorqhobikyzshrt.supabase.co';
const ANON_KEY = process.env.ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqbnFueG9ycWhvYmlreXpzaHJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0NDkyMjUsImV4cCI6MjEwMDAyNTIyNX0.ihY85rnHCWyg7MknipFU9_bI2syCPYbwpQurVIe0scA';

function createWorker(options = {}) {
  const jobId = options.jobId || process.env.PRINT_JOB_ID;
  const validId = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}_[0-9a-f]{6,12}$/.test(value);
  if (jobId && !validId(jobId)) throw new Error('Invalid selected print job id');
  const base = options.url || SUPABASE_URL;
  const apiKey = options.apiKey || ANON_KEY;
  const fetcher = options.fetch || fetch;
  const printer = options.printer || process.env.PRINTER || 'Canon_SELPHY_CP1500';
  const lpOptions = (process.env.LP_OPTS || 'media=Postcard.Fullbleed').split(/\s+/).filter(Boolean);
  const dryRun = options.dryRun ?? (process.env.DRY_RUN === '1');
  const spool = options.spool || process.env.PRINT_SPOOL_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Photobooth', 'print-spool');
  const log = options.log || ((...args) => console.log(new Date().toLocaleTimeString(), ...args));
  const headers = { apikey: apiKey, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const rest = `${base}/rest/v1/print_jobs`;
  const print = options.print || ((file, copies) => new Promise((resolve, reject) => {
    const args = ['-d', printer, '-n', String(copies)];
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
  async function tick() {
    await fs.mkdir(spool, { recursive: true });
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
    if (!dryRun) {
      // Compare-and-set: only the worker that claims a pending row may print it.
      const claimed = await patch(job.id, { status: 'printing', error: null }, 'pending');
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
      if (dryRun) { log(`DRY_RUN: would print ${job.copies} sheet(s) to ${printer}; job ${job.id} unchanged`); return true; }
      output = await print(file, job.copies);
    } catch (error) {
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
  return { tick };
}

if (require.main === module) {
  const once = process.argv.includes('--once');
  if (once && !process.env.PRINT_JOB_ID) {
    console.error('--once requires PRINT_JOB_ID so a controlled test cannot consume another guest\'s job.');
    process.exit(1);
  }
  const worker = createWorker();
  const pollMs = Number(process.env.POLL_MS || 3000);
  console.log('Photobooth print worker started. done = accepted by macOS, not physical completion.');
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
