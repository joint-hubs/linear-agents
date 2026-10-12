@echo off
setlocal
rem Use Git Bash only: C:\Windows\System32\bash.exe is the WSL launcher and cannot run a Windows path.
set "FENIX_BASH="
for /f "delims=" %%G in ('where git 2^>nul') do if not defined FENIX_BASH if exist "%%~dpG..\bin\bash.exe" set "FENIX_BASH=%%~dpG..\bin\bash.exe"
if not defined FENIX_BASH if exist "%ProgramFiles%\Git\bin\bash.exe" set "FENIX_BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined FENIX_BASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "FENIX_BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined FENIX_BASH goto nobash
"%FENIX_BASH%" "%~dp0fenix" %*
exit /b %errorlevel%
:nobash
echo Fenix needs Git Bash (Git for Windows): https://git-scm.com/download/win - then run: fenix up
exit /b 2