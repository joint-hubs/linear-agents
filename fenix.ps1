# Fenix launcher wrapper for PowerShell.
# Use Git Bash only: C:\Windows\System32\bash.exe is the WSL launcher and cannot run a Windows path.
$bashPath = $null
$git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($git) {
    $candidate = Join-Path (Split-Path (Split-Path $git.Source -Parent) -Parent) 'bin\bash.exe'
    if (Test-Path $candidate) { $bashPath = $candidate }
}
if (-not $bashPath) {
    foreach ($root in @($env:ProgramFiles, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
        if ($root) {
            $candidate = Join-Path $root 'Git\bin\bash.exe'
            if (Test-Path $candidate) { $bashPath = $candidate; break }
        }
    }
}

if ($bashPath) {
    & $bashPath (Join-Path $PSScriptRoot 'fenix') @args
    exit $LASTEXITCODE
}

Write-Host 'Fenix needs Git Bash (Git for Windows): https://git-scm.com/download/win - then run: fenix up'
exit 2