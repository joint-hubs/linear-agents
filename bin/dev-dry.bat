@echo off
node "%~dp0..\scripts\squad-start.mjs" dev --dry-run %*
exit /b %errorlevel%
