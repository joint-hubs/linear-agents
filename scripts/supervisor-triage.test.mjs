// scripts/supervisor-triage.test.mjs — the verdict is the contract, so prove it.
//
// Three things are worth failing a build over here.
//
// 1. THE PROPOSAL COMES FROM THE GRAPH. Not from four hardcoded squad names. If
//    someone deletes a node from config/graph.json, triage must refuse — a
//    fallback to `plan` would spawn a squad nobody chose and log it as a
//    decision. The "unresolvable node" tests are that guarantee.
//
// 2. AMBIGUITY IS NOT ROUNDED AWAY. Mixed signals, `In Progress`, a completed
//    issue, a body that contradicts its own labels — each one must land on
//    `ask` with low confidence, not on the nearest plausible squad. Every one
//    of these cases is a place where a confident wrong answer costs a whole
//    child run.
//
// 3. CALIBRATION IS ENFORCED IN TOOLING, not in prose. `record` refuses
//    confidence <70 on any verdict but `ask`, the same way the review-loop cap
//    refuses a third loop. A rule that only lives in CLAUDE.md is a suggestion.
//
// Run: node scripts/supervisor-triage.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadGraph } from "./graph-validate.mjs";
import { extractSignals, propose, resolveNode, verdictForNode } from "./supervisor-triage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "supervisor-triage.mjs");

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

const tmp = mkdtempSync(join(tmpdir(), "la-triage-test-"));
process.on("exit", () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

// A Linear issue as `linear-query.mjs issue <id> --json` returns it.
function issue({ id = "FOC-999", state = "Backlog", stateType = "backlog", labels = [], body = "", comments = [], estimate = null } = {}) {
  return {
    identifier: id,
    description: body,
    state: { name: state, type: stateType },
    labels: { nodes: labels.map((name) => ({ name })) },
    comments: { nodes: comments.map((b) => ({ body: b })) },
    estimate,
    children: { nodes: [] },
  };
}

const AC_BODY = [
  "## Acceptance Criteria",
  "",
  "**Given** a thing **When** it happens **Then** it works",
  "",
  "## Definition of Done",
  "",
  "* it is done",
].join("\n");

// The real rendering from publish-linear-comment.mjs: marker line, then heading.
const handoffComment = (squad) =>
  [`<!-- run:run:${squad}-handoff:FOC-999 -->`, "", `## ${squad} · hand-off · ${squad}-2026`].join("\n");

const p = (opts) => propose(extractSignals(issue(opts)), GRAPH);

// ── 1. Signals are read, not guessed ──────────────────────────────────────────
console.log("\nsygnały");

test("empty body, no AC, no DoD, no estimate", () => {
  const s = extractSignals(issue({ body: "   \n  " }));
  assert.equal(s.bodyEmpty, true);
  assert.equal(s.hasAcceptanceCriteria, false);
  assert.equal(s.hasDefinitionOfDone, false);
  assert.equal(s.estimateMissing, true);
  assert.equal(s.handoffFrom, null);
});

test("AC and DoD sections are recognised", () => {
  const s = extractSignals(issue({ body: AC_BODY, estimate: 3 }));
  assert.equal(s.bodyEmpty, false);
  assert.equal(s.hasAcceptanceCriteria, true);
  assert.equal(s.hasDefinitionOfDone, true);
  assert.equal(s.estimateMissing, false);
});

test("the LATEST hand-off comment wins, not the first", () => {
  // A task that bounced review→dev→review carries several. The oldest one
  // describes where it used to be, which is exactly the wrong answer.
  const s = extractSignals(issue({ comments: [handoffComment("plan"), handoffComment("dev")] }));
  assert.equal(s.handoffFrom, "dev");
});

test("a hand-off comment is found by its marker alone", () => {
  // publish-linear-comment writes both; a hand-edited comment may keep only one.
  const s = extractSignals(issue({ comments: ["<!-- run:run:dev-handoff:FOC-1 -->\nfree text"] }));
  assert.equal(s.handoffFrom, "dev");
});

test("labels survive both shapes Linear returns", () => {
  assert.deepEqual(extractSignals(issue({ labels: ["dor-ok"] })).labels, ["dor-ok"]);
  assert.deepEqual(extractSignals({ identifier: "X", labels: ["raw"] }).labels, ["raw"]);
});

// ── 2. The four AC cases ──────────────────────────────────────────────────────
console.log("\npropozycje — cztery przypadki z AC");

test("empty body → plan, high", () => {
  const r = p({ body: "" });
  assert.equal(r.proposal, "plan");
  assert.equal(r.node, "plan");
  assert.equal(r.confidence, "high");
});

test("acceptance criteria present → dev, high", () => {
  const r = p({ body: AC_BODY, estimate: 3, labels: ["dor-ok"] });
  assert.equal(r.proposal, "dev");
  assert.equal(r.confidence, "high");
});

test("hand-off comment from dev → review, high", () => {
  const r = p({ body: AC_BODY, comments: [handoffComment("dev")] });
  assert.equal(r.proposal, "review");
  assert.equal(r.confidence, "high");
});

test("mixed signals → ask, low", () => {
  // State+labels route to dev (Todo + dor-ok); the newest hand-off is from
  // review, which routes to test. Two families, two answers.
  const r = p({ state: "Todo", stateType: "unstarted", labels: ["dor-ok"], body: AC_BODY, comments: [handoffComment("review")] });
  assert.equal(r.proposal, "ask");
  assert.equal(r.confidence, "low");
  assert.ok(
    r.unknowns.some((u) => u.includes("mixed signals")),
    `unknowns should name the conflict, got: ${JSON.stringify(r.unknowns)}`,
  );
});

// ── 3. Routing comes from the graph's own edges ───────────────────────────────
console.log("\nrouting z grafu");

test("needs:* routes to human before anything else", () => {
  const r = p({ state: "Todo", stateType: "unstarted", labels: ["dor-ok", "needs-decision"], body: AC_BODY });
  assert.equal(r.proposal, "ask");
  assert.equal(r.node, "human");
});

test("the needs wildcard is separator-agnostic (JOI-68)", () => {
  // The doc convention is `needs:answer`, the live workspace uses
  // `needs-decision`. Both must reach the human node.
  for (const label of ["needs:answer", "needs-decision"]) {
    assert.equal(p({ labels: [label], body: AC_BODY }).node, "human", label);
  }
});

test("Todo + dor-ok → dev, In Review + coded → review, stage:testing → test", () => {
  assert.equal(p({ state: "Todo", stateType: "unstarted", labels: ["dor-ok"] }).proposal, "dev");
  assert.equal(p({ state: "In Review", stateType: "started", labels: ["coded"] }).proposal, "review");
  assert.equal(p({ state: "In Review", stateType: "started", labels: ["stage:testing"] }).proposal, "test");
});

test("a routable edge beats the body signals", () => {
  // Empty body would say `plan`; the graph says dev. The graph wins, because
  // the graph is what the dashboard shows Mateusz for the same task.
  assert.equal(p({ state: "Todo", stateType: "unstarted", labels: ["dor-ok"], body: "" }).proposal, "dev");
});

test("adding a routable edge changes the proposal with no code change", () => {
  // The point of routing from config: topology is data. If this ever needs a
  // code edit to honour a new edge, the graph stopped being the source of truth.
  const g = clone();
  g.edges.push({
    id: "blocked-to-human", from: "*", to: "human", type: "gate", routable: true,
    order: 0, when: { labels: ["blocked:*"] }, why: "test edge",
  });
  const r = propose(extractSignals(issue({ labels: ["blocked-on-vendor"], body: AC_BODY })), g);
  assert.equal(r.node, "human");
});

// ── 4. Ambiguity is never rounded away ────────────────────────────────────────
console.log("\nniepewność zostaje niepewnością");

test("In Progress → ask (returned vs. still held is not decidable)", () => {
  const r = p({ state: "In Progress", stateType: "started", body: AC_BODY, estimate: 3 });
  assert.equal(r.proposal, "ask");
  assert.equal(r.confidence, "low");
  assert.ok(r.unknowns.some((u) => u.includes("In Progress")));
});

test("a completed or canceled issue → ask, never re-routed", () => {
  for (const [state, type] of [["Done", "completed"], ["Canceled", "canceled"]]) {
    const r = p({ state, stateType: type, body: AC_BODY, estimate: 3 });
    assert.equal(r.proposal, "ask", state);
    assert.ok(r.unknowns.some((u) => u.includes("already")), state);
  }
});

test("labels claiming readiness over an empty body → ask", () => {
  const r = p({ labels: ["dor-ok"], body: "" });
  assert.equal(r.proposal, "ask");
  assert.equal(r.confidence, "low");
});

test("a hand-off from test has no next node — recorded, not invented", () => {
  // `test` is terminal in the graph. Inventing a successor would be the
  // hardcoded path this whole design removes.
  const r = p({ body: AC_BODY, comments: [handoffComment("test")] });
  assert.ok(r.unknowns.some((u) => u.includes("no outgoing handoff edge")), JSON.stringify(r.unknowns));
});

test("unknowns list the gaps even when confidence is high", () => {
  const r = p({ body: "" });
  assert.equal(r.confidence, "high");
  assert.ok(r.unknowns.length >= 3, `expected the gaps to be listed, got ${JSON.stringify(r.unknowns)}`);
});

// ── 5. Node resolution refuses rather than defaults ───────────────────────────
console.log("\nrozwiązanie węzła");

test("every verdict resolves to a declared node; ask → human", () => {
  for (const v of ["plan", "dev", "review", "test"]) assert.equal(resolveNode(GRAPH, v), v);
  assert.equal(resolveNode(GRAPH, "ask"), "human");
});

test("a verdict with no node in the graph throws and names the declared set", () => {
  const g = clone();
  delete g.nodes.human;
  assert.throws(() => resolveNode(g, "ask"), /does not declare/);
  assert.throws(() => resolveNode(g, "ask"), /plan, dev, review, test/);
});

test("propose never falls back to plan when the node is missing", () => {
  const g = clone();
  delete g.nodes.dev;
  assert.throws(
    () => propose(extractSignals(issue({ state: "Todo", stateType: "unstarted", labels: ["dor-ok"] })), g),
    /not declared in config\/graph.json/,
  );
});

test("a node the verdict vocabulary cannot name is refused, not guessed", () => {
  // `cadence` is a real node with no verdict — `record --verdict cadence` does
  // not exist. Proposing it would produce a decision nobody can act on.
  assert.equal(verdictForNode(GRAPH, "human"), "ask");
  assert.throws(() => verdictForNode(GRAPH, "cadence"), /has no verdict name/);
});

test("autonomy is read from the resolved node and echoed", () => {
  const r = p({ body: AC_BODY, estimate: 3 });
  assert.equal(r.autonomy, GRAPH.nodes[r.node].autonomy);
  assert.equal(r.requiresConfirmation, true, "every node ships supervised, so confirmation is always required today");
});

test("a bounded node would not require confirmation (the field is wired, not decorative)", () => {
  const g = clone();
  g.nodes.dev.autonomy = "bounded";
  const r = propose(extractSignals(issue({ state: "Todo", stateType: "unstarted", labels: ["dor-ok"] })), g);
  assert.equal(r.autonomy, "bounded");
  assert.equal(r.requiresConfirmation, false);
});

// ── 6. CLI ────────────────────────────────────────────────────────────────────
console.log("\nCLI");

let fixtureN = 0;
function fixture(opts) {
  const path = join(tmp, `issue-${fixtureN++}.json`);
  writeFileSync(path, JSON.stringify(issue(opts)), "utf8");
  return path;
}
const run = (args, env = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });

test("propose --issue-file prints JSON on stdout and exits 0", () => {
  const r = run(["propose", "--issue", "FOC-999", "--issue-file", fixture({ body: "" })]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.proposal, "plan");
  assert.equal(out.issue, "FOC-999");
  assert.ok(out.signals, "signals travel with the proposal so the rationale is inspectable");
});

test("a missing issue file is a JSON refusal, not a stack trace", () => {
  const r = run(["propose", "--issue", "FOC-999", "--issue-file", join(tmp, "nope.json")]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).ok, false);
});

test("an unreadable issue file is a JSON refusal", () => {
  const path = join(tmp, "broken.json");
  writeFileSync(path, "{not json", "utf8");
  const r = run(["propose", "--issue", "FOC-999", "--issue-file", path]);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /not readable JSON/);
});

test("an unknown subcommand is refused", () => {
  const r = run(["triage", "--issue", "FOC-999"]);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /propose \| record/);
});

// ── 7. record — the contract, and its calibration gate ────────────────────────
console.log("\nrecord");

let runN = 0;
const freshRun = () => `test-triage-${process.pid}-${runN++}`;
const runDirOf = (id) => join(ROOT, ".state", "supervisor", id);
const cleanup = [];
process.on("exit", () => {
  for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});
function withRun() {
  const id = freshRun();
  cleanup.push(runDirOf(id));
  return id;
}

test("record writes triage.json with the §2.4 schema", () => {
  const runId = withRun();
  const r = run([
    "record", "--issue", "FOC-999", "--verdict", "dev", "--rationale", "AC present",
    "--confidence", "85", "--proposal", "dev", "--unknown", "no estimate", "--unknown", "no DoD",
    "--run", runId,
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const path = join(runDirOf(runId), "triage.json");
  assert.ok(existsSync(path), "triage.json is where supervisor-spawn.mjs looks for it");
  const rec = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(rec).sort(), [
    "autonomy", "confidence", "createdAt", "decidedBy", "issue", "node", "proposal", "rationale", "unknowns", "verdict",
  ]);
  assert.equal(rec.verdict, "dev");
  assert.equal(rec.node, "dev");
  assert.equal(rec.autonomy, "supervised");
  assert.equal(rec.decidedBy, "supervisor");
  assert.deepEqual(rec.unknowns, ["no estimate", "no DoD"]);
});

test("LA_SUPERVISOR_RUN stands in for --run", () => {
  const runId = withRun();
  const r = run(["record", "--issue", "FOC-1", "--verdict", "ask", "--rationale", "x", "--confidence", "40"], { LA_SUPERVISOR_RUN: runId });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(existsSync(join(runDirOf(runId), "triage.json")));
});

test("confidence below 70 with a non-ask verdict is refused", () => {
  const runId = withRun();
  const r = run(["record", "--issue", "FOC-1", "--verdict", "dev", "--rationale", "hunch", "--confidence", "50", "--run", runId]);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /below 70/);
  assert.ok(!existsSync(join(runDirOf(runId), "triage.json")), "a refused record must not leave a verdict behind");
});

test("confidence below 70 with ask is allowed — that is the whole point", () => {
  const runId = withRun();
  const r = run(["record", "--issue", "FOC-1", "--verdict", "ask", "--rationale", "unclear", "--confidence", "50", "--run", runId]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).node, "human");
});

test("confidence is required, not defaulted", () => {
  const runId = withRun();
  const r = run(["record", "--issue", "FOC-1", "--verdict", "dev", "--rationale", "x", "--run", runId]);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /--confidence/);
});

test("confidence must be an integer inside 0-100", () => {
  const runId = withRun();
  for (const bad of ["101", "-1", "abc", "85.5"]) {
    const r = run(["record", "--issue", "FOC-1", "--verdict", "dev", "--rationale", "x", "--confidence", bad, "--run", runId]);
    assert.equal(r.status, 1, bad);
    assert.match(JSON.parse(r.stdout).error, /integer 0-100/, bad);
  }
});

test("an unknown verdict is refused", () => {
  const runId = withRun();
  const r = run(["record", "--issue", "FOC-1", "--verdict", "cadence", "--rationale", "x", "--confidence", "90", "--run", runId]);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /--verdict must be one of/);
});

test("re-recording the SAME issue is allowed; a different issue takes --force", () => {
  const runId = withRun();
  const base = ["record", "--verdict", "ask", "--rationale", "x", "--confidence", "90", "--run", runId];
  assert.equal(run([...base, "--issue", "FOC-1"]).status, 0);
  // New information legitimately changes a verdict for the same issue.
  assert.equal(run([...base, "--issue", "FOC-1"]).status, 0, "re-triage of the same issue must not be blocked");

  const other = run([...base, "--issue", "FOC-2"]);
  assert.equal(other.status, 1, "a second issue would retarget every spawn in the run");
  assert.match(JSON.parse(other.stdout).error, /already has a verdict for FOC-1/);

  assert.equal(run([...base, "--issue", "FOC-2", "--force"]).status, 0, "--force is the deliberate override");
  assert.equal(JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8")).issue, "FOC-2");
});

// ── 8. Integration with supervisor-spawn's fail-closed gate ───────────────────
console.log("\nintegracja ze spawnem");

const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const spawnCli = (args, env = {}) =>
  spawnSync(process.execPath, [SPAWN, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, LA_SUPERVISOR_NO_TELEMETRY: "1", ...env } });

test("no triage.json → spawn refuses (AC-2, fail-closed)", () => {
  const runId = withRun();
  const r = spawnCli(["--squad", "dev", "--task", "FOC-999", "--prompt", "go", "--run", runId]);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /no triage verdict recorded/);
});

test("a recorded verdict opens the gate — the next refusal is about something else", () => {
  // Proof that the two halves are wired to the SAME path: record writes it,
  // spawn stops complaining about it. Spawn is then pointed at a directory that
  // is not a repo, so it fails on the next check instead of starting a child.
  const runId = withRun();
  assert.equal(
    run(["record", "--issue", "FOC-999", "--verdict", "dev", "--rationale", "AC present", "--confidence", "85", "--run", runId]).status,
    0,
  );
  const notARepo = mkdtempSync(join(tmpdir(), "la-not-a-repo-"));
  const r = spawnCli(["--squad", "dev", "--task", "FOC-999", "--prompt", "go", "--run", runId, "--repo", notARepo]);
  rmSync(notARepo, { recursive: true, force: true });
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stdout).error;
  assert.ok(!/triage/.test(err), `the triage gate should be past; got: ${err}`);
  assert.match(err, /not inside a git repository/);
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
