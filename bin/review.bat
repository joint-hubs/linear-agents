@echo off
setlocal
set "SQUAD_SLUG=review"
set "SOURCE_PATH=%~1"
call "%~dp0_lib.bat" || exit /b 1
REM Agent 3 - REVIEW. Spec: docs/agents/agent-3-review.md
REM Main = GLM-5.2 (lead + deep review). first-pass = DeepSeek V4 Pro (small_fast). security = Kimi K2.7 Code.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\review"
set "ANTHROPIC_MODEL=stealth/ox-alpha"
REM Model tiers (opus/sonnet/haiku/small_fast) come from the active provider:
REM config/models.json providers.<name>.tiers, applied by scripts/provider-resolve.mjs
REM via _lib.bat. Switching LA_PROVIDER switches them too. Override one here (AFTER
REM the call above) only if this squad genuinely needs a different model for it.
echo [review] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [review] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL%
claude %*
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
endlocal
