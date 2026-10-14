// scripts/work-board.test.mjs — Work board library tests (FOC-784, slice W1).
//
// Fixture state home in a temp dir only (never the repo's .state/), no network:
// Linear goes through an injected graphqlFor. Temp dirs are left for the OS to
// reclaim (Windows rm of a live tree flakes; the OS temp cleaner owns them).

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBoardPayload,
  buildTicketDetail,
  collectTicketFacts,
  deriveFlags,
  deriveStage,
  fetchLinearStates,
  normalizeLabel,
  startText,
} from "./work-board.mjs";

const HOME = mkdtempSync(join(tmpdir(), "work-board-test-"));
const NOW = Date.parse("2026-10-13T12:00:00.000Z");

const iso = (offsetMinutes) => new Date(NOW - offsetMinutes * 60_000).toISOString();

function fixtureRun(prefix) {
  const runId = `${prefix}-${process.pid}-${NOW}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(join(HOME, runId), { recursive: true });
  return runId;
}

const writeRegistry = (runId, children) =>
  writeFileSync(join(HOME, runId, "children.json"), JSON.stringify({ runId, children, rounds: {} }, null, 2));

const writeTriage = (runId, issue) =>
  writeFileSync(join(HOME, runId, "triage.json"), JSON.stringify({ issue }, null, 2));

const writeGate = (runId, gate) => {
  mkdirSync(join(HOME, runId, "gates"), { recursive: true });
  writeFileSync(join(HOME, runId, "gates", `${gate.gateId}.json`), JSON.stringify(gate, null, 2));
};

const writeVerdict = (runId, taskId, round, record) => {
  mkdirSync(join(HOME, runId, "verdicts"), { recursive: true });
  writeFileSync(join(HOME, runId, "verdicts", `${taskId.toLowerCase()}-round${round}.json`), JSON.stringify(record));
};

const appendEdit = (runId, row) => {
  const path = join(HOME, runId, "edits.jsonl");
  writeFileSync(path, (existsSync(path) ? readFileSync(path, "utf8") : "") + JSON.stringify(row) + "\n");
};

const childEntry = (childId, patch = {}) => ({
  childId,
  squad: "dev",
  taskId: "FOC-101",
  status: "running",
  turns: [],
  costUsd: 0.05,
  costSource: "registry",
  telemetryRunId: "tr-101",
  branch: "foc-101",
  baseRevision: "abc1234",
  worktree: "wt-101",
  startedAt: iso(60),
  endedAt: null,
  tee: `children/${childId}.jsonl`,
  ...patch,
});

// ── the fixture: three real runs + one corrupt ───────────────────────────────

// runA — FOC-101 in dev, live child, one finished turn.
const runA = fixtureRun("runa");
writeRegistry(runA, { cA1: childEntry("cA1", { status: "running" }), cA0: childEntry("cA0", { status: "exited", turns: [{ startedAt: iso(120), endedAt: iso(90), exitCode: 0 }] }) });
writeTriage(runA, "FOC-101");

// runB — FOC-102: review child, verdicts FAIL→PASS, answered gate + its edit row.
const runB = fixtureRun("runb");
writeRegistry(runB, {
  cB1: childEntry("cB1", {
    taskId: "FOC-102",
    squad: "review",
    status: "exited",
    startedAt: iso(50),
    endedAt: iso(40),
    turns: [{ startedAt: iso(50), endedAt: iso(40), exitCode: 0 }],
  }),
});
writeVerdict(runB, "FOC-102", 1, { round: 1, verdict: "fail", taskId: "FOC-102", recordedAt: iso(45) });
writeVerdict(runB, "FOC-102", 2, { round: 2, verdict: "pass", taskId: "FOC-102", recordedAt: iso(30) });
writeGate(runB, {
  gateId: "gB1",
  childId: "cB1",
  runId: runB,
  taskId: "FOC-102",
  kind: "question",
  status: "answered",
  createdAt: iso(42),
  answer: { text: "use CSV", answeredAt: iso(35) },
});
appendEdit(runB, { seq: 1, ts: iso(35), who: "mateusz", runId: runB, path: "gates/gB1.json", type: "gate-answer", changes: [], notified: true });
// an ask-answer with a second ticket in the run — ambiguous, must be dropped
writeRegistry2();

function writeRegistry2() {
  // runB second child for FOC-104 would make singleTicket ambiguous — but the
  // run already has exactly one ticket; add a second run with two tickets
  // instead, so the ask/hold mapping rule ("only one ticket in the run") is
  // exercised where it actually applies.
  const runE = fixtureRun("rune");
  writeRegistry(runE, {
    cE1: childEntry("cE1", { taskId: "FOC-105", status: "exited", startedAt: iso(20), endedAt: iso(19) }),
    cE2: childEntry("cE2", { taskId: "FOC-106", status: "exited", startedAt: iso(18), endedAt: iso(17) }),
  });
  appendEdit(runE, { seq: 1, ts: iso(16), who: "mateusz", runId: runE, path: "ask/1", type: "ask-answer", changes: [], notified: false });
}

// runC — triaged only, no children: FOC-103 must exist with none.
const runC = fixtureRun("runc");
writeTriage(runC, "FOC-103");

// runD — corrupt registry: skipped, never throws.
const runD = fixtureRun("rund");
writeFileSync(join(HOME, runD, "children.json"), "{not json");
writeTriage(runD, "FOC-101");

// runF — outside the window: excluded by `days`.
const runF = fixtureRun("runf");
writeRegistry(runF, { cF1: childEntry("cF1", { taskId: "FOC-107", status: "exited" }) });
const old = new Date(NOW - 40 * 86_400_000);
utimesSync(join(HOME, runF, "children.json"), old, old);

const factsByTask = (facts, taskId) => facts.find((f) => f.taskId === taskId);

test("collectTicketFacts: the three runs are collected, the corrupt run is skipped", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const ids = facts.map((f) => f.taskId).sort();
  assert.deepEqual(ids, ["FOC-101", "FOC-102", "FOC-103", "FOC-105", "FOC-106"]);
  assert.equal(factsByTask(facts, "FOC-107"), undefined); // outside the window
});

test("collectTicketFacts: children carry the contract fields", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const f101 = factsByTask(facts, "FOC-101");
  assert.equal(f101.children.length, 2);
  const live = f101.children.find((c) => c.childId === "cA1");
  assert.equal(live.squad, "dev");
  assert.equal(live.status, "running");
  assert.equal(live.telemetryRunId, "tr-101");
  assert.equal(live.branch, "foc-101");
  assert.equal(live.baseRevision, "abc1234");
  assert.equal(live.worktree, "wt-101");
  assert.equal(live.costUsd, 0.05);
  assert.equal(live.tee, "children/cA1.jsonl");
  assert.deepEqual(live.turns, []);
  assert.ok(f101.runIds.includes(runA));
});

test("collectTicketFacts: verdict rounds with PASS/FAIL, count = rounds", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const f102 = factsByTask(facts, "FOC-102");
  assert.equal(f102.rounds, 2);
  assert.deepEqual(
    f102.verdicts.map((v) => [v.round, v.verdict]),
    [[1, "FAIL"], [2, "PASS"]],
  );
  assert.ok(f102.verdicts[0].path.endsWith("foc-102-round1.json"));
});

test("collectTicketFacts: an unreadable verdict file counts as UNKNOWN, not absent", () => {
  const run = fixtureRun("runv");
  writeRegistry(run, { cV1: childEntry("cV1", { taskId: "FOC-108", status: "exited" }) });
  mkdirSync(join(HOME, run, "verdicts"), { recursive: true });
  writeFileSync(join(HOME, run, "verdicts", "foc-108-round3.json"), "{broken");
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const f108 = factsByTask(facts, "FOC-108");
  assert.deepEqual(f108.verdicts.map((v) => v.verdict), ["UNKNOWN"]);
  assert.equal(f108.rounds, 1);
});

test("collectTicketFacts: the supervisor-lib path (default state home) reads verdicts", () => {
  // The production shape: LA_SUPERVISOR_STATE_HOME IS the state home, so the
  // lib readers (readRegistry/roundsFor/verdictPath) run instead of the
  // home-parameterised ones. Before the verdictPath import fix, any ticket
  // with a verdict file threw a ReferenceError here — every /api/work,
  // /api/costs and /api/quality request 500'd. The seam is set and left set
  // (no unsetting); its own temp home keeps the tests above on the explicit
  // stateHome branch they were written for.
  const libHome = mkdtempSync(join(tmpdir(), "work-board-lib-"));
  process.env.LA_SUPERVISOR_STATE_HOME = libHome;
  const runId = `runlib-${process.pid}-${NOW}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(join(libHome, runId, "verdicts"), { recursive: true });
  writeFileSync(join(libHome, runId, "children.json"), JSON.stringify({
    runId,
    children: {
      cLib1: {
        childId: "cLib1", squad: "review", taskId: "FOC-900", status: "exited",
        turns: [{ startedAt: iso(40), endedAt: iso(30), exitCode: 0 }],
      },
    },
    rounds: {},
  }));
  // The real verdict-record shape (supervisor-verdict.mjs): round + verdict +
  // recordedAt; the file name carries the round the same way.
  writeFileSync(join(libHome, runId, "verdicts", "foc-900-round1.json"),
    JSON.stringify({ round: 1, verdict: "fail", taskId: "FOC-900", recordedAt: iso(35) }));
  writeFileSync(join(libHome, runId, "verdicts", "foc-900-round2.json"),
    JSON.stringify({ round: 2, verdict: "pass", taskId: "FOC-900", recordedAt: iso(20) }));

  // NO explicit stateHome — this is the useLib === true branch.
  const facts = collectTicketFacts({ days: 30, now: NOW });
  const f900 = facts.find((f) => f.taskId === "FOC-900");
  assert.ok(f900, "the ticket is collected through the lib readers");
  assert.equal(f900.rounds, 2);
  assert.deepEqual(f900.verdicts.map((v) => [v.round, v.verdict]), [[1, "FAIL"], [2, "PASS"]]);
  assert.ok(f900.verdicts.every((v) => v.path.startsWith(libHome) && v.path.endsWith(".json")),
    "verdict paths come from the lib's verdictPath, not the fallback");
  assert.equal(f900.children[0].startedAt, iso(40)); // from the turn — no child.startedAt in the registry
});

test("collectTicketFacts: children without startedAt take it from their turns", () => {
  // The registry's real shape: no child.startedAt/endedAt, turns only. The
  // effective start must make review-2 the latest child — on the acceptance
  // stack this ticket read as "dev" because every child sorted as "missing
  // timestamp" and the first one won.
  const run = fixtureRun("runt");
  writeRegistry(run, {
    d1: { childId: "d1", squad: "dev", taskId: "FOC-130", status: "exited", turns: [{ startedAt: iso(120), endedAt: iso(90), exitCode: 0 }] },
    r2: { childId: "r2", squad: "review", taskId: "FOC-130", status: "exited", turns: [{ startedAt: iso(60), endedAt: iso(50), exitCode: 0 }] },
  });
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const f130 = factsByTask(facts, "FOC-130");
  const d1 = f130.children.find((c) => c.childId === "d1");
  const r2 = f130.children.find((c) => c.childId === "r2");
  assert.equal(d1.startedAt, iso(120));
  assert.equal(d1.endedAt, iso(90));
  assert.equal(r2.startedAt, iso(60));
  assert.equal(r2.endedAt, iso(50));
  assert.equal(deriveStage(f130, null), "review");
});

test("collectTicketFacts: gates map through taskId, childId, then the single ticket", () => {
  const run = fixtureRun("rung");
  writeRegistry(run, {
    cG1: childEntry("cG1", { taskId: "FOC-110", status: "waiting_gate" }),
  });
  writeGate(run, { gateId: "g1", childId: "cG1", taskId: null, kind: "question", status: "pending", createdAt: iso(10), answer: null });
  writeGate(run, { gateId: "g2", childId: null, taskId: "FOC-110", kind: "push-approval", status: "pending", createdAt: iso(9), answer: null });
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const gates = factsByTask(facts, "FOC-110").gates;
  assert.deepEqual(gates.map((g) => g.gateId).sort(), ["g1", "g2"]);
  assert.equal(gates.find((g) => g.gateId === "g1").childId, "cG1");
});

test("collectTicketFacts: interventions from edits.jsonl, gate answers via the gate", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const f102 = factsByTask(facts, "FOC-102");
  assert.equal(f102.interventions, 1);
  assert.deepEqual(f102.interventionRows[0].kind, "gate-answer");
  assert.equal(f102.interventionRows[0].path, "gates/gB1.json");
  // runE has two tickets — its ask-answer is ambiguous and must land nowhere
  assert.equal(factsByTask(facts, "FOC-105").interventions, 0);
  assert.equal(factsByTask(facts, "FOC-106").interventions, 0);
});

test("collectTicketFacts: triage-only ticket exists with no children", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const f103 = factsByTask(facts, "FOC-103");
  assert.deepEqual(f103.children, []);
  assert.ok(f103.runIds.includes(runC));
});

test("collectTicketFacts: SUP pseudo ids and non-ticket shapes are ignored", () => {
  const run = fixtureRun("runs");
  writeRegistry(run, {
    cS1: childEntry("cS1", { taskId: "SUP:dash", status: "exited" }),
    cS2: childEntry("cS2", { taskId: "not-a-ticket", status: "exited" }),
  });
  writeTriage(run, "SUP:cockpit");
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  assert.equal(facts.find((f) => f.taskId === "SUP:dash"), undefined);
  assert.equal(facts.find((f) => f.taskId === "not-a-ticket"), undefined);
});

test("collectTicketFacts: first/last activity from children, verdicts and gates", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const f102 = factsByTask(facts, "FOC-102");
  // newest stamp in the fixture for FOC-102 is the round-2 verdict (iso(30));
  // oldest is the child start (iso(50)).
  assert.equal(f102.firstActivityAt, iso(50));
  assert.equal(f102.lastActivityAt, iso(30));
});

test("deriveStage: landed beats everything; squads map; unknown squad → dev; none → ready", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  assert.equal(deriveStage(factsByTask(facts, "FOC-103"), null), "ready");
  assert.equal(deriveStage(factsByTask(facts, "FOC-101"), null), "dev");
  const reviewOnly = { children: [{ squad: "review", startedAt: iso(5) }], taskId: "X-1" };
  assert.equal(deriveStage(reviewOnly, null), "review");
  assert.equal(deriveStage({ children: [{ squad: "cadence", startedAt: iso(5) }], taskId: "X-1" }, null), "dev");
  assert.equal(deriveStage(factsByTask(facts, "FOC-101"), { type: "completed" }), "landed");
});

test("deriveFlags: live child, pending gate, crashed latest — text always says it", () => {
  const run = fixtureRun("runfl");
  writeRegistry(run, {
    cL1: childEntry("cL1", { taskId: "FOC-120", status: "running", startedAt: iso(10) }),
    cL2: childEntry("cL2", { taskId: "FOC-120", status: "crashed", startedAt: iso(9), endedAt: iso(8) }),
  });
  writeGate(run, { gateId: "g9", childId: "cL1", kind: "question", status: "pending", createdAt: iso(7), answer: null });
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const flags = deriveFlags(factsByTask(facts, "FOC-120"));
  const kinds = flags.map((f) => f.kind);
  assert.ok(kinds.includes("live"));
  assert.ok(kinds.includes("gate"));
  assert.ok(kinds.includes("crashed"));
  for (const flag of flags) assert.ok(flag.text.length > 0, "every flag carries text");
  assert.equal(flags.find((f) => f.kind === "live").childId, "cL1");
  assert.equal(flags.find((f) => f.kind === "crashed").childId, "cL2");
});

test("deriveFlags: waiting_gate with no pending gate record is needs-you", () => {
  const run = fixtureRun("runny");
  writeRegistry(run, { cN1: childEntry("cN1", { taskId: "FOC-121", status: "waiting_gate", startedAt: iso(10) }) });
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const flags = deriveFlags(factsByTask(facts, "FOC-121"));
  assert.deepEqual(flags.map((f) => f.kind), ["needs-you"]);
});

test("buildBoardPayload: Ready dedups against touched facts, open-only, sorted", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const queue = [
    { id: "1", identifier: "FOC-101", title: "dup of touched", state: "Todo", stateType: "unstarted", priority: 1, updatedAt: iso(1) },
    { id: "2", identifier: "FOC-200", title: "urgent open", state: "Todo", stateType: "unstarted", priority: 1, updatedAt: iso(2) },
    { id: "3", identifier: "FOC-201", title: "low open", state: "Todo", stateType: "unstarted", priority: 3, updatedAt: iso(3) },
    { id: "4", identifier: "FOC-202", title: "done already", state: "Done", stateType: "completed", priority: 0, updatedAt: iso(4) },
    { id: "5", identifier: "FOC-203", title: "no priority", state: "Triage", stateType: "backlog", priority: 0, updatedAt: iso(5) },
  ];
  const payload = buildBoardPayload({ facts, queue, now: NOW });
  assert.deepEqual(payload.columns, ["ready", "plan", "dev", "review", "test", "landed"]);
  const ready = payload.tickets.filter((t) => t.stage === "ready");
  // FOC-101 deduped (touched), FOC-202 closed, triage-only FOC-103 is Ready too
  assert.deepEqual(ready.map((t) => t.taskId), ["FOC-200", "FOC-201", "FOC-203", "FOC-103"]);
  assert.deepEqual(ready.map((t) => t.priority?.value ?? null), [1, 3, 0, null]); // priority first, none last
  // touched tickets keep their columns
  assert.equal(payload.tickets.find((t) => t.taskId === "FOC-101").stage, "dev");
  assert.equal(payload.tickets.find((t) => t.taskId === "FOC-102").stage, "review");
  assert.equal(payload.tickets.find((t) => t.taskId === "FOC-103").stage, "ready"); // triage-only → Ready
});

test("buildBoardPayload: touched column order is lastActivityAt desc", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const payload = buildBoardPayload({ facts, queue: [], now: NOW });
  const dev = payload.tickets.filter((t) => t.stage === "dev");
  const stamps = dev.map((t) => t.lastActivityAt);
  assert.deepEqual([...stamps].sort().reverse(), stamps);
});

test("buildBoardPayload: milestone and priority filters apply to Ready and touched", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const linearStates = { "FOC-101": { name: "In Progress", type: "started", priority: { value: 2, name: "High" }, milestone: "M1" } };
  const queue = [
    { id: "9", identifier: "FOC-210", title: "m1 urgent", state: "Todo", stateType: "unstarted", priority: 2, updatedAt: iso(1) },
  ];
  const withStates = buildBoardPayload({ facts, queue, linearStates, now: NOW });
  const f101 = withStates.tickets.find((t) => t.taskId === "FOC-101");
  assert.equal(f101.milestone, "M1");
  assert.deepEqual(f101.priority, { value: 2, name: "High" });

  const milestone = buildBoardPayload({ facts, queue: [], linearStates, filters: { milestone: "M1" }, now: NOW });
  assert.deepEqual(milestone.tickets.map((t) => t.taskId), ["FOC-101"]);
  const none = buildBoardPayload({ facts, queue: [], linearStates, filters: { milestone: "M2" }, now: NOW });
  assert.deepEqual(none.tickets, []);
  const priority = buildBoardPayload({ facts, queue, linearStates, filters: { priority: "2" }, now: NOW });
  // columns order puts Ready first
  assert.deepEqual(priority.tickets.map((t) => t.taskId), ["FOC-210", "FOC-101"]);
});

test("buildBoardPayload: cost rows attach, missing stay null", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const costReport = { tickets: [{ taskId: "FOC-101", childrenUsd: 1.5, supervisorUsd: 0.25, totalUsd: 1.75 }] };
  const payload = buildBoardPayload({ facts, queue: [], costReport, now: NOW });
  assert.deepEqual(payload.tickets.find((t) => t.taskId === "FOC-101").cost, {
    childrenUsd: 1.5,
    supervisorUsd: 0.25,
    totalUsd: 1.75,
  });
  assert.equal(payload.tickets.find((t) => t.taskId === "FOC-103").cost, null);
});

test("fetchLinearStates: 51 ids → 2 batched requests; then the cache serves the rest", async () => {
  const ids = Array.from({ length: 51 }, (_, i) => `FOC-${300 + i}`);
  let requests = 0;
  const gql = async (query) => {
    requests += 1;
    const aliases = [...query.matchAll(/a(\d+): issue\(id: "([^"]+)"\)/g)];
    assert.ok(aliases.length <= 50, "never more than 50 aliases per request");
    return Object.fromEntries(aliases.map(([, n, id]) => [`a${n}`, { identifier: id, title: `T ${id}`, url: `https://linear.app/${id}`, priority: 2, priorityLabel: "High", state: { name: "Todo", type: "unstarted" }, projectMilestone: { name: "M1" } }]));
  };
  const first = await fetchLinearStates(ids, { graphqlFor: () => gql });
  assert.equal(requests, 2); // 50 + 1
  assert.equal(Object.keys(first.states).length, 51);
  assert.equal(first.states["FOC-300"].priority.name, "High");
  assert.equal(first.states["FOC-300"].milestone, "M1");
  assert.equal(first.error, null);

  const second = await fetchLinearStates([...ids].reverse(), { graphqlFor: () => gql });
  assert.equal(requests, 2); // cache hit — keyed by the sorted id list
  assert.deepEqual(second.states, first.states);
});

test("fetchLinearStates: pisi gets the ids jointhubs did not know", async () => {
  const seen = [];
  const gql = (workspace) => async (query) => {
    seen.push(workspace ?? "jointhubs");
    const aliases = [...query.matchAll(/a(\d+): issue\(id: "([^"]+)"\)/g)];
    if ((workspace ?? "jointhubs") === "jointhubs") return {}; // unknown there
    return Object.fromEntries(aliases.map(([, n, id]) => [`a${n}`, { title: `P ${id}`, state: { name: "Done", type: "completed" } }]));
  };
  const { states, error } = await fetchLinearStates(["PISI-1"], { graphqlFor: gql });
  assert.deepEqual(seen, ["jointhubs", "pisi"]);
  assert.equal(states["PISI-1"].type, "completed");
  assert.equal(error, null);
});

test("fetchLinearStates: a failed request degrades to {} plus an error", async () => {
  const calls = [];
  const { states, error } = await fetchLinearStates(["FOC-400", "PISI-9"], {
    graphqlFor: (workspace) => async () => {
      calls.push(workspace ?? "jointhubs");
      throw new Error("linear down");
    },
  });
  assert.deepEqual(calls, ["jointhubs", "pisi"]);
  assert.deepEqual(states, {});
  assert.match(error, /linear down/);
});

test("fetchLinearStates: a missing pisi API key skips the pass instead of failing the lookup", async () => {
  // linear-client's graphql() refuses a workspace with no key before any
  // network call — that refusal is not "Linear unavailable" and must not land
  // in the error the board shows. Case 1: pisi was the only chance left.
  const seen = [];
  const { states, error } = await fetchLinearStates(["PISI-7"], {
    graphqlFor: (workspace) => async () => {
      seen.push(workspace ?? "jointhubs");
      if ((workspace ?? "jointhubs") === "jointhubs") return {}; // unknown there
      throw new Error("LINEAR_API_KEY not set for workspace 'pisi' (check .env)");
    },
  });
  assert.deepEqual(seen, ["jointhubs", "pisi"]);
  assert.deepEqual(states, {});
  assert.equal(error, null);

  // Case 2: jointhubs resolved what it knows; the pisi refusal is swallowed,
  // the resolved state stands, the pisi-only id stays unresolved.
  const seen2 = [];
  const gql2 = (workspace) => async (query) => {
    seen2.push(workspace ?? "jointhubs");
    const aliases = [...query.matchAll(/a(\d+): issue\(id: "([^"]+)"\)/g)];
    if ((workspace ?? "jointhubs") === "pisi") {
      throw new Error("LINEAR_API_KEY not set for workspace 'pisi' (check .env)");
    }
    return Object.fromEntries(
      aliases.filter(([, , id]) => id !== "PISI-8")
        .map(([, n, id]) => [`a${n}`, { title: `J ${id}`, state: { name: "Todo", type: "unstarted" } }]),
    );
  };
  const second = await fetchLinearStates(["FOC-500", "PISI-8"], { graphqlFor: gql2 });
  assert.deepEqual(seen2, ["jointhubs", "pisi"]);
  assert.equal(second.error, null);
  assert.ok(second.states["FOC-500"]);
  assert.equal(second.states["PISI-8"], undefined);
});

// ── labels: fetch → normalization → payload → filter (the labels task) ───────

test("normalizeLabel: { id, name, color } only; hex-validated color; nameless dropped", () => {
  assert.deepEqual(normalizeLabel({ id: "l1", name: "bug", color: "#d4c5f9" }), {
    id: "l1",
    name: "bug",
    color: "#d4c5f9",
  });
  // Name is the one required field; id and color degrade to null, never dropped.
  assert.deepEqual(normalizeLabel({ name: " nocol ", color: "javascript:alert(1)" }), {
    id: null,
    name: "nocol",
    color: null,
  });
  // Every hex form Linear issues is sayable; anything else is not a colour.
  for (const ok of ["#abc", "#aabbcc", "#aabbccdd"]) {
    assert.equal(normalizeLabel({ name: "x", color: ok }).color, ok);
  }
  for (const bad of ["red", "#aabb", "#aabbccddeeff", "", "#GGG"]) {
    assert.equal(normalizeLabel({ name: "x", color: bad }).color, null);
  }
  // A bare queue-name string normalizes too; empty/odd shapes are not labels.
  assert.deepEqual(normalizeLabel(" tech "), { id: null, name: "tech", color: null });
  assert.equal(normalizeLabel("   "), null);
  assert.equal(normalizeLabel(null), null);
  assert.equal(normalizeLabel({ color: "#fff" }), null);
  assert.equal(normalizeLabel(42), null);
});

test("fetchLinearStates: labels ride the state as { id, name, color }", async () => {
  // Unique ids — fetchLinearStates caches by id list for 60 s.
  const gql = async (query) => {
    const aliases = [...query.matchAll(/a(\d+): issue\(id: "([^"]+)"\)/g)];
    return Object.fromEntries(
      aliases.map(([, n, id]) => [
        `a${n}`,
        {
          identifier: id,
          title: `L ${id}`,
          state: { name: "Todo", type: "unstarted" },
          labels: {
            nodes: [
              { id: "lab-1", name: "bug", color: "#d4c5f9" },
              { id: "lab-2", name: "uncolored" }, // no color — kept, color null
              { name: "   " }, // nameless — not a label
              "name-only-queue-shape", // string form still normalizes
              { color: "#fff" }, // no name — dropped
            ],
          },
        },
      ]),
    );
  };
  const { states, error } = await fetchLinearStates(["FOC-601"], { graphqlFor: () => gql });
  assert.equal(error, null);
  assert.deepEqual(states["FOC-601"].labels, [
    { id: "lab-1", name: "bug", color: "#d4c5f9" },
    { id: "lab-2", name: "uncolored", color: null },
    { id: null, name: "name-only-queue-shape", color: null },
  ]);
});

test("buildBoardPayload: tickets carry normalized labels; absent stays []", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const linearStates = {
    "FOC-101": {
      name: "In Progress",
      type: "started",
      labels: [
        { id: "lab-1", name: "bug", color: "#d4c5f9" },
        { name: "tech" },
      ],
    },
  };
  const payload = buildBoardPayload({ facts, queue: [], linearStates, now: NOW });
  const f101 = payload.tickets.find((t) => t.taskId === "FOC-101");
  assert.deepEqual(f101.labels, [
    { id: "lab-1", name: "bug", color: "#d4c5f9" },
    { id: null, name: "tech", color: null },
  ]);
  // No Linear state, no queue labels — the empty case is graceful, never null.
  assert.deepEqual(payload.tickets.find((t) => t.taskId === "FOC-102").labels, []);
  // The detail's ticket entry shares the same shape.
  const detail = buildTicketDetail({
    facts: factsByTask(facts, "FOC-101"),
    linearState: linearStates["FOC-101"],
    now: NOW,
  });
  assert.deepEqual(detail.ticket.labels, f101.labels);
});

test("buildBoardPayload: Ready labels normalize from the queue's name strings", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const queue = [
    { id: "20", identifier: "FOC-230", title: "names only", state: "Todo", stateType: "unstarted", labels: ["bug", "  ", "tech"], updatedAt: iso(1) },
    { id: "21", identifier: "FOC-231", title: "no labels", state: "Todo", stateType: "unstarted", labels: [], updatedAt: iso(2) },
    { id: "22", identifier: "FOC-232", title: "labels missing field", state: "Todo", stateType: "unstarted", updatedAt: iso(3) },
    // An enriched Linear state (fetchLinearStates) wins over the queue names.
    { id: "23", identifier: "FOC-233", title: "enriched", state: "Todo", stateType: "unstarted", labels: ["stale"], updatedAt: iso(4) },
    // labelDetails (the queue patch's { id, name, color } list) beats the names.
    { id: "24", identifier: "FOC-234", title: "detailed", state: "Todo", stateType: "unstarted", labels: ["stale"], labelDetails: [{ id: "lab-8", name: "type:bug", color: "#ff0000" }], updatedAt: iso(5) },
  ];
  const linearStates = {
    "FOC-233": { name: "Todo", type: "unstarted", labels: [{ id: "lab-9", name: "fresh", color: "#00ff00" }] },
  };
  const payload = buildBoardPayload({ facts, queue, linearStates, now: NOW });
  const ready = Object.fromEntries(payload.tickets.filter((t) => t.stage === "ready").map((t) => [t.taskId, t]));
  assert.deepEqual(ready["FOC-230"].labels, [
    { id: null, name: "bug", color: null },
    { id: null, name: "tech", color: null },
  ]);
  assert.deepEqual(ready["FOC-231"].labels, []);
  assert.deepEqual(ready["FOC-232"].labels, []);
  assert.deepEqual(ready["FOC-233"].labels, [{ id: "lab-9", name: "fresh", color: "#00ff00" }]);
  assert.deepEqual(ready["FOC-234"].labels, [{ id: "lab-8", name: "type:bug", color: "#ff0000" }]);
});

test("buildBoardPayload: the label filter matches by name, touched and Ready", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const linearStates = {
    "FOC-101": { name: "In Progress", type: "started", labels: [{ name: "bug" }] },
  };
  const queue = [
    { id: "30", identifier: "FOC-240", title: "bug too", state: "Todo", stateType: "unstarted", labels: ["bug"], updatedAt: iso(1) },
    { id: "31", identifier: "FOC-241", title: "other label", state: "Todo", stateType: "unstarted", labels: ["tech"], updatedAt: iso(2) },
    { id: "32", identifier: "FOC-242", title: "unlabeled", state: "Todo", stateType: "unstarted", updatedAt: iso(3) },
  ];
  const all = buildBoardPayload({ facts, queue, linearStates, now: NOW });
  const labeled = buildBoardPayload({ facts, queue, linearStates, filters: { label: "bug" }, now: NOW });
  assert.deepEqual(labeled.tickets.map((t) => t.taskId), ["FOC-240", "FOC-101"]);
  // Unlabeled tickets can never match a named label (the milestone rule).
  assert.equal(labeled.tickets.some((t) => t.taskId === "FOC-242"), false);
  // An empty/absent filter is no filter — the full board comes back.
  const empty = buildBoardPayload({ facts, queue, linearStates, filters: { label: "" }, now: NOW });
  assert.deepEqual(empty.tickets.map((t) => t.taskId), all.tickets.map((t) => t.taskId));
});

test("buildTicketDetail: timeline order and evidence links", () => {
  const facts = collectTicketFacts({ stateHome: HOME, days: 30, now: NOW });
  const detail = buildTicketDetail({
    facts: factsByTask(facts, "FOC-102"),
    linearState: { name: "In Review", type: "started", priority: { value: 2, name: "High" }, milestone: "M1" },
    issue: { identifier: "FOC-102", title: "Ticket B", url: "https://linear.app/foc-102", description: "Do the thing" },
    costReport: { tickets: [{ taskId: "FOC-102", childrenUsd: 2, supervisorUsd: 0.5, totalUsd: 2.5 }] },
    reconciliation: { transcriptUsd: 2, telemetryUsd: 1.9, registryUsd: 2, ratio: 0.95, note: "ok" },
    now: NOW,
  });
  const times = detail.timeline.map((e) => e.at);
  assert.deepEqual([...times].sort().reverse().length === times.length ? [...times].sort() : times, [...times].sort()); // oldest first
  const kinds = detail.timeline.map((e) => e.kind);
  assert.ok(kinds.includes("spawn") && kinds.includes("exit") && kinds.includes("verdict") && kinds.includes("gate") && kinds.includes("answer"));
  const spawnIdx = kinds.indexOf("spawn");
  const exitIdx = kinds.indexOf("exit");
  assert.ok(spawnIdx < exitIdx, "spawn precedes exit");
  const verdicts = detail.timeline.filter((e) => e.kind === "verdict");
  assert.deepEqual(verdicts.map((v) => v.text), ["review round 1: FAIL", "review round 2: PASS"]);
  assert.deepEqual(detail.cost.reconciliation, { transcriptUsd: 2, telemetryUsd: 1.9, registryUsd: 2, ratio: 0.95, note: "ok" });
  assert.equal(detail.cost.totalUsd, 2.5);
  assert.equal(detail.issue.identifier, "FOC-102");
  assert.equal(detail.ticket.stage, "review");
  const evidenceKinds = detail.evidence.map((e) => e.kind);
  assert.ok(evidenceKinds.includes("verdict") && evidenceKinds.includes("tee") && evidenceKinds.includes("branch"));
  assert.ok(detail.evidence.some((e) => e.kind === "verdict" && e.path.endsWith("foc-102-round1.json")));
  const f101 = factsByTask(facts, "FOC-101");
  const runDetail = buildTicketDetail({ facts: f101, now: NOW });
  assert.ok(runDetail.evidence.some((e) => e.kind === "run" && e.href === "/runs/tr-101"));
  assert.ok(runDetail.evidence.some((e) => e.kind === "branch" && /foc-101 @ abc1234/.test(e.label)));
});

test("startText: header, truncation marker, control-char stripping", () => {
  const issue = { identifier: "FOC-123", title: "Fix the thing", url: "https://linear.app/foc-123", description: "line1\nline2" };
  assert.equal(
    startText(issue),
    "Start ticket FOC-123: Fix the thing\nhttps://linear.app/foc-123\n\nline1\nline2",
  );
  const long = { ...issue, description: "x".repeat(100) };
  const cut = startText(long, { maxChars: 80 });
  assert.ok(cut.length <= 80, "capped at maxChars");
  assert.ok(cut.endsWith("[…truncated]"));
  const dirty = { ...issue, description: "a\u0007b\u001Fc\td\ne" };
  assert.equal(startText(dirty), "Start ticket FOC-123: Fix the thing\nhttps://linear.app/foc-123\n\nabc\td\ne");
});
