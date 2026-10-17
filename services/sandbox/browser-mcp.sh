#!/bin/sh
# Browser MCP server for the agent (Playwright MCP), attached to one long-lived
# Chromium per sandbox. Starting Chromium here (not inside Playwright MCP) means the
# Browser card can later attach to the same browser over its debugging port and show
# what the agent sees.
#
# - Profile: ~/.state/browser, on the sandbox's state volume, so sign-ins survive restarts.
# - Network: through the sandbox's egress proxy when it has one (Docker: Squid, so only
#   allowed domains load); Chromium never sends localhost through a proxy, so the
#   project's own dev servers always load. E2B applies its allowlist itself.
# - --no-sandbox: the container is the sandbox; Chromium's own needs privileges it lacks.
set -eu
PORT="${OPENSESSION_BROWSER_PORT:-9222}"
PROFILE="$HOME/.state/browser"
LOG="$HOME/.cache/browser.log"
MCP="${OPENSESSION_PLAYWRIGHT_MCP:-/opt/opensession/browser/node_modules/@playwright/mcp/cli.js}"

running() { curl -fs "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }

if ! running; then
  CHROME="${OPENSESSION_CHROME:-}"
  if [ -z "$CHROME" ]; then
    CHROME="$(ls -d "${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -n1)"
  fi
  [ -x "$CHROME" ] || { echo "opensession-browser: Chromium not found" >&2; exit 1; }
  PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
  mkdir -p "$PROFILE" "$(dirname "$LOG")"
  # shellcheck disable=SC2086
  nohup "$CHROME" \
    --headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu \
    --no-first-run --no-default-browser-check --disable-background-networking \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port="$PORT" \
    --user-data-dir="$PROFILE" --window-size=1280,800 \
    ${PROXY:+--proxy-server="$PROXY"} \
    about:blank >"$LOG" 2>&1 &
  i=0
  until running; do
    i=$((i + 1))
    [ "$i" -gt 100 ] && { echo "opensession-browser: Chromium did not start; see $LOG" >&2; exit 1; }
    sleep 0.1
  done
fi

exec node "$MCP" --cdp-endpoint "http://127.0.0.1:$PORT" --output-dir "$HOME/.cache/browser-output"
