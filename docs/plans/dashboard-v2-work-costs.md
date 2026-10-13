# FOC-784 + FOC-785 — Dashboard v2 Work board and Costs & quality

Date: 2026-10-13. One PR for the next two lane-O tasks (Mateusz: several tasks per PR). Spec: `docs/ui/dashboard-v2-spec.md`
§4.2 (Work), §4.4 (Costs & quality), §6 (contracts), §7–§8 (design system, staleness). Builds on FOC-804 (nav),
FOC-760/761/769 (one cost truth: `ticketCostReport`, `run_focus`, `cost-reconcile`).

## Shared decisions

* **Pattern** (as the Cockpit): logic in Node libraries, a transport-only route module, pure UI model modules with
  fixture tests (`ui/src/_tests_*.mjs`), thin JSX, panels wrapped in `PanelBoundary`, area CSS scoped per screen.
* **Cost source = `ticketCostReport`** (the same function `ticket-cost.mjs` prints), so the dashboard equals the CLI
  by construction (FOC-785 AC1). Computed OFF the request path: a child process
  (`node scripts/cost-snapshot.mjs --json`, read-only store) refreshed at most every 2 min; the routes serve the last
  snapshot with `computedAt`; older than 5 min → `stale` label (spec §8). First request before any snapshot → `computing`
  state, never a blocked event loop (FOC-547).
* **Never invented numbers**: unpriced → "unknown", missing focus → "unattributed", no transcript → "unverified"
  (spec principle 1). Every metric has a written definition in the UI (FOC-785 AC2).

## FOC-784 — Work board (`/work`, ticket detail `/work/:ticket`)

**Library `scripts/work-board.mjs`** (pure derivations + one read layer):
* Tickets Fenix touched: registries (`<stateHome>/<run>/children.json`, `triage.json`) of the last 30 days → per ticket
  the children (squad, status, turns, run, branch), verdict rounds (`roundsFor`), gates/holds, interventions (answer
  rows in `edits.jsonl`).
* **Stage** (`deriveStage`): Landed when the Linear state type is `completed` (Q2); else the squad of the latest
  child (plan / dev / review / test); Ready when no child yet. **Flags**: live child (id + status), waiting gate,
  needs-you. **Rounds** = review verdict files for the ticket (`<taskId>-round<N>`), the same count the review-loop
  guard uses.
* **Ready column**: open Linear issues not yet touched (Q1), from the existing `/api/linear/queue` fetch (60 s cache,
  graceful degrade), filters milestone / priority.
* **Cost** per ticket from the cost snapshot (children + Supervisor share, total).
* **Ticket detail**: stage timeline (child spawns and exits, verdict rounds with PASS/FAIL, gates and answers), cost
  split + reconciliation line (children's transcript truth vs telemetry for this ticket, via `priceChildTranscripts` —
  per-ticket, small), evidence links (verdict records, child tees, run detail `/runs/:id`, branch + base revision),
  actions **Start** (Ready only) and **Ask the Supervisor** (prefills the Cockpit chat).
* **Start**: `POST /api/work/tickets/:id/start` — server fetches the issue (`linear-client` `resolveIssue` + body),
  builds the hand-off text ("Start ticket FOC-123: <title>" + issue text, capped), and the UI shows it in a confirm
  dialog first; Send forwards it to the Supervisor (`/message`, same guards as the chat). Native (no session host):
  the dialog offers "Open in Cockpit" with the text prefilled (today's FOC-804 path). The Supervisor never picks
  tickets on its own (D2).
* Out of scope: Push / Open PR (FOC-788), editing Linear issues.

## FOC-785 — Costs & quality (`/costs`)

**Library `scripts/cost-quality.mjs`** over the cost snapshot + registries + verdicts + edits:
* Period toggle 7d / 30d / All (`since` bound on `ticketCostReport`).
* KPI tiles: children cost per ticket **p50 with p20–p80 band** (nearest-rank, tickets with children cost > 0), all-in
  average per ticket, total spend, Supervisor share; **attribution banner** while Supervisor attributed share < 80 %.
* Spend by day: children vs Supervisor (stacked), model mix (per model $ and share) — `ticketCostReport` gains
  `byDay` and `byModel` (additive fields).
* Quality signals, each with its written definition:
  * **First-time-right** = share of tickets whose round-1 review verdict is PASS (rule of `delegation-outcomes.mjs`).
  * **Rework share of cost** = children cost of turns ≥ 2 / children cost; a turn's window comes from the registry
    `turns[]` of the child (usage `observed_at` ≥ turn 2's `startedAt`).
  * **Human interventions per ticket** = gate / hold / ask answers recorded for the ticket (`edits.jsonl` answer rows).
  * **Landing yield** = landed tickets / tickets with at least one dev child in the period.
* Most expensive tickets with "why": the first matching rule — rounds ≥ 3, rework share ≥ 50 %, interventions ≥ 3,
  Supervisor share ≥ 50 %, else "unexplained".
* Each number links to its evidence (ticket detail, run detail).

## Decisions (Mateusz, 2026-10-13)

* **Q1 Ready** = open Linear issues not yet touched by Fenix (the `/api/linear/queue` fetch), filters milestone /
  priority. Touched tickets sit in the later columns.
* **Q2 Landed** = the Linear issue's state type is `completed` (Done). Linear states of touched tickets come from one
  batched GraphQL lookup (aliases `issue(id: "FOC-123")`), cached 60 s like the queue; Linear down → stage from Fenix
  data only, with a "Linear unavailable" label.

## Contracts

**TicketFacts** — `collectTicketFacts({ stateHome, days = 30, now })` in `scripts/work-board.mjs` (read layer):

```
{ taskId, runIds: [], firstActivityAt, lastActivityAt,
  children: [{ runId, childId, squad, status, turns: [{ startedAt, endedAt, exitCode }], telemetryRunId, branch,
               baseRevision, worktree, costUsd, costSource, startedAt, endedAt, tee }],
  rounds, verdicts: [{ round, verdict: "PASS"|"FAIL"|"UNKNOWN", at, path }],
  gates: [{ gateId, status, kind, childId, createdAt, answeredAt }],
  interventions, interventionRows: [{ at, kind: "gate-answer"|"hold-answer"|"ask-answer", path }] }
```

**CostSnapshot** — `node scripts/cost-snapshot.mjs --json [--db <path>] [--cutoffs <file>]` (read-only store; cutoffs file
= `{ "<telemetryRunId>": "<ISO start of turn 2>" }`):

```
{ computedAt, storePath,
  windows: { all: Report, "30d": Report, "7d": Report },   // Report = ticketCostReport output + byDay + byModel
  runs: { "<telemetryRunId>": { usd, reworkUsd, messages, unpricedMessages } } }
```

`ticketCostReport` gains (additive): `byDay: [{ day, childrenUsd, supervisorUsd, overheadUsd, unattributedUsd }]`,
`byModel: [{ model, usd, messages }]`.

**API payloads** (UI models are built against these):

```
GET  /api/work/tickets?milestone=&priority=
  { computedAt, cost: { computedAt, stale, state: "ok"|"computing"|"error" }, linear: { ok, error, fetchedAt },
    columns: ["ready","plan","dev","review","test","landed"],
    tickets: [{ taskId, title, url, stage, linearState: { name, type }|null, priority: { value, name }|null,
                milestone, rounds, lastVerdict, flags: [{ kind: "live"|"gate"|"needs-you"|"crashed", text, childId }],
                cost: { childrenUsd, supervisorUsd, totalUsd }|null, lastActivityAt, childCount }] }
GET  /api/work/tickets/:id
  { ticket: <as above>, issue: { identifier, title, url, description }|null,
    timeline: [{ at, kind: "spawn"|"exit"|"verdict"|"gate"|"answer", text, childId, runId }],
    cost: { childrenUsd, supervisorUsd, totalUsd,
            reconciliation: { transcriptUsd, telemetryUsd, registryUsd, ratio, note } },
    children: [<TicketFacts child + costUsd>], evidence: [{ kind: "verdict"|"tee"|"run"|"branch", label, href, path }] }
GET  /api/work/tickets/:id/start-preview  → { text, issue: { identifier, title, url }, delivery: "supervisor"|"cockpit" }
POST /api/work/tickets/:id/start { text }  → session host /message result ({ sent, confirmed, queued }) | 503 docker-only
GET  /api/costs?period=7d|30d|all
  { period, computedAt, stale, state, kpis: { childrenPerTicket: { p20, p50, p80, n }, allInAvgPerTicket, totalUsd,
    childrenUsd, supervisorUsd, supervisorShare },
    attribution: { attributedShare, overheadUsd, unattributedUsd, target: 0.8, belowTarget },
    byDay: [...], byModel: [{ model, usd, share, messages }],
    mostExpensive: [{ taskId, totalUsd, childrenUsd, supervisorUsd, why: { rule, text } }],
    unpricedMessages, legacyRows, definitions: { <metricKey>: "<text>" } }
GET  /api/quality?period=
  { period, computedAt, stale, state, tickets,
    signals: [{ key: "firstTimeRight"|"reworkShare"|"interventionsPerTicket"|"landingYield", value, numerator,
                denominator, unit: "share"|"count", definition, evidence: [taskId] }] }
```

## Routes (`scripts/work-routes.mjs`, `handleWorkRoute(req, res, url, ctx)`, registered beside the Cockpit)

`GET /api/work/tickets`, `GET /api/work/tickets/:id`, `POST /api/work/tickets/:id/start` (preview), `POST
/api/work/tickets/:id/start/confirm` (send), `GET /api/costs?period=`, `GET /api/quality?period=`. POST guards = the
Cockpit's (`writeGuards`: loopback + allowed origin).

## UI

* Nav: Work area default `/work` (new board) with Runs kept as a sub-tab (evidence target); v1 Tasks and Timeline drop
  out of the nav (Tasks is replaced by the board + Start; Timeline by the ticket timeline). Costs area: the new screen
  replaces v1 Costs (its numbers were the 5× registry cost).
* `ui/src/workModel.js` + `screens/Work.jsx` + `components/work/*`; `ui/src/costsModel.js` + `screens/CostsQuality.jsx`;
  tests `_tests_work.mjs`, `_tests_costs.mjs` (fixtures only), registered in `ui/package.json`.

## Slices (Flash workers)

* Wave 1: W1 `work-board.mjs` + tests · W2 `cost-snapshot.mjs` + `ticketCostReport` byDay/byModel + tests · W3
  `cost-quality.mjs` + tests · W4 `workModel.js` / `costsModel.js` + UI tests (against the documented payload shapes).
* Wave 2: W5 `work-routes.mjs` + server registration + route tests · W6 Work screens · W7 Costs screen + nav.
* Wave 3: docs, test registration, Flash review, integration, acceptance stack + browser.

## Verification

Unit + route + UI model tests; Windows `test-all` + Linux lane; `vite build`. Acceptance stack (fake API, real Claude
Code): a ticket goes Ready → Start (confirm) → the Supervisor receives the issue text → spawned child shows the ticket
in Dev with its live flag, rounds and cost; the Costs page equals `ticket-cost --json` for the same window; stale and
computing states seen; browser check of both areas (no console errors, no panel blanking). Read-only check of the real
Windows store: `/api/costs` vs `ticket-cost.mjs` for 30 d.
