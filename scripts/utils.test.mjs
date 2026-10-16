// scripts/utils.test.mjs — FOC-600: atomicWriteJSON survives transient
// Windows EPERM/EACCES on rename. FOC-903: the per-run scratch layer —
// reviewRound/resetReviewRounds per-run counters, scratchDir, collectRunScratch.
//
// On Windows, renameSync over an existing destination fails transiently with
// EPERM/EACCES while another process (AV scan, indexer, parallel run) holds
// the file open. These tests pin the retry contract: only those two codes
// retry (bounded, capped deterministic backoff), exhaustion cleans the tmp
// file up and rethrows with path + attempt count, non-transient codes fail
// immediately and unchanged, and the default path round-trips byte-identical.
// The rename/sleep seams are injected — nothing here touches the real
// `.state/` stores, telemetry or the network, and every temp dir is cleaned.
//
// Run: node scripts/utils.test.mjs

import { readFileSync, writeFileSync, rmSync, mkdtempSync, readdirSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteJSON, collectRunScratch, resetReviewRounds, reviewRound, RUN_ID_RE, scratchDir,
} from "./utils.mjs";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + err.message);
  }
}

const fail = (msg) => { throw new Error(msg); };
const eq = (a, b, label) => { if (a !== b) fail(`${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const deepEq = (a, b, label) => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) fail(`${label}: ${sa} !== ${sb}`);
};

// A realistic rename-shaped fs error (code is what the retry policy reads).
const fsError = (code, syscall = "rename") =>
  Object.assign(new Error(`${code}: operation not permitted, ${syscall}`), { code, errno: -40, syscall });

// Tracked temp dirs — swept at the end, nothing left behind anywhere.
const dirs = [];
const tmpDir = (tag) => {
  const d = mkdtempSync(join(tmpdir(), tag));
  dirs.push(d);
  return d;
};
// Every test must leave its temp dir holding exactly the one destination file.
const onlyFile = (dir, name) => eq(readdirSync(dir).sort().join(","), name, `exactly one file in ${dir}`);

console.log("\nutils: atomicWriteJSON retry on transient EPERM/EACCES (injected rename)");

test("retries a transient EPERM N-1 times, then lands the write with no tmp residue", () => {
  const dir = tmpDir("utils-test-perm-");
  const dest = join(dir, "target.json");
  writeFileSync(dest, '{"old":true}\n', "utf8");
  const sleeps = [];
  let attempts = 0;
  // Fail EPERM on the first 4 attempts, then perform the REAL rename so the
  // write actually lands and the residue check is honest.
  atomicWriteJSON(dest, { answer: 42 }, {
    rename: (tmp, destPath) => {
      attempts++;
      if (attempts < 5) throw fsError("EPERM");
      renameSync(tmp, destPath);
    },
    sleep: (ms) => sleeps.push(ms),
  });
  eq(attempts, 5, "attempts until success");
  eq(readFileSync(dest, "utf8"), JSON.stringify({ answer: 42 }, null, 2) + "\n", "destination has the new JSON");
  deepEq(sleeps, [25, 50, 100, 100], "capped deterministic backoff");
  onlyFile(dir, "target.json");
});

test("retries EACCES the same way (both transient codes are covered)", () => {
  const dir = tmpDir("utils-test-eacces-");
  const dest = join(dir, "target.json");
  let attempts = 0;
  atomicWriteJSON(dest, { e: "acces" }, {
    rename: (tmp, destPath) => {
      attempts++;
      if (attempts === 1) throw fsError("EACCES");
      renameSync(tmp, destPath);
    },
    sleep: () => {},
  });
  eq(attempts, 2, "one retry, then success");
  onlyFile(dir, "target.json");
});

test("exhausted retries: clean tmp, path + attempt count in the message, destination untouched", () => {
  const dir = tmpDir("utils-test-exhaust-");
  const dest = join(dir, "target.json");
  writeFileSync(dest, '{"old":true}\n', "utf8");
  const sleeps = [];
  let attempts = 0;
  let thrown = null;
  try {
    atomicWriteJSON(dest, { never: "lands" }, {
      rename: () => { attempts++; throw fsError("EPERM"); },
      sleep: (ms) => sleeps.push(ms),
    });
  } catch (err) {
    thrown = err;
  }
  eq(attempts, 5, "exactly 5 attempts, no more");
  deepEq(sleeps, [25, 50, 100, 100], "4 backoffs between 5 attempts");
  if (!thrown) fail("must throw once retries are exhausted");
  if (!thrown.message.includes(dest)) fail(`error message must carry the destination path: ${thrown.message}`);
  if (!thrown.message.includes("5 attempts")) fail(`error message must carry the attempt count: ${thrown.message}`);
  eq(thrown.code, "EPERM", "original code preserved");
  eq(readFileSync(dest, "utf8"), '{"old":true}\n', "destination untouched (old content)");
  onlyFile(dir, "target.json");
});

console.log("\nutils: atomicWriteJSON non-transient errors fail fast and unchanged");

test("ENOENT fails on the first attempt: no retry, no sleep, message unmutated", () => {
  const dir = tmpDir("utils-test-enoent-");
  const dest = join(dir, "target.json");
  let attempts = 0;
  let sleeps = 0;
  let thrown = null;
  try {
    atomicWriteJSON(dest, { x: 1 }, {
      rename: () => { attempts++; throw fsError("ENOENT"); },
      sleep: () => { sleeps++; },
    });
  } catch (err) {
    thrown = err;
  }
  eq(attempts, 1, "exactly one rename attempt");
  eq(sleeps, 0, "no backoff sleeps");
  if (!thrown) fail("must throw");
  eq(thrown.code, "ENOENT", "code preserved");
  if (thrown.message.includes("atomicWriteJSON:")) fail(`non-transient error must stay unmutated: ${thrown.message}`);
});

console.log("\nutils: atomicWriteJSON default path (no options) is unchanged");

test("plain success round-trips the exact JSON formatting", () => {
  const dir = tmpDir("utils-test-default-");
  const dest = join(dir, "target.json");
  const data = { nested: { b: 2, a: 1 }, list: [1, 2, 3] };
  atomicWriteJSON(dest, data);
  eq(readFileSync(dest, "utf8"), JSON.stringify(data, null, 2) + "\n", "byte-identical formatting");
  onlyFile(dir, "target.json");
});

// ── FOC-903: per-run scratch ──────────────────────────────────────────────────
// utils.mjs reads the seams at CALL time, so pointing them at temp dirs here
// is enough — no import-order trap. The env keys are set once and never
// deleted (restoring a previously-unset key is what forces the serial lane).

const STATE_HOME = mkdtempSync(join(tmpdir(), "utils-test-sup-home-"));
const STATE_ROOT = mkdtempSync(join(tmpdir(), "utils-test-state-root-"));
dirs.push(STATE_HOME, STATE_ROOT);
process.env.LA_SUPERVISOR_STATE_HOME = STATE_HOME;
process.env.LA_STATE_ROOT = STATE_ROOT;

const RUN_A = "2026-09-01T10-00-00-000-supervisor-aaaa";
const RUN_B = "2026-09-02T10-00-00-000-supervisor-bbbb";
const runFile = (runId) => join(STATE_HOME, runId, "review-rounds.json");
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));

console.log("\nutils: reviewRound per-run counters (FOC-903)");

test("reviewRound with an explicit runId writes <runDir>/review-rounds.json, not the legacy file", () => {
  const r1 = reviewRound({ taskId: "FOC-1", runId: RUN_A });
  const r2 = reviewRound({ taskId: "FOC-1", runId: RUN_A });
  deepEq(r1, { round: 1, status: "review" }, "first increment");
  deepEq(r2, { round: 2, status: "review" }, "second increment");
  deepEq(readJSON(runFile(RUN_A)), { "FOC-1": 2 }, "per-run counter file");
  eq(existsSync(join(STATE_ROOT, "review-rounds.json")), false, "legacy file not created");
});

test("without a run id the legacy global .state file is used, exactly as before", () => {
  deepEq(reviewRound({ taskId: "FOC-2" }), { round: 1, status: "review" }, "legacy increment");
  deepEq(readJSON(join(STATE_ROOT, "review-rounds.json")), { "FOC-2": 1 }, "legacy counter file");
});

test("LA_SUPERVISOR_RUN is the fallback source; an empty value means no run", () => {
  process.env.LA_SUPERVISOR_RUN = RUN_B;
  deepEq(reviewRound({ taskId: "FOC-3" }), { round: 1, status: "review" }, "env-resolved run");
  deepEq(readJSON(runFile(RUN_B)), { "FOC-3": 1 }, "counter landed in the env's run dir");
  process.env.LA_SUPERVISOR_RUN = "";
  deepEq(reviewRound({ taskId: "FOC-2" }), { round: 2, status: "review" }, "empty env → legacy again");
  deepEq(readJSON(join(STATE_ROOT, "review-rounds.json")), { "FOC-2": 2 }, "legacy file advanced");
  delete process.env.LA_SUPERVISOR_RUN;
});

test("an invalid run id throws instead of silently falling back to the shared file", () => {
  let thrown = null;
  try {
    reviewRound({ taskId: "FOC-1", runId: "test-123-456-789" });
  } catch (err) {
    thrown = err;
  }
  if (!thrown || !String(thrown.message).includes("invalid supervisor run id")) {
    fail(`expected an invalid-run-id throw, got: ${thrown}`);
  }
});

test("two runs incrementing the same task never share a file", () => {
  deepEq(reviewRound({ taskId: "FOC-4", runId: RUN_A }), { round: 1, status: "review" }, "run A");
  deepEq(reviewRound({ taskId: "FOC-4", runId: RUN_B }), { round: 1, status: "review" }, "run B");
  deepEq(readJSON(runFile(RUN_A))["FOC-4"], 1, "run A saw only its own increment");
  deepEq(readJSON(runFile(RUN_B))["FOC-4"], 1, "run B saw only its own increment");
});

test("resetReviewRounds clears only the addressed run's counter", () => {
  resetReviewRounds({ runId: RUN_A });
  deepEq(readJSON(runFile(RUN_A)), {}, "run A cleared");
  deepEq(readJSON(runFile(RUN_B))["FOC-4"], 1, "run B untouched");
  deepEq(readJSON(join(STATE_ROOT, "review-rounds.json"))["FOC-2"], 2, "legacy untouched");
});

test("escalation still fires past maxRounds, per run", () => {
  deepEq(reviewRound({ taskId: "FOC-5", runId: RUN_A, maxRounds: 1 }), { round: 1, status: "review" }, "at the limit");
  deepEq(reviewRound({ taskId: "FOC-5", runId: RUN_A, maxRounds: 1 }), { round: 2, status: "escalated" }, "past the limit");
  deepEq(reviewRound({ taskId: "FOC-5", runId: RUN_A, maxRounds: 1 }), { round: 2, status: "escalated" }, "no further increment");
});

console.log("\nutils: scratchDir");

test("scratchDir creates <runDir>/scratch/<kind> on demand and returns it", () => {
  const dir = scratchDir(RUN_A, "krok0");
  eq(dir, join(STATE_HOME, RUN_A, "scratch", "krok0"), "path shape");
  eq(existsSync(dir), true, "created on demand");
  eq(scratchDir(RUN_A, "reviews"), join(STATE_HOME, RUN_A, "scratch", "reviews"), "second kind, same run");
});

test("scratchDir rejects a missing run id and a path-bearing kind", () => {
  let thrown = null;
  try { scratchDir(undefined, "reviews"); } catch (err) { thrown = err; }
  if (!thrown || !String(thrown.message).includes("run id is required")) fail(`expected a run-id throw: ${thrown}`);
  thrown = null;
  try { scratchDir(RUN_A, "../evil"); } catch (err) { thrown = err; }
  if (!thrown || !String(thrown.message).includes("invalid scratch kind")) fail(`expected a kind throw: ${thrown}`);
});

console.log("\nutils: collectRunScratch");

test("collectRunScratch unions every run's inputs, the newest run winning per task", () => {
  const home = mkdtempSync(join(tmpdir(), "utils-test-collect-"));
  dirs.push(home);
  // Newest run first in fact; the scan must pick it per task.
  mkdirSync(join(home, RUN_B, "scratch", "reviews"), { recursive: true });
  writeFileSync(join(home, RUN_B, "review-rounds.json"), JSON.stringify({ "FOC-1": 7, "FOC-7": 1 }));
  writeFileSync(join(home, RUN_B, "scratch", "reviews", "FOC-1-round2.md"), "newest\n");
  mkdirSync(join(home, RUN_A, "scratch", "reviews"), { recursive: true });
  writeFileSync(join(home, RUN_A, "review-rounds.json"), JSON.stringify({ "FOC-1": 2 }));
  writeFileSync(join(home, RUN_A, "scratch", "reviews", "FOC-1-round1.md"), "older\n");
  writeFileSync(join(home, RUN_A, "scratch", "reviews", "FOC-1-round2.md"), "older r2\n");
  // Noise that must never be read as a run: a fixture dir and a stray file.
  mkdirSync(join(home, "test-123-456-789"), { recursive: true });
  writeFileSync(join(home, "test-123-456-789", "review-rounds.json"), JSON.stringify({ "FOC-1": 99 }));
  writeFileSync(join(home, "not-a-run"), "x");

  const { rounds, reviews } = collectRunScratch({ stateHome: home });
  deepEq(rounds.get("FOC-1"), { round: 7, runId: RUN_B }, "newest run wins the counter");
  deepEq(rounds.get("FOC-7"), { round: 1, runId: RUN_B }, "task only the newest run knows");
  deepEq(
    reviews.filter((r) => r.taskId === "FOC-1" && r.round === 2),
    [{ taskId: "FOC-1", round: 2, file: join(home, RUN_B, "scratch", "reviews", "FOC-1-round2.md"), runId: RUN_B }],
    "newest run wins the (task, round) cell",
  );
  eq(
    reviews.some((r) => r.taskId === "FOC-1" && r.round === 1),
    true,
    "older run's unique round survives",
  );
  eq(reviews.every((r) => r.runId !== undefined && RUN_ID_RE.test(r.runId)), true, "every review carries a run id");
});

test("collectRunScratch on a missing state home is empty, not a throw", () => {
  const { rounds, reviews } = collectRunScratch({ stateHome: join(STATE_HOME, "definitely-missing") });
  eq(rounds.size, 0, "no rounds");
  eq(reviews.length, 0, "no reviews");
});

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\nutils: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
