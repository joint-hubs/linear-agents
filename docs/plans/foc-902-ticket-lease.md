# FOC-902 — Ticket lease before intake, "claimed by" comment, autonomous pickup (opt-in), leases in briefing and cockpit

Parent FOC-898 (P3-D). PRD `docs/prd/multi-supervisor-isolation-prd.md` §6.1 (collision 1), decision Q3. Branch
`foc-902-ticket-lease` stacked on `foc-901-scoped-only` (uses `readActiveSessions` and the `taskSessions` overlay key).

## Facts (recon 2026-10-16)

- There is NO "pick the next ticket" mechanism on `main`: a managed session is created per ticket by the host
  (`POST /sessions` → `store.ensure`, `task-session-host.mjs:487`, enqueue from the dashboard `POST
  /api/work/tickets/:id/start`, `work-routes.mjs:533`); the Supervisor contract starts at intake of ONE issue
  (`agents/supervisor/CLAUDE.md:49-59`; focus via `supervisor-focus.mjs set`, :36). `supervisor-triage.mjs` has verbs
  `propose | record | intake`, loads one issue (`loadIssue` :540: `--issue-file` or `linear-query.mjs issue <id>
  --json`), writes `<run>/triage.json` in `cmdRecord` (:595, write :655-700, "one triage.json per run, one issue"
  :664, cross-issue refused without `--force` :672).
- Task sessions (`task-sessions.mjs`): task key `<workspace>:<issueId>` (`resolveTaskKey` :78-85, both parts
  `^[A-Za-z0-9._-]+$`); `ensure({ taskKey, taskId, workspace, issueId, title })` :226-254 returns the active owner or
  inserts `queued`; one active owner per task key is a partial unique index (:145-146); `claimNext` :302-314 promotes
  the oldest queued under `maxActive`; `list`, `get`, `getByTask` (:275), `update` (status transitions :375-380). No
  expiry/heartbeat. A session learns its task from env `FENIX_SUPERVISOR_SESSION_ID`, `LA_TASK_KEY`, `LA_TASK_ID`
  (`task-session-host.mjs:182-185`). FOC-901 added `readActiveSessions(dbPath)` (read-only) and `pidAlive`.
- Linear: `linear-ops.mjs comment <id> --body|--body-file --dedup-tag <tag>` (marker `<!-- run:<tag> -->`, :527/:565,
  re-post suppressed :590-592; egress-screened :524); the Supervisor may run it (`agents/supervisor/settings.json:10-11`),
  children are denied (`SUPERVISOR_DENY` :1488-1489). `linear-query.mjs issues --status <state> [--label <l>] [--json]`
  (`buildIssuesQuery` :130), `search`, `issue`. Key env `LINEAR_API_KEY` (`linear-client.mjs:74`),
  `LA_LINEAR_NO_ENV_FILE=1` keeps tests offline. No API mock on main — triage tests use `--issue-file` (`fixture` :466,
  `run` :473, `issue()` :68).
- Ownership (`checkOwnership` in `scripts/task-ownership.mjs`) lives on the unmerged branch `fenix-task-ownership`
  (#76); until it lands, the owner scope = the repo's `linearProject` in `config/projects.json` (entry by `repo`).
- Briefing JSON: `supervisor-status.mjs:304-363` (`focus`, `live`, `held`, `pendingGates`, `wake`, `waker`,
  `lastAction`). Cockpit board: `GET /api/work/tickets` (`work-routes.mjs:445`, imports `resolveTaskKey` :40, per-child
  `sessionId` from the registry :351-363); UI `ui/src/components/work/TicketCard.jsx` (head: id + stage tag, :25-35).
- Doctor `task sessions` line and the overlay key `taskSessions.maxActive` + `checkTaskSessions` come from FOC-901.

## Design

### A. Lease binding in triage (`supervisor-triage.mjs record` and `intake`)

1. Scoped session (`FENIX_SUPERVISOR_SESSION_ID` set): the issue identifier must equal `LA_TASK_ID` (and the key
   `LA_TASK_KEY` when present) — otherwise refuse `LEASE_MISMATCH` (`failJson`, exit 1, message "this session holds
   the lease for <LA_TASK_ID>; it cannot triage <id>"), nothing written.
2. Unscoped run: compute the candidate task key `resolveTaskKey({ workspace, issueId })` with `workspace` = the same
   value the host uses for this repo (check how `POST /sessions` / `work-routes` derive it — `config/projects.json`
   `repo` or `basename(gitRoot)`; export one helper `workspaceNameFor(gitRoot, env)` in `task-sessions.mjs` and use it
   everywhere). `readActiveSessions` → an active row with that key whose pid is alive (`pidAlive`) → refuse
   `TICKET_LEASED` naming the session id and status; `FENIX_SUPERVISOR_LEGACY=1` records anyway with
   `lease.override: true`. A missing/unreadable store → unscoped proceeds (the FOC-901 guard already covers the
   unknown-store case at start) with `lease.store: "missing"|"unknown"`.
3. `triage.json` gains `lease: { sessionId | null, taskKey, workspace, checkedAt, override?: true, store? }`.

### B. "claimed by" comment (Supervisor side, in `record`)

After triage.json is written: body `claimed by \`sup-<sessionId>\` (run <runId>) at <iso> — fenix` (unscoped: `run
<runId>` only), posted with `node "$LA_ROOT/scripts/linear-ops.mjs" comment <identifier> --body "<body>" --dedup-tag
claim:<sessionId|runId>` through `spawnSync`. Skipped (recorded as `claimComment: { posted: false, reason }`) when
`--no-claim-comment`, when the issue came from `--issue-file` and `--claim-comment` was not given, or when
`LINEAR_API_KEY` is absent; a failed post never fails `record` (one stderr line, `posted: false, reason: "<stderr tail>"`).
Test seam `LA_TRIAGE_CLAIM_CMD_LOG=<file>`: the full argv is appended there as one JSON line and nothing is executed.

### C. Briefing leases (`supervisor-status.mjs --briefing`)

New section `leases: { mine: { taskKey, sessionId, status } | null, others: [{ sessionId, taskKey, status, live }] }`
built from `readActiveSessions` + `pidAlive` (mine = the row whose session id equals `FENIX_SUPERVISOR_SESSION_ID`);
text form `Leases: mine <taskKey> (<sessionId>, <status>); others: <taskKey> (<sessionId>, <status>[, stale])…` or
`Leases: none`. Store missing → `leases: null`, line `Leases: no managed sessions`.

### D. Autonomous pickup, opt-in (`task-session-host.mjs serve`)

Overlay `taskSessions.autoPickup = { enabled: boolean (default false), pollSeconds: 60..3600 (default 300), states:
[string] (default ["Backlog"]), label: string | null, workspace: string | null }` validated in `checkTaskSessions`
(unknown keys refused). When enabled, `serve` runs `pickupTick()` every `pollSeconds` (first tick 10 s after start):
`listCandidates()` = for each state `node linear-query.mjs issues --status <state> [--label <l>] --json` (offline env
rules: `LA_LINEAR_NO_ENV_FILE` respected), filtered to the owner scope (issue `project.name` equals the repo's
`linearProject` from `config/projects.json`; when `scripts/task-ownership.mjs` exists, `checkOwnership` instead —
one `try import`), ordered by priority (urgent first) then `createdAt`; for each candidate whose task key has NO row
in the store (`getByTask` on the whole table, terminal rows included — a completed/failed ticket is never re-picked
automatically) → `ensure({ taskKey, taskId: identifier, workspace, issueId, title })`; stop enqueuing when queued +
active ≥ `maxActive` (the scheduler promotes with `claimNext` as today). One log line per tick
`auto-pickup: <n> candidates, <m> enqueued[, skipped <k> (in store)]`; errors are logged and the timer continues.
`GET /pickup` returns `{ enabled, pollSeconds, states, lastTickAt, lastError, lastEnqueued: [taskKey] }`. The host never
writes to Linear (the comment stays in triage). Injectable seams: `deps.listCandidates`, `deps.now`, `deps.setInterval`.

### E. Doctor + cockpit

- Doctor `task sessions` detail gains `auto-pickup: off` or `auto-pickup: on (every <n>s, states <list>)`.
- `GET /api/work/tickets`: each ticket gains `claimedBy: { sessionId, status, live } | null` (`getByTask` on the
  ticket's task key via `workspaceNameFor`); `TicketCard.jsx` renders a muted tag `claimed · <sessionId short>` (class
  `wk-card-claim`, title "claimed by <sessionId> (<status>)") when present. Browser check on an acceptance instance
  before the PR (repo rule).

### F. Docs

`docs/task-sessions.md` gains "Ticket lease (triage)", "Autonomous pickup (opt-in)", "What the cockpit and the
briefing show"; `docs/supervisor-e2e-checklist.md` AC-2 bullet: triage refuses a ticket leased to another live session;
this plan.

## Tests (cases in existing files, no new test file)

- `supervisor-triage.test.mjs`: scoped mismatch refuses (no triage.json); unscoped with a live owner (temp store, pid
  = `process.pid`) refuses `TICKET_LEASED`; dead-pid owner → records; override records with `lease.override`; claim
  command logged with the exact body + `--dedup-tag claim:<id>`; `--no-claim-comment` and `--issue-file` without
  `--claim-comment` skip with the reason; `triage.json.lease` shape.
- `supervisor-status.test.mjs`: leases section mine/others/stale; store missing → null.
- `task-sessions.test.mjs`: `workspaceNameFor` rule.
- `fenix-settings.test.mjs`: `autoPickup` validation (enabled, pollSeconds bounds, states array, unknown key).
- `task-session-host.test.mjs`: `pickupTick` with an injected `listCandidates`: enqueues candidates without rows,
  skips rows (queued/active/terminal), stops at the cap, orders by priority; disabled by default (no timer); a throwing
  `listCandidates` is logged and the next tick runs; `GET /pickup` shape.
- `fenix-doctor.test.mjs`: auto-pickup detail. `work-routes.test.mjs`: `claimedBy` present/absent. UI: a case in the
  existing `ui/src/_tests_*` file for the work board if one covers `TicketCard` (else note it).

Expiring leases / heartbeats (a dead session is detected by pid); picking tickets outside the owner scope; Linear
state changes on claim (the comment is the only write); the Settings panel (FOC-906).

## Revisions

- 2026-10-16 review: task keys use the display identifier (`issuePartOf`), never the uuid; `record` derives the
  lease key from `--issue`; claim post has a 30 s timeout.
