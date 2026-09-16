// Tests for bootstrap-linear.mjs — run with: node scripts/bootstrap-linear.test.mjs
//
// FOC-297: the label fetches used a bare first:100 — on a team past 100 labels
// whose label groups sit beyond that cap, bootstrap saw zero groups and
// re-created existing ones, which Linear rejected as duplicate names. These
// tests pin the cursor pagination, its fail-loud guards, the unchanged
// single-page behaviour, and the duplicate-name self-heal in
// provisionLabelGroups. Nothing here touches the network — globalThis.fetch is
// stubbed, so a stray real request surfaces as an unstubbed-call failure
// rather than a silent API hit. (graphql() still requires LINEAR_API_KEY to be
// set even with fetch stubbed, hence the withEnv wrappers.)

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = pathToFileURL(join(__dirname, "bootstrap-linear.mjs")).href;

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

/** Assert that `fn` rejects, and hand the message to `check`. */
async function assertRejects(fn, check, label) {
  try {
    await fn();
    console.log(`  FAIL: ${label} (did not throw)`);
    failed++;
  } catch (e) {
    if (check(e.message)) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.log(`  FAIL: ${label}`);
      console.log(`    unexpected message: ${e.message}`);
      failed++;
    }
  }
}

const ENV_KEYS = ["LINEAR_API_KEY", "LINEAR_API_KEY_PISI", "LINEAR_WORKSPACE"];

/** Run `fn` with ONLY the given Linear env vars set, then restore. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Build a minimal Response-alike. */
function httpResponse({ ok = true, status = 200, statusText = "OK", body = {} }) {
  return { ok, status, statusText, json: async () => body };
}

/**
 * Replace globalThis.fetch with a recorder. `responder(body, index)` returns
 * the response for each call; the parsed request body is handed over so
 * fixtures can key pages off the cursor the code under test actually sends.
 */
function stubFetch(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, opts, body });
    return responder(body, calls.length - 1);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Silence console.log while provisioning prints its progress lines. */
async function withSilencedConsole(fn) {
  const orig = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = orig;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;

/** A non-group label as the API returns it (parent null; no children). */
function standaloneLabel(i) {
  return { id: `l${i}`, name: `lab-${i}`, isGroup: false, parent: null };
}

/** A group label carrying its children (only the groups query selects them). */
function groupLabel(id, name, children) {
  return { id, name, isGroup: true, parent: null, children: { nodes: children } };
}

// 117 labels — the live FOC team shape. Both groups sit past index 99, where
// the old first:100 cap cut the connection, so a capped fetch saw zero groups.
const PAGE_BUSTER_LABELS = (() => {
  const labels = [];
  for (let i = 1; i <= 117; i++) labels.push(standaloneLabel(i));
  labels[104] = groupLabel("g-type", "type", [{ id: "c1", name: "bug" }, { id: "c2", name: "feature" }]);
  labels[109] = groupLabel("g-ai", "ai", [{ id: "c3", name: "coded" }]);
  return labels;
})();

// One page, small team: a group with two children + one standalone flag.
const SMALL_TEAM_GROUPS_VIEW = [
  groupLabel("g-type", "type", [{ id: "c1", name: "bug" }, { id: "c2", name: "feature" }]),
  standaloneLabel(3),
];
// The same team as the API answers the children-less fetchExistingLabels query.
const SMALL_TEAM_LABELS_VIEW = [
  { id: "g-type", name: "type", isGroup: true, parent: null },
  standaloneLabel(3),
];

/**
 * Serve a 100-node page per call, keyed off the cursor the code under test
 * actually sends: page k ends with endCursor `cursor-${k}` and
 * `after: "cursor-${k}"` serves page k+1. A loop that fails to advance `after`
 * keeps seeing page 0 and never terminates — such a regression fails on the
 * page cap instead of passing vacuously.
 */
function pagedLabelsResponder({ alwaysMore = false, labels = PAGE_BUSTER_LABELS } = {}) {
  return (body) => {
    const after = body.variables?.after;
    const page = after === undefined ? 0 : Number(String(after).replace("cursor-", "")) + 1;
    const nodes = labels.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const hasNext = alwaysMore || (page + 1) * PAGE_SIZE < labels.length;
    return httpResponse({
      body: {
        data: {
          team: {
            labels: {
              nodes,
              pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? `cursor-${page}` : null },
            },
          },
        },
      },
    });
  };
}

/** Page 1 claims more pages but carries no endCursor to continue from. */
function noEndCursorResponder() {
  return () =>
    httpResponse({
      body: {
        data: {
          team: {
            labels: { nodes: [standaloneLabel(1)], pageInfo: { hasNextPage: true, endCursor: null } },
          },
        },
      },
    });
}

/** A connection with no pageInfo at all. */
function noPageInfoResponder() {
  return () =>
    httpResponse({ body: { data: { team: { labels: { nodes: [standaloneLabel(1)] } } } } });
}

/**
 * Responder for provisionLabelGroups: serves the issueLabelCreate mutations
 * (the group create optionally rejected as a duplicate name) and the
 * team.labels re-fetch the duplicate-name heal performs.
 */
function provisioningResponder({ duplicateGroupCreate = false, refetchLabels = [] } = {}) {
  return (body) => {
    if (body.query.includes("issueLabelCreate")) {
      if (body.variables.input.isGroup === true && duplicateGroupCreate) {
        return httpResponse({ body: { errors: [{ message: "Label name has already been used" }] } });
      }
      const isGroup = body.variables.input.isGroup === true;
      return httpResponse({
        body: {
          data: {
            issueLabelCreate: {
              success: true,
              issueLabel: {
                id: isGroup ? "g-new" : `child-${body.variables.input.name}`,
                name: body.variables.input.name,
              },
            },
          },
        },
      });
    }
    // The team.labels (re-)fetch — served as a single complete page.
    return httpResponse({
      body: {
        data: {
          team: { labels: { nodes: refetchLabels, pageInfo: { hasNextPage: false, endCursor: null } } },
        },
      },
    });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  const mod = await import(MODULE_PATH);
  const { fetchExistingLabelGroups, fetchExistingLabels, provisionLabelGroups } = mod;

  // ---- Test 1: fetchExistingLabels follows cursors to completion (FOC-297) ----
  {
    const f = stubFetch(pagedLabelsResponder());
    const labels = await withEnv({ LINEAR_API_KEY: "k" }, () => fetchExistingLabels("t1"));
    assertEq(labels.length, 117, "all 117 labels are fetched, not just the first 100");
    assertEq(f.calls.length, 2, "two pages are fetched");
    assertEq(f.calls[0].body.variables.after, undefined, "the first request carries no cursor");
    assertEq(f.calls[1].body.variables.after, "cursor-0", "the second request advances to the page-1 cursor");
    assertEq(labels[116].name, "lab-117", "the last label of the final page is present");
    f.restore();
  }

  // ---- Test 2: groups beyond the first page are found, children carried ----
  {
    const f = stubFetch(pagedLabelsResponder());
    const groups = await withEnv({ LINEAR_API_KEY: "k" }, () => fetchExistingLabelGroups("t1"));
    assertEq(f.calls.length, 2, "the groups fetch paginates too");
    assertEq(groups.length, 2, "both groups beyond the old first:100 cap are found");
    assertEq(groups.map((g) => g.name).join(","), "type,ai", "group names match");
    assertEq(
      JSON.stringify(groups[0].children.nodes),
      '[{"id":"c1","name":"bug"},{"id":"c2","name":"feature"}]',
      "children are carried on the group",
    );
    f.restore();
  }

  // ---- Test 3: guard — a responder that never says hasNextPage:false throws ----
  {
    const f = stubFetch(pagedLabelsResponder({ alwaysMore: true }));
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => fetchExistingLabels("t1"),
        (m) => m.includes("exceeded 100 pages") && m.includes("truncated"),
        "a never-ending connection fails loud instead of looping or truncating",
      );
    });
    assertEq(f.calls.length, 100, "the defensive page cap stops the loop");
    f.restore();
  }

  // ---- Test 4: guard — hasNextPage=true without an endCursor throws ----
  {
    const f = stubFetch(noEndCursorResponder());
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => fetchExistingLabels("t1"),
        (m) => m.includes("malformed pageInfo") && m.includes("endCursor: null"),
        "a missing continuation cursor is refused instead of looping on page 1",
      );
    });
    assertEq(f.calls.length, 1, "the refusal happens on the first malformed page");
    f.restore();
  }

  // ---- Test 5: guard — a connection without pageInfo throws ----
  {
    const f = stubFetch(noPageInfoResponder());
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => fetchExistingLabels("t1"),
        (m) => m.includes("malformed pageInfo"),
        "missing pagination metadata fails loud instead of returning a partial set",
      );
    });
    assertEq(f.calls.length, 1, "no further requests after the malformed page");
    f.restore();
  }

  // ---- Test 6: single page — groups fetch keeps its result and round-trips once ----
  {
    const f = stubFetch(pagedLabelsResponder({ labels: SMALL_TEAM_GROUPS_VIEW }));
    const groups = await withEnv({ LINEAR_API_KEY: "k" }, () => fetchExistingLabelGroups("t1"));
    assertEq(f.calls.length, 1, "a fitting team needs a single request");
    assertEq(
      JSON.stringify(groups),
      JSON.stringify([SMALL_TEAM_GROUPS_VIEW[0]]),
      "the group (with children) is returned unchanged",
    );
    f.restore();
  }

  // ---- Test 7: single page — labels fetch keeps its result ----
  {
    const f = stubFetch(pagedLabelsResponder({ labels: SMALL_TEAM_LABELS_VIEW }));
    const labels = await withEnv({ LINEAR_API_KEY: "k" }, () => fetchExistingLabels("t1"));
    assertEq(f.calls.length, 1, "a fitting team needs a single request");
    assertEq(
      JSON.stringify(labels),
      JSON.stringify(SMALL_TEAM_LABELS_VIEW),
      "the label list is returned unchanged (same shape as before pagination)",
    );
    f.restore();
  }

  // ---- Test 8: heal — a duplicate-name group create is re-matched and skipped ----
  {
    const healed = groupLabel("g-risk", "risk", [{ id: "c9", name: "high" }]);
    const f = stubFetch(provisioningResponder({ duplicateGroupCreate: true, refetchLabels: [healed] }));
    const out = await withEnv({ LINEAR_API_KEY: "k" }, () =>
      withSilencedConsole(() =>
        provisionLabelGroups("t1", { risk: { exclusive: true, labels: ["high"] } }, {}, [], [], false),
      ),
    );
    assertEq(out.created, 0, "nothing is created when the group already exists");
    assertEq(out.skipped, 2, "the group and its existing child are skipped");
    assertEq(
      f.calls.filter((c) => c.body.query.includes("issueLabelCreate")).length,
      1,
      "exactly one create attempt is made",
    );
    f.restore();
  }

  // ---- Test 9: no heal — a create failure with no matching group surfaces ----
  {
    const f = stubFetch(provisioningResponder({ duplicateGroupCreate: true, refetchLabels: [] }));
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () =>
          withSilencedConsole(() =>
            provisionLabelGroups("t1", { risk: { exclusive: true, labels: ["high"] } }, {}, [], [], false),
          ),
        (m) => m.includes("Label name has already been used"),
        "the original create error surfaces when the re-fetch finds no group",
      );
    });
    f.restore();
  }

  // ---- Test 10: fresh create — the happy path is unchanged ----
  {
    const f = stubFetch(provisioningResponder({}));
    const out = await withEnv({ LINEAR_API_KEY: "k" }, () =>
      withSilencedConsole(() =>
        provisionLabelGroups("t1", { type: { exclusive: true, labels: ["bug", "feature"] } }, {}, [], [], false),
      ),
    );
    assertEq(out.created, 3, "the group plus both children are created");
    assertEq(out.skipped, 0, "nothing is skipped on a fresh create");
    const groupCreate = f.calls.find((c) => c.body.variables.input.isGroup === true);
    const childCreates = f.calls.filter((c) => c.body.variables.input.parentId);
    assertEq(groupCreate.body.variables.input.name, "type", "the group is created first");
    assertEq(childCreates.length, 2, "both children are created");
    for (const c of childCreates) {
      assertEq(c.body.variables.input.parentId, "g-new", `child "${c.body.variables.input.name}" links to the new group`);
    }
    f.restore();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("bootstrap-linear tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
