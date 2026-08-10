#!/bin/bash
# Launcher for the photobooth print server (invoked by the launchd agent).
# Adds common node locations to PATH since launchd runs with a minimal env.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.homebrew/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
cd "$(dirname "$0")" || exit 1
exec node printserver.js
