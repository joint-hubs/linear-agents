@echo off
node --disable-warning=ExperimentalWarning "%~dp0..\scripts\squad-start.mjs" test %*
exit /b %errorlevel%
