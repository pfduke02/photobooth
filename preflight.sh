#!/bin/bash
# Booth-day preflight. Run on the MacBook Air from the repo root:
#   bash preflight.sh                 # read-only checks
#   bash preflight.sh --print-test    # also prints ONE local test sheet (print-test-4x6.png)
#                                     # straight to the SELPHY via lp; no cloud job is created
# Read-only otherwise: does not touch Supabase rows, the print queue, or the launch agent.
set -u
cd "$(dirname "$0")"
PRINTER="${PRINTER:-$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PRINTER' "$HOME/Library/LaunchAgents/com.lisapete.printserver.plist" 2>/dev/null || echo Canon_SELPHY_CP1500)}"
SB="https://xjnqnxorqhobikyzshrt.supabase.co"
ANON="$(grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' printserver.js | head -1)"
pass=0; fail=0; warn=0
ok()   { echo "  ✅ $*"; pass=$((pass+1)); }
bad()  { echo "  ❌ $*"; fail=$((fail+1)); }
meh()  { echo "  ⚠️  $*"; warn=$((warn+1)); }

echo "== Mac"
pmset -g batt 2>/dev/null | grep -q "AC Power" && ok "on AC power" || bad "not on AC power — plug in the Air"
if pmset -g 2>/dev/null | awk '/^ *sleep /{exit !($2==0)}'; then ok "system sleep disabled"
else meh "system sleep is on — run: sudo pmset -c sleep 0 displaysleep 0 (or keep \`caffeinate -dimsu\` running)"; fi
avail_gb=$(df -g / | awk 'NR==2{print $4}')
[ "${avail_gb:-0}" -ge 10 ] && ok "disk free: ${avail_gb} GB" || bad "disk free only ${avail_gb} GB"
command -v node >/dev/null && node -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' \
  && ok "node $(node -v)" || bad "Node.js 22+ not found on PATH"

echo "== Repo"
git fetch -q origin 2>/dev/null
br=$(git rev-parse --abbrev-ref HEAD); behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
[ "$behind" = "0" ] && ok "on $br, up to date with origin/main" || meh "on $br, $behind commit(s) behind origin/main — git pull"
[ -z "$(git status --porcelain --untracked-files=no)" ] && ok "no uncommitted changes" || meh "uncommitted changes present (git status)"

echo "== Printer ($PRINTER)"
if lpstat -p "$PRINTER" >/dev/null 2>&1 || lpstat -c "$PRINTER" >/dev/null 2>&1; then
  ok "queue exists"
  st=$(lpstat -p "$PRINTER" 2>/dev/null | head -1)
  echo "$st" | grep -qi disabled && bad "queue is disabled: $st — run: cupsenable $PRINTER" || ok "$st"
  lpstat -a "$PRINTER" 2>/dev/null | grep -qi "not accepting" && bad "queue not accepting jobs — run: cupsaccept $PRINTER" || ok "accepting jobs"
  q=$(lpstat -o "$PRINTER" 2>/dev/null | wc -l | tr -d ' ')
  [ "$q" = "0" ] && ok "no stuck macOS print jobs" || meh "$q job(s) waiting in the macOS queue (lpstat -o); check paper/ink"
  lpoptions -p "$PRINTER" -l 2>/dev/null | grep -qi 'Postcard.Fullbleed' && ok "media Postcard.Fullbleed available" \
    || meh "Postcard.Fullbleed not listed by lpoptions; check: lpoptions -p $PRINTER -l | grep -i media"
else
  bad "no queue named $PRINTER. Available:"; lpstat -p 2>/dev/null | sed 's/^/       /'
fi

echo "== Print worker"
if launchctl print "gui/$(id -u)/com.lisapete.printserver" >/dev/null 2>&1; then
  pid=$(launchctl print "gui/$(id -u)/com.lisapete.printserver" | awk '/pid =/{print $3}')
  [ -n "$pid" ] && ok "launch agent running (pid $pid)" || bad "launch agent loaded but not running"
else bad "launch agent not installed — run: bash install-printserver.sh $PRINTER"; fi
n=$(pgrep -fl 'node .*printserver.js' | wc -l | tr -d ' ')
[ "$n" -le 1 ] && ok "$n printserver process(es)" || bad "$n printserver processes — stop the extra manual one(s); only the launch agent should run"
LOG="$HOME/Library/Logs/Photobooth/printserver.log"
[ -f "$LOG" ] && { echo "     last log lines:"; tail -n 5 "$LOG" | sed 's/^/       /'; }

echo "== Cloud"
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$SB/rest/v1/print_jobs?select=id&limit=1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON")
[ "$code" = "200" ] && ok "Supabase reachable" || bad "Supabase not reachable (HTTP $code) — check Wi-Fi"
if [ "$code" = "200" ]; then
  pend=$(curl -s -m 10 "$SB/rest/v1/print_jobs?select=id,status,created_at&status=in.(pending,printing,error)" -H "apikey: $ANON" -H "Authorization: Bearer $ANON")
  cnt=$(echo "$pend" | grep -o '"id"' | wc -l | tr -d ' ')
  [ "$cnt" = "0" ] && ok "no pending/printing/error jobs in the cloud queue" || meh "$cnt unfinished cloud job(s): $pend"
fi
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://photobooth-c7s.pages.dev/)
[ "$code" = "200" ] && ok "booth site up" || bad "booth site HTTP $code"

if [ "${1:-}" = "--print-test" ]; then
  echo "== Test print"
  if out=$(lp -d "$PRINTER" -o media=Postcard.Fullbleed print-test-4x6.png 2>&1); then
    ok "submitted: $out — the red border should reach all four edges"
  else bad "lp failed: $out"; fi
fi

echo; echo "Result: $pass ok, $warn warning(s), $fail problem(s)"
[ $fail = 0 ]
