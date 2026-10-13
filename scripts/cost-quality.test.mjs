// Tests for scripts/cost-quality.mjs (FOC-785 W3). Fixture objects only —
// the module is pure, so no store, no fs, no network.
import test from "node:test";
import assert from "node:assert/strict";

import {
  percentileNearestRank,
  DEFINITIONS,
  buildCostsPayload,
  buildQualityPayload,
} from "./cost-quality.mjs";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const FRESH = NOW - 60_000; // computed 1 min ago → not stale (limit 5 min)
const DAY = 86_400_000;

// ── percentileNearestRank ────────────────────────────────────────────────────

test("percentileNearestRank: empty → null", () => {
  assert.equal(percentileNearestRank([], 50), null);
});

test("percentileNearestRank: single value is every percentile", () => {
  assert.equal(percentileNearestRank([7], 20), 7);
  assert.equal(percentileNearestRank([7], 50), 7);
  assert.equal(percentileNearestRank([7], 80), 7);
});

test("percentileNearestRank: p20/p50/p80 over five values", () => {
  const values = [10, 20, 30, 40, 50];
  // n=5: ceil(0.2*5)-1=0, ceil(0.5*5)-1=2, ceil(0.8*5)-1=3
  assert.equal(percentileNearestRank(values, 20), 10);
  assert.equal(percentileNearestRank(values, 50), 30);
  assert.equal(percentileNearestRank(values, 80), 40);
});

test("percentileNearestRank: sorts unsorted input and clamps p", () => {
  assert.equal(percentileNearestRank([30, 10, 20], 50), 20);
  assert.equal(percentileNearestRank([1, 2, 3], 0), 1); // clamp low
  assert.equal(percentileNearestRank([1, 2, 3], 100), 3); // clamp high
});

// ── fixtures ─────────────────────────────────────────────────────────────────

const ticket = (taskId, childrenUsd, supervisorUsd = 0) => ({
  taskId,
  childrenUsd,
  supervisorUsd,
  totalUsd: childrenUsd + supervisorUsd,
  messages: 0,
});

const supervisorReport = (totalUsd, ticketUsd, overheadUsd, unattributedUsd, attributedShare) => ({
  totalUsd,
  ticketUsd,
  overheadUsd,
  unattributedUsd,
  attributedShare,
});

const snapshot = (overrides = {}) => ({
  computedAt: new Date(FRESH).toISOString(),
  storePath: "fake.sqlite",
  windows: {
    all: {
      since: null,
      until: null,
      tickets: [],
      overheadUsd: 0,
      unattributedUsd: 0,
      untaggedChildrenUsd: 0,
      supervisor: supervisorReport(0, 0, 0, 0, null),
      unpricedMessages: 0,
      legacyRows: 0,
    },
    "30d": { ...{} },
    "7d": { ...{} },
  },
  runs: {},
  ...overrides,
});

const window = (report) => report; // readability helper in fixtures

const fact = (overrides = {}) => ({
  taskId: "FOC-1",
  runIds: [],
  firstActivityAt: NOW - 2 * DAY,
  lastActivityAt: NOW - DAY,
  children: [],
  rounds: 0,
  verdicts: [],
  gates: [],
  interventions: 0,
  interventionRows: [],
  ...overrides,
});

const child = (telemetryRunId, squad = "dev") => ({ runId: "c", childId: "ch", squad, telemetryRunId });

// ── /api/costs ───────────────────────────────────────────────────────────────

test("costs: KPIs over tickets with children cost", () => {
  const snap = snapshot({
    windows: {
      all: window({
        tickets: [ticket("A", 10), ticket("B", 30, 10), ticket("C", 0, 5)],
        untaggedChildrenUsd: 5,
        supervisor: supervisorReport(40, 15, 20, 5, 0.875),
        unpricedMessages: 3,
        legacyRows: 1,
      }),
      "30d": {},
      "7d": {},
    },
  });
  const payload = buildCostsPayload({ snapshot: snap, facts: [], period: "all", now: NOW });

  // childrenPerTicket over tickets with childrenUsd > 0 → [10, 30], p50 = 30 (nearest rank: ceil(.5*2)-1 = 0 → 10)
  // n=2: ceil(0.5*2)-1 = 0 → sorted [10,30] index 0
  assert.equal(payload.kpis.childrenPerTicket.n, 2);
  assert.equal(payload.kpis.childrenPerTicket.p50, 10);
  assert.equal(payload.kpis.childrenPerTicket.p80, 30); // ceil(.8*2)-1 = 1
  // all-in average over tickets with totalUsd > 0 → (10+40+5)/3
  assert.equal(payload.kpis.allInAvgPerTicket, 55 / 3);
  // total = children on tickets (10+30+0) + untagged (5) + supervisor (40)
  assert.equal(payload.kpis.totalUsd, 85);
  assert.equal(payload.kpis.childrenUsd, 45);
  assert.equal(payload.kpis.supervisorUsd, 40);
  assert.ok(Math.abs(payload.kpis.supervisorShare - 40 / 85) < 1e-12);
  assert.equal(payload.unpricedMessages, 3);
  assert.equal(payload.legacyRows, 1);
  assert.equal(payload.state, "ok");
  assert.equal(payload.stale, false);
  assert.equal(payload.period, "all");
});

test("costs: attribution banner flag", () => {
  const base = { tickets: [], untaggedChildrenUsd: 0 };
  const below = buildCostsPayload({
    snapshot: snapshot({
      windows: {
        all: window({ ...base, supervisor: supervisorReport(10, 4, 2, 4, 0.6) }),
        "30d": {},
        "7d": {},
      },
    }),
    facts: [],
    period: "all",
    now: NOW,
  });
  assert.equal(below.attribution.belowTarget, true);
  assert.equal(below.attribution.attributedShare, 0.6);
  assert.equal(below.attribution.target, 0.8);

  const atTarget = buildCostsPayload({
    snapshot: snapshot({
      windows: {
        all: window({ ...base, supervisor: supervisorReport(10, 10, 0, 0, 1) }),
        "30d": {},
        "7d": {},
      },
    }),
    facts: [],
    period: "all",
    now: NOW,
  });
  assert.equal(atTarget.attribution.belowTarget, false);

  // null share with Supervisor cost > 0 → banner shows (cannot prove attribution)
  const nullShare = buildCostsPayload({
    snapshot: snapshot({
      windows: {
        all: window({ ...base, supervisor: supervisorReport(10, 0, 0, 10, null) }),
        "30d": {},
        "7d": {},
      },
    }),
    facts: [],
    period: "all",
    now: NOW,
  });
  assert.equal(nullShare.attribution.belowTarget, true);

  // null share with no Supervisor cost at all → no banner
  const zero = buildCostsPayload({
    snapshot: snapshot({
      windows: {
        all: window({ ...base, supervisor: supervisorReport(0, 0, 0, 0, null) }),
        "30d": {},
        "7d": {},
      },
    }),
    facts: [],
    period: "all",
    now: NOW,
  });
  assert.equal(zero.attribution.belowTarget, false);
  assert.equal(zero.kpis.totalUsd, 0);
  assert.equal(zero.kpis.supervisorShare, null); // denominator 0 → null, never 0
});

test("costs: byModel shares", () => {
  const snap = snapshot({
    windows: {
      all: window({
        tickets: [],
        untaggedChildrenUsd: 0,
        supervisor: supervisorReport(0, 0, 0, 0, null),
        byModel: [
          { model: "claude-opus-5-5", usd: 8, messages: 2 },
          { model: "z-ai/glm-5.3-flash", usd: 2, messages: 6 },
        ],
      }),
      "30d": {},
      "7d": {},
    },
  });
  const payload = buildCostsPayload({ snapshot: snap, facts: [], period: "all", now: NOW });
  assert.deepEqual(
    payload.byModel.map((m) => [m.model, m.usd, m.share]),
    [
      ["claude-opus-5-5", 8, 0.8],
      ["z-ai/glm-5.3-flash", 2, 0.2],
    ],
  );
});

test("costs: mostExpensive rules each hit once, in order, plus unexplained", () => {
  // Rounds ≥ 3 beats rework ≥ 50 %; supervisor share is the last rule before unexplained.
  const runs = {
    r1: { usd: 10, reworkUsd: 6, messages: 1, unpricedMessages: 0 }, // 60 % rework
    r2: { usd: 4, reworkUsd: 0, messages: 1, unpricedMessages: 0 }, // no rework
  };
  const report = {
    tickets: [
      { ...ticket("T-ROUNDS", 10, 0), totalUsd: 10 },
      { ...ticket("T-REWORK", 10, 0), totalUsd: 10 },
      { ...ticket("T-INTERV", 4, 0), totalUsd: 4 },
      { ...ticket("T-SUP", 2, 3), totalUsd: 5 },
      { ...ticket("T-UNEXPL", 3, 0), totalUsd: 3 },
    ],
    untaggedChildrenUsd: 0,
    supervisor: supervisorReport(0, 0, 0, 0, null),
  };
  const facts = [
    fact({ taskId: "T-ROUNDS", rounds: 3 }),
    fact({
      taskId: "T-REWORK",
      rounds: 1,
      children: [child("r1")],
    }),
    fact({ taskId: "T-INTERV", interventions: 4 }),
    fact({ taskId: "T-SUP" }),
    fact({ taskId: "T-UNEXPL" }),
  ];
  const payload = buildCostsPayload({
    snapshot: snapshot({ windows: { all: window(report), "30d": {}, "7d": {} }, runs }),
    facts,
    period: "all",
    now: NOW,
  });
  const byRule = Object.fromEntries(payload.mostExpensive.map((t) => [t.taskId, t.why.rule]));
  // Sorted by totalUsd: T-ROUNDS 10, T-REWORK 10, T-SUP 5, T-INTERV 4, T-UNEXPL 3
  assert.deepEqual(Object.keys(byRule), ["T-ROUNDS", "T-REWORK", "T-SUP", "T-INTERV", "T-UNEXPL"]);
  assert.equal(byRule["T-ROUNDS"], "rounds");
  assert.equal(payload.mostExpensive[0].why.text, "3 review rounds");
  assert.equal(byRule["T-REWORK"], "rework");
  assert.equal(payload.mostExpensive[1].why.text, "60 % of children's cost after turn 1");
  assert.equal(byRule["T-INTERV"], "interventions");
  assert.equal(byRule["T-SUP"], "supervisor");
  assert.equal(byRule["T-UNEXPL"], "unexplained");
});

test("costs: mostExpensive capped at 10 and sorted by totalUsd", () => {
  const tickets = Array.from({ length: 12 }, (_, i) => ticket(`T-${i}`, i + 1));
  const payload = buildCostsPayload({
    snapshot: snapshot({
      windows: { all: window({ tickets, untaggedChildrenUsd: 0, supervisor: supervisorReport(0, 0, 0, 0, null) }), "30d": {}, "7d": {} },
    }),
    facts: [],
    period: "all",
    now: NOW,
  });
  assert.equal(payload.mostExpensive.length, 10);
  assert.equal(payload.mostExpensive[0].taskId, "T-11");
});

test("costs: null snapshot → computing with null numbers", () => {
  const payload = buildCostsPayload({ snapshot: null, facts: [], period: "7d", now: NOW });
  assert.equal(payload.state, "computing");
  assert.equal(payload.stale, false);
  assert.equal(payload.kpis.totalUsd, null);
  assert.equal(payload.kpis.childrenPerTicket.p50, null);
  assert.equal(payload.kpis.supervisorShare, null);
  assert.equal(payload.attribution.belowTarget, null);
  assert.deepEqual(payload.byDay, []);
  assert.deepEqual(payload.mostExpensive, []);
  assert.equal(payload.definitions.childrenPerTicket.length > 20, true);
});

test("costs: error snapshot passes through", () => {
  const payload = buildCostsPayload({
    snapshot: { state: "error", computedAt: new Date(FRESH).toISOString() },
    facts: [],
    period: "7d",
    now: NOW,
  });
  assert.equal(payload.state, "error");
  assert.equal(payload.kpis.totalUsd, null);
});

test("costs: stale flag when computedAt is older than staleAfterMs", () => {
  const old = snapshot();
  const payload = buildCostsPayload({
    snapshot: old,
    facts: [],
    period: "all",
    now: NOW + 6 * 60_000, // 7 min after computedAt, limit 5 min
  });
  assert.equal(payload.stale, true);
  const boundary = buildCostsPayload({ snapshot: old, facts: [], period: "all", now: FRESH + 5 * 60_000 });
  assert.equal(boundary.stale, false); // not > staleAfterMs at exactly 5 min
});

test("costs: period picks its window and unknown period throws", () => {
  const snap = snapshot({
    windows: {
      all: window({ tickets: [ticket("A", 1)], untaggedChildrenUsd: 0, supervisor: supervisorReport(0, 0, 0, 0, null) }),
      "30d": window({ tickets: [ticket("A", 2), ticket("B", 3)], untaggedChildrenUsd: 0, supervisor: supervisorReport(0, 0, 0, 0, null) }),
      "7d": window({ tickets: [], untaggedChildrenUsd: 0, supervisor: supervisorReport(0, 0, 0, 0, null) }),
    },
  });
  assert.equal(buildCostsPayload({ snapshot: snap, facts: [], period: "30d", now: NOW }).kpis.totalUsd, 5);
  assert.equal(buildCostsPayload({ snapshot: snap, facts: [], period: "7d", now: NOW }).kpis.totalUsd, 0);
  assert.throws(() => buildCostsPayload({ snapshot: snap, facts: [], period: "14d", now: NOW }));
});

test("costs: childrenPerTicket p20–p80 band over several tickets", () => {
  const tickets = [10, 20, 30, 40, 50].map((usd, i) => ticket(`T-${i}`, usd));
  const payload = buildCostsPayload({
    snapshot: snapshot({
      windows: { all: window({ tickets, untaggedChildrenUsd: 0, supervisor: supervisorReport(0, 0, 0, 0, null) }), "30d": {}, "7d": {} },
    }),
    facts: [],
    period: "all",
    now: NOW,
  });
  assert.deepEqual(payload.kpis.childrenPerTicket, { p20: 10, p50: 30, p80: 40, n: 5 });
});

// ── /api/quality ─────────────────────────────────────────────────────────────

test("quality: firstTimeRight counts round-1 PASS among round-1 verdicts", () => {
  const facts = [
    fact({ taskId: "P1", verdicts: [{ round: 1, verdict: "PASS", at: NOW - DAY, path: "p" }], lastActivityAt: NOW - DAY }),
    fact({ taskId: "F1", verdicts: [{ round: 1, verdict: "FAIL", at: NOW - DAY, path: "p" }], lastActivityAt: NOW - DAY }),
    fact({ taskId: "F2", verdicts: [{ round: 1, verdict: "FAIL", at: NOW - DAY, path: "p" }], lastActivityAt: NOW - DAY }),
    // round 2 only — no round-1 verdict → outside the denominator
    fact({ taskId: "R2", verdicts: [{ round: 2, verdict: "PASS", at: NOW - DAY, path: "p" }], lastActivityAt: NOW - DAY }),
  ];
  const payload = buildQualityPayload({ snapshot: snapshot(), facts, linearStates: {}, period: "all", now: NOW });
  const signal = payload.signals.find((s) => s.key === "firstTimeRight");
  assert.equal(signal.value, 1 / 3);
  assert.equal(signal.numerator, 1);
  assert.equal(signal.denominator, 3);
  assert.deepEqual(signal.evidence, ["P1"]);
  assert.equal(signal.unit, "share");
  assert.equal(payload.tickets, 4);
});

test("quality: reworkShare over priced children runs, unpriced excluded", () => {
  const runs = {
    r1: { usd: 10, reworkUsd: 4, messages: 1, unpricedMessages: 0 },
    r2: { usd: 10, reworkUsd: 2, messages: 1, unpricedMessages: 0 },
  };
  const facts = [
    fact({ taskId: "A", children: [child("r1"), child("r2")], lastActivityAt: NOW - DAY }),
    fact({ taskId: "B", children: [child("r1")], lastActivityAt: NOW - DAY }),
    // no telemetryRunId → contributes nothing, not even an error
    fact({ taskId: "C", children: [child(null)], lastActivityAt: NOW - DAY }),
  ];
  const payload = buildQualityPayload({
    snapshot: snapshot({ runs }),
    facts,
    linearStates: {},
    period: "all",
    now: NOW,
  });
  const signal = payload.signals.find((s) => s.key === "reworkShare");
  // A: r1 rework 4 + r2 rework 2; B: r1 rework 4 again
  assert.equal(signal.numerator, 10);
  assert.equal(signal.denominator, 30); // 10+10+10
  assert.ok(Math.abs(signal.value - 1 / 3) < 1e-12);
  assert.deepEqual(signal.evidence, ["A", "B"]);
});

test("quality: reworkShare null when nothing is priced", () => {
  const payload = buildQualityPayload({
    snapshot: snapshot({ runs: {} }),
    facts: [fact({ taskId: "A", children: [child("missing")] })],
    linearStates: {},
    period: "all",
    now: NOW,
  });
  const signal = payload.signals.find((s) => s.key === "reworkShare");
  assert.equal(signal.value, null);
  assert.equal(signal.denominator, 0);
});

test("quality: interventionsPerTicket over tickets with any child", () => {
  const facts = [
    fact({ taskId: "A", interventions: 5, children: [child("r1")], lastActivityAt: NOW - DAY }),
    fact({ taskId: "B", interventions: 1, children: [child("r2")], lastActivityAt: NOW - DAY }),
    fact({ taskId: "C", interventions: 9, children: [], lastActivityAt: NOW - DAY }), // no child → outside denominator
  ];
  const payload = buildQualityPayload({ snapshot: snapshot(), facts, linearStates: {}, period: "all", now: NOW });
  const signal = payload.signals.find((s) => s.key === "interventionsPerTicket");
  assert.equal(signal.unit, "count");
  assert.equal(signal.numerator, 6);
  assert.equal(signal.denominator, 2);
  assert.equal(signal.value, 3);
  assert.deepEqual(signal.evidence, ["A", "B"]);
});

test("quality: landingYield from Linear completed type among dev-child tickets", () => {
  const facts = [
    fact({ taskId: "DONE", children: [child("r1", "dev")], lastActivityAt: NOW - DAY }),
    fact({ taskId: "WIP", children: [child("r2", "dev")], lastActivityAt: NOW - DAY }),
    fact({ taskId: "PLAN", children: [child("r3", "plan")], lastActivityAt: NOW - DAY }), // not dev
  ];
  const payload = buildQualityPayload({
    snapshot: snapshot(),
    facts,
    linearStates: { DONE: { name: "Done", type: "completed" }, WIP: { name: "In Progress", type: "started" } },
    period: "all",
    now: NOW,
  });
  const signal = payload.signals.find((s) => s.key === "landingYield");
  assert.equal(signal.numerator, 1);
  assert.equal(signal.denominator, 2);
  assert.equal(signal.value, 0.5);
  assert.deepEqual(signal.evidence, ["DONE"]);
});

test("quality: denominator 0 → value null for every signal", () => {
  const payload = buildQualityPayload({ snapshot: snapshot(), facts: [], linearStates: {}, period: "all", now: NOW });
  assert.equal(payload.tickets, 0);
  for (const signal of payload.signals) {
    assert.equal(signal.value, null, signal.key);
    assert.equal(signal.denominator, 0, signal.key);
    assert.deepEqual(signal.evidence, [], signal.key);
    assert.equal(typeof signal.definition, "string");
  }
});

test("quality: period filter keeps only facts active in the window", () => {
  const facts = [
    fact({ taskId: "NEW", lastActivityAt: NOW - 2 * DAY }),
    fact({ taskId: "OLD", lastActivityAt: NOW - 20 * DAY }),
  ];
  const week = buildQualityPayload({
    snapshot: snapshot(),
    facts,
    linearStates: {},
    period: "7d",
    now: NOW,
  });
  assert.equal(week.tickets, 1);
  const month = buildQualityPayload({
    snapshot: snapshot(),
    facts,
    linearStates: {},
    period: "30d",
    now: NOW,
  });
  assert.equal(month.tickets, 2);
  const all = buildQualityPayload({
    snapshot: snapshot(),
    facts,
    linearStates: {},
    period: "all",
    now: NOW,
  });
  assert.equal(all.tickets, 2); // "all" → every fact
});

test("quality: boundary — lastActivityAt exactly at the period start is in", () => {
  const facts = [fact({ taskId: "EDGE", lastActivityAt: NOW - 7 * DAY })];
  const payload = buildQualityPayload({
    snapshot: snapshot(),
    facts,
    linearStates: {},
    period: "7d",
    now: NOW,
  });
  assert.equal(payload.tickets, 1);
});

test("quality: null snapshot → computing, null signals", () => {
  const payload = buildQualityPayload({ snapshot: null, facts: [], linearStates: {}, period: "7d", now: NOW });
  assert.equal(payload.state, "computing");
  assert.equal(payload.tickets, null);
  assert.ok(payload.signals.length >= 4);
  for (const signal of payload.signals) {
    assert.equal(signal.value, null);
    assert.equal(signal.numerator, null);
    assert.equal(signal.denominator, null);
  }
});

test("quality: stale flag on an old snapshot", () => {
  const payload = buildQualityPayload({
    snapshot: snapshot(),
    facts: [],
    linearStates: {},
    period: "7d",
    now: FRESH + 6 * 60_000,
  });
  assert.equal(payload.stale, true);
});

test("definitions: every contract key is present and non-empty", () => {
  for (const key of [
    "childrenPerTicket",
    "allInAvgPerTicket",
    "totalUsd",
    "supervisorShare",
    "attribution",
    "firstTimeRight",
    "reworkShare",
    "interventionsPerTicket",
    "landingYield",
    "mostExpensive",
    "unknown",
  ]) {
    assert.equal(typeof DEFINITIONS[key], "string", key);
    assert.ok(DEFINITIONS[key].length > 0, key);
  }
});
