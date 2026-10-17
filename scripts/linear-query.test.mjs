// Tests for linear-query.mjs — run with: node scripts/linear-query.test.mjs
//
// Covers the `issue` detail path: the query sent to Linear must select
// project { id name } and team { id key name } (task ownership reads
// issue.project), and the mocked response must ride through unchanged —
// including project: null, which stays null (never undefined).
//
// Nothing touches the network: `globalThis.fetch` is stubbed (same pattern
// as linear-client.test.mjs) and the exported cmdIssue handler is driven
// in-process with the dry-run path off — the dry-run route lives under
// .state/ and is not usable from tests.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = pathToFileURL(join(__dirname, "linear-query.mjs")).href;

// ---------------------------------------------------------------------------
// Test harness (mirrors linear-client.test.mjs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function httpResponse({ ok = true, status = 200, statusText = "OK", body = {} } = {}) {
  return { ok, status, statusText, json: async () => body };
}

function stubFetch(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const index = calls.length;
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return responder(index);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Run `fn` with only LINEAR_API_KEY set, then restore. */
async function withApiKey(fn) {
  const key = "LINEAR_API_KEY";
  const saved = process.env[key];
  process.env[key] = "k";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

/** Capture console.log around `fn`; returns the collected string args. */
async function captureLogs(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...parts) => lines.push(parts.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

const NO_DRY_RUN = { active: false, squad: null, fixturePath: null };

/** Collapse runs of whitespace so field selections can be matched regardless
 * of the multi-line formatting inside the query template literals. */
const normalized = (s) => s.replace(/\s+/g, " ");

const BASIC = {
  id: "i1",
  identifier: "FOC-1",
  title: "Some task",
  url: "https://linear.app/x/issue/FOC-1",
  state: { id: "s1", name: "Todo", type: "unstarted" },
};

const DETAIL = {
  ...BASIC,
  description: "",
  priority: 0,
  estimate: 2,
  project: { id: "p1", name: "Fenix" },
  team: { id: "t1", key: "FEN", name: "Fenix" },
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  assignee: null,
  labels: { nodes: [] },
  parent: null,
  children: { nodes: [] },
  comments: { nodes: [] },
  relations: { nodes: [] },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  const mod = await import(MODULE_PATH);
  const { cmdIssue } = mod;

  // ---- Test 1: the detail query selects project { id name } ----
  {
    const f = stubFetch((i) =>
      i === 0
        ? httpResponse({ body: { data: { issue: BASIC } } })
        : httpResponse({ body: { data: { issue: DETAIL } } }),
    );
    await withApiKey(() =>
      captureLogs(() => cmdIssue({ _: ["FOC-1"], json: true }, NO_DRY_RUN)),
    );
    const detailQuery = normalized(f.calls[1].body.query);
    assert(detailQuery.includes("project { id name }"), "detail query selects project { id name }");
    assert(detailQuery.includes("team { id key name }"), "detail query selects team { id key name }");
    f.restore();
  }

  // ---- Test 2: a response with a project rides through --json unchanged ----
  {
    const f = stubFetch((i) =>
      i === 0
        ? httpResponse({ body: { data: { issue: BASIC } } })
        : httpResponse({ body: { data: { issue: DETAIL } } }),
    );
    const lines = await withApiKey(() =>
      captureLogs(() => cmdIssue({ _: ["FOC-1"], json: true }, NO_DRY_RUN)),
    );
    const issue = JSON.parse(lines[0]);
    assertEq(issue.project?.id, "p1", "project id passes through to --json output");
    assertEq(issue.project?.name, "Fenix", "project name passes through to --json output");
    assertEq(issue.team?.key, "FEN", "team rides through alongside project");
    f.restore();
  }

  // ---- Test 3: project: null passes through as null, never undefined ----
  {
    const f = stubFetch((i) =>
      i === 0
        ? httpResponse({ body: { data: { issue: BASIC } } })
        : httpResponse({ body: { data: { issue: { ...DETAIL, project: null } } } }),
    );
    const lines = await withApiKey(() =>
      captureLogs(() => cmdIssue({ _: ["FOC-1"], json: true }, NO_DRY_RUN)),
    );
    const issue = JSON.parse(lines[0]);
    assert(Object.hasOwn(issue, "project"), "the project key is present in --json output");
    assertEq(issue.project, null, "a null project serialises as null");
    f.restore();
  }

  // ---- Test 4: human output gains a Project line without breaking the rest ----
  {
    const f = stubFetch((i) =>
      i === 0
        ? httpResponse({ body: { data: { issue: BASIC } } })
        : httpResponse({ body: { data: { issue: DETAIL } } }),
    );
    const lines = await withApiKey(() =>
      captureLogs(() => cmdIssue({ _: ["FOC-1"] }, NO_DRY_RUN)),
    );
    assert(lines.some((l) => l.startsWith("FOC-1: ")), "the title header is still printed");
    assert(lines.some((l) => l.startsWith("State: ")), "the State header is still printed");
    assert(lines.includes("Project: Fenix"), "human output names the project");
    f.restore();
  }

  // ---- Test 5: human output with no project prints (none) ----
  {
    const f = stubFetch((i) =>
      i === 0
        ? httpResponse({ body: { data: { issue: BASIC } } })
        : httpResponse({ body: { data: { issue: { ...DETAIL, project: null } } } }),
    );
    const lines = await withApiKey(() =>
      captureLogs(() => cmdIssue({ _: ["FOC-1"] }, NO_DRY_RUN)),
    );
    assert(lines.includes("Project: (none)"), "a missing project prints as (none)");
    f.restore();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("linear-query tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
