@echo off
node --disable-warning=ExperimentalWarning "%~dp0..\scripts\squad-start.mjs" dev --dry-run %*
exit /b %errorlevel%
