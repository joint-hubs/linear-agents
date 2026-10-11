# Fenix launcher wrapper for PowerShell.
$bashCmd = Get-Command bash -ErrorAction SilentlyContinue
$bashPath = $null
if ($bashCmd) {
    $bashPath = $bashCmd.Source
} elseif (Test-Path (Join-Path $env:ProgramFiles 'Git\bin\bash.exe')) {
    $bashPath = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
}

if ($bashPath) {
    & $bashPath (Join-Path $PSScriptRoot 'fenix') @args
    exit $LASTEXITCODE
}

Write-Host 'Fenix needs bash (Git for Windows or WSL). Install Git for Windows, then run: fenix up'
exit 2
