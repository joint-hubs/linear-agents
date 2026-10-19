# Delivery Plan — FOC-791 Dashboard v2 Team: agent architecture as line-ups

Linear: **FOC-791** (M8 Fenix 1.0.0, parent FOC-768, due 11-03). Spec: `docs/ui/dashboard-v2-spec.md` §4.3 (three
scopes, decision 2026-10-11). Written 2026-10-18 by the delivery owner under the 2026-10-15 autonomy rule — every
default below is reversible in review. FOC-761 is Done, so the "lower bound" label the ticket mentions is not needed;
the payload names its ground truth instead.

## 0. Why

The v1 Manager board is a tactical editor. The Team screen is the high-level picture: who delegates to whom, how
often, at what cost — You → Supervisor → four leads → each lead's line-up and bench — in three scopes (overall,
group by filters, one ticket live), fed by the same per-message priced telemetry as the cost screens.

## 1. Facts from the tree (`main` a4af4c0)

- Per-message priced usage: `canonical_usage` view (`scripts/telemetry-store.mjs`, `CANONICAL_USAGE_SQL`) — columns
  `run_id, session_id, agent_key, model, observed_at, tokens…, squad (from runs), fit_rank`; `scripts/
  delegation-outcomes.mjs` already turns it into turns with `loadUsageTurns(db)` (costUsd per turn, squad, agentKey,
  runId, sessionId?, model, observedAt), maps runs to tasks with `loadPrimaryTaskLinks` / `indexLinksByRun` /
  `taskIdForTurn`, and normalises with `normalizeRole`, `isNoiseAgent`, `isNoiseModel`, `normaliseModel`
  (`usageByRoleModel` is the weekly aggregate the CSV export uses). These are module-private today — slice A exports
  them (additive).
- Lead model per squad: `resolveSquadLead` through `readSquadConfig` (`scripts/squad-config.mjs`); roles per squad:
  `agents/<squad>/agents/*.md` (`readAgentConfigs`).
- Ticket metadata for the group scope: `scripts/work-routes.mjs` `collectTicketFacts` (cached) + `fetchLinearStates`
  (batched, 60 s cache) carry `milestone` and `labels` (names) per ticket; the repository comes from
  `config/projects.json` by the task-key prefix (`repoRefName`). Epic (parent) and size (estimate) are NOT in the
  cached state today.
- Live children per ticket: the Supervisor registry (`children.json` per run, `taskId`, `status`, `pid`) read by
  `collectChildren` in `scripts/cockpit.mjs`; run → ticket also via `triage.json.issue`.
- Routes mount in `scripts/telemetry-server.mjs` as `if (await handleXRoute(req, res, url, ctx)) return;` with
  `ctx = { json, log, … , linearQueue }`; route tests spawn the real server with `spawnTestServer` against a temp
  `LA_TELEMETRY_DB` (see `scripts/rewards-routes.test.mjs`, `scripts/runtime-statistics-routes.test.mjs`).
- UI: routes in `ui/src/App.jsx` (`/team` currently redirects to `/manager`), nav groups in `ui/src/navAreas.js`
  ("Manager (v1)" page), API client `ui/src/api.js`, polling hook `usePoll`, pure models beside screens
  (`cockpitModel.js`, `workModel.js`) with `ui/src/_tests_*.mjs` node tests; Work ticket detail is
  `ui/src/components/work/TicketPanel.jsx`.

## 2. The contract — `GET /api/team`

Query: `scope=overall|group|ticket` (default overall), `period=7d|30d|90d|all` (default 30d; ignored for ticket),
group filters `repo`, `milestone`, `type` (label name), `epic`, `size` (the last two only when the Linear state
carries them — otherwise listed as unsupported, never silently ignored), `ticket=<display id>` for the ticket scope.

```json
{
  "scope": "overall", "period": { "from": "…", "to": "…", "days": 30 },
  "filters": { "applied": {}, "supported": ["repo", "milestone", "type"], "unsupported": ["epic", "size"] },
  "groundTruth": "per-message priced usage (FOC-760/761)", "generatedAt": "…",
  "totals": { "costUsd": 0, "sessions": 0, "tasks": 0, "runs": 0 },
  "supervisor": { "model": "…", "costUsd": 0 },
  "squads": [
    { "key": "dev", "ran": true,
      "lead": { "model": "…", "costUsd": 0, "costShare": 0.77 },
      "costUsd": 0, "picks": 0, "sessions": 0,
      "roles": [
        { "role": "implementer", "model": "…", "picks": 0, "pickShare": 0.5, "costUsd": 0, "costShare": 0.3,
          "placement": "lineup", "overallPickShare": 0.5 }
      ],
      "insight": "implementer is 50 % of picks; general-purpose is 4 % of picks but 31 % of cost",
      "children": [ { "childId": "dev-1", "status": "running", "runId": "…" } ],
      "links": { "prompts": "/prompts?squad=dev", "tools": "/settings/agent-tools", "models": "/squad-config?squad=dev" } }
  ],
  "ticket": { "id": "FOC-123", "runs": ["…"] }
}
```

Definitions (D1): a **pick** = one distinct subagent session (`session_id`) of a non-lead `agent_key` inside a squad
run of the scope; the lead row (`_lead`) carries its own sessions as `picks` for the table but is excluded from the
pick shares; `pickShare = picks / squad picks`, `costShare = costUsd / squad costUsd`; `placement = lineup` when
`pickShare >= 0.05`, else `bench`; `lead.costShare = lead cost / squad cost`; `overallPickShare` is present only in the
group and ticket scopes (the same role's share in the overall scope for the same period). The insight line is
deterministic: the top pick, then the first role whose `costShare > 2 × pickShare` ("rare but expensive"), then the
lead share when it exceeds 0.5. `ran=false` squads (no run in scope) keep their roles list from the squad config
with zeros. `children` only in the ticket scope: the registry children for that ticket, newest run first.

## 3. Slices

| Slice | Deliverable | Own files |
|---|---|---|
| A — model + route | `scripts/team-model.mjs` (pure: `buildTeam({ turns, links, squadConfig, period, scope, filters, registryChildren, ticketFacts })` → the contract above), `scripts/team-routes.mjs` (`handleTeamRoute(req, res, url, ctx)`: parses/validates the query → 400 on a bad scope/period/ticket shape; reads the telemetry DB read-only; 503 when the store is unreadable), mount in `telemetry-server.mjs`; export the five helpers from `delegation-outcomes.mjs`; `scripts/team-model.test.mjs` (fixture turns → every number in the contract, AC1 by recomputing with a direct SQL query over the same fixture DB through `canonical_usage`) and `scripts/team-routes.test.mjs` (spawned server, 200 shape, 400s, 503, ticket scope with registry children); lanes + checklist counts. | the new files, `delegation-outcomes.mjs` (exports only), `telemetry-server.mjs` (one mount line), `test-lanes.json`, `docs/supervisor-e2e-checklist.md` |
| B — UI | `ui/src/teamModel.js` (pure: diagram rows from the payload, line-up/bench split, share-bar widths, insight, scope/period/filter query state ↔ URL), `ui/src/_tests_team.mjs`, `ui/src/screens/Team.jsx` + `ui/src/screens/team.css` (scope switch Overall / Group / Ticket, period select, filters in Group, ticket picker in Ticket with 5 s poll via `usePoll`, the diagram You → Supervisor → four leads → line-up cards with share bars + bench card, squads not run greyed, line-up detail tabs per squad with the roles table, the insight line and the three Settings links), `getTeam(params, signal)` in `api.js`, `/team` route replacing the redirect, nav entry "Team" next to "Manager (v1)". Built against a fixture payload until A lands; no network in tests. | the new files, `api.js`, `App.jsx`, `navAreas.js` |
| C — Work ticket block | `TicketPanel.jsx`: compact "Team on this ticket" (per squad: ran / lead model / cost / top pick) from `getTeam({ scope: "ticket", ticket })`, link to `/team?scope=ticket&ticket=…`; test in `ui/src/_tests_work.mjs` or a new `_tests_ticketTeam.mjs`. | `TicketPanel.jsx`, `workModel.js` (helper), the test |
| D — docs + acceptance | `docs/ui/dashboard-v2-spec.md` §4.3 status line; `docs/QUICKSTART.md` one paragraph under the dashboard section; browser check on the offline acceptance instance (fixture telemetry store seeded by `scripts/team-model.test.mjs`'s fixture builder exported as `seedTeamFixture(dbPath)`), screenshots in the PR. | docs; the delivery owner |

Out of scope: changing which roles a lead may pick (prompt work); a server push for the ticket scope (poll is enough);
epic/size filters until the Linear state carries them (listed as unsupported).

## 4. Order and workers

A and B in parallel (Flash, ≤ 20 min each, own files only, no git; B uses the contract above with a fixture payload);
then C (Flash) on top of B; Flash review of A (numbers, SQL read-only, 400/503) and of B+C (no network in tests,
poll stops when the tab is hidden, URL state); the delivery owner integrates, runs the affected suites + UI tests,
browser-checks the three scopes on the acceptance instance, full Windows suite, one PR.

## 5. Acceptance (ticket AC mapped)

1. AC1 numbers match a direct telemetry query on the same window — `team-model.test.mjs` recomputes picks, cost and
   shares with raw SQL over `canonical_usage` on the fixture DB and compares to the route payload byte for byte.
2. AC2 (lower bound label) — superseded: FOC-761 Done; the payload carries `groundTruth`.
3. Three scopes visible and working in the browser; Work ticket detail shows "Team on this ticket".

## 6. Follow-up — FOC-914 (2026-10-19): the four Linear-backed group filters

Milestone, type (label name), epic (the parent issue's identifier) and size (estimate) now narrow the
group scope. Facts come from the Work board's Linear states seam: `fetchLinearStates` (work-board.mjs)
asks `parent { identifier }` and `estimate` alongside the fields it already fetched and carries them in
each state; work-routes' `linearStatesFor` (the TEST-ONLY fake-file seam + the 60 s cache in
production) passes them through; team-routes enriches the offline `ticketFacts` with the four fields
for the group scope and reports availability to the model (`linearAvailable`, `linearError`).

Contract deltas (team-model.mjs, `filters` object):
- `supported` lists a Linear-backed filter only when the lookup ANSWERED and at least one fact carries
  the field — `repo` unchanged (offline-derived, `repoFilterAvailable`).
- `unsupported` lists the rest, and `unsupportedReason` (new, null when nothing is owed) carries WHY:
  `Linear unavailable: <error>` — the UI's inputs stay disabled with the reason visible, never a
  silent ignore, never a guess.
- A value passed for an unsupported filter narrows NOTHING (the pre-914 contract kept); an unknown
  value for a supported filter is an honest empty result. `type` matches a label NAME
  (case-insensitive; a ticket may carry several), `size` matches the estimate's string form
  (the URL carries strings, Linear numbers), milestone/epic by exact string.

Tests: team-routes.test.mjs spawns the server against the fake fixture file (per-issue facts distinct
per ticket) and proves each filter narrows the turns, combines (AND), degrades offline (in-process,
failed lookup seam → unsupported + reason, passed value not applied); team-model.test.mjs keeps the
fixture contract (facts without the four fields stay unsupported). Out of scope held: pick/cost
definitions (D1) untouched, no new filters.
