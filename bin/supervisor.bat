@echo off
setlocal
set "SQUAD_SLUG=supervisor"
set "SOURCE_PATH=%~1"
REM The repo the Supervisor is working ON is the directory it was launched FROM.
REM Captured here, before anything can cd, and handed to supervisor-spawn.mjs so
REM children get a worktree of THAT repo. Without it spawn defaulted to
REM linear-agents and every child got a checkout of the orchestration repo
REM instead of the code the task is about (FOC-172).
set "LA_SUPERVISOR_REPO=%CD%"
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
    if not defined SUPERVISOR_MODEL set "SUPERVISOR_MODEL=z-ai/glm-5.3-flash"
    REM small_fast stays minimax-m3: the openrouter tier is deepseek-v4-flash, and this
    REM squad ran minimax before the tiers moved to the provider. The guard belongs on
    REM SUPERVISOR_MODEL above, never on this line — they are different settings.
    set "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"
)
REM The four model tiers are NOT set here. They come from the active provider —
REM config/models.json providers.<name>.tiers, applied by scripts/provider-resolve.mjs
REM through _lib.bat — so switching LA_PROVIDER switches them with it.
REM
REM That matters most for the "sonnet tier", which no role in this repo routes work
REM to. Claude Code claims it for its own AUTO MODE PERMISSION CLASSIFIER: on an
REM external gateway it defaults to the sonnet tier and pins it for the session
REM (changelog, "the permission classifier now defaults to Sonnet 5 for external
REM sessions"). Every Bash call is judged by it, so a slug the active provider does
REM not host breaks every tool call rather than one role.
REM
REM That is not hypothetical. These launchers used to hardcode OpenRouter slugs
REM while LA_PROVIDER was nebul, which serves open models only and has no Anthropic
REM model under any id. Captured 2026-08-27 by the logging proxy: 24 of 30 recorded
REM failures were 404 model_not_found, 18 of them the small_fast slug — the
REM classifier dying on every permission question — plus a spawned Explore agent
REM dying outright on anthropic/claude-opus-4.8.
REM
REM Cost, measured 2026-08-27 on OpenRouter: one classification was 40 901 input /
REM 7 output tokens at $0.153 — SEVEN AND A HALF TIMES the $0.0204 the DEV child's
REM actual work cost in the same window, and it grows with the conversation because
REM the classifier reads it. The failure mode is fail-closed: a classifier that
REM cannot evaluate an action errors out instead of allowing it.
REM
REM To cut that cost, change providers.<name>.tiers.sonnet/smallFast in
REM config/models.json — once, for every squad. On nebul, mistralai/Ministral-3-14B-
REM Instruct-2512 was verified to return tool_use; Qwen/Qwen3-30B-A3B-Instruct-2507
REM was verified NOT to and must not be used. Any replacement also needs a pricing
REM entry under pricing.<provider> or its cost reports as $0.
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
