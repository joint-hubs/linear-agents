@echo off
setlocal
REM Launch a SINGLE sub-agent of a squad (standalone), with its exact model.
REM Usage: agent.bat <area> <role>
set "SQUAD_SLUG=%~1"
set "SOURCE_PATH=%~3"
call "%~dp0_lib.bat" || exit /b 1

set "AREA=%~1"
set "ROLE=%~2"
if "%ROLE%"=="" (
    echo Usage: agent.bat ^<area^> ^<role^>
    echo   plan:    discovery ^| spec ^| spec-review ^| decomposer ^| push
    echo   dev:     recon ^| implementer ^| refactorer ^| debugger
    echo   review:  first-pass ^| security ^| deep
    echo   test:    deployer ^| scenario-gen ^| runner ^| root-cause
    echo   cadence: collector ^| retro ^| digest
    exit /b 1
)
if not exist "%ROOT%\agents\%AREA%" (
    echo [!] Nieznany obszar: %AREA%
    exit /b 1
)
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\%AREA%"

REM role -> exact model id (via OpenRouter) from config/models.map (single source of truth)
set "M=z-ai/glm-5.2"
if exist "%ROOT%\config\models.map" for /f "usebackq tokens=1,* delims==" %%A in ("%ROOT%\config\models.map") do (
    if /i "%%A"=="%AREA%.%ROLE%" set "M=%%B"
)

set "ANTHROPIC_MODEL=%M%"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.8"
set "ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6"
echo [agent] %AREA%/%ROLE%  model=%ANTHROPIC_MODEL%
echo [agent] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
claude --append-system-prompt "Tryb pojedynczego sub-agenta: dzialaj WYLACZNIE jako rola '%ROLE%' obszaru '%AREA%'. Patrz agents/%AREA%/agents/%ROLE%.md oraz docs/prd/." %3 %4 %5 %6 %7 %8 %9
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
endlocal
