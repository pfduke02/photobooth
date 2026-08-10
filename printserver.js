#!/usr/bin/env node
// Lisa & Pete photobooth — Mac print server.
// Polls the Supabase print queue and prints each 4x6 sheet to the Selphy via `lp`.
//   Setup:  add the Selphy in System Settings > Printers, then `lpstat -p` for its name.
//   Run:    PRINTER="Canon_SELPHY_CP1500" node printserver.js     (or edit PRINTER below)
//   Test:   DRY_RUN=1 node printserver.js                         (polls + downloads, no printing)
//   Stop:   Ctrl-C
'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- config ----------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xjnqnxorqhobikyzshrt.supabase.co';
const ANON_KEY = process.env.ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqbnFueG9ycWhvYmlreXpzaHJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0NDkyMjUsImV4cCI6MjEwMDAyNTIyNX0.ihY85rnHCWyg7MknipFU9_bI2syCPYbwpQurVIe0scA';
const PRINTER = process.env.PRINTER || 'Canon_SELPHY_CP1500';                 // <-- set to your Selphy's lp name (see: lpstat -p)
const LP_OPTS = (process.env.LP_OPTS || 'media=Postcard.Fullbleed').split(/\s+/).filter(Boolean);
const POLL_MS = Number(process.env.POLL_MS || 3000);
const DRY_RUN = process.env.DRY_RUN === '1';
// ----------------------------------------------------------------------------

const REST = `${SUPABASE_URL}/rest/v1/print_jobs`;
const H = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' };
const TMP = path.join(os.tmpdir(), 'photobooth-prints');
fs.mkdirSync(TMP, { recursive: true });
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll() {
  const r = await fetch(`${REST}?status=eq.pending&order=created_at.asc&limit=1`, { headers: H });
  if (!r.ok) throw new Error(`poll ${r.status} ${await r.text()}`);
  return (await r.json())[0] || null;
}
async function patch(id, fields) {
  const r = await fetch(`${REST}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(fields) });
  if (!r.ok) log('WARN patch', id, r.status, await r.text());
}
async function download(imagePath) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/public/sessions/${imagePath}`);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const file = path.join(TMP, imagePath.replace(/[^\w.-]/g, '_'));
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  return file;
}
function lpPrint(file, copies) {
  return new Promise((resolve, reject) => {
    const args = ['-d', PRINTER, '-n', String(copies || 1)];
    for (const o of LP_OPTS) args.push('-o', o);
    args.push(file);
    if (DRY_RUN) { log('DRY_RUN lp', args.join(' ')); return resolve('(dry-run)'); }
    execFile('lp', args, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));
  });
}

process.on('SIGINT', () => { log('stopping...'); process.exit(0); });

(async function main() {
  log('print server up.');
  log(`queue: ${REST}`);
  log(PRINTER ? `printer: ${PRINTER}   opts: ${LP_OPTS.join(' ')}` : 'printer: NOT SET');
  for (;;) {
    if (!PRINTER && !DRY_RUN) { log('PRINTER not set - see: lpstat -p, then re-run with PRINTER="...". Idling.'); await sleep(5000); continue; }
    try {
      const job = await poll();
      if (job) {
        log(`job ${job.id} -> printing ${job.copies}x`);
        await patch(job.id, { status: 'printing' });
        try {
          const file = await download(job.image_path);
          const out = await lpPrint(file, job.copies);
          await patch(job.id, { status: 'done', printed_at: new Date().toISOString(), error: null });
          log(`job ${job.id} OK ${out}`);
        } catch (e) {
          await patch(job.id, { status: 'error', error: String(e.message || e) });
          log(`job ${job.id} FAIL ${e.message || e}`);
        }
        continue;
      }
    } catch (e) { log('poll error:', e.message || e); }
    await sleep(POLL_MS);
  }
})();
