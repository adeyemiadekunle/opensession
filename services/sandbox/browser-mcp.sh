#!/bin/sh
# Browser MCP server for the agent (Playwright MCP), attached to the sandbox's one
# Chromium (chromium.sh) over its debugging port, so the Browser card's live view
# (browser-view.mjs) shows the same browser and tabs the agent uses.
set -eu
PORT="${OPENSESSION_BROWSER_PORT:-9222}"
MCP="${OPENSESSION_PLAYWRIGHT_MCP:-/opt/opensession/browser/node_modules/@playwright/mcp/cli.js}"
if [ -n "${OPENSESSION_BROWSER_CDP:-}" ]; then
  # The browser runs in its own container (the gateway's SANDBOX_BROWSER=container):
  # connect to its live-view server, which starts Chromium, with this sandbox's password.
  export PLAYWRIGHT_MCP_CDP_HEADERS="Authorization: Bearer ${OPENCODE_SERVER_PASSWORD:-}"
  exec node "$MCP" --cdp-endpoint "$OPENSESSION_BROWSER_CDP" --output-dir "$HOME/.cache/browser-output"
fi
"${OPENSESSION_CHROMIUM:-opensession-chromium}"
exec node "$MCP" --cdp-endpoint "http://127.0.0.1:$PORT" --output-dir "$HOME/.cache/browser-output"
