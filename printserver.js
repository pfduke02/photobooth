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
    return response.json();
  }
  async function reconcile() {
    for (const file of await fs.readdir(spool)) {
      if (!file.endsWith('.receipt.json')) continue;
      const receipt = JSON.parse(await fs.readFile(path.join(spool, file), 'utf8'));
      // Retry the cloud acknowledgement, never the physical lp command.
      await patch(receipt.id, { status: 'done', printed_at: receipt.acceptedAt, error: null }, 'printing');
      await fs.unlink(path.join(spool, file));
      log(`job ${receipt.id} acknowledged: ${receipt.output}`);
    }
  }
  async function tick() {
    await fs.mkdir(spool, { recursive: true });
    if (!dryRun) await reconcile();
    const response = await request(`${rest}?status=eq.pending&order=created_at.asc&limit=1`, { headers });
    const job = (await response.json())[0];
    if (!job) return false;
    if (!/^\d{4}-\d{2}-\d{2}_[0-9a-f]{6,12}$/.test(job.id)) throw new Error('Invalid print job id');
    if (!Number.isInteger(job.copies) || job.copies < 1 || job.copies > 10) throw new Error('Invalid copy count');
    if (!dryRun) {
      // Compare-and-set: only the worker that claims a pending row may print it.
      const claimed = await patch(job.id, { status: 'printing', error: null }, 'pending');
      if (!claimed.length) return false;
    }
    const extension = /\.(png|jpe?g)$/.exec(job.image_path)?.[0] || '.png';
    const file = path.join(spool, `${job.id}${extension}`);
    let output;
    try {
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
  const worker = createWorker();
  const pollMs = Number(process.env.POLL_MS || 3000);
  console.log('Photobooth print worker started. done = accepted by macOS, not physical completion.');
  (async () => {
    for (;;) {
      try { await worker.tick(); } catch (error) { console.error('Print worker:', error.message || error); }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  })();
}
module.exports = { createWorker };
