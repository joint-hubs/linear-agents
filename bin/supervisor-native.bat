@echo off
set "LA_SUPERVISOR_REPO=%CD%"
node --disable-warning=ExperimentalWarning "%~dp0..\scripts\squad-start.mjs" supervisor --native %*
exit /b %errorlevel%
