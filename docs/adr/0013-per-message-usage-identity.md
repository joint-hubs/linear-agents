# ADR-0013: Per-message usage identity (FOC-381)

**Status:** Accepted

**Date:** 2026-09-26

## Context

One assistant message lands in the transcript as **~2–3 JSONL lines** (thinking / text / tool_use blocks), and each line repeats the message's `usage` object — or carries zeros on some lines. Since the telemetry pipeline's inception, `usage_facts` identity has been **per line**: `usage_id = hash(source_path:source_offset)`, one row per physical line. A multi-line message is therefore counted once per line. Measured 2026-09-19 (`docs/plans/fenix-architecture-gaps-2026-09-19.md` §2.9, max usage per `message.id` vs sum over lines): **~2.05–2.97× over-count fleet-wide, and non-uniform per squad** — supervisor 2.05×, dev 1.98×, review 2.42×, test 2.49×, plan 2.97×. The non-uniformity matters more than the mean: raw `usage_facts` cannot be corrected by a single scalar, and every squad's *share* of token spend is also wrong (plan's raw 2.4% share is really 1.7%).

The read side already had a mitigation: the `canonical_usage` view (FOC-221) collapses adjacent lines into "islands" when the usage tuple matches and the observed-at gap stays under `MESSAGE_GAP_MS` (5 min). That heuristic was **not enough**, for three reasons:

- It is a *sampled proxy* for message identity, with a known false-merge: two different adjacent messages carrying the same tuple (consecutive zero-usage messages, identical small calls) collapse into one row, undercounting.
- It runs per render over every raw row — the view costs ~12.9 s for a `COUNT(*)` on the 849 MB store (measured 2026-09-26) — and its correction happens only at the read side, so every other consumer of `usage_facts` (joins, exports, any query written before the view existed) still sees the inflated numbers.
- Island attribution is statistical, not exact: it cannot prove which lines belong to which message, so the fix lives at the wrong layer for something the source data states outright (`message.id`).

FOC-381 was opened to fix this at the source. The **first design deduplicated at event emission**: hold back a file's last message, emit one `usage.recorded` event per message. Two `glm-5.3` design reviews found it unfixable in that shape — once emitted, a message is **frozen forever**:

- `eventAlreadyApplied` (`scripts/telemetry-store.mjs`) drops any later payload for the same event key before projection ever runs, so a message held back and emitted once can never be corrected when the transcript later gains lines;
- `usage_facts` writes are `INSERT OR IGNORE` (the legacy per-line path), so projection cannot grow a row either;
- and the repo itself documents that transcripts receive their **last lines after the run manifest is written** (`scripts/telemetry-ingest.mjs:384-386` — the terminal-status grace window exists precisely because `run-manifest end` writes the manifest before the transcript's final lines are flushed). An emission-time decision about a message's completeness is therefore made on data known to be incomplete.

Design B (PRD `docs/prd/telemetry-analysis-dashboard-prd.md` §7.2, signed off by Mateusz 2026-09-26) moves deduplication into the **projection**, where it can be monotonic. This ADR records that decision. ADR-0008 (run-scoped usage identity) is the prerequisite it refines: the composite `(run_id, usage_id)` key it established is the base this ADR keeps and narrows from per-line to per-message.

Evidence in hand before the decision: the independent scan (`scripts/telemetry-message-scan.mjs`) found **0 assistant lines with `usage` but without `message.id`** across 214,771 assistant lines in the current corpus — the one failure mode of a per-message key (real usage on an id-less line) does not occur in the data that exists.

## Decision

**One physical model call (one assistant message) yields exactly one `usage_facts` row, keyed by message identity; the event log stays per line and is never rewritten in shape.**

1. **B1 — events unchanged.** `jsonLineEvents` (`scripts/telemetry-ingest.mjs`) still emits one `usage.recorded` event per transcript line with the same dedup key (`UNIQUE(run_id, source_kind, source_path, source_offset, event_type)` from ADR-0008). The payload gains `messageId: line.message?.id ?? null`. No hold-back, no skip-cache change: partial ingest passes stay safe because nothing about a line's event depends on the file being complete.

2. **B2 — per-message upsert with monotonic MAX.** `applyUsageRecorded` dispatches to `applyUsageMessage` when `payload.messageId` is a non-empty string; lines without one keep the legacy per-line identity byte-for-byte. For a message line, the target row is `usage_id = sha256(path:msg:<messageId>)`, written with `INSERT … ON CONFLICT(run_id, usage_id) DO UPDATE`:

   - each counter takes `MAX(row, excluded)` — idempotent and order-independent, so partial passes, late-flushed lines and full `reprojectEvents` replay all converge without any ordering assumptions;
   - `observed_at` takes the NULL-safe MIN (either side NULL keeps the other);
   - `source_offset` is set on INSERT only and **never updated** — updating it can collide with the retained `UNIQUE(run_id, source_path, source_offset)` defense-in-depth constraint and roll back whole ingest batches;
   - a trailing target-less `ON CONFLICT DO NOTHING` absorbs a `UNIQUE(run_id, source_path, source_offset)` clash with a legacy per-line row squatting the same offset (the deploy-window straddle: the line was first written by the pre-FOC-381 per-line identity; later lines of the same message, at different offsets, still create the row). Requires SQLite 3.35+ for multiple ON CONFLICT clauses; verified against node:sqlite 3.50.4;
   - **cost is recomputed from the row's current counters**, not this line's payload: after a zeros-first write the row is a frozen partial, and a later real line must reprice the row it grew into. Counters only ever grow, so this is idempotent across replays. A field conflict (`agent_key`, `model` changing within one message) raises a `usage_message_field_conflict` warning issue rather than silently overwriting.

3. **B3 — identity, and why this is not JOI-259.** The upsert is on the **composite** `(run_id, usage_id)`. JOI-259 (ADR-0008) was a *global* `usage_id` sole-PK keying flaw: a hash of source location alone merged runs sharing a transcript file. The composite key cannot merge two runs — `run_id` is part of the key the conflict resolves on — so per-message keying inherits ADR-0008's guarantee rather than regressing it. FOC-381's acceptance criterion literally says "not an upsert on `usage_id`"; design B satisfies its intent (not keyed on `usage_id` *alone*) but not its wording. **Mateusz signed off this deviation from the AC's literal wording on 2026-09-26.**

4. **B4 — schema v8, additive.** `MIGRATION_VERSIONS.usageMessageId = 8`: nullable `usage_facts.message_id` added via a PRAGMA-guarded additive `ALTER TABLE`, placed after `migrateRunScopedUsage` (v5) in the migration sequence, plus an index on `(run_id, message_id)`. Additive only — no table rebuild, so v8 does not repeat v5's stop-the-world rebuild mechanics, only its single-writer *window* (see Consequences).

5. **B5 — history rewrite without deleting the event log.** A one-off command (`scripts/telemetry-usage-rewrite.mjs`, written alongside this ADR) repairs existing data **per `(run_id, source_path)` whose transcript still exists on disk**: it maps each stored event's offset back to its transcript line and writes `messageId` into the *event payload* (verifying the line's usage matches the stored counters), then in one transaction deletes that source's `usage_facts` rows (cost cascades) and reprojects its `usage.recorded` events through the same B2 upsert. **A source is only rewritten if its stored events can rebuild at least the rows that exist** — `telemetry-prune.mjs` deletes events, and rewriting such a source would lose data irreversibly. Sources that fail the coverage guard, or whose transcript is gone, keep their per-line rows (`message_id` NULL) and are flagged `usage_legacy_inflated` so every reader can see the caveat instead of discovering it. Events themselves are never deleted anywhere in this flow.

6. **B6 — canonical view, NULL-safe guard.** `canonical_usage` (and its JS twin `collapseUsageIslands`, changed together under the existing contract test in `scripts/telemetry-canonical.test.mjs`) gains `message_id` and a boundary rule: **two rows with different non-null `message_id` never merge** — ground truth splits the island regardless of identical tuple and small gap. Either side NULL (a legacy per-line row adjacent to a per-message row) falls through to the existing tuple+gap rule unchanged, so the deploy window cannot mis-split a message that straddles old and new code. The same non-null id on both sides also follows tuple+gap — layer 1 should already have made those rows identical, but the view's collapse must not depend on that.

FOC-381's "reproduce within 1%" verification is interpreted per PRD §10: the corpus has grown since 2026-09-19, so the re-ingested store is compared against an **independent per-message scan of the same corpus, by the same method** (sum over lines vs max per `message.id`, tokens = input + output + cache read + cache creation), within 1% per squad, with the 2026-09-19 factors as a sanity bound. The method is a committed reference script (`scripts/telemetry-message-scan.mjs`), not a session's scratch.

## Consequences

- **Positive:**
  - Fleet usage/cost totals become honest at the source layer, for every consumer of `usage_facts` — not only the canonical views. The ~2.1× inflation and the per-squad share distortion are gone for all new data.
  - The write side is idempotent and order-independent (MAX/MIN upsert): replay, partial ingest, late flushes and re-ingest all converge to the same rows with no hold-back state machine.
  - The event log keeps its per-line shape and ADR-0008 keys — dedup moved layers without invalidating any stored event; old events replay correctly through the new projection.
  - The canonical view's known false-merge (identical adjacent tuples collapsing two distinct messages) is closed where both rows carry ids; attribution confidence stops depending on a statistical guess for message boundaries.
  - History repair is selective and guarded: only sources whose events provably cover the existing rows are rewritten; everything else is explicitly flagged, never silently lost.
- **Negative:**
  - **MAX assumes usage counters on a message's later lines are ≥ earlier ones.** Zeros-first lines exist (some transcript lines carry zeros before the real total), which MAX handles correctly; but a message whose real usage *decreased* across lines would be over-stated by taking the maximum. Not observed in the corpus — the scan found none — but the write side cannot distinguish "decrease" from "line repeat" without a full message re-read, and this trade-off is accepted.
  - **Legacy rows remain**: sources pruned of their events or with missing transcripts keep per-line rows, `message_id` NULL, flagged `usage_legacy_inflated`. Every honest reader must still carry that caveat, and the view's tuple+gap heuristic still runs for exactly those rows — the read-side fix is not retired, only narrowed to genuinely unrecoverable history.
  - The deploy window straddles: rows written by pre-FOC-381 code squat offsets next to per-message rows; the trailing `ON CONFLICT DO NOTHING` and the view's NULL-fallthrough absorb this, at the cost of these two permanently-present special cases in the code.
- **Risks:**
  - **The production migration must happen in a single-writer window (ADR-0008)**: merging this code to `main` makes the *next* store open apply v8 — whichever process gets there first (the Supervisor, the `:7331` dashboard's 15 s re-ingest loop). Per PRD §7.1, the merge and the controlled window (stop Supervisor and server, `VACUUM INTO` snapshot, migrate + rewrite, verify, restart) are one event, taken only on Mateusz's explicit go.
  - The B5 rewrite and v8 migration race if run against the live store from the dev worktree — mitigated by the branch's `LA_TELEMETRY_HOME` pointing at a dev copy; nothing on this branch opens the live store before the window.
  - Multiple ON CONFLICT clauses need SQLite ≥ 3.35; node:sqlite 3.50.4 satisfies it, but any future engine swap re-opens that assumption (a test pins it).

## Alternatives Considered

1. **Deduplicate at event emission (the first design)** — Rejected: a message is frozen at emission (`eventAlreadyApplied` drops later payloads, `usage_facts` is `INSERT OR IGNORE`), and transcripts demonstrably receive their last lines after the run manifest is written, so the decision would be made on incomplete data with no way to correct it later. Moving dedup to the projection is what makes monotonic repair possible.
2. **Global `usage_id` upsert (`usage_id = sha256(path:msg:<id>)` as sole key, no `run_id`)** — Rejected: this is the JOI-259 regression ADR-0008 closed — a key that ignores `run_id` merges runs sharing a transcript file and silently loses one run's usage. The composite `(run_id, usage_id)` key keeps ADR-0008's guarantee.
3. **Delete history and re-ingest from transcripts** — Rejected: `telemetry-prune.mjs` deletes events, so some sources' stored rows exist *only* in `usage_facts` with no event to rebuild from; re-ingest cannot restore what the event log no longer holds, and pruned data would be lost irreversibly. The B5 payload-enrichment path repairs what provably can be repaired and flags the rest.
4. **Keep the read-side island heuristic only (status quo, FOC-221)** — Rejected: it is a heuristic with a known false-merge, it corrects only consumers that go through the canonical views (every other `usage_facts` reader stays inflated), it costs ~12.9 s per pass over the raw table, and its per-squad residual error is exactly what made the 2026-09-19 squad shares wrong in the first place.
