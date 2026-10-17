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
import { createTaskSessionStore } from "./task-sessions.mjs";

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
    env: { ...process.env, OPENROUTER_API_KEY: "test-supervisor-provider-key", ...env },
  });

const parse = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    fail(`stdout was not JSON (exit ${r.status}):\n       ${r.stdout}\n       ${r.stderr}`);
  }
};

// A valid holds.json store, written directly — same shape the gate CLI writes
// (validated by readHolds on the status side), without needing the pricing
// fixture the CLI demands. `over` overrides fields on the first hold.
function writeHoldsFixture(runId, holds = [holdFixture()]) {
  writeFileSync(join(runDir(runId), "holds.json"), JSON.stringify({ version: 1, holds }));
}
function holdFixture(over = {}) {
  return {
    id: "hold-1",
    origin: "ownership",
    question: "FOC-999 belongs to another owner — take it anyway?",
    options: [{ label: "skip to the next own ticket", model: "test/priced-model", costUsd: 0 }],
    recommendation: "continue with the next ticket of your own projects",
    impact: "medium",
    resolution: null,
    state: "open",
    createdAt: "2026-10-15T00:00:00Z",
    presentedAt: null,
    until: null,
    answer: null,
    blocks: null,
    history: [{ event: "created", at: "2026-10-15T00:00:00Z" }],
    ...over,
  };
}

// A child entry written by hand, so the test controls status and tee content
// without needing a live process.
function seedChild(runId, { childId = "dev-1", status: st = "running", costUsd = 0, lines = [], turnStartedAt = new Date().toISOString(), turns, model, modelSource } = {}) {
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
        turns: turns ?? [{ pid: 999999, startedAt: turnStartedAt, endedAt: null, exitCode: null }],
        costUsd,
        worktree: ROOT,
        ...(model !== undefined ? { model } : {}),
        ...(modelSource !== undefined ? { modelSource } : {}),
      },
    },
    rounds: {},
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
  // Backdate the tee AND the turn (FOC-271: silence runs from the latest of
  // both) well past 5 x base poll (base 100 ms here -> 500 ms). The scenario is
  // a turn that has been running for a minute without a byte.
  const old = new Date(Date.now() - 60_000);
  const childId = seedChild(runId, {
    status: "running",
    lines: [{ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }],
    turnStartedAt: old.toISOString(),
  });
  utimesSync(teeAbsPath(runId, childId), old, old);

  const out = parse(status(runId, [], { LA_SUPERVISOR_POLL_MS: "100" }));
  if (!out.children[0].stalled) fail(`silentMs=${out.children[0].silentMs} did not trip stalled`);
  if (out.stallSilenceMs !== 500) fail(`threshold was ${out.stallSilenceMs}, expected 5 x base`);
});

test("the threshold scales with the base timeout — one constant, not two", () => {
  const runId = fixtureRun();
  const old = new Date(Date.now() - 60_000);
  const childId = seedChild(runId, { status: "running", lines: [{ type: "system", subtype: "init" }], turnStartedAt: old.toISOString() });
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
  const old = new Date(Date.now() - 60_000);
  const childId = seedChild(runId, { status: "running", lines: [{ type: "system", subtype: "init" }], turnStartedAt: old.toISOString() });
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

test("a turn that just started is never stalled on its predecessor's silence", () => {
  // FOC-271 (2). A resume can start long after the previous turn's last tee
  // write — the observed case was a child resumed >10 min later showing
  // `stalled: true` from its first snapshot until its first new byte. Silence
  // is wall-clock from the LATEST of the tee write and the live turn's start,
  // so a fresh turn is quiet-but-alive, not stalled.
  const runId = fixtureRun();
  const childId = seedChild(runId, {
    status: "running",
    lines: [{ type: "system", subtype: "init" }],
    turnStartedAt: new Date().toISOString(),
  });
  // The tee still holds the PREVIOUS turn's last write: 20 min old, far past
  // any threshold this test could set.
  const old = new Date(Date.now() - 1_200_000);
  utimesSync(teeAbsPath(runId, childId), old, old);

  const out = parse(status(runId, [], { LA_SUPERVISOR_POLL_MS: "100" }));
  if (out.children[0].stalled) fail(`a just-started turn was reported stalled (silentMs=${out.children[0].silentMs})`);
  if (!(out.children[0].silentMs < 60_000)) {
    fail(`silentMs=${out.children[0].silentMs} still counts the predecessor's silence`);
  }
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
        env: { ...process.env, OPENROUTER_API_KEY: "test-supervisor-provider-key", LA_CLAUDE_BIN: MOCK, LA_SUPERVISOR_NO_TELEMETRY: "1", LA_SUPERVISOR_NO_CODEGRAPH: "1", MOCK_CLAUDE_HANG_MS: "1500" },
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
  const old = new Date(Date.now() - 60_000);
  const childId = seedChild(runId, { status: "running", lines: [{ type: "system", subtype: "init" }], turnStartedAt: old.toISOString() });
  utimesSync(teeAbsPath(runId, childId), old, old);

  const out = parse(status(runId, ["--wait", "--timeout-ms", "1000"], { LA_SUPERVISOR_POLL_MS: "100" }));
  if (!out.stalledChildren.includes(childId)) fail("a stalled child was not named in the wait result");
});

test("refuses an unknown run rather than reporting an empty one", () => {
  const r = status("no-such-run-12345");
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}`);
  if (!parse(r).error.includes("no such run")) fail("unhelpful error");
});

// ── focus and unverified legacy costs (FOC-769 / FOC-760) ────────────────────
console.log("\nfocus and unverified legacy costs");

test("carries the declared focus and its one-line summary", () => {
  const runId = fixtureRun();
  seedChild(runId);
  writeFileSync(
    join(runDir(runId), "focus.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), kind: "ticket", taskId: "FOC-123", source: "spawn" }) + "\n",
  );
  const out = parse(status(runId));
  if (!out.focus || out.focus.taskId !== "FOC-123" || out.focus.kind !== "ticket") {
    fail(`focus missing: ${JSON.stringify(out.focus)}`);
  }
  if (!/^Focus: FOC-123 since \d{2}:\d{2} \(spawn\)$/.test(out.focusLine)) fail(`focusLine was ${out.focusLine}`);
});

test("no focus declared says so and names the command that declares one", () => {
  const runId = fixtureRun();
  seedChild(runId);
  const out = parse(status(runId));
  if (out.focus !== null) fail(`focus was ${JSON.stringify(out.focus)}`);
  if (!out.focusLine.includes("none declared") || !out.focusLine.includes("supervisor-focus.mjs")) {
    fail(`focusLine was ${out.focusLine}`);
  }
});

test("the briefing carries the focus too, overhead spelled out", () => {
  const runId = fixtureRun();
  seedChild(runId, { status: "exited" });
  writeFileSync(
    join(runDir(runId), "focus.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), kind: "overhead", taskId: null, source: "manual" }) + "\n",
  );
  const out = parse(status(runId, ["--briefing"]));
  if (!out.focus || out.focus.kind !== "overhead" || out.focus.taskId !== null) {
    fail(`briefing focus was ${JSON.stringify(out.focus)}`);
  }
  if (!/^Focus: overhead since \d{2}:\d{2} \(manual\)$/.test(out.focusLine)) fail(`briefing focusLine was ${out.focusLine}`);
});

test("legacy-unverified children are named beside the total, not excluded from it", () => {
  const runId = fixtureRun();
  seedChild(runId, { childId: "dev-1", costUsd: 0.25 });
  const registryPath = join(runDir(runId), "children.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  registry.children["dev-2"] = {
    ...registry.children["dev-1"],
    childId: "dev-2",
    tee: join("children", "dev-2.jsonl"),
    costUsd: 1.5,
    costSource: "legacy-unverified",
  };
  writeFileSync(registryPath, JSON.stringify(registry));
  writeFileSync(teeAbsPath(runId, "dev-2"), "");

  const r = status(runId);
  const out = parse(r);
  if (JSON.stringify(out.totals.unverifiedCostChildren) !== JSON.stringify(["dev-2"])) {
    fail(`unverifiedCostChildren was ${JSON.stringify(out.totals.unverifiedCostChildren)}`);
  }
  // The total keeps summing every entry as it stands — the note never edits it.
  if (out.totals.costUsd !== 1.75) fail(`totals.costUsd was ${out.totals.costUsd}`);
  if (!r.stderr.includes("cost includes 1 unverified legacy figure(s): dev-2")) {
    fail(`stderr did not name the unverified child: ${r.stderr}`);
  }
});

// ── task-session leases in the briefing (FOC-902) ────────────────────────────
console.log("\nbriefing leases (FOC-902)");

// The DEAD_PID fixture proven safe on this host (fenix-doctor.test.mjs): a pid
// that never exists, so pidAlive reports it dead and the lease reads stale.
const DEAD_PID = 2 ** 22 + 12345;

// A private LA_DATA_HOME holding a seeded task-session store, so the dev
// machine's real store never decides a test's verdict.
function leaseHome() {
  const home = mkdtempSync(join(tmpdir(), "la-sup-st-lease-"));
  cleanup.push(home);
  return home;
}

function seedHolder(home, taskKey, pid) {
  const store = createTaskSessionStore({ dbPath: join(home, "supervisor", "task-sessions.sqlite") });
  try {
    const s = store.ensure({
      taskKey,
      taskId: taskKey.split(":")[1],
      workspace: taskKey.split(":")[0],
      issueId: taskKey.split(":")[1],
    });
    if (store.claimNext().sessionId !== s.sessionId) fail(`${taskKey}: claimNext must promote its only row`);
    store.update(s.sessionId, { status: "running", pid });
    return s.sessionId;
  } finally {
    store.close();
  }
}

test("the briefing names the leases: mine, others, and the stale ones", () => {
  const runId = fixtureRun();
  const home = leaseHome();
  const mine = seedHolder(home, "jointhubs:FOC-111", process.pid);
  const other = seedHolder(home, "jointhubs:FOC-222", DEAD_PID);
  const out = parse(status(runId, ["--briefing"], { LA_DATA_HOME: home, FENIX_SUPERVISOR_SESSION_ID: mine }));
  if (JSON.stringify(out.leases.mine) !== JSON.stringify({ taskKey: "jointhubs:FOC-111", sessionId: mine, status: "running" })) {
    fail(`leases.mine was ${JSON.stringify(out.leases.mine)}`);
  }
  if (JSON.stringify(out.leases.others) !== JSON.stringify([{ sessionId: other, taskKey: "jointhubs:FOC-222", status: "running", live: false }])) {
    fail(`leases.others was ${JSON.stringify(out.leases.others)}`);
  }
  const line = `Leases: mine jointhubs:FOC-111 (${mine}, running); others: jointhubs:FOC-222 (${other}, running, stale)`;
  if (out.leasesLine !== line) fail(`leasesLine was ${out.leasesLine}`);
});

test("others-only: without a session id the briefing claims nothing as mine", () => {
  const runId = fixtureRun();
  const home = leaseHome();
  const other = seedHolder(home, "jointhubs:FOC-333", process.pid);
  const out = parse(status(runId, ["--briefing"], { LA_DATA_HOME: home }));
  if (out.leases.mine !== null) fail(`leases.mine was ${JSON.stringify(out.leases.mine)}`);
  if (out.leases.others.length !== 1 || out.leases.others[0].sessionId !== other || out.leases.others[0].live !== true) {
    fail(`leases.others was ${JSON.stringify(out.leases.others)}`);
  }
  if (out.leasesLine !== `Leases: others: jointhubs:FOC-333 (${other}, running)`) fail(`leasesLine was ${out.leasesLine}`);
});

test("a terminal-only store reads as no leases at all", () => {
  const runId = fixtureRun();
  const home = leaseHome();
  const sid = seedHolder(home, "jointhubs:FOC-444", process.pid);
  const store = createTaskSessionStore({ dbPath: join(home, "supervisor", "task-sessions.sqlite") });
  try {
    store.update(sid, { status: "completed" });
  } finally {
    store.close();
  }
  const out = parse(status(runId, ["--briefing"], { LA_DATA_HOME: home, FENIX_SUPERVISOR_SESSION_ID: sid }));
  if (out.leases === null) fail("an existing store must never read as missing");
  if (out.leases.mine !== null || out.leases.others.length !== 0) {
    fail(`terminal rows leaked into leases: ${JSON.stringify(out.leases)}`);
  }
  if (out.leasesLine !== "Leases: none") fail(`leasesLine was ${out.leasesLine}`);
});

test("no store — or an unreadable one — reads as no managed sessions", () => {
  const runId = fixtureRun();
  const out = parse(status(runId, ["--briefing"], { LA_DATA_HOME: leaseHome() }));
  if (out.leases !== null) fail(`missing store gave ${JSON.stringify(out.leases)}`);
  if (out.leasesLine !== "Leases: no managed sessions") fail(`leasesLine was ${out.leasesLine}`);

  // A corrupt store is "unknown", not "empty" — the briefing never guesses.
  const home = leaseHome();
  mkdirSync(join(home, "supervisor"), { recursive: true });
  writeFileSync(join(home, "supervisor", "task-sessions.sqlite"), "not a sqlite database at all. ".repeat(8), "utf8");
  const out2 = parse(status(runId, ["--briefing"], { LA_DATA_HOME: home }));
  if (out2.leases !== null) fail(`corrupt store gave ${JSON.stringify(out2.leases)}`);
  if (out2.leasesLine !== "Leases: no managed sessions") fail(`leasesLine was ${out2.leasesLine}`);
});

// ── the task journal in the briefing (FOC-904) ───────────────────────────────
console.log("\nbriefing: task journal");

test("the briefing carries the task journal when LA_TASK_ID is set and the file exists", () => {
  const runId = fixtureRun();
  seedChild(runId, { status: "exited" });
  const root = mkdtempSync(join(tmpdir(), "la-journal-br-"));
  cleanup.push(root);
  mkdirSync(join(root, "docs", "state"), { recursive: true });
  writeFileSync(
    join(root, "docs", "state", "FOC-904.md"),
    "# FOC-904 — journal\n\nTask: FOC-904\nSession: -\nRun: -\nBranch: -\nPR: -\nStatus: in progress\n\n## 2026-10-16 10:00 — first\n\nbody\n\n## 2026-10-16 11:00 — second\n\nbody\n",
    "utf8",
  );
  const out = parse(status(runId, ["--briefing"], { LA_ROOT: root, LA_TASK_ID: "FOC-904" }));
  if (
    !out.journal ||
    out.journal.path !== "docs/state/FOC-904.md" ||
    out.journal.entries !== 2 ||
    out.journal.lastAt !== "2026-10-16 11:00"
  ) {
    fail(`journal was ${JSON.stringify(out.journal)}`);
  }
  if (!/^Journal: docs\/state\/FOC-904\.md \(2 entries, last 2026-10-16 11:00\)$/.test(out.journalLine)) {
    fail(`journalLine was ${out.journalLine}`);
  }
});

test("LA_TASK_ID set but no journal yet — the line names the init command", () => {
  const runId = fixtureRun();
  seedChild(runId, { status: "exited" });
  const out = parse(status(runId, ["--briefing"], { LA_TASK_ID: "FOC-904" }));
  if (out.journal !== null) fail(`journal was ${JSON.stringify(out.journal)}`);
  if (!out.journalLine.includes("none yet") || !out.journalLine.includes("state-journal.mjs init")) {
    fail(`journalLine was ${out.journalLine}`);
  }
});

test("no LA_TASK_ID — no journal and no line; existing fields untouched", () => {
  const runId = fixtureRun();
  seedChild(runId, { status: "exited" });
  const out = parse(status(runId, ["--briefing"]));
  if (out.journal !== null) fail(`journal was ${JSON.stringify(out.journal)}`);
  if (out.journalLine !== null) fail(`journalLine was ${out.journalLine}`);
  if (!out.focusLine) fail("the focus fields disappeared");
});
// ── isolation surfaced (FOC-802) ─────────────────────────────────────────────
console.log("\nisolation surfaced");

// A child with hand-written turns, so the test controls the isolation flags
// without any live spawn.
function seedTurns(runId, turns, { childId = "dev-1" } = {}) {
  const ended = new Date().toISOString();
  writeRegistry(runId, {
    runId,
    children: {
      [childId]: {
        childId,
        squad: "dev",
        taskId: "FOC-123",
        sessionId: "sess-1",
        status: "exited",
        tee: join("children", `${childId}.jsonl`),
        turns: turns.map((isolated) => ({
          pid: 999999,
          startedAt: ended,
          endedAt: ended,
          exitCode: 0,
          isolated,
        })),
        costUsd: 0,
        worktree: ROOT,
      },
    },
    rounds: {},
  });
  return childId;
}

test("the LATEST turn's isolated flag reaches the snapshot", () => {
  const runId = fixtureRun();
  seedTurns(runId, [false, true]);
  const out = parse(status(runId));
  if (out.children[0].isolated !== true) fail(`isolated was ${out.children[0].isolated}`);
});

test("an earlier isolated turn does not mask a later unisolated one", () => {
  const runId = fixtureRun();
  seedTurns(runId, [true, false]);
  const out = parse(status(runId));
  if (out.children[0].isolated !== false) fail(`isolated was ${out.children[0].isolated}`);
});

test("a child with no turns reports isolated: null", () => {
  const runId = fixtureRun();
  seedTurns(runId, []);
  const out = parse(status(runId));
  if (out.children[0].isolated !== null) fail(`isolated was ${out.children[0].isolated}`);
});

test("in container, a child whose latest turn ran unisolated gets a human line", () => {
  const runId = fixtureRun();
  seedTurns(runId, [false]);
  const r = status(runId, [], { FENIX_IN_CONTAINER: "1" });
  if (!r.stderr.includes("isolation: off (dev-1)")) fail(`stderr did not name it: ${r.stderr}`);
  parse(r); // the human line rides stderr; stdout stays parseable JSON
});

test("in container, an isolated child gets no line", () => {
  const runId = fixtureRun();
  seedTurns(runId, [true]);
  const r = status(runId, [], { FENIX_IN_CONTAINER: "1" });
  if (r.stderr.includes("isolation: off")) fail(`stderr: ${r.stderr}`);
});

test("outside the container the line is never printed", () => {
  const runId = fixtureRun();
  seedTurns(runId, [false]);
  const r = status(runId, [], { FENIX_IN_CONTAINER: "" });
  if (r.stderr.includes("isolation: off")) fail(`stderr: ${r.stderr}`);
});

// ── model drift (FOC-607) ────────────────────────────────────────────────────
console.log("\nmodel drift");

test("a served model that differs from the pin is flagged in JSON and on stderr", () => {
  const runId = fixtureRun();
  seedChild(runId, {
    model: "a",
    modelSource: "flag",
    turns: [{ startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: 0, initModel: "b" }],
  });
  const r = status(runId);
  const out = parse(r);
  const c = out.children[0];
  if (c.model !== "a") fail(`model was ${JSON.stringify(c.model)}`);
  if (c.modelSource !== "flag") fail(`modelSource was ${JSON.stringify(c.modelSource)}`);
  if (c.initModel !== "b") fail(`initModel was ${JSON.stringify(c.initModel)}`);
  if (c.modelDrift !== true) fail(`modelDrift was ${c.modelDrift}`);
  if (!r.stderr.includes("model drift: dev-1 requested a, served b")) {
    fail(`stderr did not name the drift: ${r.stderr}`);
  }
});

test("equal requested and served models do not drift", () => {
  const runId = fixtureRun();
  seedChild(runId, {
    model: "a",
    turns: [{ startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: 0, initModel: "a" }],
  });
  const out = parse(status(runId));
  if (out.children[0].modelDrift !== false) fail(`modelDrift was ${out.children[0].modelDrift}`);
  if (out.children[0].initModel !== "a") fail(`initModel was ${JSON.stringify(out.children[0].initModel)}`);
});

test("a child with no turns has no initModel and no drift", () => {
  const runId = fixtureRun();
  seedChild(runId, { model: "a", turns: [] });
  const out = parse(status(runId));
  if (out.children[0].initModel !== null) fail(`initModel was ${JSON.stringify(out.children[0].initModel)}`);
  if (out.children[0].modelDrift !== false) fail(`modelDrift was ${out.children[0].modelDrift}`);
});

// ── briefing holds (FOC-848) ─────────────────────────────────────────────────
console.log("\nbriefing holds");

test("the briefing lists the run's open holds with id and origin", () => {
  const runId = fixtureRun();
  writeHoldsFixture(runId, [
    holdFixture(),
    holdFixture({ id: "hold-2", state: "answered" }), // answered → not open → not listed
  ]);
  const out = parse(status(runId, ["--briefing"]));
  if (!Array.isArray(out.holds) || out.holds.length !== 1) {
    fail(`holds was ${JSON.stringify(out.holds)}`);
  }
  const hold = out.holds[0];
  if (hold.id !== "hold-1") fail(`hold id was ${hold.id}`);
  if (hold.origin !== "ownership") fail(`hold origin was ${hold.origin}`);
  if (hold.impact !== "medium") fail(`hold impact was ${hold.impact}`);
  if (typeof hold.question !== "string" || !hold.question) fail(`question was ${JSON.stringify(hold.question)}`);
  if (!("holdsCount" in out) || out.holdsCount !== 1) fail(`holdsCount was ${out.holdsCount}`);
  if (out.holdsError) fail(`holdsError on a valid store: ${out.holdsError}`);
});

test("a run with no holds.json briefs an empty holds list", () => {
  const runId = fixtureRun();
  const out = parse(status(runId, ["--briefing"]));
  if (JSON.stringify(out.holds) !== "[]") fail(`holds was ${JSON.stringify(out.holds)}`);
  if (out.holdsCount !== 0) fail(`holdsCount was ${out.holdsCount}`);
  if (out.holdsError) fail(`holdsError on a missing store: ${out.holdsError}`);
});

test("a corrupt holds store surfaces holdsError instead of crashing the briefing", () => {
  const runId = fixtureRun();
  writeFileSync(join(runDir(runId), "holds.json"), "{not json");
  const out = parse(status(runId, ["--briefing"]));
  if (out.ok !== true) fail(`the briefing did not survive: ok=${out.ok}`);
  if (!out.holdsError || !/not readable JSON/.test(out.holdsError)) {
    fail(`holdsError was ${JSON.stringify(out.holdsError)}`);
  }
  if (JSON.stringify(out.holds) !== "[]") fail(`holds was ${JSON.stringify(out.holds)}`);
  if (out.holdsCount !== 0) fail(`holdsCount was ${out.holdsCount}`);
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
