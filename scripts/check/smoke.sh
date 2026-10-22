#!/usr/bin/env bash
# Smoke test of the cloud stack on a Linux Docker host (CI runs this).
# Builds the images, starts gateway + Postgres + egress proxy, creates sandboxes for
# two users and checks isolation, egress, per-user domains, the agent setup, sleep
# and resume, the per-user limit and the web terminal. Dev auth only.
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT=${GATEWAY_HOST_PORT:-8787}
G="http://127.0.0.1:$PORT"
PASS=0
FAILS=()

ok()   { echo "  ok   $*"; PASS=$((PASS + 1)); }
bad()  {
  echo "  FAIL $*"; FAILS+=("$*")
  # On GitHub Actions, also as an annotation (visible on the run page and via the API).
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=smoke::$(echo "$*" | tr '\n' ' ' | head -c 900)" || true
}
check() {
  local name=$1 want=$2 got=$3
  if [[ "$got" == $want ]]; then ok "$name ($got)"
  else bad "$name: wanted $want, got $got $( [ -f /tmp/os_body ] && head -c 400 /tmp/os_body | tr '\n' ' ' )"; fi
}

api() { # api METHOD USER PATH [JSON] -> prints HTTP code; body in /tmp/os_body
  curl -sS -o /tmp/os_body -w '%{http_code}' -X "$1" -H "X-User-Id: $2" \
    -H 'content-type: application/json' ${4:+--data "$4"} "$G$3" || echo 000
}
apiw() { # apiw METHOD USER WORKSPACE PATH [JSON]
  curl -sS -o /tmp/os_body -w '%{http_code}' -X "$1" -H "X-User-Id: $2" -H "X-Workspace: $3" \
    -H 'content-type: application/json' ${5:+--data "$5"} "$G$4" || echo 000
}
body_has() { grep -q -- "$1" /tmp/os_body; }
sandbox_of() { docker ps -q --filter label=oc.managed=true --filter "label=oc.user=$1" | head -n1; }
browser_of() { docker ps -q --filter label=oc.browser-of --filter "label=oc.user=$1" | head -n1; }
probe() { # probe USER CURL_ARGS... -> "http=X connect=Y"
  local c; c=$(sandbox_of "$1"); shift
  docker exec "$c" curl -s -m 10 -o /dev/null -w 'http=%{http_code} connect=%{http_connect}' "$@" || true
}

cleanup() {
  echo "== cleanup"
  OPENSESSION_ENV_FILE=.env.smoke docker compose --env-file .env.smoke down -v >/dev/null 2>&1 || true
  ids=$(docker ps -aq --filter label=oc.managed=true; docker ps -aq --filter label=oc.browser-of); [ -n "$ids" ] && docker rm -f $ids >/dev/null || true
  nets=$(docker network ls -q --filter label=oc.managed=true); [ -n "$nets" ] && docker network rm $nets >/dev/null || true
  vols=$(docker volume ls -q | grep -E '^oc(ws|st|bv)-' || true); [ -n "$vols" ] && docker volume rm $vols >/dev/null || true
  rm -f .env.smoke
}
on_error() { # a command failed under set -e: say which, with the gateway's last log lines
  local line=$1
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::error title=smoke aborted::line $line: $(sed -n "${line}p" "$0" | head -c 300)"
    echo "::error title=gateway log::$(OPENSESSION_ENV_FILE=.env.smoke docker compose --env-file .env.smoke logs --tail 15 gateway 2>&1 | tr '\n' ' ' | tail -c 900)"
  fi
}
trap 'on_error $LINENO' ERR
trap cleanup EXIT

echo "== build"
docker build -q -t opencode-sandbox:latest services/sandbox >/dev/null
KEY=$(python3 -c "import base64,os;print('k1:'+base64.b64encode(os.urandom(32)).decode())")
cat > .env.smoke <<ENV
AUTH_MODE=dev
KEYSTORE_MASTER_KEYS=$KEY
SANDBOX_IMAGE=opencode-sandbox:latest
SANDBOX_MAX_RUNNING=6
SANDBOX_MAX_PER_USER=2
POSTGRES_PASSWORD=smoke-$RANDOM
GATEWAY_HOST_PORT=$PORT
ADMIN_USER_IDS=alice
ENV
export OPENSESSION_ENV_FILE=.env.smoke
docker compose --env-file .env.smoke up -d --build

echo "== gateway"
for _ in $(seq 1 60); do curl -sf "$G/providers" >/dev/null && break; sleep 2; done
check "gateway answers" 200 "$(api GET alice /providers)"
check "health" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$G/health")"

echo "== sandboxes"
check "alice sandbox starts" 200 "$(api GET alice /p/default/api/info)"
check "bob sandbox starts" 200 "$(api GET bob /p/default/api/info)"
grep -q '"healthy":true' /tmp/os_body && ok "opencode healthy" || bad "opencode health body: $(cat /tmp/os_body)"
check "unauthenticated request refused" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$G/p/default/api/info")"
check "path traversal refused" 400 "$(api GET alice '/p/default/api/fs/read/%2E%2E/%2E%2E/etc/passwd')"
check "credential endpoint refused" 403 "$(api GET alice /p/default/api/credential/x)"

echo "== isolation and egress"
BOB_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(sandbox_of bob)")
check "alice -> bob sandbox" "http=000*" "$(probe alice --noproxy '*' "http://$BOB_IP:4096/api/info")"
check "alice -> gateway API" "http=403*" "$(probe alice --noproxy '*' http://opensession-gateway:8000/providers)"
check "alice -> internet without proxy" "http=000*" "$(probe alice --noproxy '*' https://example.com)"
check "alice -> example.com via proxy" "*connect=403" "$(probe alice https://example.com)"
check "alice -> cloud metadata" "http=403*" "$(probe alice http://169.254.169.254/latest/meta-data/)"
check "alice -> npm registry" "http=200*" "$(probe alice https://registry.npmjs.org/left-pad)"
check "alice -> api.anthropic.com" "*connect=200" "$(probe alice https://api.anthropic.com/v1/models)"
for domain in ui.shadcn.com fonts.googleapis.com fonts.gstatic.com; do
  check "alice -> $domain" "*connect=200" "$(probe alice "https://$domain")"
done

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
check "sandbox restarts with setup" 200 "$(api GET alice /p/default/api/info)"
FILES=$(docker exec "$(sandbox_of alice)" sh -c 'cd ~/.config/opencode && find . -type f | sort | tr "\n" " "')
[[ "$FILES" == *"opensession-skills/secret-word/SKILL.md"* && "$FILES" == *"AGENTS.md"* ]] && ok "config files written" || bad "config files: $FILES"
CFG=$(docker exec "$(sandbox_of alice)" cat /home/agent/.config/opencode/opencode.json)
[[ "$CFG" == *'"greet"'* && "$CFG" == *'"reviewer"'* && "$CFG" == *opensession-skills* ]] && ok "opencode.json has agents, commands, skills" || bad "opencode.json: $CFG"
echo "== browser"
[[ "$CFG" == *opensession-browser* && "$CFG" == *opensession_request_access* ]] && ok "browser and user tools configured" || bad "opencode.json: $CFG"
NET=$(docker exec "$(sandbox_of alice)" sh -c 'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}" | node /usr/local/lib/opensession/opensession-mcp.mjs')
[[ "$NET" == *request_access* && "$NET" == *hand_over* ]] && ok "user tools answer" || bad "user tools: $NET"
docker exec -i "$(sandbox_of alice)" node --input-type=module < scripts/check/requests.mjs
ok "agent access and hand-over tools wait for approval and expose their inputs"
# The browser runs in its own container beside the sandbox (SANDBOX_BROWSER=container).
B=$(browser_of alice)
[ -n "$B" ] && ok "browser container runs beside the sandbox" || bad "no browser container: $(docker ps -a --format '{{.Names}} {{.Status}}' | grep ocbr- | head -3)"
BROWSER=$(docker exec "$B" sh -c 'opensession-chromium && curl -fs http://127.0.0.1:9222/json/version' || true)
[[ "$BROWSER" == *Chrome* ]] && ok "Chromium starts in the browser container" || bad "browser: $BROWSER $(docker exec "$B" tail -c 600 /home/agent/.cache/browser.log 2>&1)"
VIEW=$(docker exec "$(sandbox_of alice)" sh -c 'a=$(curl -s --noproxy "*" -o /dev/null -w "%{http_code}" http://opensession-browser:9223/health); b=$(curl -s --noproxy "*" -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $OPENCODE_SERVER_PASSWORD" http://opensession-browser:9223/health); echo "$a $b"')
[[ "$VIEW" == "401 200" ]] && ok "browser view needs the sandbox password ($VIEW)" || bad "browser view: $VIEW $(docker logs --tail 20 "$B" 2>&1 | tr "\n" " ")"
bprobe() { docker exec "$B" curl -s -m 10 -o /dev/null -w 'http=%{http_code} connect=%{http_connect}' "$@" || true; }
check "browser -> sandbox localhost via relay" "http=401*" "$(bprobe -x http://opensession-sandbox:9224 http://localhost:4096/api/info)"
check "browser -> allowed domain via relay" "*connect=200" "$(bprobe -x http://opensession-sandbox:9224 https://example.com)"
check "browser -> other domain via relay" "*connect=403" "$(bprobe -x http://opensession-sandbox:9224 https://example.org)"
check "browser -> internet without the relay" "http=000*" "$(bprobe https://example.com)"
docker exec -i "$(sandbox_of alice)" node --input-type=module < scripts/check/browser.mjs
ok "agent browser tools navigate and read sandbox localhost through the companion browser"
check "browser view ticket" 200 "$(api POST alice /browser/ticket)"
check "secret stored" 200 "$(api PUT alice /secrets/DOCS_TOKEN '{"value":"smoke-value"}')"
check "literal token in MCP refused" 422 "$(api PUT alice /agent-config '{"mcp":{"x":{"type":"remote","url":"https://x.dev","headers":{"Authorization":"Bearer sk-abcdefghijklmnopqrstuvwx"}}}}')"

echo "== database"
N=$(docker exec opensession-db psql -U opensession -d opensession -tAc "select count(*) from egress_domains where user_id='alice'" | tr -d '[:space:]')
check "alice's domains are stored in Postgres" 1 "$N"

echo "== model proxy (keys stay out of sandboxes)"
FAKE_KEY="sk-ant-smoke-not-a-real-key-0123456789abcdef"
check "alice saves a key" 200 "$(api PUT alice '/keys/anthropic?validate=false' "{\"api_key\":\"$FAKE_KEY\"}")"
check "sandbox picks it up" 200 "$(api GET alice /p/default/api/info)"
TOKEN=$(docker exec "$(sandbox_of alice)" printenv ANTHROPIC_API_KEY || true)
[[ "$TOKEN" == osm_* ]] && ok "sandbox holds a stand-in token" || bad "ANTHROPIC_API_KEY in sandbox: ${TOKEN:0:12}..."
docker exec "$(sandbox_of alice)" sh -c "env; cat /home/agent/.config/opencode/opencode.json" | grep -q -- "$FAKE_KEY" \
  && bad "the real key is inside the sandbox" || ok "the real key is not in the sandbox"
CFG=$(docker exec "$(sandbox_of alice)" cat /home/agent/.config/opencode/opencode.json)
[[ "$CFG" == *'"baseURL": "http://opensession-gateway:8000/llm/anthropic"'* || "$CFG" == *'"baseURL":"http://opensession-gateway:8000/llm/anthropic"'* ]] \
  && ok "OpenCode calls Anthropic through the gateway" || bad "opencode.json providers: $CFG"
llm() { # llm USER [TOKEN] -> "<status> <body>" of GET /llm/anthropic/models from that user's sandbox
  docker exec "$(sandbox_of "$1")" curl -s -m 20 --noproxy '*' ${2:+-H "x-api-key: $2"} -w ' %{http_code}' \
    http://opensession-gateway:8000/llm/anthropic/models || true
}
OUT=$(llm alice "$TOKEN")
# Anthropic itself refuses the fake key: proof the gateway swapped the token for it.
[[ "$OUT" == *" 401" && "$OUT" != *"sandbox token"* ]] && ok "proxied to Anthropic with the stored key" || bad "alice via proxy: ${OUT: -300}"
OUT=$(llm alice); [[ "$OUT" == *"sandbox token"*" 401" ]] && ok "no token: refused" || bad "no token: ${OUT: -200}"
OUT=$(llm bob "$TOKEN"); [[ "$OUT" == *"sandbox token"*" 401" ]] && ok "alice's token from bob's sandbox: refused" || bad "bob with alice's token: ${OUT: -200}"
check "model proxy from outside a sandbox" 404 "$(curl -s -o /tmp/os_body -w '%{http_code}' -H "x-api-key: $TOKEN" "$G/llm/anthropic/models")"

echo "== sleep and resume"
check "create a session" 200 "$(api POST alice /p/default/api/session '{"model":{"providerID":"anthropic","id":"claude-sonnet-4-5"}}')"
SID=$(python3 -c "import json;print(json.load(open('/tmp/os_body'))['data']['id'])")
docker exec "$(sandbox_of alice)" sh -c 'echo kept-across-sleep > /workspace/note.txt'
check "status while awake" 200 "$(api GET alice /workspace)"
body_has '"state":"running"' && ok "state running" || bad "status: $(cat /tmp/os_body)"
check "put to sleep" 204 "$(api POST alice /workspace/stop)"
check "status while asleep" 200 "$(api GET alice /workspace)"
body_has '"state":"sleeping"' && ok "state sleeping" || bad "status: $(cat /tmp/os_body)"
[ -z "$(sandbox_of alice)" ] && ok "container stopped" || bad "alice still running"
check "next request wakes it" 200 "$(api GET alice /p/default/api/info)"
check "list sessions" 200 "$(api GET alice /p/default/api/session)"
body_has "$SID" && ok "session kept across sleep" || bad "session $SID missing: $(head -c 300 /tmp/os_body)"
# Without a location OpenCode reads from its own working directory; the apps always pass one.
check "read file" 200 "$(api GET alice '/p/default/api/fs/read/note.txt?location%5Bdirectory%5D=%2Fworkspace')"
body_has kept-across-sleep && ok "files kept across sleep" || bad "note.txt: $(head -c 200 /tmp/os_body)"

echo "== running projects per user (limit 2)"
# Only projects that exist get a sandbox.
for w in p2 p3; do check "alice creates $w" 201 "$(api POST alice /workspaces "{\"name\":\"$w\"}")"; done
check "alice opens p2" 200 "$(api GET alice /p/p2/api/info)"
check "alice opens p3" 200 "$(api GET alice /p/p3/api/info)"
check "limits" 200 "$(api GET alice /limits)"
body_has '"running":\["p2","p3"\]' && ok "least recently used project went to sleep" || bad "limits: $(cat /tmp/os_body)"
check "default status" 200 "$(api GET alice /workspace)"
body_has '"state":"sleeping"' && ok "default is asleep" || bad "default: $(cat /tmp/os_body)"

echo "== terminal"
check "open a terminal" 201 "$(apiw POST alice p3 /terminals '{"cols":100,"rows":30}')"
if ! grep -q '"id"' /tmp/os_body; then
  C=$(docker ps -q --filter label=oc.managed=true --filter label=oc.user=alice --filter label=oc.workspace=p3)
  bad "terminal diagnostics: $(docker exec "$C" sh -c 'curl -s -w " http=%{http_code}" -u "opencode:$OPENCODE_SERVER_PASSWORD" -H content-type:application/json -d "{\"cwd\":\"/workspace\"}" http://127.0.0.1:4096/api/pty; echo; mount | grep -E " /tmp | /home/agent" ; ls -la /dev/ptmx /dev/pts 2>&1 | head -3' 2>&1 | tr '\n' ' ' | head -c 700)"
  bad "sandbox log: $(docker logs --tail 25 "$C" 2>&1 | tr '\n' ' ' | tail -c 800)"
  exit 1
fi
PTY=$(python3 -c "import json;print(json.load(open('/tmp/os_body'))['id'])")
check "ticket" 200 "$(apiw POST alice p3 "/terminals/$PTY/ticket")"
TICKET=$(python3 -c "import json;print(json.load(open('/tmp/os_body'))['ticket'])")
python3 -m venv /tmp/os-wsenv >/dev/null && /tmp/os-wsenv/bin/pip install -q "websockets>=13" >/dev/null
OUT=$(/tmp/os-wsenv/bin/python - "$G" "$PTY" "$TICKET" <<'PY' || true
import asyncio, sys
from websockets.asyncio.client import connect
g, pty, ticket = sys.argv[1:]
async def main():
    async with connect(g.replace("http", "ws", 1) + f"/terminals/{pty}/connect?ticket={ticket}") as ws:
        await ws.send("echo TERM-$((6*7)) $(pwd) $(whoami)\r")
        out = ""
        for _ in range(200):
            m = await asyncio.wait_for(ws.recv(), 10)
            if isinstance(m, str):
                out += m
            if "TERM-42 " in out and "\r" in out[out.index("TERM-42 "):]:
                break
        print(out[out.index("TERM-42 "):].split("\r")[0] if "TERM-42 " in out else "no output: " + out[-200:])
asyncio.run(main())
PY
)
[[ "$OUT" == "TERM-42 /workspace agent"* ]] && ok "shell in /workspace as agent ($OUT)" || bad "terminal: $OUT"
REUSE=$(curl -s -o /dev/null -w '%{http_code}' "$G/terminals/$PTY/connect?ticket=$TICKET" -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -m 5 || true)
[[ "$REUSE" != "101" ]] && ok "ticket cannot be reused ($REUSE)" || bad "ticket reused"
check "close terminal" 204 "$(apiw DELETE alice p3 "/terminals/$PTY")"

echo "== admin"
check "admin overview" 200 "$(api GET alice /admin/overview)"
python3 -c "import json;o=json.load(open('/tmp/os_body'));assert o['counts']['running']>=1 and o['requests']['requests']>0" \
  && ok "overview counts sandboxes and requests" || bad "overview: $(head -c 400 /tmp/os_body)"
check "not for other users" 403 "$(api GET bob /admin/overview)"
check "prometheus metrics" 200 "$(api GET alice /admin/metrics)"
grep -q "opensession_sandboxes_running" /tmp/os_body && ok "metrics have sandbox gauges" || bad "metrics: $(head -c 300 /tmp/os_body)"

echo "== stop and delete"
check "stop bob" 204 "$(api POST bob /workspace/stop)"
check "delete alice" 204 "$(api DELETE alice '/workspace?delete_data=true')"
check "delete bob" 204 "$(api DELETE bob '/workspace?delete_data=true')"
for w in p2 p3; do check "delete alice $w" 204 "$(apiw DELETE alice $w '/workspace?delete_data=true')"; done
LEFT=$(docker network ls -q --filter label=oc.managed=true | wc -l)
check "sandbox networks removed" 0 "$LEFT"

echo "== $PASS passed, ${#FAILS[@]} failed"
if [ ${#FAILS[@]} -gt 0 ]; then
  docker compose --env-file .env.smoke logs --tail 60 gateway || true
  exit 1
fi
