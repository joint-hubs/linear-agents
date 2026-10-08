// scripts/foc-477-measure.test.mjs — FOC-477 measurement tabulator.
//
// Self-contained: synthesizes corpus + children.json fixtures in a temp
// directory at runtime. Never reads the real .state/supervisor/ history and
// depends on no gitignored path persisting between runs.
//
// The load-bearing assertions:
//   - cost comes from `costUsd`, NEVER `costUsdReported` (protocol §4.1, §9)
//   - gate-wait sits in its own column, excluded from exec time (§4.2)
//   - all three verdicts are reachable (GO / NO-GO / INCONCLUSIVE) (§5)
//   - missing arm A (today's normal state) and missing arm B degrade to a
//     flagged row with null ratios, exit 0 — never a crash, never a fake 0
//
// Run: node scripts/foc-477-measure.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  InputError,
  aggregate,
  childWallTime,
  decide,
  decideAxis,
  deriveGateFriction,
  extractArmFromChildren,
  loadArmFromDisk,
  median,
  pairRow,
  parseCorpus,
  ratioAB,
  resolveDefaultSupervisorDir,
  run,
} from "./foc-477-measure.mjs";

const T0 = "2026-10-06T10:00:00.000Z";

function iso(minute, second = 0) {
  return `2026-10-06T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

function child({ childId = "plan-1", taskId = "FOC-198", costUsd = 1, costUsdReported = 100, turns = [] } = {}) {
  return { childId, squad: "plan", taskId, status: "exited", costUsd, costUsdReported, turns };
}

function childrenJson(runId, ...children) {
  return JSON.stringify({
    runId,
    rounds: [],
    children: Object.fromEntries(children.map((c) => [c.childId, c])),
  });
}

// Two turns with a 30 s gate gap between them: exec 60 + 60 = 120 s,
// gate-wait 30 s, total 150 s.
function gatedTurns() {
  return [
    { startedAt: iso(0), endedAt: iso(1), exitCode: 0 },
    { startedAt: iso(1, 30), endedAt: iso(2, 30), exitCode: 0, gateId: "gate-plan-1-1" },
  ];
}

function corpusText(overrides = {}) {
  return JSON.stringify({
    protocol: "docs/plans/foc-477-measurement-protocol.md",
    qualityAxis: "A (body delta: edit count + chars)",
    corpus: [
      {
        issue: "FOC-198",
        estimate: 5,
        shape: "spike",
        armB: { runId: "run-b1", childId: "plan-1", status: "exited", costUsd: 1, turns: 2 },
        ...overrides.entry0,
      },
      {
        issue: "FOC-236",
        estimate: null,
        shape: "docs",
        armB: { runId: "run-b2", childId: "plan-1", status: "exited", costUsd: 1, turns: 1 },
        ...overrides.entry1,
      },
    ],
  });
}

// --- pure helpers ------------------------------------------------------------

describe("median", () => {
  it("odd count picks the middle", () => {
    assert.equal(median([3, 1, 2]), 2);
  });
  it("even count averages the two middles", () => {
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });
  it("ignores nulls; all-null is null", () => {
    assert.equal(median([1, null, 3, undefined]), 2);
    assert.equal(median([null, undefined]), null);
    assert.equal(median([]), null);
  });
});

describe("ratioAB", () => {
  it("computes A/B", () => {
    assert.equal(ratioAB(0.5, 1), 0.5);
    assert.equal(ratioAB(3, 2), 1.5);
  });
  it("is null when B is 0, or either side is missing", () => {
    assert.equal(ratioAB(1, 0), null);
    assert.equal(ratioAB(null, 1), null);
    assert.equal(ratioAB(1, null), null);
  });
});

describe("parseCorpus", () => {
  it("accepts a valid corpus (with or without armA)", () => {
    const doc = parseCorpus(corpusText());
    assert.equal(doc.corpus.length, 2);
    const withArmA = parseCorpus(corpusText({ entry0: { armA: { runId: "run-a1", childId: "plan-1" } } }));
    assert.equal(withArmA.corpus[0].armA.runId, "run-a1");
  });
  it("rejects unparseable JSON with InputError", () => {
    assert.throws(() => parseCorpus("{nope"), InputError);
  });
  it("rejects a document without a corpus array", () => {
    assert.throws(() => parseCorpus("{}"), InputError);
    assert.throws(() => parseCorpus('{"corpus": 3}'), InputError);
  });
  it("rejects entries missing issue or armB identity", () => {
    assert.throws(() => parseCorpus('{"corpus":[{"estimate":2}]}'), InputError);
    assert.throws(() => parseCorpus('{"corpus":[{"issue":"FOC-1","armB":{"childId":"c"}}]}'), InputError);
    assert.throws(() => parseCorpus('{"corpus":[{"issue":"FOC-1","armB":{"runId":"r"}}]}'), InputError);
  });
  it("rejects an armA block without a runId", () => {
    assert.throws(() => parseCorpus(corpusText({ entry0: { armA: { childId: "plan-1" } } })), InputError);
  });
  it("rejects runIds with characters outside [A-Za-z0-9._-] (they join a filesystem path)", () => {
    assert.throws(() => parseCorpus(corpusText({ entry0: { armB: { runId: "../evil", childId: "plan-1" } } })), InputError);
    assert.throws(() => parseCorpus(corpusText({ entry0: { armA: { runId: "a/b" } } })), InputError);
    assert.doesNotThrow(() => parseCorpus(corpusText({ entry0: { armB: { runId: "2026-10-06T15-09-19-713-supervisor-26c7", childId: "plan-1" } } })));
  });
  it("warns on duplicate issue entries without dropping either row", () => {
    const warnings = [];
    const doc = parseCorpus(JSON.stringify({
      corpus: [
        { issue: "FOC-1", armB: { runId: "r1", childId: "c" } },
        { issue: "FOC-1", armB: { runId: "r2", childId: "c" } },
      ],
    }), (m) => warnings.push(m));
    assert.equal(doc.corpus.length, 2);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("duplicate issue FOC-1"));
  });
  it("accepts an optional non-negative integer gateFriction on either arm; 0 is a real value", () => {
    const doc = parseCorpus(JSON.stringify({
      corpus: [
        {
          issue: "FOC-1",
          armA: { runId: "run-a1", gateFriction: 0 },
          armB: { runId: "run-b1", childId: "plan-1", gateFriction: 3 },
        },
      ],
    }));
    assert.equal(doc.corpus[0].armA.gateFriction, 0);
    assert.equal(doc.corpus[0].armB.gateFriction, 3);
  });
  it("rejects negative and non-integer gateFriction; null/absent pass through as no data", () => {
    const mk = (gfA, gfB) => JSON.stringify({
      corpus: [
        {
          issue: "FOC-1",
          armA: { runId: "run-a1", gateFriction: gfA },
          armB: { runId: "run-b1", childId: "plan-1", gateFriction: gfB },
        },
      ],
    });
    assert.throws(() => parseCorpus(mk(-1, undefined)), InputError);
    assert.throws(() => parseCorpus(mk(undefined, 1.5)), InputError);
    assert.throws(() => parseCorpus(mk("2", undefined)), InputError);
    assert.throws(() => parseCorpus(mk(true, undefined)), InputError);
    // null / absent mean "no data" and survive validation untouched — never coerced to 0
    assert.equal(parseCorpus(mk(null, undefined)).corpus[0].armA.gateFriction, null);
    assert.equal(parseCorpus(mk(undefined, undefined)).corpus[0].armB.gateFriction, undefined);
  });
});

describe("childWallTime", () => {
  it("sums turn spans as exec; inter-turn gaps are gate-wait in its own column", () => {
    const wt = childWallTime(gatedTurns());
    assert.equal(wt.execSec, 120);
    assert.equal(wt.gateWaitSec, 30);
    assert.equal(wt.totalSec, 150);
    assert.equal(wt.execSec + wt.gateWaitSec, wt.totalSec); // gate-wait excluded from exec
  });
  it("queue time is null — children.json records no child-level start", () => {
    assert.equal(childWallTime(gatedTurns()).queueSec, null);
  });
  it("a single turn has zero gate-wait", () => {
    const wt = childWallTime([{ startedAt: T0, endedAt: iso(1) }]);
    assert.equal(wt.execSec, 60);
    assert.equal(wt.gateWaitSec, 0);
  });
  it("turns without parseable timestamps are skipped; none valid → all null", () => {
    const wt = childWallTime([{ startedAt: null, endedAt: "garbage" }, gatedTurns()[0]]);
    assert.equal(wt.execSec, 60);
    assert.deepEqual(childWallTime([{ startedAt: "x", endedAt: "y" }]), {
      totalSec: null, queueSec: null, execSec: null, gateWaitSec: null,
    });
    assert.deepEqual(childWallTime(undefined), { totalSec: null, queueSec: null, execSec: null, gateWaitSec: null });
  });
});

describe("extractArmFromChildren", () => {
  it("reads costUsd, NEVER costUsdReported, even when they differ wildly", () => {
    const arm = extractArmFromChildren(
      JSON.parse(childrenJson("run-b1", child({ costUsd: 0.25, costUsdReported: 108.265 }))),
      { childId: "plan-1" },
    );
    assert.equal(arm.costUsd, 0.25);
    const dump = JSON.stringify(arm);
    assert.ok(!dump.includes("costUsdReported"), "costUsdReported must never be emitted");
  });
  it("matches the corpus childId and carries identity fields", () => {
    const parsed = JSON.parse(childrenJson("run-b1", child({ childId: "plan-4", taskId: "FOC-236" }), child()));
    const arm = extractArmFromChildren(parsed, { childId: "plan-4" });
    assert.equal(arm.status, "ok");
    assert.equal(arm.childId, "plan-4");
    assert.equal(arm.taskId, "FOC-236");
    assert.equal(arm.squad, "plan");
    assert.equal(arm.turns, 0);
  });
  it("unpinned childId takes the first child (arm-A case)", () => {
    const parsed = JSON.parse(childrenJson("run-a1", child({ childId: "graph-1" })));
    assert.equal(extractArmFromChildren(parsed, {}).childId, "graph-1");
  });
  it("an absent child is missing-child, not a crash", () => {
    assert.equal(extractArmFromChildren(JSON.parse(childrenJson("r", child())), { childId: "plan-9" }).status, "missing-child");
  });
  it("unpinned childId over a multi-child run warns instead of silently picking", () => {
    const parsed = JSON.parse(childrenJson("run-a1", child({ childId: "graph-1" }), child({ childId: "graph-2" })));
    const warnings = [];
    const arm = extractArmFromChildren(parsed, { warn: (m) => warnings.push(m) });
    assert.equal(arm.childId, "graph-1");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("2 children"));
  });
  it("a children.json without a children object is malformed input", () => {
    assert.throws(() => extractArmFromChildren({ runId: "r" }, { childId: "plan-1" }), InputError);
  });
});

describe("go/no-go rule (§5, amended Q3 2026-10-07 — two axes: cost, time)", () => {
  it("win: A below B*0.85; the 0.85 edge itself is NOT a win", () => {
    assert.equal(decideAxis(0.84, 1), "win");
    assert.equal(decideAxis(0.85, 1), "draw");
  });
  it("loss: A above B*1.05; the 1.05 edge itself is NOT a loss", () => {
    assert.equal(decideAxis(1.06, 1), "loss");
    assert.equal(decideAxis(1.05, 1), "draw");
  });
  it("between the edges is a draw — reportable, never a win", () => {
    assert.equal(decideAxis(0.95, 1), "draw");
  });
  it("unavailable medians give a null axis, not a verdict", () => {
    assert.equal(decideAxis(null, 1), null);
    assert.equal(decideAxis(1, null), null);
  });
  it("GO: both axes win — zero regressions", () => {
    assert.equal(decide({ cost: "win", timeExec: "win" }), "GO");
  });
  it("NO-GO: a loss or a draw on either axis blocks GO", () => {
    assert.equal(decide({ cost: "win", timeExec: "loss" }), "NO-GO");
    assert.equal(decide({ cost: "draw", timeExec: "win" }), "NO-GO");
    assert.equal(decide({ cost: "draw", timeExec: "draw" }), "NO-GO");
  });
  it("INCONCLUSIVE only when cost or timeExec has no median", () => {
    assert.equal(decide({ cost: "win", timeExec: null }), "INCONCLUSIVE");
    assert.equal(decide({ cost: null, timeExec: "win" }), "INCONCLUSIVE");
    assert.equal(decide({ cost: null, timeExec: null }), "INCONCLUSIVE");
  });
  it("the withdrawn quality axis never enters the decision", () => {
    // arm B records no bodyDelta — under the old 3-axis rule this corpus was
    // permanently INCONCLUSIVE; the amendment makes it a computable verdict
    assert.equal(decide({ cost: "win", timeExec: "win", quality: null }), "GO");
    assert.equal(decide({ cost: "win", timeExec: "win", quality: "loss" }), "GO");
    assert.equal(decide({ cost: "win", timeExec: "loss", quality: "win" }), "NO-GO");
  });
});

// --- pair rows + aggregate (in-memory) ---------------------------------------

describe("pairRow", () => {
  const entry = {
    issue: "FOC-198",
    estimate: 5,
    shape: "spike",
    armB: { runId: "run-b1", childId: "plan-1", status: "exited", costUsd: 1, turns: 2 },
  };

  it("computes ratios from costUsd and exec time when both arms have data", () => {
    const armB = {
      status: "ok", runId: "run-b1", childId: "plan-1", childStatus: "exited",
      costUsd: 1, turns: 2, wallTime: { totalSec: 150, queueSec: null, execSec: 120, gateWaitSec: 30 },
      bodyDelta: { editCount: null, charDelta: null }, escalations: null, gateAgreement: null,
    };
    const armA = {
      status: "ok", runId: "run-a1", childId: "graph-1", childStatus: "exited",
      costUsd: 0.5, turns: 1, wallTime: { totalSec: 90, queueSec: null, execSec: 60, gateWaitSec: 30 },
      bodyDelta: { editCount: 2, charDelta: -40 }, escalations: null, gateAgreement: null,
    };
    const row = pairRow(entry, armA, armB);
    assert.equal(row.metrics.costRatioAB, 0.5);
    // exec ratio uses exec (60/120 = 0.5), NOT wall total (which would be 0.6)
    assert.equal(row.metrics.execTimeRatioAB, 0.5);
    assert.equal(row.metrics.qualityDelta, null); // no body-delta source in either arm
    assert.equal(row.issue, "FOC-198");
    assert.equal(row.armA.runId, "run-a1");
  });
  it("quality delta is the edit-count difference when both arms record body delta", () => {
    const mk = (editCount) => ({
      status: "ok", runId: "r", childId: "c", childStatus: "exited", costUsd: 1, turns: 1,
      wallTime: { totalSec: 1, queueSec: null, execSec: 1, gateWaitSec: 0 },
      bodyDelta: { editCount, charDelta: null }, escalations: null, gateAgreement: null,
    });
    const row = pairRow(entry, mk(2), mk(5));
    assert.deepEqual(row.metrics.qualityDelta, { editCount: -3 });
  });
  it("quality is null (never 0) when no arm records body delta", () => {
    const okArm = {
      status: "ok", runId: "r", childId: "c", childStatus: "exited", costUsd: 1, turns: 1,
      wallTime: { totalSec: 1, queueSec: null, execSec: 1, gateWaitSec: 0 },
      bodyDelta: { editCount: null, charDelta: null }, escalations: null, gateAgreement: null,
    };
    const row = pairRow(entry, okArm, okArm);
    assert.equal(row.metrics.qualityDelta, null);
    assert.equal(row.armA.bodyDelta.editCount, null);
  });
  it("missing arm A is pending; missing arm B is flagged; ratios go null, not 0", () => {
    const okArm = {
      status: "ok", runId: "run-b1", childId: "plan-1", childStatus: "exited", costUsd: 1, turns: 2,
      wallTime: { totalSec: 150, queueSec: null, execSec: 120, gateWaitSec: 30 },
      bodyDelta: { editCount: null, charDelta: null }, escalations: null, gateAgreement: null,
    };
    const pending = pairRow(entry, { status: "pending" }, okArm);
    assert.equal(pending.armA.status, "pending");
    assert.equal(pending.armA.runId, null); // no armA field in the corpus → no runId invented
    assert.equal(pending.metrics.costRatioAB, null);

    const missingB = pairRow(entry, okArm, { status: "missing", runId: "run-b1" });
    assert.equal(missingB.armB.status, "missing");
    assert.equal(missingB.armB.runId, "run-b1"); // the corpus-named run is still named
    assert.equal(missingB.metrics.costRatioAB, null);
    assert.equal(missingB.metrics.execTimeRatioAB, null);
  });
  it("gate friction rides on each arm: absent stays null, explicit 0 stays 0", () => {
    const mk = (gateFriction) => ({
      status: "ok", runId: "r", childId: "c", childStatus: "exited", costUsd: 1, turns: 1,
      wallTime: { totalSec: 1, queueSec: null, execSec: 1, gateWaitSec: 0 },
      bodyDelta: { editCount: null, charDelta: null }, gateFriction, escalations: null, gateAgreement: null,
    });
    const row = pairRow(entry, mk(0), mk(null));
    assert.equal(row.armA.gateFriction, 0); // explicit 0 is a real value, not "no data"
    assert.equal(row.armB.gateFriction, null);
    // degraded arms still carry the friction resolved by tabulate
    const degraded = pairRow(entry, { status: "pending" }, { status: "missing", runId: "run-b1", gateFriction: 3 });
    assert.equal(degraded.armA.gateFriction, null);
    assert.equal(degraded.armB.gateFriction, 3);
  });
});

describe("aggregate", () => {
  it("all-arm-missing corpus → INCONCLUSIVE with null medians (today's state)", () => {
    const rows = [1, 2].map((i) => pairRow(
      { issue: `X-${i}`, armB: { runId: "r", childId: "c" } },
      { status: "pending" },
      { status: "missing", runId: "r" },
    ));
    const agg = aggregate(rows);
    assert.equal(agg.pairs, 2);
    assert.equal(agg.pairsArmAOk, 0);
    assert.equal(agg.pairsArmBOk, 0);
    assert.equal(agg.cost.medianA, null);
    assert.equal(agg.verdict, "INCONCLUSIVE");
    assert.deepEqual(agg.axes, { cost: null, timeExec: null });
    assert.deepEqual(agg.gateFriction, { medianA: null, medianB: null });
  });

  it("arm A dominating cost and exec, bodyDelta absent on both arms → GO (the old 3-axis rule was permanently INCONCLUSIVE here)", () => {
    const okArm = (costUsd, execSec) => ({
      status: "ok", runId: "r", childId: "c", childStatus: "exited", costUsd, turns: 1,
      wallTime: { totalSec: execSec, queueSec: null, execSec, gateWaitSec: 0 },
      bodyDelta: { editCount: null, charDelta: null }, escalations: null, gateAgreement: null,
    });
    const rows = [1, 2].map((i) => pairRow(
      { issue: `X-${i}`, armB: { runId: "r", childId: "c" } },
      okArm(0.5, 60),
      okArm(1, 120),
    ));
    const agg = aggregate(rows);
    assert.equal(agg.cost.medianA, 0.5);
    assert.equal(agg.cost.medianB, 1);
    assert.equal(agg.cost.ratioAB, 0.5);
    assert.equal(agg.timeExec.medianA, 60);
    assert.deepEqual(agg.axes, { cost: "win", timeExec: "win" });
    assert.equal(agg.verdict, "GO");
  });

  it("full data: both axes win → GO; a loss anywhere → NO-GO", () => {
    const mk = (costUsd, execSec, editCount) => ({
      status: "ok", runId: "r", childId: "c", childStatus: "exited", costUsd, turns: 1,
      wallTime: { totalSec: execSec, queueSec: null, execSec, gateWaitSec: 0 },
      bodyDelta: { editCount, charDelta: null }, escalations: null, gateAgreement: null,
    });
    const mkPair = (costA, execA, costB, execB) => [1, 2].map((i) => pairRow(
      { issue: `X-${i}`, armB: { runId: "r", childId: "c" } },
      mk(costA, execA, 1),
      mk(costB, execB, 1),
    ));
    // cost 0.5/1 and exec 60/120 both clear the win thresholds; equal edit
    // counts are the withdrawn quality descriptive — reportable, never decisive
    assert.equal(aggregate(mkPair(0.5, 60, 1, 120)).verdict, "GO");
    // exec regression 200 > 120 * 1.05 blocks GO even with a cost win
    assert.equal(aggregate(mkPair(0.5, 200, 1, 120)).verdict, "NO-GO");
  });

  it("gate friction is a descriptive: medians per arm, never an axis, never in the verdict", () => {
    const mk = (costUsd, execSec, gateFriction) => ({
      status: "ok", runId: "r", childId: "c", childStatus: "exited", costUsd, turns: 1,
      wallTime: { totalSec: execSec, queueSec: null, execSec, gateWaitSec: 0 },
      bodyDelta: { editCount: null, charDelta: null }, gateFriction, escalations: null, gateAgreement: null,
    });
    const rows = [1, 2].map((i) => pairRow(
      { issue: `X-${i}`, armB: { runId: "r", childId: "c" } },
      mk(0.5, 0.5, i - 1), // arm A friction 0 and 1
      mk(1, 1, i),         // arm B friction 1 and 2
    ));
    const agg = aggregate(rows);
    assert.deepEqual(agg.gateFriction, { medianA: 0.5, medianB: 1.5 });
    assert.deepEqual(agg.axes, { cost: "win", timeExec: "win" });
    assert.equal(agg.verdict, "GO"); // friction present but never decides
  });
});

// --- filesystem fixtures ------------------------------------------------------

function withTempDir(fn) {
  const temp = mkdtempSync(join(tmpdir(), "foc-477-measure-test-"));
  try {
    return fn(temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function writeChildren(root, runId, ...children) {
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "children.json"), childrenJson(runId, ...children));
}

describe("loadArmFromDisk (I/O)", () => {
  it("loads a children.json from disk (costUsd, wallTime, honest nulls)", () => {
    withTempDir((temp) => {
      const sup = join(temp, "sup");
      writeChildren(sup, "run-b1", child({ costUsd: 1.5 }));
      const arm = loadArmFromDisk(sup, "run-b1", "plan-1");
      assert.equal(arm.status, "ok");
      assert.equal(arm.costUsd, 1.5);
      assert.deepEqual(arm.wallTime, childWallTime([]));
      assert.equal(arm.bodyDelta.editCount, null);
      assert.equal(arm.escalations, null);
    });
  });
  it("missing run directory degrades to a flagged row", () => {
    withTempDir((temp) => {
      const arm = loadArmFromDisk(join(temp, "sup"), "nope", "plan-1");
      assert.equal(arm.status, "missing");
    });
  });
  it("unparseable children.json is malformed input (exit-code class), not a silent row", () => {
    withTempDir((temp) => {
      const dir = join(temp, "sup", "broken");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "children.json"), "{oops");
      assert.throws(() => loadArmFromDisk(join(temp, "sup"), "broken", "plan-1"), InputError);
    });
  });
  it("run() maps an InputError from corrupt run data to exit 2 with the documented message, no stack trace", () => {
    withTempDir((temp) => {
      const sup = join(temp, "sup");
      const dir = join(sup, "run-b1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "children.json"), "{oops");
      const corpusPath = join(temp, "corpus.json");
      writeFileSync(corpusPath, corpusText());
      const errors = [];
      const origError = console.error;
      console.error = (m) => errors.push(String(m));
      let exitCode = null;
      try {
        const code = run({
          argv: ["--runs", corpusPath, "--supervisor-dir", sup],
          stdout: () => {},
          exitFn: (c) => { exitCode = c; },
        });
        assert.equal(code, 2);
      } finally {
        console.error = origError;
      }
      assert.equal(exitCode, 2);
      assert.equal(errors.length, 1);
      assert.ok(errors[0].startsWith("foc-477-measure: "), errors[0]);
      assert.ok(errors[0].includes("children.json"), errors[0]);
      assert.ok(errors[0].includes("not valid JSON"), errors[0]);
      assert.ok(!errors[0].includes("\n    at "), `stack trace leaked: ${errors[0]}`);
    });
  });
  it("decisions.json feeds escalations by reason and gate agreement when present", () => {
    withTempDir((temp) => {
      const sup = join(temp, "sup");
      writeChildren(sup, "run-a1", child({ costUsd: 0.5 }));
      const dir = join(sup, "run-a1");
      writeFileSync(join(dir, "decisions.json"), JSON.stringify([
        { decision: "escalated", reason: "budget" },
        { decision: "escalated", reason: "budget" },
        { decision: "escalated", reason: "coverage" },
        { decision: "escalated" }, // no reason → bucketed, not dropped
        { asked: "approve", answered: "approve" },
        { asked: "approve", answered: "edit" },
      ]));
      const arm = loadArmFromDisk(sup, "run-a1", "plan-1");
      assert.deepEqual(arm.escalations, { total: 4, byReason: { budget: 2, coverage: 1, unspecified: 1 } });
      assert.deepEqual(arm.gateAgreement, { agreed: 1, total: 2, rate: 0.5 });
    });
  });
  it("a decisions.json with no escalations reports zero, absent file reports null", () => {
    withTempDir((temp) => {
      const sup = join(temp, "sup");
      writeChildren(sup, "run-a1", child({}));
      writeFileSync(join(sup, "run-a1", "decisions.json"), "[]");
      assert.deepEqual(loadArmFromDisk(sup, "run-a1", "plan-1").escalations, { total: 0, byReason: {} });
      const sup2 = join(temp, "sup2");
      writeChildren(sup2, "run-a2", child({}));
      assert.equal(loadArmFromDisk(sup2, "run-a2", "plan-1").escalations, null);
    });
  });
  it("an unparseable optional decisions.json warns and is treated as absent", () => {
    withTempDir((temp) => {
      const sup = join(temp, "sup");
      writeChildren(sup, "run-a1", child({}));
      writeFileSync(join(sup, "run-a1", "decisions.json"), "{oops");
      const warnings = [];
      const arm = loadArmFromDisk(sup, "run-a1", "plan-1", { warn: (m) => warnings.push(m) });
      assert.equal(arm.status, "ok");
      assert.equal(arm.escalations, null);
      assert.equal(warnings.length, 1);
    });
  });
});

describe("deriveGateFriction (I/O)", () => {
  it("arm A counts plan-graph gate kinds (plan.gate1, draft-approval); squad question gates are not counted", () => {
    withTempDir((temp) => {
      const runDir = join(temp, "run-a1");
      mkdirSync(join(runDir, "gates"), { recursive: true });
      writeFileSync(join(runDir, "gates", "gate-1.json"), JSON.stringify({ gateId: "gate-1", kind: "plan.gate1", status: "answered" }));
      writeFileSync(join(runDir, "gates", "gate-2.json"), JSON.stringify({ gateId: "gate-2", kind: "draft-approval", status: "approved" }));
      writeFileSync(join(runDir, "gates", "gate-3.json"), JSON.stringify({ gateId: "gate-plan-1-1", kind: "question" }));
      assert.equal(deriveGateFriction(runDir, { arm: "A" }), 2);
    });
  });
  it("arm B counts gate-plan-* records; dev gates are excluded", () => {
    withTempDir((temp) => {
      const runDir = join(temp, "run-b1");
      mkdirSync(join(runDir, "gates"), { recursive: true });
      writeFileSync(join(runDir, "gates", "gate-plan-1-1.json"), JSON.stringify({ gateId: "gate-plan-1-1", childId: "plan-1", kind: "question" }));
      writeFileSync(join(runDir, "gates", "gate-plan-2-1.json"), JSON.stringify({ gateId: "gate-plan-2-1", childId: "plan-2", kind: "question" }));
      writeFileSync(join(runDir, "gates", "gate-dev-3-1.json"), JSON.stringify({ gateId: "gate-dev-3-1", childId: "dev-3", kind: "question" }));
      assert.equal(deriveGateFriction(runDir, { arm: "B" }), 2);
    });
  });
  it("implementation-review verdicts in the sibling verdicts/ directory are never counted", () => {
    withTempDir((temp) => {
      const runDir = join(temp, "run-b1");
      mkdirSync(join(runDir, "gates"), { recursive: true });
      mkdirSync(join(runDir, "verdicts"), { recursive: true });
      writeFileSync(join(runDir, "gates", "gate-plan-1-1.json"), JSON.stringify({ gateId: "gate-plan-1-1", childId: "plan-1" }));
      // the real-run shape: a dozen foc-403-roundN verdicts plus a sibling-task verdict
      for (let i = 1; i <= 13; i++) {
        writeFileSync(join(runDir, "verdicts", `foc-403-round${i}.json`), JSON.stringify({ verdict: "approve" }));
      }
      writeFileSync(join(runDir, "verdicts", "foc-696-round1.json"), JSON.stringify({ verdict: "approve" }));
      assert.equal(deriveGateFriction(runDir, { arm: "B" }), 1);
    });
  });
  it("a missing gates directory is null — honest no data, never 0", () => {
    withTempDir((temp) => {
      assert.equal(deriveGateFriction(join(temp, "run-x"), { arm: "B" }), null);
      assert.equal(deriveGateFriction(join(temp, "run-x"), { arm: "A" }), null);
    });
  });
  it("an unparseable gate record warns and is excluded from the count", () => {
    withTempDir((temp) => {
      const runDir = join(temp, "run-b1");
      mkdirSync(join(runDir, "gates"), { recursive: true });
      writeFileSync(join(runDir, "gates", "gate-plan-1-1.json"), JSON.stringify({ gateId: "gate-plan-1-1" }));
      writeFileSync(join(runDir, "gates", "broken.json"), "{oops");
      const warnings = [];
      assert.equal(deriveGateFriction(runDir, { arm: "B", warn: (m) => warnings.push(m) }), 1);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes("broken.json"));
    });
  });
});

describe("resolveDefaultSupervisorDir", () => {
  it("walks the worktree .git pointer to the main checkout's .state/supervisor", () => {
    withTempDir((temp) => {
      const wt = join(temp, "wt");
      const main = join(temp, "main");
      mkdirSync(wt, { recursive: true });
      mkdirSync(join(main, ".git", "worktrees", "foc-477-dev"), { recursive: true });
      mkdirSync(join(main, ".state", "supervisor"), { recursive: true });
      writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "foc-477-dev")}\n`);
      assert.equal(resolveDefaultSupervisorDir(wt), join(main, ".state", "supervisor"));
    });
  });
  it("a real .git directory makes the root itself the main checkout", () => {
    withTempDir((temp) => {
      const root = join(temp, "main");
      mkdirSync(join(root, ".git"), { recursive: true });
      mkdirSync(join(root, ".state", "supervisor"), { recursive: true });
      assert.equal(resolveDefaultSupervisorDir(root), join(root, ".state", "supervisor"));
    });
  });
  it("nothing resolvable → null (rows flagged missing, never a crash)", () => {
    withTempDir((temp) => {
      const wt = join(temp, "wt");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, ".git"), `gitdir: ${join(temp, "absent", ".git", "worktrees", "x")}\n`);
      assert.equal(resolveDefaultSupervisorDir(wt), null);
    });
  });
});

// --- full CLI pass over synthesized fixtures ----------------------------------

describe("run (CLI surface)", () => {
  it("populates arm-B rows from disk, flags missing arm A, exits 0 with INCONCLUSIVE", () => {
    withTempDir((temp) => {
      const sup = join(temp, "sup");
      writeChildren(sup, "run-b1", child({ taskId: "FOC-198", costUsd: 1, costUsdReported: 99, turns: gatedTurns() }));
      writeChildren(sup, "run-b2", child({ taskId: "FOC-236", costUsd: 0.25, costUsdReported: 50, turns: [{ startedAt: T0, endedAt: iso(2) }] }));
      const corpusPath = join(temp, "corpus.json");
      writeFileSync(corpusPath, corpusText());

      let out = "";
      const code = run({
        argv: ["--runs", corpusPath, "--supervisor-dir", sup],
        stdout: (s) => { out += s; },
      });
      assert.equal(code, 0);
      const doc = JSON.parse(out);
      assert.equal(doc.pairs.length, 2);
      assert.equal(doc.pairs[0].armB.status, "ok");
      assert.equal(doc.pairs[0].armB.costUsd, 1); // costUsd, not the 99 costUsdReported
      assert.equal(doc.pairs[0].armB.wallTime.execSec, 120);
      assert.equal(doc.pairs[0].armB.wallTime.gateWaitSec, 30);
      assert.equal(doc.pairs[1].armB.costUsd, 0.25);
      assert.equal(doc.pairs[0].armA.status, "pending");
      assert.equal(doc.aggregate.verdict, "INCONCLUSIVE");
      assert.ok(doc.notes.some((n) => n.includes("costUsdReported")));
      assert.ok(!isAbsolute(doc.supervisorDir), `supervisorDir must be repo-relative, got ${doc.supervisorDir}`);
    });
  });
  it("aggregate medians are computed from raw values; pair rows are display-rounded once", () => {
    withTempDir((temp) => {
      const sup = join(temp, "sup");
      writeChildren(sup, "run-b1", child({ taskId: "FOC-198", costUsd: 0.111111, costUsdReported: 999 }));
      writeChildren(sup, "run-b2", child({ taskId: "FOC-236", costUsd: 0.222222, costUsdReported: 999 }));
      const corpusPath = join(temp, "corpus.json");
      writeFileSync(corpusPath, JSON.stringify({
        corpus: [
          { issue: "FOC-198", armB: { runId: "run-b1", childId: "plan-1", status: "exited", costUsd: 0.111111, turns: 1 } },
          { issue: "FOC-236", armB: { runId: "run-b2", childId: "plan-1", status: "exited", costUsd: 0.222222, turns: 1 } },
        ],
      }));
      let out = "";
      const code = run({
        argv: ["--runs", corpusPath, "--supervisor-dir", sup],
        stdout: (s) => { out += s; },
      });
      assert.equal(code, 0);
      const doc = JSON.parse(out);
      // pair rows are rounded to the published precision
      assert.equal(doc.pairs[0].armB.costUsd, 0.1111);
      assert.equal(doc.pairs[1].armB.costUsd, 0.2222);
      // but the median comes from the RAW costs — rounded pairs would give 0.16665
      assert.equal(doc.aggregate.cost.medianB, (0.111111 + 0.222222) / 2);
    });
  });
  it("a corpus entry whose children.json is absent is flagged missing; the script still exits 0", () => {
    withTempDir((temp) => {
      const sup = join(temp, "sup");
      writeChildren(sup, "run-b1", child({ costUsd: 1 }));
      const corpusPath = join(temp, "corpus.json");
      writeFileSync(corpusPath, corpusText());
      let out = "";
      const code = run({
        argv: ["--runs", corpusPath, "--supervisor-dir", sup],
        stdout: (s) => { out += s; },
      });
      assert.equal(code, 0);
      const doc = JSON.parse(out);
      assert.equal(doc.pairs[1].armB.status, "missing");
      assert.equal(doc.pairs[1].armB.runId, "run-b2");
      assert.equal(doc.pairs[1].armB.childId, "plan-1"); // corpus-named child survives the missing row
      assert.equal(doc.pairs[1].metrics.costRatioAB, null);
      assert.equal(doc.aggregate.pairsArmBOk, 1);
    });
  });
  it("arm-A run directories are picked up once the corpus names them", () => {
    withTempDir((temp) => {
      const sup = join(temp, "sup");
      writeChildren(sup, "run-b1", child({ taskId: "FOC-198", costUsd: 1, turns: [{ startedAt: T0, endedAt: iso(2) }] }));
      writeChildren(sup, "run-b2", child({ taskId: "FOC-236", costUsd: 2, turns: [{ startedAt: T0, endedAt: iso(2) }] }));
      writeChildren(sup, "run-a1", child({ childId: "graph-1", taskId: "FOC-198", costUsd: 0.5, turns: [{ startedAt: T0, endedAt: iso(1) }] }));
      writeChildren(sup, "run-a2", child({ childId: "graph-1", taskId: "FOC-236", costUsd: 1, turns: [{ startedAt: T0, endedAt: iso(1) }] }));
      const corpusPath = join(temp, "corpus.json");
      writeFileSync(corpusPath, corpusText({
        entry0: { armA: { runId: "run-a1", childId: "graph-1" } },
        entry1: { armA: { runId: "run-a2", childId: "graph-1" } },
      }));
      let out = "";
      const code = run({
        argv: ["--runs", corpusPath, "--supervisor-dir", sup],
        stdout: (s) => { out += s; },
      });
      assert.equal(code, 0);
      const doc = JSON.parse(out);
      assert.equal(doc.pairs[0].armA.status, "ok");
      assert.equal(doc.pairs[0].armA.costUsd, 0.5);
      assert.equal(doc.pairs[0].metrics.costRatioAB, 0.5);
      assert.equal(doc.pairs[0].metrics.execTimeRatioAB, 0.5); // exec 60/120, not wall 90/150
      assert.equal(doc.aggregate.pairsArmAOk, 2);
      // cost 0.75/1.5 and exec 60/120 both clear the win thresholds → GO; the
      // withdrawn quality axis (no bodyDelta source) never blocks the verdict
      assert.equal(doc.aggregate.verdict, "GO");
    });
  });
  it("arm-A gate friction derives from the same state root by default; the verdict depends only on cost/time", () => {
    withTempDir((temp) => {
      const sup = join(temp, "sup");
      writeChildren(sup, "run-b1", child({ taskId: "FOC-198", costUsd: 1, turns: [{ startedAt: T0, endedAt: iso(2) }] }));
      writeChildren(sup, "run-b2", child({ taskId: "FOC-236", costUsd: 1, turns: [{ startedAt: T0, endedAt: iso(2) }] }));
      writeChildren(sup, "run-a1", child({ childId: "graph-1", taskId: "FOC-198", costUsd: 0.5, turns: [{ startedAt: T0, endedAt: iso(1) }] }));
      writeChildren(sup, "run-a2", child({ childId: "graph-1", taskId: "FOC-236", costUsd: 0.5, turns: [{ startedAt: T0, endedAt: iso(1) }] }));
      // arm A: plan-graph gates — run-a1 has 2, run-a2 has 1
      mkdirSync(join(sup, "run-a1", "gates"), { recursive: true });
      writeFileSync(join(sup, "run-a1", "gates", "g1.json"), JSON.stringify({ gateId: "gate-1", kind: "plan.gate1" }));
      writeFileSync(join(sup, "run-a1", "gates", "g2.json"), JSON.stringify({ gateId: "gate-2", kind: "draft-approval" }));
      mkdirSync(join(sup, "run-a2", "gates"), { recursive: true });
      writeFileSync(join(sup, "run-a2", "gates", "g1.json"), JSON.stringify({ gateId: "gate-1", kind: "draft-approval" }));
      const corpusPath = join(temp, "corpus.json");
      writeFileSync(corpusPath, corpusText({
        entry0: { armA: { runId: "run-a1", childId: "graph-1" } },
        entry1: { armA: { runId: "run-a2", childId: "graph-1" } },
      }));
      let out = "";
      const code = run({
        argv: ["--runs", corpusPath, "--supervisor-dir", sup], // no --state-root → defaults to the supervisor root
        stdout: (s) => { out += s; },
      });
      assert.equal(code, 0);
      const doc = JSON.parse(out);
      assert.equal(doc.pairs[0].armA.gateFriction, 2);
      assert.equal(doc.pairs[1].armA.gateFriction, 1);
      assert.equal(doc.pairs[0].armB.gateFriction, null); // no gates dir for run-b1 → null, never 0
      assert.deepEqual(doc.aggregate.gateFriction, { medianA: 1.5, medianB: null });
      // cost 0.5/1 and exec 60/120 both win → GO even with gate friction present
      assert.equal(doc.aggregate.verdict, "GO");
    });
  });
  it("gate friction: a corpus literal beats derivation, explicit 0 included; --state-root separates the gates root", () => {
    withTempDir((temp) => {
      const sup = join(temp, "sup");
      const state = join(temp, "state");
      writeChildren(sup, "run-b1", child({ taskId: "FOC-198", costUsd: 1, turns: [{ startedAt: T0, endedAt: iso(2) }] }));
      writeChildren(sup, "run-b2", child({ taskId: "FOC-236", costUsd: 1, turns: [{ startedAt: T0, endedAt: iso(2) }] }));
      // gates live under the separate state root: run-b1 has 2 plan gates, run-b2 has 1
      mkdirSync(join(state, "run-b1", "gates"), { recursive: true });
      writeFileSync(join(state, "run-b1", "gates", "gate-plan-1-1.json"), JSON.stringify({ gateId: "gate-plan-1-1", childId: "plan-1" }));
      writeFileSync(join(state, "run-b1", "gates", "gate-plan-1-2.json"), JSON.stringify({ gateId: "gate-plan-1-2", childId: "plan-1" }));
      mkdirSync(join(state, "run-b2", "gates"), { recursive: true });
      writeFileSync(join(state, "run-b2", "gates", "gate-plan-1-1.json"), JSON.stringify({ gateId: "gate-plan-1-1", childId: "plan-1" }));
      const corpusPath = join(temp, "corpus.json");
      writeFileSync(corpusPath, JSON.stringify({
        corpus: [
          { issue: "FOC-198", armB: { runId: "run-b1", childId: "plan-1", status: "exited", costUsd: 1, gateFriction: 7 } },
          { issue: "FOC-236", armB: { runId: "run-b2", childId: "plan-1", status: "exited", costUsd: 1, gateFriction: 0 } },
        ],
      }));
      let out = "";
      const code = run({
        argv: ["--runs", corpusPath, "--supervisor-dir", sup, "--state-root", state],
        stdout: (s) => { out += s; },
      });
      assert.equal(code, 0);
      const doc = JSON.parse(out);
      assert.equal(doc.pairs[0].armB.gateFriction, 7); // literal beats the derived 2
      assert.equal(doc.pairs[1].armB.gateFriction, 0); // explicit 0 beats the derived 1
      assert.deepEqual(doc.aggregate.gateFriction, { medianA: null, medianB: 3.5 });
      assert.ok(!isAbsolute(doc.stateRoot), `stateRoot must be repo-relative, got ${doc.stateRoot}`);
      // arm A is pending → INCONCLUSIVE regardless of the friction values
      assert.equal(doc.aggregate.verdict, "INCONCLUSIVE");
    });
  });
  it("a negative gateFriction in the corpus exits 2 with exactly one stderr line, no stack trace", () => {
    withTempDir((temp) => {
      const corpusPath = join(temp, "corpus.json");
      writeFileSync(corpusPath, JSON.stringify({
        corpus: [{ issue: "FOC-1", armB: { runId: "run-b1", childId: "plan-1", gateFriction: -2 } }],
      }));
      const errors = [];
      const origError = console.error;
      console.error = (m) => errors.push(String(m));
      let code;
      try {
        code = run({ argv: ["--runs", corpusPath], stdout: () => {}, exitFn: () => {} });
      } finally {
        console.error = origError;
      }
      assert.equal(code, 2);
      assert.equal(errors.length, 1);
      assert.ok(errors[0].startsWith("foc-477-measure: "), errors[0]);
      assert.ok(errors[0].includes("gateFriction"), errors[0]);
      assert.ok(!errors[0].includes("\n    at "), `stack trace leaked: ${errors[0]}`);
    });
  });
  it("missing --runs exits 2 with usage (injected exit keeps the harness alive)", () => {
    let exitCode = null;
    const code = run({ argv: [], stdout: () => {}, exitFn: (c) => { exitCode = c; } });
    assert.equal(code, 2);
    assert.equal(exitCode, 2);
  });
  it("an unreadable corpus path exits 2", () => {
    withTempDir((temp) => {
      let exitCode = null;
      const code = run({
        argv: ["--runs", join(temp, "absent.json"), "--supervisor-dir", join(temp, "sup")],
        stdout: () => {},
        exitFn: (c) => { exitCode = c; },
      });
      assert.equal(code, 2);
      assert.equal(exitCode, 2);
    });
  });
  it("an unparseable corpus exits 2", () => {
    withTempDir((temp) => {
      const corpusPath = join(temp, "corpus.json");
      writeFileSync(corpusPath, "{oops");
      let exitCode = null;
      const code = run({
        argv: ["--runs", corpusPath, "--supervisor-dir", join(temp, "sup")],
        stdout: () => {},
        exitFn: (c) => { exitCode = c; },
      });
      assert.equal(code, 2);
      assert.equal(exitCode, 2);
    });
  });
  it("no supervisor root resolvable → rows flagged missing, still exit 0", () => {
    withTempDir((temp) => {
      const corpusPath = join(temp, "corpus.json");
      writeFileSync(corpusPath, corpusText());
      const wt = join(temp, "wt");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, ".git"), `gitdir: ${join(temp, "absent", ".git", "worktrees", "x")}\n`);
      let out = "";
      const code = run({
        argv: ["--runs", corpusPath],
        stdout: (s) => { out += s; },
        exitFn: (c) => { throw new Error(`unexpected exit ${c}`); },
        root: wt, // nothing resolvable under this root → default resolution finds nothing
      });
      assert.equal(code, 0);
      const doc = JSON.parse(out);
      assert.equal(doc.pairs[0].armB.status, "missing");
      assert.equal(doc.aggregate.verdict, "INCONCLUSIVE");
    });
  });
  it("--help prints usage and exits 0", () => {
    let out = "";
    const code = run({ argv: ["--help"], stdout: (s) => { out += s; } });
    assert.equal(code, 0);
    assert.ok(out.includes("--runs"));
    assert.ok(out.includes("--supervisor-dir"));
    assert.ok(out.includes("--arm-a-dir"));
    assert.ok(out.includes("--state-root"));
  });
});
