# Photobooth · V1.0

A browser-based digital photobooth with **cloud + local collection**, ready to
host on a **public URL**.

**V1.0 (Sprint 1):** print-true strips — exactly **2×6" @ 300 DPI** (exported
2×, 1200×3600; square cells for 3-shot) so future printing needs no resample;
countdown beeps + shutter click (WebAudio, no files); `noindex,nofollow` +
`_headers`; upload endpoint hardened (shared booth key + payload validation);
`sessions` table gained query columns (`ai_enabled`, `app_version`, `favorite`,
`tags`, `note`) saved from day one.

- **Booth** — webcam → 3s countdown → 3/4 photos → strip PNG → gallery →
  download. On-device AI background replace (incl. the Lisa & Pete wedding
  backdrop) and strip themes (Classic / Noir / Warm Film / Wedding).
- **Collection** — each session POSTs `{strip, frames[], meta}` to storage.
  On **localhost** it writes **both** local disk *and* the cloud; on a
  **hosted URL** it auto-switches to **cloud-only** (there's no local server
  there). Override with `?collect=local|cloud|both`.
- **Gallery** (`gallery.html`) — reads the cloud by default (`?local=1` for the
  local server). **📱 QR** buttons on both pages show a scannable code for the
  current URL — that's how guests get to it once hosted.

## Run locally

```bash
cd <this-folder>
node server.mjs        # or: python3 server.py
# open http://localhost:8099/
```

`index.html` is the booth (renamed from photobooth.html so the bare URL works
when hosted). The local server serves it at `/` and saves sessions to
`sessions/<id>/{strip.png, frame-N.jpg, metadata.json}`.

**If the status ever shows `💾 local ✗`:** open http://localhost:8099/api/health.
`{"ok":true}` → the right server is running (then check the folder is writable —
macOS sometimes blocks writes in Downloads; move the folder to e.g. ~/photobooth).
An error/404 → you're running a plain static server (or double-clicked the
file); quit it and run `node server.mjs` / `python3 server.py` from this folder.
On the public URL this doesn't apply — uploads go cloud-only.

## Host it publicly (Cloudflare Pages ← GitHub, free)

The repo is the deploy source — every push to `main` auto-deploys:

1. Code lives at **github.com/pfduke02/photobooth**.
2. **dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git**,
   authorize GitHub, pick `pfduke02/photobooth`.
3. Build settings: Framework preset **None**, build command **empty**, build
   output directory **`/`** → Deploy.
4. You get `https://<name>.pages.dev` — HTTPS, so the camera works. On a hosted
   URL the app auto-switches to **cloud-only** collection (no local server
   there); uploads go to Supabase, the gallery reads from it anywhere, and the
   `_headers` file adds `X-Robots-Tag: noindex`.

**Custom domain (later, optional):** DNS is on Cloudflare, so either attach
`photobooth.sternfishmanwedding.com` in Pages → Custom domains (one CNAME), or
mount `sternfishmanwedding.com/photobooth` with a small Worker route. The app
is base-path-safe either way.

## The cloud backend (Supabase project `photobooth`)

In your Supabase account (org "Data Collector"): Storage bucket `sessions`
(strips + frames under `<id>/`), Postgres table `sessions` (metadata — query it
with SQL), Edge Function `session` (receives uploads; CORS `*`). The anon key in
the frontend is public-by-design; strips are readable only via unguessable
per-session IDs. Lock down later with signed URLs/auth if wanted.

## Test it

```bash
npm install playwright
node server.mjs &
node test.mjs && node test_collection.mjs && node test_gallery.mjs \
  && node test_themes.mjs && node test_both.mjs
```

## What's next

Central Park backdrop (needs the photo file); booth polish (boomerang/GIF,
sounds); auth/locking for the gallery. See `ROADMAP.md`.
