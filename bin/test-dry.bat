@echo off
setlocal
if /i "%~1"=="--parse-check" exit /b 0

REM --- 1. Squad identity (MUST be set BEFORE _lib.bat) ---
set "SQUAD_SLUG=test"
set "SOURCE_PATH="
call "%~dp0_lib.bat" || exit /b 1

REM Agent 4 - TEST (DRY-RUN). Spec: docs/agents/agent-4-test.md
REM DRY-RUN: no push, no Linear MCP, no real GCP deploy.
REM Health-check is simulated from fixture's dryRunScenario field.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\test"
set "ANTHROPIC_MODEL=z-ai/glm-5.3-flash"
REM Model tiers (opus/sonnet/haiku/small_fast) come from the active provider:
REM config/models.json providers.<name>.tiers, applied by scripts/provider-resolve.mjs
REM via _lib.bat. Switching LA_PROVIDER switches them too. Override one here (AFTER
REM the call above) only if this squad genuinely needs a different model for it.
set "TEST_DRY_RUN=1"
echo [test-dry] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [test-dry] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL% DRY_RUN=%TEST_DRY_RUN%

set "KICKOFF=DRY-RUN mode (TEST_DRY_RUN=1). Read fixture from .state\mock\test-task.json via linear-query (no API calls). Do NOT call mcp__linear__*. Do NOT git push. Do NOT run a real GCP deploy — the deploy URL comes from the fixture. Health-check is simulated from the fixture's dryRunScenario field (healthy -> PASS path; unhealthy -> auto-rollback, 0 E2E delegations, FAIL->root_cause path). Auto-approve HITL gates. Use synthetic data only — never prod PII/RODO. Run the TEST workflow per docs/agents/agent-4-test.md: pick stage:testing -> deploy (mocked) -> health-check (simulated) -> scenario-gen -> runner -> verdict. Execute the FULL TEST loop INCLUDING the linear-ops verdict step (transition/label/comment) with --dry-run, THEN stop after the result comment. To exercise the unhealthy variant, swap the primary fixture to .state\mock\test-task-unhealthy.json (dryRunScenario=unhealthy)."

claude -p "%KICKOFF%" --permission-mode default --max-turns 40

echo [test-dry] Verifying no drift...
node "%ROOT%\scripts\check.mjs"
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
echo TEST-DRY-RUN complete
endlocal
exit /b 0
