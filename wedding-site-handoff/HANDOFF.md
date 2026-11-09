# Photos & videos uploader — what changed and how to ship it (2026-11-09)

Everything in this folder is a drop-in for the `pfduke02/sternfishmanwedding` repo
(the site Cloudflare Pages publishes as sternfishmanwedding.com). The backend parts are
**already live** in Supabase project `wedding-uploader` (`hseupjbneifqxaykxltt`); the
frontend parts wait for a push to the repo.

## Already done in Supabase (nothing to do)

| What | Where | Status |
|---|---|---|
| Safety net for stranded uploads (`uploader_reconcile`, every 10 min) | migration `20261108234651_uploader_reconcile_sweep` | applied; recovered 8 real wedding photos on 2026-11-08 |
| Video support: `events.max_video_bytes`, `media.kind` / `duration_s`, resumable-upload storage policies, `video_requests.link`, bucket limit 2 GiB | migration `20261109000259_video_support` | applied |
| Private ("family only") uploads: `media.private` | migration `20261109011856_media_private` | applied |
| Event settings: `wedding` batch 25, cap 150 GB; `demo` album on | data | applied |
| Edge function `api` v12 | `supabase/functions/api/index.ts` | deployed to `api` (staging copy `api-next` can be deleted) |

## One dashboard setting (Pete)

Supabase → project **wedding-uploader** → **Project Settings → Storage → Upload file size limit**
→ **2048 MB**. Until this is raised, storage refuses anything over 50 MB (videos show
"The server refused this size"). Everything else is in place.

## Files to copy into the repo

```
photos/index.html          ← bundle/photos/index.html        (guest page, rewritten)
photos/album/index.html    ← bundle/photos/album/index.html  (album: videos play, counts)
photos/admin/index.html    ← bundle/photos/admin/index.html  (admin: Videos/Private filters, links)
photos/tus.min.js          ← bundle/photos/tus.min.js        (tus-js-client 4.3.1, vendored)
supabase/functions/api/index.ts
supabase/migrations/20261108234651_uploader_reconcile_sweep.sql
supabase/migrations/20261109000259_video_support.sql
supabase/migrations/20261109011856_media_private.sql
```

The paths assume the repo serves `/photos/`, `/photos/admin/` and `/photos/album/` from
`photos/index.html`, `photos/admin/index.html`, `photos/album/index.html` (that is how the
live site answers). If the repo keeps them elsewhere, put each file where the live one lives.
The guest page loads `/photos/tus.min.js` by absolute path.

## What the guest page does now

- "Share your photos & videos"; post-wedding wording; "Choose photos & videos" (`image/*,video/*`).
- **Who can see these?** Everyone (couple picks the album) · Just the family (never in the album).
  Remembered per phone; tiles carry a 🔒 badge.
- Photos ≤ 50 MB: same signed PUT as before. **Videos ≤ 2 GB: chunked, resumable** upload
  (6 MB chunks, retries, stall watchdog); a poster frame and the duration are made on the phone.
- Over 2 GB: the tile says so and opens **"Video too big? Share a link instead"** → the guest
  pastes an iCloud / Drive / Dropbox link, listed for admins under "Video links & requests".
- **Stalled uploads re-ask themselves**: each file gets its own `complete` call; picked files
  (≤ 512 MB) stay on the phone until Received, so a return visit shows "N of your files didn't
  finish — Send them now"; the server also names unfinished files so "Choose them again"
  resumes a big video from where it stopped (same uploadId, same tus fingerprint).
- Duplicate detection unchanged (big files are fingerprinted by head + tail + size).

## Tests (run from this folder's parent, `scratchpad/`)

```
NODE_USE_ENV_PROXY=1 node tests/e2e-guest.mjs          # real page + real backend, demo event
OWNER=<demo owner key> NODE_USE_ENV_PROXY=1 node tests/e2e-album-admin.mjs
NODE_USE_ENV_PROXY=1 node tools/smoke-api.mjs          # API-level
```

They run against the `demo` event (`?e=12d4d64f73d342f2865aaa28`), never `wedding`.

## Rollout

1. Pete raises the upload limit (above). 2. Push the files; Cloudflare Pages deploys.
3. Open sternfishmanwedding.com/photos on an iPhone and an Android phone: one photo, one short
   video, one video over a minute; check the admin page; approve; check the album.
4. First wave (Lisa): the guests who asked for a video link on the night (Melissa Schwartz,
   Kristen, Issy) + wedding party. Watch /photos/admin for an hour. 5. Everyone.
6. Later: set a close date (`events.ends_at`) and announce it; purge the `loadtest` event
   (10 GB of synthetic data); delete the `api-next` function.

## Draft for Lisa (text or email)

> Hi everyone — thank you for celebrating with us! If you took photos or videos on the day,
> we'd love to have them. One link, no app, no sign-in:
>
> **sternfishmanwedding.com/photos**
>
> Pick as many as you like — photos and videos (up to 2 GB each). Add your name so we know
> who to thank. You can also mark anything "just for the family" if it's not for the shared
> album. Everything goes straight to us; we'll add our favorites to the album at
> sternfishmanwedding.com/photos/album.
>
> With love, Lisa & Pete

## Running the tests from this folder

```
cd wedding-site-handoff/tools && npm i          # tus-js-client + playwright
cd .. && mkdir -p tests/node_modules && ln -sfn ../../tools/node_modules/playwright tests/node_modules/playwright
NODE_USE_ENV_PROXY=1 node tests/e2e-guest.mjs   # drop NODE_USE_ENV_PROXY outside the Claude sandbox
```

Test media is generated with ffmpeg on each run (unique content, so the server's duplicate
detection does not short-circuit the uploads).
