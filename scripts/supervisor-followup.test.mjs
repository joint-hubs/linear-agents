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

import { readRegistry, runDir, writeRegistry } from "./supervisor-lib.mjs";

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

// ── incident catcher (FOC-284 rounds 2–3) ───────────────────────────────────
// A --review-loop resume off a FAIL verdict must say so when the return may
// never have landed: no linearEffects audit at all (a pre-FOC-284 tool wrote
// the record — the round-1 incident), a label recorded "failed", ops left
// "pending" (crash window), or an unlanded transition. Fixtures
// are verdict JSONs written straight into the run's verdicts dir; both rounds
// share one fingerprint so the progress guard refuses before any spawn — the
// warning fires on stderr first, and the refusal keeps the suite spawn-free.

const loopRun = () => {
  const runId = fixtureRun();
  writeRegistry(runId, {
    runId,
    children: {
      "review-1": {
        childId: "review-1",
        squad: "review",
        taskId: "FOC-123",
        sessionId: "11111111-2222-3333-4444-555555555555",
        status: "exited",
        turns: [{ pid: 1 }],
        permissionMode: "bypassPermissions",
        worktree: join(tmpdir(), "la-fu-loop-fixture"),
      },
    },
    rounds: {},
  });
  return runId;
};

const writeRound = (runId, round, over = {}) => {
  const dir = join(runDir(runId), "verdicts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `foc-123-round${round}.json`),
    JSON.stringify({
      taskId: "FOC-123", runId, childId: "review-1", squad: "review", round,
      verdict: "fail", fingerprint: { combined: "same" },
      ...over,
    }),
  );
};

const loopAttempt = (runId) => followup(runId, "review-1", ["--review-loop"]);

test("a FAIL verdict with no linearEffects audit warns before the dev round", () => {
  // The round-1 incident shape: the Supervisor recorded with the BASE verdict
  // tool, the apply never ran, nothing warned, and the record says nothing.
  const runId = loopRun();
  writeRound(runId, 1);
  writeRound(runId, 2); // no linearEffects key at all
  const r = loopAttempt(runId);
  if (r.status !== 1) fail(`expected the repeated-round refusal, got exit ${r.status}`);
  if (!/NO linearEffects audit/.test(r.stderr)) fail(`no incident warning on stderr:\n       ${r.stderr}`);
  if (!/FOC-123/.test(r.stderr)) fail("the warning does not name the task");
});

test("a FAIL verdict with a failed return label warns before the dev round", () => {
  const runId = loopRun();
  writeRound(runId, 1);
  writeRound(runId, 2, {
    linearEffects: {
      dryRun: false,
      label: { status: "failed", detail: "linear-ops label FOC-123 --add returned-by:review → refused" },
      transition: { status: "applied", detail: "" },
    },
  });
  const r = loopAttempt(runId);
  if (r.status !== 1) fail(`expected the repeated-round refusal, got exit ${r.status}`);
  if (!/FAILED return label/.test(r.stderr)) fail(`no incident warning on stderr:\n       ${r.stderr}`);
  if (!/returned-by:review/.test(r.stderr)) fail("the warning does not carry the op detail");
});

test("a landed (or skipped / not-applicable) return stays silent on the resume", () => {
  const runId = loopRun();
  writeRound(runId, 1);
  writeRound(runId, 2, {
    linearEffects: {
      dryRun: true,
      label: { status: "applied", detail: "" },
      transition: { status: "applied", detail: "" },
    },
  });
  const r = loopAttempt(runId);
  if (r.status !== 1) fail(`expected the repeated-round refusal, got exit ${r.status}`);
  if (/linearEffects|probably missing/.test(r.stderr)) fail(`unexpected incident warning:\n       ${r.stderr}`);
});

test("a PASS verdict never trips the catcher", () => {
  const runId = loopRun();
  writeRound(runId, 1);
  writeRound(runId, 2, { verdict: "pass" }); // no linearEffects — irrelevant on a pass
  const r = loopAttempt(runId);
  if (r.status !== 1) fail(`expected the repeated-round refusal, got exit ${r.status}`);
  if (/linearEffects|probably missing/.test(r.stderr)) fail(`unexpected incident warning:\n       ${r.stderr}`);
});

test("a FAIL verdict with pending return ops warns that the state is unknown (R2-3)", () => {
  // The crash window between the pending write and the amend: the record stays
  // "pending" forever. Either nothing was applied, or Linear WAS mutated while
  // the record-time gate never fired (in-memory statuses read applied at the
  // kill) — so neither the failure nor the landed wording fits; this one says
  // the state is unknown and the issue must be verified first.
  const runId = loopRun();
  writeRound(runId, 1);
  writeRound(runId, 2, {
    linearEffects: {
      dryRun: false,
      label: { status: "pending", detail: "pending — the verdict file is written before the linear-ops label runs" },
      transition: { status: "pending", detail: "pending — the verdict file is written before the linear-ops transition runs" },
    },
  });
  const r = loopAttempt(runId);
  if (r.status !== 1) fail(`expected the repeated-round refusal, got exit ${r.status}`);
  if (!/left the return ops "pending"/.test(r.stderr)) fail(`no pending warning on stderr:\n       ${r.stderr}`);
  if (!/state UNKNOWN/.test(r.stderr)) fail(`the pending warning must say the state is unknown:\n       ${r.stderr}`);
  if (/FAILED return label|NO linearEffects audit|unlanded return transition/.test(r.stderr)) {
    fail(`the pending warning reused another shape's wording:\n       ${r.stderr}`);
  }
});

test("an unlanded TRANSITION warns even when the label applied (R2-3 mirror)", () => {
  // The belt mirrors the record-time enforcement gate's condition: label
  // applied + transition failed is invisible on later resumes if that gate
  // failed to emit — never-block cuts both ways.
  const runId = loopRun();
  writeRound(runId, 1);
  writeRound(runId, 2, {
    linearEffects: {
      dryRun: false,
      label: { status: "applied", detail: "" },
      transition: { status: "failed", detail: "linear-ops transition FOC-123 --status In Progress → state not found" },
    },
  });
  const r = loopAttempt(runId);
  if (r.status !== 1) fail(`expected the repeated-round refusal, got exit ${r.status}`);
  if (!/unlanded return transition/.test(r.stderr)) fail(`no transition warning on stderr:\n       ${r.stderr}`);
  if (!/\(failed\)/.test(r.stderr)) fail(`the warning does not name the transition status:\n       ${r.stderr}`);
  if (!/state not found/.test(r.stderr)) fail(`the warning does not carry the op detail:\n       ${r.stderr}`);
});

test("a real applied/applied return stays silent — the mirror does not fire on a landed return", () => {
  // The silence pin above covers the dry-run shape; this is the REAL landed
  // shape the new mirror condition must also stay quiet on.
  const runId = loopRun();
  writeRound(runId, 1);
  writeRound(runId, 2, {
    linearEffects: {
      dryRun: false,
      label: { status: "applied", detail: "" },
      transition: { status: "applied", detail: "" },
    },
  });
  const r = loopAttempt(runId);
  if (r.status !== 1) fail(`expected the repeated-round refusal, got exit ${r.status}`);
  if (/pending|unlanded return transition|linearEffects|probably missing/.test(r.stderr)) {
    fail(`unexpected incident warning:\n       ${r.stderr}`);
  }
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
