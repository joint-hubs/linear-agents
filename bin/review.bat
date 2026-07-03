@echo off
setlocal
set "SQUAD_SLUG=review"
set "SOURCE_PATH=%~1"
call "%~dp0_lib.bat" || exit /b 1
REM Agent 3 - REVIEW. Spec: docs/agent-3-review.md
REM Main = GLM-5.2 (lead + deep review). first-pass = DeepSeek V4 Pro (small_fast). security = Kimi K2.7 Code.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\review"
set "ANTHROPIC_MODEL=z-ai/glm-5.2"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.8"
set "ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6"
set "ANTHROPIC_SMALL_FAST_MODEL=deepseek/deepseek-v4-flash"
echo [review] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [review] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL%
claude %*
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
endlocal
