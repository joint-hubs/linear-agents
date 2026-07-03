@echo off
setlocal
if /i "%~1"=="--parse-check" exit /b 0

REM --- 1. Squad identity (MUST be set BEFORE _lib.bat) ---
set "SQUAD_SLUG=cadence"
set "SOURCE_PATH="
call "%~dp0_lib.bat" || exit /b 1

REM Agent 0 - CADENCE (DRY-RUN). Spec: docs/agents/agent-0-cadence.md
REM DRY-RUN: no push, no Linear MCP, auto-approve HITL gates.
REM Cadence is read-mostly — collects, retrospects, writes digest.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\cadence"
set "ANTHROPIC_MODEL=minimax/minimax-m3"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.8"
set "ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6"
set "ANTHROPIC_SMALL_FAST_MODEL=deepseek/deepseek-v4-flash"
set "CADENCE_DRY_RUN=1"
echo [cadence-dry] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [cadence-dry] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL% DRY_RUN=%CADENCE_DRY_RUN%

set "KICKOFF=DRY-RUN mode (CADENCE_DRY_RUN=1). Read fixture from .state\mock\cadence-task.json via linear-query. Do NOT call mcp__linear__*. Do NOT git push. Do NOT change task status/label/scope (read-mostly). START IMMEDIATELY from collector (do not wait for Hermes/cron). Run the CADENCE workflow per docs/agents/agent-0-cadence.md: collect -> retro -> PL digest to .state\cadence\<ISOweek>.md. Pass --dry-run to any linear-ops comment. Stop after the digest file is written."

claude -p "%KICKOFF%" --permission-mode default --max-turns 40

echo [cadence-dry] Verifying no drift...
node "%ROOT%\scripts\check.mjs"
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
echo CADENCE-DRY-RUN complete
endlocal
exit /b 0
