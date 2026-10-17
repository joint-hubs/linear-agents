@echo off
set "LA_SUPERVISOR_REPO=%CD%"
node "%~dp0..\scripts\squad-start.mjs" supervisor --native %*
exit /b %errorlevel%
