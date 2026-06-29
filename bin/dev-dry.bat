@echo off
setlocal
if /i "%~1"=="--parse-check" exit /b 0

REM --- 1. Squad identity (MUST be set BEFORE _lib.bat) ---
set "SQUAD_SLUG=dev"
set "SOURCE_PATH="
call "%~dp0_lib.bat" || exit /b 1

REM Agent 2 - DEV (DRY-RUN). Spec: docs/agent-2-dev.md
REM DRY-RUN: no push, no Linear MCP, auto-approve HITL gates.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\dev"
set "ANTHROPIC_MODEL=z-ai/glm-5.2"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.8"
set "ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6"
set "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"
set "DEV_DRY_RUN=1"
echo [dev-dry] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [dev-dry] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL% DRY_RUN=%DEV_DRY_RUN%

set "KICKOFF=DRY-RUN mode (DEV_DRY_RUN=1). Read fixture from .state\mock\dev-task.json. Do NOT call mcp__linear__*. Do NOT git push. Auto-approve HITL gates. Run the DEV workflow per docs/agent-2-dev.md. Execute the FULL DEV loop INCLUDING the linear-ops hand-off step (transition -> In Review, comment --dedup-tag, label) with --dry-run, THEN stop after the hand-off."

claude -p "%KICKOFF%" --permission-mode default --max-turns 40

echo [dev-dry] Verifying no drift...
node scripts/check.mjs
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node scripts\run-manifest.mjs end "%RUN_ID%" %EXIT_CODE%
echo DEV-DRY-RUN complete
endlocal
exit /b 0
