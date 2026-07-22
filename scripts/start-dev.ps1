param(
  [int]$Port = 3000,
  [switch]$Foreground
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runDirectory = Join-Path $projectRoot ".run"
$stdoutPath = Join-Path $runDirectory "dev-$Port.stdout.log"
$stderrPath = Join-Path $runDirectory "dev-$Port.stderr.log"

New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null

$listener = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
  Where-Object { $_.Port -eq $Port } |
  Select-Object -First 1
if ($listener) {
  Write-Host "Port $Port is already in use. Stop the existing service or choose another port."
  exit 1
}

$env:PORT = [string]$Port
if ($Foreground) {
  Push-Location $projectRoot
  try {
    & npm.cmd run dev
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$vinextCli = Join-Path $projectRoot "node_modules\vinext\dist\cli.js"
$launchCommand = "& '$nodePath' '$vinextCli' dev"
$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launchCommand))

$startedProcess = Start-Process `
  -FilePath "powershell.exe" `
  -ArgumentList @("-NoLogo", "-NoProfile", "-EncodedCommand", $encodedCommand) `
  -WorkingDirectory $projectRoot `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -PassThru


if ($startedProcess.HasExited) {
  throw "Development service failed to start. Check $stderrPath."
}

Write-Host "Tackle Forger development service started (PID $($startedProcess.Id))."
Write-Host "Open http://127.0.0.1:$Port"
Write-Host "Logs: $stdoutPath and $stderrPath"
