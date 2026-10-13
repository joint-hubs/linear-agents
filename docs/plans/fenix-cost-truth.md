# FOC-760 + FOC-761 + FOC-769 — one cost truth: registry, telemetry, Supervisor focus

Date: 2026-10-13. One PR for the lane-O cost trio (M8, due 10-21..23). Evidence:
`docs/research/2026-10-10-model-cost-telemetry-review.md` (F4, F5), PRD `docs/prd/fenix-1.0.0-release-prd.md` §3.

## FOC-760 — registry child cost from transcripts

**Root cause (confirmed in code).** `supervisor-watch.mjs:264-265` adds `costFromResult(event)` for every `result`
event of a turn; on exit (`:328`) it adds that to the entry's `costUsd`. `result.modelUsage` is cumulative for the
session (background-task wake-ups re-emit it; a resumed turn carries the whole session), so the registry is 5.05×
ground truth ($781.85 vs $154.70, 366 children).

**Design.**

1. New `scripts/transcript-cost.mjs` (pure, no store):
   * `childTranscriptPaths({ configDir, cwd, sessionId })` → `{ lead, subagents[] }` or `null` —
     `<configDir>/projects/<cwdToHashName(cwd)>/<sessionId>.jsonl`, fallback: any `<configDir>/projects/*/<sessionId>.jsonl`;
     subagents from `<dir>/<sessionId>/subagents/agent-*.jsonl`, then flat `<dir>/subagents/`.
   * `priceTranscripts(paths, { priceOne, thresholdOne })` → `{ costUsd, messages, unpricedModels, byModel }` — every
     assistant line with `message.usage`, merged per `message.id` with MAX per counter (the ingest rule,
     `telemetry-store.mjs:1824`), lines without an id counted per line; priced with `calculateCost` from
     `pricingSnapshot()`. Tokens on an unpriceable model → `costUsd: null` + the model in `unpricedModels`; zero-token
     messages cost 0.
2. Watcher at turn end: the child's cost is **set** from its transcripts (`costSource: "transcript"`,
   `costMessages`). No transcript found (should not happen right after a turn) → the **largest** `result` event's
   computed cost (session-cumulative snapshots, never summed; a zero-token wake-up shape is lower than the real
   snapshot), `costSource: "result-max"`. `costUsdReported` = the largest reported figure (evidence only).
   `unpricedModels` from the transcript pricing. A resume that forked a new session id prices both sessions' files.
3. One-time recompute: `scripts/registry-cost-recompute.mjs [--state-home <dir>] [--apply] [--json]` — dry run by
   default. Every `<stateHome>/<runId>/children.json` child: transcript found → `costUsd` from transcripts,
   `costUsdLegacy` = the old value, `costSource: "transcript"`; not found → value kept, `costSource:
   "legacy-unverified"` (shown as such by status, never silently trusted). Atomic write per registry; refuses a
   registry whose child is in flight (`running` / a turn without `endedAt`).
4. `supervisor-status` names `legacy-unverified` children beside the run total; `budgetStatus` unchanged (the cap now
   sees true numbers).

## FOC-761 — resumed child turns reach telemetry

**Root cause (confirmed in code).** `supervisor-followup.mjs` reuses the child's `telemetryRunId` and never re-opens
the run; the watcher's second `run-manifest end` emits `run.ended` with the same identity (`recordManifest`,
`telemetry-store.mjs:1982`: kind `manifest`, offset 1), so `eventAlreadyApplied` drops it; `runs.ended_at` stays at
turn 1 and after 5 min `settledRun` (`telemetry-ingest.mjs:966`) never reads the resumed turns' lines.

**Design.**

1. Re-open on resume: `run-manifest reopen <runId> <turn>` (manifest `endedAt: null`, `turns: n`) emits `run.resumed`
   (kind `manifest-turn`, offset = turn) → projection sets `status='running'`, `ended_at=NULL`. The watcher calls it at
   the start of every turn with index > 0 (best effort, a note in the tee on failure, like `endTelemetryRun`).
2. Per-turn end identity: `run-manifest end` records `endSeq`; the first end keeps today's identity (kind `manifest`,
   offset 1 — replays of old events unchanged), later ends use kind `manifest-turn-end`, offset = `endSeq`.
   `applyRunEnded` never moves `ended_at` backwards (out-of-order replay).
3. A settled run whose transcript grew: a slow sweep in the telemetry server (`sweepSettledGrowth`, every 10 min,
   runs ended in the last 14 days; once at boot with no age limit = the one-time re-ingest) stats only the stored
   `transcript_sources` paths of settled runs; a file larger than its parsed `file_size` is marked `pending` (ingest
   resumes from its stored byte offset — no full re-parse) and raises data-quality `transcript_grew_after_settle` once
   per run. The 15 s tick still skips settled runs without a stat (AC3).
4. Known limit, stated in the PR: several runs claiming one transcript (ADR-0008 run-scoped duplication) all re-read
   the growth; canonical views already collapse those claims.

## FOC-769 — the Supervisor declares its focus

**Today.** Only `cockpit.mjs focusTicket` (heuristic: newest `triage.json`); no declared focus, no overhead focus;
Supervisor usage is linked only to the pseudo-task `SUP:<run>` (12 % attributable via child windows, PRD §3).

**Design.**

1. `scripts/supervisor-focus.mjs set <TICKET|overhead> [--note "…"]`, `show` — JSON out, run id from
   `LA_SUPERVISOR_RUN` (refuses without it). Appends `{ at, taskId|null, kind: ticket|overhead, note, source }` to
   `<stateHome>/<runId>/focus.jsonl`, writes `focus` into `current-run.json`, emits `supervisor.focus` (kind
   `supervisor-focus`, event id = hash of run, time, kind and ticket → idempotent, and two writers racing never
   collide the way a line-index offset would). `Bash(node:*)` already allows it.
2. Auto-focus: `supervisor-spawn` and `supervisor-followup` set the focus to the child's ticket (`source: "spawn" |
   "followup"`) when it differs — the Supervisor is acting on that ticket at that moment; explicit `set` wins until the
   next spawn/followup.
3. Telemetry: new `supervisor.focus` case → table `run_focus(run_id, valid_from, valid_to, task_id, kind, source)`
   (additive, `CREATE TABLE IF NOT EXISTS`); a new focus closes the open interval. Exported
   `ticketCostReport(db, { since, until })` → per ticket `{ childrenUsd, supervisorUsd, totalUsd }`, plus
   `overheadUsd`, `unattributedUsd` (Supervisor messages with no focus interval) and the attributed share. Children keep
   their own run → ticket links; the Supervisor's messages are charged to the focus valid at `observed_at`. Message
   dedup as canonical (per run + message id).
4. CLI `scripts/ticket-cost.mjs [--since] [--json]` (read-only store open); the Cockpit's `supervisor.focus` prefers
   the declared focus, the triage heuristic stays the fallback. Costs UI is FOC-785.
5. Contract: one rule in `agents/supervisor/CLAUDE.md` (switch focus with the command; `overhead` for work on no
   ticket) — needs Mateusz's OK.

## Shared — reconciliation check

`scripts/cost-reconcile.mjs [--state-home] [--db] [--json] [--strict]` — read-only (`DatabaseSync(…, { readOnly: true
})`): per child with a transcript, registry `costUsd` vs telemetry (its `telemetryRunId`, deduped per message) vs
transcript ground truth (`priceTranscripts`); summary single- / multi-turn ratios; `--strict` exits 1 when a child is
off by > 1 % (registry) or the multi-turn telemetry ratio < 0.99. Shared acceptance for FOC-760 / FOC-761.

## Slices (Flash workers)

* Wave 1 (parallel, disjoint files): S1 `transcript-cost.mjs` + tests · S3 `run-manifest reopen` / per-turn end
  identity + store `run.resumed` / `applyRunEnded` + tests · S4 `sweepSettledGrowth` in ingest + server timer + tests ·
  S5a `supervisor-focus.mjs` + tests.
* Wave 2: S2 watcher (cost set + reopen call) + `registry-cost-recompute.mjs` + tests · S5b store `supervisor.focus` /
  `run_focus` / `ticketCostReport` + `ticket-cost.mjs` + auto-focus in spawn/followup + tests · S6
  `cost-reconcile.mjs` + tests.
* Wave 3: status / Cockpit focus, contract line, docs (ACCESS, QUICKSTART, TELEMETRY-EXPLAINED), test registration;
  Flash review; integration.

## Verification

Unit tests per slice (recorded result-event shapes from `fixtures/foc-165-result-events.json`; spawn → end → followup →
end on one run id; switch / two tickets in flight / missing focus). Windows `test-all` + Linux lane. Acceptance stack
(fake Messages API, real Claude Code): a child with a background-task wake-up and a resumed turn → registry cost =
transcript price; telemetry `ended_at` = last turn, resumed usage ingested; `supervisor-focus set` → `run_focus` row and
`ticket-cost` shows it; `cost-reconcile --strict` passes. Recompute dry run on the local registries (numbers in the PR;
`--apply` only with Mateusz's consent).
