@echo off
node "%~dp0..\scripts\squad-start.mjs" plan --dry-run %*
exit /b %errorlevel%
