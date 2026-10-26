# Photobooth — Lisa & Pete, Nov 7 2026

Live booth: https://photobooth-c7s.pages.dev/ · gallery: `/gallery.html`

Cloudflare Pages auto-deploys every push to `main`, serving **only**
`photobooth-repo/` (build output directory). Anything committed there is public.

| Path | What |
|---|---|
| `photobooth-repo/` | The web app: booth (`index.html`), gallery, assets, local servers, tests. Full docs: [`photobooth-repo/README.md`](photobooth-repo/README.md). |
| `supabase/` | Backend source: migrations + Edge Functions. See [`supabase/README.md`](supabase/README.md). |
| `printserver.js` | Mac print server. Polls the Supabase `print_jobs` queue and prints each 4×6 sheet to the SELPHY via `lp`. Node built-ins only. |
| `run-printserver.sh`, `com.lisapete.printserver.plist` | launchd wrapper; the plist expects this repo at `~/Code/photobooth`. Log: `printserver.log`. |
| `deploy.sh` | Commit + push = deploy. Refuses to commit guest data. |

## Print server

```bash
lpstat -p                                              # SELPHY queue name
PRINTER=Canon_SELPHY_CP1500 DRY_RUN=1 node printserver.js   # poll + download, no printing
cp com.lisapete.printserver.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lisapete.printserver.plist
```

## Guest data

`sync.py` and `server.mjs` write guest photos to `photobooth-repo/sessions/` and
`photobooth-repo/strips/`. Both are gitignored, and `deploy.sh` aborts if they
are ever staged, because a commit there would publish them on the live site.
