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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadGraph } from "./graph-validate.mjs";
import { getRegistryEntry } from "./decision-registry.mjs";
import {
  buildIntake, claimFailureReason, extractSignals, labelRecordedIntake, propose, resolveNode, resolveSizeFlow, stateOf, verdictForNode,
} from "./supervisor-triage.mjs";
import { createTaskSessionStore } from "./task-sessions.mjs";

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

// ── ownership isolation (FOC-848) ─────────────────────────────────────────────
// Every CLI child below must see a KNOWN ownership config: a developer's real
// settings overlay (which may carry a restricted `ownership` key) must never
// leak in. The env-file rung short-circuits the loader before the overlay is
// read, so pinning LA_TASK_OWNERSHIP_CONFIG at module load makes every test
// unrestricted by default; the restricted tests override it per run.
const UNRESTRICTED_OWNERSHIP = join(tmp, "ownership-unrestricted.json");
writeFileSync(UNRESTRICTED_OWNERSHIP, JSON.stringify({ version: 1, owners: {}, unlisted: "allow" }), "utf8");
process.env.LA_TASK_OWNERSHIP_CONFIG = UNRESTRICTED_OWNERSHIP;

// The restricted install the ownership tests run against: Fenix belongs to the
// orchestrator, JW to the supervisor, everything else asks.
const RESTRICTED_OWNERSHIP = {
  version: 1,
  owners: {
    orchestrator: { linearProjects: ["Fenix — wydanie 1.0 i kontrola kosztów"] },
    supervisor: { linearProjects: ["proj-jw-id"] },
  },
  unlisted: "ask",
};
const RESTRICTED_ALLOW = { ...RESTRICTED_OWNERSHIP, unlisted: "allow" };
const ownershipFile = (name, data) => {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(data), "utf8");
  return path;
};
const restrictedEnv = (data = RESTRICTED_OWNERSHIP, owner = "supervisor") => ({
  LA_TASK_OWNERSHIP_CONFIG: ownershipFile(`ownership-${owner}-${data.unlisted}.json`, data),
  LA_TASK_OWNER: owner,
});

// A Linear issue as `linear-query.mjs issue <id> --json` returns it.
function issue({ id = "FOC-999", state = "Backlog", stateType = "backlog", labels = [], body = "", comments = [], estimate = null, project } = {}) {
  return {
    identifier: id,
    description: body,
    state: { name: state, type: stateType },
    labels: { nodes: labels.map((name) => ({ name })) },
    comments: { nodes: comments.map((b) => ({ body: b })) },
    estimate,
    children: { nodes: [] },
    ...(project !== undefined ? { project } : {}),
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

// ── 1b. the AC heading variants (FOC-577) ─────────────────────────────────────
console.log("\nwarianty nagłówka AC (FOC-577, FOC-605)");

test("all three AC heading variants are recognized", () => {
  // FOC-577: a bare `## Acceptance` heading routed to `plan` because the signal
  // read false. `Kryteria akceptacji` was already matched — pinned here so it
  // stays that way.
  for (const body of [
    "## Acceptance criteria\n\n* it works",
    "## Acceptance\n\n* it works",
    "## Kryteria akceptacji\n\n* działa",
  ]) {
    assert.equal(extractSignals(issue({ body })).hasAcceptanceCriteria, true, JSON.stringify(body));
  }
  // The `propose` path agrees: the "no acceptance criteria section" unknown
  // must not be raised over a body that carries the bare heading.
  const r = p({ body: "## Acceptance\n\n* it works", estimate: 3 });
  assert.ok(!r.unknowns.some((u) => u.includes("no acceptance criteria section")), JSON.stringify(r.unknowns));
});

test("AC heading matching keeps its tolerance: case, level 1-6, trailing colon", () => {
  for (const body of [
    "# acceptance criteria",
    "###### ACCEPTANCE:",
    "### Kryteria Akceptacji:",
    "## Acceptance Criteria:",
  ]) {
    assert.equal(extractSignals(issue({ body })).hasAcceptanceCriteria, true, JSON.stringify(body));
  }
});

test("`## Acceptance ceremony notes` is not the acceptance criteria section", () => {
  // The bare variant is anchored to end-of-line: a heading that merely STARTS
  // with "Acceptance" is a different section and must not light the signal.
  assert.equal(extractSignals(issue({ body: "## Acceptance ceremony notes\n\n* wear a hat" })).hasAcceptanceCriteria, false);
  // The long variants keep their prefix semantics — a suffix after the heading
  // text is still the section.
  assert.equal(
    extractSignals(issue({ body: "## Acceptance criteria for the widget\n\n* it works" })).hasAcceptanceCriteria,
    true,
  );
});

test("inline AC forms keep working (regression pin)", () => {
  assert.equal(
    extractSignals(issue({ body: "**Given** a thing **When** it happens **Then** it works" })).hasAcceptanceCriteria,
    true,
  );
  assert.equal(extractSignals(issue({ body: "AC-1: it works" })).hasAcceptanceCriteria, true);
});

test("the bare `## AC` heading is the acceptance criteria section (FOC-605)", () => {
  // FOC-605: `## AC` matched none of the three patterns, so a body whose only
  // AC marker was that heading read as having none — and an implementable task
  // routed to `plan`, costing a plan round before any code. None of these
  // bodies carry `AC-<n>` or `**Given**`, so the bare heading is the ONLY
  // thing that can light the signal here.
  for (const body of ["## AC\n\n* it works", "## AC:\n\n* it works", "# AC\n\n* it works", "###### AC:\n\n* it works"]) {
    assert.equal(extractSignals(issue({ body })).hasAcceptanceCriteria, true, JSON.stringify(body));
  }
  // The `propose` path agrees, exactly as for the bare `## Acceptance` heading.
  const r = p({ body: "## AC\n\n* it works", estimate: 3 });
  assert.ok(!r.unknowns.some((u) => u.includes("no acceptance criteria section")), JSON.stringify(r.unknowns));
});

test("the `## AC` shorthand keeps the bare heading's end-of-line anchoring (FOC-605)", () => {
  // AC-3: the property FOC-577 pinned has to hold for the new alternative too.
  // `## Acceptance ceremony notes` and its `## AC ...` equivalent are the same
  // kind of other-section heading, and neither may light the signal.
  for (const body of [
    "## Acceptance ceremony notes\n\n* wear a hat",
    "## AC ceremony notes\n\n* wear a hat",
    "## AC review notes\n\n* look at it",
  ]) {
    assert.equal(extractSignals(issue({ body })).hasAcceptanceCriteria, false, JSON.stringify(body));
  }
});

test("`## ACME notes` and `## Action items` are not the acceptance criteria section (FOC-605)", () => {
  // AC-2 negatives. `AC` followed by more word characters is a different word,
  // not the shorthand — the `\b` after the alternative is what says so, and the
  // end-of-line anchor is what says it twice.
  for (const body of [
    "## ACME notes\n\n* accounting",
    "## Action items\n\n* do the thing",
    "## ACK log\n\n* who approved what",
    "no marker at all\n\n* just prose",
  ]) {
    assert.equal(extractSignals(issue({ body })).hasAcceptanceCriteria, false, JSON.stringify(body));
  }
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

// FOC-902 review: what `linear-query issue --json` really returns carries BOTH
// a Linear uuid `id` and the display `identifier`. The lease key must come
// from the identifier — a uuid key never matches the store every other
// writer keys by.
const UUID_ID = "3f2a7c8e-9b1d-4e6f-8a2c-5d7b9f0e1a3b";
const uuidIssueFile = (identifier) => {
  const path = join(tmp, `issue-${fixtureN++}.json`);
  writeFileSync(path, JSON.stringify({ ...issue({ id: identifier }), id: UUID_ID }), "utf8");
  return path;
};
const run = (args, env = {}) => {
  const childEnv = { ...process.env, LA_DATA_HOME: storeHome, ...env };
  // Tests below read the repo-root .state/runs and .state/supervisor paths —
  // an exported dev LA_STATE_ROOT would redirect the child elsewhere.
  delete childEnv.LA_STATE_ROOT;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", env: childEnv });
};

// FOC-902: the lease check reads the task-session store through LA_DATA_HOME
// (the FOC-901 seam). A per-suite empty dir keeps every CLI test hermetic —
// the dev machine's real store must never decide a test's verdict. Lease
// tests below point LA_DATA_HOME at their own seeded dir.
const storeHome = mkdtempSync(join(tmpdir(), "la-triage-store-"));
process.on("exit", () => { try { rmSync(storeHome, { recursive: true, force: true }); } catch {} });

// Issue fixtures feed --issue-file (argparse, propose and intake): the lease
// check does NOT consult the loaded payload in `record` — its key comes from
// the `--issue` argument — and `intake` keys through `issuePartOf`, so a
// payload with a Linear uuid `id` keys by the identifier, never the uuid.
const FIX = {
  "FOC-1": fixture({ id: "FOC-1" }),
  "FOC-2": fixture({ id: "FOC-2" }),
  "FOC-999": fixture({}),
};
const issueFile = (id) => ["--issue-file", FIX[id] ?? (FIX[id] = fixture({ id }))];

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
    "record", "--issue", "FOC-999", ...issueFile("FOC-999"), "--verdict", "dev", "--rationale", "AC present",
    "--confidence", "85", "--proposal", "dev", "--unknown", "no estimate", "--unknown", "no DoD",
    "--run", runId,
  ], { FENIX_WORK_WORKSPACE: "jointhubs" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const path = join(runDirOf(runId), "triage.json");
  assert.ok(existsSync(path), "triage.json is where supervisor-spawn.mjs looks for it");
  const rec = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(rec).sort(), [
    "autonomy", "claimComment", "confidence", "createdAt", "decidedBy", "issue", "lease", "node", "proposal", "rationale", "unknowns", "verdict",
  ]);
  assert.equal(rec.verdict, "dev");
  assert.equal(rec.node, "dev");
  assert.equal(rec.autonomy, "supervised");
  assert.equal(rec.decidedBy, "supervisor");
  assert.deepEqual(rec.unknowns, ["no estimate", "no DoD"]);
});

test("triage.json is created 0644 (run-root: children may read, never write)", () => {
  if (process.platform === "win32") return; // POSIX mode bits only; the Windows run asserts the write succeeds above
  const runId = withRun();
  const r = run([
    "record", "--issue", "FOC-999", "--verdict", "dev", "--rationale", "AC present",
    "--confidence", "85", "--proposal", "dev", "--run", runId,
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const mode = statSync(join(runDirOf(runId), "triage.json")).mode & 0o777;
  assert.equal(mode, 0o644, `triage.json mode ${mode.toString(8)} !== 644`);
});

test("LA_SUPERVISOR_RUN stands in for --run", () => {
  const runId = withRun();
  const r = run(["record", "--issue", "FOC-1", ...issueFile("FOC-1"), "--verdict", "ask", "--rationale", "x", "--confidence", "40"], { LA_SUPERVISOR_RUN: runId });
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
  const r = run(["record", "--issue", "FOC-1", ...issueFile("FOC-1"), "--verdict", "ask", "--rationale", "unclear", "--confidence", "50", "--run", runId]);
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
  assert.equal(run([...base, "--issue", "FOC-1", ...issueFile("FOC-1")]).status, 0);
  // New information legitimately changes a verdict for the same issue.
  assert.equal(run([...base, "--issue", "FOC-1", ...issueFile("FOC-1")]).status, 0, "re-triage of the same issue must not be blocked");

  const other = run([...base, "--issue", "FOC-2", ...issueFile("FOC-2")]);
  assert.equal(other.status, 1, "a second issue would retarget every spawn in the run");
  assert.match(JSON.parse(other.stdout).error, /already has a verdict for FOC-1/);

  assert.equal(run([...base, "--issue", "FOC-2", ...issueFile("FOC-2"), "--force"]).status, 0, "--force is the deliberate override");
  assert.equal(JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8")).issue, "FOC-2");
});

// ── 8. Integration with supervisor-spawn's fail-closed gate ───────────────────
console.log("\nintegracja ze spawnem");

const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const spawnCli = (args, env = {}) => {
  // FOC-979: the outer child's sweep mark must never reach a spawned supervisor
  // script. Inline scrub rather than supervisor-test-fixtures.mjs's helper —
  // that module's load-time LA_SUPERVISOR_STATE_HOME takeover would redirect
  // these CLI runs away from the repo .state paths the tests read back.
  const childEnv = { ...process.env, LA_SUPERVISOR_NO_TELEMETRY: "1", LA_SUPERVISOR_NO_CODEGRAPH: "1", ...env };
  if (!("LA_CHILD_MARK" in env)) delete childEnv.LA_CHILD_MARK;
  return spawnSync(process.execPath, [SPAWN, ...args], { cwd: ROOT, encoding: "utf8", env: childEnv });
};

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
    run(["record", "--issue", "FOC-999", ...issueFile("FOC-999"), "--verdict", "dev", "--rationale", "AC present", "--confidence", "85", "--run", runId]).status,
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
  if (process.platform !== "win32") {
    // POSIX mode bits only; the Windows run asserts the write succeeded above.
    const mode = statSync(join(runDirOf(runId), "intake.json")).mode & 0o777;
    assert.equal(mode, 0o644, `intake.json mode ${mode.toString(8)} !== 644 (run-root: Supervisor-owned)`);
  }
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
  const r = run(["record", "--issue", "FOC-999", ...issueFile("FOC-999"), "--verdict", "dev", "--rationale", "AC present", "--confidence", "85", "--run", runId]);
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

test("the committed intakeFlows mapping covers exactly the registry's task_size criteria", () => {
  // Anti-drift: the frontman validates --size against these keys; a size the
  // registry can ask about but the mapping does not know would be refused at
  // record time for no good reason — and vice versa.
  const criteria = Object.keys(getRegistryEntry("intake.task_size").questions.size.criteria);
  assert.deepEqual(Object.keys(GRAPH.intakeFlows).sort(), criteria.sort());
  for (const flow of Object.values(GRAPH.intakeFlows)) {
    assert.ok(Array.isArray(flow), "every mapping value is a squad list");
  }
});

test("record --size embeds the final size, the suggested flow and the size disagreement", () => {
  const runId = withRun();
  const dir = runDirOf(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "intake.json"),
    JSON.stringify({
      issue: "FOC-999", createdAt: "2026-09-22T00:00:00.000Z", runId,
      decisions: {
        "intake.triage_node": { ok: true, answer: "dev", confidence: 0.9, eventId: "evt-t" },
        "intake.task_size": { ok: true, answer: "small", confidence: 0.9, eventId: "evt-s" },
      },
      frontman: { proposal: "dev", node: "dev", confidence: "high" },
      disagreement: null,
      size: "small",
    }),
    "utf8",
  );
  const r = run([
    "record", "--issue", "FOC-999", ...issueFile("FOC-999"), "--verdict", "dev", "--rationale", "x", "--confidence", "85",
    "--size", "large", "--run", runId,
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(dir, "triage.json"), "utf8"));
  assert.equal(rec.size, "large");
  assert.deepEqual(rec.suggestedFlow, ["plan", "dev", "review", "test"]);
  assert.deepEqual(rec.intake.sizeDisagreement, { seam: "small", recorded: "large" });
  assert.match(r.stderr, /seam intake\.task_size says "small"/);
  assert.match(r.stderr, /displayed, never auto-acted/);
});

test("the recorded verdict/size become FOC-449 labels tied to the intake eventIds", () => {
  const runsDir = join(tmp, "runs-labels");
  const logDir = join(runsDir, "test-triage-labels");
  mkdirSync(logDir, { recursive: true });
  const evtT = "evt-triage-1";
  const evtS = "evt-size-1";
  writeFileSync(
    join(logDir, "decisions.jsonl"),
    JSON.stringify({ type: "event", eventId: evtT, decisionId: "intake.triage_node", taskKey: "FOC-999" }) + "\n" +
      JSON.stringify({ type: "event", eventId: evtS, decisionId: "intake.task_size", taskKey: "FOC-999" }) + "\n",
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
    issue: "FOC-999",
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
    issue: "FOC-999",
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
  const r = run(["record", "--issue", "FOC-999", ...issueFile("FOC-999"), "--verdict", "dev", "--rationale", "x", "--confidence", "85", "--run", runId]);
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

// ── 9b. one run, one issue — the intake record is not re-parentable (FOC-451) ─
console.log("\nintake należy do jednego zagadnienia (FOC-451)");

// A run whose intake.json — and the decision event it points at — belongs to
// FOC-888, while the verdict being recorded is FOC-999: the round-1 blocker.
// The foreign event exists in the run's real log, so labelling it would be
// possible; every test here proves it is not.
function foreignIntake(runId) {
  const dir = runDirOf(runId);
  mkdirSync(dir, { recursive: true });
  const logDir = join(ROOT, ".state", "runs", runId);
  mkdirSync(logDir, { recursive: true });
  cleanup.push(logDir); // the caller's shadow log, same as the intake tests above
  writeFileSync(
    join(logDir, "decisions.jsonl"),
    JSON.stringify({ type: "event", eventId: "evt-foreign", decisionId: "intake.triage_node", taskKey: "FOC-888" }) + "\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "intake.json"),
    JSON.stringify({
      issue: "FOC-888", createdAt: "2026-09-22T00:00:00.000Z", runId,
      decisions: { "intake.triage_node": { ok: true, answer: "dev", confidence: 0.9, eventId: "evt-foreign" } },
      frontman: { proposal: "dev", node: "dev", confidence: "high" },
      disagreement: null,
      size: "medium",
    }),
    "utf8",
  );
  return { dir, logDir };
}

const noForeignLabel = (logDir) => {
  const lines = readFileSync(join(logDir, "decisions.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(!lines.some((l) => l.type === "label"), "the foreign event must collect no label");
};

test("record refuses an intake.json written for a DIFFERENT issue — before any embed or label", () => {
  const runId = withRun();
  const { dir, logDir } = foreignIntake(runId);
  const r = run(["record", "--issue", "FOC-999", "--verdict", "dev", "--rationale", "x", "--confidence", "85", "--run", runId]);
  assert.equal(r.status, 1, "cross-issue intake data would silently corrupt the FOC-449 join");
  const err = JSON.parse(r.stdout).error;
  assert.match(err, /already has intake annotations for FOC-888/);
  assert.match(err, /recording FOC-999/, "the refusal names both identities");
  assert.ok(!existsSync(join(dir, "triage.json")), "the refusal precedes any verdict write");
  noForeignLabel(logDir);
});

test("--force records the new verdict but DROPS the foreign intake data instead of re-parenting it", () => {
  const runId = withRun();
  const { dir, logDir } = foreignIntake(runId);
  const r = run([
    "record", "--issue", "FOC-999", ...issueFile("FOC-999"), "--verdict", "dev", "--rationale", "x", "--confidence", "85", "--force", "--run", runId,
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(dir, "triage.json"), "utf8"));
  assert.equal(rec.issue, "FOC-999");
  assert.ok(!("intake" in rec), "the foreign intake summary is dropped, never embedded");
  assert.match(r.stderr, /intake\.json belongs to FOC-888, not FOC-999/, "the drop is announced, not silent");
  noForeignLabel(logDir);
});

test("labelRecordedIntake refuses a mismatched eventId→issue pairing — fail-closed before any write", () => {
  const runsDir = join(tmp, "runs-pairing");
  const logDir = join(runsDir, "test-triage-pairing");
  mkdirSync(logDir, { recursive: true });
  const evtForeign = "evt-pair-foreign";
  const evtNoKey = "evt-pair-nokey";
  writeFileSync(
    join(logDir, "decisions.jsonl"),
    JSON.stringify({ type: "event", eventId: evtForeign, decisionId: "intake.triage_node", taskKey: "FOC-888" }) + "\n" +
      JSON.stringify({ type: "event", eventId: evtNoKey, decisionId: "intake.task_size" }) + "\n",
    "utf8",
  );
  const { labelled, warnings } = labelRecordedIntake({
    intake: {
      runId: "test-triage-pairing",
      decisions: {
        "intake.triage_node": { ok: true, answer: "dev", eventId: evtForeign },
        "intake.task_size": { ok: true, answer: "medium", eventId: evtNoKey },
      },
    },
    verdict: "dev",
    size: "medium",
    runsDir,
    issue: "FOC-999",
  });
  assert.equal(labelled.length, 0, "a mismatched event must not collect the outcome");
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
  assert.match(warnings[0], /taskKey is "FOC-888", not "FOC-999"/);
  assert.match(warnings[1], /taskKey is "missing"/, "an event without a taskKey cannot be verified, so it is refused");
  const labels = readFileSync(join(logDir, "decisions.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l))
    .filter((l) => l.type === "label");
  assert.equal(labels.length, 0, "no label line reaches the log");
});

test("intake records the invoked --issue identity, not a payload-derived uuid (the guard's vocabulary)", () => {
  // extractSignals falls back to issue.id when a payload has no identifier —
  // a uuid in intake.json would not be comparable to the --issue the record
  // step is invoked with, enabling and masking the cross-issue mismatch.
  const runId = withRun();
  cleanup.push(join(ROOT, ".state", "runs", runId));
  const path = join(tmp, `issue-uuid-${fixtureN++}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      id: "9f1c2a34-5b6d-7e8f-9a0b-1c2d3e4f5a6b",
      description: AC_BODY,
      state: { name: "Backlog", type: "backlog" },
      labels: { nodes: [] },
      comments: { nodes: [] },
      estimate: null,
      children: { nodes: [] },
    }),
    "utf8",
  );
  const i = run(["intake", "--issue", "FOC-999", "--issue-file", path, "--run", runId], { OPENROUTER_API_KEY: "" });
  assert.equal(i.status, 0, i.stdout + i.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "intake.json"), "utf8"));
  assert.equal(rec.issue, "FOC-999", "the stored identity must be the invoked id, same vocabulary as taskKey and triage.json");
});

test("the A0 disagreement line states the RECORDED verdict, not the deterministic proposal", () => {
  const runId = withRun();
  const dir = runDirOf(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "intake.json"),
    JSON.stringify({
      issue: "FOC-999", createdAt: "2026-09-22T00:00:00.000Z", runId,
      decisions: { "intake.triage_node": { ok: true, answer: "plan", confidence: 0.9, eventId: "evt-t" } },
      frontman: { proposal: "dev", node: "dev", confidence: "high" },
      disagreement: { decisionId: "intake.triage_node", seam: "plan", frontman: "dev" },
      size: "medium",
    }),
    "utf8",
  );
  // The frontman proposed dev, the seam said plan — the verdict recorded is
  // review, and the display must say review.
  const r = run(["record", "--issue", "FOC-999", ...issueFile("FOC-999"), "--verdict", "review", "--rationale", "x", "--confidence", "90", "--run", runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /seam intake\.triage_node says "plan"/);
  assert.match(r.stderr, /the recorded verdict is "review"/, "the recorded verdict, not the frontman proposal");
  assert.match(r.stderr, /displayed, never auto-acted/);
});

// ── 9c. typed seam answers unwrap — the FOC-513 regression guard ─────────────
console.log("\nintake — typed seam answers (FOC-513)");

// The live seam answers as TYPED records (decision-call.mjs normalizeAnswers:
// choice → {type:"choice", choice, confidence}, noul → {type:"noul", noul,
// confidence}, score → {type:"score", score, confidence}). These stubs use that
// exact shape for all three intake decisions, and the guard is simple: the
// literal "[object Object]" must appear nowhere — not in intake.json, not in
// triage.json, not on stderr — and every comparison/lookup must key on the
// unwrapped primitive while the stored answers keep the raw records.
const TYPED_ANSWERS = {
  "intake.triage_node": { q0: { type: "choice", choice: "dev", confidence: 0.99 } },
  "intake.has_acceptance_criteria": { q0: { type: "noul", noul: 1, confidence: 1 } },
  "intake.task_size": { size: { type: "choice", choice: "medium", confidence: 0.95 } },
};
const typedCaller = (answers = TYPED_ANSWERS) => async ({ decisionId }) => ({
  ok: true,
  decisionId,
  annotation: { answers: answers[decisionId], confidence: 0.9 },
  eventId: `evt-${decisionId}`,
});

testAsync("typed answers unwrap: the flow lookup keys on the primitive, the stored answers stay raw", async () => {
  const g = clone();
  g.intakeFlows = { small: [], medium: ["dev", "test"], large: ["plan", "dev", "review", "test"] };
  const { record } = await buildIntake({ issue: issue({ body: AC_BODY }), graph: g, caller: typedCaller() });
  // Fidelity: decisions[].answer keeps the RAW typed records...
  assert.deepEqual(record.decisions["intake.triage_node"].answer, TYPED_ANSWERS["intake.triage_node"].q0);
  assert.deepEqual(record.decisions["intake.has_acceptance_criteria"].answer, TYPED_ANSWERS["intake.has_acceptance_criteria"].q0);
  assert.deepEqual(record.decisions["intake.task_size"].answer, TYPED_ANSWERS["intake.task_size"].size);
  // ...while every derived field carries the primitive.
  assert.equal(record.size, "medium");
  assert.deepEqual(record.suggestedFlow, { size: "medium", squads: ["dev", "test"] });
  assert.equal(record.flowReason, undefined);
  // Agreement is RECOGNIZED: a raw record vs the frontman string used to
  // disagree unconditionally.
  assert.equal(record.disagreement, null);
  // The `intake` subcommand writes exactly this object to intake.json — no
  // "[object Object]" may survive serialization anywhere in it.
  assert.ok(!JSON.stringify(record).includes("[object Object]"), JSON.stringify(record));
});

testAsync("a typed answer absent from the mapping names the UNWRAPPED key in flowReason", async () => {
  const g = clone();
  g.intakeFlows = { small: [], medium: ["dev", "test"], large: ["plan", "dev", "review", "test"] };
  const withSize = (sizeAnswer) => async ({ decisionId }) => ({
    ok: true,
    decisionId,
    annotation: {
      answers: decisionId === "intake.task_size" ? { size: sizeAnswer } : TYPED_ANSWERS[decisionId],
      confidence: 0.9,
    },
    eventId: `evt-${decisionId}`,
  });
  // A choice label the mapping does not carry...
  const colossal = await buildIntake({
    issue: issue({ body: AC_BODY }), graph: g,
    caller: withSize({ type: "choice", choice: "colossal", confidence: 0.9 }),
  });
  assert.equal(colossal.record.size, "colossal");
  assert.equal(colossal.record.flowReason, 'no "colossal" entry in graph.intakeFlows');
  // ...and a noul-shaped one, whose unwrapped key is its boolean verdict.
  const noul = await buildIntake({
    issue: issue({ body: AC_BODY }), graph: g,
    caller: withSize({ type: "noul", noul: 0.9, confidence: 0.9 }),
  });
  assert.equal(noul.record.size, true);
  assert.equal(noul.record.flowReason, 'no "true" entry in graph.intakeFlows');
});

testAsync("an answer that unwraps to nothing is absent — no lookup, no flowReason, no disagreement invented", async () => {
  const g = clone();
  g.intakeFlows = { small: [], medium: ["dev", "test"], large: ["plan", "dev", "review", "test"] };
  const shapeless = async ({ decisionId }) => ({
    ok: true,
    decisionId,
    annotation: { answers: { q0: { note: "no recognized answer type" } }, confidence: 0.9 },
    eventId: `evt-${decisionId}`,
  });
  const { record } = await buildIntake({ issue: issue({ body: AC_BODY }), graph: g, caller: shapeless });
  assert.equal(record.size, null);
  assert.equal(record.suggestedFlow, undefined);
  assert.equal(record.flowReason, undefined);
  assert.equal(record.disagreement, null, "an incomparable seam side is skipped, never invented into agreement");
});

testAsync("a typed triage answer that disagrees with the frontman stores the unwrapped seam value", async () => {
  const caller = async ({ decisionId }) => ({
    ok: true,
    decisionId,
    annotation: {
      answers: decisionId === "intake.triage_node"
        ? { q0: { type: "choice", choice: "plan", confidence: 0.99 } }
        : TYPED_ANSWERS[decisionId],
      confidence: 0.9,
    },
    eventId: `evt-${decisionId}`,
  });
  const { record } = await buildIntake({ issue: issue({ body: AC_BODY }), graph: GRAPH, caller });
  assert.deepEqual(record.disagreement, { decisionId: "intake.triage_node", seam: "plan", frontman: "dev" });
  assert.deepEqual(record.decisions["intake.triage_node"].answer, { type: "choice", choice: "plan", confidence: 0.99 });
});

test("record's A0 lines read the unwrapped typed seam answers — [object Object] appears nowhere", () => {
  const runId = withRun();
  const dir = runDirOf(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "intake.json"),
    JSON.stringify({
      issue: "FOC-999", createdAt: "2026-09-22T00:00:00.000Z", runId,
      decisions: {
        "intake.triage_node": { ok: true, answer: { type: "choice", choice: "plan", confidence: 0.99 }, confidence: 0.99, eventId: "evt-t" },
        "intake.has_acceptance_criteria": { ok: true, answer: TYPED_ANSWERS["intake.has_acceptance_criteria"].q0, confidence: 1, eventId: "evt-a" },
        "intake.task_size": { ok: true, answer: { type: "choice", choice: "small", confidence: 0.9 }, confidence: 0.9, eventId: "evt-s" },
      },
      frontman: { proposal: "dev", node: "dev", confidence: "high" },
      disagreement: { decisionId: "intake.triage_node", seam: "plan", frontman: "dev" },
      size: "small",
    }),
    "utf8",
  );
  const r = run([
    "record", "--issue", "FOC-999", ...issueFile("FOC-999"), "--verdict", "dev", "--rationale", "x", "--confidence", "85",
    "--size", "large", "--run", runId,
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // The triage line: a genuine seam-vs-recorded-verdict difference, named with
  // the seam's confidence in the parenthetical.
  assert.match(r.stderr, /A0 disagreement — seam intake\.triage_node says "plan" \(0\.99\), the recorded verdict is "dev"/);
  // The size line: unwrapped seam value vs the recorded size.
  assert.match(r.stderr, /A0 disagreement — seam intake\.task_size says "small", the recorded size is "large"/);
  assert.ok(!r.stderr.includes("[object Object]"), r.stderr);
  const raw = readFileSync(join(dir, "triage.json"), "utf8");
  assert.ok(!raw.includes("[object Object]"), raw);
  const rec = JSON.parse(raw);
  // Fidelity: the embedded summary keeps the raw typed records...
  assert.deepEqual(rec.intake.decisions["intake.triage_node"].answer, { type: "choice", choice: "plan", confidence: 0.99 });
  // ...while the size disagreement stores the unwrapped seam value.
  assert.deepEqual(rec.intake.sizeDisagreement, { seam: "small", recorded: "large" });
});

test("the A0 triage line omits a null seam confidence rather than printing (null)", () => {
  const runId = withRun();
  const dir = runDirOf(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "intake.json"),
    JSON.stringify({
      issue: "FOC-999", createdAt: "2026-09-22T00:00:00.000Z", runId,
      decisions: {
        "intake.triage_node": { ok: true, answer: { type: "choice", choice: "plan", confidence: null }, confidence: null, eventId: "evt-t" },
      },
      frontman: { proposal: "dev", node: "dev", confidence: "high" },
      disagreement: { decisionId: "intake.triage_node", seam: "plan", frontman: "dev" },
      size: null,
    }),
    "utf8",
  );
  const r = run(["record", "--issue", "FOC-999", ...issueFile("FOC-999"), "--verdict", "dev", "--rationale", "x", "--confidence", "85", "--run", runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /seam intake\.triage_node says "plan", the recorded verdict is "dev"/);
  assert.ok(!/\(null\)/.test(r.stderr), r.stderr);
});

test("seam-vs-recorded agreement fires no A0 line, even with a stored disagreement", () => {
  // The stored disagreement is the seam-vs-frontman view; the record-time line
  // is the seam-vs-recorded one. The seam said "dev" and "medium", and that is
  // exactly what was recorded — nothing to display.
  const runId = withRun();
  const dir = runDirOf(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "intake.json"),
    JSON.stringify({
      issue: "FOC-999", createdAt: "2026-09-22T00:00:00.000Z", runId,
      decisions: {
        "intake.triage_node": { ok: true, answer: TYPED_ANSWERS["intake.triage_node"].q0, confidence: 0.99, eventId: "evt-t" },
        "intake.task_size": { ok: true, answer: TYPED_ANSWERS["intake.task_size"].size, confidence: 0.95, eventId: "evt-s" },
      },
      frontman: { proposal: "plan", node: "plan", confidence: "low" },
      disagreement: { decisionId: "intake.triage_node", seam: "dev", frontman: "plan" },
      size: "medium",
    }),
    "utf8",
  );
  const r = run([
    "record", "--issue", "FOC-999", ...issueFile("FOC-999"), "--verdict", "dev", "--rationale", "x", "--confidence", "85",
    "--size", "medium", "--run", runId,
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!/A0 disagreement/.test(r.stderr), r.stderr);
  const rec = JSON.parse(readFileSync(join(dir, "triage.json"), "utf8"));
  assert.equal(rec.intake.sizeDisagreement, undefined, "equal sizes → no sizeDisagreement invented");
  assert.deepEqual(rec.intake.disagreement, { decisionId: "intake.triage_node", seam: "dev", frontman: "plan" }, "the stored seam-vs-frontman view rides untouched");
});

// ── 10. the ticket lease (FOC-902) ────────────────────────────────────────────
console.log("\nticket lease (FOC-902)");

// A live pid the lease check must see as alive — this very process.
const LIVE_PID = process.pid;
// The DEAD_PID fixture proven safe on this host (fenix-doctor.test.mjs,
// supervisor-current-run.test.mjs): pidAlive reports it dead.
const DEAD_PID = 2 ** 22 + 12345;
const SID = `sup-${"a".repeat(32)}`;

// A private LA_DATA_HOME whose supervisor/ dir the lease check reads. The
// default storeHome stays empty — every lease test that needs a holder seeds
// its own.
const leaseHomes = [];
const leaseHome = () => {
  const dir = mkdtempSync(join(tmpdir(), "la-triage-lease-"));
  leaseHomes.push(dir);
  return dir;
};
process.on("exit", () => {
  for (const dir of leaseHomes) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// Seed one live-or-dead holder for a task key in dbHome's store and return
// its sessionId (the refusal must name it).
function seedHolder(dbHome, pid, taskKey = "jointhubs:FOC-999", taskId = "FOC-999") {
  const dbPath = join(dbHome, "supervisor", "task-sessions.sqlite");
  const store = createTaskSessionStore({ dbPath });
  try {
    const s = store.ensure({ taskKey, taskId, workspace: "jointhubs", issueId: taskId });
    assert.equal(store.claimNext().sessionId, s.sessionId);
    store.update(s.sessionId, { status: "running", pid });
    return s.sessionId;
  } finally {
    store.close();
  }
}

const leaseRecordArgs = (runId, extra = []) => [
  "record", "--issue", "FOC-999", ...issueFile("FOC-999"),
  "--verdict", "dev", "--rationale", "x", "--confidence", "85", "--run", runId, ...extra,
];

test("scoped: a session may only triage the ticket its lease names — LEASE_MISMATCH, nothing written", () => {
  const runId = withRun();
  const r = run(leaseRecordArgs(runId), {
    FENIX_SUPERVISOR_SESSION_ID: SID,
    LA_TASK_ID: "FOC-888",
    FENIX_WORK_WORKSPACE: "jointhubs",
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const err = JSON.parse(r.stdout);
  assert.equal(err.code, "LEASE_MISMATCH");
  assert.match(err.error, /this session holds the lease for FOC-888; it cannot triage FOC-999/);
  assert.ok(!existsSync(join(runDirOf(runId), "triage.json")), "the refusal precedes any write");
});

test("scoped: a lease whose task key disagrees with the loaded issue is refused too", () => {
  const runId = withRun();
  const r = run(leaseRecordArgs(runId), {
    FENIX_SUPERVISOR_SESSION_ID: SID,
    LA_TASK_ID: "FOC-999",
    LA_TASK_KEY: "jointhubs:FOC-1",
    FENIX_WORK_WORKSPACE: "jointhubs",
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const err = JSON.parse(r.stdout);
  assert.equal(err.code, "LEASE_MISMATCH");
  assert.equal(err.lease.taskKey, "jointhubs:FOC-1");
  assert.equal(err.lease.issueTaskKey, "jointhubs:FOC-999");
  assert.ok(!existsSync(join(runDirOf(runId), "triage.json")));
});

test("scoped: a matching lease records with lease.sessionId set", () => {
  const runId = withRun();
  const r = run(leaseRecordArgs(runId), {
    FENIX_SUPERVISOR_SESSION_ID: SID,
    LA_TASK_ID: "FOC-999",
    LA_TASK_KEY: "jointhubs:FOC-999",
    FENIX_WORK_WORKSPACE: "jointhubs",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.equal(rec.lease.sessionId, SID);
  assert.equal(rec.lease.taskKey, "jointhubs:FOC-999");
  assert.equal(rec.lease.workspace, "jointhubs");
  assert.ok(!("override" in rec.lease), "a scoped triage never overrides");
});

test("unscoped: a live owner holds the ticket — TICKET_LEASED, nothing written", () => {
  const runId = withRun();
  const home = leaseHome();
  const holder = seedHolder(home, LIVE_PID);
  const r = run(leaseRecordArgs(runId), { LA_DATA_HOME: home, FENIX_WORK_WORKSPACE: "jointhubs" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const err = JSON.parse(r.stdout);
  assert.equal(err.code, "TICKET_LEASED");
  assert.match(err.error, new RegExp(`leased to session ${holder} \\(running\\)`));
  assert.match(err.error, /live on this host/);
  assert.equal(err.lease.sessionId, holder);
  assert.equal(err.lease.status, "running");
  assert.equal(err.lease.taskKey, "jointhubs:FOC-999");
  assert.ok(!existsSync(join(runDirOf(runId), "triage.json")));
});

test("unscoped: a dead-pid owner does not hold the ticket — triage records", () => {
  const runId = withRun();
  const home = leaseHome();
  seedHolder(home, DEAD_PID);
  const r = run(leaseRecordArgs(runId), { LA_DATA_HOME: home, FENIX_WORK_WORKSPACE: "jointhubs" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.equal(rec.lease.sessionId, null, "a stale row is not a holder");
  assert.equal(rec.lease.taskKey, "jointhubs:FOC-999");
});

test("unscoped: FENIX_SUPERVISOR_LEGACY=1 overrides a live owner and records it", () => {
  const runId = withRun();
  const home = leaseHome();
  seedHolder(home, LIVE_PID);
  const r = run(leaseRecordArgs(runId), {
    LA_DATA_HOME: home,
    FENIX_WORK_WORKSPACE: "jointhubs",
    FENIX_SUPERVISOR_LEGACY: "1",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.equal(rec.lease.override, true, "the override is on the record, not silent");
});

test("triage.json.lease shape: store missing is recorded, checkedAt is an ISO instant", () => {
  const runId = withRun();
  const r = run(leaseRecordArgs(runId), { FENIX_WORK_WORKSPACE: "jointhubs" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.deepEqual(
    Object.keys(rec.lease).sort(),
    ["checkedAt", "sessionId", "store", "taskKey", "workspace"],
  );
  assert.equal(rec.lease.sessionId, null);
  assert.equal(rec.lease.store, "missing");
  assert.ok(!Number.isNaN(Date.parse(rec.lease.checkedAt)), rec.lease.checkedAt);
});

// The claim comment (§B) — the seam intercepts the exact command instead of
// posting it, so the tests stay offline while pinning body and dedup tag.
test("claim comment: the exact linear-ops command is logged, scoped flavour", () => {
  const runId = withRun();
  const home = leaseHome();
  const logPath = join(home, "claim-cmd.log");
  const r = run(leaseRecordArgs(runId, ["--claim-comment"]), {
    FENIX_SUPERVISOR_SESSION_ID: SID,
    LA_TASK_ID: "FOC-999",
    LA_TASK_KEY: "jointhubs:FOC-999",
    FENIX_WORK_WORKSPACE: "jointhubs",
    LA_TRIAGE_CLAIM_CMD_LOG: logPath,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "exactly one command was issued");
  const argv = JSON.parse(lines[0]);
  assert.equal(argv[0], process.execPath);
  assert.match(argv[1], /linear-ops\.mjs$/);
  assert.equal(argv[2], "comment");
  assert.equal(argv[3], "FOC-999");
  assert.equal(argv[4], "--body");
  const m = argv[5].match(/^claimed by `sup-[^`]+` \(run (test-triage-\d+-\d+)\) at (\S+) — fenix$/);
  assert.ok(m, `body shape: ${argv[5]}`);
  assert.equal(m[1], runId, "the body names THIS run");
  assert.ok(!Number.isNaN(Date.parse(m[2])), "the body carries an ISO instant");
  assert.equal(argv[6], "--dedup-tag");
  assert.equal(argv[7], `claim:${SID}`);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.deepEqual(rec.claimComment, {
    posted: false,
    reason: "claim command logged to LA_TRIAGE_CLAIM_CMD_LOG instead of being executed",
  });
});

test("claim comment: the unscoped flavour addresses run <runId> with tag claim:<runId>", () => {
  const runId = withRun();
  const home = leaseHome();
  const logPath = join(home, "claim-cmd.log");
  const r = run(leaseRecordArgs(runId, ["--claim-comment"]), {
    FENIX_WORK_WORKSPACE: "jointhubs",
    LA_TRIAGE_CLAIM_CMD_LOG: logPath,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const argv = JSON.parse(readFileSync(logPath, "utf8").trim());
  assert.match(argv[5], new RegExp(`^claimed by run ${runId} at \\S+ — fenix$`));
  assert.equal(argv[7], `claim:${runId}`);
});

test("claim comment: --no-claim-comment skips with its reason and issues nothing", () => {
  const runId = withRun();
  const home = leaseHome();
  const logPath = join(home, "claim-cmd.log");
  const r = run(leaseRecordArgs(runId, ["--no-claim-comment"]), {
    FENIX_WORK_WORKSPACE: "jointhubs",
    LA_TRIAGE_CLAIM_CMD_LOG: logPath,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.deepEqual(rec.claimComment, { posted: false, reason: "--no-claim-comment was given" });
  assert.ok(!existsSync(logPath), "no command was issued");
});

test("claim comment: an offline intake skips with its reason", () => {
  const runId = withRun();
  const r = run(leaseRecordArgs(runId), { FENIX_WORK_WORKSPACE: "jointhubs" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.deepEqual(rec.claimComment, {
    posted: false,
    reason: "the issue came from --issue-file and --claim-comment was not given",
  });
});

test("claim comment: no LINEAR_API_KEY skips with its reason", () => {
  const runId = withRun();
  const r = run(leaseRecordArgs(runId, ["--claim-comment"]), { FENIX_WORK_WORKSPACE: "jointhubs", LINEAR_API_KEY: "" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.deepEqual(rec.claimComment, { posted: false, reason: "LINEAR_API_KEY is not set" });
});

test("intake runs the lease check too: a live unscoped owner refuses the intake", () => {
  const runId = withRun();
  const home = leaseHome();
  seedHolder(home, LIVE_PID);
  const r = run(["intake", "--issue", "FOC-999", "--issue-file", fixture({ body: AC_BODY }), "--run", runId], {
    LA_DATA_HOME: home,
    FENIX_WORK_WORKSPACE: "jointhubs",
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const err = JSON.parse(r.stdout);
  assert.equal(err.code, "TICKET_LEASED");
  assert.ok(!existsSync(join(runDirOf(runId), "intake.json")), "the refusal precedes any write");
});

// One canonical task key = `<workspace>:<display identifier>`, never the
// Linear uuid — a payload carrying both must key by the identifier.
test("unscoped: the lease key is the display identifier, never the payload uuid (record)", () => {
  const runId = withRun();
  const home = leaseHome();
  const holder = seedHolder(home, LIVE_PID, "jointhubs:FOC-123", "FOC-123");
  const r = run(["record", "--issue", "FOC-123", "--issue-file", uuidIssueFile("FOC-123"), "--verdict", "dev", "--rationale", "x", "--confidence", "85", "--run", runId], {
    LA_DATA_HOME: home,
    FENIX_WORK_WORKSPACE: "jointhubs",
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const err = JSON.parse(r.stdout);
  assert.equal(err.code, "TICKET_LEASED");
  assert.equal(err.lease.taskKey, "jointhubs:FOC-123");
  assert.equal(err.lease.sessionId, holder);
  assert.ok(!existsSync(join(runDirOf(runId), "triage.json")), "the refusal precedes any write");
});

test("unscoped: the lease key is the display identifier, never the payload uuid (intake)", () => {
  const runId = withRun();
  const home = leaseHome();
  const holder = seedHolder(home, LIVE_PID, "jointhubs:FOC-123", "FOC-123");
  const r = run(["intake", "--issue", "FOC-123", "--issue-file", uuidIssueFile("FOC-123"), "--run", runId], {
    LA_DATA_HOME: home,
    FENIX_WORK_WORKSPACE: "jointhubs",
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const err = JSON.parse(r.stdout);
  assert.equal(err.code, "TICKET_LEASED");
  assert.equal(err.lease.taskKey, "jointhubs:FOC-123");
  assert.equal(err.lease.sessionId, holder);
  assert.ok(!existsSync(join(runDirOf(runId), "intake.json")), "the refusal precedes any write");
});

test("scoped: LA_TASK_ID/LA_TASK_KEY naming the display identifier accept a uuid payload", () => {
  const runId = withRun();
  const r = run(["intake", "--issue", "FOC-123", "--issue-file", uuidIssueFile("FOC-123"), "--run", runId], {
    OPENROUTER_API_KEY: "",
    FENIX_SUPERVISOR_SESSION_ID: SID,
    LA_TASK_ID: "FOC-123",
    LA_TASK_KEY: "jointhubs:FOC-123",
    FENIX_WORK_WORKSPACE: "jointhubs",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.issue, "FOC-123");
  assert.ok(existsSync(join(runDirOf(runId), "intake.json")), "the payload uuid id never becomes part of the key");
});

test("claim comment failure mapping: a spawnSync timeout is reason \"timeout\", the rest keeps its shape", () => {
  assert.equal(claimFailureReason({ error: Object.assign(new Error("spawn ETIMEDOUT"), { code: "ETIMEDOUT" }), status: null }), "timeout");
  assert.equal(claimFailureReason({ error: new Error("ENOENT"), status: null }), "ENOENT");
  assert.equal(claimFailureReason({ stderr: "l1\nl2\nl3\nl4\n", status: 1 }), "l2; l3; l4", "the stderr tail is the reason");
  assert.equal(claimFailureReason({ status: 3 }), "exit 3");
});

test("a non-canonical issue identity refuses the lease check before anything else", () => {
  const runId = withRun();
  const r = run(["record", "--issue", "FOC:1", ...issueFile("FOC:1"), "--verdict", "dev", "--rationale", "x", "--confidence", "85", "--run", runId], {
    FENIX_WORK_WORKSPACE: "jointhubs",
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const err = JSON.parse(r.stdout);
  assert.match(err.error, /does not yield a canonical task key/);
  assert.ok(!existsSync(join(runDirOf(runId), "triage.json")));
});

// ── 10. ownership — the gate at record/propose (FOC-848) ──────────────────────
console.log("\nownership (FOC-848)");

// The project shapes the gate must tell apart: Fenix (the orchestrator's, by
// exact name), JW (the supervisor's, by id), an unlisted project, and a
// payload with no project at all.
const FENIX = { id: "proj-fenix-id", name: "Fenix — wydanie 1.0 i kontrola kosztów" };
const JW = { id: "proj-jw-id", name: "JW" };
const UNLISTED = { id: "proj-unknown", name: "Something Else" };
const recordArgs = (extra = []) => [
  "record", "--verdict", "dev", "--rationale", "AC present", "--confidence", "85", ...extra,
];
const holdsOf = (runId) => {
  const path = join(runDirOf(runId), "holds.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")).holds;
};

test("a Fenix ticket as supervisor is FOREIGN: record refuses, holds once, writes no triage.json", () => {
  const runId = withRun();
  const args = [...recordArgs(["--issue", "FOC-999", "--run", runId]), "--issue-file", fixture({ project: FENIX })];
  const r = run(args, restrictedEnv());
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.code, "ownership-foreign");
  assert.match(out.error, /owned by orchestrator/);
  assert.ok(!existsSync(join(runDirOf(runId), "triage.json")), "a refused record writes no triage.json");
  const holds = holdsOf(runId).filter((h) => h.state === "open" && h.origin === "ownership");
  assert.equal(holds.length, 1, "exactly one open ownership hold");
  assert.equal(out.hold, holds[0].id, "the refusal names the hold it recorded");
  // Idempotent: a retried record does not pile up a second hold.
  const r2 = run(args, restrictedEnv());
  assert.equal(r2.status, 1);
  assert.equal(JSON.parse(r2.stdout).hold, holds[0].id, "the retried refusal reuses the same hold");
  assert.equal(holdsOf(runId).filter((h) => h.state === "open" && h.origin === "ownership").length, 1);
});

test("propose refuses the same ticket and names the hold", () => {
  const runId = withRun();
  const r = run(
    ["propose", "--issue", "FOC-999", "--issue-file", fixture({ project: FENIX }), "--run", runId],
    restrictedEnv(),
  );
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.code, "ownership-foreign");
  assert.match(out.hold, /^hold-\d+$/, "the hold id rides the refusal");
  assert.match(out.error, /owned by orchestrator/);
});

test("a JW ticket as supervisor is OWNED: recorded, with the stamp on triage.json", () => {
  const runId = withRun();
  const r = run(
    [...recordArgs(["--issue", "FOC-999", "--run", runId]), "--issue-file", fixture({ project: JW })],
    restrictedEnv(),
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.deepEqual(rec.ownership, { owner: "supervisor", verdict: "owned", allowed: true, project: JW });
});

test("an unlisted project under `ask` is refused with a hold; under `allow` it is stamped `unlisted`", () => {
  const askRun = withRun();
  const r = run(
    [...recordArgs(["--issue", "FOC-999", "--run", askRun]), "--issue-file", fixture({ project: UNLISTED })],
    restrictedEnv(),
  );
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).code, "ownership-unlisted");
  assert.ok(!existsSync(join(runDirOf(askRun), "triage.json")));
  assert.equal(holdsOf(askRun).filter((h) => h.state === "open" && h.origin === "ownership").length, 1);

  const allowRun = withRun();
  const ok = run(
    [...recordArgs(["--issue", "FOC-999", "--run", allowRun]), "--issue-file", fixture({ project: UNLISTED })],
    restrictedEnv(RESTRICTED_ALLOW),
  );
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(allowRun), "triage.json"), "utf8"));
  assert.deepEqual(rec.ownership, { owner: "supervisor", verdict: "unlisted", allowed: true, project: UNLISTED });
  assert.equal(holdsOf(allowRun).length, 0, "an allowed unlisted ticket records no hold");
});

test("a payload with no project on a restricted install is treated as unlisted", () => {
  const runId = withRun();
  const r = run(
    [...recordArgs(["--issue", "FOC-999", "--run", runId]), "--issue-file", fixture({})],
    restrictedEnv(),
  );
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).code, "ownership-unlisted");
  assert.ok(!existsSync(join(runDirOf(runId), "triage.json")));
});

test("--force does NOT bypass the ownership gate", () => {
  const runId = withRun();
  const r = run(
    [...recordArgs(["--issue", "FOC-999", "--run", runId, "--force"]), "--issue-file", fixture({ project: FENIX })],
    restrictedEnv(),
  );
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).code, "ownership-foreign");
  assert.ok(!existsSync(join(runDirOf(runId), "triage.json")));
});

test("a broken ownership config fails closed with ownership-config", () => {
  const runId = withRun();
  const broken = join(tmp, "ownership-broken-triage.json");
  writeFileSync(broken, "{ not json", "utf8");
  const r = run(
    [...recordArgs(["--issue", "FOC-999", "--run", runId]), "--issue-file", fixture({ project: JW })],
    { LA_TASK_OWNERSHIP_CONFIG: broken, LA_TASK_OWNER: "supervisor" },
  );
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).code, "ownership-config");
  assert.ok(!existsSync(join(runDirOf(runId), "triage.json")), "fail-closed: no verdict is written either");
});

test("the shipped default stays unrestricted: recorded with NO stamp (AC3)", () => {
  const runId = withRun();
  const r = run(
    [...recordArgs(["--issue", "FOC-999", "--run", runId]), "--issue-file", fixture({ project: FENIX })],
    { LA_TASK_OWNER: "supervisor" },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.equal(rec.ownership, undefined, "no owners configured → no stamp, byte-for-byte as before");
  assert.equal(holdsOf(runId).length, 0);
});

test("propose omits the ownership key on the shipped default, carries it on a restricted install (AC3)", () => {
  const unrestricted = run(["propose", "--issue", "FOC-999", "--issue-file", fixture({ project: JW })]);
  assert.equal(unrestricted.status, 0, unrestricted.stdout + unrestricted.stderr);
  assert.equal(
    JSON.parse(unrestricted.stdout).ownership,
    undefined,
    "unrestricted output is what it was before the gate existed",
  );

  const runId = withRun();
  const restricted = run(
    ["propose", "--issue", "FOC-999", "--issue-file", fixture({ project: JW }), "--run", runId],
    restrictedEnv(),
  );
  assert.equal(restricted.status, 0, restricted.stdout + restricted.stderr);
  assert.deepEqual(
    JSON.parse(restricted.stdout).ownership,
    { owner: "supervisor", verdict: "owned", allowed: true, project: JW },
    "a restricted install stamps the verdict on the proposal",
  );
});

test("propose and record share one hold — the canonical issue id at both sites", () => {
  // The drift the fix closes: propose keyed its hold by the payload identifier,
  // record by --issue. A payload whose identifier differs from the invoked id
  // used to buy two holds for one refused ticket.
  const runId = withRun();
  const payload = fixture({ id: "FOC-777", project: FENIX });
  const pr = run(["propose", "--issue", "FOC-123", "--run", runId, "--issue-file", payload], restrictedEnv());
  assert.equal(pr.status, 1, pr.stdout + pr.stderr);
  const rr = run(
    [...recordArgs(["--issue", "FOC-123", "--run", runId]), "--issue-file", payload],
    restrictedEnv(),
  );
  assert.equal(rr.status, 1, rr.stdout + rr.stderr);
  const holds = holdsOf(runId).filter((h) => h.state === "open" && h.origin === "ownership");
  assert.equal(holds.length, 1, "propose-then-record on one refused ticket is one hold");
  assert.equal(holds[0].issueId, "FOC-777", "the payload identifier is the canonical key");
  assert.equal(JSON.parse(rr.stdout).hold, JSON.parse(pr.stdout).hold, "the retried refusal reuses the hold");
});

test("a refused re-record strips the stale spawn licence from triage.json", () => {
  const runId = withRun();
  const recordJw = [...recordArgs(["--issue", "FOC-999", "--run", runId]), "--issue-file", fixture({ project: JW })];
  const ok = run(recordJw, restrictedEnv());
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  let rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.equal(rec.ownership?.allowed, true, "precondition: the stamp is on the file");

  // The config flips: the project the supervisor just recorded now belongs to
  // the orchestrator, and the forced re-record is refused by the gate.
  const flippedPath = join(tmp, "ownership-flipped-jw.json");
  writeFileSync(
    flippedPath,
    JSON.stringify({ version: 1, owners: { orchestrator: { linearProjects: ["proj-jw-id"] } }, unlisted: "ask" }),
    "utf8",
  );
  const flippedEnv = { LA_TASK_OWNERSHIP_CONFIG: flippedPath, LA_TASK_OWNER: "supervisor" };
  const refused = run(
    [...recordArgs(["--issue", "FOC-999", "--run", runId, "--force"]), "--issue-file", fixture({ project: JW })],
    flippedEnv,
  );
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).code, "ownership-foreign");

  rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.equal(rec.ownership, undefined, "the stale spawn licence is gone");
  assert.equal(rec.verdict, "dev", "the earlier verdict stays on record");
  assert.equal(rec.issue, "FOC-999", "the same issue's record was rewritten, not another's");
  assert.equal(holdsOf(runId).filter((h) => h.state === "open" && h.origin === "ownership").length, 1);
});

test("a refused record for a DIFFERENT issue does not touch the existing triage.json", () => {
  const runId = withRun();
  const recordJw = [...recordArgs(["--issue", "FOC-999", "--run", runId]), "--issue-file", fixture({ project: JW })];
  const ok = run(recordJw, restrictedEnv());
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);

  const refused = run(
    [...recordArgs(["--issue", "FOC-888", "--run", runId, "--force"]), "--issue-file", fixture({ id: "FOC-888", project: FENIX })],
    restrictedEnv(),
  );
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  const rec = JSON.parse(readFileSync(join(runDirOf(runId), "triage.json"), "utf8"));
  assert.equal(rec.issue, "FOC-999", "the other issue's record is untouched");
  assert.equal(rec.ownership?.allowed, true, "its spawn licence survives a refusal aimed elsewhere");
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
