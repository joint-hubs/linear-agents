@echo off
node "%~dp0..\scripts\squad-start.mjs" cadence %*
exit /b %errorlevel%
