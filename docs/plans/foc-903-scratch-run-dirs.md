# FOC-903 — Scratch under run dirs, per-run review rounds, migration, fixtures never touch the live corpus (folds FOC-602)

Parent FOC-898 (P4-E). PRD `docs/prd/multi-supervisor-isolation-prd.md` §6.3 (collision 3). Branch
`foc-903-scratch-run-dirs` stacked on `foc-840-flaky-tests` (#84: `test-spawn.mjs` handlers + `test-run.mjs` orphan
sweep — reused, not redone).

## Facts (recon 2026-10-16)

- Supervisor per-run helpers all live under `runDir(runId)` (`supervisor-lib.mjs:101-112`, `supervisorStateHome()` =
  `LA_SUPERVISOR_STATE_HOME || <repo>/.state/supervisor`); no script writes under `<stateHome>/supervisor/` outside a
  run dir. No generic scratch helper exists.
- Scratch outside run dirs: (a) `.state/reviews/<taskId>-round<N>.md` at the TOOLING REPO root — written by REVIEW
  children by contract, read by `delegation-outcomes.mjs:45,260-288` and `verdict-evidence.mjs:57,281-301`
  (keyed by task id); (b) `review-rounds.json` under `ensureStateDir()` — `utils.mjs:111` `REVIEW_ROUNDS_PATH`,
  `reviewRound({ taskId, maxRounds })` :215-235 (read-modify-write of ONE global file, no lock → two sessions lose
  increments), `resetReviewRounds` :237; readers `delegation-outcomes.mjs:46`, `verdict-evidence.mjs:58`,
  `review-round.mjs:42`; (c) `krok0-*` kickoff drafts under `.state/krok0-<date>/`, written by the Supervisor session
  itself (contract/STATE.md convention, no script).
- FOC-602: `supervisor-test-fixtures.mjs` `fixtureRun()` (:149-161) creates `test-<pid>-<ts>-<n>` run dirs through
  `ensureRunDir` in the REAL `.state/supervisor/` because `baseEnv()` (:187-194) never sets
  `LA_SUPERVISOR_STATE_HOME`; `cleanupLater()` (:77-87) drains only on `process.on("exit")`; the run id carries no
  test-file name; 323 `fixtureRun(` calls across 24 test files; 47 stale `test-*` dirs sit in this checkout's
  `.state/supervisor/` right now (the VM volume is unverified).
- #84 adds `installTestSpawnHandlers()` (SIGINT/SIGTERM/SIGHUP tree-kill + re-raise) for spawned servers and
  `sweepOrphans()` in `test-run.mjs` (pid probe + kill) — nothing for fixture run dirs.
- Migration precedent: `supervisor-cleanup.mjs cmdPrune` (:1002-1046) `--dry-run` + JSON report
  `{ ok, dryRun, pruned: [...], retained, note }`.
- API readers: `telemetry-server.mjs:2226` `GET /api/delegation-outcomes`, `:2246` `GET /api/verdict-evidence`
  (recompute per request; no UI consumer today). Tests pinning paths: `delegation-outcomes.test.mjs:353-428`,
  `verdict-evidence.test.mjs:118-139, 508-514, 978`.
- Lanes on this branch: see `scripts/test-lanes.json`; the checklist count lines must stay equal to it.

## Design

### 1. Per-run scratch helper and review rounds (`supervisor-lib.mjs`, `utils.mjs`)

- `scratchDir(runId, kind)` → `<runDir>/scratch/<kind>/` (mkdir on demand); kinds used now: `reviews`, `krok0`.
- `reviewRound({ taskId, maxRounds, runId })`: when `runId` (or `LA_SUPERVISOR_RUN` in the env) is known, the counter
  file is `<runDir>/review-rounds.json` (per run → one writer per task, no cross-session lost update); without a run
  id the legacy global file is used as today (standalone squads). `resetReviewRounds` follows the same rule.
- Readers (`delegation-outcomes.mjs`, `verdict-evidence.mjs`, `review-round.mjs`): rounds = the union of every
  `<runDir>/review-rounds.json` (newest run wins per task) with the legacy global file as fallback; reviews = every
  `<runDir>/scratch/reviews/*.md` plus the legacy `.state/reviews/` dir. Existing `--reviews-dir` / `--rounds-path`
  options keep working (they become the legacy inputs).
- Contract lines (Mateusz-owned, one line each): `agents/review/CLAUDE.md` — write the round file to
  `$LA_SUPERVISOR_STATE_HOME/<run>/scratch/reviews/<taskId>-round<N>.md` when `LA_SUPERVISOR_RUN` is set (else the
  legacy path); `agents/supervisor/CLAUDE.md` — kickoff drafts go to `<run dir>/scratch/krok0/`, never `.state/krok0-*`.
  (Check `config-drift.test.mjs` for mandated-path rules.)

### 2. Migration `scripts/supervisor-migrate-scratch.mjs`

`--dry-run` (default) / `--apply`, `--state-home`, `--json`. Steps: (a) attribute each task in the legacy
`review-rounds.json` to the newest run whose `triage.json.issue` (or registry `taskId`) matches → write that entry into
`<runDir>/review-rounds.json` (merge, never lower a counter) and drop it from the legacy file; unattributable entries
stay and are listed; (b) move `.state/reviews/<taskId>-round<N>.md` the same way into `<runDir>/scratch/reviews/`;
(c) write `<stateHome>/scratch-redirects.json` `{ migratedAt, rounds: [{ taskId, runId }], reviews: [{ file, runId }] }`
(the report, kept one release); (d) `--sweep-fixtures`: list (dry run) or remove (`--apply`) run dirs whose id matches
`^test-\d+-\d+-\d+$` or `^test-triage-` and that contain no `verdicts/` with non-fixture content — the report names
every dir. Report shape mirrors `cmdPrune`.

### 3. FOC-602 — fixtures never touch the live corpus (`supervisor-test-fixtures.mjs`, `test-run.mjs`)

- The fixtures module sets `process.env.LA_SUPERVISOR_STATE_HOME` at load to a per-process temp root
  (`mkdtemp(<tmp>/la-fixtures-<testfile>-)`) unless already pointing at a temp path; `baseEnv()` exports the same
  value, so in-process library calls and spawned children agree; a test that needs the real home is a bug.
- `fixtureRun()` ids become `test-<testfile>-<pid>-<ts>-<n>` (testfile = basename of the calling test, derived from
  `process.argv[1]`); cleanup drains on `exit`, `SIGINT`, `SIGTERM`, `SIGHUP` and `uncaughtException` (then re-raises),
  and the temp root itself is removed at the end.
- Guard test `scripts/state-isolation.test.mjs` (new, parallel lane): (1) the fixtures module never resolves
  `supervisorStateHome()` to `<repo>/.state/supervisor`; (2) a fixture run id carries the test file name; (3) after a
  simulated SIGTERM to a child test process the temp root is gone; (4) the real `<repo>/.state/supervisor` contains no
  `test-*` dir created during this test run (snapshot before/after).
- `test-run.mjs` start: when `LA_SUPERVISOR_STATE_HOME` is unset, print one line counting legacy `test-*` dirs under
  the real home and point at `supervisor-migrate-scratch.mjs --sweep-fixtures` (no automatic deletion).

### 4. Docs

`docs/agent-state.md`? No — `docs/supervisor-e2e-checklist.md`: where reviews/rounds/kickoff drafts live now (one
block) + the lane count; new `docs/scratch-and-fixtures.md` (≤60 lines): per-run scratch layout, legacy fallbacks,
the migration (dry run → apply → sweep), the fixture isolation rule and the guard test; this plan.

## Tests

- `utils.test.mjs` (or the file that covers `reviewRound`): per-run counter when `runId` given, legacy without, two
  runs on two tasks never share a file. `delegation-outcomes.test.mjs` + `verdict-evidence.test.mjs`: per-run inputs
  + legacy fallback, newest run wins. `supervisor-migrate-scratch.test.mjs` (new): dry run reports and writes nothing;
  apply moves attributable entries, keeps the rest, writes the redirect map; sweep lists only fixture ids and
  refuses a dir with a non-fixture verdict. `state-isolation.test.mjs` (new). `config-drift` green with the contract lines.

## Out of scope

Restoring the deleted 2026-09-27 verdict corpus; moving `.state/reviews/` for standalone (non-Supervisor) squads;
the VM volume (Mateusz runs the migration there after the merge: `node scripts/supervisor-migrate-scratch.mjs --dry-run`
then `--apply --sweep-fixtures`).

## Revisions

2026-10-16 review fixes:

- `verdict-evidence.mjs`: the unoptioned defaults (supervisor root plus the legacy reviews/rounds inputs, derived from its parent) resolve via `supervisorStateHome()` at call time, so `LA_SUPERVISOR_STATE_HOME` moves the whole scan; test added (`verdict-evidence.test.mjs` seam section, in-process + CLI).
- `delegation-outcomes.mjs`: the legacy `REVIEWS`/`ROUNDS` defaults derive from `stateRoot()` (`LA_STATE_ROOT`) at call time, so the reader agrees with the `utils.mjs` writer in the container.
- `delegation-outcomes.mjs`: all load-time `process.argv` parsing (`--json`, `--by-task`, `--csv`, `--reviews-dir`, `--rounds-path`, `--state-home`) moved into `main()` (`parseCliArgs`) — importing the module (telemetry-server) never reads argv; `--csv` was the same pattern and moved with the rest.
- `supervisor-migrate-scratch.mjs`: `--apply` rewrites the legacy counter file only when something was moved or the file already exists; test added (sweep-only apply over a state home with no legacy file creates no `review-rounds.json`).
- `supervisor-migrate-scratch.mjs`: the fixture-id stem class widened to `[A-Za-z0-9_-]+` (uppercase/underscore test-file stems), `^test-` anchor and the `-<pid>-<ts>-<n>` tail kept; sweep test extended with an underscored id.
- `docs/scratch-and-fixtures.md`: dedupe rules clarified (counters per task, review files per (taskId, round)); the per-reader state overrides listed in one line; the fixtures draft merged as "Fixture state isolation (FOC-602)".
- `scripts/test-lanes.json`: the state-isolation lane reason reworded — the mkdtemp root is removed at drain, not "never deleted".
