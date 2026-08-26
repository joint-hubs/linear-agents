// scripts/supervisor-semaphore.test.mjs — bounded children, and held-not-dropped.
//
// WIP=1 gave backpressure for free. Once children run in parallel that property
// is gone and has to be built, or an unbounded queue of unreviewed candidates
// grows until model quotas, the repo, or Mateusz's attention is the thing that
// breaks.
//
// The two behaviours worth guarding are not the arithmetic:
//
//   · a blocked spawn is HELD, not dropped — the request survives on disk and
//     starts when a slot frees. Dropping it would make the Supervisor
//     responsible for remembering what it asked for, which is exactly the state
//     a model loses across a compaction.
//   · a saturated CONSUMER pauses the PRODUCER. Queueing at the producer would
//     grow the backlog this exists to prevent.
//
// Run: node scripts/supervisor-semaphore.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ROOT,
  STOP,
  fixtureRepo,
  fixtureRun,
  harness,
  parse,
  runScript,
  runSpawn,
  waitForStatus,
} from "./supervisor-test-fixtures.mjs";
import {
  admissionCheck,
  concurrencyFor,
  consumerOf,
  heldDir,
  queueState,
  readHeld,
  readRegistry,
  runDir,
  writeRegistry,
} from "./supervisor-lib.mjs";
import { loadGraph } from "./graph-validate.mjs";

const { test, fail, summary } = harness();
const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const graph = loadGraph();

/** A graph with one node's concurrency raised, for the tests about >1. */
const withConcurrency = (node, n) => {
  const g = structuredClone(graph);
  g.nodes[node].concurrency = n;
  return g;
};

const liveChild = (childId, squad, over = {}) => ({
  childId,
  squad,
  taskId: "FOC-123",
  status: "running",
  turns: [{ pid: 999999 }],
  costUsd: 0,
  ...over,
});

function runWith(children = {}) {
  const runId = fixtureRun();
  writeRegistry(runId, { runId, children, rounds: {} });
  return runId;
}

/** The held directory does not exist until something is held. */
const ensureHeldDir = (runId) => {
  const dir = heldDir(runId);
  mkdirSync(dir, { recursive: true });
  return dir;
};

// ── 1. limits come from the graph, not from a constant ───────────────────────
console.log("\nlimity pochodzą z grafu");

test("the per-node limit is read from config/graph.json", () => {
  assert.equal(concurrencyFor("dev", graph), 1);
  assert.equal(concurrencyFor("dev", withConcurrency("dev", 3)), 3);
});

test("a node with no declared concurrency defaults to 1, never unbounded", () => {
  // The failure to avoid: a graph edit that drops the field quietly removing the
  // bound instead of keeping the safe one.
  assert.equal(concurrencyFor("nonexistent-node", graph), 1);
  const g = structuredClone(graph);
  delete g.nodes.dev.concurrency;
  assert.equal(concurrencyFor("dev", g), 1);
});

test("no MAX_LIVE_CHILDREN_PER_RUN survives anywhere", async () => {
  // "Replaced" has to mean replaced. An orphaned constant is worse than none:
  // the next reader takes it for the live control.
  const lib = await import("./supervisor-lib.mjs");
  assert.equal(lib.MAX_LIVE_CHILDREN_PER_RUN, undefined);
  const src = readFileSync(join(ROOT, "scripts", "supervisor-spawn.mjs"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(src, /MAX_LIVE_CHILDREN_PER_RUN/);
});

test("the consumer of a node is its routable handoff edge", () => {
  assert.equal(consumerOf("dev", graph), "review");
  assert.equal(consumerOf("review", graph), "test");
  assert.equal(consumerOf("test", graph), null, "test hands off to nothing");
});

// ── 2. the semaphore ─────────────────────────────────────────────────────────
console.log("\nsemafor");

test("a free slot admits", () => {
  const runId = runWith();
  assert.equal(admissionCheck(runId, "dev", graph).admit, true);
});

test("a full node holds, and says where the limit lives", () => {
  const runId = runWith({ "dev-1": liveChild("dev-1", "dev") });
  const c = admissionCheck(runId, "dev", graph);
  assert.equal(c.admit, false);
  assert.equal(c.reason, "node-full");
  assert.match(c.detail, /graph\.json/);
});

test("raising concurrency in the graph admits the second child", () => {
  // The whole point of moving the limit into the graph: raising it is a
  // committed, reviewable edit rather than a deleted constant.
  const runId = runWith({ "dev-1": liveChild("dev-1", "dev") });
  assert.equal(admissionCheck(runId, "dev", withConcurrency("dev", 2)).admit, true);
});

test("held requests count against capacity, not just live ones", () => {
  // A held request has already been decided on and is waiting for a slot.
  // Treating it as free capacity would admit work that is already queued.
  const runId = runWith();
  const g = withConcurrency("dev", 1);
  writeFileSync(
    join(ensureHeldDir(runId), "held-dev-1.json"),
    JSON.stringify({ heldId: "held-dev-1", squad: "dev", taskId: "FOC-1", heldAt: new Date().toISOString() }),
  );
  const state = queueState(runId, g);
  assert.equal(state.dev.held, 1);
  assert.equal(state.dev.queued, 1);
  assert.equal(admissionCheck(runId, "dev", g).admit, false);
});

// ── 3. backpressure ──────────────────────────────────────────────────────────
console.log("\nbackpressure — nasycony konsument wstrzymuje producenta");

test("a saturated REVIEW pauses DEV upstream", () => {
  // DEV has a free slot of its own. It is still paused, because producing a
  // candidate REVIEW cannot absorb is not throughput.
  const runId = runWith({ "review-1": liveChild("review-1", "review") });
  const c = admissionCheck(runId, "dev", graph);
  assert.equal(c.admit, false);
  assert.equal(c.reason, "consumer-saturated");
  assert.equal(c.consumer, "review");
  assert.match(c.detail, /paused/);
});

test("the two hold reasons are distinct — they need different responses", () => {
  // A full node means wait. A saturated consumer means the graph is producing
  // faster than it can verify, and adding capacity upstream makes that worse.
  const full = admissionCheck(runWith({ "dev-1": liveChild("dev-1", "dev") }), "dev", graph);
  const back = admissionCheck(runWith({ "review-1": liveChild("review-1", "review") }), "dev", graph);
  assert.notEqual(full.reason, back.reason);
});

test("a node whose consumer has room is admitted", () => {
  const runId = runWith({ "test-1": liveChild("test-1", "test") });
  // dev's consumer is review, which is empty — test being busy is irrelevant.
  assert.equal(admissionCheck(runId, "dev", graph).admit, true);
});

// ── 4. held, not dropped ─────────────────────────────────────────────────────
console.log("\nwstrzymane, nie porzucone");

test("a blocked spawn writes a held record and exits 0", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const first = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }), fail);
  assert.equal(first.ok, true, first.error);

  const second = runSpawn(runId, repo, ["--task", "FOC-124", "--child", "dev-2"]);
  const out = parse(second, fail);
  assert.equal(second.status, 0, "a held request is not a failure");
  assert.equal(out.held, true);

  const held = readHeld(runId);
  assert.equal(held.length, 1);
  assert.equal(held[0].squad, "dev");
  // The record has to carry enough to replay the request; asking the Supervisor
  // to reconstruct it is how a held spawn quietly becomes a dropped one.
  assert.ok(Array.isArray(held[0].argv) && held[0].argv.includes("--task"));

  runScript(STOP, ["--run", runId, "--child", first.childId]);
});

test("--release starts a held request once the slot frees", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const first = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }), fail);
  runSpawn(runId, repo, ["--task", "FOC-124", "--child", "dev-2"]); // held

  // Free the slot.
  runScript(STOP, ["--run", runId, "--child", first.childId]);
  waitForStatus(runId, first.childId, ["stopped", "exited", "crashed"]);

  const out = parse(runScript(SPAWN, ["--release", "--run", runId]), fail);
  assert.equal(out.ok, true);
  assert.equal(out.released, 1, JSON.stringify(out));
  assert.equal(out.started[0].result.ok, true, JSON.stringify(out.started[0]));

  // The record is consumed, not left to be released twice.
  assert.equal(readHeld(runId).length, 0);
  assert.ok(readRegistry(runId).children["dev-2"], "the released child was never registered");
});

test("--release leaves a request held while the slot is still taken", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const first = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }), fail);
  runSpawn(runId, repo, ["--task", "FOC-124", "--child", "dev-2"]);

  const out = parse(runScript(SPAWN, ["--release", "--run", runId]), fail);
  assert.equal(out.released, 0);
  assert.equal(out.stillHeld.length, 1);
  assert.ok(out.stillHeld[0].why, "a request left held must say why");
  assert.equal(readHeld(runId).length, 1, "the record was consumed without starting anything");

  runScript(STOP, ["--run", runId, "--child", first.childId]);
});

test("status reports held requests with their reason", () => {
  const { repo } = fixtureRepo();
  const runId = fixtureRun();
  const first = parse(runSpawn(runId, repo, [], { MOCK_CLAUDE_HANG_MS: "20000" }), fail);
  runSpawn(runId, repo, ["--task", "FOC-124", "--child", "dev-2"]);

  const status = parse(runScript(join(ROOT, "scripts", "supervisor-status.mjs"), ["--run", runId]), fail);
  assert.equal(status.held.length, 1);
  assert.equal(status.held[0].squad, "dev");
  assert.equal(status.held[0].reason, "node-full");

  runScript(STOP, ["--run", runId, "--child", first.childId]);
});

test("an unreadable held record still occupies its slot", () => {
  // Hiding it would release the slot to someone else while whoever wrote it is
  // still waiting.
  const runId = runWith();
  const dir = ensureHeldDir(runId);
  writeFileSync(join(dir, "held-broken.json"), "{ not json");
  const held = readHeld(runId);
  assert.equal(held.length, 1);
  assert.equal(held[0].unreadable, true);

  const out = parse(runScript(SPAWN, ["--release", "--run", runId]), fail);
  assert.equal(out.released, 0);
  assert.match(out.stillHeld[0].why, /unreadable/);
  assert.ok(existsSync(join(dir, "held-broken.json")), "an unreadable record was silently deleted");
});

summary();
