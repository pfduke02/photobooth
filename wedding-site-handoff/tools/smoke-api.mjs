// Smoke test for api v12 on the staging slug, against the demo event. Node 22.
import fs from 'node:fs';
import path from 'node:path';
import * as tus from 'tus-js-client';
const API = process.env.API || 'https://hseupjbneifqxaykxltt.supabase.co/functions/v1/api-next';
const EVENT = process.env.EVENT || '12d4d64f73d342f2865aaa28';
const MEDIA = process.env.MEDIA || path.resolve(import.meta.dirname, '../media');
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const rid = (n) => Array.from({ length: n }, () => A[Math.floor(Math.random() * A.length)]).join('');
const deviceKey = 'smoke-' + rid(20);
async function api(action, extra) {
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ e: EVENT, action, deviceKey, ...extra }) });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d?.ok) throw new Error(action + ' HTTP ' + r.status + ' ' + JSON.stringify(d));
  return d;
}
async function put(url, buf, type) {
  const r = await fetch(url, { method: 'PUT', headers: { 'content-type': type }, body: buf });
  if (!r.ok) throw new Error('PUT HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
}
function tusUp(buf, grant, key, type) {
  return new Promise((res, rej) => {
    const u = new tus.Upload(buf, {
      endpoint: grant.endpoint, retryDelays: [0, 1000, 3000],
      headers: { authorization: 'Bearer ' + key, apikey: key, 'x-upsert': 'true' },
      uploadDataDuringCreation: true, removeFingerprintOnSuccess: true, chunkSize: 6 * 1024 * 1024,
      metadata: { bucketName: grant.bucket, objectName: grant.objectName, contentType: type, cacheControl: '3600' },
      onShouldRetry: (err) => { const s = err?.originalResponse?.getStatus?.() || 0; return !(s >= 400 && s < 500); },
      onError: (e) => rej(e), onSuccess: () => res(),
      onProgress: (s, t) => { if (process.env.VERBOSE) console.log('   ', Math.round(s / t * 100) + '%'); },
    });
    u.start();
  });
}
const files = [
  { name: 'photo-a.jpg', type: 'image/jpeg', private: false },
  { name: 'clip-8s.mp4', type: 'video/mp4', private: true, duration: 8 },
  { name: 'clip-70s-big.mp4', type: 'video/mp4', private: false, duration: 70 },
  { name: 'notes.txt', type: 'text/plain', private: false, fake: true },
];
for (const f of files) { f.buf = f.fake ? Buffer.from('hello') : fs.readFileSync(path.join(MEDIA, f.name)); f.size = f.buf.length; f.id = rid(16); }
const hello = await api('hello');
console.log('hello:', JSON.stringify({ received: hello.received, videos: hello.videos, maxBatch: hello.maxBatch, maxFileBytes: hello.maxFileBytes, maxVideoBytes: hello.maxVideoBytes, uploadKey: hello.uploadKey ? 'yes' : 'MISSING', resumable: hello.resumable }));
const intent = await api('intent', { contributor: 'Smoke Test', uploads: files.map((f) => ({ uploadId: f.id, name: f.name, type: f.type, size: f.size, thumb: false, private: f.private, duration: f.duration })) });
for (const u of intent.uploads) console.log('intent:', u.uploadId, u.ok ? 'ok' : 'refused', u.kind || '-', u.reason || '', u.resumable ? 'resumable' : '', u.url ? 'signedPUT' : '');
const key = intent.uploadKey;
for (const f of files) {
  const u = intent.uploads.find((x) => x.uploadId === f.id); if (!u || !u.ok) continue;
  const t0 = Date.now();
  try {
    if (u.resumable) { await tusUp(f.buf, u.resumable, key, f.type); console.log('tus ok:', f.name, (f.size / 1048576).toFixed(1) + ' MB', (Date.now() - t0) + ' ms'); }
    else { await put(u.url, f.buf, f.type); console.log('put ok:', f.name, (Date.now() - t0) + ' ms'); }
  } catch (e) {
    const st = e?.originalResponse?.getStatus?.(); const body = e?.originalResponse ? String(e.originalResponse.getBody()).slice(0, 300) : '';
    console.log('UPLOAD FAILED:', f.name, st || '', body || String(e?.message || e).slice(0, 300));
    if (u.resumable && u.url) { try { await put(u.url, f.buf, f.type); console.log('put fallback ok:', f.name); } catch (e2) { console.log('put fallback FAILED:', String(e2.message).slice(0, 300)); } }
  }
}
const c = await api('complete', { uploadIds: files.map((f) => f.id) });
console.log('complete:', JSON.stringify(c.files));
const mine = await api('mine');
console.log('mine:', JSON.stringify(mine.items.map((i) => [i.name, i.kind, i.private, i.duration, !!i.thumbUrl])), 'unfinished:', JSON.stringify(mine.unfinished.map((u) => u.name)));
const album = await api('album', { limit: 200 });
console.log('album: total', album.total, 'videos', album.videos, 'privateVideoVisible', album.items.some((i) => i.id === files[1].id), 'bigVideoVisible(not approved yet)', album.items.some((i) => i.id === files[2].id));
console.log('video_link:', JSON.stringify(await api('video_link', { link: 'https://www.icloud.com/photos/0example?x=1&y=2', name: 'Smoke Test' })));
console.log('IDS', JSON.stringify(files.map((f) => f.id)));
