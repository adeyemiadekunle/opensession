#!/bin/bash
# Runs INSIDE the sandbox container. Probes the OpenCode server and records what it finds.
B=http://127.0.0.1:4096
echo "== opencode version"; opencode --version 2>&1 | head -3; command -v opencode; readlink -f "$(command -v opencode)"
echo "== whoami"; id
echo "== debug paths"; opencode debug paths 2>&1 | head -20
echo "== serve help"; opencode serve --help 2>&1 | head -40
echo "== env names seen"; env | cut -d= -f1 | sort | tr '\n' ' '; echo
code() { curl -s -o /tmp/body -w "%{http_code}" "$@"; }
echo "== auth probes"
for path in /api/info /api/health /api/session /global/health; do
  echo "-- $path none:$(code $B$path)  basic:$(code -u opencode:$PW $B$path)  bearer:$(code -H "Authorization: Bearer $PW" $B$path)"
  head -c 300 /tmp/body; echo
done
AUTH=(-u opencode:$PW)
[ "$(code "${AUTH[@]}" $B/api/session)" = 401 ] && AUTH=(-H "Authorization: Bearer $PW")
echo "== spec"
for p in /openapi.json /api/openapi.json /doc /api/doc /api/spec /spec; do
  c=$(curl -s -o /tmp/spec "${AUTH[@]}" -w "%{http_code}" $B$p)
  echo "-- $p $c $(head -c 80 /tmp/spec | tr '\n' ' ')"
  if [ "$c" = 200 ] && head -c 300 /tmp/spec | grep -q '"openapi"'; then cp /tmp/spec /tmp/openapi.json; fi
done
echo "== GET routes"
for p in /api/info /api/session /api/agent /api/model /api/model/default /api/provider /api/integration /api/skill /api/mcp /api/location; do
  echo "-- GET $p $(code "${AUTH[@]}" $B$p)"; head -c 600 /tmp/body; echo
done
echo "== POST /api/session"
echo "status $(code "${AUTH[@]}" -X POST -H 'content-type: application/json' -d '{"location":{"directory":"/workspace"}}' $B/api/session)"; cat /tmp/body | head -c 800; echo
SID=$(jq -r '.data.id // .id // empty' /tmp/body 2>/dev/null)
echo "SID=$SID"
if [ -n "$SID" ]; then
  echo "== shell"; echo "status $(code "${AUTH[@]}" -X POST -H 'content-type: application/json' -d '{"command":"echo hi-from-shell"}' $B/api/session/$SID/shell)"; head -c 600 /tmp/body; echo
  echo "== messages"; echo "status $(code "${AUTH[@]}" $B/api/session/$SID/message)"; head -c 600 /tmp/body; echo
  echo "== log (2s)"; timeout 2 curl -s -N "${AUTH[@]}" "$B/api/experimental/session/$SID/log?follow=true" | head -c 800; echo
  echo "== delete"; echo "status $(code "${AUTH[@]}" -X DELETE $B/api/session/$SID)"; head -c 200 /tmp/body; echo
fi
echo "== done"
