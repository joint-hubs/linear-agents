// scripts/supervisor-gate-answer.test.mjs — FOC-783: the answer rules, shared
// by the CLI and the dashboard API.
//
// The dashboard answers gates and holds with EXACTLY the Supervisor CLI's
// rules, so the rules live in supervisor-gate.mjs's exported answerGate /
// answerHold and the CLI calls them. What is worth failing a build over:
//
// 1. THE RULES ARE ONE SET. answerGate/answerHold enforce every rule the CLI
//    enforced — answered once, cleanup-approval's single yes/no token, ids
//    that cannot leave the run dir — with the same refusal messages, so a
//    dashboard answer cannot drift from a CLI answer.
// 2. answeredBy APPEARS ONLY WHEN GIVEN. The CLI passes nothing, so its
//    records keep their exact historical shape; the dashboard names who
//    answered.
// 3. THE CLI IS UNCHANGED. Its stdout, refusals and record shapes are the
//    pre-refactor ones — asserted against fixtures, not against the refactor.
//
// Isolation: LA_SUPERVISOR_STATE_HOME is pointed at a mkdtemp dir BEFORE the
// imports; gate records are seeded directly (the emit path has its own suite).
//
// Run: node scripts/supervisor-gate-answer.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(ROOT, "scripts", "supervisor-gate.mjs");

// The seam FIRST — supervisor-lib resolves every run dir through it.
process.env.LA_SUPERVISOR_STATE_HOME = mkdtempSync(join(tmpdir(), "la-gate-answer-"));

const { answerGate, answerHold } = await import("./supervisor-gate.mjs");
const {
  AFFIRMATIVE,
  HOLDS_SCHEMA_VERSION,
  NEGATIVE,
  gatePath,
  holdsPath,
  readHolds,
  runDir,
} = await import("./supervisor-lib.mjs");

const HOME = process.env.LA_SUPERVISOR_STATE_HOME;

let passed = 0;
const failures = [];
const asyncTests = [];

function test(name, fn) {
  try {
    const r = fn();
    // An async test resolves out of band — collected and awaited before the
    // summary, so a rejection still fails the run.
    if (r && typeof r.then === "function") {
      asyncTests.push(
        r.then(
          () => { passed++; console.log(`  PASS ${name}`); },
          (err) => { failures.push(name); console.log(`  FAIL ${name}\n       ${err.message}`); },
        ),
      );
      return;
    }
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const fail = (msg) => { throw new Error(msg); };

const cleanup = [];
process.on("exit", () => {
  for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

let counter = 0;
function freshRun() {
  const runId = `gate-answer-${process.pid}-${counter++}`;
  mkdirSync(join(runDir(runId), "gates"), { recursive: true });
  cleanup.push(runDir(runId));
  return runId;
}

const NOW = new Date("2026-10-12T10:00:00Z");
const NOW_ISO = "2026-10-12T10:00:00.000Z";

function seedGate(runId, over = {}) {
  const id = over.gateId ?? "gate-dev-1-1";
  const record = {
    gateId: id,
    childId: "dev-1",
    squad: "dev",
    runId,
    taskId: "FOC-999",
    kind: "question",
    summary: "s",
    questions: ["q?"],
    artifacts: [],
    facts: {},
    status: "pending",
    createdAt: "2026-10-12T00:00:00.000Z",
    answer: null,
    ...over,
  };
  writeFileSync(gatePath(runId, id), JSON.stringify(record, null, 2) + "\n");
  return id;
}

// A valid hold, seeded directly — the pricing rules belong to `hold` (parseOption),
// not to the answer, so the fixture only has to satisfy validateHoldStore.
function seedHold(runId, over = {}) {
  const hold = {
    id: "hold-1",
    origin: "supervisor",
    question: "wznawiać dev-1 po crashu?",
    options: [{ label: "wznów", model: "test/model", costUsd: null, unpricedModel: "test/model" }],
    recommendation: "wznów",
    impact: "medium",
    resolution: null,
    state: "open",
    createdAt: "2026-10-12T00:00:00.000Z",
    presentedAt: null,
    until: null,
    answer: null,
    blocks: null,
    history: [{ event: "created", at: "2026-10-12T00:00:00.000Z" }],
    ...over,
  };
  writeFileSync(holdsPath(runId), JSON.stringify({ version: HOLDS_SCHEMA_VERSION, holds: [hold] }));
  return hold;
}

// Throws must carry the contract `code`; assert and return the error.
function throwWith(fn, code, label) {
  let thrown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (!thrown) fail(`${label}: must refuse (throw)`);
  assert.equal(thrown.code, code, `${label}: error code (message: ${thrown.message})`);
  return thrown;
}

const cli = (args) =>
  spawnSync(process.execPath, [GATE, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LA_SUPERVISOR_NO_TELEMETRY: "1", LA_SUPERVISOR_NO_CODEGRAPH: "1" },
  });

// ── answerGate ────────────────────────────────────────────────────────────────
console.log("\nanswerGate");

test("happy path: the record flips to answered with text, answeredAt, no answeredBy", () => {
  const runId = freshRun();
  const id = seedGate(runId);
  const updated = answerGate({ runId, gateId: id, text: "rób A", now: NOW });
  assert.equal(updated.status, "answered");
  assert.deepEqual(updated.answer, { text: "rób A", answeredAt: NOW_ISO });
  assert.equal("answeredBy" in updated.answer, false, "answeredBy is only for callers that name themselves");
  assert.deepEqual(JSON.parse(readFileSync(gatePath(runId, id), "utf8")), updated, "the file carries the returned record");
});

test("note rides along; answeredBy appears ONLY when given", () => {
  const runId = freshRun();
  const plain = seedGate(runId, { gateId: "gate-dev-1-2" });
  const a = answerGate({ runId, gateId: plain, text: "tak", note: "TEST Done, tree clean", now: NOW });
  assert.deepEqual(a.answer, { text: "tak", note: "TEST Done, tree clean", answeredAt: NOW_ISO });

  const named = seedGate(runId, { gateId: "gate-dev-1-3" });
  const b = answerGate({ runId, gateId: named, text: "tak", note: "n", answeredBy: "dashboard", now: NOW });
  assert.deepEqual(b.answer, { text: "tak", note: "n", answeredBy: "dashboard", answeredAt: NOW_ISO });
});

test("already-answered: the second answer is refused, the first stays on disk", () => {
  const runId = freshRun();
  const id = seedGate(runId);
  answerGate({ runId, gateId: id, text: "pierwsza", now: NOW });
  const err = throwWith(() => answerGate({ runId, gateId: id, text: "druga", now: NOW }), "already-answered", "second answer");
  assert.match(err.message, /already answered/);
  assert.equal(err.extras.existingAnswer.text, "pierwsza");
  assert.equal(JSON.parse(readFileSync(gatePath(runId, id), "utf8")).answer.text, "pierwsza");
});

test("not-found: refused, naming the gates that DO exist", () => {
  const runId = freshRun();
  const id = seedGate(runId);
  const err = throwWith(() => answerGate({ runId, gateId: "gate-dev-1-99", text: "x", now: NOW }), "not-found", "missing gate");
  assert.match(err.message, /does not exist/);
  assert.deepEqual(err.extras.known, [id]);
});

test("cleanup-approval takes a single yes/no token and refuses prose before writing", () => {
  const runId = freshRun();
  const id = seedGate(runId, { kind: "cleanup-approval" });
  const err = throwWith(
    () => answerGate({ runId, gateId: id, text: "YES — TEST Done and the tree is clean", now: NOW }),
    "invalid-answer",
    "prose answer",
  );
  assert.match(err.message, /single yes\/no token/);
  assert.deepEqual(err.extras.accepted, { yes: AFFIRMATIVE, no: NEGATIVE });

  const rec = JSON.parse(readFileSync(gatePath(runId, id), "utf8"));
  assert.equal(rec.status, "pending", "a refused answer must leave the gate answerable");
  assert.equal(rec.answer, null);

  assert.equal(answerGate({ runId, gateId: seedGate(runId, { gateId: "gate-dev-1-2", kind: "cleanup-approval" }), text: "tak", now: NOW }).status, "answered");
  assert.equal(answerGate({ runId, gateId: seedGate(runId, { gateId: "gate-dev-1-3", kind: "cleanup-approval" }), text: "nie", now: NOW }).status, "answered");
});

test("bad-id: traversal and malformed ids are refused before any path is touched", () => {
  const runId = freshRun();
  seedGate(runId);
  for (const [runIdArg, gateIdArg] of [
    [runId, "../escape"],
    [runId, ".."],
    [runId, ""],
    [runId, null],
    ["../evil", "gate-dev-1-1"],
    ["bad/id", "gate-dev-1-1"],
    [runId, "gate-dev-1-1/../x"],
  ]) {
    throwWith(() => answerGate({ runId: runIdArg, gateId: gateIdArg, text: "x", now: NOW }), "bad-id", `${JSON.stringify(runIdArg)}/${JSON.stringify(gateIdArg)}`);
  }
  // The traversal attempts wrote nothing anywhere: the gate is still pending
  // and no file appeared outside the run's gates dir.
  assert.equal(JSON.parse(readFileSync(gatePath(runId, "gate-dev-1-1"), "utf8")).status, "pending");
  assert.equal(readFileSync(gatePath(runId, "gate-dev-1-1"), "utf8").includes("answered"), false);
});

test("unreadable: a corrupt gate file refuses with the CLI's message", () => {
  const runId = freshRun();
  writeFileSync(gatePath(runId, "broken"), "{not json");
  const err = throwWith(() => answerGate({ runId, gateId: "broken", text: "x", now: NOW }), "unreadable", "corrupt gate");
  assert.match(err.message, /not readable JSON/);
  assert.ok(err.extras.path, "the refusal names the path");
});

test("invalid-answer: empty or non-string text is refused", () => {
  const runId = freshRun();
  const id = seedGate(runId);
  throwWith(() => answerGate({ runId, gateId: id, text: "", now: NOW }), "invalid-answer", "empty text");
  throwWith(() => answerGate({ runId, gateId: id, text: "   ", now: NOW }), "invalid-answer", "blank text");
  throwWith(() => answerGate({ runId, gateId: id, text: undefined, now: NOW }), "invalid-answer", "missing text");
});

// ── answerHold ────────────────────────────────────────────────────────────────
console.log("\nanswerHold");

test("happy path: the hold answers once, history is append-only", () => {
  const runId = freshRun();
  seedHold(runId);
  const updated = answerHold({ runId, holdId: "hold-1", text: "wznów", now: NOW });
  assert.equal(updated.state, "answered");
  assert.deepEqual(updated.answer, { text: "wznów", answeredAt: NOW_ISO });
  assert.equal("answeredBy" in updated.answer, false);
  assert.deepEqual(updated.history.map((h) => h.event), ["created", "answered"]);
  assert.deepEqual(readHolds(runId).holds[0].answer, updated.answer, "the store on disk carries the answer");
});

test("hold note and answeredBy behave like the gate's", () => {
  const runId = freshRun();
  seedHold(runId);
  const a = answerHold({ runId, holdId: "hold-1", text: "wznów", note: "TEST passed", answeredBy: "dashboard", now: NOW });
  assert.deepEqual(a.answer, { text: "wznów", note: "TEST passed", answeredBy: "dashboard", answeredAt: NOW_ISO });
});

test("hold errors: not-found, already-answered, invalid-answer, unreadable, bad-id", () => {
  const runId = freshRun();
  seedHold(runId);
  const missing = throwWith(() => answerHold({ runId, holdId: "hold-9", text: "x", now: NOW }), "not-found", "missing hold");
  assert.deepEqual(missing.extras.known, ["hold-1"]);

  answerHold({ runId, holdId: "hold-1", text: "wznów", now: NOW });
  const second = throwWith(() => answerHold({ runId, holdId: "hold-1", text: "jednak nie", now: NOW }), "already-answered", "second answer");
  assert.match(second.message, /the answer in force is "wznów"/);
  assert.match(second.extras.hint, /a hold is answered once/);

  throwWith(() => answerHold({ runId, holdId: "hold-1", text: "", now: NOW }), "invalid-answer", "empty text");
  throwWith(() => answerHold({ runId, holdId: "../x", text: "x", now: NOW }), "bad-id", "traversing holdId");
  throwWith(() => answerHold({ runId: "../evil", holdId: "hold-1", text: "x", now: NOW }), "bad-id", "traversing runId");

  writeFileSync(holdsPath(runId), "{not json");
  const corrupt = throwWith(() => answerHold({ runId, holdId: "hold-1", text: "x", now: NOW }), "unreadable", "corrupt store");
  assert.match(corrupt.message, /holds store .* unreadable/);
});

// ── the answered-once lock ────────────────────────────────────────────────────
console.log("\nlock");

const gateLock = (runId, gateId) => `${gatePath(runId, gateId)}.lock`;
const holdsLock = (runId) => `${holdsPath(runId)}.lock`;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Spawn two CLI answers at the same instant and collect: exactly one wins, the
// loser re-reads under the lock and gets already-answered. `argsPair` gives each
// child its own flags — different --text, so the record on disk names its
// winner. Works for gates and holds alike.
//
// The test-held lock is released SYNCHRONOUSLY, right after the spawn — never
// behind an await. This test is async, so the next sync test (spawnSync, ~2 s
// of blocked event loop) starts immediately; a timer-based release would fire
// only after those blocks and both children would burn their 2 s wait deadline
// on a lock nobody is going to drop — both "busy", nobody wins. The held-lock
// wait itself is covered by the busy tests above.
async function raceTwoAnswers(argsPair, lockPath) {
  const children = argsPair.map((args) =>
    spawn(process.execPath, [GATE, "answer", ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LA_SUPERVISOR_NO_TELEMETRY: "1", LA_SUPERVISOR_NO_CODEGRAPH: "1" },
    }),
  );
  unlinkSync(lockPath); // release — the booting children fight over the gate now
  return Promise.all(
    children.map(
      (c) =>
        new Promise((resolve) => {
          let stdout = "";
          c.stdout.on("data", (d) => (stdout += d));
          c.on("close", (code) => resolve({ status: code, stdout }));
        }),
    ),
  );
}

test("a held lock makes answerGate wait, then throw busy — the holder's lock is left alone", () => {
  const runId = freshRun();
  const id = seedGate(runId);
  writeFileSync(gateLock(runId, id), "");
  const t0 = Date.now();
  const err = throwWith(() => answerGate({ runId, gateId: id, text: "x", now: NOW }), "busy", "held lock");
  assert.match(err.message, /another answer holds the lock/);
  assert.ok(Date.now() - t0 >= 2_000, `the wait ran to the 2 s deadline (took ${Date.now() - t0} ms)`);
  assert.equal(JSON.parse(readFileSync(gatePath(runId, id), "utf8")).status, "pending", "nothing was written");
  assert.ok(existsSync(gateLock(runId, id)), "a live holder's lock is not removed");
});

test("a stale lock (mtime 60 s ago) is taken over; the answer lands and the lock is gone", () => {
  const runId = freshRun();
  const id = seedGate(runId);
  writeFileSync(gateLock(runId, id), "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(gateLock(runId, id), old, old);
  const updated = answerGate({ runId, gateId: id, text: "rób A", now: NOW });
  assert.equal(updated.status, "answered");
  assert.equal(existsSync(gateLock(runId, id)), false, "the lock file is gone afterwards");
});

test("two gate answers racing: exactly one wins, the loser gets already-answered, no lock left", async () => {
  const runId = freshRun();
  const id = seedGate(runId);
  writeFileSync(gateLock(runId, id), ""); // the test plays the first holder
  const [a, b] = await raceTwoAnswers([
    ["--run", runId, "--gate", id, "--text", "pierwsza"],
    ["--run", runId, "--gate", id, "--text", "druga"],
  ], gateLock(runId, id));
  const winners = [a, b].filter((r) => r.status === 0);
  const losers = [a, b].filter((r) => r.status === 1);
  assert.equal(
    winners.length,
    1,
    `exactly one winner (statuses ${a.status}/${b.status})\n  a: ${a.stdout.slice(0, 300)}\n  b: ${b.stdout.slice(0, 300)}`,
  );
  assert.equal(losers.length, 1);
  const loser = JSON.parse(losers[0].stdout);
  assert.match(loser.error, /already answered/);
  const rec = JSON.parse(readFileSync(gatePath(runId, id), "utf8"));
  assert.equal(rec.status, "answered");
  assert.equal(rec.answer.text, JSON.parse(winners[0].stdout).answer.text, "the winner's text is what is on disk");
  assert.equal(existsSync(gateLock(runId, id)), false, "the lock file is gone afterwards");
});

test("CLI busy: the lock refusal goes through failJson — ok:false, exit 1, clear message", () => {
  const runId = freshRun();
  const id = seedGate(runId);
  writeFileSync(gateLock(runId, id), "");
  const r = cli(["answer", "--run", runId, "--gate", id, "--text", "x"]);
  assert.equal(r.status, 1);
  const err = JSON.parse(r.stdout);
  assert.equal(err.ok, false);
  assert.match(err.error, /another answer holds the lock/);
});

test("a held lock makes answerHold wait, then throw busy", () => {
  const runId = freshRun();
  seedHold(runId);
  writeFileSync(holdsLock(runId), "");
  const err = throwWith(() => answerHold({ runId, holdId: "hold-1", text: "x", now: NOW }), "busy", "held hold lock");
  assert.match(err.message, /another answer holds the lock/);
  assert.equal(readHolds(runId).holds[0].state, "open", "nothing was written");
});

test("lockWaitMs: 0 with a held gate lock throws busy immediately — the API path never blocks", () => {
  const runId = freshRun();
  const id = seedGate(runId);
  writeFileSync(gateLock(runId, id), "");
  const t0 = Date.now();
  const err = throwWith(
    () => answerGate({ runId, gateId: id, text: "x", now: NOW, lockWaitMs: 0 }),
    "busy",
    "zero-wait gate lock",
  );
  assert.match(err.message, /another answer holds the lock/);
  assert.ok(Date.now() - t0 < 100, `busy came without waiting (took ${Date.now() - t0} ms)`);
  assert.equal(JSON.parse(readFileSync(gatePath(runId, id), "utf8")).status, "pending", "nothing was written");
  assert.ok(existsSync(gateLock(runId, id)), "the holder's lock is intact");
});

test("lockWaitMs: 0 with a held hold lock throws busy immediately", () => {
  const runId = freshRun();
  seedHold(runId);
  writeFileSync(holdsLock(runId), "");
  const t0 = Date.now();
  const err = throwWith(
    () => answerHold({ runId, holdId: "hold-1", text: "x", now: NOW, lockWaitMs: 0 }),
    "busy",
    "zero-wait hold lock",
  );
  assert.match(err.message, /another answer holds the lock/);
  assert.ok(Date.now() - t0 < 100, `busy came without waiting (took ${Date.now() - t0} ms)`);
  assert.equal(readHolds(runId).holds[0].state, "open", "nothing was written");
});

test("a stale hold lock is taken over; the answer lands and the lock is gone", () => {
  const runId = freshRun();
  seedHold(runId);
  writeFileSync(holdsLock(runId), "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(holdsLock(runId), old, old);
  const updated = answerHold({ runId, holdId: "hold-1", text: "wznów", now: NOW });
  assert.equal(updated.state, "answered");
  assert.equal(existsSync(holdsLock(runId)), false, "the lock file is gone afterwards");
});

test("two hold answers racing: exactly one wins, the loser gets already-answered, no lock left", async () => {
  const runId = freshRun();
  seedHold(runId);
  writeFileSync(holdsLock(runId), "");
  const [a, b] = await raceTwoAnswers([
    ["--run", runId, "--hold", "hold-1", "--text", "wznów"],
    ["--run", runId, "--hold", "hold-1", "--text", "jednak nie"],
  ], holdsLock(runId));
  const winners = [a, b].filter((r) => r.status === 0);
  const losers = [a, b].filter((r) => r.status === 1);
  assert.equal(winners.length, 1, `exactly one winner (statuses ${a.status}/${b.status})`);
  assert.equal(losers.length, 1);
  const winnerText = JSON.parse(winners[0].stdout).hold.answer.text;
  assert.match(JSON.parse(losers[0].stdout).error, new RegExp(`the answer in force is "${winnerText}"`));
  assert.equal(existsSync(holdsLock(runId)), false, "the lock file is gone afterwards");
});


console.log("\nCLI — unchanged shapes");

// ── the CLI still renders the same bytes ──────────────────────────────────────

test("CLI gate answer: record shape is exactly the pre-refactor one (no answeredBy)", () => {
  const runId = freshRun();
  const id = seedGate(runId);
  const r = cli(["answer", "--run", runId, "--gate", id, "--text", "rób A"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(readFileSync(gatePath(runId, id), "utf8"));
  assert.deepEqual(Object.keys(rec).sort(), [
    "answer", "artifacts", "childId", "createdAt", "facts", "gateId", "kind",
    "questions", "runId", "squad", "status", "summary", "taskId",
  ]);
  assert.deepEqual(Object.keys(rec.answer).sort(), ["answeredAt", "text"]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.answer.text, "rób A");
  assert.deepEqual(out.warnings, []);
  assert.match(out.next, /supervisor-followup\.mjs/);
});

test("CLI cleanup-approval refusal: the exact JSON contract, nothing recorded", () => {
  const runId = freshRun();
  const id = seedGate(runId, { kind: "cleanup-approval" });
  const r = cli(["answer", "--run", runId, "--gate", id, "--text", "YES — TEST Done and the tree is clean"]);
  assert.equal(r.status, 1, r.stdout);
  const err = JSON.parse(r.stdout);
  assert.equal(err.ok, false);
  assert.match(err.error, /single yes\/no token/);
  assert.equal(err.gateId, id);
  assert.deepEqual(err.accepted, { yes: AFFIRMATIVE, no: NEGATIVE });
  assert.equal(JSON.parse(readFileSync(gatePath(runId, id), "utf8")).status, "pending");
});

test("CLI refusals keep their extras: not-found lists known, already-answered names existingAnswer", () => {
  const runId = freshRun();
  const id = seedGate(runId);
  const missing = cli(["answer", "--run", runId, "--gate", "gate-dev-1-99", "--text", "x"]);
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stdout).known, [id]);

  cli(["answer", "--run", runId, "--gate", id, "--text", "pierwsza"]);
  const second = cli(["answer", "--run", runId, "--gate", id, "--text", "druga"]);
  assert.equal(second.status, 1);
  const err = JSON.parse(second.stdout);
  assert.match(err.error, /already answered/);
  assert.equal(err.existingAnswer.text, "pierwsza");
  assert.match(err.hint, /supervisor-followup/);
});

test("CLI hold answer: --note lands in the record, no answeredBy, history appended", () => {
  const runId = freshRun();
  seedHold(runId);
  const r = cli(["answer", "--run", runId, "--hold", "hold-1", "--text", "wznów", "--note", "TEST passed"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.next, /in force/);
  const hold = readHolds(runId).holds[0];
  assert.equal(hold.state, "answered");
  assert.deepEqual(Object.keys(hold.answer).sort(), ["answeredAt", "note", "text"]);
  assert.deepEqual(hold.history.map((h) => h.event), ["created", "answered"]);
});

test("CLI hold refusals keep their extras: unknown hold lists known, answered one names the answer in force", () => {
  const runId = freshRun();
  seedHold(runId);
  const unknown = cli(["answer", "--run", runId, "--hold", "hold-9", "--text", "x"]);
  assert.equal(unknown.status, 1);
  assert.deepEqual(JSON.parse(unknown.stdout).known, ["hold-1"]);

  cli(["answer", "--run", runId, "--hold", "hold-1", "--text", "wznów"]);
  const second = cli(["answer", "--run", runId, "--hold", "hold-1", "--text", "jednak nie"]);
  assert.equal(second.status, 1);
  const err = JSON.parse(second.stdout);
  assert.match(err.error, /the answer in force is "wznów"/);
  assert.match(err.hint, /a hold is answered once/);
});

await Promise.all(asyncTests);

try {
  rmSync(HOME, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);