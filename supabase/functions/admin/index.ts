import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Admin key — known only to Pete (NOT shipped in the app pages, NOT in git).
// Lives in the ADMIN_KEY function secret:  supabase secrets set ADMIN_KEY=...
// (Deployed v1 still has it inline; set the secret before redeploying this.)
// Fails closed: if the secret is missing, every request is rejected.
const ADMIN_KEY = Deno.env.get("ADMIN_KEY");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "method not allowed" });
  if (!ADMIN_KEY || req.headers.get("x-admin-key") !== ADMIN_KEY) return json(401, { ok: false, error: "bad admin key" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "invalid json" }); }

  const url = Deno.env.get("SUPABASE_URL")!;
  const supabase = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const bucket = "sessions";

  try {
    if (body.action === "update") {
      const id = String(body.id || "");
      if (!id) return json(400, { ok: false, error: "missing id" });
      const patch: Record<string, unknown> = {};
      if (typeof body.favorite === "boolean") patch.favorite = body.favorite;
      if (Array.isArray(body.tags)) patch.tags = body.tags.filter((t: unknown) => typeof t === "string").map((t: string) => t.trim()).filter(Boolean).slice(0, 20);
      if (typeof body.note === "string") patch.note = body.note.slice(0, 2000);
      if (!Object.keys(patch).length) return json(400, { ok: false, error: "nothing to update" });
      const { error } = await supabase.from("sessions").update(patch).eq("id", id);
      if (error) throw error;
      return json(200, { ok: true, id, patch });
    }

    if (body.action === "delete") {
      const id = String(body.id || "");
      if (!id) return json(400, { ok: false, error: "missing id" });
      const { data: row, error: selErr } = await supabase.from("sessions").select("strip_path, frame_paths").eq("id", id).maybeSingle();
      if (selErr) throw selErr;
      const paths = row ? ([...(row.strip_path ? [row.strip_path] : []), ...((row.frame_paths as string[]) || [])]) : [];
      if (paths.length) { const { error } = await supabase.storage.from(bucket).remove(paths); if (error) throw error; }
      const { error: delErr } = await supabase.from("sessions").delete().eq("id", id);
      if (delErr) throw delErr;
      return json(200, { ok: true, id, removedFiles: paths.length });
    }

    if (body.action === "gc") {
      // Remove storage folders that have no matching sessions row (orphans).
      const { data: rows, error: rErr } = await supabase.from("sessions").select("id");
      if (rErr) throw rErr;
      const ids = new Set((rows || []).map((r: any) => r.id));
      const { data: tops, error: lErr } = await supabase.storage.from(bucket).list("", { limit: 1000 });
      if (lErr) throw lErr;
      let removedFiles = 0; const removedPrefixes: string[] = [];
      for (const t of tops || []) {
        if (!t.name || ids.has(t.name)) continue;
        const { data: inner, error: iErr } = await supabase.storage.from(bucket).list(t.name, { limit: 100 });
        if (iErr) continue;
        const paths = (inner || []).map((f: any) => `${t.name}/${f.name}`);
        if (paths.length) { const { error } = await supabase.storage.from(bucket).remove(paths); if (!error) { removedFiles += paths.length; removedPrefixes.push(t.name); } }
      }
      return json(200, { ok: true, removedPrefixes, removedFiles });
    }

    return json(400, { ok: false, error: "unknown action" });
  } catch (e) {
    return json(500, { ok: false, error: String((e as any)?.message || e) });
  }
});
