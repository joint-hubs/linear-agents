// scripts/cockpit.test.mjs — the cockpit library (FOC-783, cockpit.mjs).
//
// The properties worth protecting:
//   · recentRunIds: newest-first, the 14-day window, a run dir with no signals skipped;
//   · collectNeedsYou: pending gate/approval items with their answerKind, an
//     unreadable gate file surfaced (never hidden), an answered-but-undelivered
//     gate as "awaiting-delivery", open holds with options (deferred hidden,
//     past-until resurfaced, answered gone), and the problem kinds (crashed,
//     stalled past the SLA, held spawn, partial-status);
//   · a waiting_gate child and its pending gate are ONE item, never two;
//   · collectChildren: the §5 status ladder in order (pending gate first,
//     registry terminal — a waiting_gate child with an ANSWERED but undelivered
//     gate is still waiting — then the live ladder through the probe), ONE probe
//     call for every live pid, live-first sorting, the ended window and the max cap;
//   · one corrupt children.json or holds.json never breaks the other runs;
//   · focusTicket: the first run (newest first) whose triage.json names an issue;
//   · cockpitCounts: needsYou counts only actionable items (answerable + problems).
//
// Everything runs through the LA_SUPERVISOR_STATE_HOME seam pointed at a
// mkdtemp dir set BEFORE the import; the stall SLA is shrunk via
// LA_SUPERVISOR_POLL_MS so stalled/running needs no 10-minute sleeps.
//
// Run: node scripts/cockpit.test.mjs

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "la-cockpit-"));
process.env.LA_SUPERVISOR_STATE_HOME = HOME;
// Stall SLA = pollBaseMs * 5 = 5 s here, so a tee aged 8 s is stalled and a
// fresh one is running — no sleeps anywhere.
process.env.LA_SUPERVISOR_POLL_MS = "1000";

const {
  recentRunIds,
  collectNeedsYou,
  collectChildren,
  focusTicket,
  cockpitCounts,
} = await import("./cockpit.mjs");

let passed = 0;
const failures = [];

// Tests are QUEUED and drained sequentially before the fixture cleanup: an
// async body suspended at its first await must not resume after rmSync has
// already deleted the fixtures under it.
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const testAsync = test;
const section = (label) => queue.push({ section: label });

const fail = (msg) => { throw new Error(msg); };
const eq = (a, b, label) => { if (a !== b) fail(`${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const ageOld = (days) => new Date(Date.now() - days * 86_400_000);

let counter = 0;
function fixtureRun(prefix = "run") {
  const runId = `${prefix}-${process.pid}-${Date.now()}-${counter++}`;
  mkdirSync(join(HOME, runId), { recursive: true });
  return runId;
}

const childEntry = (childId, patch = {}) => ({
  childId,
  squad: "dev",
  taskId: "FOC-783",
  status: "running",
  turns: [],
  costUsd: 0.01,
  ...patch,
});

const writeRegistry = (runId, children) =>
  writeFileSync(join(HOME, runId, "children.json"), JSON.stringify({ runId, children, rounds: {} }, null, 2));

const writeGate = (runId, gate) => {
  mkdirSync(join(HOME, runId, "gates"), { recursive: true });
  writeFileSync(join(HOME, runId, "gates", `${gate.gateId}.json`), JSON.stringify(gate, null, 2));
};

const gateRecord = (runId, gateId, childId, patch = {}) => ({
  gateId,
  childId,
  squad: "dev",
  runId,
  taskId: "FOC-783",
  kind: "question",
  summary: "Which schema for the export?",
  questions: ["question: JSON or CSV?"],
  artifacts: [],
  facts: { branch: "foc-783" },
  status: "pending",
  createdAt: iso(),
  answer: null,
  ...patch,
});

const holdRecord = (patch = {}) => ({
  id: "hold-1",
  origin: "test",
  question: "Which model for dev?",
  options: [{ label: "glm", model: "z-ai/glm-5.3-flash", costUsd: 0.01 }],
  recommendation: "glm",
  impact: "high",
  resolution: null,
  state: "open",
  createdAt: iso(),
  presentedAt: null,
  until: null,
  answer: null,
  blocks: null,
  history: [{ event: "created", at: iso() }],
  ...patch,
});

const writeHolds = (runId, holds) =>
  writeFileSync(join(HOME, runId, "holds.json"), JSON.stringify({ version: 1, holds }, null, 2));

const writeHeld = (runId, held) => {
  mkdirSync(join(HOME, runId, "held"), { recursive: true });
  writeFileSync(join(HOME, runId, "held", `${held.heldId}.json`), JSON.stringify(held, null, 2));
};

const writeTee = (runId, childId) => {
  mkdirSync(join(HOME, runId, "children"), { recursive: true });
  writeFileSync(join(HOME, runId, "children", `${childId}.jsonl`), "line\n");
};

const teeMtime = (runId, childId, offsetMs) => {
  const at = new Date(Date.now() - offsetMs);
  utimesSync(join(HOME, runId, "children", `${childId}.jsonl`), at, at);
};

// probe that answers alive for every pid asked, recording each call
function liveProbe() {
  const calls = [];
  const probe = async (pids) => {
    calls.push([...pids]);
    return Object.fromEntries(pids.map((p) => [String(p), true]));
  };
  probe.calls = calls;
  return probe;
}

section("cockpit: recentRunIds — window, order, no-signal runs skipped");

test("a run touched now is listed, ordering is newest first", () => {
  const older = fixtureRun();
  const newer = fixtureRun();
  writeRegistry(older, {});
  const anHourAgo = ageOld(1 / 24);
  utimesSync(join(HOME, older, "children.json"), anHourAgo, anHourAgo);
  writeGate(newer, gateRecord(newer, "gate-dev-1-1", "dev-1"));
  eq(recentRunIds({})[0], newer, "newest first");
  if (!recentRunIds({}).includes(older)) fail(`fresh run missing: ${older}`);
});

test("a run dir whose signals are all 20 days old is ignored", () => {
  const runId = fixtureRun();
  writeRegistry(runId, {});
  writeHolds(runId, [holdRecord()]);
  mkdirSync(join(HOME, runId, "gates"), { recursive: true });
  const old = ageOld(20);
  utimesSync(join(HOME, runId, "children.json"), old, old);
  utimesSync(join(HOME, runId, "holds.json"), old, old);
  utimesSync(join(HOME, runId, "gates"), old, old);
  if (recentRunIds({}).includes(runId)) fail("old run listed");
});

test("a run with none of children.json / gates/ / holds.json is skipped", () => {
  const runId = fixtureRun();
  writeFileSync(join(HOME, runId, "triage.json"), JSON.stringify({ issue: "FOC-1" }));
  if (recentRunIds({}).includes(runId)) fail("signal-less run listed");
});

test("one fresh signal keeps a run in (holds.json fresh, registry old)", () => {
  const runId = fixtureRun();
  writeRegistry(runId, {});
  writeHolds(runId, [holdRecord()]);
  const old = ageOld(2);
  utimesSync(join(HOME, runId, "children.json"), old, old);
  if (!recentRunIds({}).includes(runId)) fail("run dropped though holds.json is fresh");
});

section("cockpit: collectNeedsYou — gates and approvals");

test("a pending question gate → gate item, answerKind text, answerable", () => {
  const runId = fixtureRun();
  writeGate(runId, gateRecord(runId, "gate-dev-1-1", "dev-1"));
  const items = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(items.length, 1, "one item");
  eq(items[0].id, `gate:${runId}:gate-dev-1-1`, "id format");
  eq(items[0].category, "gate", "category");
  eq(items[0].kind, "question", "kind");
  eq(items[0].taskId, "FOC-783", "taskId from the gate");
  eq(items[0].childId, "dev-1", "childId");
  eq(items[0].state, "pending", "state");
  eq(items[0].answerable, true, "answerable");
  eq(items[0].answerKind, "text", "answerKind");
  if (typeof items[0].ageMs !== "number" || items[0].ageMs < 0) fail(`ageMs: ${items[0].ageMs}`);
});

test("a pending push-approval → approval item, answerKind yesno", () => {
  const runId = fixtureRun();
  writeGate(runId, gateRecord(runId, "gate-dev-1-2", "dev-1", { kind: "push-approval", summary: "push the branch?" }));
  const [item] = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(item.category, "approval", "category");
  eq(item.answerKind, "yesno", "answerKind");
  eq(item.state, "pending", "state");
});

test("cleanup-approval and draft-approval are approvals; an unknown kind is not an item", () => {
  const runId = fixtureRun();
  writeGate(runId, gateRecord(runId, "gate-dev-1-3", "dev-1", { kind: "cleanup-approval" }));
  writeGate(runId, gateRecord(runId, "gate-dev-1-4", "dev-1", { kind: "draft-approval" }));
  writeGate(runId, gateRecord(runId, "gate-dev-1-5", "dev-1", { kind: "not-a-kind" }));
  const items = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(items.length, 2, "two items");
  if (!items.every((i) => i.category === "approval")) fail(`categories: ${items.map((i) => i.category)}`);
});

test("an unreadable gate file surfaces as an unreadable gate item naming the file", () => {
  const runId = fixtureRun();
  mkdirSync(join(HOME, runId, "gates"), { recursive: true });
  writeFileSync(join(HOME, runId, "gates", "gate-dev-1-6.json"), "{torn");
  const items = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(items.length, 1, "one item");
  eq(items[0].category, "gate", "category");
  eq(items[0].state, "unreadable", "state");
  eq(items[0].answerable, false, "answerable");
  eq(items[0].gateId, "gate-dev-1-6", "gateId");
  if (!items[0].summary.includes("gate-dev-1-6.json")) fail(`summary names the file: ${items[0].summary}`);
});

test("answered gate, child still waiting_gate, no delivery turn → awaiting-delivery", () => {
  const runId = fixtureRun();
  const gate = gateRecord(runId, "gate-dev-1-7", "dev-1", {
    status: "answered",
    answer: { text: "CSV", answeredAt: iso() },
  });
  writeGate(runId, gate);
  writeRegistry(runId, {
    "dev-1": childEntry("dev-1", { status: "waiting_gate", turns: [{ startedAt: iso(), endedAt: iso(-1), exitCode: 0 }] }),
  });
  const [item] = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(item.state, "awaiting-delivery", "state");
  eq(item.answerable, false, "answerable");
});

test("answered gate delivered (a turn names the gateId) → no item; child exited → no item", () => {
  const runId = fixtureRun();
  const gate = gateRecord(runId, "gate-dev-1-8", "dev-1", { status: "answered", answer: { text: "CSV", answeredAt: iso() } });
  writeGate(runId, gate);
  writeRegistry(runId, {
    "dev-1": childEntry("dev-1", {
      status: "waiting_gate",
      turns: [{ startedAt: iso(), endedAt: iso(-1), exitCode: 0, gateId: "gate-dev-1-8" }],
    }),
  });
  eq(collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] }).length, 0, "delivered → no item");

  const runId2 = fixtureRun();
  writeGate(runId2, gateRecord(runId2, "gate-dev-2-1", "dev-1", { status: "answered", answer: { text: "CSV", answeredAt: iso() } }));
  writeRegistry(runId2, { "dev-1": childEntry("dev-1", { status: "exited", exitCode: 0, endedAt: iso() }) });
  eq(collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId2] }).length, 0, "child exited → no item");
});

test("a waiting_gate child with a pending gate yields ONLY the gate item (no duplicate)", () => {
  const runId = fixtureRun();
  writeGate(runId, gateRecord(runId, "gate-dev-3-1", "dev-1"));
  writeRegistry(runId, { "dev-1": childEntry("dev-1", { status: "waiting_gate" }) });
  const items = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(items.length, 1, "exactly one item");
  eq(items[0].category, "gate", "it is the gate item");
});

section("cockpit: collectNeedsYou — holds");

test("an open hold shows options, recommendation, impact; answerKind option", () => {
  const runId = fixtureRun();
  writeHolds(runId, [holdRecord()]);
  const [item] = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(item.category, "hold", "category");
  eq(item.kind, "hold", "kind");
  eq(item.holdId, "hold-1", "holdId");
  eq(item.answerKind, "option", "answerKind");
  eq(item.answerable, true, "answerable");
  eq(item.state, "open", "state");
  eq(item.recommendation, "glm", "recommendation copied");
  eq(item.impact, "high", "impact copied");
  eq(item.options.length, 1, "options copied");
  eq(item.summary, "Which model for dev?", "summary is the question");
});

test("a hold deferred into the future is hidden; a past `until` resurfaces; answered holds are gone", () => {
  const runId = fixtureRun();
  writeHolds(runId, [
    holdRecord({ id: "hold-1", until: iso(60 * 60_000) }), // deferred → hidden
    holdRecord({ id: "hold-2", until: iso(-60_000) }), // past deferral → shows
    holdRecord({ id: "hold-3", state: "answered", answer: { text: "glm", answeredAt: iso() } }), // gone
  ]);
  const items = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(items.length, 1, "one item");
  eq(items[0].holdId, "hold-2", "the resurfaced hold");
});

test("an unreadable holds.json → one unreadable item; the other run keeps its hold", () => {
  const badRun = fixtureRun();
  const goodRun = fixtureRun();
  writeFileSync(join(HOME, badRun, "holds.json"), "{torn");
  writeHolds(goodRun, [holdRecord({ id: "hold-9" })]);
  const items = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [badRun, goodRun] });
  eq(items.length, 2, "unreadable item + the good run's hold");
  eq(items[1].category, "hold", "category");
  eq(items[1].state, "unreadable", "state");
  eq(items[1].answerable, false, "answerable");
  if (!items[1].summary.includes("holds.json")) fail(`summary names the store: ${items[1].summary}`);
  eq(items[0].holdId, "hold-9", "the other run's hold is intact");
});

section("cockpit: collectNeedsYou — problems");

test("a crashed child → problem item, kind crashed, not answerable", () => {
  const runId = fixtureRun();
  writeRegistry(runId, { "dev-1": childEntry("dev-1", { status: "crashed", exitCode: 1, endedAt: iso() }) });
  const [item] = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(item.category, "problem", "category");
  eq(item.kind, "crashed", "kind");
  eq(item.id, `problem:${runId}:dev-1:crashed`, "id format");
  eq(item.answerable, false, "answerable");
  eq(item.answerKind, null, "answerKind");
  if (!item.summary.includes("exit 1")) fail(`summary: ${item.summary}`);
});

test("a live child silent past the SLA → kind stalled; a fresh tee is not a problem", () => {
  const runId = fixtureRun();
  writeRegistry(runId, { "dev-1": childEntry("dev-1", { status: "running", pid: 4242 }) });
  writeTee(runId, "dev-1");
  eq(collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] }).length, 0, "fresh tee → no problem");
  teeMtime(runId, "dev-1", 8000); // SLA is 5 s (pollBase 1 s × 5)
  const [item] = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(item.kind, "stalled", "kind");
  eq(item.childId, "dev-1", "childId");
});

test("the stall anchor is the live turn's startedAt when it is later than the tee (FOC-271)", () => {
  const runId = fixtureRun();
  writeRegistry(runId, {
    "dev-1": childEntry("dev-1", {
      status: "running",
      pid: 4242,
      turns: [{ pid: 4242, startedAt: iso(-1000), endedAt: null, exitCode: null }], // resumed 1 s ago
    }),
  });
  writeTee(runId, "dev-1");
  teeMtime(runId, "dev-1", 8000); // the predecessor's silence must not count
  eq(collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] }).length, 0, "resumed turn not stalled");
});

test("each held spawn request → problem item held-spawn; unreadable request is not absent", () => {
  const runId = fixtureRun();
  writeHeld(runId, { heldId: "held-dev-1", squad: "dev", taskId: "FOC-784", reason: "node dev is full", heldAt: iso() });
  mkdirSync(join(HOME, runId, "held"), { recursive: true });
  writeFileSync(join(HOME, runId, "held", "held-dev-2.json"), "{torn");
  const items = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(items.length, 2, "both requests surfaced");
  if (!items.every((i) => i.category === "problem" && i.kind === "held-spawn")) fail(`items: ${JSON.stringify(items.map((i) => [i.kind, i.summary]))}`);
  eq(items[0].taskId, "FOC-784", "taskId from the request");
  if (!items[1].summary.includes("held-dev-2")) fail(`unreadable summary: ${items[1].summary}`);
});

test("partial-status.json → problem item with the file's reason as summary", () => {
  const runId = fixtureRun();
  writeFileSync(
    join(HOME, runId, "partial-status.json"),
    JSON.stringify({ runId, reason: "reserve exhausted — graph expansion stopped", generatedAt: iso(), tasks: [] }),
  );
  const [item] = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(item.category, "problem", "category");
  eq(item.kind, "partial-status", "kind");
  eq(item.id, `problem:${runId}:partial-status`, "id format");
  eq(item.summary, "reserve exhausted — graph expansion stopped", "summary from reason");
  eq(item.answerable, false, "answerable");
});

test("items come back newest first; taskId falls back to triage.json's issue", () => {
  const runId = fixtureRun();
  writeFileSync(join(HOME, runId, "triage.json"), JSON.stringify({ issue: "FOC-999" }));
  writeGate(runId, gateRecord(runId, "gate-dev-1-1", "dev-1", { taskId: null, createdAt: iso(-60_000) }));
  writeHolds(runId, [holdRecord({ createdAt: iso() })]);
  writeHeld(runId, { heldId: "held-dev-1", squad: "dev", taskId: null, heldAt: iso(-120_000) });
  const items = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(items.length, 3, "three items");
  eq(items[0].category, "hold", "newest first");
  eq(items[1].category, "gate", "second");
  eq(items[2].category, "problem", "oldest last");
  eq(items[2].taskId, "FOC-999", "held-spawn taskId via triage fallback");
});

section("cockpit: collectChildren — the status ladder");

testAsync("a pending gate outranks everything: a live child with a gate is waiting-gate", async () => {
  const runId = fixtureRun();
  writeGate(runId, gateRecord(runId, "gate-dev-1-1", "dev-1"));
  writeTee(runId, "dev-1");
  writeRegistry(runId, { "dev-1": childEntry("dev-1", { status: "running", pid: 111 }) });
  const [row] = await collectChildren({
    stateHome: HOME,
    now: Date.now(),
    runIds: [runId],
    probe: async () => ({ 111: true }),
  });
  eq(row.status, "waiting-gate", "status");
  eq(row.runId, runId, "runId");
});

section("cockpit: collectChildren — terminal statuses");

testAsync("exited / crashed → exited with the code; stopped stays stopped; waiting_gate → exit 0", async () => {
  const runId = fixtureRun();
  const now = Date.now();
  writeRegistry(runId, {
    "dev-1": childEntry("dev-1", { status: "exited", exitCode: 0, endedAt: iso(-1000) }),
    "dev-2": childEntry("dev-2", { status: "crashed", exitCode: 2, endedAt: iso(-2000) }),
    "dev-3": childEntry("dev-3", { status: "stopped", endedAt: iso(-3000) }),
    "dev-4": childEntry("dev-4", { status: "waiting_gate", exitCode: null, endedAt: iso(-4000) }),
  });
  const rows = await collectChildren({ stateHome: HOME, now, runIds: [runId] });
  eq(rows.length, 4, "four rows");
  const byChild = Object.fromEntries(rows.map((r) => [r.childId, r]));
  eq(byChild["dev-1"].status, "exited", "exited");
  eq(byChild["dev-1"].detail, "exit 0", "detail");
  eq(byChild["dev-2"].status, "exited", "crashed shows as exited");
  eq(byChild["dev-2"].detail, "exit 2", "crashed detail keeps the code");
  eq(byChild["dev-3"].status, "stopped", "stopped");
  eq(byChild["dev-4"].status, "exited", "waiting_gate without a pending gate");
  eq(byChild["dev-4"].exitCode, 0, "exit 0");
  if (rows[0].childId !== "dev-1") fail(`ended children newest first, got ${rows[0].childId}`);
});

testAsync("a waiting_gate child whose answer is recorded but UNDELIVERED is waiting-gate, not exited", async () => {
  const ended = iso(-1000);
  const mkAnsweredGate = (runId, gateId) =>
    gateRecord(runId, gateId, "dev-1", { status: "answered", answer: { text: "CSV", answeredAt: iso() } });

  // recorded, no turn carries the gateId → still waiting on the delivery
  const runId = fixtureRun();
  writeGate(runId, mkAnsweredGate(runId, "gate-dev-1-9"));
  writeRegistry(runId, {
    "dev-1": childEntry("dev-1", {
      status: "waiting_gate",
      turns: [{ startedAt: iso(-2000), endedAt: ended, exitCode: 0 }],
    }),
  });
  const [row] = await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(row.status, "waiting-gate", "undelivered answer keeps the child waiting");
  eq(row.detail, "answer recorded — waiting for delivery", "detail");
  eq(row.exitCode, null, "no exit code claimed while the answer is undelivered");
  eq(cockpitCounts({ needsYou: [], children: [row] }).waitingGate, 1, "counts.waitingGate counts it");

  // delivered — a turn names the gateId — and the child is done again
  const runId2 = fixtureRun();
  writeGate(runId2, mkAnsweredGate(runId2, "gate-dev-2-1"));
  writeRegistry(runId2, {
    "dev-1": childEntry("dev-1", {
      status: "waiting_gate",
      turns: [{ startedAt: iso(-2000), endedAt: ended, exitCode: 0, gateId: "gate-dev-2-1" }],
    }),
  });
  const [done] = await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runId2] });
  eq(done.status, "exited", "delivered → exited as before");
  eq(done.detail, "exit 0", "detail");
  eq(done.exitCode, 0, "exit 0");

  // and the undelivered child is listed even outside the ended window — it
  // waits on Mateusz, so the window must not hide it
  const runId3 = fixtureRun();
  writeGate(runId3, mkAnsweredGate(runId3, "gate-dev-3-1"));
  const twoDaysAgo = iso(-2 * 86_400_000);
  writeRegistry(runId3, {
    "dev-1": childEntry("dev-1", {
      status: "waiting_gate",
      turns: [{ startedAt: twoDaysAgo, endedAt: iso(-2 * 86_400_000 + 3600_000) }],
    }),
  });
  const rows = await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runId3] });
  eq(rows.length, 1, "outside the ended window, still listed");
  eq(rows[0].status, "waiting-gate", "status");
});

testAsync("the ended window: a child ended 2 days ago is out by default, in with a wider window", async () => {
  const runId = fixtureRun();
  writeRegistry(runId, { "dev-1": childEntry("dev-1", { status: "exited", exitCode: 0, endedAt: iso(-2 * 86_400_000) }) });
  eq((await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runId] })).length, 0, "outside the window");
  eq((await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runId], endedWindowMs: 3 * 86_400_000 })).length, 1, "inside");
});

testAsync("a waiting_gate child with a pending gate and no endedAt is always listed as waiting-gate", async () => {
  const runId = fixtureRun();
  writeGate(runId, gateRecord(runId, "gate-dev-1-2", "dev-1"));
  const started = iso(-2 * 86_400_000); // 2 days ago: outside the ended window, still listed
  const turnEnd = iso(-3 * 86_400_000);
  writeRegistry(runId, {
    "dev-1": childEntry("dev-1", {
      status: "waiting_gate",
      startedAt: started,
      turns: [{ startedAt: started, endedAt: turnEnd }],
    }),
  });
  const [row] = await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(row.status, "waiting-gate", "pending gate outranks the ended window");
  eq(row.endedAt, turnEnd, "endedAt falls back to the last turn's end");
  if (typeof row.ageMs !== "number" || row.ageMs < 2 * 86_400_000) fail(`ageMs from startedAt: ${row.ageMs}`);
  const counts = cockpitCounts({ needsYou: [], children: [row] });
  eq(counts.waitingGate, 1, "counts.waitingGate counts it");
});

testAsync("a terminal child with no entry endedAt uses the last turn's endedAt for the ended window", async () => {
  const runId = fixtureRun();
  const insideTurnEnd = iso(-3600_000);
  const inside = childEntry("dev-1", {
    status: "exited",
    exitCode: 0,
    turns: [{ startedAt: iso(-2 * 3600_000), endedAt: insideTurnEnd }],
  });
  const outside = childEntry("dev-2", {
    status: "exited",
    exitCode: 1,
    turns: [{ startedAt: iso(-3 * 86_400_000), endedAt: iso(-2 * 86_400_000) }],
  });
  writeRegistry(runId, { "dev-1": inside, "dev-2": outside });
  const rows = await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runId] });
  eq(rows.length, 1, "only the turn-ended-inside child shows");
  eq(rows[0].childId, "dev-1", "the inside child");
  eq(rows[0].endedAt, insideTurnEnd, "endedAt from the last turn");
});

section("cockpit: collectChildren — the live ladder through the probe");

testAsync("probe true + fresh tee → running; probe true + silent tee → stalled", async () => {
  const runId = fixtureRun();
  writeTee(runId, "dev-1");
  writeTee(runId, "dev-2");
  writeRegistry(runId, {
    "dev-1": childEntry("dev-1", { status: "running", pid: 111 }),
    "dev-2": childEntry("dev-2", { status: "running", pid: 222 }),
  });
  teeMtime(runId, "dev-2", 8000);
  const rows = await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runId], probe: async (pids) => Object.fromEntries(pids.map((p) => [String(p), true])) });
  const byChild = Object.fromEntries(rows.map((r) => [r.childId, r]));
  eq(byChild["dev-1"].status, "running", "fresh tee");
  eq(byChild["dev-2"].status, "stalled", "silent past the SLA");
  if (typeof byChild["dev-2"].teeSilentMs !== "number" || byChild["dev-2"].teeSilentMs < 8000) {
    fail(`teeSilentMs: ${byChild["dev-2"].teeSilentMs}`);
  }
});

testAsync("probe null → unknown, detail says the probe was unavailable", async () => {
  const runId = fixtureRun();
  writeTee(runId, "dev-1");
  writeRegistry(runId, { "dev-1": childEntry("dev-1", { status: "running", pid: 111 }) });
  const [row] = await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runId], probe: async () => null });
  eq(row.status, "unknown", "status");
  eq(row.detail, "process probe unavailable", "detail");
});

testAsync("a live child with no pid → unknown 'no pid recorded'; with no tee → unknown 'no tee'", async () => {
  const runId = fixtureRun();
  writeTee(runId, "dev-1"); // dev-1 has a tee but no pid
  writeRegistry(runId, {
    "dev-1": childEntry("dev-1", { status: "starting", pid: null }),
    "dev-2": childEntry("dev-2", { status: "running", pid: 333 }), // pid recorded, no tee file
  });
  const rows = await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runId], probe: async () => ({}) });
  const byChild = Object.fromEntries(rows.map((r) => [r.childId, r]));
  eq(byChild["dev-1"].status, "unknown", "status");
  eq(byChild["dev-1"].detail, "no pid recorded", "detail");
  eq(byChild["dev-2"].status, "unknown", "status");
  eq(byChild["dev-2"].detail, "no tee", "detail");
});

testAsync("a dead pid with no exit recorded → unknown, detail says so", async () => {
  const runId = fixtureRun();
  writeTee(runId, "dev-1");
  writeRegistry(runId, { "dev-1": childEntry("dev-1", { status: "running", pid: 777 }) });
  const [row] = await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runId], probe: async () => ({ 777: false }) });
  eq(row.status, "unknown", "status");
  eq(row.detail, "process gone, no exit recorded", "detail");
});

testAsync("probe is called EXACTLY once, with every live pid across all runs", async () => {
  const runA = fixtureRun();
  const runB = fixtureRun();
  writeTee(runA, "dev-1");
  writeTee(runB, "dev-1");
  writeRegistry(runA, { "dev-1": childEntry("dev-1", { status: "running", pid: 111 }) });
  writeRegistry(runB, { "dev-1": childEntry("dev-1", { status: "running", pid: 222 }) });
  const probe = liveProbe();
  await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [runA, runB], probe });
  eq(probe.calls.length, 1, "one call");
  eq(probe.calls[0].length, 2, "all pids in the one call");
  if (!probe.calls[0].includes(111) || !probe.calls[0].includes(222)) fail(`pids: ${probe.calls[0]}`);
});

testAsync("live children sort first (running, stalled, waiting-gate, unknown), then ended newest first; capped at max", async () => {
  const runId = fixtureRun();
  const now = Date.now();
  writeRegistry(runId, {
    "dev-1": childEntry("dev-1", { status: "exited", exitCode: 0, endedAt: iso(-3 * 3600_000) }),
    "dev-2": childEntry("dev-2", { status: "exited", exitCode: 0, endedAt: iso(-3600_000) }),
    "dev-3": childEntry("dev-3", { status: "exited", exitCode: 0, endedAt: iso(-2 * 3600_000) }),
    "dev-4": childEntry("dev-4", { status: "crashed", exitCode: 1, endedAt: iso(-4 * 3600_000) }),
    "dev-5": childEntry("dev-5", { status: "running", pid: 11 }),
    "dev-6": childEntry("dev-6", { status: "running", pid: 22 }),
    "dev-7": childEntry("dev-7", { status: "running", pid: 33 }),
  });
  writeTee(runId, "dev-5");
  writeTee(runId, "dev-6");
  writeTee(runId, "dev-7");
  teeMtime(runId, "dev-6", 8000);
  teeMtime(runId, "dev-7", 8000);
  // every pid alive — otherwise dev-5 would come back unknown ("process gone"), not running
  const rows = await collectChildren({ stateHome: HOME, now, runIds: [runId], probe: async () => ({ 11: true, 22: true, 33: true }), max: 3 });
  eq(rows.length, 3, "capped at max");
  eq(rows[0].status, "running", "running first");
  eq(rows[1].status, "stalled", "then stalled");
  eq(rows[2].status, "stalled", "then the rest of the live group");
});

testAsync("a corrupt children.json skips the run; the other run keeps working (children + needs-you)", async () => {
  const badRun = fixtureRun();
  const goodRun = fixtureRun();
  writeFileSync(join(HOME, badRun, "children.json"), "{torn");
  writeGate(badRun, gateRecord(badRun, "gate-dev-9-1", "dev-9"));
  writeRegistry(goodRun, { "dev-1": childEntry("dev-1", { status: "exited", exitCode: 0, endedAt: iso(-1000) }) });
  const rows = await collectChildren({ stateHome: HOME, now: Date.now(), runIds: [badRun, goodRun] });
  eq(rows.length, 1, "only the good run's child");
  eq(rows[0].runId, goodRun, "from the good run");
  const items = collectNeedsYou({ stateHome: HOME, now: Date.now(), runIds: [badRun, goodRun] });
  eq(items.length, 1, "the bad run's pending gate still shows without a registry");
  eq(items[0].gateId, "gate-dev-9-1", "gate survives the corrupt registry");
});

section("cockpit: focusTicket and cockpitCounts");

test("focusTicket returns the first run (newest first) whose triage.json names an issue", () => {
  const noTriage = fixtureRun();
  const corruptTriage = fixtureRun();
  writeFileSync(join(HOME, corruptTriage, "triage.json"), "{torn");
  const withTriage = fixtureRun();
  writeFileSync(join(HOME, withTriage, "triage.json"), JSON.stringify({ issue: "FOC-111" }));
  eq(JSON.stringify(focusTicket({ stateHome: HOME, runIds: [noTriage, corruptTriage, withTriage] })), JSON.stringify({ taskId: "FOC-111", runId: withTriage }), "runs without/corrupt triage skipped");
  const newest = fixtureRun();
  writeFileSync(join(HOME, newest, "triage.json"), JSON.stringify({ issue: "FOC-222" }));
  eq(JSON.stringify(focusTicket({ stateHome: HOME, runIds: [newest, withTriage] })), JSON.stringify({ taskId: "FOC-222", runId: newest }), "first with an issue wins");
  eq(focusTicket({ stateHome: HOME, runIds: [noTriage, corruptTriage] }), null, "none → null");
  eq(focusTicket({ stateHome: HOME, runIds: [] }), null, "no runs → null");
});

test("cockpitCounts: needsYou counts answerable + problems only; children by status", () => {
  const needsYou = [
    { answerable: true, category: "gate" },
    { answerable: true, category: "approval" },
    { answerable: true, category: "hold" },
    { answerable: false, category: "problem", kind: "crashed" },
    { answerable: false, category: "gate", state: "unreadable" },
    { answerable: false, category: "gate", state: "awaiting-delivery" },
  ];
  const children = [
    { status: "running" },
    { status: "running" },
    { status: "stalled" },
    { status: "waiting-gate" },
    { status: "unknown" },
    { status: "exited" },
  ];
  eq(JSON.stringify(cockpitCounts({ needsYou, children })), JSON.stringify({ needsYou: 4, running: 2, stalled: 1, waitingGate: 1, unknown: 1 }), "counts");
});

for (const item of queue) {
  if (item.section !== undefined) {
    console.log("\n" + item.section);
    continue;
  }
  try {
    await item.fn(); // async bodies are awaited — a rejection must count as a FAIL, not escape
    passed++;
    console.log("  PASS " + item.name);
  } catch (err) {
    failures.push(item.name);
    console.log("  FAIL " + item.name + "\n       " + (err?.message ?? err));
  }
}

try {
  rmSync(HOME, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(`\ncockpit: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
