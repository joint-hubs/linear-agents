# ADR-0003: WoW aging-WIP trend snapshot location

**Status:** Proposed

**Date:** 2026-06-24

## Context

CADENCE digest must show a week-over-week warning when the average age of WIP
(`In Progress` + `In Review`) tasks is rising. Computing a WoW trend requires a
**previous-week snapshot** of `meanWipAgeDays`. CADENCE is read-mostly by
constraint (`docs/agents/agent-0-cadence.md` §Safeguards) and in dry-run there is no
live Linear; the squad is launched once per week via cron. The question is
**where the previous snapshot lives** so the digest agent can read it next run.

Constraints:
- Agents are MiniMax M3 / DeepSeek V4 with small tool surfaces (Read + Linear MCP;
  `Edit` and `Bash(git push:*)` are denied in `agents/cadence/settings.json`).
- Must not change Linear schema (no new custom field on issues).
- Survives across weekly sessions (state is intentionally out-of-process —
  `docs/STATE.md` is the established pattern).
- No DB, no extra service in this repo today.

## Decision

**Persist the snapshot as a single JSON file per ISO week under `.state/`** in
the repo working tree, written by the digest agent and read by the next run's
digest agent:

```
.state/cadence-wip-<ISOweek>.json   e.g. .state/cadence-wip-2026W26.json
```

Schema (the **trend snapshot** contract — a separate, minimal artifact from the
decomposer's planning drafts):

```json
{
  "week": "2026W26",
  "generatedAt": "2026-06-24T08:00:00Z",
  "meanWipAgeDays": 2.4,
  "wipCount": 7,
  "agedCount": 2,
  "thresholdDays": { "digest": 3, "retro": 5 },
  "perTask": [
    { "id": "LIN-123", "state": "In Progress", "ageDays": 4.1, "drift": false }
  ]
}
```

Ownership: the **digest agent writes** this file at the end of each run (it
already has `Write` permission); the **collector does not**. The next run's
digest reads `.state/cadence-wip-<previousISOweek>.json` (computed from today's
ISO week − 1). If missing (first run / file deleted), the trend section renders
`"brak danych z poprzedniego tygodnia"` and no warning — **graceful, not an
error**.

ISO week is chosen (not a rolling 7-day window) because CADENCE runs on a weekly
cron and reports are consumed weekly; aligning snapshot boundaries to calendar
weeks matches the report cadence and avoids off-by-one drift.

## Consequences

- **Positive:** No new infra, no DB, no Linear schema change. Honors read-mostly
  (a file is a read/write on the agent's own working tree, not a Linear write).
  Survives sessions (matches `docs/STATE.md` philosophy). Self-contained for
  dry-run (no live Linear needed to exercise the trend path — a fixture file is
  enough). Human-readable, debuggable by Mateusz.
- **Positive:** `perTask[]` is kept so retro can reuse the same artifact
  (single source of truth for "what was WIP last week") and so trend debugging
  is possible without re-querying Linear.
- **Negative:** File is per-machine (local working tree). If CADENCE ever runs
  on multiple hosts / CI, snapshots diverge. Acceptable today (single-host
  solo profile); revisit when CADENCE moves to a shared runner.
- **Negative:** `.state/` is gitignored-style state; if the working tree is
  wiped, history is lost. Mitigation: file is reproducible from Linear on next
  run (only the *previous* week is unrecoverable → trend silently degrades to
  "brak danych" for one cycle).
- **Risks:** ISO-week boundary vs. actual cron drift (cron fires Mon 08:00 but
  file says W26) — acceptable, since both runs use the same convention.
  File-name collision if run twice in one week → the second run **overwrites**
  by design (latest snapshot wins; idempotent within a week).

## Alternatives Considered

1. **Linear note/comment as snapshot store** — write `meanWipAgeDays` as a
   comment on a dedicated "CADENCE trend" issue. Rejected: violates read-mostly
   (a Linear write every week), pollutes the issue stream, and is unreachable
   in dry-run (no live Linear).
2. **Inline in digest output only (no persistence)** — digest emits last
   week's number in its own output, next run reads previous digest. Rejected:
   digests are sent to @Mateusz as comments/notes, parsing them back is fragile
   and couples trend computation to prose output.
3. **Separate SQLite / JSON store service** — rejected: no such infra in this
   repo today; adds operational surface for a single 200-byte weekly artifact.
4. **`docs/STATE.md` append-only log** — rejected: `STATE.md` is free-form
   session narrative, not machine-parsed structured state; mixing the two
   breaks the established convention.
