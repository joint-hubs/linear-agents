# FOC-761 — telemetry fix + one-time re-ingest into the LIVE store: plan for Mateusz

**Status: plan only, nothing has been written to the live store.** Mateusz asked for this plan
before any re-ingest happens ("plan ingestu najpierw do mnie"); no child opens the live store for
writing at any point. Owner of the execution: the Supervisor, after his go-ahead.

**Scope note.** FOC-760 (watcher cost) and FOC-761 (telemetry drops resumed turns) are accepted
together by ONE reconciliation script. This document is only FOC-761's part — the store change and
the one-time repair. It does not touch the FOC-477 instrument and does not move the instrument
boundary.

## 1. What is broken (root cause, read in source)

A resumed turn never reaches the telemetry store.

1. `supervisor-followup.mjs` reuses the child's `telemetryRunId`, and the watcher ends the run again
   through `run-manifest end`.
2. The second `run.ended` event carries the **same source identity** as the first one —
   `(run_id, source_kind="manifest", source_path=<manifest>, source_offset=1, event_type="run.ended")`
   — so `eventAlreadyApplied` (`telemetry-store.mjs:1158-1174`) reports it as a duplicate and
   `applyEvent` drops it.
3. `runs.ended_at` therefore stays at the end of turn 1.
4. `settledRun` (`telemetry-ingest.mjs:966-978`) then returns `true` five minutes later: the status
   is terminal, the end time is old, and every `transcript_sources` row is `parse_status='parsed'`.
   `ingestKnownRuns` skips the run entirely (`telemetry-ingest.mjs:1003`), so the transcript lines
   the resumed turns appended are **never parsed**.

Measured effect (review F5): single-turn children are exact (1.00 x ground truth); multi-turn
children hold **0.25 x** — 109 of 188 have their later turns completely absent. Telemetry is used
for shares and per-model attribution, so this biases every multi-turn number it feeds.

The skip cache is **not** the culprit: `ingestTranscript` compares `file_size` and re-reads from
`byte_offset` when the file grew (`telemetry-ingest.mjs:582-611`). The run is skipped before the
transcript is even looked at.

## 2. The fix (FOC-761, code)

**A — re-open the run on resume (primary).** When `supervisor-followup.mjs` starts a resumed turn,
the watcher emits an event that puts the run back to `running` and clears `runs.ended_at`.
`settledRun` then stays false for the whole turn, the transcript keeps being read, and the turn's
lines land as they are written. This also covers a child that crashes mid-turn: its lines are
already in.

**B — per-turn identity for `run.ended` (belt and braces).** Give each turn's `run.ended` a source
identity that includes the turn, so the second one is not a duplicate. Without A this would only
help after a turn ends (the run is still skipped while the turn runs), so it complements A rather
than replacing it.

Both are changes to `supervisor-watch.mjs` / `supervisor-followup.mjs` / `telemetry-store.mjs` —
**not** to `graph-runner.mjs`, and not to any FOC-477 config. Nothing about the instrument moves.

## 3. The one-time re-ingest (the part that needs his go-ahead)

**What it writes.** Only the live telemetry database. No git state, no Linear, no run registry.

**Scope.** Every run whose transcript on disk is **larger** than the `file_size` recorded in its
`transcript_sources` row while `parse_status='parsed'` — i.e. the file grew after the last parsed
pass. That is the conservative set: it contains exactly the runs whose data is missing, and nothing
that was parsed completely. The review found 109 of 188 multi-turn children with their later turns
completely absent (F5); the exact set is whatever the dry run reports, and it is printed before
anything is written.

**Mechanism.** For each run in that set, reset its `transcript_sources` skip-cache row (the same
reset `telemetry-ingest.mjs` already does on a shrink) and let the normal ingest re-read the file.

**Why this is idempotent.** Re-reading from offset 0 re-emits every line, and `eventAlreadyApplied`
absorbs each one that already landed (same `run_id, source_kind, source_path, source_offset,
event_type`), so only the previously-missing lines become new rows. `usage_facts` merges per
`message.id` with `MAX()` counters (`applyUsageMessage`, FOC-381 B2), so a re-applied line can never
raise a total. Running it twice is a no-op the second time — that is part of the acceptance check.

**Safety.**
1. **Dry run first.** The script prints, per run: current `file_size`, recorded `file_size`, the
   number of lines it would parse, and the number of events it expects to apply. Nothing is written.
2. **Backup.** Copy the live `.db` file to `.state/telemetry-backup/<timestamp>/` before the write
   and keep it until the acceptance check passes. Rollback = restore that copy.
3. **Executor.** The Supervisor runs it directly. A child may write the script, but no child opens
   the live store — read-only access only.
4. **Acceptance.** The FOC-760/761 reconciliation script compares registry / telemetry / transcript
   for every child with a transcript: multi-turn telemetry / ground truth >= 0.99 (today 0.25), and
   a second run of the re-ingest applies 0 events.

**Optional step, his call.** The re-ingest can also patch `runs.ended_at` for historical runs to the
timestamp of their last transcript line. It only affects when a run looks settled — it does not
change any cost. Recommended: **yes**, so historical runs stop being skipped for a reason that is
known to be wrong.

## 4. What I need from him

1. **Go-ahead to write to the live telemetry store** at all (the re-ingest). Without it FOC-761
   stays at the code fix only and every multi-turn telemetry number keeps its 0.25 factor.
2. **Scope**: the conservative set (transcript grew past the parsed size) — or every run, re-read
   from scratch? The conservative set is recommended; a full re-read is safer against a second,
   unknown class of loss but writes many more events and needs a longer window.
3. **`runs.ended_at` patch** for historical runs: yes / no (recommended yes).
4. **Backup retention**: until the acceptance check passes, or a fixed number of days (recommended
   7)?

## 5. Order in the queue

FOC-760 + FOC-761 land together, their one reconciliation script being the acceptance for both.
After FOC-758 lands and FOC-759's AC2 is ruled on. FOC-762–764 (M5) follow; the `agents/plan/**`
contract changes (FOC-763/764) wait until the FOC-477 campaign ends, because `plan.spec` runs as a
PLAN child in arm A and changing its contract mid-campaign moves the instrument.
