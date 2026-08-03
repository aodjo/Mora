#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MORA_ROOT="${SCRIPT_DIR:h:h}"
ENV_FILE="${MORA_ROOT}/Generator/.env"
TEMPLATE="${MORA_ROOT}/Generator/launchd/com.mora.generator.plist"
AGENT_DIR="${HOME}/Library/LaunchAgents"
PLIST="${AGENT_DIR}/com.mora.generator.plist"
LOG_DIR="${MORA_ROOT}/Generator/.logs"

if [[ -f "${ENV_FILE}" ]]; then
  chmod 600 "${ENV_FILE}"
fi
mkdir -p "${AGENT_DIR}" "${LOG_DIR}"
sed "s|__MORA_ROOT__|${MORA_ROOT}|g" "${TEMPLATE}" > "${PLIST}"
plutil -lint "${PLIST}"
launchctl bootout "gui/$(id -u)" "${PLIST}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"
launchctl kickstart -k "gui/$(id -u)/com.mora.generator"
print "Mora Generator is running."
print "Logs: ${LOG_DIR}/generator.log"
