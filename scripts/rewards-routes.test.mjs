// Route-level tests for the rewards endpoints (FOC-225 slice 3).
//
// Spawns the REAL telemetry-server on port 7391 with fully isolated stores
// (LA_TELEMETRY_DB / LA_REWARDS_DB / LA_REWARDS_HOME under a tmp dir), so
// production 7331/5173 and the fixture stack are never touched. The ingest
// half of GET /api/manager/rewards is proven by reward-ingest.test.mjs; here
// we prove the HTTP contract:
//   - GET returns the server-facts payload (rules constants, squads, ratings,
//     held, ingest diagnostics) and surfaces pre-seeded ledger rows;
//   - there is NO XP submission endpoint: POST /api/manager/rewards → 405;
//   - ratings POST: local-origin discipline (403 on a foreign Origin), 400
//     with a message on invalid squad/rating/note/JSON, 413 on an over-limit
//     body, 201 + roundtrip on the happy path.
//
// The port MUST be free when this runs — the fixture backend keeps 7391, so
// stop it first (or the file skips itself).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readSquadConfig } from "./squad-config.mjs";
import { openRewardsDb, insertAward, XP_RULES } from "./reward-ledger.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = 7391;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
let skipped = 0;

class TestSkip extends Error {}

const testQueue = [];
function test(name, fn) {
  testQueue.push({ name, fn });
}

// ── setup: port probe + server spawn + tmp stores ────────────────────────────

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

const dir = mkdtempSync(join(tmpdir(), "rewards-routes-"));
const env = {
  ...process.env,
  TELEMETRY_PORT: String(PORT),
  LA_TELEMETRY_DB: join(dir, "telemetry.sqlite"),
  LA_REWARDS_DB: join(dir, "rewards.sqlite"),
  LA_REWARDS_HOME: join(dir, "rewards-home"),
};

// Pre-seed the isolated ledger with a squad no real evidence can produce, so
// the GET assertion stays deterministic regardless of what the ingest finds
// while scanning the repo's own supervisor artifacts.
const seeded = openRewardsDb(env.LA_REWARDS_DB);
insertAward(seeded, {
  subject: "route-proof-squad",
  taskId: "ROUTE-1",
  repo: "c:/repos/route-test",
  revision: "unknown",
  runId: "route-run-1",
  evidenceId: "supervisor/route-run-1/verdicts/route-1-round1.json",
});
seeded.close();

const child = spawn(process.execPath, [join(__dir, "telemetry-server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let childStderr = "";
child.stderr.on("data", (chunk) => { childStderr += chunk; });

async function fetchJson(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function waitForServer(ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}): ${childStderr.slice(-400)}`);
    try {
      const res = await fetch(`${BASE}/api/telemetry/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server not ready in ${ms}ms: ${childStderr.slice(-400)}`);
}

async function teardown() {
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

let setupError = null;
const squads = (() => {
  try { return Object.keys(readSquadConfig().squads || {}); } catch { return []; }
})();
const validSquad = squads[0] ?? null;

try {
  if (await portBusy(PORT)) {
    throw new TestSkip(`port ${PORT} is busy — stop the fixture backend first`);
  }
  await waitForServer();
} catch (err) {
  if (err instanceof TestSkip) setupError = err;
  else setupError = err;
}

// ── scenarios ────────────────────────────────────────────────────────────────

test("GET /api/manager/rewards returns the server-facts payload", async () => {
  if (setupError) throw setupError;
  const { status, body } = await fetchJson("/api/manager/rewards");
  assert.equal(status, 200, `status ${status}: ${JSON.stringify(body)}`);
  assert.deepEqual(body.rules, { ...XP_RULES }, "rules constants must pass through with their version");
  assert.equal(typeof body.squads, "object" && body.squads !== null ? "object" : "other", "squads map expected");
  assert.ok(Array.isArray(body.ratings), "ratings array expected");
  assert.ok(Array.isArray(body.held), "held array expected");
  assert.ok(body.ingest && Array.isArray(body.ingest.missing), "ingest diagnostics with missing[] expected");
  assert.ok(body.generatedAt && !Number.isNaN(Date.parse(body.generatedAt)), "generatedAt must be an ISO timestamp");
  // the pre-seeded ledger row must surface verbatim
  const proof = body.squads["route-proof-squad"];
  assert.ok(proof, `seeded squad missing: ${Object.keys(body.squads)}`);
  assert.equal(proof.xp, 100, `seeded xp wrong: ${proof.xp}`);
  assert.equal(proof.recent[0].taskId, "ROUTE-1", "seeded record must surface");
});

test("AC 2: there is no XP submission endpoint (POST /api/manager/rewards → 405)", async () => {
  if (setupError) throw setupError;
  const { status, body } = await fetchJson("/api/manager/rewards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "dev", points: 1000 }),
  });
  assert.equal(status, 405, `a POST to /rewards must never be accepted: ${status}`);
  assert.ok(body.error, "405 must carry a message");
  // and no adjacent XP path exists either
  const adjacent = await fetchJson("/api/manager/rewards/award", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "dev", points: 1000 }),
  });
  assert.equal(adjacent.status, 404, `adjacent XP path must not exist: ${adjacent.status}`);
});

test("ratings POST: 201 on the happy path, then the rating roundtrips through GET", async () => {
  if (setupError) throw setupError;
  if (!validSquad) throw new TestSkip("no configured squads to rate against");
  const before = (await fetchJson("/api/manager/rewards")).body.squads[validSquad]?.xp ?? 0;
  const { status, body } = await fetchJson("/api/manager/ratings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: validSquad, taskId: "ROUTE-2", runId: "route-run-2", rating: 4, note: "solid route test" }),
  });
  assert.equal(status, 201, `status ${status}: ${JSON.stringify(body)}`);
  assert.ok(body.ok && Number.isInteger(body.id), `201 body must carry the record id: ${JSON.stringify(body)}`);
  const after = (await fetchJson("/api/manager/rewards")).body;
  const rating = after.ratings.find((r) => r.taskId === "ROUTE-2");
  assert.ok(rating, `rating must roundtrip: ${JSON.stringify(after.ratings)}`);
  assert.equal(rating.rating, 4, "rating value must roundtrip");
  assert.equal(rating.note, "solid route test", "note must roundtrip as text");
  assert.equal(after.squads[validSquad]?.xp ?? 0, before, "a rating must never change XP");
});

test("ratings POST: invalid squad / rating / note / body → 400 with a message", async () => {
  if (setupError) throw setupError;
  const cases = [
    ["unknown squad", { subject: "not-a-squad", taskId: "ROUTE-3", rating: 3 }, /unknown squad/],
    ["missing subject", { taskId: "ROUTE-3", rating: 3 }, /subject/],
    ["rating out of range", { subject: validSquad ?? "dev", taskId: "ROUTE-3", rating: 6 }, /1\.\.5/],
    ["rating non-integer", { subject: validSquad ?? "dev", taskId: "ROUTE-3", rating: 4.5 }, /1\.\.5/],
    ["rating as string", { subject: validSquad ?? "dev", taskId: "ROUTE-3", rating: "3" }, /1\.\.5/],
    ["rating as array", { subject: validSquad ?? "dev", taskId: "ROUTE-3", rating: [3] }, /1\.\.5/],
    ["rating null", { subject: validSquad ?? "dev", taskId: "ROUTE-3", rating: null }, /1\.\.5/],
    ["note too long", { subject: validSquad ?? "dev", taskId: "ROUTE-3", rating: 3, note: "x".repeat(501) }, /500/],
    ["bad taskId", { subject: validSquad ?? "dev", taskId: "bad task id!", rating: 3 }, /taskId/],
  ];
  for (const [label, payload, match] of cases) {
    const { status, body } = await fetchJson("/api/manager/ratings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(status, 400, `${label} must 400, got ${status}`);
    assert.match(String(body?.error), match, `${label} message must be honest: ${JSON.stringify(body)}`);
  }
  const raw = await fetch(`${BASE}/api/manager/ratings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(raw.status, 400, "invalid JSON must 400");
});

test("ratings POST: an over-limit body is 413, not 400", async () => {
  if (setupError) throw setupError;
  // the 8 KB default body cap: a note far past it must surface the same
  // status the server's other body-limit handlers emit
  const { status, body } = await fetchJson("/api/manager/ratings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: validSquad ?? "dev", taskId: "ROUTE-5", rating: 3, note: "x".repeat(9000) }),
  });
  assert.equal(status, 413, `over-limit body must 413, got ${status}: ${JSON.stringify(body)}`);
  assert.match(String(body?.error), /too large/i);
});

test("ratings POST: foreign origin is rejected, GET only is enforced", async () => {
  if (setupError) throw setupError;
  const foreign = await fetchJson("/api/manager/ratings", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ subject: validSquad ?? "dev", taskId: "ROUTE-4", rating: 5 }),
  });
  assert.equal(foreign.status, 403, `foreign origin must 403: ${foreign.status}`);
  const wrongMethod = await fetchJson("/api/manager/ratings");
  assert.equal(wrongMethod.status, 405, "GET on the ratings route must 405");
});

// ── teardown + runner ────────────────────────────────────────────────────────

for (const { name, fn } of testQueue) {
  try {
    await fn();
    passed++;
    console.log(`√ ${name}`);
  } catch (err) {
    if (err instanceof TestSkip) {
      skipped++;
      console.log(`- ${name} — ${err.message}`);
    } else {
      failed++;
      console.log(`× ${name}`);
      console.log(`  ${err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n  ") : err}`);
    }
  }
}

await teardown();

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
if (setupError instanceof TestSkip && testQueue.every((t) => true) && failed === 0 && passed === 0) {
  console.log(`(all skipped: ${setupError.message})`);
}
process.exit(failed > 0 ? 1 : 0);
