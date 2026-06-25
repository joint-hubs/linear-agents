@echo off
setlocal
set "SQUAD_SLUG=plan"
set "SOURCE_PATH=%~1"
call "%~dp0_lib.bat" || exit /b 1
REM Agent 1 - PLAN. Spec: docs/agent-1-planner.md
REM Main = Opus (PLAN lead). discovery/spec-review = MiniMax M3. Tanie etapy (spec=GLM-5.2, decompose/enrich=MiniMax M3,
REM push=DeepSeek) przez subagent??w w agents/plan/agents/ + slot small_fast.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\plan"
if defined NATIVE (
    set "ANTHROPIC_MODEL=claude-opus-4-8"
    set "ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8"
    set "ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6"
    set "ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5-20251001"
    set "ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5-20251001"
) else (
    set "ANTHROPIC_MODEL=anthropic/claude-opus-4.8"
    set "ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.8"
    set "ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6"
    set "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"
)
echo [plan] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [plan] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL%
claude %*
set "EXIT_CODE=%errorlevel%"
if defined NATIVE if %EXIT_CODE% neq 0 echo Native (Anthropic subscription) run failed. Re-run with OpenRouter: bin\plan.bat %*
if defined RUN_ID node scripts\run-manifest.mjs end "%RUN_ID%" %EXIT_CODE%
endlocal
