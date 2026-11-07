#!/bin/bash
# Run on the Mac connected to the SELPHY, from a permanent copy of this repo.
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
# No argument: the worker finds every SELPHY queue itself (two printers → alternate,
# switch modes from sternfishmanwedding.com/photos/admin). An argument pins one queue/class.
PRINTER_NAME="${1:-auto}"
NODE_PATH="$(command -v node || true)"
if [ -z "$NODE_PATH" ]; then
  echo 'Install Node.js 22 or newer, then run this installer again.' >&2
  exit 1
fi
if ! "$NODE_PATH" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'; then
  echo 'Node.js 22 or newer is required.' >&2
  exit 1
fi
if [ "$PRINTER_NAME" = "auto" ]; then
  FOUND="$(lpstat -p 2>/dev/null | awk '/^printer /{print $2}' | grep -i selphy || true)"
  if [ -z "$FOUND" ]; then
    echo "No SELPHY printer queues found. Add each SELPHY in System Settings → Printers & Scanners"
    echo "(on the venue Wi-Fi), then run this installer again. Queues on this Mac:"
    lpstat -p || true
    exit 1
  fi
  echo "SELPHY printers found (the worker uses all of them):"
  echo "$FOUND" | sed 's/^/  • /'
elif ! lpstat -p "$PRINTER_NAME" >/dev/null 2>&1 && ! lpstat -c "$PRINTER_NAME" >/dev/null 2>&1; then
  echo "Printer '$PRINTER_NAME' was not found. Add the SELPHY in System Settings → Printers & Scanners."
  echo 'Available printer queue names:'
  lpstat -p || true
  echo 'Then run: bash install-printserver.sh YOUR_QUEUE_NAME'
  exit 1
fi
AGENT_PATH="$HOME/Library/LaunchAgents/com.lisapete.printserver.plist"
LOG_DIR="$HOME/Library/Logs/Photobooth"
mkdir -p "$(dirname "$AGENT_PATH")" "$LOG_DIR"
# Use this Mac's actual paths; the old checked-in plist names a different user.
"$NODE_PATH" - "$AGENT_PATH" "$NODE_PATH" "$REPO_DIR" "$PRINTER_NAME" "$LOG_DIR" <<'NODE'
const fs = require('node:fs');
const [agent, node, repo, printer, logs] = process.argv.slice(2);
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
fs.writeFileSync(agent, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.lisapete.printserver</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(repo)}/printserver.js</string></array>
<key>EnvironmentVariables</key><dict>${printer === 'auto' ? '' : `<key>PRINTERS</key><string>${xml(printer)}</string>`}<key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(logs)}/printserver.log</string>
<key>StandardErrorPath</key><string>${xml(logs)}/printserver.log</string>
</dict></plist>`);
NODE
plutil -lint "$AGENT_PATH"
launchctl bootout "gui/$(id -u)/com.lisapete.printserver" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENT_PATH"
if [ "$PRINTER_NAME" = "auto" ]; then
  echo "Print worker installed for all SELPHYs. It starts at login and is running now."
  echo "Printer switch (alternate / only one / pause): sternfishmanwedding.com/photos/admin → Photobooth"
else
  echo "Print worker installed for $PRINTER_NAME only. It starts at login and is running now."
fi
echo "Log: $LOG_DIR/printserver.log"
