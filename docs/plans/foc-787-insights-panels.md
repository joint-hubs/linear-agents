# Delivery Plan — FOC-787 Insights: three notebook analyses as dashboard panels

Linear: **FOC-787** (M8 Fenix 1.0.0, parent FOC-768, Low, due 11-04). Spec: `docs/ui/dashboard-v2-spec.md` §4
(Insights), existing Analysis screen PRD `docs/prd/telemetry-analysis-dashboard-prd.md`, data model
`docs/TELEMETRY-EXPLAINED.md` §9. Written 2026-10-19 by the delivery owner under the 2026-10-15 autonomy rule.

## 0. Why

The marimo notebook (Mateusz's analysis folder, `fenix_analysis.py`, blocks M1–S3) holds the analyses that
answer "what does a ticket cost, who spends the money, which tickets distort the picture". They run only in a
Python runtime on a cached parquet copy. The dashboard's Analysis screen already has the mechanics — a derived
`analysis-cache.sqlite`, filtered panels under `/api/analysis/<name>`, the filter bar with the pre/post era — so
three of those analyses become live panels with the same definitions, each stating what it measures and linking
to the evidence (the tickets behind a point).

## 1. Facts from the tree (`main` f22f861) and the notebook

- Cache (`scripts/analysis-cache.mjs`): copies `canonical_usage` and `canonical_tool_facts` (plus `runs`) into
  `analysis-cache.sqlite` with indexes; rebuilt as a child process on demand; `cache_schema_version` in
  `cache_meta` — a schema bump forces a rebuild (status `cache_building`, the UI's Refresh).
- Panels (`scripts/telemetry-analysis.mjs`): `costPanel(db, filters)`, `toolsPanel`, `handoffsPanel`,
  `qualityPanel`, `metaPanel`; `normalizeFilters(searchParams)` → `{ from, to, squad, model, era, eraBoundary }`
  (era default `post`, `ERA_BOUNDARY = 2026-09-22T00:00:00.000Z`); `filterSql(filters, cols)` builds the WHERE
  with bound params; synthetic/unpriced rules in `SYNTHETIC_SQL` / `NOT_SYNTHETIC_SQL`. Routes mount in
  `scripts/telemetry-server.mjs` (~line 1845: the `path === '/api/analysis/cost' || …` list and the
  `{ '/api/analysis/cost': costPanel, … }` map). Tests: `scripts/telemetry-analysis.test.mjs`,
  `scripts/telemetry-analysis-api.test.mjs`, `scripts/analysis-cache.test.mjs`.
- UI (`ui/src/screens/Analysis.jsx`): `TABS = [{ key, label, comp }]`, panels under
  `ui/src/screens/analysis/*Panel.jsx` using `useAnalysisPanel(name, filters, reloadKey)` →
  `{ data, caveats, echoedFilters, loading, error }`, shared `Caveats`, `PanelState`, `DataTable`
  (CSV/JSON export), charts `HBarChart`, `ColumnChart`, `StackedBar`, `Histogram`, `KpiTiles`, `ShareBar`,
  formatters `fmtUsd/fmtInt/fmtCompact/fmtPct`; tests `ui/src/_tests_analysis.mjs`.
- Task attribution (store tables `run_task_links`, `work_items`): a run can touch several tasks; the primary link
  is the newest `valid_from` ≤ the message time per run (`taskIdForTurn` in `scripts/delegation-outcomes.mjs`,
  the notebook's `assign_tasks` asof-backward merge). `SUP:` task ids are synthetic and never count as tickets.
- Notebook definitions (`fenix/tasks.py`, `fenix/outliers.py`, `fenix/stats.py`, `fenix/config.py`):
  - **Task table**: per task — `cost_usd` (direct: priced cost of plan/dev/review/test rows attributed to the
    task), `n_msgs`, `unpriced_share`, `first_ts`, `era` by `first_ts`.
  - **Supervisor overhead allocation** (`allocate_supervisor_overhead`, `max_gap_min = 30`): every supervisor
    row is `active` when a plan/dev/review/test run that is linked to ≥ 1 real task overlaps its time (cost split
    equally over those runs' tasks), `adjacent` when no child runs but one starts/ends within 30 min (the nearest
    run's tasks), `idle` otherwise (task = none). `cost_loaded = direct + sup_active + sup_adjacent`; a task
    with no direct cost keeps `cost_loaded = null`; `cost_loaded_partial` when `unpriced_share > 0`.
  - **Outliers** (`detect`): unit = task, on `log10(max(cost, 1e-4))`; detector 1 modified z-score
    `0.6745·(x − median)/MAD` with threshold `MAD_Z = 3.5`; detector 2 Tukey fences mild 1.5·IQR / far 3·IQR
    (`flag_tukey` = far); detectors 3–4 (isolation forest, MCD) need sklearn — **notebook only**; consensus
    `n_flags ≥ MIN_CONSENSUS = 2`; `direction` high/low/unpriced.
  - **Concentration** (`stats.gini`, `lorenz`, `hill_tail(k_frac = 0.05, 0.1, 0.2)`): Gini of task costs, the
    Lorenz curve, the share of the total spent by the top k %.
  - Headline numbers on the 2026-10 snapshot (for the comparison, not for tests): 264 tickets, 8 consensus
    outliers, median direct $4.36 → $0.61 → $0.26 across eras, Gini 0.71, supervisor $1,017 (94 % unattributed).

## 2. Contract — three panels under `/api/analysis/`

All three accept the existing filters (`from`, `to`, `squad`, `model`, `era`, `eraBoundary`); every panel echoes
`filters` and lists `caveats` like the others. Money and shares use USD rounded to 4 decimals; shares to 4.

### `GET /api/analysis/tickets` — price of a ticket
`era` is applied to the task's `first_ts`; `era=all` gives both eras side by side.
```json
{ "definition": "direct = priced cost of plan/dev/review/test messages attributed to the ticket by the run→task links; loaded = direct + the Supervisor messages active on or adjacent (≤ 30 min) to its runs",
  "tasks": 264, "priced": 240, "unpriced": 24,
  "eras": [ { "era": "pre", "tasks": 120, "direct": { "p20": 1.1, "p50": 4.36, "p80": 12.2, "medianCi": [3.9, 5.1] },
             "loaded": { "p20": 0, "p50": 0, "p80": 0, "medianCi": [0, 0] } , "partial": 7 } ],
  "rows": [ { "taskId": "FOC-123", "era": "post", "firstTs": "…", "msgs": 41, "costUsd": 4.1, "costLoaded": 6.9,
             "supActive": 2.0, "supAdjacent": 0.8, "unpricedShare": 0, "partial": false } ],
  "caveats": [ "…" ] }
```
Percentiles are p20/p50/p80 (Mateusz's standard); `medianCi` is a 95 % bootstrap CI of the median with a seeded
RNG (`seed = 42`, 2000 resamples) so the number is reproducible.

### `GET /api/analysis/money` — where the money goes
```json
{ "definition": "priced cost per squad; Supervisor messages split into active / adjacent / idle by the allocation rule; concentration of direct ticket cost",
  "total": 1978.0, "bySquad": [ { "squad": "supervisor", "costUsd": 1017.0, "share": 0.51 } ],
  "supervisor": { "costUsd": 1017.0, "active": 40.1, "adjacent": 20.3, "idle": 956.6, "idleShare": 0.94 },
  "concentration": { "gini": 0.71, "top": [ { "k": 0.05, "share": 0.4 }, { "k": 0.1, "share": 0.55 }, { "k": 0.2, "share": 0.72 } ],
                     "lorenz": [ [0, 0], [0.1, 0.01], [1, 1] ] },
  "caveats": [ "…" ] }
```

### `GET /api/analysis/outliers` — the outlier ledger
```json
{ "definition": "task cost on log10; modified z-score (MAD, |z| > 3.5) and Tukey far fence (3·IQR); consensus = both; isolation forest and MCD stay in the notebook",
  "tasks": 264, "flagged": 8, "detectors": ["mad", "tukey"], "consensusMin": 2,
  "rows": [ { "taskId": "FOC-226", "era": "post", "costUsd": 132.0, "logCost": 2.12, "madZ": 4.3, "flagMad": true, "flagTukeyMild": true, "flagTukeyFar": true, "nFlags": 2, "consensus": true, "direction": "high", "msgs": 310 } ],
  "sensitivity": { "medianAll": 0.61, "medianWithout": 0.58, "totalAll": 900.0, "totalWithout": 640.0 },
  "caveats": [ "…" ] }
```
`rows` holds every task with its detector columns (the UI shows the consensus ones first and the rest behind
"table"), so the evidence behind a point is one click away (`/work/<taskId>`).

## 3. Slices

| Slice | Deliverable | Own files |
|---|---|---|
| A — cache + builders + routes | `analysis-cache.mjs`: copy `run_task_links` and `work_items` into the cache (indexes on `run_id`, `valid_from`), bump `cache_schema_version`; `scripts/analysis-insights.mjs` (pure, exported: `buildTaskTable(usageRows, links, { eraBoundary })`, `allocateSupervisorOverhead(supRows, childRuns, linksByRun, { maxGapMin: 30 })`, `quantiles`, `bootstrapMedianCi(values, { seed: 42, n: 2000 })`, `gini`, `lorenz`, `hillTail`, `modifiedZ`, `tukeyFlags`, `detectOutliers`, and the three panel functions `ticketsPanel(db, filters)`, `moneyPanel(db, filters)`, `outliersPanel(db, filters)` reading the cache through `filterSql`); the three routes in `telemetry-server.mjs` (extend the list + map); `scripts/analysis-insights.test.mjs` (fixture cache built with the real `buildCache` on a fixture store: hand-computed expectations for every number — a 6-task fixture whose Gini, percentiles, MAD z, Tukey flags, allocation modes and loaded costs are worked out in comments); the API test extended for the three routes (200 shape, 503 cache_building, 400 bad filter); lanes + checklist counts. | the new files, `analysis-cache.mjs`, `telemetry-server.mjs`, `telemetry-analysis-api.test.mjs`, `test-lanes.json`, checklist |
| B — UI | `ui/src/screens/analysis/TicketsPanel.jsx`, `MoneyPanel.jsx`, `OutliersPanel.jsx` (definition line on top, KPI tiles, one chart each — tickets: p20/p50/p80 per era as a column chart with the CI in the secondary text; money: squad bars + a stacked bar active/adjacent/idle + the Lorenz curve as an inline SVG + Gini tile; outliers: the consensus table with links to `/work/<taskId>`, direction chips, the sensitivity tiles), `DataTable` behind "table" with export; `TABS` entries `tickets`, `money`, `outliers` after `cost`; tests in `ui/src/_tests_analysis.mjs` for any pure helper (keep helpers in `ui/src/screens/analysis/insightsModel.js`). | the new files, `Analysis.jsx`, `_tests_analysis.mjs` |
| C — docs + AC1 comparison | `docs/TELEMETRY-EXPLAINED.md` §9 table (+3 rows, the definitions), `docs/ui/dashboard-v2-spec.md` Insights status line; the delivery owner runs the notebook's `fenix` functions on a snapshot copy of the live store inside the `fenix-analysis:py313` container (if available) and the new API on the same copy, records the comparison in the PR (AC1); without the container the PR says so and AC1 rests on the fixture tests + the SQL console cross-check. | docs; the delivery owner |

Out of scope: loop episodes (B2 needs text similarity), human-steering and flow blocks (need embeddings or
transcripts), isolation forest / MCD detectors, a notebook runtime in the container.

## 4. Decisions (defaults, reversible)

- D1 Unit of analysis = task (ticket) as the notebook's M3/M5 blocks; `SUP:` ids excluded; tasks whose first
  message has no timestamp are excluded and counted in a caveat.
- D2 The era filter on the Tickets panel applies to `first_ts`; `era=all` returns both eras — the screen's default
  (`post`) therefore shows one era, and the panel offers an "all eras" toggle that sets `era=all` in the URL.
- D3 Percentile bands p20/p50/p80 everywhere; means are never shown.
- D4 Performance: every panel is a handful of indexed scans over the cache plus O(n log n) JS; the budget is the
  existing P3.1 (p95 < 500 ms) measured in the API test on the fixture and once on the snapshot copy.

## 5. Acceptance (ticket AC mapped)

1. AC1 numbers match the notebook on the same snapshot: fixture tests pin every definition; the one-off snapshot
   comparison in the PR (slice C) for the headline numbers (task count, median direct per era, Gini, consensus
   outliers by `mad`+`tukey`).
2. AC2 performance budget P3.1: the API test asserts each panel answers < 500 ms on the fixture; the snapshot run
   records real timings.

## 6. Performance measurement (FOC-915 follow-up, 2026-10-19)

The P3.1 budget (p95 < 500 ms) is asserted by the API test on the FIXTURE cache only — a fixture answers in
single-digit milliseconds and proves the code path, not the budget. The real-store numbers that motivated
FOC-915 were measured on a snapshot copy of the live store (2026-10-19, 1.27 GB, ~180k canonical usage rows):

| What | Before FOC-915 (recompute per request) | After (precomputed `insight_task_table` + `insight_supervisor_alloc`) |
|---|---|---|
| Tickets / Money / Outliers, default 30-day window, in-process | 0.25–0.6 s | single-digit ms (indexed reads + O(tasks)) |
| Whole history (`from` = epoch), in-process | 0.9–1.0 s | single-digit ms |
| Over HTTP under suite load | 0.7–2.4 s | unchanged for `money`'s spend part (indexed SQL), ms for the rest |

How to reproduce the measurement (the snapshot timings above come from this):

```bash
# 1. snapshot the live store (read-only copy — never point the tooling at the live file):
cp ~/.fenix/telemetry/telemetry.sqlite /tmp/snap.sqlite
# 2. build the cache against the snapshot:
node scripts/analysis-cache.mjs build --store /tmp/snap.sqlite --cache /tmp/analysis-cache.sqlite
# 3. time the panels in-process on the built cache:
node -e '
import("./scripts/analysis-insights.mjs").then(async (m) => {
  const { openAnalysisDb } = await import("./scripts/telemetry-analysis.mjs");
  const db = openAnalysisDb("/tmp/analysis-cache.sqlite");
  for (const [name, panel] of [["tickets", m.ticketsPanel], ["money", m.moneyPanel], ["outliers", m.outliersPanel]]) {
    for (const [label, filters] of [["30d", {}], ["all-history", { from: "1970-01-01T00:00:00.000Z" }]]) {
      const t0 = performance.now();
      panel(db, filters);
      console.log(name, label, (performance.now() - t0).toFixed(0), "ms");
    }
  }
});'
```

The cold-call numbers to record in the PR are the `all-history` rows — the 30-day window is what the dashboard
serves by default. FOC-915's contract: the panels keep byte-identical payloads on the fixture (the hand-computed
tests pass unchanged), and the filters narrow per task `first_ts` (tickets, concentration) / per message time
(spend) over the PRECOMPUTED rows instead of re-attributing the usage rows per request.
3. Browser check of the three tabs on the offline acceptance instance (fixture cache), screenshots in the PR.
