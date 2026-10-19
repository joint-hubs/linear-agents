// Route-level tests for GET /api/team (FOC-791 slice A, team-routes.mjs).
// Spawns the REAL telemetry-server against the shared team fixture DB
// (seedTeamFixture from team-model.test.mjs) and an isolated Supervisor state
// home (seedRegistryFixture) for the ticket scope's registry children:
//
//   - 200 + contract shape for the three scopes (overall / group by repo /
//     ticket with registry children), with the fixture's exact dev numbers;
//   - the 400s: bad scope, bad period, missing/malformed ticket, malformed
//     filter value;
//   - 503 store-unreadable when the telemetry DB cannot be opened;
//   - Cache-Control: no-store on every answer.
//
// Isolation: mkdtemp fixtures only; spawnTestServer registers the child with
// the runner (sweep on leak); no network beyond 127.0.0.1. FOC-914: the
// Linear-backed group filters read the fake fixture file seam
// (NODE_ENV=test + FENIX_LINEAR_FAKE_FILE) — the same TEST-ONLY seam the Work
// board routes use — so this file never touches the real Linear API even
// where a key exists.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnTestServer } from "./test-spawn.mjs";
import { repoPrefixMap, handleTeamRoute } from "./team-routes.mjs";
import { seedTeamFixture, seedRegistryFixture } from "./team-model.test.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "team-routes-"));
const dbPath = join(dir, "telemetry.sqlite");
seedTeamFixture(dbPath);
const stateHome = join(dir, "supervisor-state");
seedRegistryFixture(stateHome);

// FOC-914: the fake Linear fixture the group filters read through the shared
// work-routes seam. Per-issue facts DISTINCT per ticket so every filter's
// narrowing is data-determined:
//   FOC-100 — milestone M8, label feature,      epic FOC-768, estimate 2
//   FOC-200 — milestone M8, label feature+bug,  epic FOC-768, estimate 2
//   FOC-300 — milestone M9, label bug,          epic FOC-700, estimate 3
const linearFixturePath = join(dir, "linear-fake.json");
const fakeIssue = (identifier, extra) => ({
  identifier,
  title: `T ${identifier}`,
  url: `https://linear.app/jointhubs/issue/${identifier}`,
  description: "fixture",
  state: { name: "In Progress", type: "started" },
  ...extra,
});
writeFileSync(linearFixturePath, JSON.stringify({
  queue: { tasks: [], error: null, fetchedAt: "2026-10-15T12:00:00.000Z" },
  issues: {
    "FOC-100": fakeIssue("FOC-100", { milestone: "M8", labels: ["feature"], parent: "FOC-768", estimate: 2 }),
    "FOC-200": fakeIssue("FOC-200", { milestone: "M8", labels: ["feature", "bug"], parent: "FOC-768", estimate: 2 }),
    "FOC-300": fakeIssue("FOC-300", { milestone: "M9", labels: ["bug"], parent: "FOC-700", estimate: 3 }),
  },
}), "utf8");

const env = {
  ...process.env,
  NODE_ENV: "test",
  FENIX_LINEAR_FAKE_FILE: linearFixturePath,
  LA_TELEMETRY_DB: dbPath,
  LA_TELEMETRY_HOME: join(dir, "telemetry-home"),
  LA_SUPERVISOR_STATE_HOME: stateHome,
  LA_STATE_ROOT: join(dir, "state-root"),
};

const PORT = 7393;
const BASE = `http://127.0.0.1:${PORT}`;

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, headers: res.headers, body };
}

let spawned = null;
let setupError = null;

try {
  spawned = await spawnTestServer({
    script: join(__dir, "telemetry-server.mjs"),
    env,
    port: PORT,
    healthUrl: `${BASE}/api/telemetry/health`,
    label: "team-routes",
  });
} catch (err) {
  setupError = err;
}

// ── scenarios ────────────────────────────────────────────────────────────────

await test("GET /api/team (overall) returns the contract payload with the fixture's numbers", async () => {
  if (setupError) throw setupError;
  const { status, headers, body } = await fetchJson("/api/team");
  assert.equal(status, 200, `status ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(body.groundTruth, "per-message priced usage (FOC-760/761)");
  assert.equal(body.scope, "overall");
  assert.deepEqual(body.squads.map((s) => s.key), ["plan", "dev", "review", "test"]);
  const dev = body.squads.find((s) => s.key === "dev");
  assert.equal(dev.ran, true);
  assert.equal(dev.costUsd, 65);
  assert.equal(dev.picks, 41);
  assert.equal(dev.lead.costShare, 0.0769);
  const debug = dev.roles.find((r) => r.role === "debugger");
  assert.equal(debug.placement, "bench"); // 1/41 < 5 %
  assert.equal(dev.insight, "implementer is 98 % of picks; debugger is 2 % of picks but 31 % of cost");
  assert.deepEqual(dev.links, { prompts: "/prompts?squad=dev", tools: "/settings/agent-tools", models: "/squad-config?squad=dev" });
  // The spawned server resolves leads from the REAL repo config (its own
  // settings overlay/env) — assert the telemetry-derived numbers, and only the
  // presence of the config-derived model names.
  assert.equal(body.supervisor.costUsd, 6);
  assert.equal(typeof body.supervisor.model, "string");
  assert.ok(body.supervisor.model.length > 0);
});

await test("GET /api/team?scope=group&repo=… applies the repo filter and reports unsupported ones", async () => {
  if (setupError) throw setupError;
  // The route derives the repo from the REAL config/projects.json: the FOC
  // prefix maps to linear-agents, so this keeps every fixture run in scope.
  // FOC-914: the fixture file carries per-issue Linear facts, so milestone/
  // type/epic/size are SUPPORTED here (the seam answered) — the unsupported
  // contract moves to the offline scenario below.
  const { status, body } = await fetchJson("/api/team?scope=group&repo=linear-agents");
  assert.equal(status, 200, `status ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  assert.deepEqual(body.filters.applied, { repo: "linear-agents" });
  assert.deepEqual(body.filters.supported, ["repo", "milestone", "type", "epic", "size"]);
  assert.deepEqual(body.filters.unsupported, []);
  assert.equal(body.filters.unsupportedReason, null);
  assert.equal(body.squads.find((s) => s.key === "dev").ran, true);

  // An unknown repo is an honest empty result — applied stays {}, nothing ran.
  const none = await fetchJson("/api/team?scope=group&repo=office");
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.filters.applied, {});
  assert.ok(none.body.squads.every((s) => !s.ran));
});

await test("GET /api/team group: milestone narrows the turns and is reported applied", async () => {
  if (setupError) throw setupError;
  // M8 = FOC-100 + FOC-200 → dev+plan+sup+test runs; review (FOC-300, M9) out.
  const { status, body } = await fetchJson("/api/team?scope=group&milestone=M8");
  assert.equal(status, 200, `status ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  assert.deepEqual(body.filters.applied, { milestone: "M8" });
  assert.equal(body.squads.find((s) => s.key === "review").ran, false);
  assert.equal(body.squads.find((s) => s.key === "dev").ran, true);
  assert.equal(body.squads.find((s) => s.key === "test").ran, true);
  assert.deepEqual(body.totals, { costUsd: 75, sessions: 51, tasks: 2, runs: 4 });

  // An unknown milestone for a supported filter is an honest EMPTY result —
  // the unknown-value rule, not an ignore.
  const none = await fetchJson("/api/team?scope=group&milestone=M99");
  assert.equal(none.status, 200);
  // An empty result records no applied filter (the same convention as the
  // unknown repo case: applied = what actively narrowed a non-empty set).
  assert.deepEqual(none.body.filters.applied, {});
  assert.ok(none.body.squads.every((s) => !s.ran));
});

await test("GET /api/team group: type matches a LABEL NAME (the ticket may carry several)", async () => {
  if (setupError) throw setupError;
  // type=bug → FOC-200 (feature+bug) AND FOC-300 (bug); FOC-100 (feature) out.
  const bug = await fetchJson("/api/team?scope=group&type=bug");
  assert.equal(bug.status, 200);
  assert.deepEqual(bug.body.filters.applied, { type: "bug" });
  assert.equal(bug.body.squads.find((s) => s.key === "dev").ran, false);
  assert.equal(bug.body.squads.find((s) => s.key === "test").ran, true);
  assert.equal(bug.body.squads.find((s) => s.key === "review").ran, true);
  assert.deepEqual(bug.body.totals, { costUsd: 5, sessions: 6, tasks: 2, runs: 2 });

  // Matching is case-insensitive like every string filter.
  const ci = await fetchJson("/api/team?scope=group&type=Feature");
  assert.equal(ci.status, 200);
  assert.deepEqual(ci.body.filters.applied, { type: "Feature" });
  assert.equal(ci.body.squads.find((s) => s.key === "dev").ran, true);
});

await test("GET /api/team group: epic narrows by the parent issue's identifier", async () => {
  if (setupError) throw setupError;
  const epic = await fetchJson("/api/team?scope=group&epic=FOC-700");
  assert.equal(epic.status, 200);
  assert.deepEqual(epic.body.filters.applied, { epic: "FOC-700" });
  assert.equal(epic.body.squads.find((s) => s.key === "review").ran, true);
  assert.equal(epic.body.squads.find((s) => s.key === "dev").ran, false);
  assert.deepEqual(epic.body.totals, { costUsd: 3, sessions: 3, tasks: 1, runs: 1 });

  // An unlinked task (no Linear state) can never match a named epic — the
  // unknown-value rule (the fixture carries no issue for a task id outside
  // the three, and review's FOC-300 does not match FOC-999).
  const none = await fetchJson("/api/team?scope=group&epic=FOC-999");
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.filters.applied, {}); // empty result records nothing
  assert.ok(none.body.squads.every((s) => !s.ran));
});

await test("GET /api/team group: size narrows by the estimate's value", async () => {
  if (setupError) throw setupError;
  const size = await fetchJson("/api/team?scope=group&size=3");
  assert.equal(size.status, 200);
  assert.deepEqual(size.body.filters.applied, { size: "3" });
  assert.equal(size.body.squads.find((s) => s.key === "review").ran, true);
  assert.equal(size.body.squads.find((s) => s.key === "dev").ran, false);
  assert.deepEqual(size.body.totals, { costUsd: 3, sessions: 3, tasks: 1, runs: 1 });
});

await test("GET /api/team group: filters COMBINE (AND) across the four new ones", async () => {
  if (setupError) throw setupError;
  // milestone=M9 & size=3 → only FOC-300 (review).
  const combined = await fetchJson("/api/team?scope=group&milestone=M9&size=3");
  assert.equal(combined.status, 200);
  assert.deepEqual(combined.body.filters.applied, { milestone: "M9", size: "3" });
  assert.deepEqual(combined.body.totals, { costUsd: 3, sessions: 3, tasks: 1, runs: 1 });

  // A contradiction narrows to an honest zero: M9 tasks carry estimate 3, size=2 excludes them.
  // applied keeps what a passing turn recorded BEFORE the rejecting filter —
  // milestone rode the FOC-300 turn, size rejected it → only milestone shows.
  const contra = await fetchJson("/api/team?scope=group&milestone=M9&size=2");
  assert.equal(contra.status, 200);
  assert.deepEqual(contra.body.filters.applied, { milestone: "M9" });
  assert.ok(contra.body.squads.every((s) => !s.ran));
});

await test("GET /api/team?scope=ticket&ticket=… serves the registry children", async () => {
  if (setupError) throw setupError;
  const { status, body } = await fetchJson("/api/team?scope=ticket&ticket=FOC-200");
  assert.equal(status, 200, `status ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  assert.deepEqual(body.ticket, { id: "FOC-200", runs: ["run-test-1"] });
  const testSquad = body.squads.find((s) => s.key === "test");
  assert.deepEqual(testSquad.children, [{ childId: "test-1", status: "exited", runId: "run-test-1" }]);
  const roles = testSquad.roles;
  assert.ok(roles.every((r) => "overallPickShare" in r || r.role === "lead"), "ticket scope quotes overallPickShare");
});

await test("400 bad-request on a bad scope/period/ticket/filter", async () => {
  if (setupError) throw setupError;
  for (const [path, fragment] of [
    ["/api/team?scope=bogus", "scope"],
    ["/api/team?period=2w", "period"],
    ["/api/team?scope=ticket", "ticket"], // missing
    ["/api/team?scope=ticket&ticket=foc-1", "ticket"], // malformed
    ["/api/team?repo=<script>", "repo"],
  ]) {
    const { status, body } = await fetchJson(path);
    assert.equal(status, 400, `${path} → status ${status}`);
    assert.equal(body.error, "bad-request", `${path} → ${JSON.stringify(body)}`);
    assert.ok(String(body.reason).includes(fragment), `${path} reason should name ${fragment}: ${body.reason}`);
  }
});

await test("503 store-unreadable when the telemetry DB cannot be opened", async () => {
  if (setupError) throw setupError;
  // In-process, on the handler itself: the server bootstraps (and creates) its
  // store at boot, so a missing path cannot stay missing inside a spawned
  // child — the handler opens the store per request and must report the
  // unreadable one instead of serving an empty payload.
  const prev = process.env.LA_TELEMETRY_DB;
  process.env.LA_TELEMETRY_DB = join(dir, "missing", "nope.sqlite");
  try {
    const res = {};
    const handled = await handleTeamRoute(
      { method: "GET", headers: {} },
      res,
      new URL("/api/team", "http://127.0.0.1"),
      { json: (_r, status, payload) => { res.__status = status; res.__body = payload; }, log: () => {} },
    );
    assert.equal(handled, true);
    assert.equal(res.__status, 503, `status ${res.__status}: ${JSON.stringify(res.__body)}`);
    assert.equal(res.__body.error, "store-unreadable");
  } finally {
    if (prev === undefined) delete process.env.LA_TELEMETRY_DB;
    else process.env.LA_TELEMETRY_DB = prev;
  }
});

await test("repoPrefixMap derives the repo from config/projects.json notes", () => {
  const file = join(dir, "projects.json");
  writeFileSync(file, JSON.stringify({
    projects: [
      { linearProject: "FENIX", repo: "${GITHUB_ROOT}/linear-agents", note: "team FOC (e.g. FOC-104)" },
      { linearProject: "Neo", repo: "${GITHUB_ROOT}/joint-flows", note: "no prefix mentioned" },
    ],
  }), "utf8");
  const map = repoPrefixMap(file);
  assert.equal(map.FOC, "linear-agents");
  assert.equal(map.NEO, undefined);
});

await test("group scope offline: Linear filters stay unsupported with the reason, and passed values are NOT applied", async () => {
  // In-process on the handler with a FAILED states lookup — the seam answered
  // "Linear unavailable" (no key / offline), so the four filters must stay
  // under unsupported WITH the reason, and a caller-passed milestone must
  // narrow nothing (never a guess from half-known facts).
  if (setupError) throw setupError;
  const res = {};
  const handled = await handleTeamRoute(
    { method: "GET", headers: {} },
    res,
    new URL("/api/team?scope=group&milestone=M8", "http://127.0.0.1"),
    {
      json: (_r, status, payload) => { res.__status = status; res.__body = payload; },
      log: () => {},
      loadTurns: () => [],
      loadLinks: () => [],
      squadConfig: { squads: {} },
      ticketFacts: [
        { taskId: "FOC-100", repo: "linear-agents" },
        { taskId: "FOC-200", repo: "linear-agents" },
      ],
      linearStatesFor: async () => ({ states: {}, meta: { ok: false, error: "LINEAR_API_KEY not set (check .env)", fetchedAt: null } }),
    },
  );
  assert.equal(handled, true);
  assert.equal(res.__status, 200, `status ${res.__status}: ${JSON.stringify(res.__body).slice(0, 300)}`);
  assert.deepEqual(res.__body.filters.supported, ["repo"]); // the injected facts carry repo
  assert.deepEqual(res.__body.filters.unsupported, ["milestone", "type", "epic", "size"]);
  assert.match(res.__body.filters.unsupportedReason, /Linear unavailable: LINEAR_API_KEY not set/);
  assert.deepEqual(res.__body.filters.applied, {}); // milestone was NOT applied
  assert.ok(res.__body.squads.every((s) => !s.ran)); // no turns injected anyway
});

await test("group scope with no filter values: supported still reflects the warm lookup", async () => {
  // filters.supported must be honest BEFORE the user fills an input (the
  // ticket's "supported reflects what the installation can really answer") —
  // the group scope asks the lookup even with an empty filter set.
  if (setupError) throw setupError;
  const res = {};
  const handled = await handleTeamRoute(
    { method: "GET", headers: {} },
    res,
    new URL("/api/team?scope=group", "http://127.0.0.1"),
    {
      json: (_r, status, payload) => { res.__status = status; res.__body = payload; },
      log: () => {},
      loadTurns: () => [],
      loadLinks: () => [],
      squadConfig: { squads: {} },
      ticketFacts: [{ taskId: "FOC-100", repo: "linear-agents" }],
      linearStatesFor: async () => ({
        states: { "FOC-100": { milestone: "M8", labels: [{ id: "l", name: "feature", color: null }], parent: "FOC-768", estimate: 2 } },
        meta: { ok: true, error: null, fetchedAt: "2026-10-15T12:00:00.000Z" },
      }),
    },
  );
  assert.equal(handled, true);
  assert.equal(res.__status, 200);
  assert.deepEqual(res.__body.filters.supported, ["repo", "milestone", "type", "epic", "size"]);
  assert.deepEqual(res.__body.filters.unsupported, []);
  assert.equal(res.__body.filters.unsupportedReason, null);
});

// ── teardown ─────────────────────────────────────────────────────────────────

if (spawned) await spawned.stop();
try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ }

console.log(`\nteam-routes: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
