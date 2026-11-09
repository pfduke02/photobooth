// wedding-uploader · api — all guest/owner operations for the photo uploader.
// Source of truth for the Supabase edge function `api` (project hseupjbneifqxaykxltt).
// Deploy: supabase functions deploy api --no-verify-jwt   (or the Supabase MCP deploy tool)
//
// v12 (2026-11-09): videos, private uploads, unfinished-upload re-asks, link handoff.
//   · `intent` accepts videos. kind = photo | video is decided from the file type and name. Photos keep
//     events.max_file_bytes (50 MB); videos get events.max_video_bytes (2 GB). Each upload may carry
//     duration (seconds) and private (true = only the couple and family see it; never in the album).
//   · A video gets, besides the signed PUT URL, a resumable grant { endpoint, bucket, objectName } for
//     the storage TUS endpoint, used with the public anon key (uploadKey). Storage RLS lets anon write
//     only paths that `intent` opened for a video (migration video_support).
//   · `hello` adds videos (count), maxVideoBytes, uploadKey and the resumable endpoint.
//   · `mine` adds kind / duration / private per item, and `unfinished`: what this phone started in the
//     last 7 days and never completed, so the page can ask for those files again.
//   · `video_link`: a video over the cap → the guest pastes an iCloud / Drive / Dropbox share link
//     (video_requests.link). `video_interest` stays for the old page.
//   · `album` leaves private items out and adds kind / duration / a videos count; video URLs are signed
//     for 6 h so a long clip keeps playing. `gallery` adds kind / duration / private and the filters
//     videos | private. `approve` refuses private items.
//   · A database job (uploader_reconcile, every 10 min) completes uploads whose file arrived but whose
//     `complete` call never did (migration uploader_reconcile_sweep). The page now calls `complete`
//     per file as well.
// v11 (2026-11-07): photobooth control (the booth lives in Supabase project xjnqnxorqhobikyzshrt).
//   · `booth_config` (event token): the printer switch + one-shot commands, read by the Mac
//     print worker and the booth iPad; each can attach its status (with the booth key).
//   · owner `booth_overview`: switch, last worker/booth status, recent print jobs.
//   · owner `booth_set`: printMode alternate|only|pause, printOnly, resumePrinters[],
//     resetCamera, reloadBooth.
//   · owner `booth_reprint`: re-queue a print sheet, optionally on a chosen printer.
// v10 (2026-11-06): Deleted list, bulk actions, personal admin links.
//   · owner `delete` is now a soft delete: sets media.deleted_at. The photo leaves every list
//     (gallery, album, guest counts, the guest's own list) but the file and row stay.
//   · owner `restore` clears deleted_at; owner `purge` removes files + rows, and only for photos
//     already in Deleted ({ uploadIds } or { all: true } to empty the list).
//   · owner `gallery` takes filter "deleted"; every other filter leaves deleted photos out.
//     Items carry deleted + deletedAt.
//   · owner `hide` takes uploadIds (up to 500) as well as a single uploadId.
//   · owner key can be the event's owner_token or a personal key from event_admins
//     (uploader_admin_name); status returns the admin's name.
// v9 (2026-10-30): approval + public album.
//   · owner `approve` sets/clears media.approved_at (up to 500 ids at a time)
//   · owner `gallery` takes filter: all | unapproved | approved | hidden | outtakes (default all,
//     which is everything that isn't an outtake); items carry approved + outtake
//   · owner `album_visibility` flips events.album_public
//   · guest-callable `album`: approved, not hidden, not outtake — only while album_public is on.
//     Chronological, paginated, signed URLs. Powers /photos/album.
//   · `status` includes albumPublic, opensAt, closesAt and approved/unapproved counts
// v8 (2026-10-30): outtakes — a guest's `remove` no longer deletes anything. It sets media.outtake_at:
//   the photo leaves the guest's list and the guest-facing counts, and leaves the owner's main
//   gallery, but the file and row stay. Owner gallery takes { outtakes: true } to list only those.
// v7 (2026-10-29): transient PostgREST errors ("JWT issued at future") retried twice server-side
// v6 (2026-10-28): guest hot path = one database call per step
//   · hello / intent / complete / mine each run as a single database function
//     (uploader_hello / _intent / _complete / _mine) that also checks the event
//     token, so a guest action costs one PostgREST request instead of 5–8. Load
//     testing showed PostgREST on Micro compute was the bottleneck under a burst.
//   · intent signs storage URLs in parallel; complete checks just the uploaded
//     objects (indexed), never the whole folder
//   · video_interest: photos only on the night; a guest with videos leaves an email or
//     phone (max 3 per device) and the owner sees the list in status.videos
// v5: duplicates by SHA-256 ({ duplicate: true }), guest remove, owner delete.
// v4: thumbnails, device key + mine, owner gallery + hide, retry keeps its path.
// v3: names sanitized server-side, per-event storage cap.
//
// AUTH MODEL (why verify_jwt is off): every request carries an event capability
// token (`e`) checked against the events table; owner actions also need the event's
// owner_token or a personal admin key; `mine` and `remove` need the device's own random key.
// No Supabase JWT is involved by design — guests have no accounts. The service-role key never
// leaves this function, and the database functions are callable by service_role only. The one
// place the public anon key is used is the resumable video upload, where storage RLS only lets it
// write a path that `intent` (event token) opened.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const BUCKET = "media";
const OK_EXT = /\.(jpe?g|png|heic|heif|webp|gif|avif)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|qt|webm|3gp|3g2|mkv|avi|hevc|mts|m2ts)$/i;
const OK_TYPE = (t: string) => /^(image|video)\//.test(t) || t === "application/octet-stream" || t === "";
// What a file is, from its type first and its name second. null = neither a photo nor a video.
const kindOf = (name: string, type: string): "photo" | "video" | null => {
  if (/^video\//i.test(type)) return "video";
  if (/^image\//i.test(type)) return "photo";
  if (VIDEO_EXT.test(name)) return "video";
  if (OK_EXT.test(name)) return "photo";
  return null;
};
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DEV_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const OWNER_RE = /^[a-f0-9]{16,64}$/;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const RESUMABLE = `${SB_URL}/storage/v1/upload/resumable`;
// Photobooth project (public anon key + shared booth key, both already ship in the booth page).
const PB_URL = "https://xjnqnxorqhobikyzshrt.supabase.co";
const PB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqbnFueG9ycWhvYmlreXpzaHJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0NDkyMjUsImV4cCI6MjEwMDAyNTIyNX0.ihY85rnHCWyg7MknipFU9_bI2syCPYbwpQurVIe0scA";
const BOOTH_KEY = "lp1107-54db1816";
const PB_ID_RE = /^\d{4}-\d{2}-\d{2}_[0-9a-f]{6,12}$/;
const PRINTER_RE = /^[A-Za-z0-9_.@-]{1,80}$/;
const pbHeaders = { apikey: PB_ANON, Authorization: `Bearer ${PB_ANON}` };
function pbNewId(): string {
  return new Date().toISOString().slice(0, 10) + "_" +
    Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// Status blobs from the worker / iPad: plain JSON, size-capped.
function smallJson(v: unknown, max = 20000): unknown {
  try { const t = JSON.stringify(v); return t && t.length <= max ? JSON.parse(t) : null; } catch { return null; }
}

function sanitizeName(n: string): string {
  const base = String(n || "photo").split(/[\\/]/).pop()!;
  return base.replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "photo";
}
function sanitizeText(s: unknown, max: number): string {
  // strip markup-capable and control characters entirely — belt; page escaping is braces
  return String(s ?? "").replace(/[<>&"'`\u0000-\u001f]/g, "").trim().slice(0, max);
}
// A pasted share link: control characters and quote/markup characters out, & stays (query strings).
function cleanLink(s: unknown): string {
  return String(s ?? "").replace(/[\u0000-\u001f<>"'`\\]/g, "").trim().slice(0, 600);
}
function downloadName(who: string, orig: string, uploadId: string): string {
  const w = (who || "guest").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "guest";
  return `${w}_${uploadId.slice(0, 6)}_${sanitizeName(orig)}`;
}
// uploadIds (array) or uploadId (single) → unique valid ids, at most `max`
function idList(body: any, max: number): string[] {
  const raw = Array.isArray(body.uploadIds) ? body.uploadIds : [body.uploadId];
  return [...new Set(raw.map(String).filter((s: string) => ID_RE.test(s)))].slice(0, max) as string[];
}
// "50 MB" / "2 GB" for a byte limit
function limitLabel(bytes: number): string {
  const mb = bytes / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(mb % 1024 ? 1 : 0) + " GB" : (mb | 0) + " MB";
}
// a database function's { ok:false, code, error } becomes an HTTP error
const refused = (d: any) => json(Number(d?.code) || 400, { ok: false, error: d?.error || "request failed" });

// PostgREST now and then rejects the first request after a quiet spell with "JWT issued
// at future" (clock skew between the gateway and PostgREST). Seen 2026-10-29 on the first
// call of the morning. Transient errors get two quick retries before the caller sees them.
const TRANSIENT_DB = /issued at future|JWT|fetch failed|timed? ?out|ECONNRESET|50[234]/i;
async function db(run: () => PromiseLike<{ data: any; error: any; count?: number | null }>) {
  let r = await run();
  for (let i = 0; i < 2 && r.error && TRANSIENT_DB.test(String(r.error?.message || r.error)); i++) {
    await new Promise((ok) => setTimeout(ok, 250 * (i + 1)));
    r = await run();
  }
  return r;
}

// Signed view URLs for many paths; a missing object just has no URL (never throws).
async function signMany(supabase: any, paths: string[], ttl: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    try {
      const { data } = await supabase.storage.from(BUCKET).createSignedUrls(chunk, ttl);
      for (const s of data || []) if (s && s.signedUrl && s.path) out.set(s.path, s.signedUrl);
    } catch { /* leave these without URLs */ }
  }
  return out;
}
// Originals: photos for 1–2 h, videos longer so a long clip keeps playing. Thumbs/posters short.
async function signOriginals(supabase: any, rows: any[], photoTtl: number, videoTtl: number) {
  const [p, v] = await Promise.all([
    signMany(supabase, rows.filter((r: any) => r.kind !== "video").map((r: any) => r.storage_path), photoTtl),
    signMany(supabase, rows.filter((r: any) => r.kind === "video").map((r: any) => r.storage_path), videoTtl),
  ]);
  return (r: any) => (r.kind === "video" ? v : p).get(r.storage_path) || null;
}

// Delete objects + rows for the given media rows (only paths inside this event's folder).
async function removeRows(supabase: any, slug: string, rows: any[]) {
  const paths = rows.flatMap((r: any) => [r.storage_path, r.thumb_path])
    .filter((p: unknown) => typeof p === "string" && p.startsWith(`${slug}/`));
  for (let i = 0; i < paths.length; i += 500) {
    const { error } = await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 500));
    if (error) throw error;
  }
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from("media").delete().in("id", rows.slice(i, i + 200).map((r: any) => r.id));
    if (error) throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "method not allowed" });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: "invalid json" }); }

  const supabase = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const token = typeof body.e === "string" ? body.e : "";
  if (!/^[a-f0-9]{16,64}$/.test(token)) return json(401, { ok: false, error: "invalid link" });
  const deviceKey = typeof body.deviceKey === "string" && DEV_RE.test(body.deviceKey) ? body.deviceKey : null;

  try {
    // ================= guest hot path: one database call each =================

    if (body.action === "hello") {
      const { data, error } = await db(() => supabase.rpc("uploader_hello", { p_token: token }));
      if (error) throw error;
      if (!data?.ok) return refused(data);
      return json(200, { ...data, uploadKey: ANON, resumable: { endpoint: RESUMABLE, bucket: BUCKET } });
    }

    if (body.action === "intent") {
      const uploads = Array.isArray(body.uploads) ? body.uploads : [];
      if (!uploads.length) return json(400, { ok: false, error: "no files" });
      if (uploads.length > 25) return json(400, { ok: false, error: "too many files in one batch" });
      const contributor = sanitizeText(body.contributor, 60);

      // shape checks here; size, cap, window, retries and duplicates in the database
      const res: any[] = uploads.map((u: any) => ({ uploadId: String(u?.uploadId || "") }));
      const valid: any[] = [];
      uploads.forEach((u: any, i: number) => {
        const uploadId = res[i].uploadId;
        const name = sanitizeName(String(u?.name || ""));
        const type = String(u?.type || "");
        const size = Number(u?.size || 0);
        if (!ID_RE.test(uploadId)) { Object.assign(res[i], { ok: false, reason: "bad uploadId" }); return; }
        const kind = kindOf(name, type);
        if (!kind) { Object.assign(res[i], { ok: false, reason: "not a photo or video" }); return; }
        if (!OK_TYPE(type)) { Object.assign(res[i], { ok: false, reason: "unsupported type" }); return; }
        const dur = Number(u?.duration);
        valid.push({ i, uploadId, name, type, size: Number.isFinite(size) ? Math.floor(size) : 0, kind,
          duration: Number.isFinite(dur) && dur > 0 ? Math.min(999999, Math.round(dur)) : null,
          private: u?.private === true,
          thumb: u?.thumb === true, sha256: typeof u?.sha256 === "string" && SHA_RE.test(u.sha256) ? u.sha256 : null });
      });

      let rows: any[] = [];
      if (valid.length) {
        const { data, error } = await db(() => supabase.rpc("uploader_intent", {
          p_token: token, p_device: deviceKey, p_contributor: contributor,
          p_uploads: valid.map(({ i: _i, ...v }) => v),
        }));
        if (error) throw error;
        if (!data?.ok) return refused(data);
        rows = data.uploads || [];
      }
      const byId = new Map(rows.map((r: any) => [r.uploadId, r]));
      const signOne = async (p: string) => {
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(p, { upsert: true });
        return error || !data ? null : data;
      };
      await Promise.all(valid.map(async (v) => {
        const r: any = byId.get(v.uploadId);
        res[v.i].kind = v.kind;
        if (!r) { Object.assign(res[v.i], { ok: false, reason: "could not start" }); return; }
        if (r.status === "received") { Object.assign(res[v.i], { ok: true, alreadyReceived: true }); return; }
        if (r.status === "duplicate") { Object.assign(res[v.i], { ok: true, duplicate: true }); return; }
        if (r.status === "too_large") {
          const max = Number(r.max) || 0;
          Object.assign(res[v.i], { ok: false, tooLarge: true, max, reason: `too large (max ${limitLabel(max)})` }); return;
        }
        const [o, t] = await Promise.all([signOne(r.path), r.thumbPath ? signOne(r.thumbPath) : Promise.resolve(null)]);
        if (!o) { Object.assign(res[v.i], { ok: false, reason: "could not sign upload" }); return; }
        Object.assign(res[v.i], { ok: true, path: r.path, url: o.signedUrl, token: o.token });
        if (t) Object.assign(res[v.i], { thumbUrl: t.signedUrl, thumbToken: t.token });
        // videos may also go through the resumable endpoint (chunked, survives a dropped connection)
        if (v.kind === "video") res[v.i].resumable = { endpoint: RESUMABLE, bucket: BUCKET, objectName: r.path };
      }));
      return json(200, { ok: true, uploadKey: ANON, uploads: res });
    }

    if (body.action === "complete") {
      const ids = [...new Set((Array.isArray(body.uploadIds) ? body.uploadIds : []).map(String)
        .filter((s: string) => ID_RE.test(s)))].slice(0, 25) as string[];
      if (!ids.length) return json(400, { ok: false, error: "no uploadIds" });
      const { data, error } = await db(() => supabase.rpc("uploader_complete", { p_token: token, p_ids: ids }));
      if (error) throw error;
      if (!data?.ok) return refused(data);
      const files = (data.files || []).map((f: any) => f.ok === true
        ? { uploadId: f.uploadId, ok: true, bytes: f.bytes }
        : { uploadId: f.uploadId, ok: false, reason: f.reason || "not received" });
      return json(200, { ok: true, requested: ids.length, received: files.filter((f: any) => f.ok).length, files });
    }

    if (body.action === "mine") {
      if (!deviceKey) return json(400, { ok: false, error: "no device key" });
      const { data, error } = await db(() => supabase.rpc("uploader_mine", { p_token: token, p_device: deviceKey }));
      if (error) throw error;
      if (!data?.ok) return refused(data);
      const list = data.items || [];
      const urls = await signMany(supabase, list.filter((r: any) => r.thumbPath).map((r: any) => r.thumbPath), 3600);
      return json(200, { ok: true, count: list.length,
        items: list.map((r: any) => ({
          uploadId: r.uploadId, name: r.name, bytes: r.bytes, at: r.at, kind: r.kind || "photo",
          duration: r.duration ?? null, private: r.private === true,
          thumbUrl: r.thumbPath ? (urls.get(r.thumbPath) || null) : null,
        })),
        unfinished: (data.unfinished || []).map((u: any) => ({
          uploadId: u.uploadId, name: u.name, bytes: u.bytes, kind: u.kind || "photo", private: u.private === true, at: u.at,
        })) });
    }

    // ================= everything else: event lookup first =================
    const { data: ev, error: evErr } = await db(() => supabase.from("events").select("*").eq("token", token).maybeSingle());
    if (evErr) return json(500, { ok: false, error: "lookup failed" });
    if (!ev || !ev.active) return json(401, { ok: false, error: "invalid link" });
    const now = new Date().toISOString();
    const windowOpen = (!ev.starts_at || ev.starts_at <= now) && (!ev.ends_at || now <= ev.ends_at);

    // Owner = the event's owner_token, or an active personal key in event_admins.
    // Only looked up for owner actions, so guest album traffic never touches event_admins.
    const ownerKey = typeof body.owner === "string" && OWNER_RE.test(body.owner) ? body.owner : "";
    let ownerChecked: boolean | null = null;
    const isOwner = async (): Promise<boolean> => {
      if (ownerChecked !== null) return ownerChecked;
      if (!ownerKey) return (ownerChecked = false);
      if (ownerKey === ev.owner_token) return (ownerChecked = true);
      const { data: adm } = await db(() => supabase.from("event_admins").select("id")
        .eq("event_id", ev.id).eq("key", ownerKey).is("revoked_at", null).maybeSingle());
      if (adm) supabase.from("event_admins").update({ last_seen_at: now }).eq("id", adm.id).then(() => {}, () => {});
      return (ownerChecked = !!adm);
    };
    const notOwner = () => json(401, { ok: false, error: "owner token required" });

    // ---------------- remove (guest takes back their own photo → outtakes, never deleted) ----------------
    if (body.action === "remove") {
      if (!deviceKey) return json(400, { ok: false, error: "no device key" });
      const uploadId = String(body.uploadId || "");
      if (!ID_RE.test(uploadId)) return json(400, { ok: false, error: "bad uploadId" });
      const { data: row, error: gErr } = await supabase.from("media")
        .select("id, device_key, outtake_at").eq("event_id", ev.id).eq("upload_id", uploadId).maybeSingle();
      if (gErr) throw gErr;
      if (!row || row.device_key !== deviceKey) return json(404, { ok: false, error: "not found" });
      if (!row.outtake_at) {
        const { error: uErr } = await supabase.from("media").update({ outtake_at: new Date().toISOString() }).eq("id", row.id);
        if (uErr) throw uErr;
      }
      return json(200, { ok: true, uploadId });
    }

    // ---------------- album (anyone with the event link): approved, not private — only once the couple turns it on ----------------
    if (body.action === "album") {
      if (!ev.album_public) return json(403, { ok: false, error: "the album isn't ready yet", albumPublic: false });
      const limit = Math.min(Math.max(parseInt(String(body.limit ?? 60), 10) || 60, 1), 200);
      const offset = Math.max(parseInt(String(body.offset ?? 0), 10) || 0, 0);
      const { data: rows, count, error: lErr } = await db(() => supabase.from("media")
        .select("upload_id, storage_path, thumb_path, orig_name, contributor, received_at, kind, duration_s", { count: "exact" })
        .eq("event_id", ev.id).eq("state", "received").eq("hidden", false).eq("private", false)
        .is("outtake_at", null).is("deleted_at", null).not("approved_at", "is", null)
        .order("received_at", { ascending: true }).range(offset, offset + limit - 1));
      if (lErr) throw lErr;
      const list = rows || [];
      const [urlOf, thumbs] = await Promise.all([
        signOriginals(supabase, list, 3600, 21600),
        signMany(supabase, list.filter((r: any) => r.thumb_path).map((r: any) => r.thumb_path), 3600),
      ]);
      const items = list.map((r: any) => {
        const url = urlOf(r);
        const who = sanitizeText(r.contributor, 60);
        return { id: r.upload_id, kind: r.kind || "photo", duration: r.duration_s ?? null, contributor: who, at: r.received_at, url,
          thumbUrl: r.thumb_path ? (thumbs.get(r.thumb_path) || null) : null,
          downloadUrl: url ? `${url}&download=${encodeURIComponent(downloadName(who, r.orig_name, r.upload_id))}` : null };
      }).filter((i: any) => i.url);
      const total = count ?? items.length;
      const { data: who } = await supabase.from("media").select("contributor, kind")
        .eq("event_id", ev.id).eq("state", "received").eq("hidden", false).eq("private", false).is("outtake_at", null)
        .is("deleted_at", null).not("approved_at", "is", null);
      const people = new Set((who || []).map((r: any) => sanitizeText(r.contributor, 60).toLowerCase()).filter(Boolean)).size;
      const videos = (who || []).filter((r: any) => r.kind === "video").length;
      return json(200, { ok: true, title: ev.title, total, videos, contributors: people, offset, limit,
        truncated: offset + list.length < total, items });
    }

    // ---------------- video_interest (old page: guest has videos; the couple sends a link later) ----------------
    if (body.action === "video_interest") {
      const contact = sanitizeText(body.contact, 120);
      if (!(/@/.test(contact) || contact.replace(/\D/g, "").length >= 7))
        return json(400, { ok: false, error: "please enter an email or phone number" });
      const name = sanitizeText(body.name, 60) || null;
      if (deviceKey) {
        const { count } = await supabase.from("video_requests").select("id", { count: "exact", head: true })
          .eq("event_id", ev.id).eq("device_key", deviceKey).is("link", null);
        if ((count || 0) >= 3) return json(200, { ok: true, already: true });
      }
      const { error: vErr } = await supabase.from("video_requests").insert({ event_id: ev.id, name, contact, device_key: deviceKey });
      if (vErr) throw vErr;
      return json(200, { ok: true });
    }

    // ---------------- video_link (guest): a video over the cap, shared as an iCloud / Drive / Dropbox link ----------------
    if (body.action === "video_link") {
      const link = cleanLink(body.link);
      if (!/^https?:\/\/[^\s]{4,}$/i.test(link)) return json(400, { ok: false, error: "please paste the whole link (it starts with https://)" });
      const contact = sanitizeText(body.contact, 120) || null;
      const name = sanitizeText(body.name, 60) || null;
      if (deviceKey) {
        const { count } = await supabase.from("video_requests").select("id", { count: "exact", head: true })
          .eq("event_id", ev.id).eq("device_key", deviceKey).not("link", "is", null);
        if ((count || 0) >= 20) return json(200, { ok: true, already: true });
      }
      const { error: vErr } = await supabase.from("video_requests").insert({ event_id: ev.id, name, contact, link, device_key: deviceKey });
      if (vErr) throw vErr;
      return json(200, { ok: true });
    }

    // ---------------- booth_config (event link): printer switch + one-shot commands ----------------
    // The Mac print worker and the booth iPad poll this; with the booth key they also report status.
    if (body.action === "booth_config") {
      const { data: st0 } = await db(() => supabase.from("booth_settings").select("*").eq("event_id", ev.id).maybeSingle());
      let st: any = st0;
      if (!st) {
        await supabase.from("booth_settings").upsert({ event_id: ev.id }, { onConflict: "event_id", ignoreDuplicates: true });
        st = (await supabase.from("booth_settings").select("*").eq("event_id", ev.id).maybeSingle()).data || {};
      }
      const report: Record<string, unknown> = {};
      if (body.workerKey === BOOTH_KEY && body.worker && typeof body.worker === "object") {
        report.worker = smallJson(body.worker); report.worker_seen_at = now;
      }
      if (body.boothKey === BOOTH_KEY && body.booth && typeof body.booth === "object") {
        report.booth = smallJson(body.booth, 4000); report.booth_seen_at = now;
      }
      if (Object.keys(report).length) await supabase.from("booth_status").upsert({ event_id: ev.id, ...report }, { onConflict: "event_id" });
      return json(200, { ok: true, printMode: st.print_mode || "alternate", printOnly: st.print_only || null,
        resume: { seq: st.resume_seq || 0, printers: st.resume_printers || [], at: st.resume_at || null },
        cameraReset: { seq: st.camera_reset_seq || 0, at: st.camera_reset_at || null },
        reload: { seq: st.reload_seq || 0, at: st.reload_at || null } });
    }

    // ---------------- status (owner only): counts computed in the database ----------------
    if (body.action === "status") {
      if (!ownerKey) return notOwner();
      const [{ data: s, error: sErr }, { data: recent }] = await Promise.all([
        db(() => supabase.rpc("uploader_owner_status", { p_token: token, p_owner: ownerKey })),
        supabase.from("media")
          .select("upload_id, contributor, orig_name, byte_size, state, hidden, kind, private, created_at, received_at")
          .eq("event_id", ev.id).is("deleted_at", null).order("created_at", { ascending: false }).limit(25),
      ]);
      if (sErr) throw sErr;
      if (!s?.ok) return refused(s);
      await isOwner(); // records last_seen_at for personal keys
      const contributors: Record<string, number> = {};
      for (const [k, n] of Object.entries(s.contributors || {})) contributors[sanitizeText(k, 60) || "(no name)"] = Number(n) || 0;
      const videos = (s.videos || []).map((v: any) => ({ name: sanitizeText(v.name, 60), contact: sanitizeText(v.contact, 120),
        link: v.link ? cleanLink(v.link) : null, at: v.at }));
      return json(200, { ok: true, title: ev.title, windowOpen, albumPublic: !!s.albumPublic, admin: sanitizeText(s.admin, 60),
        opensAt: s.opensAt || null, closesAt: s.closesAt || null, counts: s.counts, contributors, videos,
        recent: (recent || []).map((r: any) => ({ ...r, contributor: sanitizeText(r.contributor, 60) })) });
    }

    // Every action below is owner-only.
    const OWNER_ACTIONS = ["gallery", "approve", "album_visibility", "hide", "delete", "restore", "purge",
      "booth_overview", "booth_set", "booth_reprint"];
    if (OWNER_ACTIONS.includes(body.action) && !(await isOwner())) return notOwner();

    // ---------------- gallery (owner only): thumbnail, view and download URLs ----------------
    // filter: all (default: everything that isn't an outtake, private included) | unapproved | approved |
    //         hidden | outtakes | deleted | videos | private
    // Deleted items appear only under "deleted". Private items never count as approved/unapproved.
    if (body.action === "gallery") {
      const limit = Math.min(Math.max(parseInt(String(body.limit ?? 300), 10) || 300, 1), 500);
      const offset = Math.max(parseInt(String(body.offset ?? 0), 10) || 0, 0);
      const filter = ["all", "unapproved", "approved", "hidden", "outtakes", "deleted", "videos", "private"].includes(body.filter) ? body.filter
        : (body.outtakes === true ? "outtakes" : "all");
      let q = supabase.from("media")
        .select("upload_id, storage_path, thumb_path, orig_name, contributor, byte_size, content_type, received_at, hidden, outtake_at, approved_at, deleted_at, kind, duration_s, private", { count: "exact" })
        .eq("event_id", ev.id).eq("state", "received");
      if (filter === "deleted") {
        q = q.not("deleted_at", "is", null).order("deleted_at", { ascending: false });
      } else {
        q = q.is("deleted_at", null).order("received_at", { ascending: body.order === "asc" });
        if (filter === "outtakes") q = q.not("outtake_at", "is", null);
        else {
          q = q.is("outtake_at", null);
          if (filter === "approved") q = q.not("approved_at", "is", null).eq("hidden", false).eq("private", false);
          else if (filter === "unapproved") q = q.is("approved_at", null).eq("hidden", false).eq("private", false);
          else if (filter === "hidden") q = q.eq("hidden", true);
          else if (filter === "videos") { q = q.eq("kind", "video"); if (body.includeHidden === false) q = q.eq("hidden", false); }
          else if (filter === "private") { q = q.eq("private", true); if (body.includeHidden === false) q = q.eq("hidden", false); }
          else if (body.includeHidden === false) q = q.eq("hidden", false);
        }
      }
      q = q.range(offset, offset + limit - 1);
      const { data: rows, count, error: gErr } = await db(() => q);
      if (gErr) throw gErr;
      const list = rows || [];
      const [urlOf, thumbs] = await Promise.all([
        signOriginals(supabase, list, 7200, 7200),
        signMany(supabase, list.filter((r: any) => r.thumb_path).map((r: any) => r.thumb_path), 7200),
      ]);
      const items = list.map((r: any) => {
        const url = urlOf(r);
        const who = sanitizeText(r.contributor, 60);
        return {
          uploadId: r.upload_id, name: r.orig_name, contributor: who, bytes: r.byte_size, type: r.content_type,
          kind: r.kind || "photo", duration: r.duration_s ?? null, private: r.private === true,
          at: r.received_at, hidden: !!r.hidden, outtake: !!r.outtake_at, approved: !!r.approved_at,
          deleted: !!r.deleted_at, deletedAt: r.deleted_at || null, url,
          thumbUrl: r.thumb_path ? (thumbs.get(r.thumb_path) || null) : null,
          downloadUrl: url ? `${url}&download=${encodeURIComponent(downloadName(who, r.orig_name, r.upload_id))}` : null,
        };
      }).filter((i: any) => i.url);
      const total = count ?? items.length;
      return json(200, { ok: true, filter, count: items.length, total, offset, limit,
        truncated: offset + list.length < total, items });
    }

    // ---------------- approve / unapprove (owner only): what goes in the public album. Private items are skipped. ----------------
    if (body.action === "approve") {
      const ids = idList(body, 500);
      if (!ids.length) return json(400, { ok: false, error: "no uploadIds" });
      const approved = body.approved !== false;
      const { data: rows, error: aErr } = await supabase.from("media")
        .update({ approved_at: approved ? new Date().toISOString() : null })
        .eq("event_id", ev.id).eq("state", "received").eq("private", false).is("deleted_at", null).in("upload_id", ids).select("upload_id");
      if (aErr) throw aErr;
      const done = (rows || []).map((r: any) => r.upload_id);
      return json(200, { ok: true, approved, uploadIds: done, skipped: ids.filter((id) => !done.includes(id)) });
    }

    // ---------------- album_visibility (owner only): the public album is dark until this is on ----------------
    if (body.action === "album_visibility") {
      const pub = body.public === true;
      const { error: pErr } = await supabase.from("events").update({ album_public: pub }).eq("id", ev.id);
      if (pErr) throw pErr;
      return json(200, { ok: true, albumPublic: pub });
    }

    // ---------------- hide / unhide (owner only; one uploadId or up to 500 uploadIds) ----------------
    if (body.action === "hide") {
      const ids = idList(body, 500);
      if (!ids.length) return json(400, { ok: false, error: "bad uploadId" });
      const hidden = body.hidden !== false;
      const { data: rows, error: hErr } = await supabase.from("media").update({ hidden })
        .eq("event_id", ev.id).is("deleted_at", null).in("upload_id", ids).select("upload_id");
      if (hErr) throw hErr;
      return json(200, { ok: true, uploadId: ids[0], uploadIds: (rows || []).map((r: any) => r.upload_id), hidden });
    }

    // ---------------- delete (owner only): to the Deleted list — nothing is removed ----------------
    if (body.action === "delete") {
      const ids = idList(body, 500);
      if (!ids.length) return json(400, { ok: false, error: "no uploadIds" });
      const { data: rows, error: dErr } = await supabase.from("media").update({ deleted_at: new Date().toISOString() })
        .eq("event_id", ev.id).is("deleted_at", null).in("upload_id", ids).select("upload_id");
      if (dErr) throw dErr;
      return json(200, { ok: true, deleted: (rows || []).map((r: any) => r.upload_id) });
    }

    // ---------------- restore (owner only): back out of the Deleted list, as it was ----------------
    if (body.action === "restore") {
      const ids = idList(body, 500);
      if (!ids.length) return json(400, { ok: false, error: "no uploadIds" });
      const { data: rows, error: rErr } = await supabase.from("media").update({ deleted_at: null })
        .eq("event_id", ev.id).not("deleted_at", "is", null).in("upload_id", ids).select("upload_id");
      if (rErr) throw rErr;
      return json(200, { ok: true, restored: (rows || []).map((r: any) => r.upload_id) });
    }

    // ---------------- purge (owner only, permanent): only items already in Deleted ----------------
    // { uploadIds } for some, { all: true } to empty the Deleted list.
    if (body.action === "purge") {
      const all = body.all === true;
      const ids = all ? [] : idList(body, 500);
      if (!all && !ids.length) return json(400, { ok: false, error: "no uploadIds" });
      let q = supabase.from("media").select("id, upload_id, storage_path, thumb_path")
        .eq("event_id", ev.id).not("deleted_at", "is", null);
      if (!all) q = q.in("upload_id", ids);
      const { data: rows, error: pErr } = await q.limit(500);
      if (pErr) throw pErr;
      await removeRows(supabase, ev.slug, rows || []);
      // { all: true } empties 500 at a time; the page calls again while `more` is true
      return json(200, { ok: true, purged: (rows || []).map((r: any) => r.upload_id), more: all && (rows || []).length === 500 });
    }

    // ---------------- booth_overview (owner): printer switch, worker/booth status, recent prints ----------------
    if (body.action === "booth_overview") {
      const [{ data: st }, { data: status }, jobsRes] = await Promise.all([
        supabase.from("booth_settings").select("*").eq("event_id", ev.id).maybeSingle(),
        supabase.from("booth_status").select("*").eq("event_id", ev.id).maybeSingle(),
        fetch(`${PB_URL}/rest/v1/print_jobs?select=id,status,created_at,printed_at,error,printer,copies,image_path,meta&order=created_at.desc&limit=40`,
          { headers: pbHeaders, signal: AbortSignal.timeout(10000) }).then((r) => r.ok ? r.json() : []).catch(() => []),
      ]);
      const jobs = (Array.isArray(jobsRes) ? jobsRes : []).map((j: any) => ({
        id: j.id, status: j.status, createdAt: j.created_at, printedAt: j.printed_at, error: j.error ? String(j.error).slice(0, 300) : null,
        printer: j.printer || null, copies: j.copies, sessionId: j.meta?.sessionId || null, reprintOf: j.meta?.reprintOf || null,
        target: j.meta?.printer || null,
        url: typeof j.image_path === "string" ? `${PB_URL}/storage/v1/object/public/sessions/${j.image_path}` : null,
      }));
      return json(200, { ok: true,
        settings: { printMode: st?.print_mode || "alternate", printOnly: st?.print_only || null, updatedAt: st?.updated_at || null, updatedBy: st?.updated_by || null },
        worker: status?.worker || null, workerSeenAt: status?.worker_seen_at || null,
        booth: status?.booth || null, boothSeenAt: status?.booth_seen_at || null, now, jobs });
    }

    // ---------------- booth_set (owner): change the printer switch / send a one-shot command ----------------
    if (body.action === "booth_set") {
      const { data: cur } = await supabase.from("booth_settings").select("*").eq("event_id", ev.id).maybeSingle();
      const c: any = cur || {};
      let who = "Owner";
      if (ownerKey !== ev.owner_token) {
        const { data: a } = await supabase.from("event_admins").select("name").eq("event_id", ev.id).eq("key", ownerKey).maybeSingle();
        who = a?.name || "Admin";
      }
      const patch: Record<string, unknown> = { event_id: ev.id, updated_at: now, updated_by: who };
      if (body.printMode !== undefined) {
        if (!["alternate", "only", "pause"].includes(body.printMode)) return json(400, { ok: false, error: "bad printMode" });
        if (body.printMode === "only" && !(typeof body.printOnly === "string" && PRINTER_RE.test(body.printOnly)))
          return json(400, { ok: false, error: "choose a printer" });
        patch.print_mode = body.printMode; patch.print_only = body.printMode === "only" ? body.printOnly : null;
      }
      if (Array.isArray(body.resumePrinters)) {
        const list = body.resumePrinters.map(String).filter((x: string) => PRINTER_RE.test(x)).slice(0, 4);
        if (list.length) { patch.resume_seq = (c.resume_seq || 0) + 1; patch.resume_printers = list; patch.resume_at = now; }
      }
      if (body.resetCamera === true) { patch.camera_reset_seq = (c.camera_reset_seq || 0) + 1; patch.camera_reset_at = now; }
      if (body.reloadBooth === true) { patch.reload_seq = (c.reload_seq || 0) + 1; patch.reload_at = now; }
      const { error: sErr } = await supabase.from("booth_settings").upsert(patch, { onConflict: "event_id" });
      if (sErr) throw sErr;
      return json(200, { ok: true });
    }

    // ---------------- booth_reprint (owner): queue a print sheet again, optionally on a chosen printer ----------------
    if (body.action === "booth_reprint") {
      const jobId = String(body.jobId || "");
      if (!PB_ID_RE.test(jobId)) return json(400, { ok: false, error: "bad jobId" });
      const printer = typeof body.printer === "string" && PRINTER_RE.test(body.printer) ? body.printer : null;
      const jr = await fetch(`${PB_URL}/rest/v1/print_jobs?select=id,image_path,meta,copies&id=eq.${encodeURIComponent(jobId)}`,
        { headers: pbHeaders, signal: AbortSignal.timeout(10000) });
      const job = jr.ok ? (await jr.json())[0] : null;
      if (!job || typeof job.image_path !== "string" || !/^prints\/[\w.-]+\.(png|jpe?g)$/.test(job.image_path))
        return json(404, { ok: false, error: "print not found" });
      const img = await fetch(`${PB_URL}/storage/v1/object/public/sessions/${job.image_path}`, { signal: AbortSignal.timeout(30000) });
      if (!img.ok) return json(502, { ok: false, error: "could not load that print" });
      const bytes = new Uint8Array(await img.arrayBuffer());
      const mime = /\.png$/.test(job.image_path) ? "image/png" : "image/jpeg";
      const id = pbNewId();
      const meta = { ...(job.meta && typeof job.meta === "object" ? job.meta : {}), reprintOf: jobId, ...(printer ? { printer } : {}) };
      if (!printer) delete (meta as any).printer;
      const pr = await fetch(`${PB_URL}/functions/v1/print`, { method: "POST",
        headers: { ...pbHeaders, "Content-Type": "application/json", "x-booth-key": BOOTH_KEY },
        body: JSON.stringify({ id, image: `data:${mime};base64,${bytesToBase64(bytes)}`, copies: 1, meta }),
        signal: AbortSignal.timeout(45000) });
      const pd = await pr.json().catch(() => null);
      if (!pr.ok || !pd?.ok) return json(502, { ok: false, error: pd?.error || `print queue HTTP ${pr.status}` });
      return json(200, { ok: true, jobId: pd.jobId, printer });
    }

    return json(400, { ok: false, error: "unknown action" });
  } catch (e) {
    return json(500, { ok: false, error: String((e as any)?.message || e) });
  }
});
