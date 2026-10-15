#!/bin/sh
A="-u opencode:$OPENCODE_SERVER_PASSWORD"
B=http://127.0.0.1:4096
SID=$(curl -s $A -X POST -H 'content-type: application/json' -d '{"location":{"directory":"/workspace"}}' $B/api/session | jq -r .data.id)
echo "SID=$SID"
echo "== run command greet"; curl -s -w " [%{http_code}]" $A -X POST -H 'content-type: application/json' -d '{"command":"greet","text":"WORLD"}' $B/api/session/$SID/command | head -c 600; echo
echo "== run command nosuch"; curl -s -w " [%{http_code}]" $A -X POST -H 'content-type: application/json' -d '{"command":"nosuchcmd","text":""}' $B/api/session/$SID/command | head -c 300; echo
echo "== activate skill secret-word"; curl -s -w " [%{http_code}]" $A -X POST -H 'content-type: application/json' -d '{"skill":"secret-word"}' $B/api/session/$SID/skill | head -c 600; echo
echo "== activate skill projskill"; curl -s -w " [%{http_code}]" $A -X POST -H 'content-type: application/json' -d '{"skill":"projskill"}' $B/api/session/$SID/skill | head -c 300; echo
echo "== activate skill nosuch"; curl -s -w " [%{http_code}]" $A -X POST -H 'content-type: application/json' -d '{"skill":"nosuchskill"}' $B/api/session/$SID/skill | head -c 300; echo
echo "== messages"; curl -s $A "$B/api/session/$SID/message?limit=10" | jq -c '.data[] | {type, text: (.text // "" | .[0:120]), skill, name}' | head -10
echo "== project-level listing"; curl -s $A "$B/api/command" | jq -c '[.data[].name]'; curl -s $A "$B/api/skill" | jq -c '[.data[].id]'
echo "== npx by hand"; cd /workspace && timeout 60 sh -c 'echo "{}" | npx -y @modelcontextprotocol/server-filesystem /workspace' 2>&1 | head -15
echo "== node/npx"; command -v node npx; node -v
echo "== mcp now"; curl -s $A "$B/api/mcp" | jq -c '.data'
