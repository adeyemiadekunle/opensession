# Installs the OpenSession CLI (`opensession`) for the current user on Windows:
#
#   irm https://<your web app>/install.ps1 | iex
#
# Needs Node.js 20 or newer. Downloads opensession.mjs (one file, your deployment's
# addresses built in) from the latest GitHub release into %LOCALAPPDATA%\opensession,
# adds an `opensession` command there and puts that folder on your user PATH.
# Run it again to update.
#
#   $env:OPENSESSION_VERSION = "v0.2.0"    a specific release instead of the latest
#   $env:OPENSESSION_REPO = "owner/repo"   the GitHub repository with the releases
#   $env:OPENSESSION_DOWNLOAD_URL = "url"  download opensession.mjs from here instead

$ErrorActionPreference = "Stop"

$Repo = if ($env:OPENSESSION_REPO) { $env:OPENSESSION_REPO } else { "adeyemiadekunle/opensession" }
$Version = if ($env:OPENSESSION_VERSION) { $env:OPENSESSION_VERSION } else { "latest" }
$Dir = Join-Path $env:LOCALAPPDATA "opensession"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js 20 or newer is needed: https://nodejs.org" }
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { throw "Node.js $(& node -v) found; OpenSession needs 20 or newer: https://nodejs.org" }

if ($env:OPENSESSION_DOWNLOAD_URL) {
  $Url = $env:OPENSESSION_DOWNLOAD_URL
} elseif ($Version -eq "latest") {
  $Url = "https://github.com/$Repo/releases/latest/download/opensession.mjs"
} else {
  $Url = "https://github.com/$Repo/releases/download/$Version/opensession.mjs"
}

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Target = Join-Path $Dir "opensession.mjs"
$Tmp = "$Target.download"
Write-Host "Downloading $Url"
Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Tmp
if (-not ((Get-Content $Tmp -TotalCount 1) -like "#!/usr/bin/env node*")) {
  Remove-Item $Tmp -Force
  throw "That doesn't look like the OpenSession CLI ($Url)"
}
Move-Item -Force $Tmp $Target

# A .cmd shim so `opensession` works in cmd.exe and PowerShell alike.
Set-Content -Path (Join-Path $Dir "opensession.cmd") -Encoding ASCII -Value "@node `"%~dp0opensession.mjs`" %*"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($userPath -split ";") -contains $Dir)) {
  $newPath = (@($userPath, $Dir) | Where-Object { $_ }) -join ";"
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $env:Path = "$env:Path;$Dir"
  Write-Host "Added $Dir to your PATH (new terminals pick it up)."
}

$installed = & node $Target --version
Write-Host "Installed opensession $installed in $Dir"

# The agent runtime (OpenCode) for local mode: OpenSession installs its own copy.
& node $Target opencode install --postinstall
if ($LASTEXITCODE -ne 0) { Write-Host "OpenCode will be downloaded on the first local run." }

Write-Host ""
Write-Host "Next, in a terminal in your project folder:"
Write-Host "  opensession local key anthropic   # once: a model API key (any provider OpenCode supports)"
Write-Host "  opensession                       # chat with the agent in this folder"
Write-Host "To use your cloud projects too: opensession login"
