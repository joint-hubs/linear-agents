@echo off
setlocal
if /i "%~1"=="--parse-check" exit /b 0

REM --- 1. Squad identity (MUST be set BEFORE _lib.bat) ---
set "SQUAD_SLUG=dev"
set "SOURCE_PATH="
call "%~dp0_lib.bat" || exit /b 1

REM Agent 2 - DEV (DRY-RUN). Spec: docs/agents/agent-2-dev.md
REM DRY-RUN: no push, no Linear MCP, auto-approve HITL gates.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\dev"
set "ANTHROPIC_MODEL=stealth/ox-alpha"
REM small_fast stays minimax-m3: the openrouter tier is deepseek-v4-flash,
REM and this squad ran minimax before the tiers moved to the provider.
set "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"
REM Model tiers (opus/sonnet/haiku/small_fast) come from the active provider:
REM config/models.json providers.<name>.tiers, applied by scripts/provider-resolve.mjs
REM via _lib.bat. Switching LA_PROVIDER switches them too. Override one here (AFTER
REM the call above) only if this squad genuinely needs a different model for it.
set "DEV_DRY_RUN=1"
echo [dev-dry] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [dev-dry] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL% DRY_RUN=%DEV_DRY_RUN%

set "KICKOFF=DRY-RUN mode (DEV_DRY_RUN=1). Read fixture from .state\mock\dev-task.json. Do NOT call mcp__linear__*. Do NOT git push. Auto-approve HITL gates. Run the DEV workflow per docs/agents/agent-2-dev.md. Execute the FULL DEV loop INCLUDING the linear-ops hand-off step (transition -> In Review, comment --dedup-tag, label) with --dry-run, THEN stop after the hand-off."

claude -p "%KICKOFF%" --permission-mode default --max-turns 40

echo [dev-dry] Verifying no drift...
node "%ROOT%\scripts\check.mjs"
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
echo DEV-DRY-RUN complete
endlocal
exit /b 0
