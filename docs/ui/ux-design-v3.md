---
type: ux-spec
status: approved-pending
audience: frontend engineer (GLM) — build EXACTLY this
tags: [type/spec, area/ui, topic/observability, topic/ux]
created: 2026-07-02
maturity: v3
supersedes: ux-design.md (v2 control-panel — kept for later phases), ux-improvements.md
plan: observability-platform-plan.md
mockup: mockups/observability-v3.html
---

# Observability Dashboard — UX Design v3 (build spec)

**This document is the build contract.** It extends the EXISTING scaffold in `ui/`
(Vite + React + react-router, commit `e849ff0`). Do not rewrite the scaffold —
extend it. Keep `theme.css` as the visual base. Functionality > beauty.

Priorities (from Mateusz):
1. **Agent monitoring** — one panel that answers "which agent works on which task right now".
2. **One Gantt timeline** of agent activity (gantt-pisi style).
3. **Cost measurement** per task / squad / model / agent.
4. **Multi-repo**: agents run from different repos (`cwd` in manifest) — repo must be a visible dimension.
5. Linear is the task system — every task ID links out to Linear.

## 0. What already exists (do not rebuild)

| Layer | State |
|---|---|
| API `:7331` | `/api/runs`, `/api/runs/:id`, `/api/summary` (totals·bySquad·byModel·byDay·**byTask**), `/api/cost-per-task`, `/api/live` — all working, CORS on |
| Data | 22+ real manifests in `.state/runs/`; ledger computes cost per model/agent/task from transcripts |
| UI | `ui/src`: App shell + tabs, screens `Live`, `Runs`, `RunDetail`, `Costs`, `theme.css`, `utils.js`, `api.js` |

v3 = **1 new screen (Timeline) + upgrades to the 4 existing screens + 1 small backend change (B1)**.

## 1. Information architecture

```
Top nav:  [ Live ]  [ Timeline ]  [ Runs ]  [ Costs ]          ● api:7331
             │           │            │          │
   "now"  ───┘           │            │          └── "where does money go"
   "when" ───────────────┘            └── "what exactly happened" (+ /runs/:id)
```

- 4 tabs, no more. Budget lives inside Costs (P2). Linear-collab inbox is a future 5th tab (out of scope).
- Global header right side: API health dot (green = last fetch ok, red = failed, click = retry)
  and `updated HH:MM:SS`.
- Routes: `/` (Live), `/timeline`, `/runs`, `/runs/:id`, `/costs`. Filters via URL query
  (`/runs?task=PISI-98&squad=dev&status=failed`) so screens can deep-link each other.

## 2. User journeys (design drivers)

- **J1 „co się teraz dzieje"** — open app → Live: active agents, today's cost, alerts. 0 clicks.
- **J2 „ile kosztował PISI-98"** — Costs → *By task* row `PISI-98` → click → `/runs?task=PISI-98` → run drilldown.
- **J3 „coś się wywaliło / dziwny koszt"** — Live alert or Runs filter `status=failed` → RunDetail:
  exit code, per-agent/per-model breakdown, transcript path, `ambiguous` warning.
- **J4 „co się działo w tym tygodniu"** — Timeline, Week zoom: bars per task per squad, gaps and overlaps visible.
- **J5 „czy agent utknął"** — Live: `stale` badge on runs started >2 h ago without end → operator decides.

Every journey must be walkable in the mockup (`docs/ui/mockups/observability-v3.html`).

## 3. Screens

### 3.1 Live (home) — agent monitor

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ACTIVE 2      COST TODAY $4.12      TOKENS TODAY 1.4M      ⚠ ATTENTION 1     │  KPI strip
├──────────────────────────────────────────────────────────────────────────────┤
│ ACTIVE RUNS                                                                   │
│ ┌───────────────────────────────────┐ ┌───────────────────────────────────┐  │
│ │ ● DEV        PISI-98 ↗   [pisi]   │ │ ● REVIEW     FEN-11 ↗   [jointhubs]│  │  card per
│ │ repo: office   branch: feat/sim   │ │ repo: linear-agents                │  │  active run
│ │ glm-5.2 82% ▏minimax 18%          │ │ deepseek-v4 100%                   │  │
│ │ elapsed 14m 32s   cost …          │ │ elapsed 3m 05s    cost …           │  │
│ └───────────────────────────────────┘ └───────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────────────────┤
│ RECENTLY FINISHED (last 10)                                                   │
│ 12:03  dev     PISI-98 ↗  office         16m   $1.84   done                   │
│ 11:40  plan    FEN-12 ↗   linear-agents  22m   $3.10   done  ⚠ ambiguous      │
│ 10:15  test    FEN-11 ↗   linear-agents   9m   $0.44   failed (exit 1)        │
├──────────────────────────────────────────────────────────────────────────────┤
│ ⚠ NEEDS ATTENTION                                                             │
│ • run 2026-07-02T11-40 transcript match ambiguous → verify cost   [open]      │
│ • run 2026-07-01T09-12 running > 2 h — stale?                     [open]      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Data**: single `getRuns()` poll every **5 s** (replaces `/api/live` polling — one request
gives actives, recents, today totals; 22–200 runs is trivial to derive client-side).

Derivations (put in `utils.js`):
- `active` = `endedAt == null`
- `today cost/tokens` = sum over runs with `startedAt` on local today
- `stale` = active && `startedAt` > 2 h ago
- `status` = `running` (endedAt null) | `failed` (exitCode ≥ 1) | `done`
- attention list = runs with `ambiguous` (last 24 h) + stale runs

Rules:
- Active run cost while running is usually 0 (transcript discovered at run end) →
  display **`…`** with tooltip "cost appears after the run ends", never `$0.00`.
- Task ID chip = link to Linear (see §5 URL mapping) with `↗`; repo chip filters Runs on click.
- Empty active state: `No agents running. Start one: bin\dev.bat` (monospace hint).
- KPI "ATTENTION" card turns amber when count > 0.

### 3.2 Timeline — the Gantt (NEW screen)

One gantt of **agent activity**: rows = tasks, bars = runs. This is actuals-only
(Linear planned-vs-actual overlay is a later phase).

```
        [ Day | 3d | Week ]   ◀ ▶        squads: ☑plan ☑dev ☑review ☑test ☑cadence
────────┬──────────────────────────────────────────────────────────────────────
        │ Mon 30        Tue 1          Wed 2 ┊now                              
PISI-98 │        ▓▓▓▓▓▓▓plan    ▓▓▓▓▓▓▓▓▓▓dev   ▓▓rev  ▶▶dev(live)             
$6.20 ↗ │                                                                      
office  │                                                                      
────────┼──────────────────────────────────────────────────────────────────────
FEN-11  │  ▓▓plan   ▓▓▓▓dev  ▓rev ▓test                                        
$3.90 ↗ │                                                                      
────────┼──────────────────────────────────────────────────────────────────────
(untag) │      ▓▓          ▓▓▓                                                 
────────┴──────────────────────────────────────────────────────────────────────
         legend: ▓ plan ▓ dev ▓ review ▓ test ▓ cadence   ▶▶ running   ⚠ failed
```

Spec:
- **Rows**: group `/api/runs` by `taskId`; `null` → single `(untagged)` row at the bottom.
  Row label: task ID (Linear link ↗) + total cost + repo chip(s). Sort: most recent activity first.
- **Bars**: one per run, `startedAt → endedAt` (running → now, animated pulse). Color by squad —
  fixed palette: plan `#5e5ce6`, dev `#0071e3`, review `#ff9500`, test `#34c759`, cadence `#6e6e73`.
  Failed run: same color + red left edge + `⚠` on hover. Min visual width 4 px.
- **X axis**: zoom presets Day (24 h) / 3 days / Week; pan with ◀ ▶ buttons; red vertical **now** line;
  on load auto-position window to end at *now*.
- **Tooltip** (hover): runId · squad · duration · cost · top model · status. **Click → `/runs/:id`.**
- Squad checkboxes filter bars client-side. Refresh with the same 5 s poll (cheap).
- **Implementation**: no gantt library — absolutely-positioned divs on a time-scaled track
  (`left/width = f(t)`), ~200 lines. See mockup for the reference implementation.

### 3.3 Runs (upgrade) + RunDetail (upgrade)

Runs — add a filter row and 3 columns to the existing table:

```
[search…]  squad ▾  status ▾  repo ▾  task ▾   ☐ only ambiguous          22 runs
Started      Squad   Task      Repo           Dur    Cost    Tokens  Models        St
06-30 10:12  dev     PISI-98↗  linear-agents  16m    $1.84   412k    glm-5.2 (+2)  done
```

- All filters client-side; reflected in URL query (`useSearchParams`) — **Costs and Live link here**.
- Status adds `failed` (red badge) — requires B1 `exitCode`.
- Row click → RunDetail (unchanged behavior).

RunDetail — keep KPI + byModel + byAgent tables; add:
1. **Meta grid** under the header: repo · branch · started → ended (duration) · exit code ·
   provider (`native` ? "anthropic-sub" : "openrouter") · config dir · source.
2. **Transcript path** row with a copy 📋 button (monospace, truncated middle).
3. **Ambiguous banner** (amber, above KPIs) when `ambiguous`:
   *"Transcript match was ambiguous — cost may belong to another session. Verify: `<transcriptPath>`"*.
4. byModel/byAgent tables: add `in / out / cache` token columns (data already in the payload).
5. Header task ID links to Linear; button `View all runs of this task` → `/runs?task=X`.

### 3.4 Costs (upgrade)

Keep: KPI strip, bySquad / byModel / byDay bars, byTask table. Add:

1. **Period toggle** `7d | 30d | All` (client-side filter on `byDay` keys + recompute
   from `/api/runs` for the KPI strip; summary endpoint stays untouched).
2. **By agent** section (NEW): sum `run.byAgent` across (period-filtered) runs client-side —
   bar list like bySquad. Answers "który subagent ile pali". Zero backend.
3. **By task table**: add columns `Squads` (chips from `byTask[x].squads`), `Span`
   (`firstStartedAt → lastEndedAt`, relative), Linear ↗; **row click → `/runs?task=X`**.
4. Footer note: *"Costs computed from transcripts × config/models.json pricing.
   Cross-check billed $: `node scripts/cost-report.mjs` (OpenRouter Activity)."*
5. *(P2, after B2)* **Budget panel**: per-task budget bar vs `COST_BUDGET_USD_PER_TASK`,
   over-budget list from `.state/over-budget.json`.

## 4. Backend changes

### B1 — expose manifest fields in `aggregateRun()` (required for v3, ~15 lines)
`scripts/ledger.mjs` `aggregateRun()` result: add pass-through fields from the manifest:
`cwd`, `repo` (= last path segment of `cwd`), `gitBranch`, `exitCode`, `native`,
`sessionId`, `transcriptPath`, `claudeConfigDir`, and extend `status`:
`"failed"` when `endedAt && exitCode >= 1` (keep `"completed"` / `"running"` otherwise).
No API shape breaks — additive only. Update `--smoke` check accordingly.

### B2 — `GET /api/budget` (P2)
`{ budgetPerTaskUSD: env COST_BUDGET_USD_PER_TASK|null, overBudget: <.state/over-budget.json>|[],
tasksOverBudget: [taskId…] derived from aggregateByTask }`.

### B3 — live step feed (P3, not now)
Tail active transcript → `{ lastModel, lastTool, lastTs }` per active run ("what the agent does NOW").

Already exists — **do not rebuild**: `byTask` in `/api/summary`, `/api/cost-per-task`, CORS, `--smoke`.

## 5. Cross-cutting rules

- **Linear links**: prefix map in `ui/src/config.js`:
  `{ PISI: "https://linear.app/pisi/issue/", FEN: "https://linear.app/jointhubs/issue/" }` —
  task chip renders `↗` link when prefix known, plain text otherwise.
- **API-down state**: full-page card (not a table error): *"Telemetry server unreachable —
  start it: `node scripts/telemetry-server.mjs`"* + auto-retry countdown 5 s. Header dot red.
- **Ambiguous is loud**: amber badge in every list + banner in detail. Never hide it.
- **No secrets**: UI reads only `:7331`; never render env values.
- **Formatting**: reuse `utils.js` helpers (`fmtUSD`, `fmtTokens`, `elapsed`…); `$` 2 decimals
  under $10, 0 decimals above; tokens `412k / 1.4M`.
- **Visual**: keep `theme.css` (Apple-light). New CSS only for: run cards, timeline track/bars,
  filter row, banner. No UI libraries, no charts libs — bars are divs.
- **Language**: UI labels English.

## 6. Build order (one PR per step, each independently shippable)

| Step | Scope | Acceptance criteria |
|---|---|---|
| **F1** | B1 + Live rework (§3.1) + status `failed` | With server running and 22 real manifests: Live shows KPI, active cards ("…" cost while running), recent-10 with repo column, attention list; failed run shows red badge. `node scripts/telemetry-server.mjs --smoke` passes |
| **F2** | Timeline screen (§3.2) | Real runs render as bars grouped by task; zoom Day/3d/Week + pan; now-line; hover tooltip; click opens RunDetail; squad filter works |
| **F3** | Runs filters + URL params + RunDetail meta/transcript/banner + Linear links (§3.3, §5) | `/runs?task=PISI-98` pre-filters; PISI-98 chip opens linear.app/pisi; copy button copies path; ambiguous banner shows on an ambiguous manifest |
| **F4** | Costs upgrades (§3.4 pts 1–4) | Period toggle changes byDay + KPIs; By-agent section sums correctly (spot-check vs one RunDetail); byTask row click lands filtered Runs |
| **F5** *(P2)* | B2 + Budget panel | Over-budget task renders red bar + appears in Live attention |

Definition of done per step: works against **real** `.state/runs` data (not fixtures),
`npm run build` clean, screenshot in PR description, no console errors.

## 7. Out of scope for v3 (parked, with pointers)

- **Launching agents from the UI** (Tasks screen, suggested-next-squad, `/api/launch`, VM/tmux
  sessions, future meta-agent) → [control-plane-plan.md](control-plane-plan.md), phases L1–L4.
  Adds a 5th nav tab `Tasks` — do not build it as part of F1–F5.
- Linear-collab inbox / HITL write-back → plan §4.5 (P4); partially superseded by control-plane L1
  (`/api/linear/queue`); needs `linear-query/ops` bridge.
- Launch & model-routing control panel → old `ux-design.md` (v2) §3b–3f + `ux-improvements.md`.
- Live token-meter / step feed → B3 (P3). SSE/file-watch → after poll proves insufficient.
- Planned-vs-actual overlay on Timeline (Linear estimates) → after collab layer.
