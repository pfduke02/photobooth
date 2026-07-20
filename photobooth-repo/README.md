# Photobooth · V2.4

A browser-based digital photobooth with **cloud + local collection**, live at
**https://photobooth-c7s.pages.dev/**.

**V1.0 (Sprint 1):** print-true strips — exactly **2×6" @ 300 DPI** (exported
2×, 1200×3600; square cells for 3-shot) so future printing needs no resample;
countdown beeps + shutter click (WebAudio, no files); `noindex,nofollow` +
`_headers`; upload endpoint hardened (shared booth key + payload validation);
`sessions` table gained query columns (`ai_enabled`, `app_version`, `favorite`,
`tags`, `note`) saved from day one.

**V1.1:** after the strip saves to the cloud, the result screen shows a **QR of
that strip** — scan it on a phone to open the full-res PNG and save it to
Photos. The Save button uses the native **share sheet on phones** (download on
desktop). The **gallery grew filters** (theme / background / AI / shots /
favorites) with badges and counts. **`sync.py`** mirrors every cloud session to
the local `sessions/` folder shape — idempotent, stdlib-only:

```bash
python3 sync.py     # pull strip + frames + metadata.json for every session
```

`sync.py --install-auto` installs a launchd agent that runs the sync every 30
minutes (log: `sync.log`); it also keeps a flat `strips/` folder (every strip
as one PNG) and copies strips into a local **Google Drive** "Photobooth
Strips" folder when Drive for desktop is installed.

**Updating the live site** (git-connected): replace the `photobooth-repo/`
folder in **github.com/pfduke02/photobooth** with the new unzipped
`photobooth-repo` (GitHub → Add file → Upload files → drag the folder →
Commit). Cloudflare Pages auto-builds from `main` (build output directory
`photobooth-repo`).

**V1.2:** simplified guest UI — Background is the only choice; 4 shots fixed
(shots/mirror/theme choosers hidden, each a one-line restore).

**V1.3:** **per-shot retake** — after the 4th shot, a review screen shows the
frames; tap one to redo it (countdown reruns for that slot). Auto-continues
after ~12s so an abandoned booth still finishes, and there's exactly one
upload per session (retakes happen before compose/upload). **Admin mode** —
open `gallery.html?admin=<ADMIN_KEY>` once (key stored locally, URL cleaned;
`?admin=off` to sign out): edit ♥ favorite / tags / note, **🗑 delete a
session** (files + record, two-tap confirm), and **🧹 clean orphans** (storage
folders with no session record). Backed by a service-role `admin` Edge
Function gated by `x-admin-key` — the key ships only to Pete, never in the app.
**Gallery date filters** (from/to) join the filter bar.

**V1.4 — Phase 1 complete (7/7):** **Boomerang** — after the last shot the
booth samples ~1.4s of live frames (AI backdrop included), shows a ping-pong
preview on the review screen, encodes an mp4/webm with `MediaRecorder` while
you review, saves it with the session (local + cloud), and gives it its own
save/share button on the result screen; it also plays in the gallery detail
view. **Live theme previews** — the review screen shows four real mini-strips
of *your* shots, one per theme; tap to choose (theme choice is back in the
guest flow). **Beefier flash**, review auto-continue **12s → 7s**, and the QR
caption now says how to save on a phone (press & hold → "Save to Photos").

**V2.0 — Phase 2A, the AI pack begins:** **Face props** — a second guest
picker (👑 crown · 🎩 top hat · 🕶 sunglasses · 🎲 surprise = a new random
prop every shot). Landmarks come from MediaPipe **FaceLandmarker**, loaded at
runtime from the CDN the first time someone picks a prop (nothing on page
load; a failed load just disables props — capture never depends on it). Props
track up to **4 faces**, render live in the preview, and bake into shots,
retakes, and the boomerang. 👑/🎩 are emoji sized ≈ head width; 🕶 is
vector-drawn so the lenses align exactly with the eyes. The chosen prop (and
the per-shot surprise rolls) land in metadata, the gallery gets a **Prop
filter** + badges. **Two new strip styles** in the review rail: **Pop Art**
and **Cyanotype** (pure canvas filters, live-previewed like the rest).
**Result screen reworked** per Pete: saving is automatic, so "Take another"
is the primary button, download is a small ghost button ("⬇ Download to this
device" / share sheet on phones), and the QR caption carries full
instructions (scan → strip opens on your phone → press & hold → Save to
Photos). Review auto-continue **7s → 5s**. **Live-site cache fix:** asset
URLs are versioned (`?v=`) and a real `404.html` disables the Pages SPA
fallback — early deploys had let browsers immutable-cache the homepage HTML
*as* the model script, which broke background replace until a hard reload.
Headless testing: `?fakeface=1` feeds synthetic landmarks so the prop
pipeline is testable without a real face (`test_props.mjs`).
**V2.0.1** makes toasts click-transparent (a faded toast was invisibly
blocking the result screen's Close button).

**V2.4 — design polish + link audit:** the idle screen now reads like a
booth — one **big pulsing 📸 Start**, the guest's two choices labeled
(**BACKGROUND** / **PROPS**), and Pete-facing utilities (Gallery / QR /
collection status) demoted to a quiet row below. The **review screen is
full-screen** (it was clipped to the camera box on phones, hiding the theme
rail and confirm button), scrolls safely on small screens, and the boomerang
preview got a label. Result modal de-duplicated ("saved" is said once, by the
live status line). **`test_links.mjs`** joins the suite: crawls both pages,
verifies ~97 same-origin links/assets (incl. every backdrop + mediapipe model
file) return 200, health endpoint is ok, and unknown paths 404.

**V2.3 — gallery upgrades:** **🔎 text search** in the filter bar — matches
id, notes, tags, theme, background, props (incl. per-shot surprise rolls),
and restyle, instantly, combinable with every other filter. **🖨 4×6 print
sheet** — one click in the session detail composes TWO copies of the strip
onto a 1200×1800 (4×6" @300dpi) PNG with a dashed cut line: the standard
photobooth print format, ready for a Canon SELPHY or any photo printer.

**V2.2 — Phase 2B, the model sidecar:** a local Python model server
(`restyle_server.py`, FastAPI on `127.0.0.1:8123`) the booth discovers
automatically when running on localhost. The review screen gains **"🎨 AI
restyle — last shot"**: Oil paint / Pencil / Cartoon (OpenCV, ~100 ms) and
**Mosaic / Candy** (ONNX fast-neural-style, ~0.3–1.5 s CPU — the models
auto-download on first run, and their fixed 224×224 graphs are patched to
dynamic H×W so they run at real resolution). The chosen style restyles the
**hero frame (the last shot) in place** before compose/upload — strip, cloud,
and gallery all carry it with zero contract changes; switching styles always
re-restyles from the untouched original; retaking the hero resets it.
Restyle is **localhost-only** (the hosted site never probes the sidecar), and
capture never depends on it. Run it:

```bash
pip3 install -r requirements-restyle.txt
python3 restyle_server.py    # alongside node server.mjs
```

**V2.1 — 2A polish:** wedding props — **🌸 flower crown, 🎀 bow tie (vector,
chin-anchored), 😍 heart eyes** join 👑🎩🕶; **🎲 is now per-face chaos**
(each face gets its own random prop, new roll every shot, recorded like
`"crown+hearts"` in metadata). New **Comic** strip theme with real pixel work
(4-level posterize + halftone dot screen — not a CSS filter). Backgrounds:
**studio / bokeh / neon regenerated** at higher quality, and two new
backdrops — **Autumn** (golden-hour leaves, for a November wedding) and
**Fireworks**.

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
  && node test_themes.mjs && node test_both.mjs && node test_retake.mjs \
  && node test_admin.mjs && node test_boomerang.mjs && node test_props.mjs \
  && node test_restyle.mjs && node test_links.mjs
```

(`test_restyle.mjs` spawns the real Python sidecar — true end-to-end.)

## What's next

Phase 2B stretch — swap a diffusion img2img (Stable Diffusion / ControlNet)
into the same `/restyle` endpoint; gallery text search; printing (strips are
already print-true 2×6" @300dpi). Central Park backdrop still needs the photo
file. See `ROADMAP.md`.
