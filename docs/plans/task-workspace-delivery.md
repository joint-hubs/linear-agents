# Delivery Plan — Task Workspaces & Concurrent Supervisors (P1–P4)

PRD: `docs/prd/task-workspace-supervisors-prd.md` — **APPROVED 2026-10-14** (all P1–P4 approved by Mateusz, "zatwierdzam"). Implementation **DELIVERED 2026-10-14** (P1–P4 + final verification; evidence in the integration / verification / acceptance logs at the end of this file).

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

Delivered 2026-10-14 — evidence in the integration / acceptance logs below.

- [x] Extend the single host (port 7332) into a session multiplexer routing by validated opaque `sessionId`; no extra public ports. (`task-session-host.mjs serve` on :7332.)
- [x] Per-session state: paths, current-run pointer, transcript, messages, wake file, terminal, config snapshot — isolated under the task's session directory.
- [x] Host mirrors the scoped routes under `/sessions/:id` (below); legacy global routes kept **only where unambiguous** (single active session) and otherwise answer with an explicit ambiguity error — never a silent guess (§5). (Acceptance: 409 `selection-required` vs scoped `taskKey` binding.)
- [x] Task start binds **immutable Linear issue identity** (workspace + issueId) at `ensure` time; display identifiers resolve only within the matching workspace (AC-2, AC-5).
- [x] Cancel/stop scoped to `task + generation`; stopping A never touches B (AC-1). (Acceptance: stop A → B byte-identical, C claimed the slot.)
- [x] SSE/WS streams scoped per task/session; routing validated server-side (AC-4).
- [x] Migration: known existing owner attached once; unknown legacy runs read-only and unassigned; nothing auto-adopted. (`ensure` is the one attach; `supervisor-current-run` scoped mode has adoption OFF and throws on an owner mismatch; legacy stays readable and unassigned.)
- [x] Spike follow-ups (owned here): shared integration-lock blast radius across `supervisor-lib.mjs`; resource benchmark at cap=2. Closed 2026-10-14 — both write-ups below.

#### P1b spike follow-ups — closed 2026-10-14

**Shared integration-lock blast radius (`supervisor-lib.mjs`).** The lock is repo-wide by design (`<commonGitDir>/workspace-claims/integration.lock`, atomic `O_EXCL`): two task sessions in different repos never meet; two in the same repo share one lock. Holders and their hold times: the managed `ensureWorktree` path (a spawn's worktree creation — seconds) and `supervisor-merge.mjs` (`merge:<runId>` — the whole merge run, minutes). Contention is **fail-fast, never a queue**: the loser is refused immediately with the holder named and the explicit `recover --force` command in the error; the refusal writes no worktree and no claim and leaves the holder's lock untouched. Reentrancy is per-process (depth counter), so `ensureWorktreeCore → claimWorkspace` cannot self-deadlock; a clean exit releases via the exit hook, a hard kill leaves the lock for explicit recovery. Nothing else in `supervisor-lib.mjs` shares mutable state across sessions — the wake-queue append path and `updateChild` are per-run single-writer, so their one-live-child caveat applies per run and is unaffected by cross-session concurrency. Pinned by `workspace-claims.test.mjs` §11 (the cap=2 spawn-vs-merge case: refused fail-fast naming the holder, no side effects, clean release unblocks the very same call) — suite 11/11.

Recommendation: keep fail-fast. If spawn-under-merge refusals ever become noise at cap=2, the change is a bounded wait in `acquireLockFile` — a behavior change, and the merge hold must not shrink (it is what makes landing atomic against concurrent worktree creation). Not needed today.

**Resource benchmark at cap=2** — stack `fenix-task-workspace` @ 4602, two live sessions (CHECK-B `running` + CHECK-C recovered via the designed Stop → Resume), 2026-10-14:

| Measure | Idle, 2 sessions live | 2 concurrent light turns |
|---|---|---|
| `fenix-supervisor` container | 0.2–0.5% CPU, 324–329 MiB | 0.4–2.5% CPU, 364–389 MiB |
| `fenix-api` container | ~0% CPU, 40–42 MiB | ~0% CPU, ~41 MiB |
| per-session processes | claude 234 / 262 MB, launch 64 MB each, tmux ~3.5 MB each | claude 261 / 275 MB |
| session host (`task-session-host.mjs`) | 75 MB | 75 MB |
| disk, per session home | ~20 MB | — |

Notes, stated so the numbers are not over-read: process RSS sums double-count shared node pages — the container working set is the honest total (≈ 330–390 MiB at cap=2). The turns were one-word probes with no tools; tool-heavy turns cost more CPU. `claude` RSS grows with conversation length. One post-burst probe caught `fenix-api` at 11.6% CPU — telemetry ingest plus the probe's own fetches, not attributed to session turns.

### P1c — Scoped API + UI

Delivered 2026-10-14 — scoped API regressions 48/48; UI helpers + Vite build + browser walk (see the logs below).

- [x] Scoped API (proposed contract):
  - `GET /api/supervisor/sessions` — list (status, taskKey, health).
  - `GET|POST /api/supervisor/sessions/:sessionId/session` — read / (re)start-resume.
  - `GET|POST /api/supervisor/sessions/:sessionId/message` — transcript read / send.
  - `POST /api/supervisor/sessions/:sessionId/stop` — scoped cancel.
  - `WS /api/supervisor/sessions/:sessionId/terminal` — per-session terminal stream.
  - Host-mirrored equivalents under `/sessions/:id` (P1b).
- [x] Legacy global endpoints remain functional **only when unambiguous** (≤1 active session); ambiguity → explicit error payload.
- [x] Board is home: `/` → board, `/work` alias; cards carry real Linear labels (id/name/color, tooltip overflow, filterable) (AC-5).
- [x] Cockpit route `/work/:taskKey/cockpit` (chat/terminal/team/timeline/evidence); header shows task + Supervisor identity + health. Stage shown **separate** from lifecycle status. (Browser walk 2026-10-14.)
- [x] Needs-you inbox links every item to its task-scoped cockpit.
- [x] No drag-and-drop without a real backend action behind it.

### P1 events (runtime, basis for P3)

Delivered 2026-10-14 (`feat(runtime)` batch; producers in `runtime-hook.mjs`, store in `runtime-events.mjs`).

- [x] Emit named events: `supervisor_started` / `supervisor_stopped`, `actor_state_changed`, `workflow_selected` / `workflow_revised`, `stage_attempt_started` / `stage_attempt_completed`, `return_to_dev` — shared fields exactly per PRD §9 (`taskKey, supervisorSessionId, workflowRunId, attemptId, actorId/role, parentActorId, seq, eventId, occurredAt, schemaVersion`, cause/evidence). Idempotent event ids; `seq` scoped per actor/session stream.
- [x] Migration of existing runs per §5 (explicit, no silent adoption). (Scoped `supervisor-current-run` adoption OFF; a foreign run is never adopted into a task.)

**P1 acceptance:** AC-1 … AC-5 pass (PRD §13).

## 3. P2 — Manager tool config + MCP (Thoughtmap)

- [x] Versioned MCP registry: connection params + **secret references** (never values); builtin tools and MCP servers as distinct layers.
- [x] Manager Tools editor: catalog + discovery + test-connection + per-role selection, staged `preview → apply`, persisted via the existing `squad-config.mjs` write service.
- [x] Inheritance `global → squad → role`; per **agent-process launch** capture a profile snapshot (registry revision + resolved tools). Apply affects only the **next** process; restart/resume previews the profile diff and records a new revision (§7).
- [x] Config snapshot recorded per session (hooks into P1a `config snapshot` state).
- [x] Thoughtmap spike first: runtime packaging, container reachability, actual `tools/list` of the registered stdio adapter (`infra/mcp-chromadb/server.py`); one read-only round-trip before "available" (§8). Five tools only — the seven-tool pipeline module is out of scope. (All five real Thoughtmap tools verified 2026-10-14.)
- [x] No write endpoints enabled implicitly; no Docker socket; no sidecar by default.
- [x] Tests use fake MCP fixtures; no auth material in responses/logs/frontmatter (AC-6, AC-7).

## 4. P3 — Metrics

Code, tests and routes/screen wiring delivered 2026-10-14 (`/insights/runtime`); the runtime-hook producer integration is coded and landed (entry (32) correction — the 12:36–12:39 Atlas wave came in after this note was first written). Active-span source = native Claude Code OTLP spans.

- [x] Active-span instrumentation (spike: where `model_request`/`tool_exec` intervals can be measured); historical windows render **unavailable** with coverage — never estimated. (Native Claude Code OTLP spans verified in a real GLM 5.3 Flash child run.)
- [x] Actor active % exactly per PRD §10 (knownTime denominator, coverage shown, null on zero denominator).
- [x] Role stats as duration pools; team concurrency as a capacity pool.
- [x] Workflow choice proportions from `workflow_selected` (+ revisions separate); rework from `return_to_dev` with reason/source; infrastructure retry ≠ rework.
- [x] Metrics computed from P1 events + existing telemetry/cost facts — **no second analytics store**.
- [x] Hand-calculated fixture tests: overlapping intervals, missing denominators, retries — counts **and** % correct (AC-8). (`scripts/runtime-statistics.test.mjs`; `/insights/runtime` wired.)

## 5. P4 — Semantic task map

Embedding cache, UMAP projection (seed 42), routes and the `/insights/map` screen delivered 2026-10-14; real local Ollama verification PASSED (integration checkpoint). Browser acceptance DONE 2026-10-14 (§6).

- [x] Embedding cache: per-text digest; reuse vectors only when input contract + model + revision + dims match; batched, off request thread, partial/error states; local cache dir git-ignored; **no automatic export** to Thoughtmap or anywhere else.
- [x] Projection: UMAP, fixed seed + library version + parameters saved per projection version; filtering never refits; new points transform into the fixed reference; explicit rebuild = new version; tiny-N fallback = list/PCA. Similarity on original vectors; 2D visual only. (Real Ollama `embeddinggemma`: digest `85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1`, seed 42 — 5 points fit, 6th transformed with the 5 old coords unchanged — PASSED.)
- [x] Map UI: one point per task, color by stage, selectable size (cost/time), click opens the exact task cockpit (`taskKey` drill-down). (`/insights/map` wired; browser acceptance in §6.)
- [x] Tasks without embeddings show no point — no fabrication (AC-9).

## 6. Final verification (last, after P1–P4)

- [x] Docker rebuild + redeploy (non-production acceptance stack); **no prod changes, no commits** in this pass. (2026-10-14: image `fenix:task-workspace-candidate` rebuilt from HEAD, both containers healthy.)
- [x] Full build + browser E2E for the UI lanes: board, cockpit, Manager, Statistics, map. (Server-side all green; browser walk DONE by Mateusz 2026-10-14 — "ok wyglada ze wszystko dziala super". No headless harness exists in `ui/`; the walk is the evidence.)
- [x] Mocked verification first; real-provider verification as a **separate** run — no operational claim from the mock environment (AC-10). (Real runs: in-stack task-map build 137/137 via Ollama; Manager test-connection init+tools+search 14.3 s.)
- [x] Update `docs/STATE.md` with delivery status; propose commit batches (parent decides). (STATE (31)/(32); 11 batches landed after Mateusz said „commituj".)

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
- [x] Remount scoped polling on task/session changes and clear old snapshot immediately; preserve URL prompt prefill without a clearing-effect race. (TaskCockpit: panel keyed by `sessionId`, prefill mount-only.)
- [x] Board card direct cockpit link; unresolved task Ask must not draft into the global Supervisor. (UI regression fixes verified 2026-10-14.)
- [x] Register new UI/backend test lanes and make the board tab active at /. (Lanes registered; nav tests pin `/`.)
- [x] Implement durable repository/workspace writer claims and common-git integration lock before concurrent child delivery.
- [x] Integrate runtime events/traces and launch tool snapshots into supervisor/child/followup paths. (Coded 2026-10-14, landed in commit batch `feat(runtime)`.)
- [x] Implement P3 aggregation/routes/UI and P4 local embedding/projection/routes/UI. (P3 metrics + `/insights/runtime`, P4 map + `/insights/map`; real local Ollama verification PASSED — integration checkpoint.)

### Integration review queue (do not accept before resolution)

- [x] Host: restart reconciliation must preserve queued claims and reserve capacity for live/unknown processes; verify PID + OS start identity. RESOLVED 2026-10-14 — OS process identity (boot ID + start ticks, uncertain ownership reserves capacity); stopped-history resume through queue/cap, 34 tests pass.
- [x] Host: failed terminal generations must reject every mutation/terminal attach; release capacity only after scoped stop is proven, not before kill. Coordinate start/stop races. RESOLVED 2026-10-14 (host recovery and ownership regressions 17/17).
- [x] Host: serve CLI must stay alive (no immediate process.exit after listen), queue pump must fill the cap and drain after startup/failure; verify the legacy delegate object shape. RESOLVED 2026-10-14 — listen callback only logs (exit only on error/SIGTERM/SIGINT); pump evidence: scoped stop A → queued C claimed the freed slot.
- [x] Tools: explicit empty tool set must disable tools, not omit --tools and regain defaults. --tools controls builtin tools only; enforce MCP exclusions separately, preserve existing MCP servers. RESOLVED 2026-10-14 — `--tools ''` pushed for empty builtin lists (NONE, not defaults); MCP subset is per-role at stamp time; a pre-existing worker `mcpServers` block is refused, never merged.
- [x] Tools: keep worker frontmatter canonical; do not add a competing roleOverrides store. Global/squad/role inheritance and next-process snapshot remain required. RESOLVED 2026-10-14 — the tool-profiles registry is the single inheritance store; stamps write tools/mcpServers into the launch-owned copy only and never a second store.
- [x] UI regression fixes verified: active owner wins over history, explicit history read-only, stale task snapshot hidden, no global Ask fallback, board card cockpit links, / active tab; 30 helper tests + Vite build pass.

### Integration checkpoint — 2026-10-14

- [x] Scoped API contract regressions: 48/48; preserve state strings, bind terminal/gate/hold to task and session, route wake notices to the scoped Supervisor.
- [x] Host recovery and ownership regressions: 17/17; process identity verified with Linux boot ID and start ticks, uncertain ownership reserves capacity.
- [x] Actual GLM 5.3 Flash telemetry probe: interaction and model spans stored with task/session context; no prompt/tool content captured.
- [x] Actual Thoughtmap MCP initialize, five-tool discovery and search roundtrip. Distance dependencies still require acceptance.
- [x] Workspace writer claims and integration lock implemented; focused worker tests passed, parent integration review pending.
- [x] Complete runtime hook / child launch profile integration and honest causal/window statistics. (Launch paths carry hooks + tool snapshots; `/api/runtime-statistics` reports known-time denominator with explicit coverage, never estimates.)
- [x] Wire statistics/map routes and screens, global/squad tool layers, explicit resume semantics.
- [x] Final Docker rebuild/redeploy and browser acceptance of concurrent task cockpits, Manager and semantic map. (2026-10-14: rebuild+redeploy DONE on `fenix:task-workspace-candidate`; server-side acceptance GREEN — see the acceptance log below; browser walk DONE by Mateusz 2026-10-14 — "ok wyglada ze wszystko dziala super": isolation probe `FENIX_SESSION_B_OK` on CHECK-B, terminals recovered via Stop → Resume, blank-page fix live.)
- [x] Update ACCESS/STATE and prepare logical commit batches (do not commit without explicit request). (STATE updated 2026-10-14 entries (31)/(32); ACCESS carries the 4602 stack section; 11 commit batches landed on `fenix-settings-keys`.)

### Verification log — 2026-10-14 (lanes/docs worker)

- [x] Real local task map on real Ollama `embeddinggemma`: cache digest `85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1`, UMAP seed 42 — 5 points fit, then a 6th transformed with the 5 old coordinates unchanged — **PASSED**.
- [x] Real GLM 5.3 Flash run in a native child process: OTLP interaction/model spans stored with task/session trace attribution; no prompt/tool content captured.
- [x] Explicit stopped-history resume through queue/cap: code + tests, **34 pass**.
- [x] Test lanes: 18 new backend `*.test.mjs` registered in `scripts/test-lanes.json` (task-workspace suites + `supervisor-watch`, `supervisor-launch`, `worker-tool-profiles`) — parallel vs serial decided per sockets/process/env (9 serial: `runtime-otel`, `task-cockpit-routes`, `task-map-routes`, `task-session-host`, `task-sessions`, `tool-profiles`, `tool-routes`, `workspace-claims`, `supervisor-watch`; 9 parallel). Lane coverage + static isolation audit green (`node scripts/test-run.mjs` inventory pass). Nav tests 24/24 (`/insights/runtime` "Runtime statistics", `/insights/map` "Task map" pinned).
- [x] Docs required-count guards: `docs/supervisor-e2e-checklist.md` updated 152 → 172 and the guard re-run green (`scripts/docs-count-guard.test.mjs`, 172 = 172). The prose line (~208, "`test-all.mjs` → 116 files") is not guard-checked and still reads stale — left as an observation, not owned.
- Browser E2E acceptance walk: DONE 2026-10-14 (Mateusz: "ok wyglada ze wszystko dziala super"). Native worker MCP distance-tool acceptance: DONE — all five tools answered real payloads on the host Ollama probe (see the acceptance log).
- Blank task-cockpit page (the walk's first stop) — FIXED 2026-10-14: `TaskCockpit.jsx` dereferenced `snap.data.data` when both the snapshot envelope and the session were absent on first paint (`undefined === undefined` made the ternary take its true branch → TypeError → React unmounted the tree). Extracted as `snapDataFor(envelope, session)` in `taskCockpitModel.js`, null-guards both sides, 6 unit tests; image rebuilt and redeployed.
- Session `lastError` banner (the "Terminal disconnected" confusion) — FIXED 2026-10-14: the P1 restart quarantine is designed to refuse the terminal WS (409 `session-recovery-required`), but the browser maps the failed handshake to a generic 1006 overlay and the task cockpit never rendered `session.lastError`, so a designed state looked like a dead terminal. `sessionErrorBanner(session)` in `taskCockpitModel.js` (verbatim `lastError`, hint only when the message names a UI-known recovery), banner in `TaskCockpit`, `hint` prop on `TerminalView`; 4 unit tests (40/40). Second redeploy re-quarantined B/C by design — the banner is visible on both cockpits (Stop → Resume this history).
- Observation from the walk (not a P1–P4 defect): a task session answering "jak tam status" pitched generic frontman intake ("podaj ID issue…") although its `taskKey` is bound to CHECK-B. The isolation probe forbade tools, so the child could not read its own record — the honest answer under that constraint. **FIXED 2026-10-14** — the kickoff now carries the binding (below).
- Task binding in the session kickoff — FIXED 2026-10-14: `prepareSupervisorLaunch` (`scripts/supervisor-launch.mjs`) appends a `## Task binding` section to the session's `CLAUDE.md` naming `taskKey` (and the Linear id when it passes `isRuntimeToken`), so a session knows its bound ticket **without tools**. The store and the env carried the identity all along — the model read neither. A managed launch without a task key still refuses outright (telemetry identity is all-or-nothing), so a binding is never fabricated; the Linear id is env-only and is dropped when it is not a short safe identifier — a prompt is never a place for unvalidated text. 5 tests in `supervisor-launch.test.mjs` (suite 92/92).
- Active Atlas jobs: hook `claude-606ac3`, watcher `claude-dd9312` (both active).

### Acceptance log — 2026-10-14 (server side, stack `fenix-task-workspace` @ 4602)

Image `fenix:task-workspace-candidate` rebuilt from HEAD (`2abaa7e`), redeployed, both containers healthy.

- [x] **Restart reconciliation (P1):** redeploying the containers left CHECK-A/B `waiting` with `lastError: process identity unproven after restart; capacity reserved` and CHECK-C `queued` — PID+OS-start identity, capacity reserved for unproven owners, queued claims preserved. Exactly the design under test.
- [x] **Stop one without touching the other (P1):** scoped `POST /sessions/<A>/stop` → A `stopped` (terminal, tmux ok), B byte-identical (same pid 292 / updatedAt 13:53:03), C claimed the freed slot (`queued → starting`, new pid). Cap=2 respected: B's reserved slot + C's new one.
- [x] **Terminal generation rejects mutations (P1):** `POST /sessions/<A>/message` → 409 `session-terminal` ("this generation is over"); restart requires an explicit `confirm: "new-session"`.
- [x] **Ambiguity, never a silent guess (P1):** global `GET /api/cockpit` and `POST /api/supervisor/message` answer 409 `selection-required` while managed sessions exist; scoped mirrors answer with `taskKey` binding. Legacy conversation stays readable (one legacy session — unambiguous by construction).
- [x] **Manager test-connection (P2):** `POST /api/tool-profiles/test` → `ok: true`, stages initialize/toolsList/searchRoundtrip all true, five tools listed, 14.3 s. (`enabled: false` default held — probe works without enabling.)
- [x] **Honest statistics (P3):** `/api/runtime-statistics` reports known-time denominator with `coveragePct` (e.g. activePct 90.3 at coverage 0.02%) — no estimates over unknown time.
- [x] **Map integrity (P4):** before build — `points: []`, `projection: {available:false, reason:"not_built"}` (AC-9, no fabrication). In-stack `POST /api/task-map/build` → 137/137 tasks embedded (`ready: 137`, `error: 0`) and projected (UMAP), points carry `taskKey`/`stage`/`labels`/`x`/`y` for cockpit drill-down.
- [x] **Native MCP adapter (P2, host path):** product stdio transport against `server-thoughtmap.py` with host Ollama `qwen3-embedding:8b` + the real 154-cluster `clusters.json` — initialize + `tools/list` = 5 tools, then real payloads from every tool: `search_thoughts` (real hits), `list_clusters`, `get_cluster` (cluster 0, representative texts), `text_distance` (distance 0.4203 / similarity 0.5797), `cluster_distances` (cluster 0 → nearest Sim-to-Real Transfer in DRL 0.4119, Physical AI Architecture 0.4417, Robotics and VLMs 0.4505; farthest CD Projekt Stock Analysis 0.7396). First `cluster_distances` call pays a one-time centroid grind over all clusters (cached afterwards); that run took ~16 min CPU-only because the GPU was occupied by a foreign process.
