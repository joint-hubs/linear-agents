# ADR-0002: Subagent model-pinning mechanism (Claude Code + OpenRouter)

**Status:** Accepted

**Date:** 2026-06-24

## Context

The linear-agents architecture routes every model through OpenRouter (all model ids
are OpenRouter slugs: `anthropic/claude-opus-4.8`, `z-ai/glm-5.2`, `minimax/minimax-m3`,
`deepseek/deepseek-v4-flash`, `moonshotai/kimi-k2.7-code`, …). Each of the 19 subagents
in `agents/<area>/agents/*.md` pins a `model:` field in its YAML frontmatter, e.g.
`agents/plan/agents/discovery.md` → `model: minimax/minimax-m3`. The squad launchers
(`bin/plan.bat`, `bin/dev.bat`, …) set `ANTHROPIC_MODEL` for the lead and rely on
Claude Code's built-in Agent tool to honor the subagent's frontmatter `model:` when the
lead delegates via the Task/Agent tool.

The entire "model per subagent" design rests on one assumption that was never verified
end-to-end: **does Claude Code actually honor `model: <openrouter-slug>` in a subagent's
frontmatter?** Task T-A1 (BUILD-BACKLOG) is the spike that resolves this. The reference
integration `C:\Users\mateu\AppData\Local\hermes\scripts\orchestrate-openrouter.bat` uses
a different, env-var-only mechanism (`ANTHROPIC_BASE_URL` + `ANTHROPIC_SMALL_FAST_MODEL`),
which raised doubt about whether frontmatter pinning works at all.

This ADR records the empirical verdict and the two defects the spike uncovered.

## Decision

**Frontmatter `model:` pinning is the primary, supported mechanism — with two mandatory
environment preconditions.** Keep the current architecture (explicit OpenRouter slug in
each subagent's `model:` frontmatter); do NOT switch to per-subagent `CLAUDE_CONFIG_DIR`
or slot-only mapping. Apply the two fixes below.

### Empirical evidence (spike `.spike-a1` / `.spike-a2`, Claude Code 2.1.187, OpenRouter)

Isolated `CLAUDE_CONFIG_DIR`, lead `z-ai/glm-5.2`, `ANTHROPIC_SMALL_FAST_MODEL=deepseek/deepseek-v4-flash`,
one subagent spawned via the Agent tool. Decisive observable = the `model:` field in the
subagent's API request body (captured via `ANTHROPIC_LOG=debug`), cross-checked with the
subagent's self-report.

| Test | frontmatter `model:` | `CLAUDE_CODE_SUBAGENT_MODEL` env | Subagent request `model:` | Result |
|------|----------------------|----------------------------------|---------------------------|--------|
| 1 | `minimax/minimax-m3` | set (`glm-5.2:cloud`, inherited) | `glm-5.2:cloud` | frontmatter **ignored** |
| 2 | `haiku` | set (`glm-5.2:cloud`, inherited) | `glm-5.2:cloud` | alias **ignored** |
| 3a | `minimax/minimax-m3` | **cleared** | **`minimax/minimax-m3`** (HTTP 200) | arbitrary slug **honored** |
| 3b | `haiku` | cleared, `DEFAULT_HAIKU=minimax` | **`minimax/minimax-m3`** (HTTP 200) | alias mapped via `ANTHROPIC_DEFAULT_HAIKU_MODEL` |

### Verdict

1. **Explicit OpenRouter slug in `model:` frontmatter IS honored** and passed through to
   the API verbatim — but **only when `CLAUDE_CODE_SUBAGENT_MODEL` is not set** in the
   process environment (Test 3a).
2. **Aliases `opus` / `sonnet` / `haiku` are remapped** via `ANTHROPIC_DEFAULT_OPUS_MODEL`
   / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` respectively
   (Test 3b). The current subagents use explicit slugs, so aliases are not exercised
   today, but the mechanism is valid as a fallback.
3. **`CLAUDE_CODE_SUBAGENT_MODEL`, when set, overrides EVERYTHING** — both arbitrary slugs
   and aliases (Tests 1 & 2). It forces all Agent-tool subagents onto one model. This is
   the trap: any parent session that exports `CLAUDE_CODE_SUBAGENT_MODEL` (e.g. an
   orchestrator launcher) will silently flatten the whole squad onto a single model.

### Required fixes (block all squad execution until applied)

**Fix 1 — `bin/_lib.bat:17` base URL (BUG, P0).** The shared launcher sets
`ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1`. The Claude Code SDK appends
`/v1/messages`, producing `https://openrouter.ai/api/v1/v1/messages` → **HTTP 404 on
every request, in every squad**. Confirmed empirically (1.25 MB of 404 error pages in
the first spike run). Correct value is `https://openrouter.ai/api` (no `/v1`), matching
the working `orchestrate-openrouter.bat`. **This single bug breaks all of Phase D.**

**Fix 2 — clear `CLAUDE_CODE_SUBAGENT_MODEL` in `bin/_lib.bat`.** Add
`set "CLAUDE_CODE_SUBAGENT_MODEL="` so an inherited parent environment cannot override
per-subagent frontmatter pinning. Production launches from a clean terminal are unaffected
today (the var is unset), but this makes the launcher robust when invoked from inside
another Claude Code session (the orchestrator, CI, headless runners in Phase G).

### Recommended (non-blocking)

- Set `ANTHROPIC_DEFAULT_HAIKU_MODEL` in the squad launchers (alongside the existing
  `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL`) so the `haiku` alias
  resolves to a deliberate OpenRouter slug rather than a SDK default. Not required while
  no subagent uses the `haiku` alias.
- `scripts/check.mjs` (T-A2) should lint that every subagent `model:` value is either a
  known alias (`opus`/`sonnet`/`haiku`/`inherit`) or a slug present in `config/models.map`.

## Consequences

- **Positive:** The existing 19-subagent architecture is sound; no rewrite to per-subagent
  config dirs or slot-only mapping is needed. Per-subagent cost/control is real and
  observable in API logs. Cheap model selection per role works as designed.
- **Positive:** The spike surfaced a P0 latent bug (`_lib.bat` base URL) that would have
  blocked Phase D entirely; fixing it now is a one-line change.
- **Negative:** Correctness depends on environment hygiene. A single inherited
  `CLAUDE_CODE_SUBAGENT_MODEL` silently defeats the whole model-per-subagent design.
  Mitigated by Fix 2, but future launchers/headless runners must preserve it.
- **Negative:** Model selection is not visible to the user at runtime (only in debug logs /
  OpenRouter dashboard). The control-panel UI (Phase E, T-E6) must surface the resolved
  per-agent model, not just the configured frontmatter value.
- **Risks:** Claude Code version drift — the pass-through behavior for arbitrary `model:`
  strings and the `CLAUDE_CODE_SUBAGENT_MODEL` precedence are observed on 2.1.187; a future
  version could validate/whitelist `model:` and reject OpenRouter slugs. Re-run this spike
  (`.spike-a1`/`.spike-a2` harness) on any Claude Code upgrade. If arbitrary slugs stop
  being honored, fall back to alias + `ANTHROPIC_DEFAULT_*_MODEL` slot mapping (3 slots) or
  the `bin/agent.bat` standalone process-per-subagent approach (`ANTHROPIC_MODEL` env
  override, which always works).

## Alternatives Considered

1. **Per-subagent `CLAUDE_CONFIG_DIR`** — one isolated config dir per subagent with its own
   `ANTHROPIC_MODEL` env. Rejected: frontmatter pass-through works, so this adds process
   overhead and breaks lead-spawns-subagent delegation (the lead could not spawn arbitrary
   subagents from a single session). Kept only as the `bin/agent.bat` standalone path for
   running a single subagent out-of-band.
2. **Slot-only mapping (alias + `ANTHROPIC_DEFAULT_*_MODEL`)** — limit subagents to
   `opus`/`sonnet`/`haiku` aliases remapped to 3 OpenRouter slugs. Rejected as primary: only
   3 slots vs. the 6+ distinct models the squad design wants per role. Valid as a fallback
   if arbitrary-slug pass-through breaks in a future Claude Code version.
3. **`CLAUDE_CODE_SUBAGENT_MODEL` as the sole mechanism** — one model for all subagents.
   Rejected: collapses the model-per-subagent design and the cost/role routing in
   `config/models.map`. (This is exactly the failure mode Tests 1 & 2 demonstrated when the
   var was inherited.)

## References

- BUILD-BACKLOG task T-A1 (spike contract) — `docs/BUILD-BACKLOG.md`
- ADR-0001 — provider routing & fallback (native vs OpenRouter profiles)
- Reference integration — `C:\Users\mateu\AppData\Local\hermes\scripts\orchestrate-openrouter.bat`
- Spike harness + logs — `.spike-a1/`, `.spike-a2/` (re-runnable: `run-spike.ps1`, `run-clean.ps1`)