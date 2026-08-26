// scripts/supervisor-status.test.mjs — the lead's eyes and its only way to wait.
//
// The two properties worth protecting here:
//   · status NEVER probes a process. A dead pid whose watcher has not written an
//     exit must still read as running, because a second source of liveness that
//     disagrees with the first is worse than a stale one that does not.
//   · the stall SLA is wall-clock. Backoff must not be able to stretch it, which
//     means it cannot be implemented as "count the polls".
//
// Run: node scripts/supervisor-status.test.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runDir, teeAbsPath, writeRegistry } from "./supervisor-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const STATUS = join(ROOT, "scripts", "supervisor-status.mjs");
const STOP = join(ROOT, "scripts", "supervisor-stop.mjs");
const MOCK = join(ROOT, "scripts", "mock-claude.mjs");

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

let counter = 0;
function fixtureRun() {
  const runId = `test-st-${process.pid}-${Date.now()}-${counter++}`;
  const dir = runDir(runId);
  mkdirSync(join(dir, "children"), { recursive: true });
  mkdirSync(join(dir, "gates"), { recursive: true });
  writeFileSync(join(dir, "triage.json"), JSON.stringify({ issue: "FOC-123", verdict: "dev" }));
  cleanup.push(dir);
  return runId;
}

function fixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), "la-sup-st-"));
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

const status = (runId, extra = [], env = {}) =>
  spawnSync(process.execPath, [STATUS, "--run", runId, ...extra], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

const parse = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    fail(`stdout was not JSON (exit ${r.status}):\n       ${r.stdout}\n       ${r.stderr}`);
  }
};

// A child entry written by hand, so the test controls status and tee content
// without needing a live process.
function seedChild(runId, { childId = "dev-1", status: st = "running", costUsd = 0, lines = [] } = {}) {
  writeRegistry(runId, {
    runId,
    children: {
      [childId]: {
        childId,
        squad: "dev",
        taskId: "FOC-123",
        sessionId: "sess-1",
        status: st,
        tee: join("children", `${childId}.jsonl`),
        turns: [{ pid: 999999, startedAt: new Date().toISOString(), endedAt: null, exitCode: null }],
        costUsd,
        worktree: ROOT,
      },
    },
    reviewLoopCount: {},
  });
  writeFileSync(teeAbsPath(runId, childId), lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return childId;
}

// ── snapshot ─────────────────────────────────────────────────────────────────
console.log("\nsnapshot");

test("returns the documented shape and totals the cost", () => {
  const runId = fixtureRun();
  seedChild(runId, { costUsd: 0.25 });
  const out = parse(status(runId));

  if (out.mode !== "snapshot") fail(`mode was ${out.mode}`);
  if (!Array.isArray(out.children) || out.children.length !== 1) fail("children missing");
  if (!Array.isArray(out.pendingGates)) fail("pendingGates missing");
  if (out.totals.costUsd !== 0.25) fail(`totals.costUsd was ${out.totals.costUsd}`);
  if (out.totals.live !== 1) fail(`totals.live was ${out.totals.live}`);
});

test("--tail returns the last n parsed events, newest last", () => {
  const runId = fixtureRun();
  seedChild(runId, {
    lines: [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", message: { content: [{ type: "text", text: "one" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "two" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "three" }] } },
    ],
  });
  const out = parse(status(runId, ["--tail", "2"]));
  const events = out.children[0].events;
  if (events.length !== 2) fail(`expected 2 events, got ${events.length}`);
  if (!events[1].text.includes("three")) fail(`last event was ${events[1].text}`);
  if (events[0].type !== "assistant") fail(`type missing: ${JSON.stringify(events[0])}`);
});

test("truncates a long snippet to 200 characters", () => {
  const runId = fixtureRun();
  seedChild(runId, {
    lines: [{ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1000) }] } }],
  });
  const out = parse(status(runId, ["--tail", "1"]));
  if (out.children[0].events[0].text.length !== 200) {
    fail(`snippet was ${out.children[0].events[0].text.length} chars`);
  }
});

test("--child narrows to one child", () => {
  const runId = fixtureRun();
  seedChild(runId, { childId: "dev-1" });
  const out = parse(status(runId, ["--child", "dev-1"]));
  if (out.children.length !== 1 || out.children[0].childId !== "dev-1") fail("filter did not apply");
});

test("an unparsable tee line is surfaced, not swallowed", () => {
  const runId = fixtureRun();
  const childId = seedChild(runId);
  writeFileSync(teeAbsPath(runId, childId), "this is not json\n");
  const out = parse(status(runId, ["--tail", "5"]));
  if (out.children[0].events[0].type !== "unparsed") fail("a corrupt line disappeared from the tail");
});

// ── redaction ────────────────────────────────────────────────────────────────
console.log("\nredaction of printed snippets");

test("scrubs keys, bearer tokens and passwords before printing", () => {
  const runId = fixtureRun();
  const secrets = "sk-abc123456789 lin_api_9876543210 api_key=supersecret Bearer tok_9999 password=hunter2";
  seedChild(runId, {
    lines: [{ type: "assistant", message: { content: [{ type: "text", text: secrets }] } }],
  });
  const raw = status(runId, ["--tail", "1"]).stdout;

  for (const leak of ["sk-abc123456789", "lin_api_9876543210", "supersecret", "tok_9999", "hunter2"]) {
    if (raw.includes(leak)) fail(`"${leak}" reached the operator's screen`);
  }
  if (!raw.includes("***")) fail("nothing was redacted at all");
});

test("the tee on disk stays unredacted — it is the debugging record", () => {
  const runId = fixtureRun();
  const childId = seedChild(runId, {
    lines: [{ type: "assistant", message: { content: [{ type: "text", text: "sk-abc123456789" }] } }],
  });
  status(runId, ["--tail", "1"]);
  if (!readFileSync(teeAbsPath(runId, childId), "utf8").includes("sk-abc123456789")) {
    fail("status mutated the tee — it must be read-only");
  }
});

test("redacts gate summaries too", () => {
  const runId = fixtureRun();
  seedChild(runId);
  writeFileSync(
    join(runDir(runId), "gates", "g1.json"),
    JSON.stringify({ gateId: "g1", status: "pending", kind: "question", summary: "token is sk-leak99999", questions: [] }),
  );
  if (status(runId).stdout.includes("sk-leak99999")) fail("a gate summary leaked a key");
});

// ── liveness comes from the registry only ────────────────────────────────────
console.log("\nno process probing");

test("a dead pid still reads as running until the watcher says otherwise", () => {
  // pid 999999 does not exist. If status probed processes it would report this
  // child as gone; the contract is that only the watcher writes liveness.
  const runId = fixtureRun();
  seedChild(runId, { status: "running" });
  const out = parse(status(runId));
  if (out.children[0].status !== "running") {
    fail(`status second-guessed the watcher and reported "${out.children[0].status}"`);
  }
});

// ── stall SLA ────────────────────────────────────────────────────────────────
console.log("\nstall is wall-clock, not a poll count");

test("a silent live child trips the stall threshold", () => {
  const runId = fixtureRun();
  const childId = seedChild(runId, {
    status: "running",
    lines: [{ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }],
  });
  // Backdate the tee well past 5 x base poll (base 100 ms here -> 500 ms).
  const old = new Date(Date.now() - 60_000);
  utimesSync(teeAbsPath(runId, childId), old, old);

  const out = parse(status(runId, [], { LA_SUPERVISOR_POLL_MS: "100" }));
  if (!out.children[0].stalled) fail(`silentMs=${out.children[0].silentMs} did not trip stalled`);
  if (out.stallSilenceMs !== 500) fail(`threshold was ${out.stallSilenceMs}, expected 5 x base`);
});

test("the threshold scales with the base timeout — one constant, not two", () => {
  const runId = fixtureRun();
  const childId = seedChild(runId, { status: "running", lines: [{ type: "system", subtype: "init" }] });
  const old = new Date(Date.now() - 60_000);
  utimesSync(teeAbsPath(runId, childId), old, old);

  // Same 60 s of silence, a base big enough that 5x has not elapsed.
  const out = parse(status(runId, [], { LA_SUPERVISOR_POLL_MS: "600000" }));
  if (out.children[0].stalled) fail("stalled tripped below its own threshold");
});

test("stall is wall-clock, so backoff cannot stretch the kill SLA", () => {
  // The cadence tells the lead to back off x1, x2, x4 on timeout. If the stall
  // threshold counted POLLS, or summed the backed-off waits, a lead that backed
  // off would buy a stalled child extra life — exactly when it should be killed
  // sooner. The threshold is 5 x the BASE timeout in wall-clock, and the number
  // of calls that happened in between is irrelevant.
  const runId = fixtureRun();
  const childId = seedChild(runId, { status: "running", lines: [{ type: "system", subtype: "init" }] });
  const old = new Date(Date.now() - 60_000);
  utimesSync(teeAbsPath(runId, childId), old, old);

  // Base 10 s => threshold 50 s. 60 s of silence is past it.
  const first = parse(status(runId, [], { LA_SUPERVISOR_POLL_MS: "10000" }));
  if (!first.children[0].stalled) fail("60 s of silence did not trip a 50 s threshold");
  if (first.stallSilenceMs !== 50_000) fail(`stallSilenceMs was ${first.stallSilenceMs}`);

  // Same child, same silence, asked again as a backed-off lead would: the
  // verdict must not change, because nothing about the CHILD changed.
  const second = parse(status(runId, [], { LA_SUPERVISOR_POLL_MS: "10000" }));
  if (!second.children[0].stalled) fail("the second call disagreed with the first");
});

test("a finished child is silent by definition, never stalled", () => {
  const runId = fixtureRun();
  const childId = seedChild(runId, { status: "exited", lines: [{ type: "result", subtype: "success" }] });
  const old = new Date(Date.now() - 60_000);
  utimesSync(teeAbsPath(runId, childId), old, old);
  const out = parse(status(runId, [], { LA_SUPERVISOR_POLL_MS: "100" }));
  if (out.children[0].stalled) fail("a completed child was reported as stalled");
});

// ── wait mode ────────────────────────────────────────────────────────────────
console.log("\nwait mode");

test("returns reason=timeout when nothing happens, with a backoff hint", () => {
  const runId = fixtureRun();
  seedChild(runId, { status: "running" });
  const out = parse(status(runId, ["--wait", "--timeout-ms", "1200"]));
  if (out.reason !== "timeout") fail(`reason was ${out.reason}`);
  if (out.mode !== "wait") fail(`mode was ${out.mode}`);
  if (!out.nextBackoffHint) fail("no backoff hint for the lead");
});

test("returns reason=idle, immediately, when nothing is live", () => {
  // The child finished before the lead got round to waiting — the ordinary case
  // for a fast turn, since spawn returns at system/init and the child may be
  // done microseconds later. Without this the wait burns its full timeout and
  // reports `timeout`, which the cadence answers with a backoff: up to 4x the
  // base timeout spent waiting on someone who already left.
  const runId = fixtureRun();
  seedChild(runId, { status: "exited" });
  const t0 = Date.now();
  const out = parse(status(runId, ["--wait", "--timeout-ms", "8000"]));
  const elapsed = Date.now() - t0;
  if (out.reason !== "idle") fail(`reason was ${out.reason}`);
  if (elapsed > 4000) fail(`waited ${elapsed} ms for a child that had already exited`);
  if (out.mode !== "wait") fail(`mode was ${out.mode}`);
});

test("a standing gate with no live child is idle too, and still reported", () => {
  // Nothing writes a gate answer except the lead, so waiting on one while no
  // child runs is waiting on itself.
  const runId = fixtureRun();
  seedChild(runId, { status: "exited" });
  writeFileSync(
    join(runDir(runId), "gates", "standing.json"),
    JSON.stringify({ gateId: "standing", status: "pending", kind: "question", summary: "waiting", questions: ["?"] }),
  );
  const out = parse(status(runId, ["--wait", "--timeout-ms", "8000"]));
  if (out.reason !== "idle") fail(`reason was ${out.reason}`);
  if (!out.pendingGates.some((g) => g.gateId === "standing")) fail("the standing gate must stay in the payload");
});

test("returns reason=exit when a live child finishes during the wait", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun();
  const child = parse(
    spawnSync(
      process.execPath,
      [SPAWN, "--run", runId, "--squad", "dev", "--task", "FOC-123", "--prompt", "k", "--repo", repo],
      {
        encoding: "utf8",
        env: { ...process.env, LA_CLAUDE_BIN: MOCK, LA_SUPERVISOR_NO_TELEMETRY: "1", MOCK_CLAUDE_HANG_MS: "1500" },
      },
    ),
  );
  const out = parse(status(runId, ["--wait", "--timeout-ms", "15000"]));
  if (out.reason !== "exit") fail(`reason was ${out.reason} (child status ${out.children[0].status})`);
  spawnSync(process.execPath, [STOP, "--run", runId, "--child", child.childId], { encoding: "utf8" });
});

test("returns reason=gate when a pending gate appears mid-wait", () => {
  const runId = fixtureRun();
  seedChild(runId, { status: "running" });
  const gateFile = join(runDir(runId), "gates", "g-new.json");

  // Detached writer: the gate must appear WHILE the wait is blocked, otherwise
  // it is already in the baseline and correctly ignored.
  const writer = spawn(
    process.execPath,
    [
      "-e",
      `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(gateFile)}, JSON.stringify({gateId:'g-new',status:'pending',kind:'question',summary:'need an answer',questions:['?']})),800)`,
    ],
    { detached: true, stdio: "ignore" },
  );
  writer.unref();

  const out = parse(status(runId, ["--wait", "--timeout-ms", "10000"]));
  if (out.reason !== "gate") fail(`reason was ${out.reason}`);
  if (!out.pendingGates.some((g) => g.gateId === "g-new")) fail("the gate is not in the payload");
});

test("a gate already pending before the wait does not fire it", () => {
  // Otherwise every wait after an unanswered gate returns instantly and the
  // lead spins.
  const runId = fixtureRun();
  seedChild(runId, { status: "running" });
  writeFileSync(
    join(runDir(runId), "gates", "old.json"),
    JSON.stringify({ gateId: "old", status: "pending", kind: "question", summary: "stale", questions: [] }),
  );
  const out = parse(status(runId, ["--wait", "--timeout-ms", "1200"]));
  if (out.reason !== "timeout") fail(`a pre-existing gate fired the wait (reason ${out.reason})`);
  if (!out.pendingGates.length) fail("the standing gate should still be reported");
});

test("names stalled children on every wait result", () => {
  const runId = fixtureRun();
  const childId = seedChild(runId, { status: "running", lines: [{ type: "system", subtype: "init" }] });
  const old = new Date(Date.now() - 60_000);
  utimesSync(teeAbsPath(runId, childId), old, old);

  const out = parse(status(runId, ["--wait", "--timeout-ms", "1000"], { LA_SUPERVISOR_POLL_MS: "100" }));
  if (!out.stalledChildren.includes(childId)) fail("a stalled child was not named in the wait result");
});

test("refuses an unknown run rather than reporting an empty one", () => {
  const r = status("no-such-run-12345");
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  if (!parse(r).error.includes("no such run")) fail("unhelpful error");
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
