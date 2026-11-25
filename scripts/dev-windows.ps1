#Requires -Version 5.1
<#
.SYNOPSIS
    Stockpot — Windows build/run helper.

.DESCRIPTION
    Initialises the Visual Studio (MSVC) developer environment and the Rust
    toolchain, then runs whatever command is passed through. Rust needs the
    MSVC linker (link.exe) and the C headers on PATH/INCLUDE/LIB, otherwise the
    `ring`/`cc` builds fail with cl.exe error D8050. Every fresh shell therefore
    has to source vcvars64.bat first — this script does that for you.

.PARAMETER Command
    The command to run inside the prepared environment. Defaults to `tauri dev`.

.EXAMPLE
    ./scripts/dev-windows.ps1                    # tauri dev
    ./scripts/dev-windows.ps1 check              # cargo check
    ./scripts/dev-windows.ps1 build              # cargo build (debug)
    ./scripts/dev-windows.ps1 tauri-build        # tauri build (installers)
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('dev', 'check', 'build', 'test', 'cli', 'tauri-build', 'run')]
    [string]$Command = 'dev',

    # 透传给底层命令的额外参数，比如只打 NSIS 包：
    #   dev-windows.ps1 tauri-build --bundles nsis
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Extra = @()
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tauriDir = Join-Path $root 'src-tauri'

function Initialize-Msvc {
    if ($env:VCToolsVersion) { return }  # already inside a developer prompt

    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        throw "vswhere.exe not found. Install 'Visual Studio Build Tools 2022' with the 'Desktop development with C++' workload."
    }

    $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsPath) {
        throw "No Visual Studio installation with the MSVC C++ toolset was found. Install the 'Desktop development with C++' workload."
    }

    $vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
    if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }

    Write-Host "[Stockpot] Initialising MSVC environment: $vcvars" -ForegroundColor DarkGray
    cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
        if ($_ -match '^([^=]+)=(.*)$') {
            Set-Item -Path "env:$($matches[1])" -Value $matches[2]
        }
    }
    if (-not $env:VCToolsVersion) { throw "Failed to initialise the MSVC environment from vcvars64.bat." }
}

function Complete-WindowsSdk {
    # vcvars64.bat reads the SDK paths out of the registry through reg.exe. When the
    # caller blocks reg.exe (a sandboxed agent, for one), vcvars does not fail - it just
    # leaves the Windows Kits entries out of INCLUDE/LIB, and the build only dies at the
    # first #include <windows.h>, as a bare cl.exe exit code 2 with nothing else to go on.
    # Fill them in from the directory layout instead; a normal shell never gets here.
    if ($env:INCLUDE -like '*Windows Kits*') { return }

    $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
    if (-not (Test-Path $sdkRoot)) { return }

    $version = Get-ChildItem (Join-Path $sdkRoot 'Include') -Directory |
        Where-Object { $_.Name -match '^10\.' } |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1
    if (-not $version) { return }

    $includeExtra = @(
        (Join-Path $sdkRoot "Include\$($version.Name)\ucrt")
        (Join-Path $sdkRoot "Include\$($version.Name)\um")
        (Join-Path $sdkRoot "Include\$($version.Name)\shared")
    ) | Where-Object { Test-Path $_ }

    $libExtra = @(
        (Join-Path $sdkRoot "Lib\$($version.Name)\ucrt\x64")
        (Join-Path $sdkRoot "Lib\$($version.Name)\um\x64")
    ) | Where-Object { Test-Path $_ }

    if ($includeExtra) {
        Write-Host "[Stockpot] vcvars missed the SDK paths; adding Windows Kits $($version.Name) by hand" -ForegroundColor DarkGray
        $env:INCLUDE = ($includeExtra + $env:INCLUDE) -join ';'
        $env:LIB = ($libExtra + $env:LIB) -join ';'
    }
}

function Initialize-Rust {
    if (Get-Command cargo -ErrorAction SilentlyContinue) { return }
    $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
    if (Test-Path (Join-Path $cargoBin 'cargo.exe')) {
        Write-Host "[Stockpot] Adding $cargoBin to PATH" -ForegroundColor DarkGray
        $env:PATH = "$cargoBin;$env:PATH"
    } else {
        throw "cargo.exe not found. Install Rust from https://rustup.rs and reopen your terminal."
    }
}

Initialize-Msvc
Complete-WindowsSdk
Initialize-Rust

Write-Host "[Stockpot] Command: $Command $($Extra -join ' ')" -ForegroundColor Cyan

switch ($Command) {
    'dev' {
        Push-Location $root
        try { & pnpm tauri dev @Extra } finally { Pop-Location }
    }
    'tauri-build' {
        Push-Location $root
        try { & pnpm tauri build @Extra } finally { Pop-Location }
    }
    'check' { & cargo check --manifest-path (Join-Path $tauriDir 'Cargo.toml') --all-targets @Extra }
    'build' { & cargo build --manifest-path (Join-Path $tauriDir 'Cargo.toml') @Extra }
    'test'  { & cargo test  --manifest-path (Join-Path $tauriDir 'Cargo.toml') @Extra }
    'run'   { & cargo run   --manifest-path (Join-Path $tauriDir 'Cargo.toml') @Extra }
    'cli' {
        & cargo run --manifest-path (Join-Path $tauriDir 'Cargo.toml') -- cli --help @Extra
    }
}

exit $LASTEXITCODE
