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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadGraph } from "./graph-validate.mjs";
import {
  buildIntake, extractSignals, labelRecordedIntake, propose, resolveNode, resolveSizeFlow, stateOf, verdictForNode,
} from "./supervisor-triage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "scripts", "supervisor-triage.mjs");

let passed = 0;
const failures = [];
// The intake tests (FOC-451) await stub callers — they are queued and run
// after the sync body, so a rejected promise can never print a green line
// past the summary.
const asyncTests = [];

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

function testAsync(name, fn) {
  asyncTests.push({ name, fn });
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

test("In Progress with no return flag → ask (returned vs. still held is not decidable)", () => {
  const r = p({ state: "In Progress", stateType: "started", body: AC_BODY, estimate: 3 });
  assert.equal(r.proposal, "ask");
  assert.equal(r.confidence, "low");
  assert.ok(r.unknowns.some((u) => u.includes("In Progress")));
});

test("In Progress + returned-by:review → dev (FOC-284 return edge)", () => {
  // The discriminator supervisor-verdict stamps on a review fail. Without it
  // this case would still land on ask — fresh DEV work carries no return flag.
  const r = p({ state: "In Progress", stateType: "started", labels: ["returned-by:review"], body: AC_BODY, estimate: 3 });
  assert.equal(r.proposal, "dev");
  assert.equal(r.confidence, "high");
});

test("In Progress + returned-by:test → dev (same key, emitter deferred FOC-165)", () => {
  const r = p({ state: "In Progress", stateType: "started", labels: ["returned-by:test"], body: AC_BODY, estimate: 3 });
  assert.equal(r.proposal, "dev");
});

// ── 4b. the return flag outranks a stale hand-off comment (FOC-284 round 2) ──
console.log("\nflag powrotu bije stary komentarz hand-off");

test("In Progress + returned-by:review + latest hand-off from dev → dev, not ask", () => {
  // The headline case F1 closed. Every returned task carries a hand-off comment
  // from the round BEFORE the fail (comments are append-only), so treating a
  // flag × hand-off disagreement as mixed signals made `ask` the DEFAULT for
  // the return itself. The flag is the machine stamp — newer by construction.
  const r = p({
    state: "In Progress", stateType: "started",
    labels: ["returned-by:review"], body: AC_BODY, estimate: 3,
    comments: [handoffComment("dev")],
  });
  assert.equal(r.proposal, "dev");
  assert.equal(r.confidence, "high");
  assert.ok(!r.unknowns.some((u) => u.includes("mixed signals")), JSON.stringify(r.unknowns));
});

test("mixed signals with NO return flag still ask — the precedence is flag-gated", () => {
  // Regression pin: In Review + coded routes to review; a stale plan hand-off
  // routes to dev. No return flag → the two families have no ordering → ask.
  const r = p({
    state: "In Review", stateType: "started", labels: ["coded"], body: AC_BODY,
    comments: [handoffComment("plan")],
  });
  assert.equal(r.proposal, "ask");
  assert.equal(r.confidence, "low");
  assert.ok(r.unknowns.some((u) => u.includes("mixed signals")), JSON.stringify(r.unknowns));
});

test("In Review + coded + lingering flag + dev hand-off → review (consistent with the state pin)", () => {
  // DEV's re-hand-off goes through here after fixing a returned round: the
  // state-gated rule fires before the return rule, flag inert, same as the
  // no-handoff pin above.
  const r = p({
    state: "In Review", stateType: "started", labels: ["coded", "returned-by:review"],
    body: AC_BODY, comments: [handoffComment("dev")],
  });
  assert.equal(r.proposal, "review");
});

test("In Progress + returned-by:test + stale hand-off → dev (the FOC-165 emitter copies this)", () => {
  // Pinned now, while test's emitter is still off: the review hand-off routes
  // to test, the flag routes to dev, the flag wins.
  const r = p({
    state: "In Progress", stateType: "started",
    labels: ["returned-by:test"], body: AC_BODY, estimate: 3,
    comments: [handoffComment("review")],
  });
  assert.equal(r.proposal, "dev");
  assert.equal(r.confidence, "high");
});

test("a lingering return flag cannot steal a re-hand-off — In Review + coded routes to review", () => {
  // DEV's re-hand-off stamps coded + In Review; the state-gated rule 3 fires
  // before the return rule is ever reached, so a stale flag is inert.
  const r = p({ state: "In Review", stateType: "started", labels: ["coded", "returned-by:review"], body: AC_BODY });
  assert.equal(r.proposal, "review");
});

test("a needs:* label still outranks the return flag — the order-1 gate wins", () => {
  const r = p({ state: "In Progress", stateType: "started", labels: ["returned-by:review", "needs-decision"], body: AC_BODY, estimate: 3 });
  assert.equal(r.node, "human");
  assert.equal(r.proposal, "ask");
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
  assert.match(JSON.parse(r.stdout).error, /propose \| record \| intake/);
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

// ── 9. intake — the seam's annotations next to the verdict (FOC-451) ─────────
console.log("\nintake (FOC-451)");

// The seam is stubbed at the exact contract buildIntake consumes: a registry
// call ({state, decisionId}) answered with the A0 envelope — annotation,
// confidence, eventId. No network, no key, ever.
const ANSWERS = {
  "intake.triage_node": { q0: "dev" },
  "intake.has_acceptance_criteria": { q0: true },
  "intake.task_size": { size: "medium" },
};
const stubCaller = () => async ({ decisionId }) => ({
  ok: true,
  decisionId,
  annotation: { answers: ANSWERS[decisionId], confidence: 0.9 },
  eventId: `evt-${decisionId}`,
});

testAsync("stateOf composes title + body and caps at the seam's 16000-char state cap", async () => {
  assert.equal(stateOf({ title: "T", description: "b" }), "Title: T\n\nb");
  assert.equal(stateOf({ description: "body" }), "body");
  assert.equal(stateOf({ title: "T", description: "x".repeat(20000) }).length, 16000);
});

testAsync("intake records the three seam annotations with answers, confidence and eventIds", async () => {
  const { record, warnings } = await buildIntake({ issue: issue({ title: "T", body: AC_BODY }), graph: GRAPH, caller: stubCaller() });
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  for (const id of ["intake.triage_node", "intake.has_acceptance_criteria", "intake.task_size"]) {
    const d = record.decisions[id];
    assert.equal(d.ok, true, id);
    assert.ok(d.answer !== null && d.answer !== undefined, `${id} answer`);
    assert.equal(d.confidence, 0.9, id);
    assert.match(d.eventId, /^evt-intake\./, id);
  }
  assert.equal(record.decisions["intake.triage_node"].answer, "dev");
  assert.equal(record.decisions["intake.has_acceptance_criteria"].answer, true);
  assert.equal(record.frontman.proposal, "dev", "the deterministic frontman proposal rides along");
  assert.equal(record.disagreement, null, "seam and frontman agree → no disagreement invented");
  assert.equal(record.size, "medium");
  // suggestedFlow is pinned against an explicit mapping fixture below — the
  // committed graph may or may not carry intakeFlows at this commit.
});

testAsync("a seam/frontman disagreement is surfaced, never auto-acted", async () => {
  const caller = async ({ decisionId }) => ({
    ok: true,
    decisionId,
    annotation: { answers: { ...(decisionId === "intake.triage_node" ? { q0: "plan" } : ANSWERS[decisionId]) }, confidence: 0.9 },
    eventId: `evt-${decisionId}`,
  });
  const { record } = await buildIntake({ issue: issue({ body: AC_BODY }), graph: GRAPH, caller });
  assert.deepEqual(record.disagreement, { decisionId: "intake.triage_node", seam: "plan", frontman: "dev" });
  // A0: the seam's answer is displayed data — recorded verbatim, never swapped
  // for the frontman's, never acted on.
  assert.equal(record.decisions["intake.triage_node"].answer, "plan");
});

testAsync("no API key → every decision fails closed, visibly, and the record still builds", async () => {
  const authMissing = async () => {
    const err = new Error("OPENROUTER_API_KEY is not set — tier-1 Jev needs it");
    err.code = "auth_missing";
    throw err;
  };
  const { record, warnings } = await buildIntake({ issue: issue({ body: AC_BODY }), graph: GRAPH, caller: authMissing });
  for (const id of Object.keys(record.decisions)) {
    assert.equal(record.decisions[id].ok, false, id);
    assert.equal(record.decisions[id].code, "auth_missing", id);
  }
  assert.equal(warnings.length, 3, JSON.stringify(warnings));
  assert.equal(record.disagreement, null, "no annotation → no disagreement invented");
});

testAsync("a pre-provider failure still carries the eventId — the label join works later", async () => {
  const refused = async ({ decisionId }) => ({
    ok: false,
    error: { code: "schema_invalid", message: "state rejected" },
    eventId: `evt-${decisionId}`,
  });
  const { record } = await buildIntake({ issue: issue({ body: AC_BODY }), graph: GRAPH, caller: refused });
  assert.equal(record.decisions["intake.triage_node"].eventId, "evt-intake.triage_node");
  assert.equal(record.decisions["intake.triage_node"].code, "schema_invalid");
});

testAsync("the seam's size feeds the suggested flow only where the config mapping knows it", async () => {
  const g = clone();
  g.intakeFlows = { small: [], medium: ["dev", "test"], large: ["plan", "dev", "review", "test"] };
  const { record } = await buildIntake({ issue: issue({ body: AC_BODY }), graph: g, caller: stubCaller() });
  assert.deepEqual(record.suggestedFlow, { size: "medium", squads: ["dev", "test"] });

  const g2 = clone();
  delete g2.intakeFlows; // robust whether or not the committed graph carries the mapping yet
  const { record: r2 } = await buildIntake({ issue: issue({ body: AC_BODY }), graph: g2, caller: stubCaller() });
  assert.equal(r2.suggestedFlow, undefined);
  assert.match(r2.flowReason, /no "intakeFlows" size→flow mapping/);
});

test("resolveSizeFlow reads the config mapping and refuses what it does not know", () => {
  const g = { intakeFlows: { small: [], medium: ["dev", "test"], large: ["plan", "dev", "review", "test"] } };
  assert.deepEqual(resolveSizeFlow(g, "medium"), ["dev", "test"]);
  assert.deepEqual(resolveSizeFlow(g, "small"), []);
  assert.throws(() => resolveSizeFlow(g, "huge"), /unknown size "huge"/);
  assert.throws(() => resolveSizeFlow({}, "medium"), /no "intakeFlows" size→flow mapping/);
  assert.throws(() => resolveSizeFlow({ intakeFlows: "x" }, "medium"), /no "intakeFlows" size→flow mapping/);
});

test("intake refuses without --run, before any network or file write", () => {
  // LA_SUPERVISOR_RUN blanked: a supervised session sets it, and this refusal
  // must fire even there — --run is required, not inherited-by-luck.
  const r = run(["intake", "--issue", "FOC-999", "--issue-file", fixture({ body: AC_BODY })], { OPENROUTER_API_KEY: "", LA_SUPERVISOR_RUN: "" });
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /--run/);
});

test("intake with no API key fails closed, visibly, and still writes the sibling record", () => {
  const runId = withRun();
  cleanup.push(join(ROOT, ".state", "runs", runId)); // the caller's shadow log
  const r = run(
    ["intake", "--issue", "FOC-999", "--issue-file", fixture({ body: AC_BODY, title: "T" }), "--run", runId],
    { OPENROUTER_API_KEY: "" },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  for (const id of ["intake.triage_node", "intake.has_acceptance_criteria", "intake.task_size"]) {
    assert.equal(out.decisions[id].ok, false, id);
    assert.equal(out.decisions[id].code, "auth_missing", id);
    assert.match(out.decisions[id].eventId, /^[0-9a-f-]{36}$/, `${id} event id`);
  }
  assert.equal(out.warnings.length, 3, JSON.stringify(out.warnings));
  assert.equal(out.disagreement, null);
  assert.match(r.stderr, /failed closed/, "the failure is announced, not swallowed");
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "intake.json"), "utf8"));
  assert.equal(rec.runId, runId);
  assert.equal(rec.issue, "FOC-999");
  assert.equal(rec.decisions["intake.triage_node"].code, "auth_missing");
  assert.ok(existsSync(join(ROOT, ".state", "runs", runId, "decisions.jsonl")), "the shadow events exist even for failed calls");
});

test("record embeds the intake summary next to the verdict and displays the disagreement", () => {
  const runId = withRun();
  const dir = runDirOf(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "intake.json"),
    JSON.stringify({
      issue: "FOC-999", createdAt: "2026-09-22T00:00:00.000Z", runId,
      decisions: {
        "intake.triage_node": { ok: true, answer: "plan", confidence: 0.9, eventId: "evt-t" },
        "intake.has_acceptance_criteria": { ok: true, answer: true, confidence: 0.9, eventId: "evt-a" },
        "intake.task_size": { ok: true, answer: "medium", confidence: 0.9, eventId: "evt-s" },
      },
      frontman: { proposal: "dev", node: "dev", confidence: "high" },
      disagreement: { decisionId: "intake.triage_node", seam: "plan", frontman: "dev" },
      size: "medium",
    }),
    "utf8",
  );
  const r = run(["record", "--issue", "FOC-999", "--verdict", "dev", "--rationale", "AC present", "--confidence", "85", "--run", runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(dir, "triage.json"), "utf8"));
  assert.equal(rec.verdict, "dev");
  assert.deepEqual(rec.intake.disagreement, { decisionId: "intake.triage_node", seam: "plan", frontman: "dev" });
  assert.equal(rec.intake.decisions["intake.triage_node"].eventId, "evt-t");
  assert.equal(rec.intake.decisions["intake.has_acceptance_criteria"].answer, true);
  assert.ok(!("size" in rec), "no --size → no final size on the record");
  assert.match(r.stderr, /A0 disagreement — seam intake\.triage_node says "plan"/);
  assert.match(r.stderr, /displayed, never auto-acted/);
});

test("record --size is validated against the config mapping — unknown sizes are refused", () => {
  const runId = withRun();
  const r = run([
    "record", "--issue", "FOC-1", "--verdict", "dev", "--rationale", "x", "--confidence", "85",
    "--size", "colossal", "--run", runId,
  ]);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /size/);
  assert.ok(!existsSync(join(runDirOf(runId), "triage.json")), "a refused size must not leave a verdict behind");
});

test("the recorded verdict/size become FOC-449 labels tied to the intake eventIds", () => {
  const runsDir = join(tmp, "runs-labels");
  const logDir = join(runsDir, "test-triage-labels");
  mkdirSync(logDir, { recursive: true });
  const evtT = "evt-triage-1";
  const evtS = "evt-size-1";
  writeFileSync(
    join(logDir, "decisions.jsonl"),
    JSON.stringify({ type: "event", eventId: evtT, decisionId: "intake.triage_node" }) + "\n" +
      JSON.stringify({ type: "event", eventId: evtS, decisionId: "intake.task_size" }) + "\n",
    "utf8",
  );
  const { labelled, warnings } = labelRecordedIntake({
    intake: {
      runId: "test-triage-labels",
      decisions: {
        "intake.triage_node": { ok: true, answer: "dev", eventId: evtT },
        "intake.task_size": { ok: true, answer: "medium", eventId: evtS },
      },
    },
    verdict: "dev",
    size: "medium",
    runsDir,
  });
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  assert.equal(labelled.length, 2);
  const labels = readFileSync(join(logDir, "decisions.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l))
    .filter((l) => l.type === "label");
  const byEvent = Object.fromEntries(labels.map((l) => [l.eventId, l]));
  assert.equal(byEvent[evtT].outcome, "dev");
  assert.equal(byEvent[evtT].by, "agent");
  assert.equal(byEvent[evtT].source, "auto");
  assert.equal(byEvent[evtT].via, "verdict");
  assert.equal(byEvent[evtS].outcome, "medium");
});

test("an intake without eventIds labels nothing and warns nobody", () => {
  const { labelled, warnings } = labelRecordedIntake({
    intake: { runId: "nowhere", decisions: { "intake.triage_node": { ok: true, answer: "dev" } } },
    verdict: "dev",
    runsDir: join(tmp, "runs-empty"),
  });
  assert.equal(labelled.length, 0);
  assert.equal(warnings.length, 0);
});

test("record labels the final verdict against the offline intake's eventId (end to end)", () => {
  const runId = withRun();
  const runsDir = join(ROOT, ".state", "runs");
  cleanup.push(join(runsDir, runId));
  // intake — offline (no key): the events exist, the answers do not.
  const i = run(
    ["intake", "--issue", "FOC-999", "--issue-file", fixture({ body: AC_BODY }), "--run", runId],
    { OPENROUTER_API_KEY: "" },
  );
  assert.equal(i.status, 0, i.stdout + i.stderr);
  const intakeRec = JSON.parse(readFileSync(join(runDirOf(runId), "intake.json"), "utf8"));
  const evtT = intakeRec.decisions["intake.triage_node"].eventId;
  assert.ok(evtT, "a failed call still carries its event id");
  // record the verdict → the label lands in the run log that holds the event.
  const r = run(["record", "--issue", "FOC-999", "--verdict", "dev", "--rationale", "x", "--confidence", "85", "--run", runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = readFileSync(join(runsDir, runId, "decisions.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const label = lines.find((l) => l.type === "label" && l.eventId === evtT);
  assert.ok(label, "the label is in the run log holding the event");
  assert.equal(label.outcome, "dev");
  assert.equal(label.by, "agent");
  assert.equal(label.via, "verdict");
  const evtS = intakeRec.decisions["intake.task_size"].eventId;
  assert.ok(!lines.some((l) => l.type === "label" && l.eventId === evtS), "no final size → no size label");
});

// ── summary ───────────────────────────────────────────────────────────────────
(async () => {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      passed++;
      console.log(`  PASS ${name}`);
    } catch (err) {
      failures.push(name);
      console.log(`  FAIL ${name}\n       ${err.message}`);
    }
  }
  console.log("");
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} FAILED`);
    process.exitCode = 1;
    return;
  }
  console.log(`${passed} passed, 0 failed`);
})();
