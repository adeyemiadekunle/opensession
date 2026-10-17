#!/bin/sh
# Starts the sandbox's one Chromium if it isn't running, and returns once its
# debugging port (127.0.0.1 only) answers. Used by the agent's browser tools
# (browser-mcp.sh) and the Browser card's live view (browser-view.mjs), so both
# see the same browser and tabs.
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

running() { curl -fs "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }
running && exit 0

CHROME="${OPENSESSION_CHROME:-}"
if [ -z "$CHROME" ]; then
  CHROME="$(ls -d "${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -n1)"
fi
[ -x "$CHROME" ] || { echo "opensession-chromium: Chromium not found" >&2; exit 1; }
PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
mkdir -p "$PROFILE" "$(dirname "$LOG")"
# A crash leaves a lock behind that would stop the next start.
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"
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
  [ "$i" -gt 150 ] && { echo "opensession-chromium: Chromium did not start; see $LOG" >&2; exit 1; }
  sleep 0.1
done
