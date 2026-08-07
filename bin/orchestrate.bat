@echo off
REM ---------------------------------------------------------------------------
REM Orchestrator on Ollama - Claude Code with Minimax-M3 as the strategist
REM and DeepSeek in the haiku slot as the worker.
REM
REM Moved from %LOCALAPPDATA%\hermes\scripts\orchestrate.bat (2026-08-06) so the
REM whole agent stack lives in one repo and is covered by telemetry.
REM Differences from the original:
REM   1. CLAUDE_CONFIG_DIR -> agents\orchestrator (own context inside the repo,
REM      instead of the global ~/.claude shared by every Claude Code session)
REM   2. --mcp-config config\atlas-mcp.json - atlas was registered ONLY in the
REM      global ~/.claude.json, so without this the agent_spawn bridge would
REM      disappear the moment CLAUDE_CONFIG_DIR moved
REM   3. run registered in telemetry (run-manifest), fail-soft
REM
REM NOTE: keep this file ASCII-only. cmd.exe reads .bat in the OEM codepage;
REM UTF-8 accented characters corrupt line parsing and break the launcher.
REM
REM Usage: bin\orchestrate.bat [pro|flash|minimax] [path-to-repo]
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

if /i "%PROFILE%"=="pro"     set WORKER=deepseek-v4-pro:cloud
if /i "%PROFILE%"=="flash"   set WORKER=deepseek-v4-flash:cloud
if /i "%PROFILE%"=="minimax" set WORKER=minimax-m3:cloud

if "%WORKER%"=="" (
    echo [orchestrate] Unknown profile "%PROFILE%". Use: pro ^| flash ^| minimax
    exit /b 1
)

if not "%~2"=="" (
    if not exist "%~2" (
        echo [orchestrate] Repo path not found: %~2
        exit /b 1
    )
    cd /d "%~2"
)

set "CLAUDE_CONFIG_DIR=%ROOT%\agents\orchestrator"
REM the orchestrator context refers to files via $LA_ROOT, same as the squads
set "LA_ROOT=%ROOT%"
set ANTHROPIC_SMALL_FAST_MODEL=%WORKER%

REM --- telemetry (fail-soft: a missing node or repo must NOT block the launch) ---
set "RUN_ID="
if exist "%ROOT%\scripts\run-manifest.mjs" for /f "delims=" %%i in ('node "%ROOT%\scripts\run-manifest.mjs" gen-id orch-ollama 2^>nul') do set "RUN_ID=%%i"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" start "%RUN_ID%" orch-ollama "%CD%" >nul 2>&1

echo [orchestrate] orchestrator = minimax-m3:cloud
echo [orchestrate] worker (haiku slot) = %WORKER%
echo [orchestrate] working dir = %CD%
echo [orchestrate] CLAUDE_CONFIG_DIR = %CLAUDE_CONFIG_DIR%
if defined RUN_ID echo [orchestrate] run = %RUN_ID%
echo.

ollama launch claude --model minimax-m3:cloud -- --mcp-config "%ROOT%\config\atlas-mcp.json" --append-system-prompt "ORCHESTRATION MODE (Minimax-M3): you are the STRATEGIST + integration point. You do NOT read code, you do NOT write code, you do NOT run tools that touch the repo. Your job: (1) UNDERSTAND the goal in plain terms, (2) ASK the user when anything is unclear - never guess, never invent constraints, (3) DELEGATE every implementation chunk to a worker, (4) REVIEW each worker's diff, (5) INTEGRATE, run the user's test command, and report back. DELEGATION RULES: for ANY non-trivial task, FIRST spawn a flash worker (agent_spawn model=flash, cwd=repo) to explore the code and return a COMPACT map (key files, key symbols, where state lives, max ~200 lines, NO changes). Plan from that map. Then cut work into the SMALLEST possible chunks, run on PARALLEL flash workers (agent_spawn xN) for independent parts, pro for hard isolated chunks, sonnet only for UX/design. NEVER escalate flash->pro for a chunk flash already failed at twice on the same exact prompt - rewrite the prompt or split the chunk instead. Every worker prompt must be a complete contract: exact files, exact task, acceptance criteria, cwd. Keep prompts token-dense (min tokens, max info). MODEL ESCALATION ORDER: flash -> pro -> sonnet -> opus. Use Atlas (mcp__atlas__agent_start) for parallel work; use native Task/haiku slot for the cheap single worker this launcher pinned. FINAL APPROVAL IS ALWAYS YOURS: integrate and test the whole before declaring done. Reason by Descartes' 4 rules: evidence (no guessing/haste), divide, order by dependency, full review. Read memory/orchestration.md first."

set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE% >nul 2>&1

endlocal
