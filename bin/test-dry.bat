@echo off
node "%~dp0..\scripts\squad-start.mjs" test --dry-run %*
exit /b %errorlevel%
