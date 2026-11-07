// session v4 (DEPLOYED 2026-07-31). Backward-compatible with v3:
//   1. Honors a well-formed client session id (payload.id, date_8+hex) so the
//      local dir, cloud row, and reconciler share ONE id -> the reconciler no
//      longer re-uploads every session under a second id (no more cloud dupes).
//      Old clients that send no id get a server id exactly as before.
//   2. Accepts a JPEG strip as well as PNG (measured ~6x smaller at q95, text
//      quality identical to 4:4:4). Row write is an UPSERT so a retry of the
//      same id converges instead of erroring.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOOTH_KEY = "lp1107-54db1816";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-booth-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const MAX_STRIP_CHARS = 12_000_000;
const MAX_FRAME_CHARS = 4_000_000;
const MAX_BOOM_CHARS  = 12_000_000;
const MAX_FRAMES = 6;
const ID_RE = /^\d{4}-\d{2}-\d{2}_[0-9a-f]{6,12}$/;          // matches server.mjs + client

function dataUrlToBytes(dataUrl: string, allowMimes: string[]) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!m || !allowMimes.includes(m[1])) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1], bytes };
}

function newId() {
  const d = new Date().toISOString().slice(0, 10);
  const r = crypto.getRandomValues(new Uint8Array(6));
  return `${d}_${Array.from(r).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "method not allowed" });
  if (req.headers.get("x-booth-key") !== BOOTH_KEY) return json(401, { ok: false, error: "bad booth key" });

  let payload: any;
  try { payload = await req.json(); } catch { return json(400, { ok: false, error: "invalid json" }); }

  const frames = Array.isArray(payload.frames) ? payload.frames : [];
  if (frames.length > MAX_FRAMES) return json(400, { ok: false, error: "too many frames" });
  if (typeof payload.strip === "string" && payload.strip.length > MAX_STRIP_CHARS)
    return json(400, { ok: false, error: "strip too large" });
  for (const f of frames)
    if (typeof f !== "string" || f.length > MAX_FRAME_CHARS)
      return json(400, { ok: false, error: "frame too large" });
  const numPhotos = Number(payload.numPhotos ?? frames.length);
  if (!Number.isInteger(numPhotos) || numPhotos < 1 || numPhotos > MAX_FRAMES)
    return json(400, { ok: false, error: "bad numPhotos" });

  let boomMime: string | null = null;
  if (payload.boomerang !== undefined) {
    if (typeof payload.boomerang !== "string" || payload.boomerang.length > MAX_BOOM_CHARS)
      return json(400, { ok: false, error: "boomerang too large" });
    const bm = /^data:(video\/(?:webm|mp4));base64,/.exec(payload.boomerang);
    if (!bm) return json(400, { ok: false, error: "boomerang must be a webm/mp4 data url" });
    boomMime = bm[1];
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const supabase = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const bucket = "sessions";

  const id = (typeof payload.id === "string" && ID_RE.test(payload.id)) ? payload.id : newId();
  const framePaths: string[] = [];
  try {
    let stripPath: string | null = null;
    if (payload.strip) {
      const strip = dataUrlToBytes(payload.strip, ["image/png", "image/jpeg"]);
      if (!strip) return json(400, { ok: false, error: "strip must be a png/jpeg data url" });
      stripPath = `${id}/strip.${strip.mime === "image/png" ? "png" : "jpg"}`;
      const up = await supabase.storage.from(bucket).upload(stripPath, strip.bytes, { contentType: strip.mime, upsert: true });
      if (up.error) throw up.error;
    }
    for (let i = 0; i < frames.length; i++) {
      const f = dataUrlToBytes(frames[i], ["image/jpeg"]);
      if (!f) continue;
      const p = `${id}/frame-${i + 1}.jpg`;
      const up = await supabase.storage.from(bucket).upload(p, f.bytes, { contentType: "image/jpeg", upsert: true });
      if (up.error) throw up.error;
      framePaths.push(p);
    }
    if (!stripPath && framePaths.length === 0) return json(400, { ok: false, error: "no images" });

    let boomPath: string | null = null;
    if (boomMime) {
      const boom = dataUrlToBytes(payload.boomerang, [boomMime]);
      if (boom) {
        boomPath = `${id}/boomerang.${boomMime.split("/")[1]}`;
        const up = await supabase.storage.from(bucket).upload(boomPath, boom.bytes, { contentType: boomMime, upsert: true });
        if (up.error) throw up.error;
      }
    }

    const meta = (payload.meta && typeof payload.meta === "object") ? payload.meta : {};
    const tags = Array.isArray(meta.tags) ? meta.tags.filter((t: unknown) => typeof t === "string").slice(0, 20) : [];
    const createdAt = (typeof payload.createdAt === "string" && payload.createdAt.length <= 40)
      ? payload.createdAt : new Date().toISOString();
    const metaOut = { ...meta, ...(boomPath ? { boomerangPath: boomPath } : {}) };

    const { error: dbErr } = await supabase.from("sessions").upsert({
      id,
      created_at: createdAt,
      num_photos: numPhotos,
      background: typeof meta.background === "string" ? meta.background.slice(0, 60) : null,
      strip_theme: typeof meta.stripTheme === "string" ? meta.stripTheme.slice(0, 60) : null,
      ai_enabled: typeof meta.aiEnabled === "boolean" ? meta.aiEnabled : null,
      app_version: typeof meta.version === "string" ? meta.version.slice(0, 20) : null,
      favorite: meta.favorite === true,
      tags,
      note: typeof meta.note === "string" ? meta.note.slice(0, 2000) : null,
      strip_path: stripPath,
      frame_paths: framePaths,
      meta: metaOut,
    }, { onConflict: "id" });
    if (dbErr) throw dbErr;

    const pub = (p: string) => `${url}/storage/v1/object/public/${bucket}/${p}`;
    return json(200, { ok: true, id, strip: stripPath ? pub(stripPath) : null, frames: framePaths.map(pub), boomerang: boomPath ? pub(boomPath) : null });
  } catch (e) {
    return json(500, { ok: false, error: String((e as any)?.message || e) });
  }
});
