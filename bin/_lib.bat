@echo off
REM Shared launcher logic. Called by each agent .bat via: call "%~dp0_lib.bat" || exit /b 1
REM Loads .env, validates keys, sets common provider env (OpenRouter for ALL model ids).

REM repo root (absolute)
pushd "%~dp0.." & set "ROOT=%CD%" & popd

REM load .env (eol=# skips comments, blank lines ignored)
if exist "%ROOT%\.env" for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT%\.env") do set "%%A=%%B"

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
for /f "delims=" %%i in ('node scripts\run-manifest.mjs gen-id %SQUAD_SLUG%') do set "RUN_ID=%%i"
node scripts\run-manifest.mjs start "%RUN_ID%" %SQUAD_SLUG% "%SOURCE_PATH%"
exit /b 0
