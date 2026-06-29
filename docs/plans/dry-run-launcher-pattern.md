# Dry-run launcher pattern

Canonical template for `bin/<squad>-dry.bat`. F1/F2/F3 workers copy this verbatim, substituting `<squad>`.

## Template

```bat
@echo off
setlocal

REM --- 1. Squad identity (MUST be set BEFORE _lib.bat) ---
set "SQUAD_SLUG=<squad>"
set "SOURCE_PATH="
call "%~dp0_lib.bat" || exit /b 1

REM --- 2. Agent config dir ---
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\<squad>"

REM --- 3. Provider env (copy from the live launcher for this squad) ---
REM e.g. for dev:  set "ANTHROPIC_MODEL=z-ai/glm-5.2"
REM e.g. for plan: set "ANTHROPIC_MODEL=anthropic/claude-opus-4.8"
REM See bin/<squad>.bat for the exact model vars.

REM --- 4. Dry-run env var (consumed MECHANICALLY by scripts/linear-query.mjs) ---
REM The squad name is uppercased to match the *_DRY_RUN convention.
REM linear-query.mjs iterates env vars, finds the one ending in _DRY_RUN=1,
REM lowercases the prefix, and loads .state/mock/<prefix>-task.json.
set "<SQUAD_UPPER>_DRY_RUN=1"
echo [<squad>-dry] DRY_RUN active — using fixture .state\mock\<squad>-task.json

REM --- 5. Kickoff prompt ---
REM CRITICAL: Write prompt to a temp file to avoid Windows metachar issues
REM (%, ^, &, |, <, >, " inside the prompt). claude -p "..." would interpret
REM these as shell metacharacters. --prompt-file is not supported by claude.exe,
REM so we write to a temp file and pipe via stdin or use -p with a simple string.
REM For safety, keep the kickoff string simple and avoid metacharacters.
set "KICKOFF=DRY-RUN mode (<SQUAD_UPPER>_DRY_RUN=1). Read fixture from .state\mock\<squad>-task.json. Do NOT call mcp__linear__*. Do NOT git push. Auto-approve HITL gates. Run the squad workflow per docs/agent-<N>-<squad>.md. Stop after the squad output artifact is written."

claude -p "%KICKOFF%" --permission-mode default --max-turns 40

REM --- 6. Post-run verify (squad-specific) ---
REM dev / review: run mock verify
REM   node scripts/check.mjs
REM cadence: read-only — verify digest file exists
REM   if not exist "%ROOT%\.state\runs\%RUN_ID%\digest.md" echo [WARN] No digest produced

REM --- 7. End manifest ---
set "EXIT_CODE=%errorlevel%"
if defined RUN_ID node scripts\run-manifest.mjs end "%RUN_ID%" %EXIT_CODE%

endlocal
```

## Substitution table

| Placeholder | dev-dry | review-dry | cadence-dry |
|---|---|---|---|
| `<squad>` | `dev` | `review` | `cadence` |
| `<SQUAD_UPPER>` | `DEV` | `REVIEW` | `CADENCE` |
| `<N>` (agent doc) | `2` | `3` | `0` |
| Model (from `bin/<squad>.bat`) | `z-ai/glm-5.2` | `z-ai/glm-5.2` | `minimax/minimax-m3` |
| Fixture file | `.state/mock/dev-task.json` | `.state/mock/review-task.json` | `.state/mock/cadence-task.json` |
| Post-run verify | `node scripts/check.mjs` | `node scripts/check.mjs` | check `.state/runs/<RUN_ID>/digest.md` exists |

## Contract (all squads)

1. **No live Linear.** `linear-query.mjs` serves fixture; `linear-ops.mjs` MUST be called with `--dry-run` flag (enforced by agent system prompt).
2. **No git push.** Agent prompt must forbid `git push` / `git push --force`.
3. **Auto-approve HITL.** All human-in-the-loop gates auto-approved per dry-run convention.
4. **Manifest telemetry.** `RUN_ID` is set by `_lib.bat`; `run-manifest.mjs start/end` bracket the run.
5. **Fixture path.** Always `.state/mock/<squad>-task.json` — consumed mechanically by `linear-query.mjs` via `detectDryRun()`.
