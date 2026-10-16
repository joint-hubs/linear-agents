# FOC-901 — Scoped-only autonomy: an unscoped session never adopts a managed run, cap in the overlay, doctor line

Parent FOC-898 (P2-C). PRD `docs/prd/multi-supervisor-isolation-prd.md` §6.2 (collision 2), decisions Q1 + Q2.
Cut from `main` 833f93b.

## Facts (recon 2026-10-16)

- The adoption decision lives in ONE place: `scripts/supervisor-current-run.mjs` `resolveCurrentRun()` (:143-188).
  Unscoped (no `FENIX_SUPERVISOR_SESSION_ID`): reads the GLOBAL pointer (:164, `supervisorCurrentRunPath()` →
  `<dataHome>/supervisor/current-run.json`) and otherwise ADOPTS the newest recent run (:166-169, `source: "adopted"`).
  Scoped: `scopedContext` (:94-105) requires the session id + `LA_TASK_KEY`/`LA_TASK_ID`; the pointer path becomes
  `<dataHome>/supervisor/sessions/<id>/current-run.json` (`fenix-paths.mjs:69-87`). Everything downstream (`status
  --briefing`, `guard`, `wake`, `spawn`) takes the run id from `LA_SUPERVISOR_RUN`, exported by the launcher after
  resolve; `cockpit-routes.mjs` reads the global pointer at :158, :541, :1376 and the scoped one at :292, :722, :735.
- Launchers: `docker/entrypoint.sh` `supervisor-run` selects managed vs legacy at :170-176 on
  `FENIX_SUPERVISOR_SESSION_ID`; the managed branch fails closed on a resolve error (:212-215, exit 2); the legacy
  branch (:217-219) only warns and continues. `bin/supervisor.bat` never sets the session id (always unscoped) and
  records the run through `supervisor-current-run.mjs record` (:64 → `recordLauncherRun` :181-188).
- Managed sessions: SQLite `dataHome()/supervisor/task-sessions.sqlite` (`task-sessions.mjs:65-67`); active =
  status ∈ `CAP_STATUSES = ["starting","running","waiting"]` (:46); rows carry `pid` + `process_started_at` (:131,
  :151) but no liveness column; `store.list()` (:281) and the `activeCapCount` statement (:184) exist.
- Cap: `createTaskSessionStore({ maxActive = 2 })` (:164-169), enforced in `claimNext` (:304-309); the host reads
  `deps.maxActive ?? Number(baseEnv.FENIX_MAX_ACTIVE_SUPERVISORS || 2)` (`task-session-host.mjs:146`, echoed :591,
  :782). Not in the overlay.
- Overlay: `fenix-settings.mjs` `validateSettings()` (:98-142) allows only `provider` | `routing` at the top level
  (:101-103) and refuses secret-shaped values; `get <dotted.path>` walks segments (`getValue` ~:205). The same
  validate loop is edited by the open branches `foc-780-retention`, `foc-772-integrations`, `fenix-task-ownership`
  (trivial merge conflicts expected — keep each key's check in its own function).
- Doctor: checks are plain functions returning `{ name, status: "ok"|"warn"|"fail", detail, fix? }`
  (`fenix-doctor.mjs:172-176`), aggregated in `runChecks` (:241-252); nothing about sessions/tmux/7332 yet.
- Tests to reuse: `task-sessions.test.mjs` (`tempDir` :29, `dbFile` :33, `ensureArgs` :39),
  `task-session-host.test.mjs` (`build(opts)` :130 with store/tmux/pty seams, `SESSION_A/B` :48-49),
  `supervisor-current-run.test.mjs` (`scopedEnv` :42-44, `tempHome` :56, `scopedPointerPath` :349-351),
  `fenix-doctor.test.mjs` (`runChecks({ env, fsImpl, spawn, fetchImpl, … })` :215-218).
- Docs: no session doc exists; `docs/plans/task-workspace-delivery.md:49` carries the scoped-mode note; the PRD
  `docs/prd/task-workspace-supervisors-prd.md` §5/§6.

## Design

### 1. Refusal in the one choke point

`resolveCurrentRun()` unscoped branch, before reading the global pointer: `managedSessionsBlocking({ stateHome, env,
now })` opens the task-sessions store READ-ONLY when the file exists (missing file → `[]`), lists active sessions
(`CAP_STATUSES`), and drops the ones whose `pid` is provably dead on this host (`pidAlive(pid)` = `process.kill(pid,
0)` → ESRCH means dead; EPERM or no pid means alive — conservative). When the remaining list is non-empty and
`env.FENIX_SUPERVISOR_LEGACY !== "1"`, it throws `CurrentRunError("MANAGED_SESSIONS_ACTIVE", …)` whose message lists
`<sessionId> (<taskKey>, <status>)` per session and the scoped command:
`FENIX_SUPERVISOR_SESSION_ID=<id> LA_TASK_KEY=<key> fenix supervisor-run` — plus the override:
`FENIX_SUPERVISOR_LEGACY=1 to adopt anyway (logged)`. Nothing is written (no pointer, no run dir). With the override
the legacy path runs as today and the resolved record carries `legacyOverride: true`; `recordLauncherRun` (native
`record`) runs the same check so `bin/supervisor.bat` refuses too (on Windows the Docker volume is not visible, so
natively this only triggers when a native session host exists). Stale sessions (all pids dead) do not block; the
record carries `staleManagedSessions: [ids]` so the briefing can mention them.

`docker/entrypoint.sh` legacy branch (:217-219): a resolve failure with the `MANAGED_SESSIONS_ACTIVE` code (detected
by the CLI's exit code 3, new, distinct from the generic 1/2) prints the message and exits 2 — fail closed like the
managed branch; any other legacy failure keeps today's warn-and-continue.

### 2. Overlay key `taskSessions.maxActive`

`fenix-settings.mjs`: top-level key `taskSessions` allowed; `checkTaskSessions(value, errors)` — plain object, only
`maxActive`, integer 1..8 (`taskSessions.maxActive must be an integer between 1 and 8`). Read side: export
`readTaskSessionsSettings(env)` → `{ maxActive: number | null }` from the overlay file (never throws; invalid → null +
one stderr line). `task-session-host.mjs:146`: `deps.maxActive ?? envNumber(FENIX_MAX_ACTIVE_SUPERVISORS) ??
overlay.taskSessions.maxActive ?? 2` (env stays the operational override; documented). `fenix settings get/set
taskSessions.maxActive` works through the existing CLI.

### 3. Doctor line

`checkTaskSessions({ env, fsImpl })` in `fenix-doctor.mjs`: `task sessions` — `ok` "N active / cap M (ids: …)" (store
missing → `ok` "no managed sessions yet"); `warn` when N ≥ M ("cap reached — the next ticket waits; raise
taskSessions.maxActive") and `warn` when an unscoped Supervisor is live next to managed ones (global
`<dataHome>/supervisor/session.json` exists, its pid is alive, and N > 0: "an unscoped Supervisor runs next to
managed sessions — stop it or start it scoped"). Added to `runChecks` (:252). A `fix` string names the key/command.

### 4. Docs

New `docs/task-sessions.md` ("One container, N sessions"): scoped vs legacy, what adoption was and why it is off,
the refusal message and the `FENIX_SUPERVISOR_LEGACY=1` override, `taskSessions.maxActive` (default 2; 4 after the
resource spike — measurement note), env override, the doctor line, and the explicit out-of-scope: N containers over
one `/data`. Link it from `docs/plans/task-workspace-delivery.md:49` (one line) and from the PRD §6.2 (one line).
This plan.

## Tests

- `scripts/supervisor-current-run.test.mjs`: (1) unscoped resolve with one active managed session (temp store,
  pid = `process.pid` so it is alive) → throws `MANAGED_SESSIONS_ACTIVE`, message names the session id and the scoped
  command, no pointer written, the managed session's dir untouched; (2) same with `FENIX_SUPERVISOR_LEGACY=1` → adopts
  as before, record has `legacyOverride: true`; (3) only sessions with a dead pid (use a pid that cannot exist, e.g.
  `2**22 + 12345` after checking `pidAlive` reports it dead) → adopts, `staleManagedSessions` lists the id; (4) store
  file absent → unchanged behaviour; (5) CLI `resolve` exits 3 on the refusal.
- `scripts/fenix-settings.test.mjs`: `taskSessions.maxActive` 1 and 8 accepted, 0 / 9 / "2" / extra key refused with
  the documented message; `readTaskSessionsSettings` on a missing/invalid overlay → null.
- `scripts/task-session-host.test.mjs`: overlay `maxActive: 4` → the third claim succeeds; overlay 2 → third stays
  queued; `FENIX_MAX_ACTIVE_SUPERVISORS=1` beats overlay 4.
- `scripts/fenix-doctor.test.mjs`: store with 2 active / cap 2 → warn "cap reached"; 1 active + live unscoped
  `session.json` → warn "unscoped"; no store → ok.
- `bash -n docker/entrypoint.sh`; the exit-3 contract is pinned by test (5).

## Out of scope

Ticket lease (FOC-902); the resource spike itself; N containers; changing `bin/supervisor.bat` beyond what the
shared `record` path gives it.
