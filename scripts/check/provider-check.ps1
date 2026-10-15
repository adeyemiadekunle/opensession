# Starts one sandbox with fake keys for several providers and records how OpenCode sees them.
$ErrorActionPreference = 'Continue'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..\.."))
$out = Join-Path $PSScriptRoot 'provider-output.txt'
Remove-Item $out -ErrorAction SilentlyContinue
function Log($m) { $m | Out-File -FilePath $out -Append -Encoding utf8; Write-Host $m }
function Run($cmd) { Log ">> $cmd"; (cmd /c "$cmd 2>&1") | ForEach-Object { Log $_ } }
Log "started $(Get-Date -Format o)"
Run "docker rm -f ocsb-provcheck"
Run "docker run -d --name ocsb-provcheck -e OPENCODE_SERVER_PASSWORD=pc-check -e OPENAI_API_KEY=sk-proj-fakefakefake0000 -e ANTHROPIC_API_KEY=sk-ant-fake-0000 -e GOOGLE_GENERATIVE_AI_API_KEY=AIzaFakeFake0000 opencode-sandbox:latest"
Start-Sleep -Seconds 20
Run "docker cp scripts/check/provider.sh ocsb-provcheck:/home/agent/provider.sh"
Run "docker exec ocsb-provcheck sh /home/agent/provider.sh"
Run "docker logs --tail 20 ocsb-provcheck"
Run "docker rm -f ocsb-provcheck"
Log "ALL DONE - you can close this window"
