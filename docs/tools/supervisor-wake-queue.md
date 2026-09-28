# Supervisor wake queue — consumer contract (FOC-608)

What one drain of the durable wake queue hands the Supervisor, and what the
Supervisor owes back. Read by the frontman (`agents/supervisor/CLAUDE.md` §4)
and by any future consumer of child events (FOC-621). The runtime lives in
`scripts/supervisor-watch.mjs` (writer) and `scripts/supervisor-status.mjs`
(reader); the shared row/ack helpers live in `scripts/supervisor-lib.mjs`.

## Model

The watcher classifies events into `<runDir>/wake-queue.jsonl` — append-only,
one JSON row per line. The Supervisor drains the queue at the start of a turn,
handles each row, then acknowledges. **The model is never the waiter, only the
judge**: a `gate` or `exit` lands in the queue even when nobody was waiting.

Single-writer per file: the queue is written only by the watcher, the ack store
only by `supervisor-status.mjs`. Safe under the current one-live-child policy;
lifting that policy requires a real lock on the append path first (see the
comment on `appendWakeEvent`).

## CLI

```
node scripts/supervisor-status.mjs --drain --run <runId>   # un-acked rows + stalledChildren
node scripts/supervisor-status.mjs --ack <seq> --run <runId>  # retire rows through seq
```

`--drain` prints `{ ok, runId, mode: "drain", ackedThrough, unackedCount, totalRows, unacked[], stalledChildren[] }`.
`--ack` prints `{ ok, runId, mode: "ack", ackedThrough, unackedCount }` and
persists the watermark (never moves backwards).

## Row shape

| field | type | meaning |
|---|---|---|
| `seq` | number | monotonic, 1-based, durable across watcher restarts (max-on-file + 1) — `--ack <seq>` is unambiguous |
| `event` | `"exit" \| "gate" \| "stall"` | the three event classes |
| `childId` | string \| null | the child the event is about (always set except for a gate with no `childId` in its record) |
| `turn` | number | the child turn index the watcher was spawned for (0-based) |
| `gateId` | string \| null | gate identity, `gate` rows only |
| `dedupKey` | string | the exactly-once key — see table below |
| `detail` | object | event-specific: `exit` → `{ status, exitCode, spawnFailed? }`; `gate` → `{ kind }`; `stall` → `{ silentMs }` |
| `ts` | string | ISO timestamp of classification (not of the event itself) |

### De-dup keys — exactly one row per event

| event | key | why this identifies the event exactly once |
|---|---|---|
| `exit` | `exit:<childId>:<turn>` | a turn ends exactly once; the registry's `turns[]` already owns this identity, no parallel source of truth |
| `gate` | `gate:<gateId>` | gate identity; re-observed across scans and watcher restarts for free |
| `stall` | `stall:<childId>:<turn>` | the SLA breach is one event; the response (stop + escalate) does not scale with re-observations |

## Acks and crash semantics

Acks live in `<runDir>/wake-ack.json` — one small JSON file
(`{ ackedThrough, ackedAt }`) written through `atomicWriteJSON` (temp +
rename), so a torn ack record is impossible by construction; an append-log
would need partial-line tolerance for no gain. `--ack <seq>` retires rows
through `seq`; a reader restart never re-delivers acked rows.

When an ack and an append disagree (crash between the two), the outcome is
**redelivery, never loss**: the row exists and the watermark does not cover it,
so the next drain re-reads it. That is safe because a row is a pointer to facts
that live in the registry, the gate files and the tee — judging an event twice
is idempotent, losing one is not. The reverse (watermark past an append) cannot
happen: an ack is only written for a seq the acker read from the file.

A torn trailing line in `wake-queue.jsonl` (the one shape a crash mid-append
leaves) is skipped on read; the next append continues from the last valid seq.

## Stall semantics

`stall` fires when the child's tee has not grown for 5 × the base poll timeout
(`LA_SUPERVISOR_POLL_MS`, default 120 s → 10 min) — the same shared constant
(`stallSilenceMs()` in `supervisor-lib.mjs`) the status display uses. The
response to a stall row is the standing one: stop the child, escalate. Nothing
here probes a pid; the watcher owns liveness.
