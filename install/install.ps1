# kette installer for Windows: downloads the CLI, verifies the checksum and puts it in ~\.kette
$ErrorActionPreference = 'Stop'
$Mirror = if ($env:KETTE_MIRROR) { $env:KETTE_MIRROR } else { 'https://kette.itdone.de/dl' }
$KetteHome = if ($env:KETTE_HOME) { $env:KETTE_HOME } else { Join-Path $HOME '.kette' }

function Fail($msg) { Write-Host "kette: $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js 20 or newer is missing. Install it from https://nodejs.org and start again.' }
$major = [int](node -p 'process.versions.node.split(".")[0]')
if ($major -lt 20) { Fail "Found Node.js $major, version 20 or newer is required." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is missing.' }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { Fail 'tar is missing (included since Windows 10).' }

Write-Host 'kette · rules and agents of Die Kette'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("kette-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $manifest = Invoke-RestMethod "$Mirror/manifest.json"
  $file = Join-Path $tmp 'cli.tgz'
  Write-Host "Downloading CLI $($manifest.cli.version) ..."
  Invoke-WebRequest "$Mirror/$($manifest.cli.url)" -OutFile $file -UseBasicParsing
  $sum = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  if ($sum -ne $manifest.cli.sha256) { Fail 'Checksum does not match, installation cancelled.' }
  $dest = Join-Path $KetteHome "cli\$($manifest.cli.version)"
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  tar -xzf $file -C $dest
  $bin = Join-Path $KetteHome 'bin'
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  Set-Content -Path (Join-Path $bin 'kette.cmd') -Value "@node `"$dest\bin\kette.mjs`" %*" -Encoding ASCII
  Write-Host "Installed: $bin\kette.cmd ($($manifest.cli.version))"
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -eq $bin })) {
    if ($env:KETTE_NO_MODIFY_PATH -eq '1') {
      Write-Host "PATH not changed (KETTE_NO_MODIFY_PATH=1). Add $bin to the user PATH by hand."
    } else {
      [Environment]::SetEnvironmentVariable('Path', "$bin;$userPath", 'User')
      Write-Host "PATH updated with $bin (open a new terminal)."
    }
  }
  Write-Host ''
  Write-Host 'Next:'
  Write-Host '  kette init my-project   new project'
  Write-Host '  kette add               connect an existing repo'
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
