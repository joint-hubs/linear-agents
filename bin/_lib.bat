@echo off
setlocal enabledelayedexpansion
REM Shared launcher logic. Called by each agent .bat via: call "%~dp0_lib.bat" || exit /b 1
REM Loads .env, validates keys, sets common provider env (OpenRouter for ALL model ids).

REM repo root (absolute)
pushd "%~dp0.." & set "ROOT=!CD!" & popd
set "LA_ROOT=%ROOT%"

REM load .env (eol=# skips comments, blank lines ignored)
if exist "%ROOT%\.env" for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT%\.env") do set "%%A=%%B"

REM --- New workspace provisioning check ---
if defined LINEAR_TEAM_KEY (
    if not exist "%ROOT%\.state\teams\%LINEAR_TEAM_KEY%.provisioned" (
        echo [INFO] Team key %LINEAR_TEAM_KEY% has no provisioning marker. Checking labels...
        node "%ROOT%\scripts\bootstrap-linear.mjs" --check --team-key %LINEAR_TEAM_KEY%
        if errorlevel 1 (
            set /p PROVISION=Provision labels/states for team %LINEAR_TEAM_KEY%? [y/N]:
            if /i "!PROVISION!"=="y" (
                node "%ROOT%\scripts\bootstrap-linear.mjs"
            ) else (
                echo [WARN] Skipping provisioning. linear-push may fail on missing labels.
            )
        )
    )
)

if defined NATIVE (
    REM native Anthropic subscription — clear any inherited/leaked ANTHROPIC_* vars (from .env or parent env)
    set "ANTHROPIC_BASE_URL="
    set "ANTHROPIC_AUTH_TOKEN="
    set "ANTHROPIC_API_KEY="
    set "ANTHROPIC_MODEL="
    set "ANTHROPIC_DEFAULT_OPUS_MODEL="
    set "ANTHROPIC_DEFAULT_SONNET_MODEL="
    set "ANTHROPIC_DEFAULT_HAIKU_MODEL="
    set "ANTHROPIC_SMALL_FAST_MODEL="
) else (
    if not defined OPENROUTER_API_KEY (
        echo [!] Brak OPENROUTER_API_KEY. Skopiuj .env.example -^> .env i uzupelnij.
        exit /b 1
    )

    REM provider: OpenRouter serves every model id (anthropic/*, z-ai/*, minimax/*, deepseek/*, moonshotai/*, openai/*)
    set "ANTHROPIC_BASE_URL=https://openrouter.ai/api"  REM no /v1 here -- Claude Code SDK appends /v1/messages
    set "ANTHROPIC_AUTH_TOKEN=%OPENROUTER_API_KEY%"
    set "ANTHROPIC_API_KEY="
)
set "CLAUDE_CODE_SUBAGENT_MODEL="
REM clear inherited override; else all subagents flatten onto one model (see ADR-0002)
set "API_TIMEOUT_MS=3000000"

REM --- Run manifest (telemetry) ---
REM SQUAD_SLUG and SOURCE_PATH are set by each launcher BEFORE calling _lib.bat.
if not defined SQUAD_SLUG set "SQUAD_SLUG=unknown"
if not defined SOURCE_PATH set "SOURCE_PATH="
for /f "delims=" %%i in ('node "%ROOT%\scripts\run-manifest.mjs" gen-id %SQUAD_SLUG%') do set "RUN_ID=%%i"
node "%ROOT%\scripts\run-manifest.mjs" start "%RUN_ID%" %SQUAD_SLUG% "%SOURCE_PATH%"
endlocal & set "ROOT=%ROOT%" & set "LA_ROOT=%LA_ROOT%" & set "ANTHROPIC_BASE_URL=%ANTHROPIC_BASE_URL%" & set "ANTHROPIC_AUTH_TOKEN=%ANTHROPIC_AUTH_TOKEN%" & set "ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY%" & set "API_TIMEOUT_MS=%API_TIMEOUT_MS%" & set "CLAUDE_CODE_SUBAGENT_MODEL=%CLAUDE_CODE_SUBAGENT_MODEL%" & set "LINEAR_API_KEY=%LINEAR_API_KEY%" & set "LINEAR_API_KEY_PISI=%LINEAR_API_KEY_PISI%" & set "LINEAR_WORKSPACE=%LINEAR_WORKSPACE%" & set "LINEAR_TEAM_KEY=%LINEAR_TEAM_KEY%" & set "OPENROUTER_API_KEY=%OPENROUTER_API_KEY%" & set "COST_BUDGET_USD_PER_TASK=%COST_BUDGET_USD_PER_TASK%"
exit /b 0
