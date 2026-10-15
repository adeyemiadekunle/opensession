# End-to-end check: gateway in Docker (docker compose) managing real sandboxes.
# Output goes to scripts\check\e2e-output.txt. Uses fake API keys (validate=false).
$ErrorActionPreference = 'Continue'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..\.."))
$out = Join-Path $PSScriptRoot 'e2e-output.txt'
Remove-Item $out -ErrorAction SilentlyContinue
function Log($m) { $m | Out-File -FilePath $out -Append -Encoding utf8; Write-Host $m }
function Run($cmd) { Log ">> $cmd"; (cmd /c "$cmd 2>&1") | ForEach-Object { Log $_ } }
$G = 'http://127.0.0.1:8787'
function Api($method, $path, $user, $body = $null) {
  $h = @{ 'X-User-Id' = $user }
  try {
    $req = @{ Method = $method; Uri = "$G$path"; Headers = $h; TimeoutSec = 180 }
    if ($body -ne $null) { $req.Body = ($body | ConvertTo-Json -Compress -Depth 6); $req.ContentType = 'application/json' }
    $r = Invoke-WebRequest @req -UseBasicParsing
    Log "$method $path [$user] -> $($r.StatusCode) $($r.Content.Substring(0, [Math]::Min(900, $r.Content.Length)))"
    return $r.Content
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    $txt = ''
    try { $txt = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
    Log "$method $path [$user] -> ERROR $code $txt $($_.Exception.Message)"
  }
}
Log "started $(Get-Date -Format o)"
if (-not (Test-Path .env)) {
  Log "creating .env with a new master key"
  $key = (docker run --rm python:3.12-slim python -c "import base64,os;print('k1:'+base64.b64encode(os.urandom(32)).decode())").Trim()
  (Get-Content .env.example) -replace '^KEYSTORE_MASTER_KEYS=.*', "KEYSTORE_MASTER_KEYS=$key" | Set-Content .env -Encoding ascii
}
Log "== BUILD"
Run "docker build -q -t opencode-sandbox:latest services/sandbox"
Run "docker compose up -d --build"
Run "docker compose ps"
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try { $r = Invoke-WebRequest "$G/providers" -UseBasicParsing -TimeoutSec 3; if ($r.Content -match '"anthropic"') { $ok = $true; break } } catch { Start-Sleep 2 }
}
if (-not $ok) { Log "GATEWAY DID NOT START on $G"; Run "docker logs --tail 40 opensession-gateway"; Run "docker compose down"; Log "ALL DONE - you can close this window"; exit 1 }
Log "== KEYS"
Api PUT '/keys/anthropic?validate=false' 'alice' @{ api_key = 'sk-ant-fake-alice-1111' }
Api PUT '/keys/openai?validate=false' 'bob' @{ api_key = 'sk-openai-fake-bob-2222' }
Api GET '/keys' 'alice'
Log "== SANDBOXES"
Api GET '/health' 'alice'
Api GET '/health' 'bob'
Api GET '/agents' 'alice'
$m = Api GET '/models' 'alice'
$model = $null
if ($m) { $ms = $m | ConvertFrom-Json; Log ("alice models: " + $ms.Count + " providers: " + (($ms | ForEach-Object { $_.providerID } | Sort-Object -Unique) -join ',')); $model = $ms | Select-Object -First 1 }
$m2 = Api GET '/models' 'bob'
if ($m2) { $ms2 = $m2 | ConvertFrom-Json; Log ("bob models: " + $ms2.Count + " providers: " + (($ms2 | ForEach-Object { $_.providerID } | Sort-Object -Unique) -join ',')) }
Api POST '/sessions' 'alice' @{ agent = 'build' }
$s = $null
if ($model) { $s = Api POST '/sessions' 'alice' @{ model = @{ providerID = $model.providerID; id = $model.id } } }
Api GET '/sessions' 'alice'
if ($s) {
  $sid = ($s | ConvertFrom-Json).id
  Api POST "/sessions/$sid/shell" 'alice' @{ command = 'echo hello-from-sandbox > hello.txt && git init -q 2>/dev/null; id' }
  Start-Sleep 2
  Api GET "/sessions/$sid/messages?limit=5" 'alice'
  Api GET '/files' 'alice'
  Api GET '/files/content?path=hello.txt' 'alice'
  Api GET '/files/content?path=../../etc/passwd' 'alice'
  Api GET '/diff' 'alice'
}
Log "== ISOLATION"
Run "docker ps --filter label=oc.managed=true --format ""{{.Names}} {{.Label \""oc.user\""}} {{.Networks}}"""
Run "docker network ls --filter label=oc.managed=true"
Run "docker network inspect -f ""{{.Name}} internal={{.Internal}}"" $(docker network ls -q --filter label=oc.managed=true)"
$names = @{}
foreach ($u in @('alice', 'bob')) { $names[$u] = (docker ps -q --filter label=oc.managed=true --filter "label=oc.user=$u" | Select-Object -First 1) }
Log "containers: alice=$($names['alice']) bob=$($names['bob'])"
$bobIp = (docker inspect -f "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" $names['bob'] | Out-String).Trim()
Log "bob sandbox ip: $bobIp"
$A = $names['alice']
function Probe($label, $curlArgs) { Run "docker exec $A curl -s -m 8 -o /dev/null -w ""$label http=%{http_code} proxy_connect=%{http_connect}\n"" $curlArgs" }
Probe 'ALICE_TO_BOB(direct)' "--noproxy * http://$($bobIp):4096/api/health"
Probe 'ALICE_TO_GATEWAY_API(direct)' "--noproxy * http://opensession-gateway:8000/providers"
Probe 'ALICE_TO_INTERNET(direct,no proxy)' "--noproxy * https://example.com"
Probe 'ALICE_TO_EXAMPLE(via proxy)' "https://example.com"
Probe 'ALICE_TO_ANTHROPIC(via proxy)' "https://api.anthropic.com/v1/models"
Probe 'ALICE_TO_GITHUB(via proxy)' "https://github.com"
Probe 'ALICE_TO_NPM(via proxy)' "https://registry.npmjs.org/left-pad"
Probe 'ALICE_TO_METADATA(via proxy)' "http://169.254.169.254/latest/meta-data/"
Probe 'ALICE_TO_OPENCODE_AI(via proxy)' "https://opencode.ai"
Run "docker exec $A sh -c ""env | grep -E 'API_KEY|_PROXY' | cut -d= -f1 | sort | tr '\n' ' '"""
Log "== PER-USER EGRESS"
$B = $names['bob']
Api PUT '/egress/domains' 'alice' @{ domains = @('example.com', '*.wikipedia.org') }
Api POST '/egress/domains' 'alice' @{ domain = 'localhost' }
Api GET '/egress/domains' 'bob'
Start-Sleep 2
Run "docker exec opensession-egress cat /etc/squid/conf.d/50-users.conf"
Probe 'ALICE_TO_EXAMPLE(after allow)' "https://example.com"
Probe 'ALICE_TO_WIKIPEDIA(after allow)' "https://en.wikipedia.org"
Run "docker exec $B curl -s -m 8 -o /dev/null -w ""BOB_TO_EXAMPLE(not allowed for bob) http=%{http_code} proxy_connect=%{http_connect}\n"" https://example.com"
Api DELETE '/egress/domains/example.com' 'alice'
Start-Sleep 2
Probe 'ALICE_TO_EXAMPLE(after remove)' "https://example.com"
Log "== PROVIDER ENV NAMES (from OpenCode integrations)"
Run "docker cp scripts/check/integrations.sh $($A):/home/agent/integrations.sh"
Run "docker exec $A sh /home/agent/integrations.sh"
Log "== EGRESS PROXY LOG"
Run "docker logs --tail 40 opensession-egress"
Log "== KEY CHANGE RECREATES SANDBOX"
$before = $names['alice']
Api PUT '/keys/anthropic?validate=false' 'alice' @{ api_key = 'sk-ant-fake-alice-3333' }
Api GET '/health' 'alice'
$after = (docker ps -q --filter label=oc.managed=true --filter "label=oc.user=alice" | Select-Object -First 1)
Log "recreated: $($before -ne $after) ($before -> $after)"
Run "docker exec $after sh -c ""ls /workspace; env | grep ANTHROPIC_API_KEY | cut -c1-30"""
Api GET '/sessions' 'alice'
Log "(the session list above should still contain the session created earlier: state volume kept)"
Log "== AGENT SETUP: skills, agents, commands, MCP, permissions, AGENTS.md"
$setup = @{
  skills = @(@{ id = 'secret-word'; description = 'Use when the user asks for the secret word.'; body = 'The secret word is BANANA-42. Reply with exactly that word and nothing else.' })
  agents = @(@{ id = 'reviewer'; description = 'Reviews code without editing'; mode = 'subagent'; body = 'Review only.'; permissions = @(@{ action = 'edit'; resource = '*'; effect = 'deny' }) })
  commands = @(@{ name = 'greet'; description = 'Say hello'; template = 'Reply with exactly: HELLO $ARGUMENTS' })
  mcp = @{ fs = @{ type = 'local'; command = @('npx', '-y', '@modelcontextprotocol/server-filesystem', '/workspace') } }
  permissions = @(@{ action = 'webfetch'; resource = '*'; effect = 'deny' })
  instructions = 'Keep answers very short.'
}
Api PUT '/agent-config' 'carol' $setup
Api GET '/health' 'carol'
$C = (docker ps -q --filter label=oc.managed=true --filter "label=oc.user=carol" | Select-Object -First 1)
Run "docker exec $C sh -c ""cd ~/.config/opencode && find . -type f | sort && cat opencode.json"""
# skill/command lists and the npx MCP server load in the background: poll for up to 90s
$t0 = Get-Date
for ($i = 0; $i -lt 18; $i++) {
  $cmds = Api GET '/commands' 'carol'
  if ($cmds -match '"greet"') { break }
  Start-Sleep 5
}
Log ("commands visible after {0:N0}s: {1}" -f ((Get-Date) - $t0).TotalSeconds, ($cmds -match '"greet"'))
Api GET '/skills' 'carol'
Api GET '/agents' 'carol'
Api GET '/mcp' 'carol'
Log "-- requests the egress proxy refused so far (host, count)"
(cmd /c "docker logs opensession-egress 2>&1") | Select-String 'TCP_DENIED' | ForEach-Object { ($_ -split '\s+')[6] } | Group-Object | ForEach-Object { Log ("   {0}  x{1}" -f $_.Name, $_.Count) }
Log "-- change the setup: the skill and MCP server are removed"
Api PUT '/agent-config' 'carol' @{ commands = @(@{ name = 'greet'; template = 'Reply with exactly: HELLO $ARGUMENTS' }) }
Api GET '/health' 'carol'
$C = (docker ps -q --filter label=oc.managed=true --filter "label=oc.user=carol" | Select-Object -First 1)
Run "docker exec $C sh -c ""cd ~/.config/opencode && find . -type f | sort"""
Api PUT '/agent-config' 'carol' $setup
Log "== REAL MODEL (needs E2E_ANTHROPIC_API_KEY in .env)"
$realKey = $null
foreach ($l in (Get-Content .env)) { if ($l -match '^\s*E2E_ANTHROPIC_API_KEY\s*=\s*(\S+)\s*$') { $realKey = $Matches[1] } }
if (-not $realKey) {
  Log "skipped: E2E_ANTHROPIC_API_KEY is empty in .env"
} else {
  Api PUT '/keys/anthropic' 'carol' @{ api_key = $realKey }   # checked with Anthropic; the response shows the last 4 characters only
  $realKey = $null
  $mm = Api GET '/models' 'carol'
  $model = $null
  if ($mm) { $all = $mm | ConvertFrom-Json; $model = ($all | Where-Object { $_.id -match 'haiku' } | Select-Object -First 1); if (-not $model) { $model = $all | Select-Object -First 1 } }
  if ($model) {
    Log "using model $($model.providerID)/$($model.id)"
    $s = Api POST '/sessions' 'carol' @{ model = @{ providerID = $model.providerID; id = $model.id } }
    $sid = ($s | ConvertFrom-Json).id
    $r = Api POST "/sessions/$sid/run" 'carol' @{ text = 'What is the secret word? Use @secret-word'; skills = @('secret-word') }
    Log ("SKILL_TEST " + $(if ($r -match 'BANANA-42') { 'PASS' } else { 'FAIL' }))
    Api POST "/sessions/$sid/command" 'carol' @{ command = 'greet'; arguments = 'WORLD' }
    Api POST "/sessions/$sid/wait" 'carol'
    $m = Api GET "/sessions/$sid/messages?limit=3&order=desc" 'carol'
    Log ("COMMAND_TEST " + $(if ($m -match 'HELLO WORLD') { 'PASS' } else { 'FAIL' }))
    $r2 = Api POST "/sessions/$sid/run" 'carol' @{ text = 'Use the fs MCP server to list the files in /workspace, then reply with just the file names.' }
    Log ("MCP_TEST " + $(if ($r2 -match 'fs_') { 'PASS (tool used)' } else { 'CHECK OUTPUT' }))
  }
  Api DELETE '/keys/anthropic' 'carol'
}
Api DELETE '/workspace?delete_data=true' 'carol'
Log "== STOP / CLEANUP"
Api POST '/workspace/stop' 'bob'
Run "docker network ls --filter label=oc.managed=true"
Api DELETE '/workspace?delete_data=true' 'alice'
Api DELETE '/workspace?delete_data=true' 'bob'
Run "docker network ls --filter label=oc.managed=true"
Run "docker logs --tail 30 opensession-gateway"
Run "docker compose down"
Log "finished $(Get-Date -Format o)"
Log "ALL DONE - you can close this window"
