# Photobooth

Live booth: **https://photobooth-c7s.pages.dev/**

The active app is in **`photobooth-repo/`**. Its `index.html` matches the deployed site; the root `index.html` is a legacy copy. Cloudflare Pages must publish `photobooth-repo`, not the repository root.

## Saving and printing

Each finished session gets one ID. Its strip, original frames and optional boomerang are saved to the Supabase `photobooth` project (`xjnqnxorqhobikyzshrt`), in the `sessions` bucket and table. This happens whether or not the guest prints.

**Print** composes two matching strips on one 4×6 sheet (2400×3600 pixels). It waits for that session's cloud archive to be confirmed, saves the sheet in Supabase, and creates one `print_jobs` entry linked by `meta.sessionId`. The MacBook Air's worker claims the entry, downloads the image and submits it to the SELPHY using macOS `lp`.

The result screen distinguishes:

- **Saved — Supabase ✓:** the photo archive is confirmed.
- **Queued—waiting for the booth Mac:** Supabase accepted the print request.
- **The booth Mac is preparing your print:** a worker claimed the job.
- **Sent to the SELPHY print queue:** macOS accepted the job. Check the printer for physical completion; paper/ink problems can still stop a queued sheet.
- **Printer needs attention:** the photo archive is safe; the host should check the Air's logs and printer.

Pending sessions and print requests are kept in IndexedDB. They retry every 30 seconds, on reconnect, and when the same site is reopened in the same browser profile. Successful destinations are not resent. Stable session and print IDs avoid duplicates after a lost response. If browser storage is unavailable, the UI says to keep the tab open. Clearing site data/private browsing can remove pending backups. Cloud printing requires internet access; offline requests wait for reconnection.

## Run locally

Use Node.js 22 or newer:

```sh
npm ci
npm start
# Open http://localhost:8099/
```

Local mode saves to `photobooth-repo/sessions/<id>/` and Supabase. Hosted mode saves to Supabase. Override with `?collect=local|cloud|both`. Pressing Print always requests a cloud archive even when local-only collection was selected. `SESSIONS_DIR` can move local storage elsewhere.

## Set up the MacBook Air

1. Connect the SELPHY and add it in **System Settings → Printers & Scanners**.
2. Keep a copy of this repo in a permanent folder on the Air, with Node.js 22+ installed.
3. Check the printer queue name with `lpstat -p`.
4. Stop any manually running old `node printserver.js` process. The installer replaces the existing `com.lisapete.printserver` login agent.
5. From the repo root, run:

```sh
bash install-printserver.sh Canon_SELPHY_CP1500
```

Replace the last argument if `lpstat` shows a different name. The installer builds a launch agent using this Mac's actual paths, starts it immediately, and restarts it at login. The older checked-in plist contains another Mac's path; do not install that file directly.

Keep the Air plugged in, awake and logged in during the event. A browser or iPad can run the booth; the Air must reach Supabase and the SELPHY.

```sh
# Inspect worker output:
tail -f "$HOME/Library/Logs/Photobooth/printserver.log"
# Check pending macOS print jobs:
lpstat -o
# Stop the worker:
launchctl bootout "gui/$(id -u)/com.lisapete.printserver"
# Read/download a pending cloud job without changing its state or printing:
DRY_RUN=1 node printserver.js
```

The worker uses `media=Postcard.Fullbleed`; override `LP_OPTS` for a manual run if needed. Local print receipts live under `~/Library/Application Support/Photobooth/print-spool`. If acknowledgement fails after `lp` accepts a job, the worker retries acknowledgement without printing again. If the Mac crashes during submission, the job can remain `printing`: inspect the macOS queue and physical output before manually requeuing it. Never automatically reset claimed jobs, because that can duplicate a sheet.

## Release order

1. Deploy `supabase/functions/print` with JWT verification **on**. This adds retry-safe IDs while retaining compatibility with the old booth. It uses the existing bucket, table and policies; no database migration is required.
2. Publish the updated `photobooth-repo/` directory to Cloudflare Pages.
3. Update and restart the worker on the MacBook Air. Stop all older worker instances; their non-atomic claims cannot be made safe by a new worker running alongside them.
4. Run one real booth session, check **Supabase ✓**, press Print once, and verify the physical 4×6 sheet. Confirm its `sessions` row and linked `print_jobs` row.

The existing bucket and gallery remain publicly readable by URL. The existing public booth key and anon queue policies are retained; no service-role key is embedded in client code. This change does not redesign gallery or queue authentication.

## Tests

```sh
npm ci
npx playwright install chromium
npm test
```

Tests use a simulated camera, temporary local storage, mocked Supabase requests and a fake `lp` function. They cover upload/reload recovery, partial saves, guest isolation, idempotent print requests, atomic worker claims, dry-run behavior and acknowledgement recovery. They do not send anything to a real printer or change live Supabase data.
