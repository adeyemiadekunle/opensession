#!/bin/sh
# Inside a sandbox: what OpenCode makes of the provider keys in its env.
A="-u opencode:$OPENCODE_SERVER_PASSWORD"
B=http://127.0.0.1:4096
echo "== env"; env | grep -E 'API_KEY' | cut -d= -f1
echo "== providers"; curl -s $A $B/api/provider | jq -c '.data[] | {id, activation, integrationID}'
echo "== model counts"; curl -s $A $B/api/model | jq -c '[.data[] | .providerID] | group_by(.) | map({(.[0]): length}) | add'
for p in openai anthropic google; do
  echo "== integration $p"; curl -s $A $B/api/integration/$p | jq -c '.data // . | {id, methods, connections}' | head -c 800; echo
  echo "== provider $p"; curl -s $A $B/api/provider/$p | head -c 600; echo
done
