@echo off
where bash >nul 2>nul
if errorlevel 1 goto nobash
bash "%~dp0fenix" %*
exit /b %errorlevel%
:nobash
echo Fenix needs bash (Git for Windows or WSL). Install Git for Windows, then run: fenix up
exit /b 2
