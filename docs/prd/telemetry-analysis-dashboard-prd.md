# Telemetry Analysis Dashboard — PRD

**Status:** Draft — awaiting Mateusz's approval before delegation
**Date:** 2026-09-26
**Owner:** Mateusz
**Branch / worktree:** `feat/telemetry-analysis-dashboard` in `.claude/worktrees/telemetry-dashboard` (isolated from the running Supervisor)
**Backlog refs:** FOC-381 (prerequisite, parent FOC-466), FOC-272 (Done — the review this analysis continues), FOC-273 (FT feasibility, out of scope)

## 1. Problem

Three things changed since the September telemetry analysis, and together they make the old approach unusable:

1. **The architecture moved.** Since 2026-09-22 (FOC-397, graph runner) Fenix runs a graph of typed nodes — `[D]` deterministic, `[G]` generator, `[J]` judge, `[H]` human — backed by a decision registry (`config/decisions.json`, FOC-448) and a decision I/O log (`.state/runs/<run>/decisions.jsonl`, FOC-449). The unit worth analysing is no longer "a squad's turn" but "a node's decision": its input, typed output, confidence, cost, and the outcome label recorded afterwards.
2. **There is no place to analyse.** Every analysis so far — including `docs/research/telemetry-analysis-2026-09.md` and the FOC-272 review — was a one-off script in a scratch directory. The dashboard (`:7331`, 11 screens, ~40 endpoints) shows operations, not analysis: it does not serve the decision log, and nothing in it lets a question be asked that the screen was not built for.
3. **Cost is not trustworthy.** One assistant message is written as ~2.57 transcript lines, each repeating the same `usage` block, and ingest records every line (FOC-381). The over-count is **1.98×–2.97× depending on squad** (measured 2026-09-19), so not only totals but shares are wrong. `canonical_usage`'s island rule (FOC-221) collapses much of it heuristically; it is not a fix at the source.

## 2. Goal

A new **Analysis** screen in the existing dashboard, reading the live telemetry store and the decision log, where Mateusz can find optimisation patterns in Fenix himself — through five ready panels, global filters, a read-only SQL console, and export from every panel. Cost figures on it are hard numbers, because FOC-381 lands first.

## 3. Decisions (taken, 2026-09-26)

| # | Question | Decision |
|---|---|---|
| 1 | Where it lives | New screen in the existing dashboard (`ui/` + `telemetry-server.mjs`), no separate tool |
| 2 | Ad-hoc queries | Yes — read-only SQL console |
| 3 | Panels | All five: cost & tokens, tool behaviour, graph decisions, handoffs & delegation, data quality |
| 4 | Global filters | Time window + squad + model + **era** (pre/post graph v2) |
| 5 | FOC-381 | **Fixed first**, before the dashboard ships cost panels |
| 6 | Decision panel with only 36 events | **Build now** (recommendation below) |
| 7 | Export | CSV and JSON from every panel |
| 8 | Isolation | Own worktree + branch; built by Atlas workers; does not touch the Supervisor's checkout |

**Why build the decision panel now (decision 6).** The log's schema is stable (FOC-449 fixed it, including the deterministic train/val/test split), so the panel will not be rebuilt when volume grows. Today's 36 events are all intake nodes from 22–23 Sep; `plan.dod` and `plan.ac` have no logged events yet. The panel therefore ships showing **n per decision and a small-sample warning below a threshold** — it is honest about thin data rather than hidden until data is thick. Deferring it would leave the one part of the new architecture that is actually new with no view at all.

## 4. User journey

1. Mateusz opens `http://localhost:7331/analysis`.
2. A filter bar sits above everything: window (default last 30 days), squad, model, era (default: post graph v2). Every panel re-queries on change; the active filters are visible in each panel's subtitle so a screenshot is self-describing.
3. He reads five panels top to bottom, hovers a mark for its exact value, and clicks **Export** on any panel for the rows behind it (CSV or JSON).
4. When a panel does not answer his question, he opens the **SQL console**, writes a `SELECT` against the canonical views or the decision table, and gets a result table with the same export buttons.
5. Where a number carries a caveat — small sample, unpriced rows, low attribution confidence — the caveat sits next to the number, never in a footnote.

## 5. Scope

**In**

- FOC-381 in full, per its acceptance criteria: ADR, ingest keyed per `message.id` taking the maximum across a message's lines, `message.id` stored per row, re-ingest reproducing the 2026-09-19 per-message totals within 1%.
- `scripts/telemetry-analysis.mjs` — pure, testable query functions taking a filter object; one read-only DB connection.
- `GET /api/analysis/{meta,cost,tools,decisions,handoffs,quality}` and `POST /api/analysis/sql`.
- A decision-log reader over `.state/runs/*/decisions.jsonl` (events joined to labels).
- `ui/src/screens/Analysis.jsx` + `analysis.css`, route and nav entry; inline SVG charts like `Ft.jsx` (no chart library).
- Per-panel CSV/JSON export.

**Out**

- Writing to the database from the dashboard in any form.
- Changing metric definitions — FOC-220 and FOC-221 are closed and their semantics stand.
- Alerting, scheduled reports, or anything that runs without Mateusz opening the page.
- New dependencies (chart libraries, SQL editors, auth).
- Fine-tuning (FOC-273).
- Access from anywhere but loopback — the server already binds `127.0.0.1`.

## 6. UX

**Persona:** Mateusz as operator and architect of Fenix — technical, reads SQL, scans rather than reads, wants density over decoration. Not the AU end-user persona.

**Style:** consistent with the existing screens — the dashboard's CSS variables (`--border`, `--muted`, …), English copy, inline SVG. Dense tables with tabular numerals. One scale per chart, never a dual axis. Status colour (warning for thin samples, critical for unpriced) is separate from series colour and always carries a text label.

**Panels:**

| Panel | Answers | Primary source |
|---|---|---|
| Cost & tokens | Where the money goes by squad, model, role, week; lead vs subagent share | `canonical_usage` (post-381) |
| Tool behaviour | Repeats by FOC-220 category (`reread_after_edit`, `rerun_after_change`, `result_changed`, `unchanged`, `unknown`), error rate, outcome-unknown share | `canonical_tool_facts` |
| Graph decisions | Per `decisionId`: volume, confidence distribution, cost, latency, agreement with the recorded outcome label | `decisions.jsonl` |
| Handoffs & delegation | Parent→child delegation volume and cost, first-turn re-derivation where measurable | `delegation_links`, `canonical_usage` |
| Data quality | Unpriced rows by model, attribution confidence mix, canon coverage, transcript coverage | canonical views, `data_quality_issues` |

**Era boundary:** a named constant, `2026-09-22T00:00:00Z` (FOC-397 merge), shown in the UI and overridable in the filter — because it is a judgement, and the judgement should be visible.

## 7. Architecture

### 7.1 Isolation — the part a worktree does not solve

A worktree isolates **code**. The telemetry store is **user-level** (`%LOCALAPPDATA%\linear-agents\telemetry\telemetry.sqlite`) and shared by every process on the machine, including the Supervisor, which is running now, and the `:7331` dashboard, which re-ingests transcripts every few seconds. FOC-381 migrates that store's schema and rewrites its cost history; ADR-0008 already requires a single writer during such a rebuild.

Therefore:

- **All development and testing run against a copy.** The worktree's processes set `LA_TELEMETRY_HOME` to a separate directory (`%LOCALAPPDATA%\linear-agents\telemetry-dev\`) holding a snapshot of the live store. Nothing built on this branch opens the live store until the production window.
- **The branch's dashboard runs on its own port**, `TELEMETRY_PORT=7341`, so it never collides with the Supervisor's `:7331`.
- **The production migration is one controlled window**, taken only with Mateusz's explicit go: stop the Supervisor and the `:7331` server, snapshot the live store (`VACUUM INTO`), apply the v8 migration and re-ingest, verify, restart. A migration that fires on whichever process happens to open the store first is exactly what ADR-0008 forbids.
- **Merging to `main` is the trigger** — the moment the new ingest code is on `main`, any process opening the store would apply the migration. The merge and the window are therefore the same event, not two.

### 7.2 FOC-381 at the source — design B (signed off by Mateusz 2026-09-26)

*Revised 2026-09-26 after two `glm-5.3` design reviews.* The first design deduplicated at **event emission** (hold back a file's last message, emit one event per message). Review found it unfixable in that shape: once emitted, a message is frozen forever — `eventAlreadyApplied` drops any later payload before projection and `usage_facts` is `INSERT OR IGNORE` — and the repo itself documents that transcripts receive their last lines *after* the run manifest is written (`telemetry-ingest.mjs:377-379`). Design B moves deduplication into the **projection**, where it can be monotonic:

- **B1 — events unchanged.** Still one `usage.recorded` per transcript line, same dedup key; the payload gains `messageId`.
- **B2 — per-message upsert with monotonic MAX.** For a line with a `messageId`, the target row is `usage_id = sha256(path:msg:<id>)`, written with `INSERT … ON CONFLICT(run_id, usage_id) DO UPDATE` taking the MAX of each counter and the MIN of `observed_at`; `source_offset` is set on INSERT only and never updated (review blocker: updating it can collide with `UNIQUE(run_id, source_path, source_offset)` and roll back whole ingest batches). Cost is recomputed from the row's current counters. MAX is idempotent and order-independent, so partial ingest passes, late-flushed lines and full `reprojectEvents` replay all converge — no hold-back, no skip-cache change.
- **B3 — identity.** The upsert is on the **composite** `(run_id, usage_id)`, which cannot merge two runs; JOI-259 was a *global* `usage_id` key. FOC-381's AC literally says "not an upsert on `usage_id`" — design B satisfies its intent (not keyed on `usage_id` alone) but not its wording, **Mateusz signed off this deviation from the AC's literal wording on 2026-09-26.**
- **B4 — schema v8.** `MIGRATION_VERSIONS.usageMessageId = 8`; nullable `usage_facts.message_id` via a PRAGMA-guarded additive ALTER placed after `migrateRunScopedUsage`; index on `(run_id, message_id)`.
- **B5 — history without deleting the event log.** A one-off command, per `(run_id, source_path)` whose transcript still exists: maps each stored event's offset back to its line and writes `messageId` into the event payload (verifying the line's usage matches the stored counters), then in one transaction deletes that source's `usage_facts` (cost cascades) and reprojects its `usage.recorded` events. **A source is only rewritten if its stored events can rebuild at least the rows that exist** (review blocker: `telemetry-prune.mjs` deletes events, and rewriting such a source would lose data irreversibly). Everything else stays per-line, `message_id` NULL, flagged `usage_legacy_inflated`.
- **B6 — canonical view.** A NULL-safe guard so rows with different non-null `message_id` never merge; `message_id` exposed; SQL and JS twin changed together with the contract test extended.
- **Evidence already in hand:** the independent scan (`scripts/telemetry-message-scan.mjs`) found **0 lines without `message.id`** across 214,771 assistant lines, so the review's remaining double-count risk (real usage on an id-less line) does not occur in the current corpus.

### 7.3 Backend

- **Analysis never goes through `openTelemetryDb()`.** Recon found that it opens the store read-write and runs `migrate()` on every open, and that `telemetry-server.mjs` also re-ingests every 15 s (`setInterval(ingestTelemetry, 15_000)`). Analysis endpoints therefore open their own `new DatabaseSync(path, { readOnly: true })` connection. A consequence for §7.1: after the merge, the `:7331` server itself applies v8 on its first open — one more reason the merge and the production window are one event.
- **Decision logs live in the checkout that ran the Supervisor**, not in this worktree (`.state/runs/*/decisions.jsonl` is runtime state). The reader takes its directory from `LA_DECISION_RUNS_DIR`, defaulting to `<repo>/.state/runs`; during development it points read-only at the main checkout's.
- `scripts/telemetry-analysis.mjs` — one exported function per panel, each taking `{ from, to, squad, model, era }` and returning plain rows plus a `caveats` array. Every cost query reads `canonical_usage`; no `SUM()` over raw `usage_facts` anywhere (a review rule and a test).
- **SQL console guard**, in layers so no single check is load-bearing: the connection is opened `readOnly: true` (SQLite itself refuses writes); the statement must be a single `SELECT` or `WITH … SELECT`; `ATTACH`, `PRAGMA` and multiple statements are refused before preparation; results are capped (5,000 rows, flagged when truncated); execution runs in a **child process** killed with `SIGKILL` on timeout (10 s).
  *Amended 2026-09-26 (W1 finding):* this section originally specified a `worker_thread` terminated on timeout. Measured on Node 22.20, `worker.terminate()` does **not** interrupt a thread blocked inside a native `node:sqlite` call — an infinite recursive CTE was still running 30 s after `terminate()`, whose promise never settled. The original design would have hung on exactly the query the timeout exists for. `SIGKILL` (TerminateProcess on Windows) lands mid-native-call; the cost is ~50–100 ms of process spawn per query, acceptable for a local tool. Also verified: TEMP tables can be created on a read-only connection (the temp schema is separate and writable), which is how decision-log rows become queryable next to telemetry.
- Decision reader: parses events and labels, joins on `eventId`, exposes them to the SQL console as a queryable table in an in-memory attachment — so the console can join decisions against telemetry without the reader writing anything.

### 7.4 Performance — the canonical views are too slow to query interactively (cache approved 2026-09-26)

Measured 2026-09-26 on the dev snapshot (849 MB, 279,821 raw usage rows):

| Query | Time |
|---|---:|
| `SELECT COUNT(*) FROM usage_facts` | 0.0 s |
| `SELECT COUNT(*) FROM canonical_usage` | 12.9 s |
| same, last 7 days only | 10.2 s |
| `SELECT COUNT(*) FROM canonical_tool_facts` | **90.1 s** |

A time filter barely helps: the views' window functions (claim ranking, FOC-221 islands) run over every row before any outer `WHERE`. The cost panel alone needs ~7 passes; the SQL console's 10 s timeout would kill almost any query over the views.

**Proposed fix — a derived analysis cache.** A separate SQLite file (`analysis-cache.sqlite`, next to the store, never the store itself) holding the two views materialised as indexed tables, with a watermark of what they were built from (store row counts + max `observed_at`). Panels and the console read the cache; the screen shows the cache's age and a **Refresh** button; a rebuild costs roughly one pass of each view (~2 min today) and runs only when the store has changed. §9 AC5 still holds — the telemetry store is never written; the cache is a disposable derivative that can be deleted at any time.

### 7.5 UI

`Analysis.jsx` with a shared filter state, five panel components, a console component, and one export helper. Charts are inline SVG, following `Ft.jsx`. API functions added to `ui/src/api.js` in its existing pattern.

## 8. Implementation phases

Worker model policy per `~/.claude/memory/orchestration.md`: `glm-5.3-flash` by default, `glm-5.3` for harder or reviewing work, nothing else. Up to four workers in parallel. I plan, slice, review and accept; workers write the code.

**Phase 0 — FOC-381 (sequential; everything else depends on it)**

- [x] 0.1 Recon of the usage path — first `flash` attempt drifted and answered nothing; redone on `glm-5.3` (complete, file:line). 2026-09-19 scan located (§10).
- [x] 0.2 Snapshot the live store into the dev home — 810 MB, `quick_check` ok, v7, both views.
- [x] 0.2a `[glm-5.3-flash]` Independent reference scan `scripts/telemetry-message-scan.mjs` (52 tests) — fleet 2.10×, per-squad factors in the 2026-09-19 band, 0 id-less lines.
- [x] 0.2b `[glm-5.3]` ×2 design reviews — design A rejected (4 blockers), design B accepted with 2 blockers folded in (§7.2).
- [x] 0.2c Mateusz signed off design B, including the composite-key upsert vs the AC's wording (2026-09-26).
- [x] 0.3 `[glm-5.3]` ADR-0013: projection-level dedup, history rewrite rules, why a composite upsert is not JOI-259 (`docs/adr/0013-per-message-usage-identity.md`).
- [x] 0.4 `[glm-5.3]` Migration v8: `message_id` column + index (F1; migration test incl. simulated v7 reopen).
- [x] 0.5 `[glm-5.3]` Ingest payload `messageId` + projection upsert (B1–B2) — F1, 10 new tests, 20 adjacent suites green; `applyUsageMessage` reviewed by the orchestrator.
- [x] 0.6 `[glm-5.3]` One-off rewrite with the coverage guard (B5) + `reprojectEvents` `sourcePath` option — `scripts/telemetry-usage-rewrite.mjs`, 10 tests; dry-run default, `--apply` refuses the live path without `--live`.
- [x] 0.7 `[glm-5.3]` Canonical view guard + JS twin + contract tests (B6) — 66 tests; `message_id` exposed on `canonical_usage`.
- [x] 0.8 Rewrite the **copy**; compare within 1% per squad — see §10a. Comparison by `scripts/telemetry-usage-verify.mjs` (independent per-message scan bounded by each file's ingest horizon, 44 tests).
- [x] 0.9 `[glm-5.3]` Review of phase 0 (R3): no blockers; 4 should-fix (live-guard bypass via env, SQLITE_BUSY flagging healthy pairs, stale raw-cost note, `payload.usageId` override) → F5.

**Phase 1 — backend (parallel after 0.4; contract frozen before phase 2 starts)**

- [x] 1.1 `[glm-5.3-flash]` `telemetry-analysis.mjs`: filters, era constant, read-only opener, meta/tools/quality panels — 61 tests.
- [x] 1.2 `[glm-5.3-flash]` Cost and handoffs panels — 97 tests total (worker ended its first turn early; accepted after my own test run).
- [x] 1.3 `[glm-5.3]` Decision-log reader + join + answer→outcome mapping — 58 tests (first `flash` attempt wrote nothing in ~50 min).
- [x] 1.4 `[glm-5.3]` SQL console — 53 tests; child process + `SIGKILL`, not `worker_thread` (§7.3 amendment).
- [x] 1.5 `[glm-5.3-flash]` Endpoints in `telemetry-server.mjs` — E1, 29 API checks; Pro review folded into 3.3.
- [x] 1.6 Contract tests incl. "no raw `usage_facts`" (source guard) and "console refuses writes".
- [x] 1.7a Mateusz approved the analysis cache (§7.4), 2026-09-26.
- [x] 1.7b `[glm-5.3]` Build `analysis-cache.mjs` — C1, 67 tests; build 54 s on the snapshot; panels on the cache 0.04–6 s.
- [x] 1.7c `[glm-5.3]` Point panels + console at the cache; status + rebuild routes (child-process build) — E2, API 44 checks.
- [x] 1.8 Export `REPEAT_CATEGORIES` from `agent-behavior.mjs` and drop the copy in `telemetry-analysis.mjs`.

**Phase 2 — UI (parallel after the API contract is frozen)**

- [x] 2.1 `api.js` functions, route, nav entry (U1b on `glm-5.3` after the flash U1 timed out).
- [x] 2.2 Filter bar with shared state in the URL (U1b).
- [x] 2.3 Five panels — chart primitives U1c (flash), tailored panels U2/U3/U4 (`glm-5.3`).
- [x] 2.4 SQL console UI — examples, per-target relations hint; positional rows → objects fixed after e2e (F4).
- [x] 2.5 Export helper — RFC 4180 CSV + JSON, full rows (not charted top N).

**Phase 3 — integration and acceptance (me)**

- [x] 3.1 `test-all` 93/94 (the one failure, `supervisor-followup.test.mjs`, is a 15 s child-exit timeout under load — passes 18/18 in isolation; untouched code); `ui` tests 175/175, build clean.
- [x] 3.2 End-to-end in the browser on `:7341` against the rewritten copy: five panels, squad/era/era-boundary/to filters (URL state), SQL console (examples, both targets), Refresh cache (child build 24.8 s). Found and fixed: console rows rendered as "—" (positional rows), `<synthetic>` flagged as critical unpriced. Export covered by unit tests (RFC 4180), not clicked (downloads).
- [x] 3.3 `[glm-5.3]` Whole-branch review — R3 (FOC-381) + R4 (analysis stack): no blockers; should-fix items → F5 (FOC-381), F6 (backend), F7 (UI).
- [x] 3.4 `docs/STATE.md`, `TELEMETRY-EXPLAINED.md`, `ACCESS.md`, e2e checklist count (85 → 94) updated; commits proposed, not made.

**Phase 4 — production window (only on Mateusz's explicit go)**

- [ ] 4.1 Stop Supervisor and `:7331`; snapshot live store.
- [ ] 4.2 Merge; apply v8 + re-ingest on the live store; verify against 0.7.
- [ ] 4.3 Restart; confirm `:7331/analysis` against live data.

### Resume point (updated 2026-09-26 evening)

Phases 0–3 done on the branch (not committed — waiting for "commituj"). All workers collected and verified. Open:

- **Commit** the branch in the proposed batches (on Mateusz's "commituj").
- **Phase 4** (production window) only on Mateusz's explicit go — sequence in `docs/STATE.md` 2026-09-26 entry.
- **Follow-ups (not in this branch):** (1) cross-file duplicate messages — 36 OpenRouter `gen-…` messages logged in both the lead and a subagent transcript of the same run, ~4.1 M tokens (0.05 %), counted once per file; reported by `telemetry-usage-verify.mjs` as `crossFileDuplicates`. (2) `telemetry-server.mjs` ingest is synchronous: after downtime the first pass blocks HTTP for minutes (seen on the dev copy; will happen once on `:7331` after the production window). (3) Footer label "telemetry :7331" is hard-coded in `App.jsx`.

Dev artefacts: copy `%LOCALAPPDATA%\linear-agents\telemetry-dev-381\` (rewritten, v8, cache inside); pristine v7 snapshot `%LOCALAPPDATA%\linear-agents\telemetry-dev\`; verify snapshots `%TEMP%\telemetry-381-verify*.sqlite` and `%TEMP%\analysis-cache-smoke.sqlite` (disposable).

## 9. Acceptance criteria

1. FOC-381's own acceptance criteria all pass.
2. `:7331/analysis` exists in the dashboard's navigation with five panels and the four global filters.
3. No query anywhere sums raw `usage_facts`; every cost figure comes from `canonical_usage`. Enforced by a test.
4. The SQL console refuses non-`SELECT`, multiple statements, `ATTACH` and `PRAGMA`; returns at most 5,000 rows and flags truncation; aborts after 10 s. Each behaviour has a test.
5. The dashboard never writes to the store — the analysis connection is `readOnly`, and a test proves a write through it fails.
6. The decision panel shows `n` per decision and a small-sample warning below the threshold.
7. Every panel and every console result exports to CSV and JSON.
8. Caveats (small sample, unpriced, low attribution confidence) render beside the figure they qualify.
9. `test-all` and the `ui` build pass; the screen is verified in a browser, not just compiled.

## 10a. FOC-381 verification on the copy (2026-09-26)

Copy: `%LOCALAPPDATA%\linear-agents\telemetry-dev-381\` (snapshot of the live store taken 2026-09-26 11:08, v7 → v8 on first open).

**Rewrite** (`telemetry-usage-rewrite.mjs --apply`, 2 min 15 s): 3,077 (run, transcript) pairs; 1,965 rewritten, 1,112 skipped `transcript_missing` (flagged `usage_legacy_inflated` on 259 runs); 0 `events_pruned`, 0 `unverifiable`, 0 `reproject_failed`. `usage_facts` 279,821 → 158,556 rows; raw per-run tokens 21.61 B → 12.49 B; raw per-run cost $7,866 → $4,384.

**Verification** (`telemetry-usage-verify.mjs`, on a `VACUUM INTO` snapshot of the rewritten copy): 1,913 transcripts, **72,598 / 72,598 messages matched exactly**, 0 mismatched, 0 missing either side, 0 run disagreements; per-squad token difference **0.0000 %** for every squad. Legacy remainder (transcripts gone): 78,828 rows, 4.10 B tokens — still per-line, still de-duplicated read-side by the view heuristic.

**Canonical view before → after** (era all, same filters): tokens within 0.4 % for every squad except orch-openrouter (−22.8 %, where the tuple heuristic had not collapsed lines); turns 121,074 → 107,657 (−11 %); unpriced turns 1,630 → 636 — `zai-org/GLM-5.2-FP8` rows had NULL cost stored by an older price resolver and are now priced from the run's own pinned price set (+$40 on supervisor). Fleet canonical spend $1,895 → $1,944.

## 10. Open items

- **Production window timing** — needs the Supervisor stopped; Mateusz picks when.
- ~~Location of the 2026-09-19 per-message scan~~ — **resolved.** It is the per-squad table in `docs/plans/fenix-architecture-gaps-2026-09-19.md` (supervisor 2.05×, dev 1.98×, review 2.42×, test 2.49×, plan 2.97×), with the method stated in the same file: every `agents/<squad>/projects/**/*.jsonl`, assistant lines with `usage`, sum over lines vs maximum per `message.id`, tokens = input + output + cache read + cache creation. The probe scripts stayed in that session's scratchpad and are not in the repo.
  **Interpretation of FOC-381's "reproduce within 1%":** the corpus has grown since 2026-09-19, so its totals cannot be reproduced literally. The criterion is taken as: *the re-ingested store matches an independent per-message scan of the same corpus, by the same method, within 1% per squad*, with the per-squad factors checked against the 2026-09-19 table as a sanity bound. The method becomes a committed reference script (`scripts/telemetry-message-scan.mjs`) so the comparison is repeatable rather than one session's scratch.
- **Small-sample threshold** for the decision panel — proposed `n < 30` per decision; adjustable.
