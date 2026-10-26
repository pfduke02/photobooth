# Backend — Supabase project `photobooth`

Ref `xjnqnxorqhobikyzshrt` · org "Data Collector" · us-east-1. Pulled from the
deployed project on 2026-10-25 so the backend lives in git. Nothing in this
folder is published by Cloudflare (only `photobooth-repo/` is).

| Path | Deployed as | What it does |
|---|---|---|
| `migrations/` | migration history | `sessions` table + public `sessions` bucket; query columns; `print_jobs` queue. |
| `functions/session` | v4 | Upload endpoint. Booth-key gated; writes strip/frames/boomerang to the bucket and upserts `public.sessions`. |
| `functions/print` | v1 | Enqueues a 4×6 sheet: uploads to `sessions/prints/`, inserts a pending `print_jobs` row for `printserver.js`. |
| `functions/admin` | v1 | Gallery admin: favorite/tags/note, delete, orphan GC. |

## Deploy

```bash
supabase link --project-ref xjnqnxorqhobikyzshrt
supabase secrets set ADMIN_KEY=<current admin key>   # once, before deploying admin
supabase functions deploy session print admin
```

`functions/admin` reads its key from the `ADMIN_KEY` secret. The deployed v1
still has the key inline (it was never in git); set the secret to that same
value before redeploying so the key stored in the gallery keeps working.

## Known issues (not changed here)

- The booth key ships in the public booth page, so it deters casual misuse
  only. Anyone who reads the page source can upload sessions or queue prints.
- `print_jobs` grants anon `UPDATE` on every column, so anyone with the public
  anon key can edit jobs (e.g. reset a done job to pending, raise `copies`).
- `admin` `gc` treats the `prints/` folder as an orphan and deletes print
  sheets; `delete` leaves the boomerang file behind for `gc` to sweep.

## Not in git on purpose

The `spike` and `cors-probe` functions and the empty `spike` bucket on this
project are throwaway R&D for the wedding-uploader app (iPhone upload and Drive
CORS probes, 2026-07-30). Both functions run with JWT verification off. Safe to
delete. The cake-ballot migration pair (applied to this project by mistake and
reverted, 2026-09-20) is also omitted; its net effect is zero.
