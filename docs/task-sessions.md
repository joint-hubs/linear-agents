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
  exit 2 on the refusal. `bin/supervisor.bat` delegates to the node launcher
  (`scripts/squad-start.mjs`), which stops on the `record` step's exit 3: it
  prints the refusal and exits 2 without starting `claude` — any other record
  failure only warns and the launch proceeds.
- **`FENIX_SUPERVISOR_LEGACY=1`** is the explicit override: the pre-901
  behaviour runs and the record carries `legacyOverride: true`.
- Sessions whose `pid` is provably dead on this host are stale: they never
  block, and the resolved record carries `staleManagedSessions: [ids]` so the
  briefing can mention them. A store that cannot be verified (locked, corrupt)
  counts as blocking with the reason in the message — never as empty.

## The cap: `taskSessions.maxActive`

The cap on concurrently active (`starting|running|waiting`) sessions defaults
to **1** (`DEFAULT_MAX_ACTIVE` in `scripts/task-sessions.mjs`). Precedence:

1. `deps.maxActive` (embedders/tests),
2. env `FENIX_MAX_ACTIVE_SUPERVISORS` (integer ≥ 1 — the operational override),
3. the Settings overlay `taskSessions.maxActive` (survives `fenix update`):
   `fenix settings set taskSessions.maxActive 2`,
4. 1.

After FOC-1088 the operator MAY raise the cap to 2 with
`fenix settings set taskSessions.maxActive 2` + `fenix restart supervisor`
(both exist on main since #170) — the two concurrent sessions must then either
run on different repositories per session, or the per-task worktree lane below
must have been live-verified first. Beyond 2 only after a measured resource spike — the cap=2 benchmark
(2026-10-14, `docs/plans/task-workspace-delivery.md`) is the baseline; 4 is the
documented next step once a spike justifies it. The chosen source is logged
once at host start: `maxActive=<n> (<source>)`.

## Per-task worktrees (FOC-1088, default ON)

Every managed session works in its OWN git worktree of the task's repository
instead of a shared checkout — two concurrent sessions on one repo no longer
collide on `git checkout -b` or commits (seen live on the FOC-789 acceptance
run). The switch is the Settings overlay key `taskSessions.worktrees`,
**default true** — the shared checkout is the data-integrity bug (two managed
sessions editing one tree), the cap is 1 anyway, so isolation is the safe
default. Ladder (the same shape the cap uses):

1. `deps.worktrees` (embedders/tests),
2. env `FENIX_TASK_WORKTREES` = `0` or `1` — the test / emergency override,
   winning over the overlay BOTH ways (an operator who set `=0` before the
   lane went default-on keeps the opt-out; any other value is ignored),
3. the overlay's `taskSessions.worktrees` (survives `fenix update`):
   `fenix settings set taskSessions.worktrees false`,
4. true.

A change takes effect at host start — run `fenix restart supervisor` after
`fenix settings set`.

- **Branch** — derived deterministically from the task only:
  `buildBranchName(issueId, "task")` → `foc-<n>-task`. The session id never
  appears in the name, so a resumed generation (stopped → resume) reuses the
  SAME branch and worktree, its predecessor's commits included. A new branch
  starts at the origin default branch (`git remote set-head origin -a` must
  resolve there; the start fails closed otherwise).
- **Claim** — the workspace is claimed in the workspace-claims registry under
  the owner `task-session:<taskKey>` (task-scoped, so a resumed generation
  re-claims its own branch as the same owner). The pane inherits the worktree
  through `FENIX_REPO_DIR` — the entrypoint's supervisor-run branch already
  resolves `LA_SUPERVISOR_REPO` from it and cds there, so no entrypoint change.
- **Repository resolution** — PER SESSION, in this order:
  1. a repository carried on the session record (no writer produces one
     today — the forward-compatible hook), then the embedder's explicit pin
     (`deps.repo` — tests, single-repo hosts); an explicit value decides on
     its own and fails loudly when it is not a git repo;
  2. the projects.json entry matching the issue's **Linear project**: the
     issue's facts come from `fetchIssueFacts` (fixture first, then the
     GraphQL API; any failure there is "Linear unavailable", never a crash),
     and the issue's project name is matched exactly against each entry's
     `linearProject` field — exactly one distinct repository required, an
     ambiguous mapping fails closed. The pisi workspace's lookup is routed
     with `LINEAR_WORKSPACE=pisi` (it reads `LINEAR_API_KEY_PISI`). The
     `${GITHUB_ROOT}/<name>` template the `fenix repo add` mapping writes
     expands against env `GITHUB_ROOT` (`/data/workspaces` in the container);
  3. only when Linear gave no project (or none matched): the entry whose
     STRUCTURED `ticketPrefix` field equals the issue id's prefix (`FOC` in
     `FOC-1080`) — the structured field only, never the note-text fallback
     `repoPrefixMap` accepts (a guess from free text must not pick a
     repository); exactly one distinct repository required;
  4. env `FENIX_REPO_DIR`, then `LA_SUPERVISOR_REPO` on the host process —
     only when no project map exists or is unreadable. A READABLE map that
     matches neither rule fails closed, naming what was tried (the Linear
     project found — or that Linear was unreachable — and the ticket prefix);
     it does not fall through to the env.

  The task key's workspace half (`jointhubs`) is the LINEAR WORKSPACE NAME,
  never a repository name — round 2 matched `repoRefName(repo)` against it
  and failed every real session closed (fixed in round 3).
  There is deliberately NO cwd fallback (the host runs from the fenix stack
  checkout, never the task's repository). Resolutions are memoized per
  repository, never one root for the whole host; a FAILED resolution is not
  memoized, so an operator fix takes effect on the next attempt without a
  restart.
- **Fail closed with a remedy** — when no repository resolves, the session
  goes `waiting` and its `lastError` names both operator fixes, copy-pasteable:
  map the repository (`fenix repo add <repository url> --project <the task's
  Linear project>`) or turn the lane off (`fenix settings set
  taskSessions.worktrees false` + `fenix restart supervisor`).
- **Release** — stop (including its queued and terminal early returns) and
  failed starts release the claim, against the SAME repository the session's
  ensure used (the memoized resolution, never a re-resolution); a `waiting`
  session from a failed ensure holds no claim and re-ensures after recovery.
  The worktree itself is NEVER removed automatically — cleanup is the
  operator's (`git worktree remove`).
- **Crash recovery** — a session that crashes mid-flight may leave a claimed
  worktree behind. The registry names the owner; release is explicit:
  `node scripts/workspace-claims.mjs release --git-root <dir> --branch <b>
  --owner task-session:<taskKey>`.

## Doctor line

`fenix doctor` prints a `task sessions` line: `N active / cap M (ids: …)`;
sessions whose `pid` is provably dead are stale and do not count against the
cap — the line then reads `L live / cap M (S stale: ids)`. A missing store
reads `no managed sessions yet`. It warns when the cap is reached (the next
ticket waits) and when an unscoped Supervisor is live next to managed sessions
(global `session.json`, best-effort liveness) — one line when both apply. The
doctor never mutates the store.

## Ticket lease (triage)

Before `triage record`/`triage intake` write anything, the CLI checks the store:
a scoped session may only triage the ticket its lease names (`LA_TASK_ID`,
refusal `LEASE_MISMATCH`); an unscoped triage refuses a ticket whose task key
(`workspaceNameFor(env):issue`) is held by a live session (`TICKET_LEASED`) —
dead-pid rows do not hold, and `FENIX_SUPERVISOR_LEGACY=1` overrides with
`lease.override: true` on the record. The check is recorded in
`triage.json.lease` (`sessionId`, `taskKey`, `workspace`, `store`, `checkedAt`).
After the verdict is on disk, `record` posts a `claimed by …` comment via
`linear-ops.mjs comment --dedup-tag claim:<sessionId|runId>` (failure never
fails the record; `--no-claim-comment` skips).

## What the briefing shows

`supervisor-status.mjs --briefing` carries `leases` (`mine` — the session's own
row, `others` — every other active row with `live` liveness) and a one-line
`leasesLine`, e.g. `Leases: mine jointhubs:FOC-1 (sup-…, running); others:
jointhubs:FOC-2 (sup-…, waiting, stale)`. A missing or unreadable store reads
`Leases: no managed sessions`; an empty one reads `Leases: none`.

## Autonomous pickup (opt-in)

The host can fill its queue by itself. Off by default; turn it on in the settings overlay
(`fenix settings set taskSessions.autoPickup.enabled true`, plus optionally `pollSeconds` 60–3600, default 300;
`states`, default `["Backlog"]`; `label`; `workspace`). When enabled, `task-session-host serve` polls Linear every
`pollSeconds` (first tick 10 s after start): it queries each configured state
(`node linear-query.mjs issues --status <state> [--label <l>] --json`), keeps only the owner scope's project, orders
by priority (urgent first) then age, and enqueues every candidate that has NO row in the task-sessions store —
queued, active and terminal rows alike, so a completed or failed ticket is never re-picked. The owner scope:
when the task-ownership module is present its `checkOwnership` decides (FOC-902 §D); otherwise the scope resolves
through the projects map — the entries whose own `workspace` field names the pickup workspace must agree on exactly
one `linearProject` (FOC-1147; the workspace half of a task key is a Linear workspace name, never a repo dir name,
so it is never matched against a repo ref). Any gap — unreadable map, no entry for the workspace, no
`linearProject`, an ambiguous one — fails the tick closed with the remedy in `GET /pickup`'s `lastError`.
Enqueuing stops at `taskSessions.maxActive`; the ordinary scheduler (`claimNext`) starts sessions from the queue as
usual. The host
never writes to Linear — the claim comment stays with the Supervisor's triage. `GET /pickup` on the host reports
`{ enabled, pollSeconds, states, lastTickAt, lastError, lastEnqueued }`, and the doctor's `task sessions` line ends
with `auto-pickup: off` or `auto-pickup: on (every <n>s, states <a,b>)`.

## What the cockpit shows

Each board ticket carries a muted `claimed · <session id, first 12 chars>` tag next to its stage tag (hover shows
the full session id and status). The claim comes from the task-sessions store's active owner for the ticket — the
board only reads the store, never creates it; a dead owner's tag stays but is not marked live.
## Run ownership and the orphan scan (FOC-905)

Every run dir carries `owner.json`, written once when the run dir is created
(`ensureRunDir` in `supervisor-lib.mjs`) and never overwritten:

```json
{
  "sessionId": "sup-<32hex> or null",
  "hostname": "the container or host that created the run",
  "containerStartMs": 1729068000000,
  "pid": 1234,
  "recordedAt": "2026-10-16T09:00:00.000Z"
}
```

`containerStartMs` is the creating container's PID 1 start in epoch ms, or null
when it cannot be proven (host-run supervisors, macOS). A NEW run's
current-run record (`supervisor-current-run.mjs` `resolve --new`, `record`)
carries the same object under `owner`; `supervisor-status --briefing` reports
the run dir's record under `owner` (null for legacy runs).

The orphan scan (`scripts/supervisor-orphans.mjs`, run at container start)
relates each run's owner to the current container before touching anything:

| relation | action |
|---|---|
| `mine` (same hostname, same container start) | the time rule: a live child whose turn started before this container → `crashed`; when the owner's task-session row is terminal (`stopped`/`completed`/`failed`) the run is finished work → marked regardless of the turn time |
| `restarted` (same hostname, an older container start) | marked — that container instance is gone |
| `unknown` (no `owner.json`, legacy runs; or the starts do not line up) | the time rule, exactly as before FOC-905 |
| `foreign` (a different hostname) | listed only — its children are never swept. `--all --yes` overrides and applies the time rule |

- `node scripts/supervisor-orphans.mjs --container [--json]` always exits 0 —
  the container start is never blocked. `--json` reports
  `{ containerStart, marked: [{ runId, childId, relation }], skipped: [{ runId, relation, reason }], unknown }`.
- `--all` without `--yes` prints the foreign list and exits 2. N containers
  over one `/data` is unsupported but must not be destructive: the override is
  two flags on purpose, and foreign runs are never swept automatically.
- `fenix doctor` prints a `run owners` line: `N runs: mine M, restarted R,
  legacy L`. It warns when foreign runs share this state home, naming their
  hostnames and pointing at the override.

## Out of scope

N containers over one `/data` volume and the resource spike itself.
Scoped-only autonomy assumes the single-container multiplexer: sessions
coordinate through the shared store, not containers.