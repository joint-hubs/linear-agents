# Fenix Manager — tactical team interface and progression

## Context

The user wants to move from an observability dashboard to managing agent squads with interaction logic inspired by Football Manager, not its exact visual design. Confirmed choices: **tactical board** as the main screen; **progression plus manager ratings** as the reward system. Deliver a useful frontend on existing infrastructure, not a decorative simulation or wholesale backend rewrite.

This is a new feature, not acceptance of FOC-217. Preserve its unresolved verification work and all unrelated dirty files. Keep the supervisor's one-live-operational-child policy, human gates, exact approved squad models, and separate push/cleanup approvals. Approval of this design does not answer future operational triage/gates.

## Evidence and limits

Source inspected:
- `ui/src/App.jsx`: React Router with Live, Timeline, Runs, Costs, Tasks, Flow, SquadConfig and Prompts screens. Additive `/manager` route is feasible; retain existing routes.
- `ui/package.json`: React 18, Router 6, Vite 5; no graph/game framework. Existing `npm test` only executes `src/_test_utils.mjs` and is not browser coverage.
- `ui/src/api.js`: `getSquadConfig` / `postSquadConfig` (preview/apply), `getPromptRole`, `getPromptLead`, `getPromptFile` / `postPromptFile` (dry run), `getRuns`, `getRun`, `getFlowLog`, `getDelegationOutcomes`.
- `ui/src/screens/SquadConfig.jsx`: editable model/tool assignments, working-copy state, dry-run preview, explicit apply; changes are intended for subsequent launches.
- `scripts/squad-config.mjs:321`: `readSquadConfig` supplies squads, lead/provider, roles, provider catalogue and pricing. These files configure the orchestration installation, not each task repository independently.
- `scripts/telemetry-server.mjs`: central-store run reads, prompt/config write guards, and legacy aggregate Flow. Do not treat aggregate Flow as a per-run live event source.
- `config/graph.json`: authoritative squad topology, not subagent execution order. No manager graph/gate HTTP route or reward feature was found in the inspected server/client paths; add only narrowly scoped adapters where needed.
- `ui/vite.config.js`: dev UI port 5173 proxies `/api` to port 7331.

Read-only runtime probe in this session: `/api/telemetry/health` and `/api/squad-config` returned HTTP 200. Configuration lists six squads and actual role names. `/api/runs` exceeded a 5-second client timeout. This is evidence of reachable services, not a complete backend acceptance test. Do not claim live performance or writes verified yet.

The auxiliary exploration failed before returning a report; no findings from it are assumed. Do not automatically retry operational failures or substitute models.

## Product model

- Squad = team; role = position; model = current assignment; prompt/tools = instructions and capabilities; run = one execution.
- Stable role identity: orchestration installation + squad + role key. Runtime evidence additionally names task repo, task, run, actual model, and prompt/config revision where available.
- Repository filtering controls observed activity, NOT the scope of global configuration edits. Show this explicitly in the editor.
- Do not invent persistent individual-agent identities or infer role identity from a shared model name. Unattributed activity stays at squad level.
- XP records verified experience; it does not claim that model weights improved. No invented skill ratings, morale, or causal model rankings.

## Recommended experience

Desktop-first, dense but readable manager layout: graphite surfaces, restrained field/grid treatment, strong typography, compact role cards and a contextual inspector. Use existing theme tokens and scoped manager CSS; no external game artwork or new game engine.

1. Header: squad selector; `Setup / Live` switch; active repo/task/run in Live; freshness and connectivity; unsaved-change indicator.
2. Left rail: squads and compact roster. Supervisor is the coordinator, not an invented football position; show its empty role list honestly.
3. Center: tactical board for the selected squad. Cards show role, configured model, tools summary, and explicit state. Provide an accessible roster/table alternative.
4. Right inspector: `Profile`, `Instructions`, `History`, `Achievements`. Separate configured model from observed runtime model.
5. Post-task report: independent verification outcome, reward explanation, manager rating, and evidence links.

Board positions are presentation preferences only. Repositioning a card must not change routing, concurrency, membership, permissions or stage order. Use pointer drag with a keyboard move/reset alternative; persist versioned layout preferences locally, keyed by installation and squad. Explain this distinction visibly. Initial positions group leader and specialists; do not fabricate execution edges between roles.

Model assignment uses the provider's existing catalogue and current role bindings. A visual assignment interaction stages the same configuration change as the inspector; it never silently starts work. Reuse current editor logic rather than maintain a second writer. Prompt changes preserve their existing guarded file-edit flow. No combined atomic save is claimed across independent prompt/config endpoints; each save has its own preview and success/failure state.

Motion communicates observed activity only: selected cards, newly observed state transitions, and confirmed handoffs. No looping fake agent movement. Respect reduced motion; encode status with label/icon as well as color. No new execution, stop, push or gate-answer buttons in the first release. Existing `/api/launch` opens standalone terminals and must not be presented as supervised orchestration.

## Delivery slices

### 0. Product/design specification before application code
- Write `docs/ui/fenix-manager.md` with this product model, annotated layouts, empty/error/stale states, interaction contracts and acceptance criteria.
- Write `docs/ui/fenix-manager-rewards.md` defining reward attribution, evidence, rating rubric and persistence. Mark proposed XP constants as product rules, not measured performance.
- Present the first navigable visual increment for review before expanding functionality. Demo fixtures, if used, must be clearly labelled and unable to write production configuration.
- Reconcile a new feature issue with existing Fenix backlog before creating duplicates; publication and squad triage follow the supervisor workflow.

### 1. Functional tactical board and configuration
- Add `/manager` and navigation, preserving the old dashboard as advanced tools.
- Load actual squads/roles/config; selectable cards, layout preferences and inspector.
- Reuse/extract configuration working-copy, preview, apply and validation logic from SquadConfig; preserve its route and behavior.
- Reuse prompt context/file-edit components (`PromptContext`, RoleLeaf/SquadLeaf paths after targeted inspection); protect unsaved edits and show explicit save scope and next-launch semantics.
- No automatic model changes during implementation: fixtures and dry-run first; real save smoke tests require an isolated config root or explicit approval.
- Keep rewards visibly unavailable/pending until persisted evidence support exists, not fake zero-valued achievement records.

### 2. Trustworthy live overlay
- Diagnose `/api/runs` timeout using bounded read-only measurements before selecting polling strategy. A timeout does not authorize rewriting ingestion.
- Create a pure adapter between telemetry responses and board state, using explicit run/task/repo/role identifiers. Document missing fields rather than guess.
- Bounded polling with cancellation, no overlapping requests, pause/backoff on failure or hidden tab, and visible last-success time. No per-card transcript polling.
- State distinctions: idle, running, waiting for decision (only authoritative evidence), failed, process finished/unverified, independently accepted, unknown/stale.
- Unknown cost remains unknown. Process exit 0 is not verified delivery. On lost connectivity keep last-known data with stale warning and stop apparent live movement.
- If existing responses cannot provide bounded per-run role activity, add a small read-only manager snapshot endpoint in `scripts/telemetry-server.mjs` backed by existing store/status readers, with allowlisted fields and isolation tests. No raw-log scanning or side-effecting status CLI from each HTTP request.
- Gate visibility may be added through a sanitized read-only adapter; actual answers continue through Supervisor. No inferred or redacted question presented as verbatim.

### 3. Progression and manager ratings
- Add a dedicated local durable reward ledger, not localStorage and not edits to raw telemetry. Prefer a separate SQLite module/database under the existing application-data directory, overridable for tests. Confirm location against existing storage conventions before implementation and document it.
- Record evidence IDs, task/repo, subject role/squad, run, actual model, prompt/config revision (or explicit unknown), rule version, timestamp, points, and provenance.
- Proposed first rule: 100 squad XP for one independently TEST-accepted task revision. Repeated polls, retries, REVIEW passes and runs do not multiply it. A provisional level curve can be 500 XP per level; both values must be versioned and visible.
- Agent profiles show participation in accepted work only when evidence links their role; do not distribute team XP as proof of each role's quality. Unattributed evidence cannot earn individual credit.
- Initial badges: first verified delivery; five distinct verified deliveries. No bonus for tokens, tool calls, raw speed, zero escalations or avoiding questions.
- Manager rating: 1–5 plus explanatory note and optional distinction, tied to a specific task/run and subject. Separate subjective ratings from independent verdicts; allow ratings of unsuccessful work without turning it into a pass. No rating means unknown, not zero.
- Record corrections/revocations as history with transactional deduplication (stable evidence/task-revision/rule keys). Reopening a task or invalidating acceptance updates active XP without erasing the audit trail. Rating edits supersede prior entries; no repeated XP from editing.
- Only ingestion of validated acceptance evidence can generate automatic XP. The browser cannot submit arbitrary XP or claim TEST passed. If current acceptance artefacts cannot prove the relation, show `awaiting verified evidence`; no backfill by interpreting success-shaped log text.
- Ratings endpoint accepts only bounded schema and valid referenced entities; loopback/origin/JSON-body limits follow existing server protections. Render user notes as text. No secrets or entire prompts in reward records.
- XP never unlocks tools, autonomy, spending or automatic promotion. No RL/FT in this scope.

## Files and reuse

Expected existing changes: `ui/src/App.jsx`, `ui/src/api.js`, `ui/src/screens/SquadConfig.jsx` only for deliberate extraction, `scripts/telemetry-server.mjs` only for necessary bounded endpoints. Preserve unrelated edits, especially server/telemetry changes already in the working tree.

Expected new modules: `ui/src/screens/Manager.jsx`, `ui/src/components/manager/*`, scoped manager stylesheet, pure manager state/identity adapters and tests; `scripts/manager-rewards.mjs` and tests for slice 3. Reuse `Modal`, `StatusBadge`, cost formatting, provider catalogue, prompt editors and existing backend validation after checking their exact contracts.

Shared-symbol impact: SquadConfig serves the old route; API clients serve multiple screens; readSquadConfig has seven callers and several regression suites. Before extracting or changing shared behavior run CodeGraph impact and report reach. Prefer additive components and adapters; do not rewrite the shared server or telemetry store for this feature.

## Verification and acceptance

- Tests for identity mapping, repo/run filtering, unknown role/model, layout persistence/schema migration, staged assignments, failed previews/applies and unsaved edits.
- Telemetry fixtures: running, gate, crash, exit-0-unverified, accepted, stale, disconnected, missing price and ambiguous attribution. Test that stale/unknown states never animate or award XP as current success.
- Rewards tests: duplicate replay, concurrent insertion, cross-repo task-ID collisions, changed model/prompt, missing evidence, invalid role, reopened task, revocation, rating amendment and server restart persistence.
- API security tests: non-loopback/disallowed origin, malformed or oversized JSON, invalid reference, injected notes; fixture storage only.
- Run `npm --prefix ui test`, explicit new test scripts (wire them into test discovery), and `npm --prefix ui run build`. Run impacted squad-config/prompt/server suites; no claim that current UI unit tests cover interactions.
- Start/inspect through the project's delivery workflow: backend `node scripts/telemetry-server.mjs`, UI `npm --prefix ui run dev`, reusing an existing service instead of competing for its port. Browser-test with an available browser harness; if unavailable, report visual verification as pending rather than claim success from curl.
- Visually inspect 1440px and 1024px layouts plus narrow-screen roster fallback; keyboard navigation, card movement, modal focus, reduced motion, loading/error states and text overflow. Validate categorical/status palette using the dataviz validator before shipping.
- End-to-end: select real squad → inspect role → stage model/prompt change → preview → cancel unchanged; verify apply/reread in an isolated installation. Live fixture/current run highlights only supported activity. Persist rating → restart → retained; replay acceptance → no duplicate XP.
- Update `docs/STATE.md` at slice handoffs, and `docs/ACCESS.md` only for changed URLs/ports/access. Deliver REVIEW/TEST evidence, user test steps, and scoped commit batches; do not mark FOC-217 Done incidentally.

## Deferred

Arbitrary role creation/movement between squads, editable executable graph, 3D office, model hot-swapping, autonomous selection based on ratings, a model marketplace, leaderboards claiming causal quality, automated HITL answers, push/cleanup from the board, and full historic reward backfill.
