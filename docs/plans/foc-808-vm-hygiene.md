# Delivery Plan — FOC-808 Fenix on a VM: resource hygiene and telemetry noise

Linear: **FOC-808** (M8 Fenix 1.0.0, parent FOC-768, Medium, due 11-06). Found on `fenix-vm` 2026-10-12 after one
test-squad run. Written 2026-10-19 by the delivery owner under the 2026-10-15 autonomy rule; VM work authorised by
Mateusz the same day (cost-aware: `fenix-vm` resized to e2-standard-2, started only for work).

## 0. The four findings and what they are in the code (`main` 4675b82)

1. **Helpers outlive their child.** `scripts/supervisor-spawn.mjs` spawns the child `detached: true` (own process
   group); `killTree` in `scripts/supervisor-lib.mjs` signals the group (`process.kill(-pid)`). A helper that calls
   `setsid` (pgserver's Postgres, any daemonizing tool) leaves the group, so neither the turn end
   (`scripts/supervisor-watch.mjs` `finalizeTurn`) nor the container-start scan (`scripts/supervisor-orphans.mjs`
   `--container`, which only MARKS registry rows) stops it.
2. **The container layer grows.** `compose.yaml` mounts only `fenix-data:/data`; `/tmp` and `/home/node` (`.npm`,
   `.cache`, `.local`) live in the container layer — lost on every `fenix update`, downloaded again, never pruned.
3. **Idle writes.** `scripts/telemetry-server.mjs` `ingestTelemetry()` every 15 s = `replayPending()` +
   `ingestKnownRuns()` + `reconcileDeadRuns()`; something in that path writes to the store when nothing changed
   (~1.5 MB/min measured on the VM). The writer has to be pinned by measurement, not guessed.
4. **False quality warning.** `supervisor-spawn.mjs` tags every child run with `sup:<runId>` through
   `run-manifest.mjs tag` → `recordTaskLink` → `applyTaskLinked` (`scripts/telemetry-store.mjs` ~1596), whose
   `^[A-Z][A-Z0-9]{0,9}-\d{1,10}$` guard rejects the uppercased `SUP:<runId>` and raises `task_id_malformed`. The
   same store already treats `SUP:` as the Supervisor pseudo-task prefix (`PSEUDO_TASK_PREFIX`, ~3164).

## 1. Contracts

### A — telemetry (store + server)
- `applyTaskLinked`: an id starting with `SUP:` (any case on input) is a **supervisor attribution**, not a ticket:
  normalise to `SUP:<runId>`, insert the `work_items` row with `provider='fenix'` and `workspace='supervisor'`, link
  with `role='supervisor'` (never `primary`), raise NO quality issue; every reader that selects primary links
  (`taskForTimestamp`, the task attribution in `delegation-outcomes.mjs` / `team-model.mjs`, the cost views) keeps
  ignoring it (`role='primary'` filters already exist — prove it in tests). Existing `task_id_malformed` issues
  for `SUP:` ids are closed by a one-shot migration on store open (`resolved_at`, reason `foc-808`).
- Idle tick: a test spawns the real server against a fixture store with no pending spool, no new transcript bytes
  and no dead runs, waits 3 ticks (interval overridable: `LA_TELEMETRY_INGEST_MS`), and asserts the store file
  (`telemetry.sqlite` + `-wal`) grew by 0 bytes and `PRAGMA data_version` is unchanged. Then fix whatever wrote
  (candidates: a cursor/updated_at touch in `ingestKnownRuns`, a reconcile that rewrites unchanged rows, a WAL
  checkpoint — the report must name it with file:line).

### B — child teardown (Supervisor side)
- Every spawned child gets `LA_CHILD_MARK=<runId>/<childId>/<attemptId>` in its env (inherited by everything it
  starts) and `TMPDIR=/tmp/fenix-child/<childId>` (created 0700 for the child uid before spawn).
- `sweepChildProcesses({ mark, signal })` in `scripts/supervisor-lib.mjs` (Linux only: scans `/proc/*/environ` for
  `LA_CHILD_MARK=<mark>`, excluding the watcher itself; SIGTERM, 2 s, SIGKILL; returns the pids killed; on
  non-Linux returns `[]` with `skipped: "no /proc"`). Called from `finalizeTurn` after the group kill, logged as
  `child sweep: killed N stray process(es) [pid comm…]` in the registry turn record (`sweptPids`), and the child's
  `TMPDIR` is removed after the sweep unless `LA_KEEP_CHILD_TMP=1`.
- Container start (`supervisor-orphans.mjs --container`): after marking, sweep every process whose
  `LA_CHILD_MARK` names a child that is not live in its registry (dead pid / terminal status) — `orphans: killed N
  stray helper(s)`; `--json` carries `sweptPids`.

### C — caches, prune, doctor
- `compose.yaml`: named volume `fenix-cache` mounted at `/home/node/.cache` in BOTH services; `Dockerfile`/entrypoint
  env `XDG_CACHE_HOME=/home/node/.cache`, `npm_config_cache=/home/node/.cache/npm`, `PIP_CACHE_DIR=…/pip`,
  `UV_CACHE_DIR=…/uv`, `PLAYWRIGHT_BROWSERS_PATH=…/ms-playwright`; the volume is group-writable for `fenix-child`
  (FOC-802's setgid pattern from `docker/entrypoint.sh`).
- `fenix prune [--max-gb N] [--dry-run]` (root `fenix` → `in_container_node scripts/fenix-prune.mjs`): reports
  `/home/node/.cache`, `/tmp/fenix-child`, docker build cache sizes; `--max-gb` deletes the oldest cache entries
  (by atime) until under the cap, always removes `/tmp/fenix-child/<id>` dirs of children not live; never touches
  `/data`. `fenix doctor` gains a `caches` line (sizes + the cap from the overlay key `retention.cacheMaxGb`,
  default 5).
- QUICKSTART "Where things live": the cache volume, `fenix prune`, what survives `fenix update`.

### What review changed (2026-10-19, integrator)

- **B needs a root path in the container.** The watcher runs as `node`, the child tree as `fenix-child` (FOC-802), so
  `/proc/<pid>/environ` of a stray is EACCES to the in-process scan. Added `docker/fenix-child-sweep.sh` (root, via
  the second `sudoers-fenix-child` rule; validates mark + signal, prints `pid comm` before signalling, signals only
  what it listed) — `sweepChildProcesses` takes it when `FENIX_IN_CONTAINER=1` and the helper is installed
  (`via: "helper"`), the `/proc` scan otherwise (`via: "proc"`). A pid that is already gone at the first signal is
  not reported as killed.
- **The TMPDIR removal is path-guarded.** `finalizeTurn` removes the registry's `tmpDir` (or the env `TMPDIR`) only
  when it sits under `<os tmpdir>/fenix-child/` — a watcher run by hand with an ambient `TMPDIR` must never have it
  removed (`child_tmpdir_skipped` note instead).
- **Group ownership.** The spawn helper honours the per-child `TMPDIR` from the env file (prefix `/tmp/fenix-child/`,
  no `..`) and makes it `2770 fenix-child:fenix`; `node` is in group `fenix` and the child's umask is 0002, so the
  watcher can remove the tree at turn end. The default scratch (`/tmp/fenix-child-<uid>`) stays 0700.
- **Second review round (sudo path).** The container-start sweep honours the same ownership gate as the marking
  (foreign runs are never swept without `--all --yes`); a live-status child without a recorded pid is unknown, not
  dead; a marked process the in-process path cannot signal (EPERM) is reported as `unsignalled`, never as killed;
  `finalizeTurn` notes a skipped sweep (`child_sweep_skipped`); the sweep helper re-checks the mark right before each
  signal (pid reuse); the spawn helper refuses symlinked tmp/cache dirs and normalises `/tmp/fenix-child` (group
  `fenix`, 2775) in case the watcher had to create it.
- **Child caches.** The image-wide cache env (`XDG_CACHE_HOME`, npm/pip/uv/playwright) would point `fenix-child` at
  node-owned directories; the spawn helper gives the child its own subtree `/home/node/.cache/fenix-child` (owned
  `fenix-child:fenix`, 2770) — on the volume, shared with nothing.
- **A: idempotent attribution.** A second `sup:` tag for the same run (every launch attempt tags) returns the
  existing open supervisor link instead of inserting a duplicate.
- **Store idle-open fast path** named by measurement: `openTelemetryDb` dropped and recreated the two canonical
  views on every open (two write transactions per 15 s tick); `canonicalViewsCurrent()` skips that when the stored
  SQL already matches.
- **Found on the VM after the merge (PR follow-up).** Even root cannot read another uid's `/proc/<pid>/environ`
  inside a container without `CAP_SYS_PTRACE` — the helper got EACCES on every `fenix-child` process; the Supervisor
  service now has `cap_add: [SYS_PTRACE]` (verified: the same helper then lists and kills the stray). The
  `fenix-cache` volume was created `root:root` because the image had no `/home/node/.cache`; the image now ships
  it as `node:fenix 2775`, and `fenix up` / `fenix update` repair an older root-owned volume once.
- **Second spawn path (FOC-917).** Follow-up turns (`supervisor-followup.mjs`) had no mark and no per-child
  TMPDIR — the resumed `dev-2` on the VM left its Postgres behind. Both paths now use
  `childTeardownIdentity` / `ensureChildTmpDir` from supervisor-lib, and the follow-up writes the current turn's
  `mark` / `tmpDir` into the registry.

## 2. Slices (own files only, no git, ≤ 20 min, Flash)

| Slice | Files |
|---|---|
| A telemetry | `scripts/telemetry-store.mjs` (applyTaskLinked + migration), `scripts/telemetry-server.mjs` (the idle writer), `scripts/telemetry-store.test.mjs` (+cases), new `scripts/telemetry-idle-tick.test.mjs` (serial: spawns the server), lanes/checklist |
| B teardown | `scripts/supervisor-spawn.mjs` (env mark + TMPDIR), `scripts/supervisor-lib.mjs` (`sweepChildProcesses`), `scripts/supervisor-watch.mjs` (finalizeTurn hook), `scripts/supervisor-orphans.mjs` (container sweep), `scripts/supervisor-watch.test.mjs` / `scripts/supervisor-orphans.test.mjs` (+cases, POSIX-only parts print `SKIP … — win32`), `docs/supervisor-e2e-checklist.md` only if a lane changes |
| C caches | `compose.yaml`, `Dockerfile`, `docker/entrypoint.sh`, `fenix`, new `scripts/fenix-prune.mjs` + `scripts/fenix-prune.test.mjs`, `scripts/fenix-doctor.mjs` (+line, +test case in `fenix-doctor.test.mjs`), `scripts/fenix-settings.mjs` (`retention.cacheMaxGb`), `docs/QUICKSTART.md`, lanes/checklist (coordinate: A registers first; C re-reads the file before editing) |

Lane bookkeeping conflicts between A and C are resolved by the integrator (union + recount).

## 3. Verification

- Unit/lane tests per slice; Flash reviews of A and B (production paths); the integrator runs the full Windows
  suite and the Linux lane in the image.
- On `fenix-vm` (e2-standard-2, main after this PR): `./fenix update`; `./fenix doctor` shows `caches`; a synthetic
  escaped helper — `docker compose exec fenix-supervisor sh -c 'LA_CHILD_MARK=test/dev-x/1 setsid sleep 600 &'` —
  is killed by `supervisor-orphans.mjs --container` (and by a finalizeTurn in a fixture turn); the idle-write
  measurement (`-wal` size over 10 idle minutes) before/after; `fenix prune --dry-run` output. Numbers go into the
  PR and the Linear comment.

## 4. Out of scope

Windows process sweeps (the container is Linux); stopping helpers that ignore SIGKILL; cgroup-based accounting
(FOC-809 measures with a sampler).
