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

Next: a **public, shareable gallery URL + QR** — the last piece, which needs
hosting the static folder (e.g. Cloudflare Pages / Netlify) so guests can reach
it from their phones; remove the couple from the Central Park photo to add as a
backdrop (needs the file); more booth polish (QR-to-phone, boomerang/GIF).

Files: `photobooth.html` (app), `test.mjs` (headless test), `README.md` (how to
run), plus `sample_strip.png` / `app_screenshot.png` from the test run.

### V0 architecture, in one breath

`getUserMedia` → `<video>` preview → on capture, draw a center-cropped video
frame to a canvas (`grabFrame`) → stack the frames + footer onto a 2× canvas
and `toDataURL` a PNG (`composeStrip`) → persist to a guarded `localStorage`
gallery. Trigger is a button + Space/Enter (arcade-button-ready).

## Phase 1 — Polish the core (browser only)

Strip layouts/themes and a live preview of them; per-frame retake; a
countdown/flash sound and a beefier flash; a **boomerang/GIF** mode via
`MediaRecorder`; a **QR code** so a phone can grab the strip. *Learn:* canvas
detail, `MediaRecorder`, small UX touches.

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
