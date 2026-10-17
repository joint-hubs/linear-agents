# Scratch, run dirs and fixtures

Where the supervisor's throwaway state lives, and how old layouts migrate (FOC-903, FOC-602).

## Per-run scratch layout (FOC-903)

A supervised run owns everything it produces under its own run dir
(`$LA_SUPERVISOR_STATE_HOME/<runId>/`, default `.state/supervisor/<runId>/`):

```
<runId>/
  review-rounds.json          # the run's REVIEW round counter (one writer per task)
  scratch/
    reviews/<taskId>-round<N>.md   # REVIEW round files
    krok0/                         # kickoff drafts (never .state/krok0-*)
  triage.json / children.json / ...  # the rest of the run dir (unchanged)
```

Helpers: `scratchDir(runId, kind)` creates `<runDir>/scratch/<kind>/` on demand;
`reviewRound({ taskId, runId })` keeps the counter per run (`LA_SUPERVISOR_RUN` is the fallback
source; an invalid run id throws — never a silent fallback to the shared file).

**Legacy locations still work** and are the default when no run id is known (standalone squads):
`.state/reviews/<taskId>-round<N>.md`, `.state/review-rounds.json`, `.state/krok0-<date>/`.

**Readers take the union** (`delegation-outcomes.mjs`, `verdict-evidence.mjs`,
`review-round.mjs`): every run dir's inputs with the legacy locations merged in at lower
precedence (run ids are zero-padded timestamps, so name order is chronological). The
COUNTERS dedupe per task — the newest run's `review-rounds.json` value wins whole — while
the review FILES dedupe per (taskId, round), so one run may contribute a task's round 1
and a newer run its round 2. Per-reader state override: `--state-home`
(delegation-outcomes), `--supervisor-root` (verdict-evidence), env-only
`LA_SUPERVISOR_STATE_HOME` (review-round).

## Migration

Legacy leftovers move into their per-run homes with:

```bash
node scripts/supervisor-migrate-scratch.mjs              # dry run — the plan, nothing written
node scripts/supervisor-migrate-scratch.mjs --apply      # move attributable entries
node scripts/supervisor-migrate-scratch.mjs --apply --sweep-fixtures  # also remove stale fixture dirs
```

- **Attribution**: each legacy counter entry and round file goes to the NEWEST run whose
  `triage.json.issue` (or any `children.json` child taskId) names the task. Unattributable entries
  stay in the legacy locations and are listed — nothing is dropped.
- **Never lowers a counter**: merging into `<runDir>/review-rounds.json` keeps the max.
- **Redirect map**: `--apply` writes `<stateHome>/scratch-redirects.json` (`{ migratedAt, rounds,
  reviews }`) — the record of what went where, kept one release.
- **`--sweep-fixtures`** removes state-home dirs whose name matches the fixture-run-id shapes
  (`test-<pid>-<ts>-<n>`, `test-<testfile>-<pid>-<ts>-<n>`, `test-triage-*`) only when they contain
  no `verdicts/` dir with files; a dir with verdicts is listed as `kept (verdicts present)`.
- `--json` prints the full report (`{ ok, dryRun, rounds, reviews, fixtures, redirectMap }`).

## Fixture state isolation (FOC-602)

- Every suite importing `scripts/supervisor-test-fixtures.mjs` redirects the supervisor state tree at load:
  `LA_SUPERVISOR_STATE_HOME` is set to a per-process temp root (`<tmp>/la-fixtures-<testfile>-`) whenever it is unset
  or points inside the repo's `.state/`. A test that needs the real corpus is a bug.
- `fixtureRun()` ids are `test-<testfile>-<pid>-<timestamp>-<n>` — a dir that ever escapes cleanup names its origin.
  Cleanup drains on `exit`, `SIGINT`/`SIGTERM`/`SIGHUP` (then re-raises) and `uncaughtException`; the temp root is
  removed last.
- Spawned children agree because `baseEnv()` carries the same value. `supervisorStateHome()` reads the env at call
  time, so there is no import-order trap.
- Guard test: `scripts/state-isolation.test.mjs` (all four properties, including the child SIGTERM/exit cases — the
  signal case skips on win32, where `child.kill()` is TerminateProcess).
- `test-run.mjs` prints one startup line counting legacy `test-*` dirs under the real `.state/supervisor/` and points
  at `supervisor-migrate-scratch.mjs --sweep-fixtures` — it never deletes.

Checklist for the VM volume (run after the merge):

- [ ] `node scripts/supervisor-migrate-scratch.mjs` (dry run) — review the moved/kept lists
- [ ] `node scripts/supervisor-migrate-scratch.mjs --apply` — counters + round files moved
- [ ] `node scripts/supervisor-migrate-scratch.mjs --apply --sweep-fixtures` — stale `test-*` dirs gone
- [ ] `scratch-redirects.json` exists and names the expected entries

