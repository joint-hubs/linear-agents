# FOC-905 — Run ownership: the orphan scan marks only what this container owns; foreign and live runs are listed, never touched

Parent FOC-898 (P6-G). PRD `docs/prd/multi-supervisor-isolation-prd.md` §6.5 (collision 5, partial). Branch
`foc-905-orphan-owner` stacked on `foc-901-scoped-only` (uses `readActiveSessions`, `pidAlive`, the doctor pattern).

## Facts (recon 2026-10-16)

- The ONLY whole-home sweep is `scripts/supervisor-orphans.mjs` (FOC-799): `markOrphans({ stateRoot, containerStart })`
  (:89) enumerates every run dir with `children.json`, and marks every live-status child whose last turn
  `startedAt` is older than the container's PID 1 start (`containerStartMs()` :42, `/proc/stat btime` +
  `/proc/1/stat`) as `crashed` with `orphanedBy: "container-restart"` (:134-142). Called once at container start
  from `docker/entrypoint.sh:84-86` (`mark_orphans`, `|| true`). No pid probing (pid namespace), no deletion. Nothing
  else sweeps: `supervisor-cleanup prune` deletes only `test-artifacts/`, `stop`/`watch`/`guard` are per child/run,
  `task-session-host stopSession` is already scoped to its own session.
- Ownership metadata today: none. `children.json` entries carry no creator (`sessionId` is the child's Claude session,
  patched by the watcher); the run record (`supervisor-current-run.mjs`) has `runId, model, startedAt, source`; the
  task-sessions row has `session_id, run_id, pid, process_started_at`; no container identity anywhere (no
  `HOSTNAME`/`os.hostname()`/cgroup use in scripts or docker).
- Liveness: `processAlive(pid)` (`supervisor-lib.mjs:2179`), `pidAlive(pid)` (FOC-901, conservative),
  `matchesProcess` (`task-session-host.mjs:75,364`, pid + start time).
- Doctor pattern: `checkTaskSessions({ env, fsImpl, readSessions })` (FOC-901, `fenix-doctor.mjs`), wired in `runChecks`.
- Tests to reuse: `supervisor-orphans.test.mjs` (containerStartMs fixtures :176-184, mark/untouched/idempotence
  cases), `fenix-doctor.test.mjs` seams, `task-sessions.test.mjs` `ensureArgs`.
- The one-container model means a container restart kills every session's processes, so the start-time rule is right
  for runs this container created; it is wrong for runs another container or host wrote into the same state home
  (N containers over one `/data` is unsupported but must not be destructive) and it ignores the session store.
- Lanes on this base: 139 parallel + 35 serial = 174.

## Design

### 1. Owner identity — `scripts/run-owner.mjs` (new, imports only node builtins)

- `containerStartMs()` moves here (re-exported from `supervisor-orphans.mjs` so its tests and callers keep working).
- `currentOwner(env = process.env)` → `{ sessionId: env.FENIX_SUPERVISOR_SESSION_ID || null, hostname: os.hostname(),
  containerStartMs: containerStartMs() | null, pid: process.pid, recordedAt: iso }`.
- `ownerPath(runDir)` = `<runDir>/owner.json`; `readRunOwner(runDir)` → object | null (corrupt → null);
  `writeRunOwnerIfMissing(runDir, owner)` (atomic, never overwrites).
- `ownerRelation(owner, current, { session })` → `"mine"` (same hostname and same `containerStartMs`, or both null
  and same hostname), `"restarted"` (same hostname, owner `containerStartMs` < current), `"foreign"` (different
  hostname), `"unknown"` (no owner record); `session` = the task-sessions row for `owner.sessionId` when any
  (`terminal: true` when its status is stopped/completed/failed).

### 2. Writing the owner

`ensureRunDir(runId)` in `supervisor-lib.mjs` writes `owner.json` through `writeRunOwnerIfMissing` right after creating
the dir (fixtures get the test process as owner — fine). `supervisor-current-run.mjs` stamps `owner` (the same object)
into a NEW run's record. `supervisor-status --briefing` JSON gains `owner` (from the run's `owner.json`).

### 3. Scan rule — `markOrphans` becomes owner-aware

For every run with live-status children: `relation = ownerRelation(readRunOwner(runDir), current, { session })`:

| relation | action |
|---|---|
| `mine` | today's rule (turn started before this container → mark); with the owner's session row terminal in the store → mark regardless of time |
| `restarted` | mark (that container instance is gone) |
| `unknown` (no owner.json, legacy runs) | today's rule |
| `foreign` | list only (`skipped: foreign`), unless `--all --yes` → today's rule applies |

`--json` report `{ containerStart, marked: [{ runId, childId, relation }], skipped: [{ runId, relation, reason }],
unknown: n }`; text output one line per decision; exit 0 always (never blocks the start). `--all` without `--yes`
prints the foreign list and exits 2.

### 4. Doctor line

`checkRunOwners({ env, fsImpl, readOwners })` → `run owners` — `ok` "N runs: mine M, restarted R, legacy L" ;
`warn` when `foreign > 0`: "F run(s) owned by another host/container (<hostnames>) share this state home — N
containers over one /data is unsupported; they are never swept automatically (`supervisor-orphans --all --yes`)".

### 5. Docs

`docs/task-sessions.md` section "Run ownership and the orphan scan" (table above, `owner.json` shape, the operator
override); `docs/supervisor-e2e-checklist.md` one bullet + counts (175 = 140 + 35); this plan.

## Tests

- `scripts/run-owner.test.mjs` (new, parallel): `currentOwner` shape; read/write-if-missing (never overwrites,
  corrupt → null); `ownerRelation` matrix (mine / restarted / foreign / unknown / terminal session).
- `scripts/supervisor-orphans.test.mjs`: owner mine + live child started before container start → marked (as today);
  owner mine + turn after start → untouched; owner restarted → marked even with a recent turn; owner foreign →
  skipped and reported, marked only with `--all --yes` (CLI case); no owner.json → today's rule; owner session terminal
  in a temp task-sessions store → marked; `--json` shape.
- `scripts/supervisor-lib` / `supervisor-spawn.test.mjs`: `ensureRunDir` writes `owner.json` once (second call keeps it).
- `scripts/fenix-doctor.test.mjs`: ok and warn lines through the `readOwners` seam.
- `config-drift`, `docs-count-guard` green.

## Out of scope

Per-session overlay/token (stack-global by design, documented); deleting run dirs (prune keeps its narrow class);
cross-container liveness (unsupported; foreign runs are only listed).

## Revisions

- 2026-10-16 review: CLK_TCK probe memoized
