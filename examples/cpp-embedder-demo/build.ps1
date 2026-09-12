# Build and run the C++ embedder demo against the kernel cdylib.
# All build artifacts stay inside the project directory.
#
# Usage (from the project root): powershell -File examples/cpp-embedder-demo/build.ps1 [-Release]

param([switch]$Release)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$profileDir = if ($Release) { "release" } else { "debug" }
$dllPath = Join-Path $projectRoot "rust\target\$profileDir\extensions_kernel.dll"
$buildDir = Join-Path $projectRoot "examples\cpp-embedder-demo\build"
$exePath = Join-Path $buildDir "host.exe"

if (-not (Test-Path $dllPath)) {
    Write-Host "kernel cdylib not found, building $profileDir..."
    Push-Location (Join-Path $projectRoot "rust")
    if ($Release) { cargo build --release -p extensions-kernel } else { cargo build -p extensions-kernel }
    Pop-Location
}
Write-Host "using kernel cdylib: $profileDir"

New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

# Locate a g++ from PATH (MinGW); never write outside the project.
$gpp = (Get-Command g++ -ErrorAction Stop).Source
Write-Host "using g++: $gpp"

& $gpp -std=c++17 -O2 (Join-Path $PSScriptRoot "host.cpp") -o $exePath
if ($LASTEXITCODE -ne 0) { throw "g++ build failed" }

Push-Location $projectRoot
try {
    & $exePath $dllPath
    if ($LASTEXITCODE -ne 0) { throw "embedder demo failed" }
} finally {
    Pop-Location
}
