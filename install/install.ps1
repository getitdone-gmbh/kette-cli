# kette Installer für Windows: lädt die CLI, prüft die Prüfsumme und legt sie unter ~\.kette ab
$ErrorActionPreference = 'Stop'
$Mirror = if ($env:KETTE_MIRROR) { $env:KETTE_MIRROR } else { 'https://kette.itdone.de/dl' }
$KetteHome = if ($env:KETTE_HOME) { $env:KETTE_HOME } else { Join-Path $HOME '.kette' }

function Fail($msg) { Write-Host "kette: $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js 20 oder neuer fehlt. Installieren über https://nodejs.org und erneut starten.' }
$major = [int](node -p 'process.versions.node.split(".")[0]')
if ($major -lt 20) { Fail "Node.js $major gefunden, gebraucht wird 20 oder neuer." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git fehlt.' }
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { Fail 'tar fehlt (ab Windows 10 enthalten).' }

Write-Host 'kette · Regelwerk und Agenten der Kette'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("kette-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $manifest = Invoke-RestMethod "$Mirror/manifest.json"
  $file = Join-Path $tmp 'cli.tgz'
  Write-Host "Lade CLI $($manifest.cli.version) ..."
  Invoke-WebRequest "$Mirror/$($manifest.cli.url)" -OutFile $file -UseBasicParsing
  $sum = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  if ($sum -ne $manifest.cli.sha256) { Fail 'Prüfsumme stimmt nicht, Installation abgebrochen.' }
  $dest = Join-Path $KetteHome "cli\$($manifest.cli.version)"
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  tar -xzf $file -C $dest
  $bin = Join-Path $KetteHome 'bin'
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  Set-Content -Path (Join-Path $bin 'kette.cmd') -Value "@node `"$dest\bin\kette.mjs`" %*" -Encoding ASCII
  Write-Host "Installiert: $bin\kette.cmd ($($manifest.cli.version))"
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -eq $bin })) {
    if ($env:KETTE_NO_MODIFY_PATH -eq '1') {
      Write-Host "PATH nicht geändert (KETTE_NO_MODIFY_PATH=1). Von Hand $bin in den PATH des Benutzers aufnehmen."
    } else {
      [Environment]::SetEnvironmentVariable('Path', "$bin;$userPath", 'User')
      Write-Host "PATH ergänzt um $bin (neues Terminal öffnen)."
    }
  }
  Write-Host ''
  Write-Host 'Weiter mit:'
  Write-Host '  kette init mein-projekt   neues Projekt'
  Write-Host '  kette add                 bestehendes Repo anbinden'
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
