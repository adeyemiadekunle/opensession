# Compares how OpenCode loads skills/commands from ~/.config/opencode when it is
# (A) a symlink to the state volume, as in the current image, or (B) a real folder.
$ErrorActionPreference = 'Continue'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot "..\.."))
$out = Join-Path $PSScriptRoot 'config-output.txt'
Remove-Item $out -ErrorAction SilentlyContinue
function Log($m) { $m | Out-File -FilePath $out -Append -Encoding utf8; Write-Host $m }
function Run($cmd) { Log ">> $cmd"; (cmd /c "$cmd 2>&1") | ForEach-Object { Log $_ } }
Log "started $(Get-Date -Format o)"
foreach ($variant in @('C-inline')) {
  Log "################ $variant"
  Run "docker rm -f ocsb-cfg"
  if ($variant -eq 'C-inline') {
    Run "docker create --name ocsb-cfg -e OPENCODE_SERVER_PASSWORD=cfg-check opencode-sandbox:latest"
    Run "docker cp scripts/check/cfg-sample2/. ocsb-cfg:/home/agent/.state/config/"
    Run "docker cp scripts/check/cfg-proj/. ocsb-cfg:/workspace/"
  } else {
    Run "docker create --name ocsb-cfg -e OPENCODE_SERVER_PASSWORD=cfg-check -e XDG_CONFIG_HOME=/home/agent/xdg --entrypoint sh opencode-sandbox:latest -c ""mkdir -p /home/agent/xdg/opencode && cp -R /home/agent/sample/. /home/agent/xdg/opencode/ && exec opencode serve --hostname 0.0.0.0 --port 4096"""
    Run "docker cp scripts/check/cfg-sample/. ocsb-cfg:/home/agent/sample/"
  }
  Run "docker cp scripts/check/config-probe.sh ocsb-cfg:/home/agent/config-probe.sh"
  Run "docker start ocsb-cfg"
  Start-Sleep 25
  Run "docker cp scripts/check/config-probe2.sh ocsb-cfg:/home/agent/config-probe2.sh"
  Run "docker exec ocsb-cfg sh /home/agent/config-probe2.sh"
  Run "docker logs --tail 15 ocsb-cfg"
  Run "docker rm -f ocsb-cfg"
}
Log "ALL DONE - you can close this window"
