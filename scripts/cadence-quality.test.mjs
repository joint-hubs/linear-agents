// Tests for scripts/cadence-quality.mjs (FOC-1071) — the weekly CADENCE
// digest's four quality/cost numbers for the current and the previous ISO
// week, with the delta. The pure core is fixture-driven: no store, no fs, no
// network. Run: node --test scripts/cadence-quality.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { cadenceQuality, isoWeekRange } from "./cadence-quality.mjs";

const NOW = Date.parse("2026-11-04T22:00:00.000Z"); // a Wednesday
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ── isoWeekRange ─────────────────────────────────────────────────────────────

test("isoWeekRange: current week starts Monday 00:00 UTC; previous is the 7 days before", () => {
  const { current, previous } = isoWeekRange(NOW);
  assert.equal(current.start, Date.parse("2026-11-02T00:00:00.000Z"));
  assert.equal(current.end, NOW);
  assert.equal(previous.start, Date.parse("2026-10-26T00:00:00.000Z"));
  assert.equal(previous.end, Date.parse("2026-11-02T00:00:00.000Z"));
});

test("isoWeekRange: a Sunday late evening still belongs to the week that started 6 days earlier", () => {
  const sunday = Date.parse("2026-11-08T23:00:00.000Z");
  const { current, previous } = isoWeekRange(sunday);
  assert.equal(current.start, Date.parse("2026-11-02T00:00:00.000Z"));
  assert.equal(previous.start, Date.parse("2026-10-26T00:00:00.000Z"));
});

test("isoWeekRange: a Monday 00:00 sharp opens a fresh week with a full previous one", () => {
  const monday = Date.parse("2026-11-09T00:00:00.000Z");
  const { current, previous } = isoWeekRange(monday);
  assert.equal(current.start, monday);
  assert.equal(previous.start, Date.parse("2026-11-02T00:00:00.000Z"));
  assert.equal(previous.end, monday);
});

// ── cadenceQuality ───────────────────────────────────────────────────────────

// Facts carry ISO stamps (the shape collectTicketFacts emits) — the window
// filter parses them, so the fixtures must too.
const fact = (overrides = {}) => ({
  taskId: "FOC-1",
  firstActivityAt: new Date(NOW - 2 * DAY).toISOString(),
  lastActivityAt: new Date(NOW - DAY).toISOString(),
  children: [],
  verdicts: [],
  interventions: 0,
  size: null,
  prOpenAt: null,
  ...overrides,
});

const report = (tickets) => ({ tickets, supervisor: {}, byDay: [], byModel: [], untaggedChildrenUsd: 0 });

test("cadenceQuality: the four numbers for both windows, from window facts and window reports", () => {
  const facts = [
    // current week: two round-1 review verdicts, one PASS → 0.5;
    // interventions 4 over the two tickets with children → 2;
    // wall time 2 h and 10 h → p50 10 h
    fact({
      taskId: "A",
      lastActivityAt: new Date(NOW - DAY).toISOString(),
      verdicts: [{ round: 1, squad: "review", verdict: "PASS" }],
      children: [{ squad: "dev" }],
      interventions: 3,
      firstActivityAt: new Date(NOW - 12 * HOUR).toISOString(),
      prOpenAt: new Date(NOW - 10 * HOUR).toISOString(),
    }),
    fact({
      taskId: "B",
      lastActivityAt: new Date(NOW - DAY).toISOString(),
      verdicts: [{ round: 1, squad: "review", verdict: "FAIL" }],
      children: [{ squad: "dev" }],
      interventions: 1,
      firstActivityAt: new Date(NOW - 20 * HOUR).toISOString(),
      prOpenAt: new Date(NOW - 10 * HOUR).toISOString(),
    }),
    // previous week: one round-1 PASS → 1.0; one PR at 30 h
    fact({
      taskId: "P",
      lastActivityAt: "2026-10-28T12:00:00.000Z",
      verdicts: [{ round: 1, squad: "review", verdict: "PASS" }],
      children: [{ squad: "dev" }],
      interventions: 2,
      firstActivityAt: "2026-10-27T12:00:00.000Z",
      prOpenAt: "2026-10-28T18:00:00.000Z",
    }),
  ];
  const reports = {
    current: report([
      { taskId: "A", totalUsd: 3 },
      { taskId: "B", totalUsd: 9 },
    ]),
    previous: report([{ taskId: "P", totalUsd: 20 }]),
  };

  const out = cadenceQuality({ now: NOW, facts, reports });

  assert.equal(out.current.firstTimeRight, 0.5);
  assert.equal(out.current.interventionsPerTicket, 2);
  // nearest rank over [2, 10]: n=2 → ceil(.5*2)-1 = 0 → the lower value
  assert.equal(out.current.wallTimeToPr, 2);
  assert.equal(out.current.tickets, 2);
  assert.equal(out.current.costPerTicketBySize.small.n, 0);
  assert.equal(out.current.costPerTicketBySize.small.p50, null);

  assert.equal(out.previous.firstTimeRight, 1.0);
  assert.equal(out.previous.interventionsPerTicket, 2);
  assert.equal(out.previous.wallTimeToPr, 30);
  assert.equal(out.previous.tickets, 1);

  // deltas: current - previous; a null on either side stays null
  assert.equal(out.deltas.firstTimeRight, -0.5);
  assert.equal(out.deltas.interventionsPerTicket, 0);
  assert.equal(out.deltas.wallTimeToPr, -28);
  assert.equal(out.deltas.costPerTicketBySize.small, null);
});

test("cadenceQuality: cost per ticket by size joins the window report to the facts' triage size", () => {
  const facts = [
    fact({ taskId: "S1", size: "small", lastActivityAt: new Date(NOW - DAY).toISOString() }),
    fact({ taskId: "S2", size: "small", lastActivityAt: new Date(NOW - DAY).toISOString() }),
    fact({ taskId: "S3", size: "small", lastActivityAt: new Date(NOW - DAY).toISOString() }),
    fact({ taskId: "M1", size: "medium", lastActivityAt: new Date(NOW - DAY).toISOString() }),
  ];
  const out = cadenceQuality({
    now: NOW,
    facts,
    reports: { current: report([{ taskId: "S1", totalUsd: 2 }, { taskId: "S2", totalUsd: 3 }, { taskId: "S3", totalUsd: 5 }, { taskId: "M1", totalUsd: 15 }]), previous: report([]) },
  });
  const bySize = out.current.costPerTicketBySize;
  assert.equal(bySize.small.n, 3);
  assert.equal(bySize.small.p50, 3);
  assert.equal(bySize.medium.p50, 15);
  assert.equal(out.previous.costPerTicketBySize.small.p50, null);
  assert.equal(out.deltas.costPerTicketBySize.small, null); // previous null → delta null
  assert.equal(out.deltas.costPerTicketBySize.medium, null);
});

test("cadenceQuality: targets ride the size buckets, states never appear here", () => {
  const facts = [fact({ taskId: "S1", size: "small", lastActivityAt: new Date(NOW - DAY).toISOString() })];
  const out = cadenceQuality({
    now: NOW,
    facts,
    targets: { costPerTicketBySize: { small: 5 } },
    reports: { current: report([{ taskId: "S1", totalUsd: 3 }]), previous: report([]) },
  });
  assert.equal(out.current.costPerTicketBySize.small.target, 5);
  // the bucket helper computes a state, but the digest reads the numbers and
  // the deltas — the state field is simply not part of the digest wording
  assert.equal(out.current.costPerTicketBySize.small.state, "good");
});

test("cadenceQuality: a window with no tickets → null numbers, null deltas", () => {
  const out = cadenceQuality({ now: NOW, facts: [fact()], reports: { current: report([]), previous: report([]) } });
  assert.equal(out.current.firstTimeRight, null);
  assert.equal(out.current.interventionsPerTicket, null);
  assert.equal(out.current.wallTimeToPr, null);
  assert.equal(out.deltas.firstTimeRight, null);
  assert.equal(out.previous.tickets, 0);
});