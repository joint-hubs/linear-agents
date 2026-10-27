@echo off
node --disable-warning=ExperimentalWarning "%~dp0..\scripts\squad-start.mjs" cadence --dry-run %*
exit /b %errorlevel%
