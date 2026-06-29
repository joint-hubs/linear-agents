# Plan: Finish DEV / REVIEW / CADENCE squads to e2e

Status: REVIEWED (Sonnet adversarial review adopted — see bottom). Scope decided with
Mateusz: all 4 squads in dependency order, **TEST deferred** until GCP VM is provided.
Branch: `feat/phase-a-offline-foundation`.

## Diagnosis

DEV / REVIEW / TEST / CADENCE are **real stubs**, not empty shells: each has a launcher
(`bin/*.bat` + run manifest), `agents/<squad>/CLAUDE.md` with a full pipeline, all subagent
configs (`agents/<squad>/agents/*.md`), and `settings.json` with Linear MCP allowed.

**What's missing = glue scripts.** The single biggest unblocker: there is **no read-side
Linear script**. Only `scripts/linear-push.mjs` (writes, creates epic+subissues) exists.
MCP `mcp__linear__*` is allowed in settings but does not work headless (decision T-C2). So
no squad can read Linear (DEV can't pick a `Todo`, REVIEW can't load a diff, CADENCE can't
collect state). And there is **no script for mutating existing issues** (status transitions,
label add/remove, comments) — `linear-push.mjs` only creates.

## Architecture decisions

1. **Extract a tiny shared client** `scripts/linear-client.mjs` exporting `loadEnv()`,
   `graphql(query, vars)`, `resolveTeam(key)`, `resolveIssue(identifier)` (FEN-12 → UUID),
   `ENDPOINT`. Mirrors the self-contained, zero-dep style of `linear-push.mjs` (global fetch,
   `Authorization: <raw key>` header, no Bearer). **`linear-push.mjs` is NOT refactored**
   (zero risk to working PLAN) — it keeps its own `graphql()`; the new scripts share the client.

2. **`scripts/linear-query.mjs`** — read-side, headless, API key. Subcommand CLI:
   - `issues --status <name> [--label <flag>] [--json]` — team issues by state (+ optional
     label filter, e.g. `dor-ok`); nodes: id, identifier, title, url, state, estimate,
     labels, parent, children, assignee, timestamps.
   - `issue <id|identifier> [--json]` — full detail incl. description, comments, relations.
   - `comments <id|identifier>` — just comments.
   - `search "<term>"` — `searchIssues`.
   - `team` — resolve team id + dump states/labels (debug helper).
   - `--json` for machine output; human-readable default. Exit 0/1/2 (2 = usage).
   - Identifier `FEN-12` resolved via `resolveIssue` (search then team-issues match).

3. **`scripts/linear-ops.mjs`** — write mutations on **existing** issues, headless, API key:
   - `transition <id|identifier> --status <name>` — `issueUpdate` with resolved `stateId`.
   - `label <id> --add <l> --remove <l> ...` — fetch current `labelIds`, compute new set,
     `issueUpdate` (add/remove without clobbering other labels).
   - `comment <id> --body <text|--body-file <path>>` — `commentCreate`.
   - `estimate <id> --estimate <S|M|L|...>` — `issueUpdate`.
   - `--dry-run` prints the planned mutation, writes nothing. Exit 0/1/2.
   - Comments are **not** idempotent by default (caller's responsibility); transitions and
     labels are naturally idempotent.

4. **Dry-run launchers** `bin/dev-dry.bat`, `bin/review-dry.bat` mirroring `bin/plan-dry.bat`:
   set `CLAUDE_CONFIG_DIR`, squad env `DEV_DRY_RUN=1` / `REVIEW_DRY_RUN=1`, model envs, run
   `claude -p "<kickoff>"`, then a squad mock verify step. In dry-run the agent reads a
   **local mock fixture** (`.state/mock/<squad>-task.json`) instead of `linear-query`, and
   passes `--dry-run` to every `linear-ops` call (no Linear writes, no git push).

5. **`check.mjs`** extended with 2 new lint checks: (a) every `bin/*-dry.bat` sets its
   `*_DRY_RUN=1` env; (b) `linear-query.mjs` / `linear-ops.mjs` CLI surface matches the
   contract below (smoke `--help`).

## Phases (dependency-ordered)

### F0 — Shared Linear scripts (task #1) — unblocks F1/F2/F3
- F0a: `scripts/linear-client.mjs` (loadEnv, graphql, resolveTeam, resolveIssue).
- F0b: `scripts/linear-query.mjs` (subcommands above).
- F0c: `scripts/linear-ops.mjs` (subcommands above, `--dry-run`).
- F0d: extend `scripts/check.mjs` with the 2 new lint checks.
- F0e: dry-run launcher **template** (the actual `dev-dry.bat`/`review-dry.bat` ship with
  their squads in F1/F2; F0 only fixes the shared pattern + a mock-fixture loader helper).
- **Verify (orchestrator):** `node scripts/linear-query.mjs team` + `issues --status Todo`
  against live team FEN → real output; `linear-ops ... --dry-run` preview; `check.mjs` green.

### F1 — DEV squad e2e (task #2, T-D2)
- Wire `agents/dev/CLAUDE.md` + subagents to call:
  - `linear-query.mjs issues --status Todo --label dor-ok` → pick (WIP=1, dep-aware via
    `children`/`relations`).
  - `linear-ops.mjs transition <id> --status "In Progress"` + `label --add ai:coded`.
  - branch mgmt helper `scripts/dev-branch.mjs` (branch name from identifier+slug,
    `git checkout -b`, pull/rebase before start; **no `git push`** — denied in settings).
  - self-verify: build/test via npm scripts (delivery-loop); on fail → retry→fallback→
    `escalated` label + `needs:answer`.
  - hand-off: `linear-ops.mjs comment <id> --body-file <summary>` + `transition --status
    "In Review"` + `label --add ai:coded` (keep).
- `bin/dev-dry.bat` + `.state/mock/dev-task.json` fixture.
- **Verify (orchestrator):** `dev-dry.bat` run end-to-end on the mock task (no Linear/git
  writes); then a **live pilot** on one real FEN `Todo`+`dor-ok` task → codes, self-verifies,
  hands off to `In Review`.

### F2 — REVIEW squad e2e (task #3, T-D3)
- Wire `agents/review/CLAUDE.md` + subagents to call:
  - `linear-query.mjs issues --status "In Review"` → pick; `issue <id>` for description +
    comments (hand-off summary) + relations.
  - diff load: from the task's branch — `git diff main...<branch>` (branch inferred from
    identifier via `scripts/dev-branch.mjs` naming convention, or a `dev-branch` label/comment).
  - merge 3 parallel passes (first-pass ∥ security ∥ deep) → Conventional Comments file
    `.state/reviews/<id>-round<N>.md`; post via `linear-ops.mjs comment`.
  - round counter: `utils.mjs reviewRound({ taskId, maxRounds: 2 })` → on `escalated`,
    `linear-ops.mjs label --add escalated`.
  - verdict: clean → `transition --status "In Review"` keep + `label --add ai:reviewed,dod-ok`
    + `label --add stage:testing` (hand to TEST); issues → `transition --status "In Progress"`
    + round++.
- `bin/review-dry.bat` + `.state/mock/review-task.json` fixture + mock diff.
- **Verify (orchestrator):** `review-dry.bat` e2e on mock; then **live pilot** on the FEN
  task that DEV handed off in F1 → review, post Conventional Comments, transition.

### F3 — CADENCE squad e2e (task #4, T-D5)
- Wire `agents/cadence/agents/collector.md` to `linear-query.mjs`:
  - throughput (completed this week), In Progress / In Review counts, `blocked`,
    `escalated`, `over-budget`, aging WIP (startedAt old), tasks without Initiative
    (`parent` null), stale `needs:*` (label + old updatedAt).
  - `retro.md` (GLM-5.2) drift + blameless retro + 1-3 action items.
  - `digest.md` (DeepSeek V4 Pro) → **PL digest** written to
    `.state/cadence/<week>.md` + optional `linear-ops.mjs comment` on a chosen issue
    (or a dedicated FEN digest issue). Read-mostly: no status changes without approval.
- `bin/cadence-dry.bat` = run against **live Linear reads**, `--dry-run` on any
  `linear-ops` comment (so dry = real read, no writes). No mock needed (read-only).
- **Verify (orchestrator):** one real weekly digest run → PL markdown file produced with
  real throughput/blockers/drift from team FEN.

## Out of scope (this session)
- TEST squad full e2e (needs GCP VM + GitHub secrets from Mateusz) — T-D4 deferred.
- CADENCE cron trigger / Hermes integration (external systems, not this repo).
- Bot `@flow` OAuth app (deferred earlier).
- Telemetry Phase 2 / Gantt panel (separate PRDs).

## Open questions — RESOLVED (Sonnet review)

- **Extract `linear-client.mjs`?** YES, keep `linear-push.mjs` untouched. Client must validate
  `LINEAR_API_KEY` up-front (exit with clear message) — `linear-push.mjs` doesn't, error leaks
  out of `graphql()`.
- **`label --add/--remove` safe?** Linear has no per-label add/remove — read-then-`issueUpdate`
  is the only way. It is **NOT** "naturally idempotent": it is a TOCTOU read-modify-write.
  Acceptable at WIP=1, but the script comment must warn, and callers must not run concurrent
  label ops on the same issue.
- **Dry-run safe with mock fixture + `--dry-run`?** ONLY if `linear-query.mjs` mechanically
  respects `<SQUAD>_DRY_RUN=1` → returns fixture from `.state/mock/<squad>-task.json` instead
  of hitting the API. Relying on the agent to obey a prompt gate is NOT safe (C1, critical).
  `linear-ops.mjs --dry-run` stays a no-write preview.
- **`FEN-12 → UUID` robust?** Try `issue(id: "FEN-12")` FIRST (Linear accepts text identifiers
  in the id field — exact match). `searchIssues` is fuzzy (matches FEN-120) → only a last
  resort fallback (C3).
- **`comment` idempotent?** YES via optional `--dedup-tag <tag>`: injects `<!-- run:<tag> -->`,
  checks last N comments before posting, exits 0 if tag exists (C4).

## Sonnet review — adopted changes (critical first)

- **C1 (critical):** `linear-query.mjs` honors `<SQUAD>_DRY_RUN=1` env → loads
  `.state/mock/<squad>-task.json` fixture, never touches the API. Mechanical safety.
- **C2 (critical):** every `agents/<squad>/CLAUDE.md` gets an explicit section:
  "Linear tools: ONLY `node scripts/linear-query.mjs` and `node scripts/linear-ops.mjs`.
  NEVER `mcp__linear__*` (does not work headless)." Added in F1/F2/F3.
- **C3:** `resolveIssue` → `issue(id: identifier)` first, search fallback.
- **C4:** `linear-ops.mjs comment --dedup-tag <tag>`.
- **C5:** F1-scripting ∥ F2-scripting OK after F0; **F2-live-pilot requires F1-live-pilot done.**
- **C6:** `.bat` kickoff written to a temp file, passed via `--prompt-file` (avoids Windows
  CMD metachar quoting bugs). Required pattern for all dry-run launchers.
- **C7:** DEV `needs:answer` → write state to `STATE.md` and exit cleanly (no busy-wait);
  next `dev.bat` run reads `STATE.md` and resumes the in-progress task instead of re-picking.
- **C8:** label ops documented as TOCTOU (see above).
- **C9:** `agents/cadence/CLAUDE.md` — on manual launch (`cadence.bat`/`cadence-dry.bat`),
  start immediately from the collector; do not wait for Hermes/cron.
- **C10:** `linear-query.mjs issues --first <N>` (default 50); CADENCE passes larger limit.