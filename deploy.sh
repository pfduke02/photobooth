#!/bin/bash
# One-command deploy: commit + push the booth so Cloudflare rebuilds.
cd "$(dirname "$0")" || exit 1
git add -A
if git diff --cached --quiet; then echo "Nothing new to deploy."; exit 0; fi
git commit -m "update booth $(date '+%Y-%m-%d %H:%M')" >/dev/null
git push && echo "Deployed — Cloudflare rebuilds in ~1-2 min."
