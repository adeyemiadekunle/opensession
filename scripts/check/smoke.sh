#!/usr/bin/env bash
# Smoke test of the cloud stack on a Linux Docker host (CI runs this).
# Builds the images, starts gateway + egress proxy, creates sandboxes for two users
# and checks isolation, egress, per-user domains and the agent setup. Dev auth only.
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT=${GATEWAY_HOST_PORT:-8787}
G="http://127.0.0.1:$PORT"
PASS=0
FAILS=()

ok()   { echo "  ok   $*"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL $*"; FAILS+=("$*"); }
check() { local name=$1 want=$2 got=$3; if [[ "$got" == $want ]]; then ok "$name ($got)"; else bad "$name: wanted $want, got $got"; fi; }

api() { # api METHOD USER PATH [JSON] -> prints HTTP code; body in /tmp/os_body
  curl -sS -o /tmp/os_body -w '%{http_code}' -X "$1" -H "X-User-Id: $2" \
    -H 'content-type: application/json' ${4:+--data "$4"} "$G$3" || echo 000
}
sandbox_of() { docker ps -q --filter label=oc.managed=true --filter "label=oc.user=$1" | head -n1; }
probe() { # probe USER CURL_ARGS... -> "http=X connect=Y"
  local c; c=$(sandbox_of "$1"); shift
  docker exec "$c" curl -s -m 10 -o /dev/null -w 'http=%{http_code} connect=%{http_connect}' "$@" || true
}

cleanup() {
  echo "== cleanup"
  OPENSESSION_ENV_FILE=.env.smoke docker compose --env-file .env.smoke down -v >/dev/null 2>&1 || true
  ids=$(docker ps -aq --filter label=oc.managed=true); [ -n "$ids" ] && docker rm -f $ids >/dev/null || true
  nets=$(docker network ls -q --filter label=oc.managed=true); [ -n "$nets" ] && docker network rm $nets >/dev/null || true
  vols=$(docker volume ls -q | grep -E '^oc(ws|st)-' || true); [ -n "$vols" ] && docker volume rm $vols >/dev/null || true
  rm -f .env.smoke
}
trap cleanup EXIT

echo "== build"
docker build -q -t opencode-sandbox:latest services/sandbox >/dev/null
KEY=$(python3 -c "import base64,os;print('k1:'+base64.b64encode(os.urandom(32)).decode())")
cat > .env.smoke <<ENV
AUTH_MODE=dev
KEYSTORE_MASTER_KEYS=$KEY
SANDBOX_IMAGE=opencode-sandbox:latest
SANDBOX_MAX_RUNNING=5
GATEWAY_HOST_PORT=$PORT
ENV
export OPENSESSION_ENV_FILE=.env.smoke
docker compose --env-file .env.smoke up -d --build

echo "== gateway"
for _ in $(seq 1 60); do curl -sf "$G/providers" >/dev/null && break; sleep 2; done
check "gateway answers" 200 "$(api GET alice /providers)"

echo "== sandboxes"
check "alice sandbox starts" 200 "$(api GET alice /health)"
check "bob sandbox starts" 200 "$(api GET bob /health)"
grep -q '"healthy":true' /tmp/os_body && ok "opencode healthy" || bad "opencode health body: $(cat /tmp/os_body)"
check "unauthenticated request refused" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$G/health")"
check "path traversal refused" 400 "$(api GET alice '/files/content?path=../../etc/passwd')"

echo "== isolation and egress"
BOB_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(sandbox_of bob)")
check "alice -> bob sandbox" "http=000*" "$(probe alice --noproxy '*' "http://$BOB_IP:4096/api/health")"
check "alice -> gateway API" "http=403*" "$(probe alice --noproxy '*' http://opensession-gateway:8000/providers)"
check "alice -> internet without proxy" "http=000*" "$(probe alice --noproxy '*' https://example.com)"
check "alice -> example.com via proxy" "*connect=403" "$(probe alice https://example.com)"
check "alice -> cloud metadata" "http=403*" "$(probe alice http://169.254.169.254/latest/meta-data/)"
check "alice -> npm registry" "http=200*" "$(probe alice https://registry.npmjs.org/left-pad)"
check "alice -> api.anthropic.com" "*connect=200" "$(probe alice https://api.anthropic.com/v1/models)"

echo "== per-user domains"
check "alice allows example.com" 200 "$(api PUT alice /egress/domains '{"domains":["example.com"]}')"
check "localhost refused" 400 "$(api POST alice /egress/domains '{"domain":"localhost"}')"
sleep 2
check "alice -> example.com now" "*connect=200" "$(probe alice https://example.com)"
check "bob -> example.com still blocked" "*connect=403" "$(probe bob https://example.com)"

echo "== agent setup"
SETUP='{"skills":[{"id":"secret-word","description":"Use for the secret word","body":"BANANA-42"}],
 "agents":[{"id":"reviewer","description":"Reviews","mode":"subagent","body":"Review only.","permissions":[]}],
 "commands":[{"name":"greet","template":"Reply with HELLO $ARGUMENTS"}],
 "permissions":[{"action":"webfetch","resource":"*","effect":"deny"}],"instructions":"Be brief."}'
check "save setup" 200 "$(api PUT alice /agent-config "$SETUP")"
check "sandbox restarts with setup" 200 "$(api GET alice /health)"
FILES=$(docker exec "$(sandbox_of alice)" sh -c 'cd ~/.config/opencode && find . -type f | sort | tr "\n" " "')
[[ "$FILES" == *"opensession-skills/secret-word/SKILL.md"* && "$FILES" == *"AGENTS.md"* ]] && ok "config files written" || bad "config files: $FILES"
CFG=$(docker exec "$(sandbox_of alice)" cat /home/agent/.config/opencode/opencode.json)
[[ "$CFG" == *'"greet"'* && "$CFG" == *'"reviewer"'* && "$CFG" == *opensession-skills* ]] && ok "opencode.json has agents, commands, skills" || bad "opencode.json: $CFG"
check "secret stored" 200 "$(api PUT alice /secrets/DOCS_TOKEN '{"value":"smoke-value"}')"
check "literal token in MCP refused" 422 "$(api PUT alice /agent-config '{"mcp":{"x":{"type":"remote","url":"https://x.dev","headers":{"Authorization":"Bearer sk-abcdefghijklmnopqrstuvwx"}}}}')"

echo "== stop and delete"
check "stop bob" 204 "$(api POST bob /workspace/stop)"
check "delete alice" 204 "$(api DELETE alice '/workspace?delete_data=true')"
check "delete bob" 204 "$(api DELETE bob '/workspace?delete_data=true')"
LEFT=$(docker network ls -q --filter label=oc.managed=true | wc -l)
check "sandbox networks removed" 0 "$LEFT"

echo "== $PASS passed, ${#FAILS[@]} failed"
if [ ${#FAILS[@]} -gt 0 ]; then
  docker compose --env-file .env.smoke logs --tail 60 gateway || true
  exit 1
fi
