// scripts/supervisor-budget.test.mjs — the split, and the borrowing it refuses.
//
// The failure this whole mechanism exists to prevent has one shape: DEV spends
// the issue budget, REVIEW and TEST have nothing left, and the run ends with
// work nobody checked. A single global cap cannot express that — it only tells
// you afterwards, when the money is gone and the code is unread.
//
// So the load-bearing test here is not the arithmetic. It is that an exhausted
// stage is REFUSED while other stages still hold money, and that the money it
// was refused is still there afterwards.
//
// Run: node scripts/supervisor-budget.test.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ROOT,
  fixtureRepo,
  fixtureRun,
  harness,
  parse,
  runScript,
  runSpawn,
} from "./supervisor-test-fixtures.mjs";
import {
  allocateBudget,
  budgetPath,
  readRegistry,
  runDir,
  spendByStage,
  stageBudgetStatus,
  stageForSquad,
  writeRegistry,
} from "./supervisor-lib.mjs";
import { loadGraph } from "./graph-validate.mjs";

const { test, fail, summary } = harness();
const BUDGET = join(ROOT, "scripts", "supervisor-budget.mjs");
const graph = loadGraph();

const budget = (runId, args) => runScript(BUDGET, [...args, "--run", runId]);

/** A run with an allocation and a dev child whose spend we control. */
function scenario({ total = 10, devSpend = 0, reviewSpend = 0 } = {}) {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  writeRegistry(runId, {
    runId,
    rounds: {},
    children: {
      "dev-1": { childId: "dev-1", squad: "dev", taskId: "FOC-123", status: "exited", costUsd: devSpend, turns: [] },
      "review-1": { childId: "review-1", squad: "review", taskId: "FOC-123", status: "exited", costUsd: reviewSpend, turns: [] },
    },
  });
  parse(budget(runId, ["allocate", "--total", String(total)]), fail);
  return { runId, repo };
}

// ── 1. the arithmetic ────────────────────────────────────────────────────────
console.log("\nalokacja");

test("the split sums to the total, reserve included", () => {
  const a = allocateBudget(10, graph);
  const sum = Object.values(a.stages).reduce((x, y) => x + y, 0) + a.reserve;
  assert.equal(Number(sum.toFixed(4)), 10);
});

test("shares follow the graph's own hints", () => {
  // dev 0.45 synthesis · plan 0.2 discovery · review 0.2 + test 0.1 verification
  const a = allocateBudget(10, graph);
  assert.equal(a.stages.synthesis, 4.5);
  assert.equal(a.stages.discovery, 2);
  assert.equal(a.stages.verification, 3);
  assert.equal(a.reserve, 0.5);
});

test("hints are normalised, not trusted to sum to 1", () => {
  // A graph edit that changes one hint must not silently under- or over-allocate
  // the whole run. Halving every hint must not halve the budget.
  const halved = structuredClone(graph);
  for (const node of Object.values(halved.nodes)) {
    if (node.budget?.shareHint) node.budget.shareHint /= 2;
  }
  const a = allocateBudget(10, halved);
  const sum = Object.values(a.stages).reduce((x, y) => x + y, 0) + a.reserve;
  assert.equal(Number(sum.toFixed(4)), 10);
  assert.equal(a.stages.synthesis, 4.5);
});

test("out-of-band nodes are allocated nothing", () => {
  // cadence is time-triggered and human is a wait — neither is an issue's work.
  const a = allocateBudget(10, graph);
  assert.equal(a.stages["out-of-band"], undefined);
  assert.equal(stageForSquad("cadence", graph), "out-of-band");
});

test("a nonsense total or reserve share is refused, not rounded away", () => {
  assert.throws(() => allocateBudget(0, graph), /> 0/);
  assert.throws(() => allocateBudget(-5, graph), /> 0/);
  assert.throws(() => allocateBudget(10, { ...graph, budgetPolicy: { reserveShare: 1 } }), /reserveShare/);
});

test("a squad maps to the stage its node declares", () => {
  assert.equal(stageForSquad("dev", graph), "synthesis");
  assert.equal(stageForSquad("review", graph), "verification");
  assert.equal(stageForSquad("test", graph), "verification");
  assert.equal(stageForSquad("plan", graph), "discovery");
});

test("an unpriced child makes its STAGE unknown, never free", () => {
  const { stages } = spendByStage(
    { children: { a: { squad: "dev", costUsd: null }, b: { squad: "dev", costUsd: 1 } } },
    graph,
  );
  assert.equal(stages.synthesis, null, "an unknown cost was silently treated as zero");
});

// ── 2. the refusal that matters ──────────────────────────────────────────────
console.log("\netap nie pożycza od innego etapu");

test("an exhausted stage is refused, and says it will not borrow", () => {
  const { runId, repo } = scenario({ total: 10, devSpend: 5 }); // synthesis alloc 4.5
  const out = parse(runSpawn(runId, repo, ["--child", "dev-2"]), fail);

  assert.equal(out.ok, false);
  assert.match(out.error, /synthesis/);
  assert.match(out.error, /NOT borrow/);
});

test("the money it was refused is still in the other stages", () => {
  // The assertion that makes the previous one mean something: refusing DEV is
  // only worth doing if verification's money actually survives it.
  const { runId, repo } = scenario({ total: 10, devSpend: 5 });
  runSpawn(runId, repo, ["--child", "dev-2"]);

  const b = stageBudgetStatus(runId, { graph });
  assert.equal(b.stages.verification.spent, 0);
  assert.equal(b.stages.verification.remaining, 3);
  assert.equal(b.stages.verification.exhausted, false);
});

test("a stage inside its allocation is not blocked", () => {
  const { runId, repo } = scenario({ total: 10, devSpend: 1 });
  const out = parse(runSpawn(runId, repo, ["--child", "dev-2"]), fail);
  assert.equal(out.ok, true, out.error);
});

test("a run with no allocation is not blocked at all", () => {
  // Opt-in per run: a run started before `budget allocate` must not become
  // unstartable, and the global cap still applies to it.
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  assert.equal(stageBudgetStatus(runId, { graph }), null);
  const out = parse(runSpawn(runId, repo), fail);
  assert.equal(out.ok, true, out.error);
});

// ── 3. the reserve ───────────────────────────────────────────────────────────
console.log("\nrezerwa");

test("the overrun is charged to the reserve, measured not estimated", () => {
  // An authorisation is permission to overspend; what it COSTS is the distance
  // the stage actually went past its allocation, computed after the fact.
  const { runId } = scenario({ total: 10, devSpend: 4.6 }); // 0.1 over 4.5
  const b = stageBudgetStatus(runId, { graph });
  assert.equal(b.stages.synthesis.over, 0.1);
  assert.equal(b.reserveDrawn, 0.1, "the overrun was not charged to the reserve");
  assert.equal(b.reserveRemaining, 0.4);
});

test("an authorisation lets the overrun through", () => {
  const { runId, repo } = scenario({ total: 10, devSpend: 4.6 });
  assert.equal(parse(runSpawn(runId, repo, ["--child", "dev-2"]), fail).ok, false);

  parse(budget(runId, ["authorise", "--stage", "synthesis", "--reason", "tool failure forced a retry"]), fail);

  const out = parse(runSpawn(runId, repo, ["--child", "dev-3"]), fail);
  assert.equal(out.ok, true, out.error);
});

test("an unpriced child makes the stage UNKNOWN and the gate refuses", () => {
  // A budget that cannot be evaluated is not a budget — FOC-165's rule, applied
  // per stage. Real runs hit this whenever a model has no price row.
  //
  // The registry is written directly rather than waiting for a spawned child to
  // land unpriced: that is a race with the watcher, and the first version of
  // this test passed or failed depending on which won. What is under test is the
  // gate, not the watcher's timing.
  const { runId, repo } = scenario({ total: 10, devSpend: 1 });
  const reg = readRegistry(runId);
  reg.children["dev-unpriced"] = {
    childId: "dev-unpriced",
    squad: "dev",
    taskId: "FOC-123",
    status: "exited",
    costUsd: null,
    unpricedModels: ["some/unlisted-model"],
    turns: [],
  };
  writeRegistry(runId, reg);

  const b = stageBudgetStatus(runId, { graph });
  assert.equal(b.stages.synthesis.spent, null, "an unpriced child did not make the stage unknown");

  const out = parse(runSpawn(runId, repo, ["--child", "dev-3"]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /UNKNOWN/);
});

test("an authorisation without a reason is refused", () => {
  // A rubber stamp cannot be reconciled from afterwards: `reconcile` has to be
  // able to say WHY a stage was allowed past its allocation.
  const { runId } = scenario();
  const out = parse(budget(runId, ["authorise", "--stage", "synthesis"]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /--reason/);
});

test("an unknown stage cannot be authorised", () => {
  const { runId } = scenario();
  const out = parse(budget(runId, ["authorise", "--stage", "wishful", "--reason", "x"]), fail);
  assert.equal(out.ok, false);
  assert.ok(out.stages.includes("synthesis"));
});

test("exhausting the reserve stops expansion and writes a partial-status report", () => {
  // The point of the report: stopping with an error and nothing else is the
  // silent halt this task exists to prevent.
  const { runId, repo } = scenario({ total: 10, devSpend: 5.1 }); // 0.6 over 4.5, reserve is 0.5
  parse(budget(runId, ["authorise", "--stage", "synthesis", "--reason", "retry"]), fail);

  const out = parse(runSpawn(runId, repo, ["--child", "dev-2"]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /reserve is exhausted/);

  const path = join(runDir(runId), "partial-status.json");
  assert.ok(existsSync(path), "no partial-status report was written");
  const report = JSON.parse(readFileSync(path, "utf8"));

  // The useful column: money already spent whose result nobody can vouch for.
  assert.ok(report.unverified.includes("FOC-123"), JSON.stringify(report.unverified));
  assert.equal(report.tasks[0].verdict, null);
  assert.ok(report.budget.reserveExhausted);
});

// ── 4. two caps, ordered ─────────────────────────────────────────────────────
console.log("\ndwa limity, uporządkowane");

test("the global cap is the outer backstop and names itself", () => {
  // Not a competing cap: the stage gate is the working control, and each
  // refusal has to say which of the two it was, or the operator cannot tell
  // what to change.
  const { runId, repo } = scenario({ total: 100, devSpend: 3 }); // stage is fine
  const r = runSpawn(runId, repo, ["--child", "dev-2"], { LA_SUPERVISOR_MAX_COST_USD: "1" });
  const out = parse(r, fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /LA_SUPERVISOR_MAX_COST_USD|budget spent/);
  assert.doesNotMatch(out.error, /NOT borrow/, "the stage gate answered a global-cap refusal");
});

// ── 5. re-allocation and reconciliation ──────────────────────────────────────
console.log("\nrealokacja i rozliczenie");

test("re-allocating mid-run takes --force", () => {
  // It rewrites the denominator every earlier refusal was measured against.
  const { runId } = scenario({ total: 10 });
  const out = parse(budget(runId, ["allocate", "--total", "20"]), fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /already has an allocation/);

  const forced = parse(budget(runId, ["allocate", "--total", "20", "--force"]), fail);
  assert.equal(forced.ok, true, forced.error);
  assert.equal(forced.total, 20);
});

test("authorisations survive a forced re-allocation", () => {
  // They record decisions Mateusz already made; a bigger budget does not un-make
  // them.
  const { runId } = scenario({ total: 10 });
  parse(budget(runId, ["authorise", "--stage", "synthesis", "--reason", "retry"]), fail);
  const forced = parse(budget(runId, ["allocate", "--total", "20", "--force"]), fail);
  assert.equal(forced.authorisations.length, 1);
  assert.equal(forced.authorisations[0].reason, "retry");
});

test("reconcile reports the share this run actually used", () => {
  // The step that turns budget.shareHint from a guess into a measured number.
  const { runId } = scenario({ total: 10, devSpend: 3, reviewSpend: 1 });
  const out = parse(budget(runId, ["reconcile", "--json"]), fail);
  assert.equal(out.ok, true, out.error);

  const synthesis = out.stages.find((s) => s.stage === "synthesis");
  assert.equal(synthesis.spent, 3);
  assert.equal(synthesis.allocated, 4.5);
  assert.equal(synthesis.observedShare, 0.75, "3 of 4 spent is not 75%");
  // One run is not a trend, and the tool has to say so rather than inviting an
  // edit to graph.json off a single sample.
  assert.match(out.hint, /one run is not a trend/i);
});

test("an unreadable budget refuses in JSON, not with a stack trace", () => {
  // Every other refusal in this runtime is JSON on stdout, and the Supervisor
  // parses stdout and nothing else. This one threw: spawn exited 1 with an empty
  // stdout and a stack trace on stderr, which is a refusal the lead cannot read.
  const { runId, repo } = scenario({ total: 10 });
  writeFileSync(budgetPath(runId), "{ not json");

  const r = runSpawn(runId, repo, ["--child", "dev-9"]);
  assert.ok(r.stdout.trim().startsWith("{"), `stdout was not JSON: ${r.stdout.slice(0, 80)}`);
  const out = parse(r, fail);
  assert.equal(out.ok, false);
  assert.match(out.error, /could not be read/);
});

test("status refuses helpfully when there is no allocation", () => {
  const runId = fixtureRun();
  const out = parse(budget(runId, ["status"]), fail);
  assert.equal(out.ok, false);
  assert.match(out.hint, /allocate/);
  assert.match(out.note, /LA_SUPERVISOR_MAX_COST_USD/);
});

test("the allocation is on disk where status and the gate both read it", () => {
  const { runId } = scenario({ total: 10 });
  const plan = JSON.parse(readFileSync(budgetPath(runId), "utf8"));
  assert.equal(plan.total, 10);
  assert.equal(plan.stages.synthesis, 4.5);
  assert.ok(plan.allocatedAt);
});

summary();
