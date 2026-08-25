@echo off
setlocal
set "SQUAD_SLUG=supervisor"
set "SOURCE_PATH=%~1"
call "%~dp0_lib.bat" || exit /b 1
REM Frontman Supervisor. Spec: planning/briefs/spec-foc-116-supervisor.md, ADR-0009.
REM The ONLY user-facing launcher of the supervised pipeline: Mateusz talks here and
REM nowhere else. Children (plan/dev/review/test) are started by scripts/supervisor-spawn.mjs
REM as headless processes in their own worktrees - never by a .bat, never with a console.
REM Model: routing.supervisor.default in config/models.json; SUPERVISOR_MODEL overrides.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\supervisor"
if defined NATIVE (
    if not defined SUPERVISOR_MODEL set "SUPERVISOR_MODEL=claude-opus-4-8"
    set "ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8"
    set "ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6"
    set "ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5-20251001"
    set "ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5-20251001"
) else (
    if not defined SUPERVISOR_MODEL set "SUPERVISOR_MODEL=z-ai/glm-5.2"
    set "ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.8"
    set "ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6"
    set "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"
)
REM Deliberately OUTSIDE the block above. Inside a parenthesised block cmd expands
REM %SUPERVISOR_MODEL% when it parses the whole block — before the `set` on the
REM previous line has run — so this read empty and claude started with no model.
REM Caught by running the launcher with a shim; a read-through would not have.
set "ANTHROPIC_MODEL=%SUPERVISOR_MODEL%"
REM Children inherit this so they can find the run directory without being told.
if not defined LA_SUPERVISOR_RUN set "LA_SUPERVISOR_RUN=%RUN_ID%"
echo [supervisor] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [supervisor] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL%
echo [supervisor] run=%LA_SUPERVISOR_RUN%  issue=%SOURCE_PATH%
claude %*
set "EXIT_CODE=%errorlevel%"
if defined NATIVE if %EXIT_CODE% neq 0 echo Native (Anthropic subscription) run failed. Re-run with OpenRouter: bin\supervisor.bat %*
if defined RUN_ID node "%ROOT%\scripts\run-manifest.mjs" end "%RUN_ID%" %EXIT_CODE%
endlocal
