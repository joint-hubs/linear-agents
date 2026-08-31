@echo off
setlocal
if /i "%~1"=="--parse-check" exit /b 0
call "%~dp0_lib.bat" || exit /b 1
REM Agent 1 - PLAN (DRY-RUN). Spec: docs/agents/agent-1-planner.md
REM DRY-RUN: no push, no Linear MCP, auto-approve HITL gates.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\plan"
set "ANTHROPIC_MODEL=z-ai/glm-5.3"
REM small_fast stays minimax-m3: the openrouter tier is deepseek-v4-flash,
REM and this squad ran minimax before the tiers moved to the provider.
set "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"
REM Model tiers (opus/sonnet/haiku/small_fast) come from the active provider:
REM config/models.json providers.<name>.tiers, applied by scripts/provider-resolve.mjs
REM via _lib.bat. Switching LA_PROVIDER switches them too. Override one here (AFTER
REM the call above) only if this squad genuinely needs a different model for it.
set "PLAN_DRY_RUN=1"
echo [plan-dry] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [plan-dry] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL% DRY_RUN=%PLAN_DRY_RUN%

set "KICKOFF=DRY-RUN mode (PLAN_DRY_RUN=1). Read planning/inbox/sample.md. Run discovery > spec > (spec-review) > decompose per the DRY-RUN section of your system prompt: auto-approve HITL gates, do NOT invoke push, do NOT call mcp__linear. The decomposer must write its draft JSON to planning/briefs/.draft.<parent.externalId>.json. Stop after the draft is written."

claude -p "%KICKOFF%" --permission-mode default --max-turns 40

echo [plan-dry] Ingesting draft...
node "%ROOT%\scripts\mock-linear.mjs" --ingest
echo [plan-dry] Verifying briefs...
node "%ROOT%\scripts\mock-linear.mjs" --verify
echo PLAN-DRY-RUN complete
endlocal
exit /b 0
