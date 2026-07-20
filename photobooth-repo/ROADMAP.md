# Photobooth — Scope & Learning Roadmap

A personal learning/maker project: a local, browser-based **AI photobooth**.
Runs on a laptop + webcam today; hardware (Pi, Canon, lights, button, kiosk) is
optional and deferred. The point is fun plus learning across web media APIs,
canvas, and applied ML/GenAI.

## Guiding principles

- Ship a working thing at every phase; each phase adds exactly one capability.
- Browser-first — zero install, fast iteration. Add a backend or Python only
  when a feature actually needs it.
- Keep the capture loop stable and treat effects as pluggable (there's an AI
  hook in the capture path already).

## Status — V0.6 (done)

Two concerns, kept separate:

**Booth experience** — preview → 3s countdown → 3/4 shots → strip PNG → gallery
→ download, plus optional on-device AI background replacement (MediaPipe, off by
default).

**Collection system (V0.5)** — a tiny dependency-free local backend
(`server.mjs` or `server.py`) receives each finished session and writes
`sessions/<YYYY-MM-DD_id>/{strip.png, frame-N.jpg, metadata.json}`. Upload is
fire-and-forget: capture never blocks on it, the strip shows/downloads
immediately, and a failed upload shows a Retry while the local copy still works.
The frontend POSTs a JSON `{strip, frames[], meta}` contract to a configurable
endpoint, so it can later repoint at the cloud unchanged.

Verified headlessly (Playwright + simulated webcam): booth capture (3/4 shots),
AI compositing, and the collection pipeline (files on disk + failure path) all
pass — against both the Node and Python servers.

**V0.6 adds** a local **gallery page** (`gallery.html` + a `/api/sessions`
listing) that browses saved sessions — view the strip and the original frames,
re-download either, and export a contact sheet — plus a **wedding backdrop**
("Lisa & Pete · November 7th, 2026") in the background picker. **V0.6.1** adds
selectable **strip themes** — Classic, Noir B&W, Warm Film, and a Lisa & Pete
Wedding strip (gold frames, serif footer) — the first slice of Phase 1 polish.
**V0.7** repoints collection to the **cloud**: a Supabase project (`photobooth`)
with a `sessions` Storage bucket + a `sessions` Postgres table, written by an
Edge Function that accepts the same `{strip, frames[], meta}` contract. Local
disk mode stays available via `?collect=local`. (Phase 3 storage: done.)
**V0.8** is public-URL-ready: `index.html` rename, auto target (localhost→both,
hosted→cloud-only), retry re-sends only failed destinations, 📱 QR share
buttons, and a `photobooth-site.zip` for Cloudflare Pages drag-and-drop deploy.
First real sessions confirmed in the cloud (4 rows + files verified via SQL).
**V1.0 (Sprint 1, per V1-PLAN.md)**: print-true 2×6" strips (1200×3600 export,
square cells for 3-shot), WebAudio countdown/shutter sounds, noindex +
`_headers`, booth-key + payload validation on the Edge Function, and query
columns (`ai_enabled`, `app_version`, `favorite`, `tags`, `note`) in the
sessions table. Deploy target: Cloudflare Pages connected to
github.com/pfduke02/photobooth, interim URL on `*.pages.dev`.

**🚀 LIVE (2026-07-19): https://photobooth-c7s.pages.dev/** — deployed via
Pages direct upload of the repo bundle. Verified end-to-end: real session from
the live site landed in Supabase with `app_version='1.0'` through the hardened
Edge Function (booth key + validation), strip + frames in the bucket, noindex
served. Sprint 1 exit criteria met. Gallery at /gallery.html on the same host.
Repo (github.com/pfduke02/photobooth) is populated. **Decision: custom domain
is deferred to ~V4** — https://photobooth-c7s.pages.dev/ is the URL until then
(QR is the real interface anyway; DNS is on Cloudflare, so attaching
photobooth.sternfishmanwedding.com later is one CNAME).

**V1.1 (shipped):** per-strip **QR on the result screen** (scan → full-res
strip on your phone → save to Photos); Save button uses the native share sheet
on touch devices; **gallery filters** (theme/background/AI/shots/favorites)
with badges + counts; **sync.py** mirrors all cloud sessions to the local
`sessions/` shape (Drive tip: keep the folder inside Google Drive). Fixes:
duplicate session row deleted; filename uses theme-at-capture.

**V1.3 (shipped, unattended block):** ✅ per-shot retake (review screen, tap a
frame to redo, ~12s auto-continue, one upload per session) · ✅ admin mode
(`gallery.html?admin=<key>`: favorite/tags/note editing, two-tap session
delete incl. storage files, 🧹 orphan cleanup — via a service-role `admin`
Edge Function gated by `x-admin-key`) · ✅ gallery date filters (from/to).
7 headless suites green. AI-pack finding: the FaceLandmarker model can't be
vendored from the build sandbox, but browsers can load it at runtime from
Google's CDN — so face props are viable without bundling. Deploys became
**git-connected** (Pages ← github.com/pfduke02/photobooth, build output
`photobooth-repo`) — updating the live site is now just a push/upload to the
repo. Local backup went autopilot: `sync.py --install-auto` installs a launchd
agent (every 30 min) that mirrors the cloud to `~/Photobooth`, keeps a flat
`strips/` summary folder, and copies strips into a local Google Drive folder
when Drive for desktop is present.

**V1.4 (shipped) — Phase 1 complete, 7/7:** ✅ **boomerang** — after the 4th
shot the booth samples ~1.4s of live (AI-composited) frames, plays a ping-pong
loop on the review screen, encodes it with `MediaRecorder`
(mp4 preferred, webm fallback) concurrently while you review, saves it with
the session (local file + cloud storage + `boomerangPath` in metadata), shows
it on the result screen with its own save/share button, and plays it in the
gallery detail view · ✅ **live theme previews** — the review screen grew a
rail of four real mini-strips (your actual shots composited per theme); tap
one to pick the strip theme, restoring theme choice to the guest flow without
un-hiding the old chooser · ✅ **beefier flash** — radial white burst with a
slower decay curve. Review auto-continue tightened 12s → 7s (Pete: "preview
mode is a bit long"); QR caption now includes save instructions ("press &
hold the photo → 'Save to Photos'"). 8 headless suites green
(`test_boomerang.mjs` new: rail rendered + selection recorded in metadata,
boomerang encoded, file on disk, `boomerangPath` present).

**V2.0 (shipped) — Phase 2A, tier A of the AI pack:** ✅ **face props** —
👑/🎩/🕶/🎲 as a second guest picker row (Pete's call, and "DEFINITELY
CROWNS"). MediaPipe FaceLandmarker loaded at runtime from the CDN on first
use, up to 4 faces, props bake into shots/retakes/boomerang; per-shot surprise
rolls recorded in metadata; gallery Prop filter + badges. ✅ **style filters**
— Pop Art + Cyanotype join the review rail as live-previewed strip themes.
✅ result-screen rework (auto-save is the message; download demoted to a small
ghost button; QR caption = full save instructions; review 7s→5s). ✅ live-site
fix: versioned asset URLs + `404.html` end the immutable-cached-HTML-as-JS
failure ("Couldn't load the segmentation model" on the live site). 9 headless
suites green (`test_props.mjs` new, via `?fakeface=1` synthetic landmarks).

**V2.1 (shipped) — 2A polish, all four of Pete's picks:** ✅ **wedding prop
set** — 🌸 flower crown (five blooms on a hairline arc), 🎀 vector bow tie
(chin landmark), 😍 heart eyes; prop row is now 6 props + 🎲. ✅ **Comic**
strip theme — real pixel work (posterize to 4 levels + halftone dot screen),
live in the review rail like the rest. ✅ **per-face surprise chaos** — 🎲
now rolls a different prop for every face (left→right), re-rolled each shot;
rolls recorded as `"crown+hearts"` in metadata. ✅ **background pack v2** —
studio/bokeh/neon regenerated (soft key light / layered golden orbs / glowing
tubes+rings), plus **Autumn** (golden-hour leaves — November wedding) and
**Fireworks**. 9 suites green.

**V2.2 (shipped) — Phase 2B, tier B begins:** ✅ **restyle sidecar** —
`restyle_server.py` (FastAPI, port 8123): 3 OpenCV styles (oil/pencil/
cartoon, ~100 ms) + 2 neural fast-style ONNX models (mosaic/candy, ~0.3–1.5 s
CPU) that auto-download on first run; their fixed 224×224 graphs get patched
to dynamic H×W so they run at real resolution. ✅ booth integration — the
review screen shows "🎨 AI restyle — last shot" when the sidecar is up
(localhost only); the style restyles the **hero frame in place** before
compose/upload (zero contract changes — strip/cloud/gallery all carry it);
always re-restyled from the untouched original; retaking the hero resets it;
`meta.restyle` + `restyleMs` recorded and shown in the gallery. Tier-B
learning goals hit: model serving, ONNX graph surgery, latency budgeting
(downscale-before-style, hero-frame-only). 10 suites green —
`test_restyle.mjs` spawns the real Python sidecar.

**V2.3 (shipped, unattended block):** ✅ **gallery text search** (id/notes/
tags/theme/background/props/restyle, instant, stacks with all filters) ·
✅ **4×6 print sheet** (two strip copies on a 1200×1800 @300dpi PNG with a
dashed cut line — the software half of printing done; what remains is
hardware + a print queue) · ✅ **cloud audit**: 0 security lints, 0
performance lints, 11 sessions (app versions 1.0/1.3/2.0), 61 files / 65 MB
in storage, 1 known orphan prefix (Pete's 🧹 admin button clears it).

## Next steps (agreed order)

1. **Phase 2B stretch** — swap a real diffusion img2img (Stable Diffusion /
   ControlNet via diffusers on Apple Silicon MPS) into the same `/restyle`
   endpoint; prompt-driven styles ("oil painting of us", "anime poster").
   Needs Pete's Mac (models are GB-scale — won't fit the build sandbox).
2. Restore the shots (3/4) and mirror choosers when wanted — hidden since
   V1.2, each a one-line `display:none` removal (theme choice is back via the
   V1.4 review rail).
3. **Central Park backdrop** — blocked on receiving the proposal photo file.
4. **Printing (hardware half)** — Canon SELPHY per HARDWARE.md; the 4×6
   print sheet is ready for it as of V2.3.
5. (~V4) custom domain; remaining hardware per HARDWARE.md.

Files: `index.html` (app), `gallery.html`, `server.mjs`/`server.py` (local
backend), `sync.py` (cloud→local mirror + auto-sync), `test*.mjs` (8 headless
suites), `README.md` (how to run).

### V0 architecture, in one breath

`getUserMedia` → `<video>` preview → on capture, draw a center-cropped video
frame to a canvas (`grabFrame`) → stack the frames + footer onto a 2× canvas
and `toDataURL` a PNG (`composeStrip`) → persist to a guarded `localStorage`
gallery. Trigger is a button + Space/Enter (arcade-button-ready).

## Phase 1 — Polish the core (browser only) — STATUS: 7 / 7 ✅ COMPLETE

✅ Strip themes (V0.6.1) · ✅ live theme preview (V1.4 review rail — real
mini-strips of your shots, tap to choose) · ✅ per-frame retake (V1.3) ·
✅ countdown/shutter sounds (V1.0) · ✅ beefier flash (V1.4) · ✅ boomerang
via `MediaRecorder` (V1.4 — the last learning goal of the phase) ·
✅ QR-to-phone (V1.1, exceeded: per-strip QR + share sheet).

## Phase 2 — AI effects (the "AI photobooth")

The meaty part. Pick an implementation tier **per feature** — it's the
privacy / cost / quality triangle:

- **A. On-device, in-browser** (no server, private, free): background
  removal/replace with MediaPipe Selfie Segmentation or `transformers.js`
  (RMBG/MODNet); face landmarks + AR props (hats, glasses) with MediaPipe
  FaceLandmarker; style filters via WebGL/WebGPU shaders (LUTs, halftone,
  comic) or a small style-transfer model on TF.js / onnxruntime-web. *Learn:*
  WebGL/WebGPU, on-device inference, segmentation masks, compositing.
- **B. Local Python sidecar** (more power, still local/free): a tiny
  FastAPI/Flask endpoint the browser POSTs frames to — `rembg`, Real-ESRGAN
  upscale, GFPGAN face-restore, or local Stable Diffusion img2img/ControlNet
  for "restyle me as an oil painting / anime / vintage." *Learn:* model
  serving, img2img/ControlNet, latency budgeting, GPU vs CPU.
- **C. Hosted GenAI API** (least infra, costs money, best quality): call an
  image model for high-quality themed restyles, or an LLM for funny captions.
  *Learn:* API integration, prompt design for image edits, cost/rate limits,
  safety.

**Suggested path:** start with **A → background swap + face props** (instant
wow, no server), then try **B → a local img2img restyle** to learn the GenAI
stack, then optionally **C** for quality. Wire any of these into the existing
`grabFrame()` hook. Latency tip: a 4-shot strip × a few seconds each adds up —
consider restyling one "hero" frame rather than all four.

## Phase 3 — Persistence & sharing (cloud)

Supabase (Postgres + Storage): upload strips to a bucket, a shareable gallery
link + QR, optional per-event grouping. *Learn:* object storage, row-level
security, signed URLs, a minimal backend. (Supabase is already available as a
connector in this workspace when you want it.)

## Phase 4 — Hardware (optional, whenever)

See `HARDWARE.md`. Highest fun-per-dollar order: **lighting → external webcam
(Logitech C920) → tablet → arcade button** (a USB "Zero-Delay" encoder makes
the button send a keypress — the app already starts on Space, so this is nearly
free) **→ Raspberry Pi kiosk** (the Pi's GPIO can read the button directly) **→
Canon camera via gPhoto2** (big image-quality jump) **→ printing** (Canon
SELPHY, two 2×6 strips per 4×6 sheet). *Learn:* Linux kiosk mode, GPIO,
tethered capture, dye-sub printing.

## Decisions to make (when you reach them)

Effects on-device vs server vs API (privacy/cost/quality). Local-only vs cloud
storage. If GenAI restyle: which model and acceptable latency. Camera pipeline:
stay on webcam (`getUserMedia`) or tether a DSLR via gPhoto2 for a real quality
jump at the cost of complexity.

## Good next step

Pick one Phase-2A effect — background replace is the classic crowd-pleaser —
and I'll wire it into `grabFrame()` so it composites live into every shot.
