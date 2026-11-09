// Download every photobooth strip from the cloud into a folder (default: ~/Downloads/LisaPete-photobooth-strips).
// Needs only Node 18+. Safe to run again: strips already downloaded are skipped.
//   curl -fsSL https://raw.githubusercontent.com/pfduke02/photobooth/main/download-strips.mjs -o /tmp/strips.mjs && node /tmp/strips.mjs
// Options: node strips.mjs [folder] [--from=2026-11-07] [--frames]   (--frames also saves each strip's single photos)
import { mkdir, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SB = 'https://xjnqnxorqhobikyzshrt.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqbnFueG9ycWhvYmlreXpzaHJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0NDkyMjUsImV4cCI6MjEwMDAyNTIyNX0.ihY85rnHCWyg7MknipFU9_bI2syCPYbwpQurVIe0scA';
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) || path.join(os.homedir(), 'Downloads', 'LisaPete-photobooth-strips');
const from = (args.find((a) => a.startsWith('--from=')) || '').slice(7);
const frames = args.includes('--frames');
const limit = Number((args.find((a) => a.startsWith('--limit=')) || '').slice(8)) || Infinity;
const headers = { apikey: ANON, Authorization: `Bearer ${ANON}` };
const exists = (p) => access(p).then(() => true, () => false);
const stamp = (iso) => {   // local time, sortable: 2026-11-07_21-39-05
  const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

const rows = [];
for (let offset = 0; ; offset += 1000) {
  const q = `${SB}/rest/v1/sessions?select=id,created_at,strip_path,frame_paths&order=created_at.asc&offset=${offset}&limit=1000` +
    (from ? `&created_at=gte.${encodeURIComponent(from)}` : '');
  const r = await fetch(q, { headers });
  if (!r.ok) throw new Error(`Could not list strips (HTTP ${r.status}). Check the internet connection.`);
  const page = await r.json(); rows.push(...page);
  if (page.length < 1000) break;
}
await mkdir(dir, { recursive: true });
console.log(`${rows.length} booth sessions${from ? ' since ' + from : ''} → ${dir}`);
let got = 0, skipped = 0, failed = 0, n = 0;
for (const s of rows) {
  if (n++ >= limit) break;
  const items = [];
  if (s.strip_path) items.push([s.strip_path, `${stamp(s.created_at)}_${s.id.slice(-6)}_strip${path.extname(s.strip_path)}`]);
  if (frames) (s.frame_paths || []).forEach((f, i) => items.push([f, `${stamp(s.created_at)}_${s.id.slice(-6)}_photo-${i + 1}${path.extname(f)}`]));
  for (const [src, name] of items) {
    const out = path.join(dir, name);
    if (await exists(out)) { skipped++; continue; }
    try {
      const r = await fetch(`${SB}/storage/v1/object/public/sessions/${src.split('/').map(encodeURIComponent).join('/')}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      await writeFile(out, Buffer.from(await r.arrayBuffer())); got++;
      process.stdout.write(`\r  downloaded ${got}  skipped ${skipped}  failed ${failed}   `);
    } catch (e) { failed++; console.log(`\n  could not download ${src}: ${e.message}`); }
  }
}
console.log(`\nDone: ${got} downloaded, ${skipped} already there, ${failed} failed. Folder: ${dir}`);
