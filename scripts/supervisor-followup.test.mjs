// scripts/supervisor-followup.test.mjs — resuming a child's session, turn by turn.
//
// The thing worth testing here is not that a process starts — it is that the
// second turn is a CONTINUATION: same session id on --resume, same permission
// mode, same tee. A follow-up that quietly starts a fresh session looks
// identical from the outside and loses everything the child knew.
//
// Run: node scripts/supervisor-followup.test.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readRegistry, runDir } from "./supervisor-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const FOLLOWUP = join(ROOT, "scripts", "supervisor-followup.mjs");
const STOP = join(ROOT, "scripts", "supervisor-stop.mjs");
const MOCK = join(ROOT, "scripts", "mock-claude.mjs");
const GATE = join(ROOT, "scripts", "supervisor-gate.mjs");

let passed = 0;
const failures = [];
const cleanup = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const fail = (msg) => { throw new Error(msg); };
const pause = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

function fixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), "la-sup-fu-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-m", "init");
  cleanup.push(base);
  return repo;
}

let counter = 0;
function fixtureRun() {
  const runId = `test-fu-${process.pid}-${Date.now()}-${counter++}`;
  const dir = runDir(runId);
  mkdirSync(join(dir, "children"), { recursive: true });
  mkdirSync(join(dir, "gates"), { recursive: true });
  writeFileSync(join(dir, "triage.json"), JSON.stringify({ issue: "FOC-123", verdict: "dev" }));
  cleanup.push(dir);
  return runId;
}

const baseEnv = (extra = {}) => ({
  ...process.env,
  LA_CLAUDE_BIN: MOCK,
  LA_SUPERVISOR_NO_TELEMETRY: "1",
  ...extra,
});

const parse = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    fail(`stdout was not JSON (exit ${r.status}):\n       ${r.stdout}\n       ${r.stderr}`);
  }
};

function spawnChild(runId, repo, env = {}) {
  const r = spawnSync(
    process.execPath,
    [SPAWN, "--run", runId, "--squad", "dev", "--task", "FOC-123", "--prompt", "kickoff", "--repo", repo],
    { encoding: "utf8", env: baseEnv({ MOCK_CLAUDE_HANG_MS: "0", ...env }) },
  );
  return parse(r);
}

function waitForStatus(runId, childId, wanted, ms = 8000) {
  const deadline = Date.now() + ms;
  let entry;
  while (Date.now() < deadline) {
    entry = readRegistry(runId).children[childId];
    if (wanted.includes(entry.status)) return entry;
    pause(150);
  }
  return entry;
}

const followup = (runId, childId, extra = [], env = {}) =>
  spawnSync(process.execPath, [FOLLOWUP, "--run", runId, "--child", childId, "--prompt", "answer", ...extra], {
    encoding: "utf8",
    env: baseEnv({ MOCK_CLAUDE_HANG_MS: "0", ...env }),
  });

// ── resume semantics ─────────────────────────────────────────────────────────
console.log("\nresume is a continuation, not a new session");

test("re-invokes claude with --resume and the captured session id", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const argvFile = join(runDir(runId), "argv.log");

  const child = spawnChild(runId, repo, { MOCK_CLAUDE_SESSION_ID: "sess-xyz", MOCK_CLAUDE_ARGV_FILE: argvFile });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const out = parse(followup(runId, child.childId, [], { MOCK_CLAUDE_ARGV_FILE: argvFile }));
  if (!out.ok) fail(`followup failed: ${out.error}`);
  if (out.sessionId !== "sess-xyz") fail(`sessionId changed to ${out.sessionId}`);
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const calls = readFileSync(argvFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (calls.length !== 2) fail(`expected 2 claude invocations, got ${calls.length}`);
  const resumeIdx = calls[1].indexOf("--resume");
  if (resumeIdx === -1) fail(`second call carried no --resume: ${JSON.stringify(calls[1])}`);
  if (calls[1][resumeIdx + 1] !== "sess-xyz") fail(`--resume got ${calls[1][resumeIdx + 1]}`);
  // The first turn must NOT be a resume — that would mean spawn silently
  // continued someone else's session.
  if (calls[0].includes("--resume")) fail("the initial spawn used --resume");
});

test("reuses the permission mode recorded at spawn", () => {
  // A follow-up running under looser permissions than the turn it continues
  // would be a hole in the push gate.
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const argvFile = join(runDir(runId), "argv.log");

  const child = spawnChild(runId, repo, { MOCK_CLAUDE_ARGV_FILE: argvFile });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);
  followup(runId, child.childId, [], { MOCK_CLAUDE_ARGV_FILE: argvFile });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const calls = readFileSync(argvFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const modeOf = (a) => a[a.indexOf("--permission-mode") + 1];
  if (modeOf(calls[0]) !== modeOf(calls[1])) {
    fail(`permission mode drifted: ${modeOf(calls[0])} → ${modeOf(calls[1])}`);
  }
});

test("appends to the same tee and pushes a new turn", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const child = spawnChild(runId, repo);
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const tee = join(runDir(runId), child.tee);
  const sizeBefore = readFileSync(tee, "utf8").length;

  const out = parse(followup(runId, child.childId));
  if (out.turn !== 1) fail(`expected turn index 1, got ${out.turn}`);
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  if (readFileSync(tee, "utf8").length <= sizeBefore) fail("the follow-up did not append to the same tee");
  const entry = readRegistry(runId).children[child.childId];
  if (entry.turns.length !== 2) fail(`expected 2 turns, got ${entry.turns.length}`);
  if (!entry.turns[1].endedAt) fail("second turn was never closed");
});

// ── guards ───────────────────────────────────────────────────────────────────
console.log("\nguards");

test("refuses while a turn is still in flight", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const child = spawnChild(runId, repo, { MOCK_CLAUDE_HANG_MS: "20000" });

  const r = followup(runId, child.childId);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const out = parse(r);
  if (!/in flight|running/i.test(out.error)) fail(`unhelpful error: ${out.error}`);

  const entry = readRegistry(runId).children[child.childId];
  if (entry.turns.length !== 1) fail("a competing turn was created anyway");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", child.childId], { encoding: "utf8" });
});

test("refuses an unknown child and lists what it knows", () => {
  const runId = fixtureRun();
  const r = followup(runId, "ghost");
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  if (!Array.isArray(parse(r).known)) fail("error does not list known children");
});

// ── review loop ─────────────────────────────────────────────────────────────
// The round CAP that used to be asserted here is gone (FOC-163): it counted,
// and a counter cannot tell a run that is converging from one going in circles.
// What replaced it — the diff + failing-test fingerprint — is a different
// mechanism with its own preconditions, so it gets its own suite:
// scripts/supervisor-verdict.test.mjs.

test("--gate is recorded on the turn for audit", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const child = spawnChild(runId, repo);
  waitForStatus(runId, child.childId, ["exited", "crashed", "waiting_gate"]);

  // The gate has to exist and be ANSWERED before it can be delivered (FOC-122):
  // a turn carrying an unrecorded answer leaves the gate `pending` forever.
  // supervisor-gate.test.mjs owns the refusal cases; this one just needs a real gate.
  const gateId = parse(
    spawnSync(
      process.execPath,
      [GATE, "--run", runId, "emit", "--child", child.childId, "--kind", "question", "--summary", "s", "--question", "q?"],
      { encoding: "utf8", env: baseEnv() },
    ),
  ).gateId;
  spawnSync(process.execPath, [GATE, "--run", runId, "answer", "--gate", gateId, "--text", "rob A"], {
    encoding: "utf8",
    env: baseEnv(),
  });

  followup(runId, child.childId, ["--gate", gateId]);
  waitForStatus(runId, child.childId, ["exited", "crashed", "waiting_gate"]);

  const entry = readRegistry(runId).children[child.childId];
  if (entry.turns[1].gateId !== gateId) fail(`gateId was ${entry.turns[1].gateId}`);
});

// ── summary ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
