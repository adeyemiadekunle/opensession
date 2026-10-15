#!/bin/sh
# Inside a sandbox: what OpenCode actually loads from ~/.config/opencode.
A="-u opencode:$OPENCODE_SERVER_PASSWORD"
B=http://127.0.0.1:4096
echo "== paths"; echo "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"
opencode debug paths 2>&1 | head -12
echo "== files"; find -L "${XDG_CONFIG_HOME:-$HOME/.config}/opencode" -type f | sort
echo "== GET /api/config"; curl -s $A "$B/api/config" | head -c 3000; echo
echo "== GET /api/command"; curl -s $A "$B/api/command" | head -c 1500; echo
echo "== GET /api/command?location[directory]=/workspace"; curl -s -g $A "$B/api/command?location[directory]=/workspace" | head -c 1500; echo
echo "== GET /api/skill ids"; curl -s $A "$B/api/skill" | jq -c '[.data[].id]'
echo "== GET /api/agent"; curl -s $A "$B/api/agent" | jq -c '[.data[] | {id, mode}]'
echo "== GET /api/mcp"; curl -s $A "$B/api/mcp" | head -c 1500; echo
echo "== GET /api/location"; curl -s $A "$B/api/location"; echo
echo "== opencode mcp list"; timeout 20 opencode mcp list 2>&1 | head -20
echo "== done"
echo "== session context (AGENTS.md?)"
SID=$(curl -s $A -X POST -H 'content-type: application/json' -d '{"location":{"directory":"/workspace"}}' $B/api/session | jq -r .data.id)
echo "SID=$SID"
curl -s $A "$B/api/session/$SID/context" > /tmp/ctx.json; wc -c /tmp/ctx.json
grep -o 'SENTINEL-AGENTS-MD[^"]\{0,40\}' /tmp/ctx.json | head -2 || true
grep -o 'secret-word[^"]\{0,60\}' /tmp/ctx.json | head -2 || true
jq -c 'paths(scalars) as $p | select(($p|tostring|test("permission"))) | $p' /tmp/ctx.json 2>/dev/null | head -3
echo "== mcp after wait"; sleep 15; curl -s $A "$B/api/mcp" | jq -c '.data'
