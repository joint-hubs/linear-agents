@echo off
setlocal
if /i "%~1"=="--parse-check" exit /b 0
call "%~dp0_lib.bat" || exit /b 1
REM Agent 1 - PLAN (DRY-RUN). Spec: docs/agent-1-planner.md
REM DRY-RUN: no push, no Linear MCP, auto-approve HITL gates.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\plan"
set "ANTHROPIC_MODEL=anthropic/claude-opus-4.8"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.8"
set "ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6"
set "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"
set "PLAN_DRY_RUN=1"
echo [plan-dry] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [plan-dry] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL% DRY_RUN=%PLAN_DRY_RUN%

set "KICKOFF=DRY-RUN mode (PLAN_DRY_RUN=1). Read planning/inbox/sample.md. Run discovery > spec > (spec-review) > decompose per the DRY-RUN section of your system prompt: auto-approve HITL gates, do NOT invoke push, do NOT call mcp__linear. The decomposer must write its draft JSON to planning/briefs/.draft.<parent.externalId>.json. Stop after the draft is written."

claude -p "%KICKOFF%" --permission-mode default --max-turns 40

echo [plan-dry] Ingesting draft...
node scripts/mock-linear.mjs --ingest
echo [plan-dry] Verifying briefs...
node scripts/mock-linear.mjs --verify
echo PLAN-DRY-RUN complete
endlocal
exit /b 0