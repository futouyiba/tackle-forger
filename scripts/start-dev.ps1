param(
  [int]$Port = 3456,
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

# ---- Worktree-aware session data directory --------------------------------
#
# Multiple git worktrees running dev servers on different ports must NOT
# share the same `sessions.json` file.  We detect whether this checkout is
# a linked worktree by inspecting the `.git` entry:
#
#   Main checkout:  .git is a DIRECTORY
#   Linked worktree: .git is a FILE  containing "gitdir: .../worktrees/<name>"
#
# If we are in a worktree AND `FEISHU_SESSION_DATA_DIR` has not been set to a
# *non-default* explicit value in the shell environment, we derive an isolated
# path:
#
#   .data/auth-<worktreeName>-<port>
#
# "Non-default" here matches `lib/session-path.ts`'s `resolveSessionDataDir`:
# the built-in default `.data/auth` (trimmed) is treated as "not intentional"
# so that a value inherited from `.env` / the shell does not silently disable
# isolation.  Only a genuine override (e.g. `/opt/tackle-forger/data/auth` or
# any other non-default path) is respected and left untouched.
#
# This path is gitignored (`.data/` is in `.gitignore`), does NOT conflict
# with other worktrees, and does NOT overwrite an explicit production path.
#
# Next.js/Vinext do NOT overwrite existing process.env values when they
# load `.env.local`, so setting the variable here takes priority.
# ---------------------------------------------------------------------------

$sessionDirExplicit = [Environment]::GetEnvironmentVariable("FEISHU_SESSION_DATA_DIR", "Process")
# Faithful mirror of `resolveSessionDataDir` / `isDefaultPath` in
# lib/session-path.ts:
#     const raw = explicitEnvPath?.trim() ?? "";
#     const isDefaultPath = raw === "" || raw === ".data/auth";
# Null, empty, AND whitespace-only values all trim to "" and are treated as
# the default (so worktree+port isolation still applies); only a genuine
# non-default path is an intentional override that is left untouched.
# `[string]::IsNullOrWhiteSpace` collapses null/empty/whitespace exactly like
# `?.trim() ?? ""` does on the TS side — using `IsNullOrEmpty` here instead
# would let a whitespace-only value (e.g. "   ") slip through as a false
# "explicit override" and silently disable isolation.  This ps1 and
# lib/session-path.ts MUST stay equivalent — update both together (and the
# auth.test.ts coverage) when changing.
if ([string]::IsNullOrWhiteSpace($sessionDirExplicit)) {
  $sessionDirRaw = ""
} else {
  $sessionDirRaw = $sessionDirExplicit.Trim()
}
$isDefaultSessionPath = ($sessionDirRaw -eq "") -or ($sessionDirRaw -eq ".data/auth")
$gitPath = Join-Path $projectRoot ".git"
$worktreeName = $null

if (Test-Path $gitPath -PathType Leaf) {
  $gitContent = Get-Content $gitPath -TotalCount 1 -Encoding Utf8
  if ($gitContent -match 'gitdir:\s*(.+)') {
    $gitdir = $matches[1].Trim()
    # Extract worktree name from path; accept both \ and / separators.
    if ($gitdir -match '[\\/]worktrees[\\/]([^\\/]+)$') {
      $worktreeName = $matches[1]
    }
  }
}

if ($isDefaultSessionPath -and $worktreeName) {
  $isolatedDir = ".data/auth-$worktreeName-$Port"
  $env:FEISHU_SESSION_DATA_DIR = $isolatedDir
  Write-Host "[auth] Session data: $isolatedDir (worktree-isolated for '$worktreeName')"
} elseif ($worktreeName) {
  Write-Host "[auth] Session data: $sessionDirExplicit (explicit non-default, not auto-isolated)"
} else {
  # Main checkout or non-git directory; use whatever .env.local provides.
  Write-Host "[auth] Not a linked worktree; session data from environment."
}

$env:PORT = [string]$Port
if ($Foreground) {
  Push-Location $projectRoot
  try {
    & npm.cmd run dev -- -p $Port
    exit $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$vinextCli = Join-Path $projectRoot "node_modules\vinext\dist\cli.js"
$launchCommand = "& '$nodePath' '$vinextCli' dev -p $Port"
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
