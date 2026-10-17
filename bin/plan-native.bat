@echo off
node "%~dp0..\scripts\squad-start.mjs" plan --native %*
exit /b %errorlevel%
