@echo off
setlocal
set "SQUAD_SLUG=test"
set "SOURCE_PATH=%~1"
call "%~dp0_lib.bat" || exit /b 1
REM Agent 4 - TEST. Spec: docs/agents/agent-4-test.md
REM Main = MiniMax M3 (deploy/run, multimodal screenshoty). scenarios = DeepSeek V4 Flash (small_fast). root-cause -> GLM-5.2.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\test"
set "ANTHROPIC_MODEL=z-ai/glm-5.3-flash"
REM Model tiers (opus/sonnet/haiku/small_fast) come from the active provider:
REM config/models.json providers.<name>.tiers, applied by scripts/provider-resolve.mjs
REM via _lib.bat. Switching LA_PROVIDER switches them too. Override one here (AFTER
REM the call above) only if this squad genuinely needs a different model for it.
echo [test] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [test] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL%
claude %*
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
endlocal
