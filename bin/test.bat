@echo off
node "%~dp0..\scripts\squad-start.mjs" test %*
exit /b %errorlevel%
