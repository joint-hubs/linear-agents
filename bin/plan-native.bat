@echo off
node --disable-warning=ExperimentalWarning "%~dp0..\scripts\squad-start.mjs" plan --native %*
exit /b %errorlevel%
