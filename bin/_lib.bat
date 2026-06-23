@echo off
REM Shared launcher logic. Called by each agent .bat via: call "%~dp0_lib.bat" || exit /b 1
REM Loads .env, validates keys, sets common provider env (OpenRouter for ALL model ids).

REM repo root (absolute)
pushd "%~dp0.." & set "ROOT=%CD%" & popd

REM load .env (eol=# skips comments, blank lines ignored)
if exist "%ROOT%\.env" for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT%\.env") do set "%%A=%%B"

if not defined OPENROUTER_API_KEY (
    echo [!] Brak OPENROUTER_API_KEY. Skopiuj .env.example -^> .env i uzupelnij.
    exit /b 1
)

REM provider: OpenRouter serves every model id (anthropic/*, z-ai/*, minimax/*, deepseek/*, moonshotai/*, openai/*)
set "ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1"
set "ANTHROPIC_AUTH_TOKEN=%OPENROUTER_API_KEY%"
set "ANTHROPIC_API_KEY="
set "API_TIMEOUT_MS=3000000"
exit /b 0
