# PRD — Task Workspace, Concurrent Supervisors, Manager Tool Config, Statistics & Semantic Map

Status: **DELIVERED 2026-10-14** — approved by Mateusz ("zatwierdzam") and all phases P1–P4 implemented, verified (server-side acceptance + browser walk) and committed on `fenix-settings-keys`. Execution plan and evidence: `docs/plans/task-workspace-delivery.md`.
Scope: follow-up package, separate from the completed (uncommitted) Settings work. Nothing here supersedes any Settings deliverable.
Supersedes (only if approved): the single-process navigation decision in `docs/plans/foc-783-cockpit.md` and related board/navigation assumptions in `docs/ui/dashboard-v2-spec.md`. All prior run history is preserved, never rewritten.

---

## 1. Problem & Goal

Fenix runs Supervisors as a single global process bound to one "current run". An operator working several tickets at once cannot see which task a chat/terminal belongs to, cannot run two Supervisors concurrently, cannot edit role tools from the Manager, and the existing cost statistics and flow analysis cover only part of the requested picture — actor utilization, workflow choice, rework and a semantic task map are still missing.

**Persona:** Mateusz — operator / delivery lead.

**Target journey:**
Board (home) → click card → task cockpit (chat/terminal/team/timeline/evidence) → return to board → Manager (edit role tools, incl. MCP) → Statistics (utilization, workflow choice, rework) → semantic task map.

**Non-goals for this package:** new model providers, changes to completed Settings scope, replacing the telemetry store, real-time productivity scoring, any auto-export of task text to external services.

---

## 2. Requirements, separated by certainty

### 2.1 Confirmed decisions (each individually user-approved; the plan as a whole was approved 2026-10-14)

- Board is the primary/home route; Kanban cards carry Linear labels.
- One active Supervisor **per task**; many tasks run concurrently. Each task has its own cockpit and preserved run/session history.
- Manager can edit role tools; add the **Thoughtmap** MCP integration (its registered adapter from the jointhubs-os repo) — a **single** integration. No second Jointhubs OS server; Google Workspace is out of scope for this package.
- Statistics: actor utilization, workflow-choice proportions (plan-dev-review-test vs dev-test etc.), rework-into-dev with source, semantic task map.
- Semantic map: one point per task; color by stage; selectable point size (cost/time); click opens the task cockpit.
- Developer policy: **no app implementation until this PRD was reviewed and approved** (honored during planning; approval granted 2026-10-14).

### 2.2 Defaults / proposals (changeable before approval)

- Initial global cap of 2 concurrently active Supervisors (configurable), on top of preserved per-node caps and budget checks.
- MCP for Thoughtmap: **reuse/adapt the registered stdio wrapper** (`infra/mcp-chromadb/server.py`, FastMCP `ThoughtMap`) inside the Fenix runtime with minimal extra dependencies; **no new sidecar/gateway by default**. Remaining spike: runtime packaging, container reachability and the actual `tools/list` of the selected adapter (Section 8).
- UMAP for the map projection, with fixed-seed/versioned rebuilds (Section 11).

### 2.3 Open technical validation (must be spiked, not assumed)

- Runtime packaging, container-endpoint reachability and `tools/list` of the selected Thoughtmap adapter inside the Fenix runtime (Section 8).
- Real active-span instrumentation hooks (Section 10).
- Shared integration-lock blast radius across `supervisor-lib.mjs` (Section 6).
- Resource footprint at cap=2 (Section 14).

### 2.4 Established facts this design builds on (no re-exploration needed)

- Current routes in `ui/src/App.jsx` + `navAreas.js`: `/` Cockpit, `/work` board, `/work/:ticket` detail, `/manager`, `/costs`, `/analysis`.
- Manager inspector currently *states* "Tools stay in /squad-config" and renders tool names only. `scripts/squad-config.mjs` writes `agents/<squad>/agents/<role>.md` frontmatter tools; `config/tools.json` holds the builtin catalog (MCP names may exist in role files but not the catalog). We **reuse** the write service; the Manager does **not** have an editor today.
- `scripts/work-routes.mjs` start-preview/start sends the issue as text through `cockpit-routes.forwardMessageToHost`; identity is not task-bound through the host.
- `scripts/supervisor-host.mjs`: tmux socket `fenix/session supervisor`, one host on 7332, one process. `scripts/fenix-paths.mjs`: `session.json` + `current-run.json` under `/data/supervisor`; `supervisor-current-run.mjs` adopts newest run if the pointer is missing.
- `supervisor-lib.mjs` registries assume a single writer (held queues, node caps, worktrees by branch, budget caps). Child/work manifests carry `LA_TASK_ID`/`runId`/`childId`. Unique branch strings alone do **not** make concurrent repository writes safe.
- `scripts/telemetry-store.mjs` already has SQLite `runs`/`sessions`/`run_sessions`/`work_items`/`run_task_links` (validity windows), `usage_facts`, `cost_facts`, `tool_facts`, `delegation_links`; `telemetry-canonical.mjs` dedups physical calls. Keep this cost basis; **no second analytics store**.
- `scripts/flow-db.mjs` queryTrace/queryPatterns uses a REVIEW→DEV chronological heuristic — not proven causation.
- Active-time spans do not exist today; timestamps are point measurements. Historical active work must be shown as *unavailable*, never estimated from adjacent timestamps.
- Semantic tooling exists as examples only: `tools/precedent-spike/embed.mjs` (cache/digests), `notebooks/agent_intelligence.py` (local embeddings/clustering). Task text is not persisted in the telemetry store.
- Thoughtmap (verified, newer recon): the registered `.vscode/mcp.json` in the jointhubs-os repo runs a **stdio FastMCP server `ThoughtMap`** (`python infra/mcp-chromadb/server.py`) that proxies the existing Thoughtmap REST app on port 8585 via `THOUGHTMAP_API_URL`, exposing **five** tools: `search_thoughts`, `list_clusters`, `get_cluster`, `cluster_distances`, `text_distance`. The separate pipeline module `python -m thoughtmap.mcp_server` exposes **seven** tools (adds `on_this_day`, `whats_new`) but is **not** the registered adapter — its tools must not be claimed available through the registered one. The 8585 surface is **REST, not MCP over HTTP**; reachability must be verified from inside the Fenix container (`localhost` inside the container ≠ host).
- Project `.mcp.json` has guarded codegraph + 2 decision servers; `mcp-enable.mjs` approvals cover guarded codegraph only. The new Settings schema covers provider/routing only — MCP needs a deliberate schema extension.
- Current preview `127.0.0.1:4601` is the isolated Settings acceptance environment (fake keys, models disabled) — it explains the non-interactive Supervisor there; it is **not** evidence production (4600/VM) is broken, and no multi-Supervisor behavior is claimed delivered.

---

## 3. Routing & task identity

- `/` → Board (default home). `/work` aliases to the same board.
- `/work/:taskKey/cockpit` → task cockpit with chat / terminal / team / timeline / evidence panes.
- `taskKey` = stable workspace identifier + immutable issue id; identifier strings are display-only. A legacy identifier link resolves only within the matching workspace, or shows an explicit ambiguity screen — it must never open the wrong task.
- Compatibility: retain existing task identifiers, LA_TASK_ID values and historical cost/run links. Add an explicit mapping to taskKey; never rewrite legacy evidence or infer an ambiguous workspace. New records carry both the canonical key and display identifier.
- The global needs-you inbox links every item to its task-scoped cockpit.

## 4. Board cards, labels, stages

- Card labels come from Linear id/name/color; overflow collapses into a tooltip; labels are filterable.
- **Stage is separate from lifecycle.** Lifecycle states: `waiting / queued / running / needs-you / failed / completed`.
- Card shows freshness, provider/model health; the mock/acceptance banner is shown when applicable.
- No drag-and-drop that implies an execution transition without a real backend action behind it.

### 4.1 Text wireframe (layout intent only; identifiers, counts and costs below are illustrative)

```
Board (home)
[filters: label ▾ stage ▾ search…]                        [Needs you (3) ▾]
 Ready        Plan        Dev         Review       Test       Landed
 ┌ LA-1234 ──────────────────────────────┐  ┌ … ┐  ┌ LA-1277 ┐  ┌ … ┐  ┌ … ┐  ┌ LA-1109 ┐
 │ Fix provider key rotation             │
 │ labels: fenix · backend               │
 │ stage DEV / runtime running           │
 │ 2h14 · $3.10            [Open cockpit]│
 └───────────────────────────────────────┘
```

```
Cockpit
LA-1234 · Fix provider key rotation      Supervisor sup-a · healthy
[Chat] [Terminal] [Team] [History]            [Metrics] [Map]
```

- Columns `Ready | Plan | Dev | Review | Test | Landed`; filter strip on top, global **Needs you** inbox above the board.
- Card carries: task identifier, title, Linear labels, **stage vs runtime state** (they differ), elapsed/cost, `Open cockpit`.
- Cockpit header carries **task and Supervisor identity + health**; panes follow: Chat / Terminal / Team / History.
- Metrics and map open as the **exact drill-down** of the selected card/task (same `taskKey`).

## 5. Session host: extend the authenticated host into a session multiplexer

- The existing host is a **single-session** process on internal port 7332; this package **extends it into a session multiplexer** that routes by a validated opaque `sessionId`. No extra public ports; no per-task Docker by default.
- Per-session tmux identity and per-session state: paths, current-run pointer, transcript, messages, wake file, terminal, config snapshot.
- Every request carries `task + session + run`. Uniqueness: **one active owner per task**, enforced atomically; idempotent start; a duplicate open lands on the same cockpit.
- Resuming continues the same logical session/history; a new conversation is an explicit new generation; attempts increment separately. The native Claude session id is never the app identity.
- When multiple Supervisors exist, the global current-run pointer and CLI selection must not silently fall back to a guess.
- Migration (explicit, no silent adoption): a known existing owner is attached once; unknown legacy runs become read-only and unassigned; nothing is ever auto-adopted into another task.
- The shared host token may remain as authentication, but routing isolation must not rely on the UI alone.

## 6. Concurrency, coordination, safety

- A small durable coordinator (SQLite or transactional file store, reusing the existing local-DB pattern) owns task claims and global caps. Per-session state isolation alone is not quota enforcement.
- Preserve per-node caps and budget checks; queued excess is visible as a status, not silently dropped.
- Recovery reconciles PID + start identity + state — never PID alone.
- Cancel/stop is scoped to `task + generation`; claim release is atomic; stopping task A never kills task B.
- SSE/WS streams are scoped per task/session.
- Scoped-only autonomy (FOC-901): an unscoped Supervisor never adopts a managed run while live task sessions exist — the refusal, the `FENIX_SUPERVISOR_LEGACY=1` override and the `taskSessions.maxActive` cap are documented in [docs/task-sessions.md](../task-sessions.md).
- Worktrees: concurrent write owners are separated. Each **new child attempt** gets a unique owned worktree; **follow-up/retry of the same child reuses its own worktree and history** — a retry is not a new worktree. A repository integration lock / claims registry prevents other writers from writing to the same workspace or branch. No broad git permissions are introduced; no unrequested `git commit`/`push`.
- Prior documentation (FOC-477) defines a special **one-live-child experiment policy**. This PRD changes **product capability only**; it does not rewrite that historical experiment's safety/STOP/gate rules and does not by itself enable any global permission broadening.

## 7. Manager: tool configuration & MCP registry

- Versioned MCP registry: connection parameters + **secret references** (never secret values). Builtin/native tools and MCP servers are distinct layers.
- Manager Tools editor: catalog + discovery + test-connection + per-role selection, staged as preview → apply, persisted via the existing squad-config write service.
- Supervisor-lead, squad-lead and worker settings are distinct. A tool assignment can never grant permissions beyond explicit server + role approval.
- Inheritance: **global → squad → role** produces the effective tool profile. A snapshot of that profile (registry **revision + resolved tools**) is captured **per agent-process launch**. Manager **apply** changes the configuration for the **next** new process (a new child or a new Supervisor); a running process keeps its captured profile. Resuming the same process retains its profile; a restart/resume that requires a new process **previews the profile diff** and records a new revision. There is **no task-lifetime pin** that would contradict the next-spawn rule.
- Key rotation: backends are resolved **per launch**; secret values are never pinned or stored — the completed Settings provider behavior is preserved.
- Secret values never appear in API responses, logs, or role frontmatter; key references resolve backend-side.

## 8. MCP integration: Thoughtmap (single integration)

- **One** integration: Thoughtmap, via its **registered adapter from the jointhubs-os repo**. No second Jointhubs OS server is in scope; **Google Workspace is out of scope** for this package.
- It must pass a runtime `tools/list` verification inside the Fenix network plus one meaningful read-only tool round-trip before being marked available.
- Preferred path: reuse/adapt the registered stdio wrapper (`infra/mcp-chromadb/server.py`, FastMCP `ThoughtMap`, proxying REST 8585 via `THOUGHTMAP_API_URL`) with minimal extra dependencies inside the Fenix runtime. The unregistered pipeline module (`python -m thoughtmap.mcp_server`, seven tools incl. `on_this_day`/`whats_new`) is a separate surface — not available through the registered adapter and not part of the default scope.
- Remaining technical spike: runtime packaging, container-endpoint reachability (`localhost` inside the container ≠ host) and the actual `tools/list` of the selected adapter. REST on 8585 is **not** MCP over HTTP.
- No automatic pipeline execution, write or rerun; no Docker socket mount; no new sidecar/gateway by default; no write endpoint is enabled implicitly.
- Role preview shows the *actual* tools available at runtime, including failures — not just configured names.

## 9. Events for future metrics

Emit structured events now so P3 metrics have a basis. **Named event types:** `supervisor_started` / `supervisor_stopped`; `actor_state_changed` (model/tool busy, waiting-on-human, waiting-on-child, queued, idle); `workflow_selected` / `workflow_revised`; `stage_attempt_started` / `stage_attempt_completed`; `return_to_dev` (with from/to attempt, reason and evidence). Shared fields on every event: `taskKey`, `supervisorSessionId`, `workflowRunId`, `attemptId`, `actorId`/`role`, `parentActorId`, `seq`, `eventId`, `occurredAt`, `schemaVersion`, cause/evidence fields. Every `seq` is scoped to its actor/session stream; event ids are stable and idempotent (dedup-safe). Causality is **never inferred from wall-clock ordering** alone. Task-scoped indexes.

## 10. Metrics — exact definitions

- **Actor active %** — exact denominators. *Eligible window* = the actor's **observed allocated lifetime**, clipped to the active filter. `knownTime` = union of measured state intervals inside the window; `unknownTime` = eligible − known. `busyTime` = union of `model_request`/`tool_exec` spans, clipped to `knownTime`. **activePct = 100 × busyTime ÷ knownTime**; **coverage = 100 × knownTime ÷ eligible**. A zero denominator renders **null**. The UI states "of observed known time" and always shows coverage and unknown duration next to the percentage, so a partially known window can never look like 100% of an entire life. This measures busy/execution **occupancy (including request latency)** — **not CPU usage**. Waiting-on-children / waiting-on-human / queued / idle / unknown are shown **separately**; waiting children are excluded from the lead's busy time.
- **Role stats**: **sum of durations** across actor instances (duration pools) — not averages, and not averages of percentages. **Team concurrency** is a capacity pool, not a union over actors. Workload share per role, if needed, is a **separate optional metric**. All bounds [0,100]; absent denominator → null.
- **Workflow choice** = proportions from a `workflow_selected` event (initial choice per workflow run) ÷ runs with a known choice; revisions reported separately. Planned vs observed kept distinct. Observed routes use completed runs as denominator with in-progress prefixes shown separately; adjacent same-squad repeats collapse for the route only (attempt counts retained); parallel branches are shown as parallel, never as a false chronological chain; runs without task links are *unattributed*, not "other". "Other" means another known sequence; unknown is separate.
- **Return-to-Dev (rework)** events link source attempt + verdict and reason (`review / test / human / other / unknown`). Direct causal proof vs historical inference are labeled distinctly. Same-stage infrastructure retry is not rework. Report both event count and % of completed tasks affected; drill down to evidence.
- **Additional useful metrics:** time waiting on human, lead time p50/p80, first-pass acceptance, rework cost, model/tool error rates, cost by label/repo, sample size / coverage per panel.
- Active-time spans: instrument state spans going forward; historical windows show "unavailable" with coverage — never estimated from adjacent timestamps.
- Missing boundaries and crashes: do not extend an open busy span indefinitely. Use runtime lifecycle/heartbeat evidence to bound observed intervals; uncovered gaps become unknown. Late/duplicate events must reconcile without increasing measured time twice.

## 11. Semantic task map

- One point per task. Input: normalized title + description/AC. No raw transcripts, no credentials.
- Local cache directory is git-ignored and ownership-tracked; corpus is authorized task text only. A full-text remote embedding requires a configured, approved destination — **no automatic export to Thoughtmap**.
- Reuse existing vectors **only** when input contract, model, revision and dims match; otherwise compute new and cache. Per-text digest cache: only changed text re-embeds. Embedding runs batched, off the request thread, with partial/error states.
- Projection: UMAP recommended, not a locked dependency. Fixed seed + library version + parameters are saved with each projection version. Filtering never refits; label/stage changes neither re-embed nor refit. New points optionally transform into the fixed reference; explicit rebuild creates a new projection version. Tiny-N fallback: list/PCA, never fake clusters. Nearest-neighbor similarity is computed on original vectors; 2D is visual only. The map is not a causal or productivity score.
- Sources for seed/transform behavior (documentation only): [umap-learn — Reproducibility](https://umap-learn.readthedocs.io/en/latest/reproducibility.html) and [umap-learn — Transform](https://umap-learn.readthedocs.io/en/latest/transform.html). No determinism is claimed across different library versions or hardware; only saved (seed, version, parameters) tuples and cached artifacts are stable.

## 12. Phases (smallest verticals first)

- **P0 — Planning/recon.** This PRD. Status: complete, approved 2026-10-14. *No code (by design).*
- **P1 — Concurrent task workspaces (usable with 2 tasks first).**
  - P1A: task identity/ownership, events, migration of existing runs. Files: `scripts/fenix-paths.mjs`, `supervisor-current-run.mjs`, new identity module.
  - P1B: task-scoped session host + guards. Files: `scripts/supervisor-host.mjs`, `supervisor-lib.mjs`, coordinator module, `work-routes.mjs`/`cockpit-routes.mjs`.
  - P1C: board home + labels + scoped cockpit. Files: `ui/src/App.jsx`, `navAreas.js`, board/cockpit components.
  - Acceptance: AC-1..AC-5 below pass.
- **P2 — Manager tool config + MCP connector (Thoughtmap).** Registry, editor, staged apply; Thoughtmap verified at runtime (spike first). Depends on P1 (spawn-time profile snapshots).
- **P3 — Statistics.** Utilization, workflow choice, rework causality — computed from P1 events + existing cost/telemetry facts. Depends on P1A events + span instrumentation.
- **P4 — Semantic map.** Embedding cache, projection versioning, interactive UI. Depends on P3 data hygiene.

## 13. Acceptance criteria (evidence-based)

- **AC-1** Two tasks run concurrently; different chats/terminals/gates; stopping A never affects B.
- **AC-2** Duplicate start / restart / resume / missing-pointer cannot cross-adopt another task's run.
- **AC-3** Cap=2: third task queues with visible status; queue drains correctly.
- **AC-4** Permissions and task ids validated server-side; routing does not trust the UI.
- **AC-5** Board labels are real Linear labels; legacy links never open the wrong task.
- **AC-6** Tool config survives a rebuild; the actual next spawn sees the configured tools (runtime check, not just config readback).
- **AC-7** Fake MCP fixtures in tests; no auth material in responses/logs/frontmatter.
- **AC-8** Metrics hand-calculated on fixtures with overlapping intervals, missing denominators, and retries; % and counts both correct.
- **AC-9** Map projection stable under filtering; texts without embeddings show no point (no fabrication).
- **AC-10** Docker rebuild + redeploy + browser E2E for the UI lanes. Real-provider verification runs separately from the mock stack — no operational claim is made from the mock environment (4601).

Planning-phase constraints (historical, satisfied): during planning there were no real model calls, no production mutation, and no feature code before approval. Delivery keeps: no real model calls, no production mutation.

## 14. Risks & open technical spikes (owned by phase)

- P1B: shared integration lock blast radius across `supervisor-lib.mjs` single-writer registries.
- P1B: resource benchmark at cap=2 (memory, tmux sessions, worktrees).
- P2: Thoughtmap adapter spike — runtime packaging, container reachability and the actual `tools/list` of the selected adapter.
- P3: real active-span hooks (where model_request/tool_exec intervals can be measured).
- Approved decisions are recorded in §2.1; the phased direction was approved 2026-10-14 (spikes remain open, owned by their phases).

---

## 15. Checklist

Planning (complete):

- [x] Current base verified from lead findings; no re-exploration, no CodeGraph query (index UNKNOWN established)
- [x] Confirmed decisions / defaults / open validation separated (§2)
- [x] Routing, identity, host scoping, migration defined (§3, §5)
- [x] Concurrency, caps, locks, cancel semantics defined (§6)
- [x] Manager tool config + registry contracts defined (§7)
- [x] MCP integration scoped to Thoughtmap only, with verified registered-adapter facts (§8)
- [x] Event schema and exact metric definitions (§9, §10)
- [x] Semantic map pipeline, cache, projection policy (§11)
- [x] Phases with file areas, dependencies, acceptance (§12)
- [x] Evidence-based AC incl. Docker rebuild/redeploy and mock-vs-real separation (§13)
- [x] Risks/spikes assigned to owning phases (§14)
- [x] PRD approved by Mateusz, 2026-10-14 (all P1–P4)

Implementation (DELIVERED 2026-10-14 — evidence in `docs/plans/task-workspace-delivery.md`, acceptance log at the end):

- [x] P1A identity/ownership/events + migration
- [x] P1B task-scoped host + coordinator + guards
- [x] P1C board home/labels + scoped cockpit
- [x] P2 Manager editor + registry + MCP connectors (runtime-verified)
- [x] P3 utilization / workflow-choice / rework metrics
- [x] P4 semantic map cache + projection + UI
- [x] Final E2E: Docker rebuild, redeploy, browser check, real-provider pass (browser walk DONE 2026-10-14)
