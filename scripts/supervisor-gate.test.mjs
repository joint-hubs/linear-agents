// scripts/supervisor-gate.test.mjs — the question survives the process that asked it.
//
// A gate is the only place the Supervisor is allowed to stop and hand a decision
// back to Mateusz, so the failure modes worth failing a build over are the ones
// where a question quietly stops existing:
//
// 1. A REFUSED emit LEAVES NO FILE. A half-written gate is worse than none —
//    `status` would show a pending question with no content, and the Supervisor
//    would have to invent what was being asked, which is the one thing its hard
//    rules forbid.
//
// 2. RECORDED AND DELIVERED STAY IN STEP. `answer` records, followup delivers.
//    Delivering an unrecorded answer leaves the file `pending` forever — the
//    child runs on while the queue still shows an open question. So followup
//    refuses a gate that is not answered yet.
//
// 3. A CHILD THAT STOPPED TO ASK IS NOT A CHILD THAT FINISHED. The watcher has
//    to write `waiting_gate`, and `waiting_gate` has to count as terminal for
//    liveness — otherwise the child is reported as stalled the moment its tee
//    goes quiet, which it always does while waiting on a human.
//
// Run: node scripts/supervisor-gate.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TERMINAL_STATUSES,
  ensureRunDir,
  gatePath,
  gatesDir,
  hasPendingGate,
  runDir,
  writeRegistry,
} from "./supervisor-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(ROOT, "scripts", "supervisor-gate.mjs");
const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const FOLLOWUP = join(ROOT, "scripts", "supervisor-followup.mjs");
const STATUS = join(ROOT, "scripts", "supervisor-status.mjs");
const MOCK = join(ROOT, "scripts", "mock-claude.mjs");

let passed = 0;
const failures = [];

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

const cleanup = [];
process.on("exit", () => {
  for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

let runCounter = 0;
function fixtureRun({ child = true } = {}) {
  const runId = `test-gate-${process.pid}-${runCounter++}`;
  cleanup.push(runDir(runId));
  ensureRunDir(runId);
  writeFileSync(
    join(runDir(runId), "triage.json"),
    JSON.stringify({ issue: "FOC-999", verdict: "dev", node: "dev", confidence: 90 }),
  );
  if (child) {
    writeRegistry(runId, {
      runId,
      children: {
        "dev-1": {
          childId: "dev-1", squad: "dev", taskId: "FOC-999",
          sessionId: "sess-1", status: "exited", turns: [{ pid: 1 }],
          worktree: join(tmpdir(), "fake-worktree"), permissionMode: "bypassPermissions",
        },
      },
      reviewLoopCount: {},
    });
  }
  return runId;
}

function fixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), "la-gate-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git("add", "-A");
  git("commit", "-m", "init");
  cleanup.push(base);
  return repo;
}

const cli = (script, args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, LA_SUPERVISOR_NO_TELEMETRY: "1", ...env },
  });
const gate = (args, env) => cli(GATE, args, env);
const parse = (r) => JSON.parse(r.stdout);
const gateFiles = (runId) => (existsSync(gatesDir(runId)) ? readdirSync(gatesDir(runId)) : []);

// ── 1. emit writes the §2.6 record ────────────────────────────────────────────
console.log("\nemit — zapis rekordu");

test("emit writes a pending gate with every §2.6 field", () => {
  const runId = fixtureRun();
  const r = gate([
    "emit", "--run", runId, "--child", "dev-1", "--kind", "plan.gate1",
    "--summary", "wybór podejścia", "--question", "A czy B?", "--question", "kiedy?",
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = parse(r);
  assert.equal(out.gateId, "gate-dev-1-1");

  const rec = JSON.parse(readFileSync(gatePath(runId, "gate-dev-1-1"), "utf8"));
  assert.deepEqual(Object.keys(rec).sort(), [
    "answer", "artifacts", "childId", "createdAt", "gateId", "kind",
    "questions", "runId", "squad", "status", "summary", "taskId",
  ]);
  assert.equal(rec.status, "pending");
  assert.equal(rec.answer, null);
  // squad and taskId come from the registry — a gate has to say who asked and
  // about what, or it cannot be routed back.
  assert.equal(rec.squad, "dev");
  assert.equal(rec.taskId, "FOC-999");
  assert.deepEqual(rec.questions, ["A czy B?", "kiedy?"]);
});

test("the child reads its identity from the env spawn already sets", () => {
  const runId = fixtureRun();
  const r = gate(["emit", "--kind", "question", "--summary", "s", "--question", "q?"], {
    LA_SUPERVISOR_RUN: runId, LA_SUPERVISOR_CHILD: "dev-1",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(parse(r).childId, "dev-1");
});

test("gate ids count up per child and are sayable", () => {
  // The Supervisor reads these to Mateusz and types them back into `answer`.
  const runId = fixtureRun();
  const emit = () => gate(["emit", "--run", runId, "--child", "dev-1", "--kind", "question", "--summary", "s", "--question", "q"]);
  assert.equal(parse(emit()).gateId, "gate-dev-1-1");
  assert.equal(parse(emit()).gateId, "gate-dev-1-2");
  assert.equal(parse(emit()).gateId, "gate-dev-1-3");
});

test("relative artifact paths resolve against the CHILD's worktree", () => {
  // The child means its own checkout; the Supervisor reads the gate from the
  // main repo, where that same relative path is a different file.
  const runId = fixtureRun();
  const r = gate([
    "emit", "--run", runId, "--child", "dev-1", "--kind", "question",
    "--summary", "s", "--question", "q", "--artifact", "docs/plan.md", "--artifact", join(tmpdir(), "abs.md"),
  ]);
  const rec = parse(r);
  assert.ok(rec.artifacts[0].includes("fake-worktree"), `relative path not resolved: ${rec.artifacts[0]}`);
  assert.equal(rec.artifacts[1], join(tmpdir(), "abs.md"), "an absolute path is left alone");
});

test("a gate with no question still emits, but says why that is bad", () => {
  // Not fatal (the AC requires kind + summary only), but a gate with nothing to
  // answer pushes the Supervisor towards inventing the question.
  const runId = fixtureRun();
  const r = gate(["emit", "--run", runId, "--child", "dev-1", "--kind", "push-approval", "--summary", "gotowe do push"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(parse(r).warnings.length, 1);
  assert.match(r.stderr, /no --question/);
});

// ── 2. a refused emit leaves nothing behind ───────────────────────────────────
console.log("\nemit — odmowa nie zostawia pliku");

test("a bogus kind exits 1 and writes no file", () => {
  const runId = fixtureRun();
  const r = gate(["emit", "--run", runId, "--child", "dev-1", "--kind", "bogus", "--summary", "s"]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /not a known gate kind/);
  assert.deepEqual(gateFiles(runId), [], "a refused emit must leave no gate file");
});

test("missing --kind or --summary exits 1 and writes no file", () => {
  for (const args of [
    ["emit", "--summary", "s", "--question", "q"],
    ["emit", "--kind", "question", "--question", "q"],
  ]) {
    const runId = fixtureRun();
    const r = gate([...args, "--run", runId, "--child", "dev-1"]);
    assert.equal(r.status, 1, args.join(" "));
    assert.deepEqual(gateFiles(runId), [], args.join(" "));
  }
});

test("a child that is not in the registry cannot raise a gate", () => {
  // Nothing could deliver the answer back: there is no session to resume.
  const runId = fixtureRun({ child: false });
  const r = gate(["emit", "--run", runId, "--child", "ghost-9", "--kind", "question", "--summary", "s"]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /not in the registry/);
  assert.deepEqual(gateFiles(runId), []);
});

test("every declared kind is accepted", () => {
  const runId = fixtureRun();
  for (const kind of ["plan.gate1", "plan.gate2", "question", "push-approval", "pr-approval"]) {
    const r = gate(["emit", "--run", runId, "--child", "dev-1", "--kind", kind, "--summary", "s", "--question", "q"]);
    assert.equal(r.status, 0, `${kind}: ${r.stdout}`);
  }
});

// ── 3. answer ─────────────────────────────────────────────────────────────────
console.log("\nanswer");

function seedGate(runId, extra = {}) {
  const r = gate(["emit", "--run", runId, "--child", "dev-1", "--kind", "question", "--summary", "s", "--question", "q?"]);
  const id = parse(r).gateId;
  if (Object.keys(extra).length) {
    const rec = { ...JSON.parse(readFileSync(gatePath(runId, id), "utf8")), ...extra };
    writeFileSync(gatePath(runId, id), JSON.stringify(rec));
  }
  return id;
}

test("answer flips the record to answered with the text and a timestamp", () => {
  const runId = fixtureRun();
  const id = seedGate(runId);
  const r = gate(["answer", "--run", runId, "--gate", id, "--text", "rób A"]);
  assert.equal(r.status, 0, r.stdout);
  const rec = JSON.parse(readFileSync(gatePath(runId, id), "utf8"));
  assert.equal(rec.status, "answered");
  assert.equal(rec.answer.text, "rób A");
  assert.ok(rec.answer.answeredAt, "answeredAt is what makes the audit trail a timeline");
  // Recording is not delivering — the response has to say so out loud.
  assert.match(parse(r).next, /supervisor-followup\.mjs/);
});

test("answering twice is refused — a gate is answered once", () => {
  const runId = fixtureRun();
  const id = seedGate(runId);
  assert.equal(gate(["answer", "--run", runId, "--gate", id, "--text", "pierwsza"]).status, 0);
  const second = gate(["answer", "--run", runId, "--gate", id, "--text", "druga"]);
  assert.equal(second.status, 1);
  assert.match(parse(second).error, /already answered/);
  // The first answer must still be the one on disk.
  assert.equal(JSON.parse(readFileSync(gatePath(runId, id), "utf8")).answer.text, "pierwsza");
});

test("answering a gate that does not exist lists the ones that do", () => {
  const runId = fixtureRun();
  const id = seedGate(runId);
  const r = gate(["answer", "--run", runId, "--gate", "gate-dev-1-99", "--text", "x"]);
  assert.equal(r.status, 1);
  assert.deepEqual(parse(r).known, [id]);
});

test("answer requires --gate and --text", () => {
  const runId = fixtureRun();
  seedGate(runId);
  assert.equal(gate(["answer", "--run", runId, "--text", "x"]).status, 1);
  assert.equal(gate(["answer", "--run", runId, "--gate", "gate-dev-1-1"]).status, 1);
});

// ── 4. list ───────────────────────────────────────────────────────────────────
console.log("\nlist");

test("list filters by status and by child, and always counts both", () => {
  const runId = fixtureRun();
  const a = seedGate(runId);
  const b = seedGate(runId);
  gate(["answer", "--run", runId, "--gate", a, "--text", "ok"]);

  const pending = parse(gate(["list", "--run", runId, "--status", "pending"]));
  assert.deepEqual(pending.gates.map((g) => g.gateId), [b]);
  assert.deepEqual(pending.counts, { pending: 1, answered: 1 });

  const answered = parse(gate(["list", "--run", runId, "--status", "answered"]));
  assert.deepEqual(answered.gates.map((g) => g.gateId), [a]);

  assert.equal(parse(gate(["list", "--run", runId])).gates.length, 2, "no --status means all");
  assert.equal(parse(gate(["list", "--run", runId, "--child", "nobody"])).gates.length, 0);
});

test("list returns gate text VERBATIM, unlike status snippets", () => {
  // The Supervisor's hard rule is to relay a child's question word for word.
  // A relay through a redactor is not a relay. supervisor-status.mjs redacts
  // because it prints summaries; this is the source of truth.
  const runId = fixtureRun();
  const secretish = "użyj api_key=abc123def dla stagingu";
  gate(["emit", "--run", runId, "--child", "dev-1", "--kind", "question", "--summary", secretish, "--question", "ok?"]);

  assert.equal(parse(gate(["list", "--run", runId])).gates[0].summary, secretish);
  const status = parse(cli(STATUS, ["--run", runId]));
  assert.match(status.pendingGates[0].summary, /api_key=\*\*\*/, "status still redacts what it prints");
});

test("a malformed gate file does not hide the well-formed ones", () => {
  const runId = fixtureRun();
  const id = seedGate(runId);
  writeFileSync(join(gatesDir(runId), "broken.json"), "{not json");
  const out = parse(gate(["list", "--run", runId]));
  assert.equal(out.gates.length, 2);
  assert.ok(out.gates.some((g) => g.gateId === id));
  assert.ok(out.gates.some((g) => g.status === "unreadable"));
});

test("an unknown subcommand is refused", () => {
  const r = gate(["ask", "--run", "x"]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /emit \| answer \| list/);
});

// ── 5. waiting_gate — stopped to ask is not finished ──────────────────────────
console.log("\nwaiting_gate");

test("waiting_gate counts as terminal for liveness", () => {
  // Not cosmetic: counted as live, a child waiting on a human would be reported
  // stalled the moment its tee went quiet — which it always does while waiting.
  assert.ok(TERMINAL_STATUSES.includes("waiting_gate"));
});

test("hasPendingGate is per child, and treats an unreadable file as pending", () => {
  const runId = fixtureRun();
  assert.equal(hasPendingGate(runId, "dev-1"), false);
  const id = seedGate(runId);
  assert.equal(hasPendingGate(runId, "dev-1"), true);
  assert.equal(hasPendingGate(runId, "review-1"), false, "another child's gate is not this child's");
  gate(["answer", "--run", runId, "--gate", id, "--text", "ok"]);
  assert.equal(hasPendingGate(runId, "dev-1"), false);

  writeFileSync(join(gatesDir(runId), "broken.json"), "{not json");
  assert.equal(hasPendingGate(runId, "dev-1"), true, "a gate nobody can parse must not read as answered");
});

test("the watcher writes waiting_gate when a real child leaves a pending gate", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun({ child: false });
  writeFileSync(join(runDir(runId), "triage.json"), JSON.stringify({ issue: "FOC-999", verdict: "dev" }));

  const spawned = parse(
    cli(SPAWN, ["--run", runId, "--squad", "dev", "--task", "FOC-999", "--prompt", "k", "--repo", repo], {
      LA_CLAUDE_BIN: MOCK, MOCK_CLAUDE_HANG_MS: "2500",
    }),
  );
  // Raised WHILE the turn is still in flight, exactly as a child would.
  const emitted = gate([
    "emit", "--run", runId, "--child", spawned.childId, "--kind", "plan.gate2",
    "--summary", "mogę pushować?", "--question", "ok?",
  ]);
  assert.equal(emitted.status, 0, emitted.stdout + emitted.stderr);

  const waited = parse(cli(STATUS, ["--run", runId, "--wait", "--timeout-ms", "20000"]));
  const child = waited.children.find((c) => c.childId === spawned.childId);
  assert.equal(child.status, "waiting_gate", `status was ${child.status} (reason ${waited.reason})`);
  assert.equal(child.exitCode, 0, "waiting_gate is a CLEAN exit plus an open question");
  assert.equal(child.stalled, false, "a child waiting on a human is not stalled");
  assert.equal(waited.totals.live, 0, "nothing is running, so nothing is live");
});

// ── 6. recorded and delivered stay in step ────────────────────────────────────
console.log("\nintegracja z followup");

test("followup refuses to deliver a gate that is still pending", () => {
  const runId = fixtureRun();
  const id = seedGate(runId);
  const r = cli(FOLLOWUP, ["--run", runId, "--child", "dev-1", "--gate", id, "--prompt", "odpowiedź"]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /still pending/);
  assert.match(parse(r).error, /supervisor-gate\.mjs answer/, "the error has to say how to fix it");
});

test("followup refuses a gate that does not exist", () => {
  const runId = fixtureRun();
  const r = cli(FOLLOWUP, ["--run", runId, "--child", "dev-1", "--gate", "gate-dev-1-77", "--prompt", "x"]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /does not exist/);
});

test("followup refuses another child's gate", () => {
  const runId = fixtureRun();
  const id = seedGate(runId);
  gate(["answer", "--run", runId, "--gate", id, "--text", "ok"]);
  const rec = JSON.parse(readFileSync(gatePath(runId, id), "utf8"));
  writeFileSync(gatePath(runId, id), JSON.stringify({ ...rec, childId: "review-1" }));

  const r = cli(FOLLOWUP, ["--run", runId, "--child", "dev-1", "--gate", id, "--prompt", "x"]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /belongs to child review-1/);
});

test("an answered gate delivers, and the turn records which gate it carried", () => {
  const repo = fixtureRepo();
  const runId = fixtureRun({ child: false });
  writeFileSync(join(runDir(runId), "triage.json"), JSON.stringify({ issue: "FOC-999", verdict: "dev" }));

  const spawned = parse(
    cli(SPAWN, ["--run", runId, "--squad", "dev", "--task", "FOC-999", "--prompt", "k", "--repo", repo], {
      LA_CLAUDE_BIN: MOCK,
    }),
  );
  const id = parse(
    gate(["emit", "--run", runId, "--child", spawned.childId, "--kind", "question", "--summary", "s", "--question", "q?"]),
  ).gateId;
  cli(STATUS, ["--run", runId, "--wait", "--timeout-ms", "15000"]);
  assert.equal(gate(["answer", "--run", runId, "--gate", id, "--text", "rób A"]).status, 0);

  const r = cli(FOLLOWUP, ["--run", runId, "--child", spawned.childId, "--gate", id, "--prompt", "rób A"], {
    LA_CLAUDE_BIN: MOCK,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(parse(r).gateId, id);

  cli(STATUS, ["--run", runId, "--wait", "--timeout-ms", "15000"]);
  cli(join(ROOT, "scripts", "supervisor-stop.mjs"), ["--run", runId, "--child", spawned.childId]);
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
