# Task sessions — one container, N sessions (FOC-901)

Managed task sessions let one Fenix container run several Supervisors side by
side, each isolated under its own session home (`<dataHome>/supervisor/sessions/<id>/`),
its own tmux identity and its own Claude config dir. The coordinator is
`scripts/task-sessions.mjs` (SQLite, `dataHome()/supervisor/task-sessions.sqlite`):
one active owner per task, a queue, and a global cap on active sessions.

## Scoped vs legacy

- **Scoped** (managed): the pane runs with `FENIX_SUPERVISOR_SESSION_ID=<id>`
  plus `LA_TASK_KEY`/`LA_TASK_ID`. Its pointer lives in the session home;
  adoption is OFF — a missing scoped pointer is a NEW run, never another
  task's run, and a pointer owned by a different task/session is refused.
- **Legacy** (unscoped): no session id. The pointer is the global
  `<dataHome>/supervisor/current-run.json` and — before FOC-901 — a missing
  pointer ADOPTED the newest recent run, silently landing an unscoped session
  on a managed run's telemetry.

## Why adoption is off now (the refusal)

An unscoped `resolve` (and `record`) now refuses while live managed task
sessions exist in the same data home — an unscoped session never adopts a
managed run. The refusal is exit code 3 and prints, for each session, its
id, task key, status and its own scoped start command, e.g.:

```
current-run: unscoped Supervisor run resolution refused: 1 active managed session(s) own this container:
  sup-<32hex> (workspace:ISSUE-123, running) — scoped start: FENIX_SUPERVISOR_SESSION_ID=sup-<32hex> LA_TASK_KEY=workspace:ISSUE-123 fenix supervisor-run
Start the Supervisor scoped with the command above, or set FENIX_SUPERVISOR_LEGACY=1 to adopt anyway (logged).
```

- **Scoped start** is the normal answer; the entrypoint fails closed with
  exit 2 on the refusal. `bin/supervisor.bat` does the same: it runs
  `record` with stderr visible and, on the refusal (exit 3), prints its own
  hint and exits 2 without starting `claude` — any other record failure only
  warns and the launch proceeds.
- **`FENIX_SUPERVISOR_LEGACY=1`** is the explicit override: the pre-901
  behaviour runs and the record carries `legacyOverride: true`.
- Sessions whose `pid` is provably dead on this host are stale: they never
  block, and the resolved record carries `staleManagedSessions: [ids]` so the
  briefing can mention them. A store that cannot be verified (locked, corrupt)
  counts as blocking with the reason in the message — never as empty.

## The cap: `taskSessions.maxActive`

The cap on concurrently active (`starting|running|waiting`) sessions defaults
to **2**. Precedence:

1. `deps.maxActive` (embedders/tests),
2. env `FENIX_MAX_ACTIVE_SUPERVISORS` (integer ≥ 1 — the operational override),
3. the Settings overlay `taskSessions.maxActive` (survives `fenix update`):
   `fenix settings set taskSessions.maxActive 4`,
4. 2.

Raise it only after a measured resource spike — the cap=2 benchmark
(2026-10-14, `docs/plans/task-workspace-delivery.md`) is the baseline; 4 is the
documented next step once a spike justifies it. The chosen source is logged
once at host start: `maxActive=<n> (<source>)`.

## Doctor line

`fenix doctor` prints a `task sessions` line: `N active / cap M (ids: …)`;
sessions whose `pid` is provably dead are stale and do not count against the
cap — the line then reads `L live / cap M (S stale: ids)`. A missing store
reads `no managed sessions yet`. It warns when the cap is reached (the next
ticket waits) and when an unscoped Supervisor is live next to managed sessions
(global `session.json`, best-effort liveness) — one line when both apply. The
doctor never mutates the store.

## Out of scope

N containers over one `/data` volume, the ticket lease (FOC-902), and the
resource spike itself. Scoped-only autonomy assumes the single-container
multiplexer: sessions coordinate through the shared store, not containers.