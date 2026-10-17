# Delivery Plan — FOC-839 Task workspaces 1.0 hardening

Linear: **FOC-839** (M8 Fenix 1.0.0, parent FOC-768, High). PRD: `docs/prd/task-workspace-supervisors-prd.md` §5
(migration — "a known existing owner is attached once; unknown legacy runs become read-only and unassigned; nothing is
ever auto-adopted into another task"). Delivery record of the stream: `docs/plans/task-workspace-delivery.md`.
Written 2026-10-17 by the delivery owner; decided alone under the 2026-10-15 autonomy rule — every default below is
reversible in review.

## 0. Why now

PR #71 landed task workspaces with a legacy regression (`POST /api/gates/answer` → 500 for the single-session
dashboard) that only the full suite caught, and with no user-facing docs. FOC-789 (fresh-machine acceptance, both
modes) cannot start until (a) the legacy single-Supervisor mode is pinned by a suite that runs on every `test-all`,
(b) `fenix update` on a volume that already has a legacy session is proven, (c) the README/QUICKSTART alone explain
the board → task cockpit flow.

## 1. Facts from the tree (2026-10-17, `main` 2b1bf33)

- Global write routes (`scripts/cockpit-routes.mjs`): `POST /api/supervisor/message | session | wake | ask | dialog`,
  `POST /api/gates/answer`, `POST /api/holds/answer`, `POST /api/gates/notify`; scoped twins under
  `/api/supervisor/sessions/:sid/{message,session,stop,wake,dialog,ask}`. The global routes answer **409
  `selection-required`** only when `managedSessionsExist()` is true (host reachable AND a non-terminal session in its
  list); a host that is not configured (native) or unreachable reads as "unmanaged" (fail-open toward legacy).
- The session host (`scripts/task-session-host.mjs`) serves the global routes through a **legacy controller**
  (`createHost` with `FENIX_SUPERVISOR_SESSION_ID` stripped) while no managed session exists; managed sessions get
  one controller each, keyed by the store row (`task-sessions.sqlite`).
- The legacy session identity is `session.json` (`supervisorSessionPath`) + the global current-run pointer
  (`supervisorCurrentRunPath`); its id shape is the Claude UUID (`SUPERVISOR_SESSION_ID_PATTERN`), the managed shape
  is `sup-<16..32 hex>` (`SESSION_ID_PATTERN`). Run ownership since FOC-905: `owner.json` per run dir, written once.
- `scripts/cockpit-routes.test.mjs` already covers a few legacy cases (gate answer without sessionId notifies the
  global `/message`; scoped answer does not), not the full matrix. `scripts/task-cockpit-routes.test.mjs` covers the
  scoped routes. Nothing exercises "host configured, session list empty".
- FOC-816 residue named by the ticket: `workspace-claims` lock test (fixed in PR #75 + #84: lease lock +
  stand-down), `supervisor-pinned-state` premise (PR #75). Every follow-up in `task-workspace-delivery.md` is `[x]`.
- `docs/QUICKSTART.md` has no task-cockpit section (board → cockpit, the cap, Stop → Resume, the 409).

## 2. Scope

| Slice | Deliverable | Files (own only these) |
|---|---|---|
| A — legacy compatibility suite | `scripts/cockpit-routes-legacy.test.mjs`: every global write route × {host not configured, host configured + empty session list} × legacy UUID session id, asserting the pre-#71 results (status, body shape, the side effect on disk: message file, wake queue, gate/hold answer file, session.json). Registered in `scripts/test-lanes.json` (parallel lane if it binds no port — it must stub the host like `cockpit-routes.test.mjs` does), checklist count lines updated. | the new test, `test-lanes.json`, `docs/supervisor-e2e-checklist.md` |
| B — legacy session migration | `scripts/supervisor-migrate-legacy.mjs` (dry run default, `--apply`): reads `session.json` + the global current-run pointer + the store; (1) a legacy run whose `triage.json.issue`/focus ticket matches a task that has exactly one **non-terminal managed session** and whose legacy Supervisor pid is not alive → **attach once**: `store.update(sessionId, { runId })` when the session has no runId, and `<runDir>/legacy-attach.json { sessionId, attachedAt }`; (2) every other legacy run → `<runDir>/legacy-readonly.json { markedAt, reason }` and the legacy controller refuses writes into it (409 `legacy-readonly`); (3) never adopts a run into a task it does not name. Called once by the host at serve start (idempotent, logged `legacy migration: attached N, read-only M, skipped K`). Acceptance script `scripts/supervisor-migrate-legacy-acceptance.sh <copy-of-volume>` runs the dry run + `--apply` on a COPY and prints the three counts — Mateusz runs it on a copy of the VM volume (the delivery owner does not touch the VM). | the new script + its test, `task-session-host.mjs` (serve start hook + the 409), `cockpit-routes.mjs` (the 409 on legacy-readonly runs), lanes/checklist (after A lands) |
| C — docs | `docs/QUICKSTART.md`: section "Task cockpits" (board → task cockpit flow, one active Supervisor per task, the cap 2 and `taskSessions.maxActive`, Stop → Resume semantics, what `409 selection-required` and `409 session-terminal` mean, the legacy global Cockpit at `/cockpit`); `docs/ACCESS.md`: the migration script, what it marks, how to run the acceptance on a volume copy. | the two docs |
| D — residue proof | 10× sequential + 3×8 concurrent runs of `workspace-claims.test.mjs` and `supervisor-pinned-state.test.mjs`; any red → fix the test's wait (observable condition, never a timer) or the production race; report. | the two tests (+ the production file only if the race is real) |

Out of scope: new task-workspace features, Thoughtmap by default, the fresh-machine acceptance itself (FOC-789),
anything on the VM.

## 3. Decisions (defaults, reversible)

- D1 "Same results as before #71" = the status codes and side effects `cockpit-routes.test.mjs` asserted at
  `3e7e099` (the 2026-09-22 baseline) for the global routes; slice A cites that revision per case.
- D2 The attach in slice B is explicit and one-shot: a session already carrying a `runId` is never re-pointed; a
  task with two candidate runs attaches the newest and marks the rest read-only.
- D3 Read-only legacy runs stay listed in the Cockpit overview and the Work board (history), never editable.
- D4 Slice A runs in the parallel lane only if the static audit accepts it (no real server bind, no live DB seam
  change); otherwise serial.

## 4. Order and workers

A, C, D in parallel (Flash, ≤ 20 min each, own files only, no git); then B (Flash) on top of A's lanes/checklist;
Pro review of B; the delivery owner integrates, runs `node scripts/test-all.mjs` once (Windows) + the Linux lane,
browser-checks nothing (no UI change), opens one PR.

## 5. Acceptance (ticket AC mapped)

1. AC1: `test-all` green on Windows and Linux with `cockpit-routes-legacy.test.mjs` registered — slices A + D.
2. AC2: the migration script + its fixture test green; the acceptance script documented in ACCESS and handed to
   Mateusz for the VM volume copy — slice B + C.
3. AC3: FOC-789 can run both modes from README + QUICKSTART alone — slice C (reviewed against the actual commands).
