# App tester on Windows (docs/app-tester/DESIGN.md, "Windows"): builds
# "Plyloft Test" (a debug build with the test bridge, identifier
# com.mbadv.ply.test) and ply-test-winhelper inside the VM. Run by
# scripts/app-tester/vm-build.sh from the Mac; never a release.
#
# Its own clone (C:\build\ply-test) and target dirs, so the owner's
# C:\build\atelier and the installed Plyloft are untouched.
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Branch,
  [string]$Target = "aarch64-pc-windows-msvc",
  [switch]$HelperOnly
)
# Continue: Windows PowerShell turns a native tool's stderr into an error under
# Stop; every step checks its exit code instead.
$ErrorActionPreference = "Continue"
$env:PATH = "$env:USERPROFILE\.cargo\bin;C:\Program Files\Git\bin;C:\Program Files\nodejs;" +
  "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\Llvm\bin;$env:PATH"
$src = "C:\build\ply-test"
$logs = "C:\build\ply-test-logs"
New-Item -ItemType Directory -Force $logs | Out-Null

function Step($name, [scriptblock]$body) {
  Write-Output "=== $name"
  & $body
  if ($LASTEXITCODE -ne 0) { Write-Output "FAILED: $name (exit $LASTEXITCODE)"; exit 1 }
}

if (!(Test-Path "$src\.git")) {
  $seed = if (Test-Path "C:\build\atelier\.git") { "C:\build\atelier" } else { $Repo }
  Step "clone" { git -c safe.directory=* clone -q --no-checkout $seed $src }
}
Set-Location $src
Step "fetch $Branch" { git -c safe.directory=* fetch -q $Repo "+refs/heads/${Branch}:refs/remotes/mac/$Branch" }
Step "checkout" { git -c safe.directory=* checkout -q -f -B $Branch "mac/$Branch" }
git -c safe.directory=* log --oneline -1

# A helper still serving holds its exe: end it (and only it) before replacing.
Get-Process ply-test-winhelper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Step "ply-test-winhelper" {
  cargo build --release --manifest-path tools\ply-test-winhelper\Cargo.toml --target-dir C:\build\ply-test-helper-target *> "$logs\helper.log"
}
New-Item -ItemType Directory -Force C:\ply-test\bin | Out-Null
Copy-Item -Force C:\build\ply-test-helper-target\release\ply-test-winhelper.exe C:\ply-test\bin\ply-test-winhelper.exe
& C:\ply-test\bin\ply-test-winhelper.exe --version
if ($HelperOnly) { exit 0 }

$lock = (Get-FileHash package-lock.json).Hash
$stamp = "node_modules\.ply-test-lock"
if (!(Test-Path node_modules) -or ((Get-Content $stamp -ErrorAction SilentlyContinue) -ne $lock)) {
  Step "npm ci" { npm ci --no-audit --no-fund *> "$logs\npm.log" }
  Set-Content $stamp $lock
}

$app = "$src\src-tauri\target\$Target\debug\atelier.exe"
$running = Get-Process atelier -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $app }
if ($running) { Write-Output "FAILED: Plyloft Test is running ($($running.Id)): quit it first"; exit 1 }

$env:PLY_TEST_BRIDGE = "1"
# The crate outgrew what a PDB can hold (LNK1140, 2026-11-03): line tables are
# enough for a test build's backtraces.
$env:CARGO_PROFILE_DEV_DEBUG = "line-tables-only"
Step "Plyloft Test (tauri build --debug --features test-bridge)" {
  npx tauri build --debug --no-bundle --features test-bridge --config src-tauri/tauri.test.conf.json --target $Target *> "$logs\tauri.log"
}
Remove-Item Env:\PLY_TEST_BRIDGE
Remove-Item Env:\CARGO_PROFILE_DEV_DEBUG
if (!(Test-Path $app)) { Write-Output "FAILED: no $app"; exit 1 }
Write-Output "APP=$app"
Write-Output "HELPER=C:\ply-test\bin\ply-test-winhelper.exe"
Write-Output "BUILD_OK"
