@echo off
node --disable-warning=ExperimentalWarning "%~dp0..\scripts\squad-start.mjs" test --dry-run %*
exit /b %errorlevel%
