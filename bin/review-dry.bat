@echo off
setlocal
if /i "%~1"=="--parse-check" exit /b 0

REM --- 1. Squad identity (MUST be set BEFORE _lib.bat) ---
set "SQUAD_SLUG=review"
set "SOURCE_PATH="
call "%~dp0_lib.bat" || exit /b 1

REM Agent 3 - REVIEW (DRY-RUN). Spec: docs/agent-3-review.md
REM DRY-RUN: no push, no Linear MCP, auto-approve HITL gates.
REM Review is read-only analysis — no code edits or writes.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\review"
set "ANTHROPIC_MODEL=z-ai/glm-5.2"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.8"
set "ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6"
set "ANTHROPIC_SMALL_FAST_MODEL=deepseek/deepseek-v4-flash"
set "REVIEW_DRY_RUN=1"
echo [review-dry] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [review-dry] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL% DRY_RUN=%REVIEW_DRY_RUN%

set "KICKOFF=DRY-RUN mode (REVIEW_DRY_RUN=1). Read fixture from .state\mock\review-task.json. Do NOT call mcp__linear__*. Do NOT git push. Do NOT edit or write code (review is read-only analysis). Auto-approve HITL gates. Run the REVIEW workflow per docs/agent-3-review.md: parallel first-pass/security/deep review, merge findings, format as Conventional Comments, produce verdict. Execute the FULL REVIEW loop INCLUDING the linear-ops verdict step (comment --dedup-tag with the Conventional Comments, transition/label per verdict) with --dry-run, THEN stop after the verdict hand-off."

claude -p "%KICKOFF%" --permission-mode default --max-turns 40

echo [review-dry] Verifying no drift...
node "%ROOT%\scripts\check.mjs"
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
echo REVIEW-DRY-RUN complete
endlocal
exit /b 0
