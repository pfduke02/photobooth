// Backward-compatible with print v1. New clients provide an idempotency ID;
// replays return the original job without resetting its status or image.
const BOOTH_KEY = 'lp1107-54db1816';
const ID_RE = /^\d{4}-\d{2}-\d{2}_[0-9a-f]{6,12}$/;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-booth-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json' },
});
function newId() {
  return new Date().toISOString().slice(0, 10) + '_' +
    Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');
}

export function createPrintHandler({ createClient, env }) {
  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' });
    if (req.headers.get('x-booth-key') !== BOOTH_KEY) return json(401, { ok: false, error: 'bad booth key' });
    let payload;
    try { payload = await req.json(); } catch { return json(400, { ok: false, error: 'invalid json' }); }
    if (!payload || typeof payload !== 'object') return json(400, { ok: false, error: 'invalid payload' });
    if (payload.id !== undefined && (typeof payload.id !== 'string' || !ID_RE.test(payload.id)))
      return json(400, { ok: false, error: 'invalid print id' });
    if (typeof payload.image !== 'string' || payload.image.length > 12_000_000)
      return json(400, { ok: false, error: 'image missing or too large' });
    const match = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(payload.image);
    if (!match) return json(400, { ok: false, error: 'image must be a png/jpeg data url' });
    let bytes;
    try { bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0)); }
    catch { return json(400, { ok: false, error: 'invalid image encoding' }); }
    const id = payload.id || newId();
    const url = env.get('SUPABASE_URL');
    const client = createClient(url, env.get('SUPABASE_SERVICE_ROLE_KEY'));
    const reply = job => json(200, { ok: true, jobId: job.id, status: job.status,
      url: `${url}/storage/v1/object/public/sessions/${job.image_path}` });
    const lookup = () => client.from('print_jobs').select('id,status,image_path').eq('id', id).maybeSingle();
    try {
      const existing = await lookup();
      if (existing.error) throw existing.error;
      if (existing.data) return reply(existing.data);
      const imagePath = `prints/${id}.${match[1] === 'image/png' ? 'png' : 'jpg'}`;
      // Never overwrite an image which a worker may already be downloading.
      const upload = await client.storage.from('sessions').upload(imagePath, bytes, { contentType: match[1], upsert: false });
      if (upload.error && String(upload.error.statusCode) !== '409') throw upload.error;
      const copies = Number.isInteger(payload.copies) && payload.copies > 0 && payload.copies <= 10 ? payload.copies : 1;
      const meta = payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta) ? payload.meta : {};
      // A conflicting insert is a successful replay, never an UPDATE to pending.
      const insert = await client.from('print_jobs').upsert({ id, image_path: imagePath, status: 'pending', copies, meta },
        { onConflict: 'id', ignoreDuplicates: true });
      if (insert.error) throw insert.error;
      const saved = await lookup();
      if (saved.error) throw saved.error;
      if (!saved.data) throw new Error('Print job was not saved');
      return reply(saved.data);
    } catch (error) {
      return json(500, { ok: false, error: String(error.message || error) });
    }
  };
}
