#!/bin/zsh
set -euo pipefail

PLIST="${HOME}/Library/LaunchAgents/com.mora.generator.plist"
launchctl bootout "gui/$(id -u)" "${PLIST}" >/dev/null 2>&1 || true
rm -f "${PLIST}"
print "Mora Generator LaunchAgent removed."
