@echo off
REM L1b contract (JOI-69): when launched via POST /api/launch, %1 is the
REM server-built kickoff prompt (not a path) -- squad-start.mjs records it as
REM SOURCE_PATH in the run manifest and passes it to claude as the first arg.
node "%~dp0..\scripts\squad-start.mjs" dev %*
exit /b %errorlevel%
