@echo off
setlocal
set "SQUAD_SLUG=dev"
REM L1b contract change (JOI-69): when launched via POST /api/launch, %1 is the
REM server-built kickoff prompt (HOW-TO §4), not a file path. It is recorded as
REM SOURCE_PATH (provenance in the run manifest) and re-passed to claude as the
REM initial input by `claude %*` below. A path-style arg still works when the
REM launcher is invoked by hand. See scripts/launch.mjs buildLaunchBat.
set "SOURCE_PATH=%~1"
call "%~dp0_lib.bat" || exit /b 1
REM Agent 2 - DEV. Spec: docs/agent-2-dev.md
REM Main = GLM-5.2 (base coding). Escalacja: multi-file/MCP -> Kimi, hard -> DeepSeek V4 Pro (przez /model lub subagent??w).
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\dev"
set "ANTHROPIC_MODEL=z-ai/glm-5.2"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.8"
set "ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6"
set "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"
echo [dev] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [dev] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL%
claude %*
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
endlocal
