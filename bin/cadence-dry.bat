@echo off
node "%~dp0..\scripts\squad-start.mjs" cadence --dry-run %*
exit /b %errorlevel%
