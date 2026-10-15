#!/bin/sh
# Runs inside a sandbox: which env var names OpenCode reads for each provider we support.
curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" http://127.0.0.1:4096/api/integration \
 | jq -c '.data[] | select(.id as $i | ["anthropic","openai","google","openrouter","groq","mistral","deepseek","xai"] | index($i)) | {id, env: ([.methods[] | select(.type=="env") | .names] | flatten)}'
