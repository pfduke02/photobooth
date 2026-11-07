#!/bin/bash
# One-paste fix for the booth Mac. Run from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/pfduke02/photobooth/main/fix-printing.sh | bash
# It finds the photobooth folder (from the installed print worker), switches it to the
# latest code, restarts the worker for all SELPHYs, and says plainly whether it worked.
# It never prints anything and never deletes guest photos.
set -u
say()  { printf '%s\n' "$*"; }
good() { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*"; }
fail() { printf '  ❌ %s\n' "$*"; }
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

say "== Finding the photobooth folder"
AGENT="$HOME/Library/LaunchAgents/com.lisapete.printserver.plist"
REPO=""
if [ -f "$AGENT" ]; then
  JS="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$AGENT" 2>/dev/null || true)"
  [ -n "$JS" ] && REPO="$(dirname "$JS")"
fi
for d in "$REPO" "$PWD" "$HOME/photobooth" "$HOME/Documents/photobooth" "$HOME/Desktop/photobooth" \
         "$HOME/Downloads/photobooth" "$HOME/Documents/GitHub/photobooth" "$HOME/code/photobooth" "$HOME/dev/photobooth"; do
  if [ -n "$d" ] && [ -f "$d/printserver.js" ] && [ -d "$d/.git" ]; then REPO="$d"; break; fi
  REPO=""
done
if [ -z "$REPO" ]; then
  JS="$(find "$HOME" -maxdepth 5 -name printserver.js -path '*photobooth*' -not -path '*/node_modules/*' 2>/dev/null | head -1)"
  [ -n "$JS" ] && [ -d "$(dirname "$JS")/.git" ] && REPO="$(dirname "$JS")"
fi
if [ -z "$REPO" ]; then
  fail "Couldn't find the photobooth folder. cd into it and run: bash fix-printing.sh"
  exit 1
fi
cd "$REPO" || exit 1
good "using $REPO"

say "== Getting the latest code"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git stash push -m "fix-printing $(date '+%Y-%m-%d %H:%M')" >/dev/null 2>&1 \
    && warn "you had edited files; they're saved (git stash list) so the update could go ahead" \
    || { fail "local edits are blocking the update — run: git status"; exit 1; }
fi
if ! git fetch -q origin main; then fail "couldn't reach GitHub — check the Wi-Fi (Bacco Secure) and run this again"; exit 1; fi
git checkout -q -B main origin/main || { fail "couldn't switch to the latest code"; exit 1; }
good "code: $(git log --oneline -1)"
VER="$(grep -o "const VERSION = '[^']*'" printserver.js | cut -d"'" -f2)"
[ "$VER" = "3.0" ] && good "print worker version $VER" || warn "print worker version '$VER' (expected 3.0)"

say "== Checking Node.js"
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'; then
  fail "Node.js 22 or newer is required (found: $(node -v 2>/dev/null || echo none)). Install it from nodejs.org, then run this again."
  exit 1
fi
good "node $(node -v)"

say "== Restarting the print worker (all SELPHYs)"
bash install-printserver.sh || { fail "installer failed — see the message above"; exit 1; }

say "== Waiting 20 seconds for it to report in…"
sleep 20
LOG="$HOME/Library/Logs/Photobooth/printserver.log"
STARTED="$(grep -c 'print worker 3.0 started' "$LOG" 2>/dev/null || echo 0)"
[ "${STARTED:-0}" -gt 0 ] && good "worker 3.0 is running" || warn "the log doesn't show worker 3.0 starting yet"
say "     last log lines:"; tail -n 8 "$LOG" 2>/dev/null | sed 's/^/       /'

SWITCH="$(node -e "require('./printserver.js').defaultControl('config').then(d=>console.log('OK '+d.printMode), e=>console.log('ERROR '+e.message))" 2>&1 | tail -1)"
case "$SWITCH" in
  OK*) good "printer switch reachable (mode: ${SWITCH#OK })" ;;
  *)   fail "can't reach the printer switch: $SWITCH — check the Wi-Fi" ;;
esac
say "     SELPHYs this Mac sees:"
lpstat -p 2>/dev/null | grep -i selphy | sed 's/^/       /' || true

say ""
if [ "${STARTED:-0}" -gt 0 ] && [ "${SWITCH%% *}" = "OK" ]; then
  say "✅ DONE. Open the admin page → 📸 Photobooth: the print light should be green within a minute."
else
  say "⚠️  Not fully green yet. Send a photo of this screen."
fi
