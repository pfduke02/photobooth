#!/bin/bash
# One-command deploy: commit + push the booth so Cloudflare rebuilds.
# Pushing to main IS the deploy (Cloudflare Pages serves photobooth-repo/).
set -e
cd "$(dirname "$0")"
git add -A

# Guard: guest photos must never reach this public repo / the live site.
if git diff --cached --name-only | grep -qE '(^|/)(sessions|strips|prints|models)/'; then
  echo "ABORT: guest data or models staged — check .gitignore. Unstaging."
  git reset -q
  exit 1
fi

if git diff --cached --quiet; then
  if [ -z "$(git log '@{u}..' --oneline 2>/dev/null)" ]; then echo "Nothing new to deploy."; exit 0; fi
  echo "Pushing earlier unpushed commit(s)."
else
  echo "Deploying:"; git diff --cached --name-status | sed 's/^/  /'
  git commit -m "update booth $(date '+%Y-%m-%d %H:%M')" >/dev/null
fi
git pull --rebase --quiet          # pick up changes pushed from other machines first
git push && echo "Deployed — Cloudflare rebuilds in ~1-2 min."
