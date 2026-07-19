// ============================================================================
// Photobooth · V0.5 — tiny LOCAL COLLECTION backend (zero dependencies).
//
// Two jobs:
//   1. Serve the static app (so the camera + model load from a secure
//      http://localhost origin, and the POST below is same-origin — no CORS).
//   2. Receive each finished session and write it to disk as:
//        sessions/<YYYY-MM-DD_id>/
//          strip.png
//          frame-1.jpg … frame-N.jpg
//          metadata.json
//
// Design notes for the future cloud move: the request handler is a plain
// (method, url, body) -> response function. A Cloudflare Worker's
// `export default { fetch(req) {...} }` has the same shape, so the frontend's
// upload contract (POST JSON with base64 images) can later point at a Worker
// + R2, or Supabase Storage, with NO frontend change.
//
// Run:  node server.mjs      (optionally PORT=8099)
// ============================================================================
import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(ROOT, 'sessions');
const PORT = process.env.PORT || 8099;
const MAX_BODY = 80 * 1024 * 1024; // 80 MB is plenty for 1 strip + a few frames

const MIME = {
  '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.css':'text/css', '.json':'application/json', '.png':'image/png',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.svg':'image/svg+xml', '.wasm':'application/wasm', '.tflite':'application/octet-stream',
  '.binarypb':'application/octet-stream', '.data':'application/octet-stream',
};

const send = (res, code, body, headers={}) => { res.writeHead(code, { 'Cache-Control':'no-store', ...headers }); res.end(body); };
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type':'application/json' });

function dataUrlToBuffer(dataUrl){
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime:m[1], buf:Buffer.from(m[2], 'base64') } : null;
}
function newId(){
  const day = new Date().toISOString().slice(0,10);          // YYYY-MM-DD
  return `${day}_${crypto.randomBytes(3).toString('hex')}`;   // e.g. 2026-07-16_ab12cd
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY){ reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---- core: persist one session to sessions/<id>/ ----------------------------
async function saveSession(payload){
  const id = newId();
  const dir = path.join(SESSIONS_DIR, id);
  await fs.mkdir(dir, { recursive:true });
  const files = [];

  const strip = dataUrlToBuffer(payload.strip);
  if (strip){ await fs.writeFile(path.join(dir,'strip.png'), strip.buf); files.push('strip.png'); }

  const frames = Array.isArray(payload.frames) ? payload.frames : [];
  for (let i=0;i<frames.length;i++){
    const f = dataUrlToBuffer(frames[i]); if (!f) continue;
    const name = `frame-${i+1}.jpg`;
    await fs.writeFile(path.join(dir,name), f.buf); files.push(name);
  }

  const metadata = {
    id,
    createdAt: payload.createdAt || new Date().toISOString(),
    savedAt: new Date().toISOString(),
    numPhotos: payload.numPhotos ?? frames.length,
    strip: strip ? 'strip.png' : null,
    frames: files.filter((n) => n.startsWith('frame-')),
    ...(payload.meta || {}),
  };
  await fs.writeFile(path.join(dir,'metadata.json'), JSON.stringify(metadata, null, 2));
  files.push('metadata.json');
  return { id, dir: path.relative(ROOT, dir), files };
}

// ---- static file serving (with a path-traversal guard) ----------------------
async function serveStatic(req, res){
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '/photobooth.html') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'forbidden');
  try {
    const st = await fs.stat(filePath);
    if (st.isDirectory()) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  } catch { send(res, 404, 'not found'); }
}

const server = http.createServer(async (req, res) => {
  // permissive CORS so the same contract also works if the app is ever hosted elsewhere
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/api/health')
    return sendJson(res, 200, { ok:true, sessionsDir: path.relative(ROOT, SESSIONS_DIR) });

  if (req.method === 'GET' && url === '/api/sessions') {
    try {
      const entries = await fs.readdir(SESSIONS_DIR, { withFileTypes:true }).catch(()=>[]);
      const out = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const id = e.name, dir = path.join(SESSIONS_DIR, id);
        let meta = {}; try { meta = JSON.parse(await fs.readFile(path.join(dir,'metadata.json'),'utf8')); } catch {}
        const files = await fs.readdir(dir).catch(()=>[]);
        const frames = files.filter((f)=>/^frame-\d+\.jpg$/.test(f)).sort();
        out.push({
          id, createdAt: meta.createdAt || null, numPhotos: meta.numPhotos ?? frames.length,
          background: meta.background || null,
          strip: files.includes('strip.png') ? `/sessions/${id}/strip.png` : null,
          frames: frames.map((f)=>`/sessions/${id}/${f}`), meta,
        });
      }
      out.sort((a,b)=> (b.createdAt||'').localeCompare(a.createdAt||'') || b.id.localeCompare(a.id));
      return sendJson(res, 200, { ok:true, sessions: out });
    } catch(e){ return sendJson(res, 500, { ok:false, error:e.message }); }
  }

  if (req.method === 'POST' && url === '/api/session') {
    try {
      const payload = JSON.parse((await readBody(req)).toString('utf8'));
      const result = await saveSession(payload);
      console.log(`[saved] ${result.id}  (${result.files.join(', ')})`);
      return sendJson(res, 200, { ok:true, ...result });
    } catch (e) {
      console.error('[error]', e.message);
      return sendJson(res, 400, { ok:false, error:e.message });
    }
  }

  if (req.method === 'GET') return serveStatic(req, res);
  return send(res, 405, 'method not allowed');
});

await fs.mkdir(SESSIONS_DIR, { recursive:true });
server.listen(PORT, () => {
  console.log('\n📸  Photobooth · local collection server');
  console.log(`    open   →  http://localhost:${PORT}/`);
  console.log(`    saves  →  ${SESSIONS_DIR}/<id>/\n`);
});
