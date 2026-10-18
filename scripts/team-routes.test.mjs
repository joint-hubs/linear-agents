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
// the runner (sweep on leak); no network beyond 127.0.0.1.

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

const env = {
  ...process.env,
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
  const { status, body } = await fetchJson("/api/team?scope=group&repo=linear-agents&epic=FOC-768");
  assert.equal(status, 200, `status ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  assert.deepEqual(body.filters.applied, { repo: "linear-agents" });
  assert.ok(body.filters.unsupported.includes("epic"), "epic must be listed unsupported");
  assert.equal(body.squads.find((s) => s.key === "dev").ran, true);

  // An unknown repo is an honest empty result — applied stays {}, nothing ran.
  const none = await fetchJson("/api/team?scope=group&repo=office");
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.filters.applied, {});
  assert.ok(none.body.squads.every((s) => !s.ran));
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

// ── teardown ─────────────────────────────────────────────────────────────────

if (spawned) await spawned.stop();
try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ }

console.log(`\nteam-routes: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
