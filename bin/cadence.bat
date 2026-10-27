@echo off
node --disable-warning=ExperimentalWarning "%~dp0..\scripts\squad-start.mjs" cadence %*
exit /b %errorlevel%
