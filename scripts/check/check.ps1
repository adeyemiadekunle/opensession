# Real-container check for OpenSession. Output goes to check\output.txt
$ErrorActionPreference = 'Continue'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..\.."))
$out = Join-Path $PSScriptRoot 'output.txt'
function Log($m) { $m | Tee-Object -FilePath $out -Append }
function Run($cmd) { Log ">> $cmd"; cmd /c "$cmd 2>&1" | Tee-Object -FilePath $out -Append }
Remove-Item $out -ErrorAction SilentlyContinue
Log "started $(Get-Date -Format o)"
Run "docker version"
Log "== OFFICIAL IMAGE"
Run "docker run --rm --entrypoint sh ghcr.io/anomalyco/opencode:2.0.0 -c ""head -2 /etc/os-release; id; command -v opencode; opencode --version"""
Log "== BUILD"
Run "docker build --progress=plain -t opencode-sandbox:latest --build-arg OPENCODE_VERSION=2.0.0 services/sandbox"
Log "BUILD_EXIT $LASTEXITCODE"
Run "docker rm -f ocsb-check"
Log "== RUN"
Run "docker run -d --name ocsb-check -e OPENCODE_SERVER_PASSWORD=envpw-check -e ANTHROPIC_API_KEY=sk-ant-fake-check --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 512 --memory 2g opencode-sandbox:latest"
Start-Sleep -Seconds 30
Log "== STATUS"
Run "docker ps -a --filter name=ocsb-check"
Log "== LOGS"
$logs = (cmd /c "docker logs ocsb-check 2>&1") -join "`n"
Log $logs
$pw = 'envpw-check'
if ($logs -match 'server password\s*[:=]?\s*(\S+)') { $pw = $Matches[1]; Log "PASSWORD_FROM_LOG yes" } else { Log "PASSWORD_FROM_LOG no (using env value)" }
Log "== PROBE"
Run "docker cp scripts/check/probe.sh ocsb-check:/tmp/probe.sh"
Run "docker exec -e PW=$pw ocsb-check bash /tmp/probe.sh"
Run "docker cp ocsb-check:/tmp/openapi.json scripts/check/openapi.json"
Log "== LOGS AFTER"
Run "docker logs --tail 40 ocsb-check"
Run "docker rm -f ocsb-check"
Log "finished $(Get-Date -Format o)"
Log "ALL DONE - you can close this window"
