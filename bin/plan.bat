@echo off
node "%~dp0..\scripts\squad-start.mjs" plan %*
exit /b %errorlevel%
