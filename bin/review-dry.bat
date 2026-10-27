@echo off
node --disable-warning=ExperimentalWarning "%~dp0..\scripts\squad-start.mjs" review --dry-run %*
exit /b %errorlevel%
