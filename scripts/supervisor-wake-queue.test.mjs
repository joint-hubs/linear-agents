// scripts/supervisor-wake-queue.test.mjs — exactly-once and crash-idempotent
// replay for the durable wake queue (FOC-608).
//
// What is pinned, and why it can fail loudly:
//   - EXACTLY-ONCE (AC1): a child exit observed N times, a gate re-scanned
//     across watcher restarts, and a stall re-sampled all produce ONE row — the
//     dedup key is the guarantee, not the caller's discipline;
//   - REPLAY (AC1): acks are persisted next to the queue, so a reader restart
//     re-delivers un-acked rows and never re-delivers acked ones;
//   - SEQ (AC1): monotonic and durable — a watcher restart continues from the
//     last VALID seq, so --ack <seq> stays unambiguous even after a torn
//     trailing line (the one shape a crash mid-append leaves);
//   - THE SEAM (AC3): every fixture runs under LA_SUPERVISOR_STATE_HOME pointed
//     at a mkdtemp dir, and one assertion proves the queue materialises there —
//     not in the repo's real .state/supervisor/.
//
// HERMETIC. Only scripts/supervisor-lib.mjs is imported (no telemetry store, no
// node:sqlite); every write lands under a temp state home; the repo's real
// .state/supervisor/ is never created or touched.

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";

import {
  ROOT,
  appendWakeEvent,
  readWakeAck,
  readWakeQueue,
  supervisorStateHome,
  wakeQueuePath,
  wakeDedupKey,
  writeWakeAck,
  writeRegistry,
} from "./supervisor-lib.mjs";

// THE SEAM, set before anything resolves runDir. supervisor-lib reads the env
// per call, so this redirects every path helper from here on.
function fixtureHome(name) {
  const home = mkdtempSync(join(tmpdir(), `foc-608-${name}-`));
  process.env.LA_SUPERVISOR_STATE_HOME = home;
  return home;
}

function fixtureRun(home, runId) {
  process.env.LA_SUPERVISOR_STATE_HOME = home;
  writeRegistry(runId, { runId, children: {}, rounds: {} });
  return runId;
}

const exitEvent = (childId, turn, extra = {}) => ({
  event: "exit",
  childId,
  turn,
  detail: { status: "exited", exitCode: 0, ...extra },
});

describe("FOC-608 wake queue — the state-home seam (AC3)", () => {
  it("the queue materialises under LA_SUPERVISOR_STATE_HOME, not the repo's .state", () => {
    const home = fixtureHome("seam");
    const runId = fixtureRun(home, `seam-${Date.now()}`);

    const row = appendWakeEvent(runId, exitEvent("dev-1", 0));

    assert.ok(row, "the exit row was appended");
    assert.ok(
      wakeQueuePath(runId).startsWith(home),
      `queue path must be under the temp state home, got ${wakeQueuePath(runId)}`,
    );
    assert.ok(existsSync(join(home, runId, "wake-queue.jsonl")), "queue file exists under the temp home");
    assert.equal(
      existsSync(join(ROOT, ".state", "supervisor", runId)),
      false,
      "nothing was written to the repo's real supervisor state dir",
    );
    assert.equal(supervisorStateHome(), home, "supervisorStateHome() resolves to the seam");
  });
});

describe("FOC-608 wake queue — exactly once (AC1)", () => {
  it("a child exit observed twice produces one row", () => {
    const home = fixtureHome("exit-once");
    const runId = fixtureRun(home, `exit-once-${Date.now()}`);

    const first = appendWakeEvent(runId, exitEvent("dev-1", 0));
    // Two polls (or a watcher that re-reads the registry before exiting) see
    // the same turn end. Same dedup key — exit:<childId>:<turn> — so the second
    // observation is a no-op, not a second row.
    const second = appendWakeEvent(runId, exitEvent("dev-1", 0, { reobserved: true }));

    assert.ok(first, "first observation appends");
    assert.equal(second, null, "second observation of the same exit is a no-op");
    assert.deepEqual(
      readWakeQueue(runId).map((r) => r.dedupKey),
      [wakeDedupKey(exitEvent("dev-1", 0))],
      "exactly one row on disk",
    );
  });

  it("a new gate produces one row across scans and a watcher restart", () => {
    const home = fixtureHome("gate-once");
    const runId = fixtureRun(home, `gate-once-${Date.now()}`);

    appendWakeEvent(runId, { event: "gate", gateId: "gate-1", childId: "dev-1", detail: { kind: "question" } });
    // A scanner tick later, then a RESTARTED watcher (fresh module instance,
    // state read back from disk — the same thing a real restart does):
    appendWakeEvent(runId, { event: "gate", gateId: "gate-1", childId: "dev-1", detail: { kind: "question" } });
    const restarted = import("./supervisor-lib.mjs?restart=1");
    return restarted.then((lib) => {
      const third = lib.appendWakeEvent(runId, {
        event: "gate",
        gateId: "gate-1",
        childId: "dev-1",
        detail: { kind: "question" },
      });
      assert.equal(third, null, "the restarted watcher does not re-issue the gate row");
      assert.equal(readWakeQueue(runId).length, 1, "exactly one row for the gate");
    });
  });

  it("a stall re-sampled every tick stays one row per turn", () => {
    const home = fixtureHome("stall-once");
    const runId = fixtureRun(home, `stall-once-${Date.now()}`);

    appendWakeEvent(runId, { event: "stall", childId: "dev-1", turn: 2, detail: { silentMs: 600_000 } });
    for (let i = 0; i < 3; i++) {
      appendWakeEvent(runId, { event: "stall", childId: "dev-1", turn: 2, detail: { silentMs: 605_000 } });
    }
    const rows = readWakeQueue(runId);
    assert.equal(rows.length, 1, "one stall row per turn");
    assert.equal(rows[0].event, "stall");
  });

  it("an unknown event class is refused, not silently queued", () => {
    const home = fixtureHome("unknown");
    const runId = fixtureRun(home, `unknown-${Date.now()}`);
    assert.throws(() => appendWakeEvent(runId, { event: "vibes", childId: "dev-1" }));
  });
});

describe("FOC-608 wake queue — monotonic seq and crash-idempotent replay (AC1)", () => {
  it("seq continues from the last VALID line after a torn trailing line", () => {
    const home = fixtureHome("torn");
    const runId = fixtureRun(home, `torn-${Date.now()}`);

    appendWakeEvent(runId, exitEvent("dev-1", 0));
    appendWakeEvent(runId, { event: "gate", gateId: "g1", childId: "dev-1", detail: {} });

    // Simulate a crash mid-append: a partial JSON line at the tail.
    appendFileSync(wakeQueuePath(runId), '{"seq":3,"event":"ex');

    const rows = readWakeQueue(runId);
    assert.equal(rows.length, 2, "the torn line is not a row");

    // A restarted watcher (fresh module instance) must not reissue seq 3 or
    // collide with it.
    return import("./supervisor-lib.mjs?restart=2").then((lib) => {
      const row = lib.appendWakeEvent(runId, { event: "stall", childId: "dev-1", turn: 0, detail: {} });
      assert.equal(row.seq, 3, "seq continues from the last valid line");
    });
  });

  it("crash-replay: acked rows never come back, un-acked survive a reader restart", () => {
    const home = fixtureHome("replay");
    const runId = fixtureRun(home, `replay-${Date.now()}`);

    for (let turn = 0; turn < 5; turn++) appendWakeEvent(runId, exitEvent("dev-1", turn));

    // The Supervisor handles rows 1..3 and acks through 3 — persisted, not
    // in-process.
    writeWakeAck(runId, 3);
    assert.equal(readWakeAck(runId), 3, "the watermark is on disk");

    // Reader restart: everything is re-read from disk, nothing from memory.
    return import("./supervisor-lib.mjs?restart=3").then((lib) => {
      const acked = lib.readWakeAck(runId);
      const unacked = lib.readWakeQueue(runId).filter((r) => r.seq > acked);
      assert.equal(acked, 3, "acks survive the restart");
      assert.deepEqual(
        unacked.map((r) => r.seq),
        [4, 5],
        "un-acked rows survive the restart",
      );
      // An ack that arrives late (or is retried) never moves the watermark
      // backwards over a row already retired.
      assert.equal(lib.writeWakeAck(runId, 2), 3, "the watermark never moves backwards");
    });
  });

  it("a row appended after the watermark is redelivered, never lost", () => {
    const home = fixtureHome("disagree");
    const runId = fixtureRun(home, `disagree-${Date.now()}`);

    appendWakeEvent(runId, exitEvent("dev-1", 0));
    writeWakeAck(runId, 1);
    // Crash between the watcher's append and the Supervisor's next drain: the
    // queue row exists, the watermark does not cover it. Redelivery is the
    // contract — the queue points at facts in the registry/gates/tee, so
    // judging twice is safe and losing one is not.
    appendWakeEvent(runId, exitEvent("dev-2", 0));

    const unacked = readWakeQueue(runId).filter((r) => r.seq > readWakeAck(runId));
    assert.deepEqual(
      unacked.map((r) => r.dedupKey),
      [wakeDedupKey(exitEvent("dev-2", 0))],
      "the post-ack row is redelivered on the next drain",
    );
  });
});

after(() => {
  delete process.env.LA_SUPERVISOR_STATE_HOME;
});
