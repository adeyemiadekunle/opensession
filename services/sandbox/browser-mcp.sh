#!/bin/sh
# Browser MCP server for the agent (Playwright MCP), attached to the sandbox's one
# Chromium (chromium.sh) over its debugging port, so the Browser card's live view
# (browser-view.mjs) shows the same browser and tabs the agent uses.
set -eu
PORT="${OPENSESSION_BROWSER_PORT:-9222}"
MCP="${OPENSESSION_PLAYWRIGHT_MCP:-/opt/opensession/browser/node_modules/@playwright/mcp/cli.js}"
"${OPENSESSION_CHROMIUM:-opensession-chromium}"
exec node "$MCP" --cdp-endpoint "http://127.0.0.1:$PORT" --output-dir "$HOME/.cache/browser-output"
