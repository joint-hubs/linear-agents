// Tests for the manager rating validator (FOC-225 slice 3, review round 5).
//
// validateRating was extracted from telemetry-server.mjs so its rejection
// contract is testable without starting the HTTP server:
//   - the squad allowlist FAILS CLOSED: an unreadable squad config denies the
//     write (503) instead of awarding authoring rights to an unvalidated squad;
//   - the rating value is validated STRICTLY — a number, an integer, 1..5 —
//     so "3", [3] or 4.5 cannot slip through a Number() coercion;
//   - the bounded schema holds: subject required, note ≤ 500 chars, taskId and
//     runId must look like identifiers; success returns the insert shape.

import assert from "node:assert/strict";

import { validateRating } from "./manager-ratings.mjs";

let passed = 0;
let failed = 0;

const testQueue = [];
function test(name, fn) {
  testQueue.push({ name, fn });
}

const GOOD = { subject: "dev", taskId: "FOC-225", runId: "run-1", rating: 4, note: "solid" };

test("happy path: a valid rating returns the insert shape with normalized keys", () => {
  const v = validateRating({ ...GOOD, subject: " DEV " });
  assert.ok(!v.error, `must accept: ${JSON.stringify(v)}`);
  assert.deepEqual(v.rating, { subject: "dev", taskId: "FOC-225", runId: "run-1", rating: 4, note: "solid" });
});

test("fail closed: an unreadable squad config denies the rating instead of failing open", () => {
  const broken = () => {
    throw new Error("config store unreadable");
  };
  const v = validateRating({ ...GOOD }, { squadConfig: broken });
  assert.equal(v.status, 503, `must deny with 503, got ${JSON.stringify(v)}`);
  assert.match(v.error, /squad configuration unavailable/);
  // never a partial pass: even a perfectly-shaped body is rejected
  assert.ok(!v.rating, "no rating object may be returned when the allowlist is unavailable");
});

test("unknown squad: rejected with the honest message", () => {
  const v = validateRating({ ...GOOD, subject: "not-a-squad" }, {
    squadConfig: () => ({ squads: { dev: {} } }),
  });
  assert.equal(v.status, 400);
  assert.match(v.error, /unknown squad: not-a-squad/);
});

test("rating value is validated strictly — a number, an integer, 1..5", () => {
  const cases = [
    ["string '3'", "3"],
    ["array [3]", [3]],
    ["null", null],
    ["undefined", undefined],
    ["float 4.5", 4.5],
    ["zero", 0],
    ["six", 6],
    ["NaN", Number.NaN],
  ];
  for (const [label, value] of cases) {
    const v = validateRating({ ...GOOD, rating: value }, {
      squadConfig: () => ({ squads: { dev: {} } }),
    });
    assert.equal(v.status, 400, `${label} must 400, got ${JSON.stringify(v)}`);
    assert.match(v.error, /1\.\.5/, `${label} message must name the range`);
  }
});

test("bounded schema: subject required, note ≤ 500, taskId/runId shaped", () => {
  const cfg = { squadConfig: () => ({ squads: { dev: {} } }) };
  const rejections = [
    ["missing subject", { taskId: "FOC-225", rating: 3 }, /subject/],
    ["note too long", { ...GOOD, note: "x".repeat(501) }, /500/],
    ["bad taskId", { ...GOOD, taskId: "bad task id!" }, /taskId/],
    ["bad runId", { ...GOOD, runId: "bad run id!" }, /runId/],
  ];
  for (const [label, body, match] of rejections) {
    const v = validateRating(body, cfg);
    assert.equal(v.status, 400, `${label} must 400, got ${JSON.stringify(v)}`);
    assert.match(v.error, match, `${label} message must be honest`);
  }
});

// ── runner ───────────────────────────────────────────────────────────────────

for (const { name, fn } of testQueue) {
  try {
    await fn();
    passed++;
    console.log(`√ ${name}`);
  } catch (err) {
    failed++;
    console.log(`× ${name}`);
    console.log(`  ${err && err.stack ? err.stack.split("\n").slice(0, 4).join("\n  ") : err}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
