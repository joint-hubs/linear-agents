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
REM Agent 2 - DEV. Spec: docs/agents/agent-2-dev.md
REM Task lead/roles use GLM Flash; role purpose and routing come from config/models.json.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\dev"
set "ANTHROPIC_MODEL=z-ai/glm-5.3-flash"
REM Model tiers (opus/sonnet/haiku/small_fast) come from the active provider:
REM config/models.json providers.<name>.tiers, applied by scripts/provider-resolve.mjs
REM via _lib.bat. Switching LA_PROVIDER switches them too. Override one here (AFTER
REM the call above) only if this squad genuinely needs a different model for it.
echo [dev] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [dev] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL%
claude %*
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
endlocal
