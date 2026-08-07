@echo off
REM ---------------------------------------------------------------------------
REM Orchestrator on OpenRouter - Claude Code with GLM-5.2 as the strategist
REM and DeepSeek in the haiku slot as the worker.
REM
REM Moved from %LOCALAPPDATA%\hermes\scripts\orchestrate-openrouter.bat
REM (2026-08-06) so the whole agent stack lives in one repo and is covered by
REM telemetry. Differences from the original:
REM   1. CLAUDE_CONFIG_DIR -> agents\orchestrator instead of ~/.claude-or.
REM      The original copied CLAUDE.md there and mirrored skills on EVERY start
REM      (copy /y + robocopy /MIR), so any edit made in .claude-or was silently
REM      overwritten. The context now lives in the repo and nothing rewrites it.
REM   2. --mcp-config points at config\atlas-mcp.json in this repo (was: the
REM      separate atlas repo)
REM   3. OPENROUTER_API_KEY is read from this repo's .env (was: hermes .env)
REM   4. run registered in telemetry (run-manifest), fail-soft
REM
REM NOTE: keep this file ASCII-only. cmd.exe reads .bat in the OEM codepage;
REM UTF-8 accented characters corrupt line parsing and break the launcher.
REM
REM Usage: bin\orchestrate-openrouter.bat [flash|pro|minimax] [path-to-repo]
REM ---------------------------------------------------------------------------

setlocal

REM Each on its own line on purpose: in a `pushd ... & set "ROOT=%CD%" & popd`
REM one-liner, %CD% is expanded when the line is PARSED - before pushd runs - so
REM ROOT would capture the caller's directory instead of the repo. _lib.bat gets
REM around it with !CD! and delayed expansion; that is avoided here because the
REM --append-system-prompt string must not be exposed to ! expansion.
pushd "%~dp0.."
set "ROOT=%CD%"
popd

set PROFILE=%1
if "%PROFILE%"=="" set PROFILE=flash
if /i "%PROFILE%"=="flash"   set WORKER=deepseek/deepseek-v4-flash
if /i "%PROFILE%"=="pro"     set WORKER=deepseek/deepseek-v4-pro
if /i "%PROFILE%"=="minimax" set WORKER=minimax/minimax-m3
if "%WORKER%"=="" (
    echo [orchestrate-openrouter] Unknown profile "%PROFILE%". Use: flash ^| pro ^| minimax
    exit /b 1
)

if not "%~2"=="" (
    if not exist "%~2" ( echo Repo path not found: %~2 & exit /b 1 )
    cd /d "%~2"
)

set ORKEY=
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b "OPENROUTER_API_KEY=" "%ROOT%\.env"`) do set ORKEY=%%b
if "%ORKEY%"=="" (
    echo [orchestrate-openrouter] OPENROUTER_API_KEY not found in %ROOT%\.env
    exit /b 1
)

set "CLAUDE_CONFIG_DIR=%ROOT%\agents\orchestrator"
REM the orchestrator context refers to files via $LA_ROOT, same as the squads
set "LA_ROOT=%ROOT%"

set ANTHROPIC_BASE_URL=https://openrouter.ai/api
set ANTHROPIC_AUTH_TOKEN=%ORKEY%
set ANTHROPIC_API_KEY=
set ANTHROPIC_SMALL_FAST_MODEL=%WORKER%

REM --- telemetry (fail-soft: a missing node or repo must NOT block the launch) ---
set "RUN_ID="
if exist "%ROOT%\scripts\run-manifest.mjs" for /f "delims=" %%i in ('node "%ROOT%\scripts\run-manifest.mjs" gen-id orch-openrouter 2^>nul') do set "RUN_ID=%%i"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" start "%RUN_ID%" orch-openrouter "%CD%" >nul 2>&1

echo [orchestrate-openrouter] orchestrator = z-ai/glm-5.2 (OpenRouter)
echo [orchestrate-openrouter] worker (haiku slot) = %WORKER%
echo [orchestrate-openrouter] working dir = %CD%
echo [orchestrate-openrouter] CLAUDE_CONFIG_DIR = %CLAUDE_CONFIG_DIR%
if defined RUN_ID echo [orchestrate-openrouter] run = %RUN_ID%
echo.

claude --model z-ai/glm-5.2 --mcp-config "%ROOT%\config\atlas-mcp.json" --append-system-prompt "ORCHESTRATION MODE: you PLAN, delegate, and approve. You do NOT read or write code yourself - your context is only for planning and integration. FIRST for ANY task: spawn a DeepSeek Flash worker (agent_spawn model=flash, cwd=repo) to explore the code and return a COMPACT summary (key files, signatures, where things live; max ~200 lines, no changes) - NEVER open large files yourself. Plan from that summary; ASK the user when unclear before delegating. Delegate ALL code to Flash, even tiny changes - never write feature code yourself; cut into the SMALLEST chunks, run on PARALLEL Flash workers (agent_spawn xN). Every worker instruction must be complete, precise, token-dense (min tokens, max info). Pro reviews Flash; escalate Flash->Pro->Sonnet->Opus. FINAL APPROVAL IS ALWAYS YOURS: integrate and test the whole before done. Atlas bridge sonnet/opus route to real Anthropic. Reason by Descartes' 4 rules: evidence (no guessing/haste), divide, order by dependency, full review. Read memory/orchestration.md first."

set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE% >nul 2>&1

endlocal
