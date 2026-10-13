// FOC-769 slice S5b — the Supervisor declares its focus: the run_focus
// projection and the ticket cost report.
//
// Covers the plan's verification list: focus switch, two tickets in flight,
// missing focus, out-of-order convergence, replay idempotence, and the CLI
// (JSON output, read-only open, a store without run_focus). The store is
// always a temp dir — never the real telemetry home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

// Route every store write into a temp dir BEFORE the module under test is
// imported — same pattern as telemetry-resume.test.mjs.
const temp = mkdtempSync(join(tmpdir(), "ticket-cost-test-"));
const dbPath = join(temp, "telemetry.sqlite");
process.env.LA_TELEMETRY_HOME = temp;
process.env.LA_TELEMETRY_DB = dbPath;

const { openTelemetryDb, makeEvent, applyEvent, ticketCostReport, pricingSnapshot } = await import("./telemetry-store.mjs");

// Expected costs derive from the same pricing snapshot the store prices
// through, not from literals (rate literals broke on the 2026-09-15 price
// sync). Every fixture message bills input tokens only, output 0.
const PRICE_INPUT = pricingSnapshot().prices["deepseek/deepseek-v4-flash"].input;
const costOf = (inputTokens) => (inputTokens * PRICE_INPUT) / 1_000_000;
const close = (a, b) => Math.abs(a - b) < 1e-9;

let usageSeq = 0;

function usage(db, runId, at, inputTokens, { messageId = null, usageId = null, model = "deepseek-v4-flash" } = {}) {
  usageSeq++;
  return applyEvent(db, makeEvent("usage.recorded", {
    runId, agentKey: "_lead", model,
    observedAt: at, inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    ...(messageId ? { messageId } : {}), ...(usageId ? { usageId } : {}),
  }, {
    runId, observedAt: at, sourceKind: "transcript",
    sourcePath: `C:/sessions/${runId}.jsonl`, sourceOffset: usageSeq,
  }));
}

function focus(db, runId, at, kind, taskId, line) {
  return applyEvent(db, makeEvent("supervisor.focus", { runId, kind, taskId, at, source: "test", note: null }, {
    runId, observedAt: at, sourceKind: "supervisor-focus",
    sourcePath: `C:/state/${runId}/focus.jsonl`, sourceOffset: line,
  }));
}

function startRun(db, runId, squad, at) {
  return applyEvent(db, makeEvent("run.started", { runId, squad, startedAt: at }, {
    runId, observedAt: at, sourceKind: "test",
  }));
}

function link(db, runId, taskId, at) {
  return applyEvent(db, makeEvent("task.linked", { runId, taskId, source: "launch", confidence: 1 }, {
    runId, observedAt: at, sourceKind: "test",
  }));
}

/** Supervisor run + two linked child runs, the standard fixture skeleton. */
function supervisorFixture(db, { supervisorRun = "sup-1", at }) {
  startRun(db, supervisorRun, "supervisor", at);
  startRun(db, "child-1", "dev", at);
  startRun(db, "child-2", "dev", at);
  link(db, "child-1", "FOC-1", at);
  link(db, "child-2", "FOC-2", at);
}

function runFocusRows(db, runId) {
  return db.prepare(
    "SELECT valid_from, valid_to, task_id, kind FROM run_focus WHERE run_id=? ORDER BY valid_from",
  ).all(runId).map((row) => ({ ...row })); // plain objects: sqlite rows have a null prototype
}

test("(a) focus switch: supervisor messages land in the right buckets", () => {
  const db = openTelemetryDb(join(temp, "a.sqlite"));
  supervisorFixture(db, { at: "2026-10-13T08:00:00.000Z" });
  focus(db, "sup-1", "2026-10-13T08:10:00.000Z", "ticket", "FOC-1", 0);
  focus(db, "sup-1", "2026-10-13T08:20:00.000Z", "overhead", null, 1);
  focus(db, "sup-1", "2026-10-13T08:30:00.000Z", "ticket", "FOC-2", 2);

  usage(db, "child-1", "2026-10-13T08:12:00.000Z", 100_000, { messageId: "m-c1" });
  usage(db, "sup-1", "2026-10-13T08:15:00.000Z", 50_000, { messageId: "m-s1" }); // → FOC-1
  usage(db, "child-2", "2026-10-13T08:22:00.000Z", 200_000, { messageId: "m-c2" });
  usage(db, "sup-1", "2026-10-13T08:25:00.000Z", 30_000, { messageId: "m-s2" }); // → overhead
  usage(db, "sup-1", "2026-10-13T08:35:00.000Z", 20_000, { messageId: "m-s3" }); // → FOC-2

  const report = ticketCostReport(db);
  assert.deepEqual(report.tickets.map((t) => t.taskId), ["FOC-2", "FOC-1"]); // sorted totalUsd desc
  const foc2 = report.tickets[0];
  const foc1 = report.tickets[1];
  assert.ok(close(foc1.childrenUsd, costOf(100_000)), `FOC-1 childrenUsd=${foc1.childrenUsd}`);
  assert.ok(close(foc1.supervisorUsd, costOf(50_000)), `FOC-1 supervisorUsd=${foc1.supervisorUsd}`);
  assert.ok(close(foc1.totalUsd, costOf(150_000)), `FOC-1 totalUsd=${foc1.totalUsd}`);
  assert.equal(foc1.messages, 2);
  assert.ok(close(foc2.childrenUsd, costOf(200_000)), `FOC-2 childrenUsd=${foc2.childrenUsd}`);
  assert.ok(close(foc2.supervisorUsd, costOf(20_000)), `FOC-2 supervisorUsd=${foc2.supervisorUsd}`);
  assert.equal(foc2.messages, 2);
  assert.ok(close(report.overheadUsd, costOf(30_000)), `overheadUsd=${report.overheadUsd}`);
  assert.equal(report.unattributedUsd, 0);
  assert.equal(report.untaggedChildrenUsd, 0);
  assert.ok(close(report.supervisor.totalUsd, costOf(100_000)), `supervisor totalUsd=${report.supervisor.totalUsd}`);
  assert.ok(close(report.supervisor.attributedShare, 1), `attributedShare=${report.supervisor.attributedShare}`);
  assert.equal(report.unpricedMessages, 0);
  assert.equal(report.legacyRows, 0);
  db.close();
});

test("(b) two tickets in flight: children keep their own tickets, Supervisor share only to the declared focus", () => {
  const db = openTelemetryDb(join(temp, "b.sqlite"));
  supervisorFixture(db, { at: "2026-10-13T09:00:00.000Z" });
  focus(db, "sup-1", "2026-10-13T09:00:00.000Z", "ticket", "FOC-1", 0);

  // Both children run at the same time; the focus stays FOC-1 throughout.
  usage(db, "child-1", "2026-10-13T09:05:00.000Z", 100_000, { messageId: "b-c1" });
  usage(db, "child-2", "2026-10-13T09:06:00.000Z", 300_000, { messageId: "b-c2" });
  usage(db, "sup-1", "2026-10-13T09:07:00.000Z", 50_000, { messageId: "b-s1" });

  const report = ticketCostReport(db);
  const foc1 = report.tickets.find((t) => t.taskId === "FOC-1");
  const foc2 = report.tickets.find((t) => t.taskId === "FOC-2");
  assert.ok(foc1 && foc2, `both tickets present: ${JSON.stringify(report.tickets)}`);
  assert.ok(close(foc1.childrenUsd, costOf(100_000)), `FOC-1 childrenUsd=${foc1.childrenUsd}`);
  assert.ok(close(foc1.supervisorUsd, costOf(50_000)), `FOC-1 supervisorUsd=${foc1.supervisorUsd}`);
  assert.ok(close(foc2.childrenUsd, costOf(300_000)), `FOC-2 childrenUsd=${foc2.childrenUsd}`);
  assert.ok(close(foc2.supervisorUsd, 0), `FOC-2 supervisorUsd=${foc2.supervisorUsd} (focus was FOC-1)`);
  assert.equal(report.overheadUsd, 0);
  db.close();
});

test("(c) missing focus: supervisor messages before the first focus stay unattributed, share < 1", () => {
  const db = openTelemetryDb(join(temp, "c.sqlite"));
  supervisorFixture(db, { at: "2026-10-13T08:00:00.000Z" });
  usage(db, "sup-1", "2026-10-13T08:05:00.000Z", 40_000, { usageId: "legacy-s1" }); // no message_id
  focus(db, "sup-1", "2026-10-13T08:10:00.000Z", "ticket", "FOC-1", 0);
  usage(db, "sup-1", "2026-10-13T08:15:00.000Z", 60_000, { messageId: "c-s2" });

  const report = ticketCostReport(db);
  assert.ok(close(report.unattributedUsd, costOf(40_000)), `unattributedUsd=${report.unattributedUsd}`);
  const foc1 = report.tickets.find((t) => t.taskId === "FOC-1");
  assert.ok(close(foc1.supervisorUsd, costOf(60_000)), `FOC-1 supervisorUsd=${foc1.supervisorUsd}`);
  const expectedShare = costOf(60_000) / (costOf(40_000) + costOf(60_000));
  assert.ok(close(report.supervisor.attributedShare, expectedShare) && report.supervisor.attributedShare < 1,
    `attributedShare=${report.supervisor.attributedShare}`);
  assert.equal(report.legacyRows, 1);
  db.close();
});

test("(d) focus events applied out of order converge to the same valid_to", () => {
  const db = openTelemetryDb(join(temp, "d.sqlite"));
  supervisorFixture(db, { at: "2026-10-13T08:00:00.000Z" });
  // Arrival order reversed relative to the timeline.
  focus(db, "sup-1", "2026-10-13T08:30:00.000Z", "ticket", "FOC-2", 2);
  focus(db, "sup-1", "2026-10-13T08:10:00.000Z", "ticket", "FOC-1", 0);
  focus(db, "sup-1", "2026-10-13T08:20:00.000Z", "overhead", null, 1);

  assert.deepEqual(runFocusRows(db, "sup-1"), [
    { valid_from: "2026-10-13T08:10:00.000Z", valid_to: "2026-10-13T08:20:00.000Z", task_id: "FOC-1", kind: "ticket" },
    { valid_from: "2026-10-13T08:20:00.000Z", valid_to: "2026-10-13T08:30:00.000Z", task_id: null, kind: "overhead" },
    { valid_from: "2026-10-13T08:30:00.000Z", valid_to: null, task_id: "FOC-2", kind: "ticket" },
  ]);

  usage(db, "sup-1", "2026-10-13T08:05:00.000Z", 10_000, { messageId: "d-s0" }); // before any focus
  usage(db, "sup-1", "2026-10-13T08:25:00.000Z", 30_000, { messageId: "d-s2" }); // overhead window
  usage(db, "sup-1", "2026-10-13T08:35:00.000Z", 20_000, { messageId: "d-s3" }); // FOC-2 window
  const report = ticketCostReport(db);
  assert.ok(close(report.unattributedUsd, costOf(10_000)), `unattributedUsd=${report.unattributedUsd}`);
  assert.ok(close(report.overheadUsd, costOf(30_000)), `overheadUsd=${report.overheadUsd}`);
  const foc2 = report.tickets.find((t) => t.taskId === "FOC-2");
  assert.ok(close(foc2.supervisorUsd, costOf(20_000)), `FOC-2 supervisorUsd=${foc2.supervisorUsd}`);
  db.close();
});

test("(e) replaying the same supervisor.focus event is idempotent (one run_focus row)", () => {
  const db = openTelemetryDb(join(temp, "e.sqlite"));
  supervisorFixture(db, { at: "2026-10-13T08:00:00.000Z" });
  const event = makeEvent("supervisor.focus", {
    runId: "sup-1", kind: "ticket", taskId: "FOC-1", at: "2026-10-13T08:10:00.000Z", source: "test", note: null,
  }, {
    runId: "sup-1", observedAt: "2026-10-13T08:10:00.000Z", sourceKind: "supervisor-focus",
    sourcePath: "C:/state/sup-1/focus.jsonl", sourceOffset: 0,
  });
  assert.equal(applyEvent(db, event).duplicate, undefined, "first application is not a duplicate");
  // Same event id, and a different event id with the same source identity —
  // both must dedup to a no-op.
  assert.equal(applyEvent(db, event).duplicate, true);
  assert.equal(applyEvent(db, makeEvent("supervisor.focus", {
    runId: "sup-1", kind: "ticket", taskId: "FOC-1", at: "2026-10-13T08:10:00.000Z", source: "test", note: null,
  }, {
    runId: "sup-1", observedAt: "2026-10-13T08:10:00.000Z", sourceKind: "supervisor-focus",
    sourcePath: "C:/state/sup-1/focus.jsonl", sourceOffset: 0,
  })).duplicate, true);
  // Even a same-`at` row with a different source identity is absorbed by the
  // PK (run_id, valid_from) — the interval set never doubles.
  focus(db, "sup-1", "2026-10-13T08:10:00.000Z", "ticket", "FOC-1", 7);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_focus WHERE run_id='sup-1'").get().n, 1);
  assert.deepEqual(runFocusRows(db, "sup-1"), [
    { valid_from: "2026-10-13T08:10:00.000Z", valid_to: null, task_id: "FOC-1", kind: "ticket" },
  ]);
  db.close();
});

test("(e2) the handler rejects a malformed ticket id instead of storing a NULL-task row", () => {
  const db = openTelemetryDb(join(temp, "e2.sqlite"));
  try {
    supervisorFixture(db, { at: "2026-10-13T11:00:00.000Z" });
    // A distinct source offset per id: applyEvent logs the events row BEFORE
    // the handler runs, so a reused identity would dedup the second id away
    // before the handler could reject it.
    for (const [i, bad] of ["NOT-A-TICKET", "FOC", "12-3", "FOC_12"].entries()) {
      assert.throws(
        () => focus(db, "sup-1", "2026-10-13T11:10:00.000Z", "ticket", bad, i),
        /supervisor.focus ticket id must look like FOC-123/,
      );
    }
    // The same shape normalizeFocus produces — lowercase in, uppercased by
    // the store's own normalizeTaskId — still lands (fresh source offset, so
    // the identity is not absorbed by one of the rejected ids above).
    assert.equal(focus(db, "sup-1", "2026-10-13T11:20:00.000Z", "ticket", "foc-3", 4).duplicate, undefined);
    assert.deepEqual(runFocusRows(db, "sup-1"), [
      { valid_from: "2026-10-13T11:20:00.000Z", valid_to: null, task_id: "FOC-3", kind: "ticket" },
    ]);
  } finally {
    db.close();
  }
});

test("(f) CLI --json matches ticketCostReport and works read-only; a store without run_focus reports all-unattributed", () => {
  const fixturePath = join(temp, "f.sqlite");
  const fixtureDb = openTelemetryDb(fixturePath);
  supervisorFixture(fixtureDb, { at: "2026-10-13T08:00:00.000Z" });
  focus(fixtureDb, "sup-1", "2026-10-13T08:10:00.000Z", "ticket", "FOC-1", 0);
  focus(fixtureDb, "sup-1", "2026-10-13T08:20:00.000Z", "overhead", null, 1);
  usage(fixtureDb, "child-1", "2026-10-13T08:12:00.000Z", 100_000, { messageId: "f-c1" });
  usage(fixtureDb, "sup-1", "2026-10-13T08:15:00.000Z", 50_000, { messageId: "f-s1" });
  usage(fixtureDb, "sup-1", "2026-10-13T08:25:00.000Z", 30_000, { messageId: "f-s2" });
  const direct = ticketCostReport(fixtureDb);
  fixtureDb.close();

  const cli = spawnSync(process.execPath, [join(SCRIPTS, "ticket-cost.mjs"), "--db", fixturePath, "--json"], {
    encoding: "utf8",
    env: { ...process.env, LA_TELEMETRY_DB: fixturePath, LA_TELEMETRY_HOME: temp },
  });
  assert.equal(cli.status, 0, `exit ${cli.status}: ${cli.stderr}`);
  const fromCli = JSON.parse(cli.stdout);
  assert.deepEqual(fromCli, direct, "CLI JSON must equal the library report");

  // The same store minus run_focus: the report must not throw — every
  // Supervisor message is unattributed instead.
  const strippedPath = join(temp, "f-stripped.sqlite");
  const stripped = openTelemetryDb(strippedPath);
  supervisorFixture(stripped, { supervisorRun: "sup-2", at: "2026-10-13T10:00:00.000Z" });
  usage(stripped, "sup-2", "2026-10-13T10:05:00.000Z", 70_000, { messageId: "f-s3" });
  stripped.exec("DROP TABLE run_focus");
  stripped.close();

  const bare = spawnSync(process.execPath, [join(SCRIPTS, "ticket-cost.mjs"), "--db", strippedPath, "--json"], {
    encoding: "utf8",
    env: { ...process.env, LA_TELEMETRY_DB: strippedPath, LA_TELEMETRY_HOME: temp },
  });
  assert.equal(bare.status, 0, `exit ${bare.status}: ${bare.stderr}`);
  const bareReport = JSON.parse(bare.stdout);
  assert.ok(close(bareReport.unattributedUsd, costOf(70_000)), `bare unattributedUsd=${bareReport.unattributedUsd}`);
  assert.ok(close(bareReport.supervisor.attributedShare, 0), `bare attributedShare=${bareReport.supervisor.attributedShare}`);
  assert.deepEqual(bareReport.tickets, [], "no focus → no supervisor buckets (children none here)");

  // And the library path on a read-only connection without the table.
  const readOnly = new DatabaseSync(strippedPath, { readOnly: true });
  try {
    const report = ticketCostReport(readOnly);
    assert.ok(close(report.unattributedUsd, costOf(70_000)), `library unattributedUsd=${report.unattributedUsd}`);
  } finally {
    readOnly.close();
  }
});

test("(g) byDay: two days, every bucket placed by observed_at's UTC date; an undated row skips byDay only (FOC-785)", () => {
  const db = openTelemetryDb(join(temp, "g.sqlite"));
  try {
    supervisorFixture(db, { at: "2026-10-13T08:00:00.000Z" });
    focus(db, "sup-1", "2026-10-13T08:10:00.000Z", "ticket", "FOC-1", 0);
    focus(db, "sup-1", "2026-10-14T08:00:00.000Z", "overhead", null, 1);
    // child-3 has no task link → its spend lands in untaggedChildrenUsd at the
    // ticket level, but in byDay it is spend on children like any other child.
    startRun(db, "child-3", "dev", "2026-10-13T10:00:00.000Z");

    usage(db, "child-1", "2026-10-13T08:12:00.000Z", 100_000); // tagged child, day 1
    usage(db, "child-3", "2026-10-13T10:05:00.000Z", 10_000); // untagged child, day 1
    usage(db, "sup-1", "2026-10-13T08:05:00.000Z", 20_000); // before ANY focus → unattributed, day 1
    usage(db, "sup-1", "2026-10-13T08:15:00.000Z", 50_000); // → FOC-1, day 1
    // The FOC-1 focus interval is still valid until 10-14T08:00, so this row
    // is charged to FOC-1 — on day 2, like its observed_at says.
    usage(db, "sup-1", "2026-10-14T07:55:00.000Z", 20_000); // → FOC-1, day 2
    usage(db, "sup-1", "2026-10-14T08:05:00.000Z", 30_000); // overhead, day 2
    usage(db, "child-2", "2026-10-14T09:00:00.000Z", 70_000); // tagged child, day 2
    // No observed_at anywhere: counted in every total, in no byDay bucket.
    const undated = makeEvent("usage.recorded", {
      runId: "child-1", agentKey: "_lead", model: "deepseek-v4-flash",
      inputTokens: 5_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    }, {
      runId: "child-1", observedAt: null, sourceKind: "transcript",
      sourcePath: "C:/sessions/child-1-undated.jsonl", sourceOffset: ++usageSeq,
    });
    undated.observedAt = null;
    undated.payload.observedAt = null;
    applyEvent(db, undated);

    const report = ticketCostReport(db);
    assert.deepEqual(report.byDay.map((entry) => entry.day), ["2026-10-13", "2026-10-14"], "byDay sorted by day");
    const [day1, day2] = report.byDay;
    // Day 1: tagged + untagged children together, the unattributed row BEFORE
    // any focus, the FOC-1-charged Supervisor row.
    assert.ok(close(day1.childrenUsd, costOf(110_000)), `day1 children=${day1.childrenUsd}`);
    assert.ok(close(day1.supervisorUsd, costOf(50_000)), `day1 supervisor=${day1.supervisorUsd}`);
    assert.ok(close(day1.unattributedUsd, costOf(20_000)), `day1 unattributed=${day1.unattributedUsd}`);
    assert.equal(day1.overheadUsd, 0);
    // Day 2: the 07:55 row rides the still-open FOC-1 interval (charged to a
    // ticket, on its own day), 08:05 is the overhead interval's first spend.
    assert.ok(close(day2.childrenUsd, costOf(70_000)), `day2 children=${day2.childrenUsd}`);
    assert.ok(close(day2.supervisorUsd, costOf(20_000)), `day2 supervisor=${day2.supervisorUsd}`);
    assert.ok(close(day2.overheadUsd, costOf(30_000)), `day2 overhead=${day2.overheadUsd}`);
    assert.equal(day2.unattributedUsd, 0);
    // The undated row is only absent from byDay: FOC-1's children cost and the
    // grand totals still include it.
    const foc1 = report.tickets.find((t) => t.taskId === "FOC-1");
    assert.ok(close(foc1.childrenUsd, costOf(105_000)), `FOC-1 childrenUsd=${foc1.childrenUsd}`);
    assert.ok(close(foc1.supervisorUsd, costOf(70_000)), `FOC-1 supervisorUsd=${foc1.supervisorUsd}`);
    assert.ok(
      close(
        report.overheadUsd + report.unattributedUsd + report.untaggedChildrenUsd
        + report.tickets.reduce((sum, t) => sum + t.totalUsd, 0),
        costOf(305_000),
      ),
      "every priced row lands in exactly one ticket-level bucket",
    );
  } finally {
    db.close();
  }
});

test("(h) byModel: usd desc with a stable tiebreak, NULL model reports as (none), unpriced never folded as free (FOC-785)", () => {
  const db = openTelemetryDb(join(temp, "h.sqlite"));
  try {
    supervisorFixture(db, { at: "2026-10-13T08:00:00.000Z" });
    usage(db, "child-1", "2026-10-13T08:12:00.000Z", 100_000); // priced
    usage(db, "child-1", "2026-10-13T08:14:00.000Z", 30_000); // priced, same model
    // A real-shaped model name the price set does not know: priced nowhere,
    // so its usd stays 0 while its messages still count (and it drags
    // unpricedMessages — a NULL cost is unpriced, never free).
    usage(db, "child-2", "2026-10-13T09:00:00.000Z", 80_000, { messageId: "h-x1", model: "no-such-model" });
    usage(db, "child-2", "2026-10-13T09:05:00.000Z", 60_000, { messageId: "h-x2", model: "no-such-model" });
    // NULL model: priced nowhere by definition, reported as "(none)" and NOT
    // counted unpriced (synthetic rows are never priceable — the classification
    // costPanel applies).
    const unnamed = makeEvent("usage.recorded", {
      runId: "child-2", agentKey: "_lead", model: null,
      inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    }, {
      runId: "child-2", observedAt: "2026-10-13T09:10:00.000Z", sourceKind: "transcript",
      sourcePath: "C:/sessions/child-2-unnamed.jsonl", sourceOffset: ++usageSeq,
    });
    applyEvent(db, unnamed);

    const report = ticketCostReport(db);
    assert.deepEqual(report.byModel, [
      { model: "deepseek-v4-flash", usd: costOf(130_000), messages: 2 },
      { model: "(none)", usd: 0, messages: 1 },
      { model: "no-such-model", usd: 0, messages: 2 },
    ]);
    // "(none)" is a placeholder model, so only the genuinely unpriced named
    // model drags unpricedMessages.
    assert.equal(report.unpricedMessages, 2);
  } finally {
    db.close();
  }
});

test("human output: sub-cent cost is printed with significant digits, never a bare $0", () => {
  const subPath = join(temp, "sub.sqlite");
  const sub = openTelemetryDb(subPath);
  supervisorFixture(sub, { at: "2026-10-13T12:00:00.000Z" });
  focus(sub, "sup-1", "2026-10-13T12:10:00.000Z", "ticket", "FOC-1", 0);
  usage(sub, "child-1", "2026-10-13T12:12:00.000Z", 1, { messageId: "h-c1" }); // sub-cent child cost
  sub.close();

  const expected = costOf(1);
  assert.ok(expected > 0 && expected < 0.01, `precondition: costOf(1)=${expected} must be sub-cent and non-zero`);

  const cli = spawnSync(process.execPath, [join(SCRIPTS, "ticket-cost.mjs"), "--db", subPath], {
    encoding: "utf8",
    env: { ...process.env, LA_TELEMETRY_DB: subPath, LA_TELEMETRY_HOME: temp },
  });
  assert.equal(cli.status, 0, `exit ${cli.status}: ${cli.stderr}`);
  const row = cli.stdout.split("\n").find((line) => line.startsWith("FOC-1"));
  assert.ok(row, `FOC-1 row missing:\n${cli.stdout}`);
  const children = row.trim().split(/\s+/)[1];
  assert.ok(children !== "$0", `sub-cent cost collapsed to $0: ${children}`);
  const shown = Number(children.replace("$", ""));
  assert.ok(
    Math.abs(shown - expected) <= expected * 0.05,
    `children cell ${children} does not show costOf(1)=${expected} to 2 significant digits`,
  );
  // Zero stays zero — distinguishable from the sub-cent row above.
  assert.match(cli.stdout, /(^|\s)\$0(\s|$)/m, "an exactly-zero bucket must print $0");
});

