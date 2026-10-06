// scripts/plan-duplicate-retrieval.test.mjs — FOC-519: the retrieval that
// feeds the plan.duplicate_of gate its candidates.
//
// Four things are worth failing a build over here.
//
// 1. THE CANDIDATE SHAPE IS EXACT. Every record is exactly {id, identifier,
//    title, state:{id, name, type}} — no extra fields, no missing fields —
//    ready for the (future) consumer to map onto buildPlanGates' {key, title}
//    seam shape.
//
// 2. FILTERS ARE BUSINESS, PAYLOAD IS CONTRACT. Done/Canceled (by state
//    TYPE, not name), other teams and the issue itself are dropped one by
//    one; a schema-invalid node anywhere in the payload empties the WHOLE
//    result — a half-real candidate list is exactly what the fail-closed
//    discipline exists to prevent.
//
// 3. ORDER IS DETERMINISTIC. Numeric identifier part ascending, identifier
//    ascending as tie-break — the same set always yields the same list,
//    whatever order the endpoint returned it in.
//
// 4. EVERYTHING FAILS CLOSED. Transport throws, auth errors, malformed and
//    partial payloads resolve to [] — the no_candidates skip buildPlanGates
//    already records. Caller bugs throw before any call. Two probes drive
//    the REAL transport (linear-client's graphql) with the network severed
//    and the key seam scrubbed, proving the network is provably never
//    reached and nothing is ever fabricated.
//
// Hermetic: no network, no key, no file writes, no live .state — the Linear
// transport is an injected fetchPage stub, or the real client behind the
// LA_LINEAR_NO_ENV_FILE seam with fetch stubbed to throw.
//
// Run: node scripts/plan-duplicate-retrieval.test.mjs

import assert from "node:assert/strict";

import { buildPlanGates } from "./plan-gates.mjs";
import { findDuplicateCandidates } from "./plan-duplicate-retrieval.mjs";

// Hermetic by construction (decision-call.test.mjs pattern).
delete process.env.LA_RUN_ID;

let passed = 0;
const failures = [];
const asyncTests = [];

function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

const ISSUE = "FEN-519";
const TEAM = "FEN";
const TITLE = "Gantt snapshot lib";

// A schema-valid node the way the search endpoint answers the module's
// selection. Done states carry type "completed"; Canceled type "canceled".
function node(identifier, { stateType = "started", stateName = "In Progress", teamKey = "FEN", id = `id-${identifier}`, title = `title ${identifier}` } = {}) {
  return {
    id,
    identifier,
    title,
    state: { id: `st-${identifier}`, name: stateName, type: stateType },
    team: { key: teamKey },
  };
}

const open = (identifier, overrides = {}) => node(identifier, overrides);

// A stub fetchPage: records every call and answers with the given data.
function stubPage(data) {
  const calls = [];
  const fetchPage = async (term, first) => {
    calls.push({ term, first });
    return data;
  };
  return { calls, fetchPage };
}

// Snapshot/restore for the env seams the real-transport probes touch.
function withScrubbedEnv(fn) {
  const saved = {
    noEnvFile: process.env.LA_LINEAR_NO_ENV_FILE,
    key: process.env.LINEAR_API_KEY,
    pisi: process.env.LINEAR_API_KEY_PISI,
    workspace: process.env.LINEAR_WORKSPACE,
  };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return fn(restore);
}

// ── shape, filters, cap, order ───────────────────────────────────────────────
console.log("\nshape and filters — exactly {id, identifier, title, state}");

testAsync("the happy path maps to exactly {id, identifier, title, state} — no extra fields, no missing fields", async () => {
  const { calls, fetchPage } = stubPage({
    searchIssues: {
      nodes: [
        open("FEN-10"),
        node("FEN-11", { stateType: "unstarted", stateName: "Todo" }),
      ],
    },
  });
  const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
  assert.deepEqual(out, [
    { id: "id-FEN-10", identifier: "FEN-10", title: "title FEN-10", state: { id: "st-FEN-10", name: "In Progress", type: "started" } },
    { id: "id-FEN-11", identifier: "FEN-11", title: "title FEN-11", state: { id: "st-FEN-11", name: "Todo", type: "unstarted" } },
  ]);
  assert.equal(calls.length, 1, "exactly one search call");
  assert.equal(calls[0].term, TITLE, "the issue's title is the search term");
});

testAsync("Done and Canceled are excluded by state type; open types stay", async () => {
  const { fetchPage } = stubPage({
    searchIssues: {
      nodes: [
        node("FEN-2", { stateType: "completed", stateName: "Done" }),
        node("FEN-3", { stateType: "canceled", stateName: "Canceled" }),
        node("FEN-4", { stateType: "backlog", stateName: "Backlog" }),
        node("FEN-5", { stateType: "unstarted", stateName: "Todo" }),
        open("FEN-6"),
        // a done state under a renamed title must not sneak past the type filter
        node("FEN-7", { stateType: "completed", stateName: "Shipped" }),
      ],
    },
  });
  const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
  assert.deepEqual(out.map((c) => c.identifier), ["FEN-4", "FEN-5", "FEN-6"], "only the open states survive");
});

testAsync("candidates are scoped to the issue's team, case-insensitively", async () => {
  const { fetchPage } = stubPage({
    searchIssues: {
      nodes: [
        open("FEN-10"),
        node("JOI-20", { teamKey: "JOI" }),
        node("JOI-21", { teamKey: "joi" }),
      ],
    },
  });
  const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
  assert.deepEqual(out.map((c) => c.identifier), ["FEN-10"], "another team's issues never pass the scope");
});

testAsync("the issue itself is never its own candidate (identifier match, case-insensitive)", async () => {
  const { fetchPage } = stubPage({
    searchIssues: {
      nodes: [
        node(ISSUE),
        node("fen-519", { id: "id-self-lower" }),
        open("FEN-10"),
      ],
    },
  });
  const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
  assert.deepEqual(out.map((c) => c.identifier), ["FEN-10"], "self in any casing is excluded");
});

testAsync("the cap is 5 — seven open same-team candidates return exactly five", async () => {
  const { fetchPage } = stubPage({
    searchIssues: {
      nodes: Array.from({ length: 7 }, (_, i) => open(`FEN-${i + 1}`)),
    },
  });
  const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((c) => c.identifier), ["FEN-1", "FEN-2", "FEN-3", "FEN-4", "FEN-5"]);
});

testAsync("the post-filter does not starve the top-5 — noise among many open candidates still yields five, over a larger fetch window", async () => {
  const { calls, fetchPage } = stubPage({
    searchIssues: {
      nodes: [
        node("FEN-1", { stateType: "completed", stateName: "Done" }),
        node("FEN-2", { stateType: "canceled", stateName: "Canceled" }),
        node("JOI-3", { teamKey: "JOI" }),
        node(ISSUE),
        ...Array.from({ length: 9 }, (_, i) => open(`FEN-${i + 10}`)),
      ],
    },
  });
  const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
  assert.equal(out.length, 5, "five open candidates survive the noise");
  assert.deepEqual(out.map((c) => c.identifier), ["FEN-10", "FEN-11", "FEN-12", "FEN-13", "FEN-14"]);
  assert.equal(calls[0].first, 25, "the fetch window is 5× the cap, not the cap");
});

testAsync("order is deterministic — numeric identifier part ascending, identical output from shuffled inputs", async () => {
  // Lexicographic order would give FEN-10, FEN-100, FEN-2, FEN-3 — the pin
  // below proves the numeric part rules.
  const set = [
    node("FEN-100", { stateType: "unstarted", stateName: "Todo" }),
    open("FEN-3"),
    node("FEN-10", { stateType: "backlog", stateName: "Backlog" }),
    open("FEN-2"),
  ];
  const orders = [
    set,
    [...set].reverse(),
    [set[2], set[0], set[3], set[1]],
  ];
  const expected = ["FEN-2", "FEN-3", "FEN-10", "FEN-100"];
  for (const nodes of orders) {
    const { fetchPage } = stubPage({ searchIssues: { nodes } });
    const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
    assert.deepEqual(out.map((c) => c.identifier), expected, `input order ${nodes.map((n) => n.identifier).join(",")}`);
  }
});

// ── fail closed ──────────────────────────────────────────────────────────────
console.log("\nfail-closed — failures resolve to [], never a fabricated list");

testAsync("a transport throw fails closed to []", async () => {
  const fetchPage = async () => { throw new Error("connection reset mid-search"); };
  const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
  assert.deepEqual(out, []);
});

testAsync("a malformed payload fails closed to []; an empty result is an empty list, not an error", async () => {
  for (const data of [
    undefined,
    null,
    {},
    { searchIssues: null },
    { searchIssues: {} },
    { searchIssues: { nodes: "nope" } },
    { searchIssues: { nodes: null } },
  ]) {
    const { fetchPage } = stubPage(data);
    const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
    assert.deepEqual(out, [], JSON.stringify(data));
  }
  const { calls, fetchPage } = stubPage({ searchIssues: { nodes: [] } });
  const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
  assert.deepEqual(out, [], "an empty search result is an empty candidate list");
  assert.equal(calls.length, 1, "the search still ran");
});

testAsync("a partially broken payload fails closed ENTIRELY — one schema-invalid node empties the whole list", async () => {
  for (const broken of [
    null,
    "not an object",
    { ...open("FEN-10"), title: "" },
    { ...open("FEN-10"), id: "" },
    { ...open("FEN-10"), identifier: "FENX" },
    { ...open("FEN-10"), state: { name: "In Progress", type: "started" } },
    { ...open("FEN-10"), state: "started" },
    { ...open("FEN-10"), state: { id: "st", name: "In Progress" } },
    { ...open("FEN-10"), team: {} },
    { ...open("FEN-10"), team: null },
  ]) {
    const { fetchPage } = stubPage({ searchIssues: { nodes: [open("FEN-11"), broken] } });
    const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
    assert.deepEqual(out, [], `the valid node must not survive beside ${JSON.stringify(broken)}`);
  }
});

testAsync("caller bugs throw before any call — never swallowed into an empty list", async () => {
  const { calls, fetchPage } = stubPage({ searchIssues: { nodes: [] } });
  for (const args of [
    { teamKey: TEAM, title: TITLE },
    { issue: "   ", teamKey: TEAM, title: TITLE },
    { issue: ISSUE, title: TITLE },
    { issue: ISSUE, teamKey: "  ", title: TITLE },
    { issue: ISSUE, teamKey: TEAM },
    { issue: ISSUE, teamKey: TEAM, title: "   " },
    { issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage: "nope" },
    { issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage: null },
  ]) {
    await assert.rejects(
      () => findDuplicateCandidates({ fetchPage, ...args }),
      /findDuplicateCandidates/,
      `these arguments must be refused: ${JSON.stringify(args)}`,
    );
  }
  assert.equal(calls.length, 0, "the refusal precedes any search call");
});

// ── real-transport probes (FOC-452 pattern) ──────────────────────────────────
console.log("\nprobes — the REAL transport, network severed, nothing fabricated");

testAsync("through the REAL transport, a missing key fails closed to [] before any network call", async () => {
  await withScrubbedEnv(async (restore) => {
    let reached = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { reached++; throw new Error("network must never be reached by these probes"); };
    try {
      process.env.LA_LINEAR_NO_ENV_FILE = "1";
      delete process.env.LINEAR_API_KEY;
      delete process.env.LINEAR_API_KEY_PISI;
      const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE });
      assert.deepEqual(out, []);
      assert.equal(reached, 0, "the refusal precedes any fetch — the network is provably never reached");
    } finally {
      globalThis.fetch = origFetch;
      restore();
    }
  });
});

testAsync("through the REAL transport, a severed network fails closed to [] too", async () => {
  await withScrubbedEnv(async (restore) => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network must never be reached by these probes"); };
    try {
      process.env.LA_LINEAR_NO_ENV_FILE = "1";
      process.env.LINEAR_API_KEY = "test-key";
      delete process.env.LINEAR_API_KEY_PISI;
      const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE });
      assert.deepEqual(out, [], "a transport failure past auth is fail-closed [] all the same");
    } finally {
      globalThis.fetch = origFetch;
      restore();
    }
  });
});

// ── the seam end to end ──────────────────────────────────────────────────────
console.log("\nseam shape — the retrieval feeds buildPlanGates' plan.duplicate_of");

const STATE = "Title: Gantt snapshot lib\n\nExport the schedule as a PNG.";

// A stub seam caller in the plan-gates.test.mjs shape: typed answers for
// every question the call carried, over every served decisionId.
function stubCaller() {
  const calls = [];
  const caller = async (input) => {
    calls.push(input);
    const keys = input.instances
      ? input.instances.map((_, i) => (input.decisionId === "plan.ac.testable" ? `ac${i}` : `cand${i}`))
      : ["q0"];
    const answers = Object.fromEntries(keys.map((k, i) => [
      k,
      input.decisionId === "plan.ac.testable"
        ? { type: "noul", noul: 1, confidence: 0.9 }
        : k === "q0"
          ? { type: "choice", choice: "feature", confidence: 0.9 }
          : i === 0
            ? { type: "choice", choice: "related", confidence: 0.8 }
            : { type: "choice", choice: "distinct", confidence: 0.8 },
    ]));
    return {
      ok: true,
      decisionId: input.decisionId,
      annotation: { answers, confidence: 0.9 },
      eventId: `evt-${input.decisionId}`,
    };
  };
  return { calls, caller };
}

testAsync("the retrieval output, mapped to the seam's {key, title} shape, serves plan.duplicate_of end to end", async () => {
  const { fetchPage } = stubPage({
    searchIssues: {
      nodes: [
        node("FEN-10", { title: "Gantt snapshot export" }),
        node("FEN-11", { stateType: "unstarted", stateName: "Todo" }),
      ],
    },
  });
  const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
  // The documented {key, title} mapping — the future consumer's job, proven here.
  const candidates = out.map((c) => ({ key: c.identifier, title: c.title }));
  const { calls, caller } = stubCaller();
  const { record, warnings } = await buildPlanGates({
    issue: ISSUE,
    state: STATE,
    caller,
    candidates,
    acs: [{ id: "AC-1", text: "returns a PNG data-URL for a populated schedule" }],
    runId: null,
  });
  assert.equal(warnings.length, 0, JSON.stringify(warnings));
  const dup = record.decisions["plan.duplicate_of"];
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicateOf, null, "the stub answered related/distinct — nothing judged a duplicate");
  const dupCall = calls.find((c) => c.decisionId === "plan.duplicate_of");
  assert.deepEqual(dupCall.instances, candidates, "the mapped candidates ride the call verbatim");
  assert.deepEqual(dupCall.instances.map((c) => c.key), ["FEN-10", "FEN-11"]);
});

testAsync("an empty retrieval becomes the existing no_candidates skip, visibly", async () => {
  const { fetchPage } = stubPage({ searchIssues: { nodes: [] } });
  const out = await findDuplicateCandidates({ issue: ISSUE, teamKey: TEAM, title: TITLE, fetchPage });
  const { caller } = stubCaller();
  const { record, warnings } = await buildPlanGates({
    issue: ISSUE,
    state: STATE,
    caller,
    candidates: out,
    acs: [{ id: "AC-1", text: "returns a PNG data-URL for a populated schedule" }],
    runId: null,
  });
  assert.equal(record.decisions["plan.duplicate_of"].ok, false);
  assert.equal(record.decisions["plan.duplicate_of"].code, "no_candidates");
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /plan\.duplicate_of skipped/);
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
      const at = String(err.stack ?? "").split("\n").find((l) => l.includes("plan-duplicate-retrieval.test.mjs:")) ?? "";
      console.log(`  FAIL ${name}\n       ${err.message}\n       ${at.trim()}`);
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