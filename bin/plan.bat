@echo off
node --disable-warning=ExperimentalWarning "%~dp0..\scripts\squad-start.mjs" plan %*
exit /b %errorlevel%
