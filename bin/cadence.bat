@echo off
setlocal
set "SQUAD_SLUG=cadence"
set "SOURCE_PATH=%~1"
call "%~dp0_lib.bat" || exit /b 1
REM Agent 0 - CADENCE (weekly). Spec: docs/agents/agent-0-cadence.md
REM Main = MiniMax M3 (czyta 100+ issues, tanio). Retro -> GLM-5.2. Digest PL -> DeepSeek V4 Pro. Moze isc z crona.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\cadence"
set "ANTHROPIC_MODEL=minimax/minimax-m3"
REM Model tiers (opus/sonnet/haiku/small_fast) come from the active provider:
REM config/models.json providers.<name>.tiers, applied by scripts/provider-resolve.mjs
REM via _lib.bat. Switching LA_PROVIDER switches them too. Override one here (AFTER
REM the call above) only if this squad genuinely needs a different model for it.
echo [cadence] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [cadence] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL%
claude %*
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
endlocal
