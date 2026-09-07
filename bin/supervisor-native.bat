@echo off
REM Supervisor on the Anthropic SUBSCRIPTION instead of OpenRouter.
REM
REM All the machinery already exists; this only flips the switch. NATIVE=1 makes
REM _lib.bat clear ANTHROPIC_BASE_URL / AUTH_TOKEN / API_KEY and every model tier,
REM which is what makes claude fall back to the OAuth login rather than a metered
REM gateway. supervisor.bat then fills the native ids in its own NATIVE branch.
REM
REM Same shape as bin/plan-native.bat. Deliberately a separate launcher rather
REM than a flag on supervisor.bat: which account pays is a decision to make when
REM starting the run, not one to discover afterwards from a bill.
setlocal
set "NATIVE=1"
call "%~dp0supervisor.bat" %*
endlocal
