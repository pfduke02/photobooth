// print v1 — enqueue a 4x6 print sheet for the on-site Mac print server.
// Booth-key protected (mirrors `session`). Uploads the image to the public
// `sessions` bucket under prints/, then inserts a pending print_jobs row that
// the Mac watcher (anon key) polls and prints via lp.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOOTH_KEY = "lp1107-54db1816";
const MAX_CHARS = 12_000_000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-booth-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function dataUrlToBytes(dataUrl: string, allow: string[]) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!m || !allow.includes(m[1])) return null;
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

  if (typeof payload.image !== "string" || payload.image.length > MAX_CHARS)
    return json(400, { ok: false, error: "image missing or too large" });
  const img = dataUrlToBytes(payload.image, ["image/png", "image/jpeg"]);
  if (!img) return json(400, { ok: false, error: "image must be a png/jpeg data url" });
  const copies = Number.isInteger(payload.copies) && payload.copies > 0 && payload.copies <= 10 ? payload.copies : 1;

  const url = Deno.env.get("SUPABASE_URL")!;
  const supabase = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const bucket = "sessions";
  const id = newId();
  const path = `prints/${id}.${img.mime === "image/png" ? "png" : "jpg"}`;

  try {
    const up = await supabase.storage.from(bucket).upload(path, img.bytes, { contentType: img.mime, upsert: true });
    if (up.error) throw up.error;
    const meta = (payload.meta && typeof payload.meta === "object") ? payload.meta : {};
    const { error: dbErr } = await supabase.from("print_jobs").insert({ id, image_path: path, status: "pending", copies, meta });
    if (dbErr) throw dbErr;
    const pub = `${url}/storage/v1/object/public/${bucket}/${path}`;
    return json(200, { ok: true, jobId: id, url: pub });
  } catch (e) {
    return json(500, { ok: false, error: String((e as any)?.message || e) });
  }
});
