// scripts/graph-validate.test.mjs — the graph describes reality, and can prove it.
//
// Two jobs here, and the second one is the important one.
//
// 1. Every failure mode the validator claims to catch is actually caught, with a
//    message that names the offender. A validator that says "invalid" and makes
//    you diff by hand does not get used.
//
// 2. THE EQUIVALENCE PROOF. config/handoff-rules.json is what telemetry-server.mjs
//    reads at runtime today, and it is being retired in favour of config/graph.json.
//    The migration is only safe if the graph reproduces the current routing exactly
//    — same rules, same order, same rationale text. That is what
//    "emitHandoffRules reproduces the committed handoff-rules.json" asserts. If it
//    ever fails, either the graph lost a rule or someone edited the generated file
//    by hand; both are the data loss this test exists to prevent.
//
// When telemetry-server.mjs is rewired to read graph.json directly,
// handoff-rules.json, the emitter and check (2) are deleted together.
//
// Run: node scripts/graph-validate.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadGraph, validateGraph, emitHandoffRules, emitPuml } from "./graph-validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const fail = (msg) => { throw new Error(msg); };

const GRAPH = loadGraph();
const clone = () => JSON.parse(JSON.stringify(GRAPH));
const hasProblem = (problems, needle) => problems.some((p) => p.includes(needle));

// ── 1. The committed graph is well-formed ─────────────────────────────────────
console.log("\ncommitted graph");

test("config/graph.json validates clean", () => {
  const problems = validateGraph(GRAPH);
  if (problems.length) fail(`expected no problems, got:\n       ${problems.join("\n       ")}`);
});

test("every node ships as supervised", () => {
  const promoted = Object.entries(GRAPH.nodes)
    .filter(([, n]) => n.autonomy !== "supervised")
    .map(([name, n]) => `${name} → ${n.autonomy}`);
  // Promotion is a deliberate committed decision backed by telemetry, and it is
  // blocked until FOC-163 (grounded verdicts) exists. If this fails, check that
  // the promotion was intentional rather than a copy-paste.
  if (promoted.length) fail(`node(s) promoted above supervised:\n       ${promoted.join("\n       ")}`);
});

test("every node names a budget stage", () => {
  const missing = Object.entries(GRAPH.nodes)
    .filter(([, n]) => !n.budget?.stage)
    .map(([name]) => name);
  if (missing.length) fail(`no budget.stage on: ${missing.join(", ")} — FOC-162 allocates per stage`);
});

// ── 2. Each documented failure mode is caught ─────────────────────────────────
console.log("\nvalidator catches what it claims to");

test("unknown node referenced by an edge", () => {
  const g = clone();
  g.edges.push({ id: "bogus", from: "dev", to: "nowhere", type: "handoff", routable: false, why: "x" });
  const problems = validateGraph(g);
  if (!hasProblem(problems, 'unknown node "nowhere"')) {
    fail(`expected an unknown-node problem naming "nowhere", got: ${problems.join(" | ")}`);
  }
});

test("unknown node in `from` is caught too", () => {
  const g = clone();
  g.edges.push({ id: "bogus", from: "ghost", to: "dev", type: "handoff", routable: false, why: "x" });
  if (!hasProblem(validateGraph(g), 'unknown node "ghost" as from')) {
    fail("a bad `from` slipped through");
  }
});

test('the "*" wildcard source is not reported as an unknown node', () => {
  // The needs:* gate applies wherever the task sits, so its source is "*", not a
  // node. Treating it as unknown would make the committed graph unvalidatable.
  const problems = validateGraph(GRAPH);
  if (hasProblem(problems, '"*"')) fail("the any-source wildcard was rejected");
});

test("node with no inbound edge and not in entryNodes", () => {
  const g = clone();
  g.nodes.orphan = {
    autonomy: "supervised",
    budget: { stage: "synthesis", shareHint: 0 },
    input: {}, output: {}, completion: "x", failure: "x",
  };
  if (!hasProblem(validateGraph(g), 'node "orphan" has no inbound edge')) {
    fail("an unreachable node was accepted");
  }
});

test("declared entry nodes are exempt from the inbound-edge rule", () => {
  // plan is triggered by planning/inbox/, cadence by a weekly timer — neither has
  // a task for an edge to match against. Without this exemption the real graph
  // could never validate.
  const inbound = new Set(GRAPH.edges.map((e) => e.to));
  for (const name of GRAPH.entryNodes) {
    if (inbound.has(name)) continue;
    if (hasProblem(validateGraph(GRAPH), `node "${name}" has no inbound edge`)) {
      fail(`entry node ${name} was flagged as unreachable`);
    }
  }
});

test("entryNodes naming a node that does not exist", () => {
  const g = clone();
  g.entryNodes = [...g.entryNodes, "imaginary"];
  if (!hasProblem(validateGraph(g), 'entryNodes lists "imaginary"')) {
    fail("a bogus entry node was accepted");
  }
});

test("edge type outside the four known types", () => {
  const g = clone();
  g.edges[0] = { ...g.edges[0], type: "sideways" };
  if (!hasProblem(validateGraph(g), 'has type "sideways"')) {
    fail("an unknown edge type was accepted");
  }
});

test("node missing any of the five required contract fields", () => {
  for (const field of ["input", "output", "completion", "failure", "budget"]) {
    const g = clone();
    delete g.nodes.dev[field];
    if (!hasProblem(validateGraph(g), `node "dev" is missing required contract field "${field}"`)) {
      fail(`a node missing "${field}" was accepted`);
    }
  }
});

test("node missing autonomy, or carrying an unknown level", () => {
  const g1 = clone();
  delete g1.nodes.review.autonomy;
  if (!hasProblem(validateGraph(g1), 'node "review" is missing "autonomy"')) {
    fail("a node with no autonomy was accepted");
  }
  const g2 = clone();
  g2.nodes.review.autonomy = "yolo";
  if (!hasProblem(validateGraph(g2), 'autonomy "yolo"')) {
    fail("an unknown autonomy level was accepted");
  }
});

test("routable edge with no `when` condition", () => {
  const g = clone();
  const edge = g.edges.find((e) => e.routable);
  delete edge.when;
  if (!hasProblem(validateGraph(g), "routable but declares no")) {
    fail("a routable edge with no condition was accepted");
  }
});

test("two routable edges sharing an order", () => {
  // First-match-wins routing makes order meaningful; a tie is a silent coin flip.
  const g = clone();
  const routable = g.edges.filter((e) => e.routable);
  routable[1].order = routable[0].order;
  if (!hasProblem(validateGraph(g), "share an `order`")) {
    fail("ambiguous routing order was accepted");
  }
});

test("duplicate edge ids", () => {
  const g = clone();
  g.edges.push({ ...g.edges[0] });
  if (!hasProblem(validateGraph(g), "duplicate edge id")) fail("a duplicate edge id was accepted");
});

test("edge with no `why`", () => {
  // The rationale is the part worth keeping. handoff-rules.json's comments carry
  // the JOI-68 incident (six needs-decision tasks routing to null); losing that
  // prose is the real data loss, not losing the rule.
  const g = clone();
  delete g.edges[0].why;
  if (!hasProblem(validateGraph(g), 'has no "why"')) fail("an unexplained edge was accepted");
});

// ── 3. The equivalence proof ─────────────────────────────────────────────────
console.log("\nequivalence with the file telemetry-server.mjs reads today");

test("emitHandoffRules reproduces the committed config/handoff-rules.json", () => {
  const committed = JSON.parse(readFileSync(join(ROOT, "config", "handoff-rules.json"), "utf8"));
  const generated = emitHandoffRules(GRAPH);
  // deepStrictEqual, not a byte compare: formatting is irrelevant, semantics are
  // not. Order IS semantics here — the matcher takes the first match.
  assert.deepStrictEqual(
    generated,
    committed,
    "the graph no longer reproduces the live routing — a rule was lost, reordered, or the generated file was hand-edited",
  );
});

test("the needs:* gate is still the first rule", () => {
  // A blocked task must route to the human regardless of state. If this ever
  // stops being rule 1, blocked tasks start getting picked up by squads.
  const [first] = emitHandoffRules(GRAPH);
  if (first.next !== "human" || !first.when.labels?.includes("needs:*")) {
    fail(`rule 1 is ${JSON.stringify(first.when)} → ${first.next}, expected the needs:* human gate`);
  }
});

test("non-routable edges stay out of the emitted rules", () => {
  const generated = emitHandoffRules(GRAPH);
  const declaredOnly = GRAPH.edges.filter((e) => !e.routable).map((e) => e.id);
  if (!declaredOnly.length) fail("expected at least the return edges to be declared-not-routed");
  if (generated.length !== GRAPH.edges.filter((e) => e.routable).length) {
    fail("emitted rule count does not match the routable edge count");
  }
});

test("the review→dev return path is declared but deliberately not routed", () => {
  // It matches no rule today, so returns route to null in the dashboard. Enabling
  // it needs a "returned, round > 0" discriminator, because In Progress is also
  // the state of work DEV currently holds. Separate task, visible UI change.
  const edge = GRAPH.edges.find((e) => e.id === "review-to-dev-return");
  if (!edge) fail("the return edge is missing from the graph");
  if (edge.type !== "return") fail(`return edge typed as "${edge.type}"`);
  if (edge.routable) fail("the return edge became routable — that changes live dashboard behaviour");
});

// ── 4. Rendering ─────────────────────────────────────────────────────────────
console.log("\npuml rendering");

test("emitPuml produces a complete diagram naming every node", () => {
  const puml = emitPuml(GRAPH);
  if (!puml.startsWith("@startuml") || !puml.trimEnd().endsWith("@enduml")) {
    fail("output is not a complete PlantUML document");
  }
  for (const name of Object.keys(GRAPH.nodes)) {
    if (!puml.includes(`as ${name}`)) fail(`node "${name}" is missing from the diagram`);
  }
});

test("emitPuml renders the any-source gate without inventing a node", () => {
  const puml = emitPuml(GRAPH);
  if (!puml.includes('rectangle "any node" as ANY')) fail("the ANY marker is missing");
  if (/^\* /m.test(puml)) fail('a raw "*" leaked into the diagram as a node name');
});

// ── 5. The CLI itself ────────────────────────────────────────────────────────
// Exercised end-to-end: exit codes and stream discipline are the contract other
// tooling depends on, and neither is visible from the exported functions.
console.log("\ncli");

const CLI = join(ROOT, "scripts", "graph-validate.mjs");
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("exits 0 on the committed graph", () => {
  const r = run();
  if (r.status !== 0) fail(`exit ${r.status}: ${r.stderr}`);
});

test("exits 1 and names every problem on a broken graph", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-validate-"));
  const broken = clone();
  broken.edges.push({ id: "x", from: "dev", to: "nowhere", type: "sideways", routable: false, why: "x" });
  delete broken.nodes.test.completion;
  const path = join(dir, "graph.json");
  writeFileSync(path, JSON.stringify(broken));

  const r = run(path);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  if (!r.stderr.includes('unknown node "nowhere"')) fail("the unknown node was not reported");
  if (!r.stderr.includes('has type "sideways"')) fail("the bad edge type was not reported");
  if (!r.stderr.includes('missing required contract field "completion"')) {
    fail("the missing contract field was not reported");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("exits 1 with a named error when the file is unreadable", () => {
  const r = run(join(tmpdir(), "definitely-not-here-graph.json"));
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  if (!r.stderr.includes("could not be read")) fail("no readable error message");
});

test("emitters put the artifact on stdout and nothing else", () => {
  // `--emit-puml > file` must capture a renderable document, not a status line.
  const puml = run("--emit-puml");
  if (!puml.stdout.startsWith("@startuml")) fail("stdout does not begin the diagram");
  if (puml.stderr.trim()) fail(`stderr polluted the artifact stream: ${puml.stderr}`);

  const rules = run("--emit-handoff-rules");
  const parsed = JSON.parse(rules.stdout);
  assert.deepStrictEqual(parsed, emitHandoffRules(GRAPH));
  if (rules.stderr.trim()) fail(`stderr polluted the artifact stream: ${rules.stderr}`);
});

test("a broken graph is never rendered", () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-validate-"));
  const broken = clone();
  broken.edges[0].type = "sideways";
  const path = join(dir, "graph.json");
  writeFileSync(path, JSON.stringify(broken));

  const r = run(path, "--emit-puml");
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  if (r.stdout.includes("@startuml")) fail("a broken graph was rendered anyway");
  rmSync(dir, { recursive: true, force: true });
});

// ── summary ──────────────────────────────────────────────────────────────────
console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
