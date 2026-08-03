// Tests for linear-client.mjs — run with: node scripts/linear-client.test.mjs
//
// The shared Linear client: 6 modules import it and `graphql()` has a blast
// radius of 23 symbols (code-review-2026-08-03 §5). Nothing here touches the
// network — `globalThis.fetch` is stubbed, so a stray real request would show
// up as an unstubbed-call failure rather than a silent API hit.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = pathToFileURL(join(__dirname, "linear-client.mjs")).href;

// ---------------------------------------------------------------------------
// Test harness
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
 * Replace globalThis.fetch with a recorder. `responder(callIndex)` returns the
 * response for each successive call, so multi-step flows (resolveIssue's
 * direct-then-search) can be scripted.
 */
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

const TEAMS = {
  teams: {
    nodes: [
      { id: "t1", name: "Jointhubs", key: "JOI" },
      { id: "t2", name: "Pisi", key: "PISI" },
    ],
  },
};

const ISSUE = {
  id: "i1",
  identifier: "JOI-12",
  title: "Some task",
  url: "https://linear.app/x/issue/JOI-12",
  state: { id: "s1", name: "Todo", type: "unstarted" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  const mod = await import(MODULE_PATH);
  const { loadEnv, ENDPOINT, chooseApiKey, graphql, resolveTeam, resolveIssue } = mod;

  // ---- Test 1: ENDPOINT is the Linear GraphQL URL ----
  assertEq(ENDPOINT, "https://api.linear.app/graphql", "ENDPOINT points at Linear");

  // ---- Test 2: chooseApiKey honours an explicit workspace ----
  await withEnv({ LINEAR_API_KEY: "joi-key", LINEAR_API_KEY_PISI: "pisi-key" }, () => {
    assertEq(chooseApiKey("pisi"), "pisi-key", "explicit 'pisi' selects the pisi key");
    assertEq(chooseApiKey("jointhubs"), "joi-key", "explicit 'jointhubs' selects the default key");
  });

  // ---- Test 3: explicit workspace beats the env default ----
  // This is the JOI-68 regression: ?workspace=pisi used to return jointhubs data.
  await withEnv(
    { LINEAR_API_KEY: "joi-key", LINEAR_API_KEY_PISI: "pisi-key", LINEAR_WORKSPACE: "jointhubs" },
    () => {
      assertEq(chooseApiKey("pisi"), "pisi-key", "explicit workspace overrides LINEAR_WORKSPACE");
    },
  );

  // ---- Test 4: omitted workspace falls back to env ----
  await withEnv(
    { LINEAR_API_KEY: "joi-key", LINEAR_API_KEY_PISI: "pisi-key", LINEAR_WORKSPACE: "pisi" },
    () => {
      assertEq(chooseApiKey(), "pisi-key", "no argument falls back to LINEAR_WORKSPACE");
    },
  );

  // ---- Test 5: unknown workspace uses the default key ----
  await withEnv({ LINEAR_API_KEY: "joi-key", LINEAR_API_KEY_PISI: "pisi-key" }, () => {
    assertEq(chooseApiKey("nonsense"), "joi-key", "unknown workspace falls back to the default key");
    assertEq(chooseApiKey(), "joi-key", "no workspace and no env uses the default key");
  });

  // ---- Test 6: missing key throws BEFORE any network call ----
  // The docstring promises validation precedes the request; assert the promise.
  {
    const f = stubFetch(() => httpResponse({ body: { data: {} } }));
    await withEnv({}, async () => {
      await assertRejects(
        () => graphql("query { x }"),
        (m) => m === "LINEAR_API_KEY not set (check .env)",
        "missing key throws the plain message",
      );
    });
    assertEq(f.calls.length, 0, "no HTTP request is made when the key is missing");
    f.restore();
  }

  // ---- Test 7: missing workspace key names the workspace ----
  {
    const f = stubFetch(() => httpResponse({ body: { data: {} } }));
    await withEnv({ LINEAR_API_KEY: "joi-key" }, async () => {
      await assertRejects(
        () => graphql("query { x }", {}, "pisi"),
        (m) => m.includes("workspace 'pisi'"),
        "missing workspace key names the workspace",
      );
    });
    assertEq(f.calls.length, 0, "no HTTP request for a missing workspace key");
    f.restore();
  }

  // ---- Test 8: request shape — endpoint, method, auth header, body ----
  {
    const f = stubFetch(() => httpResponse({ body: { data: { ok: 1 } } }));
    await withEnv({ LINEAR_API_KEY: "joi-key" }, async () => {
      await graphql("query($a: String) { x }", { a: "b" });
    });
    const call = f.calls[0];
    assertEq(call.url, "https://api.linear.app/graphql", "posts to the Linear endpoint");
    assertEq(call.opts.method, "POST", "uses POST");
    assertEq(call.opts.headers.Authorization, "joi-key", "sends the chosen key as Authorization");
    assertEq(call.opts.headers["Content-Type"], "application/json", "sends a JSON content type");
    assertEq(call.body.query, "query($a: String) { x }", "forwards the query verbatim");
    assertEq(call.body.variables.a, "b", "forwards the variables");
    f.restore();
  }

  // ---- Test 9: variables default to an empty object ----
  {
    const f = stubFetch(() => httpResponse({ body: { data: {} } }));
    await withEnv({ LINEAR_API_KEY: "joi-key" }, async () => {
      await graphql("query { x }");
    });
    assertEq(
      JSON.stringify(f.calls[0].body.variables),
      "{}",
      "omitted variables serialise as {}",
    );
    f.restore();
  }

  // ---- Test 10: workspace argument picks the key actually sent ----
  {
    const f = stubFetch(() => httpResponse({ body: { data: {} } }));
    await withEnv({ LINEAR_API_KEY: "joi-key", LINEAR_API_KEY_PISI: "pisi-key" }, async () => {
      await graphql("query { x }", {}, "pisi");
    });
    assertEq(f.calls[0].opts.headers.Authorization, "pisi-key", "pisi request authenticates as pisi");
    f.restore();
  }

  // ---- Test 11: success returns only the data envelope ----
  {
    const f = stubFetch(() => httpResponse({ body: { data: { teams: { nodes: [] } } } }));
    const out = await withEnv({ LINEAR_API_KEY: "k" }, () => graphql("query { x }"));
    assertEq(JSON.stringify(out), '{"teams":{"nodes":[]}}', "returns body.data, not the whole body");
    f.restore();
  }

  // ---- Test 12: HTTP failure surfaces body.error ----
  {
    const f = stubFetch(() =>
      httpResponse({ ok: false, status: 401, statusText: "Unauthorized", body: { error: "bad token" } }),
    );
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => graphql("query { x }"),
        (m) => m === "Linear API 401: bad token",
        "HTTP error prefers body.error",
      );
    });
    f.restore();
  }

  // ---- Test 13: HTTP failure falls back to errors[0].message ----
  {
    const f = stubFetch(() =>
      httpResponse({ ok: false, status: 400, statusText: "Bad Request", body: { errors: [{ message: "nope" }] } }),
    );
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => graphql("query { x }"),
        (m) => m === "Linear API 400: nope",
        "HTTP error falls back to errors[0].message",
      );
    });
    f.restore();
  }

  // ---- Test 14: HTTP failure with an empty body falls back to statusText ----
  {
    const f = stubFetch(() =>
      httpResponse({ ok: false, status: 500, statusText: "Internal Server Error", body: {} }),
    );
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => graphql("query { x }"),
        (m) => m === "Linear API 500: 500 Internal Server Error",
        "empty error body falls back to status + statusText",
      );
    });
    f.restore();
  }

  // ---- Test 15: HTTP 200 carrying GraphQL errors still throws ----
  // Linear answers 200 with an `errors` array for query-level failures; treating
  // that as success would hand callers `undefined` data.
  {
    const f = stubFetch(() =>
      httpResponse({ body: { errors: [{ message: "Field 'x' doesn't exist" }] } }),
    );
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => graphql("query { x }"),
        (m) => m === "GraphQL error: Field 'x' doesn't exist",
        "200 with a GraphQL errors array throws the readable message",
      );
    });
    f.restore();
  }

  // ---- Test 15b: several GraphQL errors are joined, not truncated to one ----
  {
    const f = stubFetch(() =>
      httpResponse({ body: { errors: [{ message: "first" }, { message: "second" }] } }),
    );
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => graphql("query { x }"),
        (m) => m === "GraphQL error: first; second",
        "multiple errors are joined with '; '",
      );
    });
    f.restore();
  }

  // ---- Test 15c: a message-less error still surfaces its shape ----
  {
    const f = stubFetch(() => httpResponse({ body: { errors: [{ code: "X" }] } }));
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => graphql("query { x }"),
        (m) => m.includes('"code"') && m.includes("X"),
        "an error without .message falls back to the raw shape",
      );
    });
    f.restore();
  }

  // ---- Test 16: resolveTeam matches case-insensitively ----
  {
    const f = stubFetch(() => httpResponse({ body: { data: TEAMS } }));
    const team = await withEnv({ LINEAR_API_KEY: "k" }, () => resolveTeam("joi"));
    assertEq(team.id, "t1", "lowercase key resolves the team");
    assertEq(team.key, "JOI", "returns the canonical key casing");
    f.restore();
  }

  // ---- Test 17: resolveTeam lists what was available when it fails ----
  {
    const f = stubFetch(() => httpResponse({ body: { data: TEAMS } }));
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => resolveTeam("NOPE"),
        (m) => m.includes("not found: NOPE") && m.includes("JOI (Jointhubs)") && m.includes("PISI (Pisi)"),
        "unknown team error lists the available teams",
      );
    });
    f.restore();
  }

  // ---- Test 17b: resolveTeam forwards an explicit workspace ----
  // bootstrap-linear.mjs pins "jointhubs"; if the argument were dropped the key
  // would silently follow LINEAR_WORKSPACE instead.
  {
    const f = stubFetch(() => httpResponse({ body: { data: TEAMS } }));
    await withEnv(
      { LINEAR_API_KEY: "joi-key", LINEAR_API_KEY_PISI: "pisi-key", LINEAR_WORKSPACE: "pisi" },
      () => resolveTeam("JOI", "jointhubs"),
    );
    assertEq(
      f.calls[0].opts.headers.Authorization,
      "joi-key",
      "explicit workspace on resolveTeam wins over LINEAR_WORKSPACE",
    );
    f.restore();
  }

  // ---- Test 17c: resolveTeam without a workspace follows the env ----
  {
    const f = stubFetch(() => httpResponse({ body: { data: TEAMS } }));
    await withEnv(
      { LINEAR_API_KEY: "joi-key", LINEAR_API_KEY_PISI: "pisi-key", LINEAR_WORKSPACE: "pisi" },
      () => resolveTeam("JOI"),
    );
    assertEq(
      f.calls[0].opts.headers.Authorization,
      "pisi-key",
      "omitted workspace on resolveTeam keeps the env default",
    );
    f.restore();
  }

  // ---- Test 18: an empty team list hints at API-key permissions ----
  {
    const f = stubFetch(() => httpResponse({ body: { data: { teams: { nodes: [] } } } }));
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => resolveTeam("JOI"),
        (m) => m.includes("check API key permissions"),
        "no teams at all points at key permissions",
      );
    });
    f.restore();
  }

  // ---- Test 19: resolveIssue returns the direct hit without searching ----
  {
    const f = stubFetch(() => httpResponse({ body: { data: { issue: ISSUE } } }));
    const issue = await withEnv({ LINEAR_API_KEY: "k" }, () => resolveIssue("JOI-12"));
    assertEq(issue.identifier, "JOI-12", "direct lookup returns the issue");
    assertEq(f.calls.length, 1, "a direct hit makes exactly one request (no search fallback)");
    f.restore();
  }

  // ---- Test 20: a null direct hit falls back to search ----
  {
    const f = stubFetch((i) =>
      i === 0
        ? httpResponse({ body: { data: { issue: null } } })
        : httpResponse({ body: { data: { searchIssues: { nodes: [ISSUE] } } } }),
    );
    const issue = await withEnv({ LINEAR_API_KEY: "k" }, () => resolveIssue("JOI-12"));
    assertEq(issue.identifier, "JOI-12", "search fallback finds the issue");
    assertEq(f.calls.length, 2, "falls back with a second request");
    assert(f.calls[1].body.query.includes("searchIssues"), "the second request is a search");
    f.restore();
  }

  // ---- Test 21: a throwing direct hit also falls back ----
  {
    const f = stubFetch((i) =>
      i === 0
        ? httpResponse({ body: { errors: [{ message: "boom" }] } })
        : httpResponse({ body: { data: { searchIssues: { nodes: [ISSUE] } } } }),
    );
    const issue = await withEnv({ LINEAR_API_KEY: "k" }, () => resolveIssue("JOI-12"));
    assertEq(issue.identifier, "JOI-12", "a failing direct lookup still falls back to search");
    f.restore();
  }

  // ---- Test 22: search matches the identifier exactly, not fuzzily ----
  // searchIssues is a text search: it happily returns neighbours like JOI-120.
  {
    const f = stubFetch((i) =>
      i === 0
        ? httpResponse({ body: { data: { issue: null } } })
        : httpResponse({
            body: {
              data: {
                searchIssues: {
                  nodes: [
                    { ...ISSUE, id: "other", identifier: "JOI-120" },
                    { ...ISSUE, identifier: "joi-12" },
                  ],
                },
              },
            },
          }),
    );
    const issue = await withEnv({ LINEAR_API_KEY: "k" }, () => resolveIssue("JOI-12"));
    assertEq(issue.identifier, "joi-12", "picks the exact identifier, not the JOI-120 neighbour");
    f.restore();
  }

  // ---- Test 23: no match anywhere throws ----
  {
    const f = stubFetch((i) =>
      i === 0
        ? httpResponse({ body: { data: { issue: null } } })
        : httpResponse({ body: { data: { searchIssues: { nodes: [] } } } }),
    );
    await withEnv({ LINEAR_API_KEY: "k" }, async () => {
      await assertRejects(
        () => resolveIssue("JOI-999"),
        (m) => m === "Linear issue not found: JOI-999",
        "an unresolvable identifier throws",
      );
    });
    f.restore();
  }

  // ---- Test 24: loadEnv never overwrites an already-set variable ----
  // The repo's .env defines LINEAR_API_KEY, so this exercises the real guard.
  {
    const saved = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "sentinel-do-not-clobber";
    loadEnv();
    assertEq(
      process.env.LINEAR_API_KEY,
      "sentinel-do-not-clobber",
      "loadEnv leaves an already-set variable alone",
    );
    if (saved === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = saved;
  }

  // ---- Test 25: loadEnv is safe to call repeatedly ----
  {
    let threw = false;
    try {
      loadEnv();
      loadEnv();
    } catch {
      threw = true;
    }
    assert(!threw, "loadEnv is idempotent and never throws");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("linear-client tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
