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
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PRINT_BG_WAIT_CEILING_MS, PRINT_BG_WAIT_ENV, TURN_END_CONTRACT, readRegistry, runDir, writeRegistry } from "./supervisor-lib.mjs";
import { attemptIdFor } from "./agent-launch-profile.mjs";
import { waitForStatus } from "./supervisor-test-fixtures.mjs";
import { readFocus } from "./supervisor-focus.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const FOLLOWUP = join(ROOT, "scripts", "supervisor-followup.mjs");
const FOCUS = join(ROOT, "scripts", "supervisor-focus.mjs");
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
function fixtureRun({ runId } = {}) {
  // `runId` override: the auto-focus tests need a run id matching RUN_ID_RE —
  // supervisor-focus refuses others — which the counter ids do not carry.
  const id = runId ?? `test-fu-${process.pid}-${Date.now()}-${counter++}`;
  const dir = runDir(id);
  mkdirSync(join(dir, "children"), { recursive: true });
  mkdirSync(join(dir, "gates"), { recursive: true });
  writeFileSync(join(dir, "triage.json"), JSON.stringify({ issue: "FOC-123", verdict: "dev" }));
  cleanup.push(dir);
  return id;
}

// A run id that matches RUN_ID_RE (supervisor-current-run.mjs).
const validRunId = (n) => `2026-10-13T10-00-00-000-supervisor-000${n}`;

const baseEnv = (extra = {}) => ({
  ...process.env, OPENROUTER_API_KEY: "test-supervisor-provider-key",
  LA_CLAUDE_BIN: MOCK,
  LA_SUPERVISOR_NO_TELEMETRY: "1",
  LA_SUPERVISOR_NO_CODEGRAPH: "1",
  ...extra,
});

// FOC-522 follow-up — a load-crashed spawn used to flow through here as a
// success-shaped object: parse() checked JSON-parseability only, so spawn's
// failJson ({ok:false, error, tee: <ABSOLUTE path>}) passed as if the child had
// started, waitForStatus(["exited","crashed"]) accepted the crash, and the
// absolute tee mangled by join() surfaced three assertions later as an ENOENT
// nobody could read. Every call site now declares what it expects:
//   · parseOk      — the call must succeed; a failJson fails the test HERE with
//                    the actual error field (the load-flake names its cause).
//   · parseRefusal — the call must refuse; asserts the ok:false shape instead
//                    of assuming it.
const parse = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    fail(`stdout was not JSON (exit ${r.status}):\n       ${r.stdout}\n       ${r.stderr}`);
  }
};
const parseOk = (r) => {
  const out = parse(r);
  if (!out || out.ok !== true) {
    fail(`the script reported failure (exit ${r.status}): ${out?.error ?? JSON.stringify(out)}`);
  }
  return out;
};
const parseRefusal = (r) => {
  const out = parse(r);
  if (!out || out.ok !== false) {
    fail(`expected a refusal (ok:false), got exit ${r.status}: ${JSON.stringify(out).slice(0, 300)}`);
  }
  return out;
};

// The success payloads carry a run-RELATIVE tee (teeRelPath); spawn's failJson
// carries an ABSOLUTE one (teeAbsPath). A blind join() on an absolute path
// mangles it on win32 and the ENOENT that follows hides the real error —
// validate the shape instead of trusting it.
const followupTeePath = (runId, tee) => {
  if (typeof tee !== "string" || !tee || isAbsolute(tee)) {
    fail(`tee is not a run-relative path: ${JSON.stringify(tee)}`);
  }
  return join(runDir(runId), tee);
};

function spawnChild(runId, repo, env = {}) {
  const r = spawnSync(
    process.execPath,
    [SPAWN, "--run", runId, "--squad", "dev", "--task", "FOC-123", "--prompt", "kickoff", "--repo", repo],
    { encoding: "utf8", env: baseEnv({ MOCK_CLAUDE_HANG_MS: "0", ...env }) },
  );
  return parseOk(r);
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

  const out = parseOk(followup(runId, child.childId, [], { MOCK_CLAUDE_ARGV_FILE: argvFile }));
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

  const tee = followupTeePath(runId, child.tee);
  const sizeBefore = readFileSync(tee, "utf8").length;

  const out = parseOk(followup(runId, child.childId));
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
  const out = parseRefusal(r);
  if (!/in flight|running/i.test(out.error)) fail(`unhelpful error: ${out.error}`);

  const entry = readRegistry(runId).children[child.childId];
  if (entry.turns.length !== 1) fail("a competing turn was created anyway");

  spawnSync(process.execPath, [STOP, "--run", runId, "--child", child.childId], { encoding: "utf8" });
});

test("refuses an unknown child and lists what it knows", () => {
  const runId = fixtureRun();
  const r = followup(runId, "ghost");
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  if (!Array.isArray(parseRefusal(r).known)) fail("error does not list known children");
});

// ── --prompt-file ───────────────────────────────────────────────────────────
// Run a93f, 2026-09-12: four resumes with `--prompt-file .state/x.md` died as
// "no system/init within 30000 ms" because the watcher read the RELATIVE path
// with the child's worktree as its cwd. The two `--prompt "$(cat …)"` resumes
// in the same run worked. Spawn had been fixed for exactly this; followup had not.
console.log("\n--prompt-file");

const followupFromCwd = (cwd, runId, childId, extra, env = {}) =>
  spawnSync(process.execPath, [FOLLOWUP, "--run", runId, "--child", childId, ...extra], {
    cwd,
    encoding: "utf8",
    env: baseEnv({ MOCK_CLAUDE_HANG_MS: "0", ...env }),
  });

test("a relative --prompt-file resolves against the caller's cwd, not the worktree", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const argvFile = join(runDir(runId), "argv.log");
  const caller = mkdtempSync(join(tmpdir(), "la-sup-fu-caller-"));
  cleanup.push(caller);
  mkdirSync(join(caller, ".state"));
  writeFileSync(join(caller, ".state", "round2.md"), "PROMPT FROM THE CALLER'S FILE");

  const child = spawnChild(runId, repo, { MOCK_CLAUDE_ARGV_FILE: argvFile });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const out = parseOk(
    followupFromCwd(caller, runId, child.childId, ["--prompt-file", ".state/round2.md"], { MOCK_CLAUDE_ARGV_FILE: argvFile }),
  );
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const calls = readFileSync(argvFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (calls.length !== 2) fail(`expected 2 claude invocations, got ${calls.length} — the resumed turn never started`);
  const prompt = calls[1][calls[1].indexOf("-p") + 1];
  // FOC-522: every resume prompt carries the turn-end contract up front, so the
  // caller's file content is asserted as the payload's tail, not byte equality.
  if (!prompt.endsWith("PROMPT FROM THE CALLER'S FILE")) fail(`resumed turn received ${JSON.stringify(prompt)}`);
});

test("an absolute --prompt-file is passed through unchanged", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const argvFile = join(runDir(runId), "argv.log");
  const caller = mkdtempSync(join(tmpdir(), "la-sup-fu-caller-"));
  cleanup.push(caller);
  mkdirSync(join(caller, ".state"));
  const promptFile = join(caller, ".state", "round2.md");
  writeFileSync(promptFile, "PROMPT FROM THE CALLER'S FILE");

  const child = spawnChild(runId, repo, { MOCK_CLAUDE_ARGV_FILE: argvFile });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const out = parseOk(
    followupFromCwd(caller, runId, child.childId, ["--prompt-file", promptFile], { MOCK_CLAUDE_ARGV_FILE: argvFile }),
  );
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const calls = readFileSync(argvFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (calls.length !== 2) fail(`expected 2 claude invocations, got ${calls.length} — the resumed turn never started`);
  const prompt = calls[1][calls[1].indexOf("-p") + 1];
  // Same FOC-522 shape as the relative-path test: the file's content is the tail.
  if (!prompt.endsWith("PROMPT FROM THE CALLER'S FILE")) fail(`resumed turn received ${JSON.stringify(prompt)}`);
});

test("an unreadable --prompt-file is refused before a turn is recorded", () => {
  // Refusing after the turn is appended would leave a phantom `starting` turn
  // with a null pid — the zombie shape FOC-271 exists to prevent.
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const child = spawnChild(runId, repo);
  waitForStatus(runId, child.childId, ["exited", "crashed"]);
  const before = readRegistry(runId).children[child.childId];

  const r = followupFromCwd(ROOT, runId, child.childId, ["--prompt-file", ".state/does-not-exist-fu-test.md"]);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  const refusal = parseRefusal(r);
  if (!/not readable/.test(refusal.error)) fail(`unhelpful error: ${refusal.error}`);

  const after = readRegistry(runId).children[child.childId];
  if (after.turns.length !== before.turns.length) fail("a turn was recorded for a prompt that could not be read");
  if (after.status !== before.status) fail(`status moved ${before.status} → ${after.status}`);
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
  const gateId = parseOk(
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

// ── background-wait ceiling + turn-end contract (FOC-522) ────────────────────
// The follow-up env is NOT a copy of the spawn env — it was written separately
// once and drifted before (FOC-171, RUN_ID). So the resume carrier gets its own
// end-to-end proof: the ceiling the resumed turn runs under, and the contract
// prepended to the delivered prompt.
console.log("\nbackground-wait ceiling and the turn-end contract");

test("the resumed turn's env carries the same ceiling — the second carrier (FOC-522)", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const envFile = join(runDir(runId), "env.log");
  const child = spawnChild(runId, repo, { MOCK_CLAUDE_ENV_FILE: envFile });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const out = parseOk(followup(runId, child.childId, [], { MOCK_CLAUDE_ENV_FILE: envFile }));
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const envs = readFileSync(envFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (envs.length !== 2) fail(`expected 2 claude invocations, got ${envs.length}`);
  for (const [turn, env] of envs.entries()) {
    if (env[PRINT_BG_WAIT_ENV] !== String(PRINT_BG_WAIT_CEILING_MS)) {
      fail(`turn ${turn} env carried ${PRINT_BG_WAIT_ENV}=${JSON.stringify(env[PRINT_BG_WAIT_ENV])}`);
    }
    // FOC-848: the resumed turn declares its acting owner the way spawn does —
    // the child's ownership gates attribute its work to this owner, and a
    // resume that dropped it would let the two turn paths drift (the FOC-171
    // shape this suite exists to catch).
    if (env.LA_TASK_OWNER !== "supervisor") {
      fail(`turn ${turn} env carried LA_TASK_OWNER=${JSON.stringify(env.LA_TASK_OWNER)}`);
    }
  }
});

test("the resumed turn carries the teardown identity and the registry records it (FOC-917)", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const envFile = join(runDir(runId), "env.log");
  const child = spawnChild(runId, repo, { MOCK_CLAUDE_ENV_FILE: envFile });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  // The pre-FOC-808 shape the sweep has to keep working with: an entry with no
  // teardown identity. Today's spawn records turn 0's pair (FOC-808), so strip
  // it to model the legacy entry this fix must write into fresh.
  const reg0 = readRegistry(runId);
  const { mark: _turn0Mark, tmpDir: _turn0TmpDir, ...legacyEntry } = reg0.children[child.childId];
  writeRegistry(runId, { ...reg0, children: { ...reg0.children, [child.childId]: legacyEntry } });

  const out = parseOk(followup(runId, child.childId, [], { MOCK_CLAUDE_ENV_FILE: envFile }));
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const envs = readFileSync(envFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (envs.length !== 2) fail(`expected 2 claude invocations, got ${envs.length}`);
  const resumed = envs[1];
  // The mark carries the attempt id, so resumed turn 1 carries turn 1's.
  const wantedMark = `${runId}/${child.childId}/${attemptIdFor(child.childId, 1)}`;
  if (resumed.LA_CHILD_MARK !== wantedMark) {
    fail(`resumed env carried LA_CHILD_MARK=${JSON.stringify(resumed.LA_CHILD_MARK)}, wanted ${JSON.stringify(wantedMark)}`);
  }
  if (!resumed.TMPDIR || !resumed.TMPDIR.endsWith(join("fenix-child", child.childId))) {
    fail(`resumed env carried TMPDIR=${JSON.stringify(resumed.TMPDIR)}`);
  }
  // And the registry records the CURRENT turn's identity — the sweep matches
  // the mark, the turn end removes the tmp dir.
  const entry = readRegistry(runId).children[child.childId];
  if (entry.mark !== resumed.LA_CHILD_MARK) {
    fail(`registry mark=${JSON.stringify(entry.mark)}, env carried ${JSON.stringify(resumed.LA_CHILD_MARK)}`);
  }
  if (entry.tmpDir !== resumed.TMPDIR) {
    fail(`registry tmpDir=${JSON.stringify(entry.tmpDir)}, env carried ${JSON.stringify(resumed.TMPDIR)}`);
  }
});

test("every resume prompt embeds the turn-end contract without displacing the answer (FOC-522)", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const argvFile = join(runDir(runId), "argv.log");
  const child = spawnChild(runId, repo, { MOCK_CLAUDE_ARGV_FILE: argvFile });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const out = parseOk(followup(runId, child.childId, [], { MOCK_CLAUDE_ARGV_FILE: argvFile }));
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const calls = readFileSync(argvFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (calls.length !== 2) fail(`expected 2 claude invocations, got ${calls.length}`);
  const payload = calls[1][calls[1].indexOf("-p") + 1];
  if (payload === undefined) fail(`the resumed turn had no -p payload: ${JSON.stringify(calls[1])}`);
  for (const line of TURN_END_CONTRACT.split("\n")) {
    if (!payload.includes(line)) fail(`the resumed prompt lost the contract line: "${line}"`);
  }
  if (!payload.endsWith("answer")) fail(`the contract displaced the delivered answer: ...${payload.slice(-80)}`);
});

// ── provider pinning on resume (FOC-762/FOC-773) ─────────────────────────────
// The resumed turn must run on the SAME provider the first turn ran on, even
// after a switch in the settings overlay — a pinned model on another provider's
// endpoint is the exact drift this closes. The env capture is the same
// MOCK_CLAUDE_ENV_FILE channel the spawn suite uses, so what is asserted is
// what claude actually received, not what the script mentions.
console.log("\nthe resumed turn pins the spawn-time provider");

// Two providers in one fixture config, so "the active provider moved on" is a
// real switch between resolvable providers, not a mock.
function twoProviderFixture() {
  const dir = mkdtempSync(join(tmpdir(), "la-sup-fu-prov-"));
  cleanup.push(dir);
  const configPath = join(dir, "models.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        mockprov: { baseUrl: "http://127.0.0.1:9443/api", authEnv: "MOCKPROV_API_KEY", authStyle: "token" },
        otherprov: { baseUrl: "http://127.0.0.1:9553/api", authEnv: "OTHERPROV_API_KEY", authStyle: "token" },
      },
    }),
  );
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "MOCKPROV_API_KEY=mock-key\nOTHERPROV_API_KEY=other-key\n");
  return { configPath, envPath };
}

// The mock claude appends one JSON object per invocation; the last line is the
// env of the most recent turn.
const lastRecordedEnv = (envFile) => JSON.parse(readFileSync(envFile, "utf8").trim().split("\n").pop());

test("a resumed turn keeps the child's spawn-time provider after the active provider moved on", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const { configPath, envPath } = twoProviderFixture();
  const envFile = join(runDir(runId), "env.log");

  const child = spawnChild(runId, repo, {
    LA_PROVIDER: "mockprov",
    LA_PROVIDER_CONFIG: configPath,
    LA_PROVIDER_ENV_FILE: envPath,
    MOCK_CLAUDE_ENV_FILE: envFile,
  });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);
  if (readRegistry(runId).children[child.childId].provider !== "mockprov") {
    fail("spawn did not record the resolved provider in the registry entry");
  }

  // The active provider has moved on: the follow-up itself runs with
  // otherprov active — the child env must STILL carry mockprov.
  parseOk(
    followup(runId, child.childId, [], {
      LA_PROVIDER: "otherprov",
      LA_PROVIDER_CONFIG: configPath,
      LA_PROVIDER_ENV_FILE: envPath,
      MOCK_CLAUDE_ENV_FILE: envFile,
    }),
  );
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const childEnv = lastRecordedEnv(envFile);
  if (childEnv.ANTHROPIC_BASE_URL !== "http://127.0.0.1:9443/api") {
    fail(`resumed base URL: ${childEnv.ANTHROPIC_BASE_URL} — the pinned model would run on the wrong endpoint`);
  }
  if (childEnv.LA_PROVIDER !== "mockprov") fail(`resumed LA_PROVIDER: ${childEnv.LA_PROVIDER}`);
});

test("a legacy registry entry without provider resolves the currently active provider", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const { configPath, envPath } = twoProviderFixture();
  const envFile = join(runDir(runId), "env.log");

  const child = spawnChild(runId, repo, {
    LA_PROVIDER: "mockprov",
    LA_PROVIDER_CONFIG: configPath,
    LA_PROVIDER_ENV_FILE: envPath,
    MOCK_CLAUDE_ENV_FILE: envFile,
  });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  // A child spawned before this slice: the registry entry carries no `provider`.
  const registry = readRegistry(runId);
  delete registry.children[child.childId].provider;
  writeRegistry(runId, registry);

  parseOk(
    followup(runId, child.childId, [], {
      LA_PROVIDER: "otherprov",
      LA_PROVIDER_CONFIG: configPath,
      LA_PROVIDER_ENV_FILE: envPath,
      MOCK_CLAUDE_ENV_FILE: envFile,
    }),
  );
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const childEnv = lastRecordedEnv(envFile);
  if (childEnv.LA_PROVIDER !== "otherprov") fail(`legacy resume LA_PROVIDER: ${childEnv.LA_PROVIDER}`);
  if (childEnv.ANTHROPIC_BASE_URL !== "http://127.0.0.1:9553/api") {
    fail(`legacy resume base URL: ${childEnv.ANTHROPIC_BASE_URL}`);
  }
});

test("a provider resolution failure on resume refuses before any turn starts", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const child = spawnChild(runId, repo);
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const registry = readRegistry(runId);
  registry.children[child.childId].provider = "does-not-exist";
  writeRegistry(runId, registry);

  const turnsBefore = readRegistry(runId).children[child.childId].turns.length;
  const out = parseRefusal(followup(runId, child.childId, [], { LA_PROVIDER: "does-not-exist" }));
  if (out.reason !== "provider-resolution-failed") fail(`expected a named refusal, got: ${JSON.stringify(out)}`);
  if (!/does-not-exist/.test(out.error)) fail(`the error does not name the provider: ${out.error}`);
  const turnsAfter = readRegistry(runId).children[child.childId].turns.length;
  if (turnsAfter !== turnsBefore) fail(`a turn was appended anyway (${turnsBefore} → ${turnsAfter})`);
});

// ── auto-focus (FOC-769) ─────────────────────────────────────────────────────
console.log("\nauto-focus");

// Same seam as the spawn tests: the focus declaration writes into the state
// home, so these tests point LA_SUPERVISOR_STATE_HOME at a temp tree (restored
// in `finally`) and use run ids that match RUN_ID_RE.
function withFocusHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "la-sup-fu-focus-"));
  cleanup.push(home);
  const prev = process.env.LA_SUPERVISOR_STATE_HOME;
  process.env.LA_SUPERVISOR_STATE_HOME = home;
  try {
    fn(home);
  } finally {
    if (prev === undefined) delete process.env.LA_SUPERVISOR_STATE_HOME;
    else process.env.LA_SUPERVISOR_STATE_HOME = prev;
  }
}

test("a launched follow-up turn declares the child's ticket as the focus (source followup)", () => {
  withFocusHome((home) => {
    const repo = fixtureRepo();
    const runId = fixtureRun({ runId: validRunId(1) });

    // Turn 0 declares FOC-123 (source spawn). Move the focus aside, so the
    // follow-up's own declaration is a real CHANGE and its line is appended —
    // a same-focus follow-up dedups to changed:false and writes nothing.
    const child = spawnChild(runId, repo, { MOCK_CLAUDE_HANG_MS: "0" });
    waitForStatus(runId, child.childId, ["exited", "crashed"]);
    execFileSync(process.execPath, [FOCUS, "set", "overhead", "--run", runId], {
      encoding: "utf8",
      env: baseEnv(),
    });

    const out = parseOk(followup(runId, child.childId, [], { MOCK_CLAUDE_HANG_MS: "0" }));
    waitForStatus(runId, child.childId, ["exited", "crashed"]);

    if (!out.focus || out.focus.changed !== true || out.focus.taskId !== "FOC-123") {
      fail(`the follow-up did not declare the focus: ${JSON.stringify(out.focus)}`);
    }
    if (out.focusError !== undefined) fail(`the follow-up reported a focus error: ${out.focusError}`);
    const { current, history } = readFocus(runId, { stateHome: home });
    if (!current || current.taskId !== "FOC-123" || current.source !== "followup") {
      fail(`focus.jsonl does not carry the followup declaration: ${JSON.stringify(current)}`);
    }
    if (history.length !== 3) fail(`expected 3 focus lines (spawn, overhead, followup), got ${history.length}`);
  });
});

test("a follow-up whose child has no ticket-shaped taskId still succeeds", () => {
  withFocusHome((home) => {
    const repo = fixtureRepo();
    const runId = fixtureRun({ runId: validRunId(2) });
    const now = new Date().toISOString();
    writeRegistry(runId, {
      runId,
      children: {
        "dev-9": {
          childId: "dev-9", squad: "dev", taskId: "not-a-ticket", sessionId: "sess-9",
          status: "exited", worktree: repo,
          turns: [{ pid: null, startedAt: now, endedAt: now, exitCode: 0 }],
        },
      },
      rounds: {},
    });

    const out = parseOk(followup(runId, "dev-9", [], { MOCK_CLAUDE_HANG_MS: "0" }));
    waitForStatus(runId, "dev-9", ["exited", "crashed"]);

    if (out.focus !== undefined) fail(`a focus was declared for a non-ticket: ${JSON.stringify(out.focus)}`);
    if (out.focusError !== undefined) fail(`the skip was reported as an error: ${out.focusError}`);
    if (readFocus(runId, { stateHome: home }).history.length) fail("a focus line was written anyway");
  });
});

// ── pending runtime return (causal return evidence) ──────────────────────────
// The verdict flow sets pendingRuntimeReturn on the dev child after a FAIL
// round; the follow-up carries it to the child env (FENIX_RUNTIME_RETURN) and
// the SessionStart hook records return_to_dev from it. This file owns the
// launch-side contract: the pending must survive the launch untouched — it
// used to be cleared in the same patch that opened the turn, so a launch that
// died before the hook fired took the only copy of the evidence with it.
console.log("\nthe pending runtime return survives the launch");

test("a pending runtimeReturn is retained across the follow-up, not cleared at launch", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const envFile = join(runDir(runId), "env.log");
  const child = spawnChild(runId, repo, {
    FENIX_SUPERVISOR_SESSION_ID: "sup-session-0001",
    MOCK_CLAUDE_ENV_FILE: envFile,
  });
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  // The verdict shape (supervisor-verdict.mjs sets exactly this).
  const pending = {
    sourceAttemptId: readRegistry(runId).children[child.childId].attemptId,
    source: "review",
    reason: "rejected",
    evidenceRef: `${runId}:verdict:FOC-123:1`,
    evidenceKind: "direct",
  };
  const reg = readRegistry(runId);
  reg.children[child.childId].pendingRuntimeReturn = pending;
  writeRegistry(runId, reg);

  const out = parseOk(followup(runId, child.childId, [], { MOCK_CLAUDE_ENV_FILE: envFile }));
  waitForStatus(runId, child.childId, ["exited", "crashed"]);

  const entry = readRegistry(runId).children[child.childId];
  if (JSON.stringify(entry.pendingRuntimeReturn) !== JSON.stringify(pending)) {
    fail(`the pending return was consumed or mutated at launch: ${JSON.stringify(entry.pendingRuntimeReturn)}`);
  }
  if (entry.turns.length !== 2) fail(`the follow-up did not add a turn (${entry.turns.length})`);
  // The launched turn's env must carry the pending verbatim — that env is what
  // the SessionStart hook reads to record return_to_dev.
  const childEnv = JSON.parse(readFileSync(envFile, "utf8").trim().split("\n").pop());
  if (childEnv.FENIX_RUNTIME_RETURN !== JSON.stringify(pending)) {
    fail(`the turn env lost the pending return: ${JSON.stringify(childEnv.FENIX_RUNTIME_RETURN)}`);
  }
  if (!JSON.parse(childEnv.FENIX_DEPENDS_ON_ATTEMPTS).includes(pending.sourceAttemptId)) {
    fail(`the turn env dependencies lost the returned-from attempt: ${childEnv.FENIX_DEPENDS_ON_ATTEMPTS}`);
  }
  if (out.status !== "running" && out.status !== "exited") fail(`unexpected follow-up status: ${out.status}`);
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
