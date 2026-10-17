@echo off
node "%~dp0..\scripts\squad-start.mjs" review %*
exit /b %errorlevel%
