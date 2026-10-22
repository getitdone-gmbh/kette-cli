# kette installer for Windows: downloads the CLI, verifies the checksum and puts it in ~\.kette
# Runs in a script block and stops with throw, so irm | iex never closes the PowerShell window of the user
& {
  $ErrorActionPreference = 'Stop'
  $Mirror = if ($env:KETTE_MIRROR) { $env:KETTE_MIRROR.TrimEnd('/') } else { 'https://kette.itdone.de/dl' }
  $KetteHome = if ($env:KETTE_HOME) { $env:KETTE_HOME } else { Join-Path $HOME '.kette' }

  function Fail($msg) { throw "kette: $msg" }

  # Plain http only for a local test mirror or with KETTE_INSECURE=1
  $mirrorUri = [Uri]$Mirror
  $local = $mirrorUri.Host -in @('127.0.0.1', 'localhost')
  if ($mirrorUri.Scheme -ne 'https' -and -not ($mirrorUri.Scheme -eq 'http' -and ($local -or $env:KETTE_INSECURE -eq '1'))) {
    Fail "Mirror must use https: $Mirror (set KETTE_INSECURE=1 only for a trusted test mirror)."
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

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
    $version = [string]$manifest.cli.version
    $url = [string]$manifest.cli.url
    # The version becomes a folder that gets replaced, the URL is either a file name on the mirror or https on the mirror host
    if ($version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$' -or $version.Contains('..')) { Fail 'Manifest names an invalid CLI version, installation cancelled.' }
    if ($url.Contains('..')) { Fail 'Manifest names an invalid CLI download, installation cancelled.' }
    if ($url.StartsWith("https://$($mirrorUri.Authority)/")) { $download = $url }
    elseif ($url -match '^[0-9A-Za-z][0-9A-Za-z._+-]*$') { $download = "$Mirror/$url" }
    else { Fail 'Manifest names an invalid CLI download, installation cancelled.' }

    $file = Join-Path $tmp 'cli.tgz'
    Write-Host "Downloading CLI $version ..."
    Invoke-WebRequest $download -OutFile $file -UseBasicParsing
    $sum = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    if ($sum -ne $manifest.cli.sha256) { Fail 'Checksum does not match, installation cancelled.' }
    $dest = Join-Path $KetteHome "cli\$version"
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    tar -xzf $file -C $dest
    if ($LASTEXITCODE -ne 0) { Fail "Unpacking failed (tar exit code $LASTEXITCODE), installation cancelled." }
    if (-not (Test-Path (Join-Path $dest 'bin\kette.mjs'))) { Fail 'The CLI package is incomplete, installation cancelled.' }
    $bin = Join-Path $KetteHome 'bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    # cmd.exe expands %...% even inside quotes, so a percent sign in the path is doubled
    $script = "$dest\bin\kette.mjs".Replace('%', '%%')
    Set-Content -Path (Join-Path $bin 'kette.cmd') -Value "@node `"$script`" %*" -Encoding ASCII
    Write-Host "Installed: $bin\kette.cmd ($version)"
    # User PATH straight from the registry without expanding %USERPROFILE% and friends, written back as ExpandString,
    # so entries like %USERPROFILE%\bin stay variables instead of being frozen to today's values
    $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $userPath = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if (-not ($userPath -split ';' | Where-Object { $_ -eq $bin })) {
        if ($env:KETTE_NO_MODIFY_PATH -eq '1') {
          Write-Host "PATH not changed (KETTE_NO_MODIFY_PATH=1). Add $bin to the user PATH by hand."
        } else {
          $newPath = if ($userPath) { "$bin;$userPath" } else { $bin }
          $envKey.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
          # Setting and clearing a dummy variable broadcasts the change, so new terminals see the new PATH
          [Environment]::SetEnvironmentVariable('KETTE_PATH_REFRESH', '1', 'User')
          [Environment]::SetEnvironmentVariable('KETTE_PATH_REFRESH', $null, 'User')
          Write-Host "PATH updated with $bin (open a new terminal)."
        }
      }
    } finally {
      $envKey.Close()
    }
    Write-Host ''
    Write-Host 'Next:'
    Write-Host '  kette init my-project   new project'
    Write-Host '  kette add               connect an existing repo'
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
