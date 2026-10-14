# Delivery Plan — Task Workspaces & Concurrent Supervisors (P1–P4)

PRD: `docs/prd/task-workspace-supervisors-prd.md` — **APPROVED 2026-10-14** (all P1–P4 approved by Mateusz, "zatwierdzam"). Implementation **in progress**; nothing delivered yet.

## 0. Ground rules (binding for every worker)

- **Worker policy:** delegation is **Flash only** (`z-ai/glm-5.3-flash`) via Atlas (`agent_spawn` / `agent_collect`). No nested agents. Escalations go **to the parent/orchestrator** — workers never substitute models or self-escalate.
- **No** `git add/commit/push`, **no** deploy, **no** production changes, **no** real model calls, **no** secret values printed or logged. Fake fixtures only (AC-7).
- CodeGraph index for this worktree is **UNKNOWN** (established earlier; do not re-query or init). Bounded direct reads are the sanctioned fallback.
- Large uncommitted Settings diff exists in this worktree — **preserve it**; do not touch Settings files. Other workers run concurrently; own only assigned files.
- Focused tests per slice; no whole-suite runs unless a slice assigns one.
- All code, comments and docs in English.

## 1. Prior recon & approval (checked)

- [x] PRD approved 2026-10-14 (P1–P4, including defaults: cap=2, Thoughtmap-only MCP, UMAP projection).
- [x] Recon facts verified and frozen in PRD §2.4 (routes, host topology, telemetry store schema, Thoughtmap registered adapter, single-writer registries). No re-exploration.
- [x] Contracts below agreed between workers; deviations are escalated, not invented locally.
- [x] STATE.md entry (30) records the approval; entries (28)/(29) preserved as history.

## 2. P1 — Concurrent task workspaces

### P1a — Identity & coordinator (`scripts/task-sessions.mjs`, NEW; tests `scripts/task-sessions.test.mjs`)

- [x] Implement `createTaskSessionStore({ dbPath, maxActive = 2 })` returning:
  - `ensure({ taskKey, taskId, workspace, issueId, title })` → session record (idempotent per `taskKey` — duplicate open lands on the same session/cockpit).
  - `get(sessionId)` / `getByTask(taskKey)` / `list({ includeTerminal = true })`.
  - `claimNext()` → oldest `queued` session transitions to `starting` **iff** active cap allows; otherwise stays queued (visible status, never dropped — AC-3).
  - `update(sessionId, { status, runId, pid, processStartedAt, lastError, title })`.
  - `close()`.
- [x] Record fields (exact): `sessionId, taskKey, taskId, workspace, issueId, title, status, runId, pid, processStartedAt, createdAt, updatedAt, lastError`.
- [x] Session ids: safe `sup-` + lowercase hex (crypto-random, URL/cron-safe), never derived from user text.
- [x] Default state path: `/data/supervisor/task-sessions.sqlite` (override via options for tests/temp dirs).
- [x] Lifecycle: `queued → starting → running ⇄ waiting → completed | stopped | failed` (`stopped/failed/completed` are terminal; `waiting` is a runtime sub-state, not terminal).
- [x] One active owner per task enforced atomically inside the store (SQLite transaction / WAL); idempotent `ensure`.
- [x] Recovery uses PID **+** `processStartedAt` + status, never PID alone (§6). Verified: Linux boot ID + kernel start ticks (`scripts/task-process-identity.test.mjs`); host recovery/ownership regressions 17/17; explicit stopped-history resume through queue/cap — code + tests, 34 pass (integration checkpoint).
- [x] Tests: idempotent ensure, cap=2 third-task queue + drain, atomic claim, terminal transitions, malformed updates rejected.

### P1b — Task-scoped session host (`scripts/supervisor-host.mjs`, `supervisor-lib.mjs`, `supervisor-current-run.mjs`, `work-routes.mjs`, `cockpit-routes.mjs`)

- [ ] Extend the single host (port 7332) into a session multiplexer routing by validated opaque `sessionId`; no extra public ports.
- [ ] Per-session state: paths, current-run pointer, transcript, messages, wake file, terminal, config snapshot — isolated under the task's session directory.
- [ ] Host mirrors the scoped routes under `/sessions/:id` (below); legacy global routes kept **only where unambiguous** (single active session) and otherwise answer with an explicit ambiguity error — never a silent guess (§5).
- [ ] Task start binds **immutable Linear issue identity** (workspace + issueId) at `ensure` time; display identifiers resolve only within the matching workspace (AC-2, AC-5).
- [ ] Cancel/stop scoped to `task + generation`; stopping A never touches B (AC-1).
- [ ] SSE/WS streams scoped per task/session; routing validated server-side (AC-4).
- [ ] Migration: known existing owner attached once; unknown legacy runs read-only and unassigned; nothing auto-adopted.
- [ ] Spike follow-ups (owned here): shared integration-lock blast radius across `supervisor-lib.mjs`; resource benchmark at cap=2.

### P1c — Scoped API + UI

- [ ] Scoped API (proposed contract):
  - `GET /api/supervisor/sessions` — list (status, taskKey, health).
  - `GET|POST /api/supervisor/sessions/:sessionId/session` — read / (re)start-resume.
  - `GET|POST /api/supervisor/sessions/:sessionId/message` — transcript read / send.
  - `POST /api/supervisor/sessions/:sessionId/stop` — scoped cancel.
  - `WS /api/supervisor/sessions/:sessionId/terminal` — per-session terminal stream.
  - Host-mirrored equivalents under `/sessions/:id` (P1b).
- [ ] Legacy global endpoints remain functional **only when unambiguous** (≤1 active session); ambiguity → explicit error payload.
- [ ] Board is home: `/` → board, `/work` alias; cards carry real Linear labels (id/name/color, tooltip overflow, filterable) (AC-5).
- [ ] Cockpit route `/work/:taskKey/cockpit` (chat/terminal/team/timeline/evidence); header shows task + Supervisor identity + health. Stage shown **separate** from lifecycle status.
- [ ] Needs-you inbox links every item to its task-scoped cockpit.
- [ ] No drag-and-drop without a real backend action behind it.

### P1 events (runtime, basis for P3)

- [ ] Emit named events: `supervisor_started` / `supervisor_stopped`, `actor_state_changed`, `workflow_selected` / `workflow_revised`, `stage_attempt_started` / `stage_attempt_completed`, `return_to_dev` — shared fields exactly per PRD §9 (`taskKey, supervisorSessionId, workflowRunId, attemptId, actorId/role, parentActorId, seq, eventId, occurredAt, schemaVersion`, cause/evidence). Idempotent event ids; `seq` scoped per actor/session stream.
- [ ] Migration of existing runs per §5 (explicit, no silent adoption).

**P1 acceptance:** AC-1 … AC-5 pass (PRD §13).

## 3. P2 — Manager tool config + MCP (Thoughtmap)

- [ ] Versioned MCP registry: connection params + **secret references** (never values); builtin tools and MCP servers as distinct layers.
- [ ] Manager Tools editor: catalog + discovery + test-connection + per-role selection, staged `preview → apply`, persisted via the existing `squad-config.mjs` write service.
- [ ] Inheritance `global → squad → role`; per **agent-process launch** capture a profile snapshot (registry revision + resolved tools). Apply affects only the **next** process; restart/resume previews the profile diff and records a new revision (§7).
- [ ] Config snapshot recorded per session (hooks into P1a `config snapshot` state).
- [x] Thoughtmap spike first: runtime packaging, container reachability, actual `tools/list` of the registered stdio adapter (`infra/mcp-chromadb/server.py`); one read-only round-trip before "available" (§8). Five tools only — the seven-tool pipeline module is out of scope. (All five real Thoughtmap tools verified 2026-10-14.)
- [ ] No write endpoints enabled implicitly; no Docker socket; no sidecar by default.
- [ ] Tests use fake MCP fixtures; no auth material in responses/logs/frontmatter (AC-6, AC-7).

## 4. P3 — Metrics

Code, tests and routes/screen wiring delivered 2026-10-14 (`/insights/runtime`); real-data flow awaits runtime-hook producer integration (see integration checkpoint). Active-span source = native Claude Code OTLP spans.

- [ ] Active-span instrumentation (spike: where `model_request`/`tool_exec` intervals can be measured); historical windows render **unavailable** with coverage — never estimated.
- [x] Actor active % exactly per PRD §10 (knownTime denominator, coverage shown, null on zero denominator).
- [x] Role stats as duration pools; team concurrency as a capacity pool.
- [x] Workflow choice proportions from `workflow_selected` (+ revisions separate); rework from `return_to_dev` with reason/source; infrastructure retry ≠ rework.
- [x] Metrics computed from P1 events + existing telemetry/cost facts — **no second analytics store**.
- [x] Hand-calculated fixture tests: overlapping intervals, missing denominators, retries — counts **and** % correct (AC-8). (`scripts/runtime-statistics.test.mjs`; `/insights/runtime` wired.)

## 5. P4 — Semantic task map

Embedding cache, UMAP projection (seed 42), routes and the `/insights/map` screen delivered 2026-10-14; real local Ollama verification PASSED (integration checkpoint). Browser acceptance remains in §6.

- [x] Embedding cache: per-text digest; reuse vectors only when input contract + model + revision + dims match; batched, off request thread, partial/error states; local cache dir git-ignored; **no automatic export** to Thoughtmap or anywhere else.
- [x] Projection: UMAP, fixed seed + library version + parameters saved per projection version; filtering never refits; new points transform into the fixed reference; explicit rebuild = new version; tiny-N fallback = list/PCA. Similarity on original vectors; 2D visual only. (Real Ollama `embeddinggemma`: digest `85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1`, seed 42 — 5 points fit, 6th transformed with the 5 old coords unchanged — PASSED.)
- [x] Map UI: one point per task, color by stage, selectable size (cost/time), click opens the exact task cockpit (`taskKey` drill-down). (`/insights/map` wired; browser acceptance in §6.)
- [x] Tasks without embeddings show no point — no fabrication (AC-9).

## 6. Final verification (last, after P1–P4)

- [ ] Docker rebuild + redeploy (non-production acceptance stack); **no prod changes, no commits** in this pass.
- [ ] Full build + browser E2E for the UI lanes: board, cockpit, Manager, Statistics, map.
- [ ] Mocked verification first; real-provider verification as a **separate** run — no operational claim from the mock environment (AC-10).
- [ ] Update `docs/STATE.md` with delivery status; propose commit batches (parent decides).

## 7. Contracts & escalation summary

- Store contract (P1a) and API surface (P1c) are frozen above; a worker needing a change escalates to the orchestrator **before** deviating.
- Cross-worker interfaces (e.g. event emitter used by P3) are consumed exactly as specified in PRD §9 / this plan; incompatibilities are reported, not papered over.
- Workers report APIs/files/tests/remaining gaps concisely; the orchestrator owns integration, final review and reporting to Mateusz.

## Integration log — 2026-10-14

- [x] Session coordinator reviewed by lead: 15 tests pass, including independent-process races. Direct status updates cannot bypass claim/cap or revive terminal generations; task identity is canonical and collision-safe.
- [x] Board label data/components: worker tests 29 backend + 53 UI pass; screen/API wiring remains in P1c.
- [x] Manager worker-role tools staging: 55 model tests pass; lead tools/MCP runtime and browser acceptance remain in P2.
- [x] Atlas jobs: the 2026-10-14 wave (host `claude-82ecbc`, scoped API `claude-b12a31`, runtime OTLP/events `claude-cc2f17`, MCP registry/adapter `claude-baf986`) completed; current active jobs: hook `claude-606ac3` and watcher `claude-dd9312`.
- [x] Initial scoped cockpit UI landed; worker UI tests/build pass. Integration review found the follow-ups below.
- Native span source verified: installed Claude Code 2.1.296, official OTLP http/json tracing (model calls, tool execution, permission waits). Capture only metadata, locally, with content gates off.
- Existing local credentials were located by presence only in the main checkout .env; values were not printed or copied. Operational verification will use a separate local stack after mock isolation tests. Production VM remains unchanged.

### Review follow-ups

- [x] Fix task UI selection across session generations: choose one active owner, explicitly select historical generations read-only; do not report normal history as ambiguous. (History/isolation links verified with the UI regression fixes below.)
- [ ] Remount scoped polling on task/session changes and clear old snapshot immediately; preserve URL prompt prefill without a clearing-effect race.
- [ ] Board card direct cockpit link; unresolved task Ask must not draft into the global Supervisor.
- [ ] Register new UI/backend test lanes and make the board tab active at /.
- [x] Implement durable repository/workspace writer claims and common-git integration lock before concurrent child delivery.
- [ ] Integrate runtime events/traces and launch tool snapshots into supervisor/child/followup paths.
- [x] Implement P3 aggregation/routes/UI and P4 local embedding/projection/routes/UI. (P3 metrics + `/insights/runtime`, P4 map + `/insights/map`; real local Ollama verification PASSED — integration checkpoint.)

### Integration review queue (do not accept before resolution)

- [x] Host: restart reconciliation must preserve queued claims and reserve capacity for live/unknown processes; verify PID + OS start identity. RESOLVED 2026-10-14 — OS process identity (boot ID + start ticks, uncertain ownership reserves capacity); stopped-history resume through queue/cap, 34 tests pass.
- [x] Host: failed terminal generations must reject every mutation/terminal attach; release capacity only after scoped stop is proven, not before kill. Coordinate start/stop races. RESOLVED 2026-10-14 (host recovery and ownership regressions 17/17).
- Host: serve CLI must stay alive (no immediate process.exit after listen), queue pump must fill the cap and drain after startup/failure; verify the legacy delegate object shape.
- Tools: explicit empty tool set must disable tools, not omit --tools and regain defaults. --tools controls builtin tools only; enforce MCP exclusions separately, preserve existing MCP servers.
- Tools: keep worker frontmatter canonical; do not add a competing roleOverrides store. Global/squad/role inheritance and next-process snapshot remain required.
- [x] UI regression fixes verified: active owner wins over history, explicit history read-only, stale task snapshot hidden, no global Ask fallback, board card cockpit links, / active tab; 30 helper tests + Vite build pass.

### Integration checkpoint — 2026-10-14

- [x] Scoped API contract regressions: 48/48; preserve state strings, bind terminal/gate/hold to task and session, route wake notices to the scoped Supervisor.
- [x] Host recovery and ownership regressions: 17/17; process identity verified with Linux boot ID and start ticks, uncertain ownership reserves capacity.
- [x] Actual GLM 5.3 Flash telemetry probe: interaction and model spans stored with task/session context; no prompt/tool content captured.
- [x] Actual Thoughtmap MCP initialize, five-tool discovery and search roundtrip. Distance dependencies still require acceptance.
- [x] Workspace writer claims and integration lock implemented; focused worker tests passed, parent integration review pending.
- [ ] Complete runtime hook / child launch profile integration and honest causal/window statistics.
- [x] Wire statistics/map routes and screens, global/squad tool layers, explicit resume semantics.
- [ ] Final Docker rebuild/redeploy and browser acceptance of concurrent task cockpits, Manager and semantic map.
- [ ] Update ACCESS/STATE and prepare logical commit batches (do not commit without explicit request). (STATE updated 2026-10-14 entry (31); ACCESS NOT updated yet.)

### Verification log — 2026-10-14 (lanes/docs worker)

- [x] Real local task map on real Ollama `embeddinggemma`: cache digest `85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1`, UMAP seed 42 — 5 points fit, then a 6th transformed with the 5 old coordinates unchanged — **PASSED**.
- [x] Real GLM 5.3 Flash run in a native child process: OTLP interaction/model spans stored with task/session trace attribution; no prompt/tool content captured.
- [x] Explicit stopped-history resume through queue/cap: code + tests, **34 pass**.
- [x] Test lanes: 18 new backend `*.test.mjs` registered in `scripts/test-lanes.json` (task-workspace suites + `supervisor-watch`, `supervisor-launch`, `worker-tool-profiles`) — parallel vs serial decided per sockets/process/env (9 serial: `runtime-otel`, `task-cockpit-routes`, `task-map-routes`, `task-session-host`, `task-sessions`, `tool-profiles`, `tool-routes`, `workspace-claims`, `supervisor-watch`; 9 parallel). Lane coverage + static isolation audit green (`node scripts/test-run.mjs` inventory pass). Nav tests 24/24 (`/insights/runtime` "Runtime statistics", `/insights/map` "Task map" pinned).
- [ ] Docs required-count guards (reported, NOT changed — not owned): `docs/supervisor-e2e-checklist.md` line 3 says **152 files**, actual **170** `scripts/*.test.mjs` — update to 170; the prose line (~208, "`test-all.mjs` → 116 files") is not guard-checked but reads stale too. Guard: `scripts/docs-count-guard.test.mjs` fails until line 3 is updated.
- Still NOT delivered: runtime-hook producer integration (events/launch snapshots into supervisor/child/followup paths); full Docker rebuild/redeploy + browser E2E acceptance; native worker MCP review/test; final ACCESS.
- Active Atlas jobs: hook `claude-606ac3`, watcher `claude-dd9312` (both active).
