// scripts/supervisor-holds.test.mjs — holds: non-blocking decision records (FOC-612).
//
// A hold is the answer to "the Supervisor owes Mateusz a decision, but the run
// must not stop for it": work that does not name the hold keeps going, one hold
// is presented per turn (impact first) WITH a recommendation and its costed
// alternatives, and a run cannot be marked complete while a hold is open.
// What is worth failing a build over:
//
// 1. AC1 — `blocks: null` really means nothing waits: an open hold stops ONLY
//    the queue item that names it.
// 2. AC2 — answers survive restart (every assertion here reads the file from a
//    fresh CLI invocation, nothing from memory); a deferred hold resurfaces
//    after `until`; a hold is answered once and the refusal names the answer
//    in force; history is append-only.
// 3. Presentation — a rendered hold carries options AND their priced costs AND
//    a recommendation; a recommendation without costed options is refused at
//    write time, never rendered. Costs are priced through config/models.json
//    ("wycenione"); unpriced is UNKNOWN plus the model name, never zero, never
//    the stream's reported figure.
// 4. neverCovers — a hold whose resolution names push / force / discard /
//    delete-branch / secrets is refused at LOAD, not honoured: asserted per
//    entry, five independent blocks, no shared loop (supervisor-autonomy
//    shape).
// 5. Run completion — closing a run over an open hold refuses and names the
//    open holds; the turn-end guard blocks only on holds still owing their
//    presentation, and fails closed on a store nobody can parse.
//
// Isolation: LA_SUPERVISOR_STATE_HOME is redirected to a mkdtemp dir at module
// load; LA_MODELS_ROOT points hasPriceRow at a fixture pricing table so the
// priced/unpriced split never depends on the repo's real config. The
// graph-runner completion tests inject their graph and their dependencies —
// nothing touches the repo's real .state/.
//
// Run: node scripts/supervisor-holds.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGraphRunner } from "./graph-runner.mjs";
import { NEVER_COVERS } from "./autonomy-grants.mjs";
import {
  HOLDS_SCHEMA_VERSION,
  ensureRunDir,
  hasPriceRow,
  holdBlocksTurnEnd,
  holdsForCompletion,
  holdsOwingTurnEnd,
  holdsPath,
  partitionByHolds,
  readHolds,
  runDir,
  setHoldBlocks,
  validateHoldStore,
} from "./supervisor-lib.mjs";
import {
  GATE,
  ROOT,
  baseEnv,
  cleanupLater,
  harness,
  parse,
} from "./supervisor-test-fixtures.mjs";

const { test, summary, state } = harness();

// The seam: every run dir (in-process and in spawned gate/guard processes,
// which inherit the env) resolves under this temp home.
const STATE_HOME = mkdtempSync(join(tmpdir(), "la-sup-holds-"));
process.env.LA_SUPERVISOR_STATE_HOME = STATE_HOME;
cleanupLater(STATE_HOME);

// The pricing seam: a fixture table with one priced model, so the priced/
// unpriced split of hold options never depends on the repo's real models.json.
const MODELS_ROOT = mkdtempSync(join(tmpdir(), "la-sup-holds-models-"));
cleanupLater(MODELS_ROOT);
mkdirSync(join(MODELS_ROOT, "config"), { recursive: true });
writeFileSync(
  join(MODELS_ROOT, "config", "models.json"),
  JSON.stringify({
    _doc: "test fixture pricing (not a real price table)",
    pricing: {
      openrouter: { "test/priced-model": { input: 1, output: 2 } },
      nebul: { "test/other-scope": { input: 3, output: 4 } },
    },
  }),
);
process.env.LA_MODELS_ROOT = MODELS_ROOT;

const GUARD = join(ROOT, "scripts", "supervisor-guard.mjs");

const gate = (args) =>
  spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: "utf8", env: baseEnv() });
const guard = (runId) =>
  spawnSync(process.execPath, [GUARD, "--run", runId], { cwd: ROOT, encoding: "utf8", input: "{}", env: baseEnv() });
const readStore = (runId) => JSON.parse(readFileSync(holdsPath(runId), "utf8"));

let runCounter = 0;
const freshRun = () => {
  const runId = `test-holds-${process.pid}-${runCounter++}`;
  ensureRunDir(runId);
  cleanupLater(runDir(runId));
  return runId;
};

// The one priced option shape: model has a row in the fixture table.
const PRICED_OPTION = { label: "wznów dev-1 na rynku", model: "test/priced-model", costUsd: 0.0123 };
const HOLD_ARGS = (over = {}) => [
  "hold",
  "--origin", over.origin ?? "supervisor",
  "--question", over.question ?? "wznawiać dev-1 po crashu?",
  "--recommendation", over.recommendation ?? "wznów na tym samym sesion id",
  "--option", JSON.stringify(PRICED_OPTION),
  ...(over.extra ?? []),
];

// ── 1. creation ──────────────────────────────────────────────────────────────
console.log("\nhold — zapis rekordu");

test("hold writes holds.json v1 with every mandated field, blocks null", () => {
  const runId = freshRun();
  const r = gate([...HOLD_ARGS(), "--run", runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const store = readStore(runId);
  assert.equal(store.version, HOLDS_SCHEMA_VERSION, "the store is versioned");
  const hold = store.holds[0];
  assert.equal(hold.id, "hold-1", "ids are sayable and counted from the file");
  assert.equal(hold.origin, "supervisor");
  assert.equal(hold.question, "wznawiać dev-1 po crashu?");
  assert.equal(hold.recommendation, "wznów na tym samym sesion id");
  assert.equal(hold.state, "open");
  assert.equal(hold.until, null);
  assert.equal(hold.answer, null);
  assert.equal(hold.presentedAt, null, "nothing is presented until list --open shows it");
  // FOC-612 decision 2: blocks null = NOTHING waits yet. This is what makes
  // several open holds safe at once.
  assert.equal(hold.blocks, null);
  assert.deepEqual(hold.options, [PRICED_OPTION]);
  assert.deepEqual(hold.history.map((h) => h.event), ["created"]);

  const second = parse(gate([...HOLD_ARGS(), "--run", runId]));
  assert.equal(second.holds[1].id, "hold-2", "ids count up");
});

test("impact defaults to medium; unknown impact is refused", () => {
  const runId = freshRun();
  assert.equal(gate([...HOLD_ARGS(), "--run", runId]).status, 0);
  assert.equal(readStore(runId).holds[0].impact, "medium");

  const r = gate([...HOLD_ARGS({ extra: ["--impact", "urgent"] }), "--run", runId]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /--impact/);
});

test("list --open renders options with PRICED costs, UNKNOWN named per model, and the recommendation", () => {
  const runId = freshRun();
  const mixed = [
    ...HOLD_ARGS({
      extra: [
        "--option", JSON.stringify({ label: "spawn od zera", model: "test/unpriced-model" }),
        "--impact", "high",
      ],
    }),
    "--run", runId,
  ];
  assert.equal(gate(mixed).status, 0);
  const out = parse(gate(["list", "--open", "--run", runId]));
  assert.equal(out.presentNext, "hold-1");
  assert.match(out.rendered, /wznawiać dev-1 po crashu\?/, "the question is in the rendering");
  assert.match(out.rendered, /\$0\.0123 \(wycenione\)/, "a priced cost carries the wycenione label");
  assert.match(out.rendered, /UNKNOWN \(brak wiersza wyceny dla test\/unpriced-model/, "UNKNOWN names the model, never zero");
  assert.match(out.rendered, /Rekomendacja: wznów na tym samym sesion id/, "the recommendation is in the rendering");
});

test("list --open presents ONE hold per invocation, impact first, and stamps presentedAt", () => {
  const runId = freshRun();
  gate([...HOLD_ARGS({ extra: ["--impact", "low"], question: "niskie?" }), "--run", runId]);
  gate([...HOLD_ARGS({ extra: ["--impact", "high"], question: "wysokie?" }), "--run", runId]);
  gate([...HOLD_ARGS({ question: "średnie?" }), "--run", runId]); // medium default

  const out = parse(gate(["list", "--open", "--run", runId]));
  assert.equal(out.presentNext, "hold-2", "high impact first");
  assert.match(out.rendered, /wysokie\?/);
  assert.deepEqual(out.open.map((h) => h.id), ["hold-2", "hold-3", "hold-1"], "the whole open list rides along, ordered");

  // The stamp: exactly the presented hold got presentedAt; the others did not.
  const store = readStore(runId);
  assert.ok(store.holds.find((h) => h.id === "hold-2").presentedAt, "the presented hold is stamped");
  assert.equal(store.holds.find((h) => h.id === "hold-1").presentedAt, null);
  assert.equal(store.holds.find((h) => h.id === "hold-3").presentedAt, null);

  // hold-2 is presented but not yet answered or deferred — it is NOT
  // presentable again (its showing is done, its answer is owed), so the next
  // invocation moves on to the next un-presented hold in impact order. One
  // per invocation is the "one at a time" rule, mechanically.
  const second = parse(gate(["list", "--open", "--run", runId]));
  assert.equal(second.presentNext, "hold-3", "one per invocation; next un-presented in impact order");
});

test("list --open with no open holds says so", () => {
  const runId = freshRun();
  const out = parse(gate(["list", "--open", "--run", runId]));
  assert.deepEqual(out.open, []);
  assert.equal(out.presentNext, null);
  assert.equal(out.rendered, null);
});

// ── 2. write-time refusals ───────────────────────────────────────────────────
console.log("\nhold — odmowa nie zostawia pliku");

test("a hold with no options is refused and writes nothing", () => {
  // A recommendation without its alternatives is a fail — refused at WRITE
  // time, not rendered.
  const runId = freshRun();
  const r = gate([
    "hold", "--origin", "supervisor", "--question", "q?", "--recommendation", "r",
    "--run", runId,
  ]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /alternatives/);
  assert.ok(!existsSync(holdsPath(runId)), "a refused hold must leave no store");
});

test("a hold whose options carry no priced cost is refused at write, not rendered", () => {
  // NO option is priced here — not even one. UNKNOWN alongside a priced cost is
  // allowed (the render test below covers it); a hold where nothing is priced
  // is not, because its options would never carry a cost for Mateusz to weigh.
  const runId = freshRun();
  const r = gate([
    "hold",
    "--origin", "supervisor",
    "--question", "wznawiać dev-1 po crashu?",
    "--recommendation", "wznów na tym samym sesion id",
    "--option", JSON.stringify({ label: "spawn od zera", model: "test/unpriced-model" }),
    "--run", runId,
  ]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /no option carries a priced cost/);
  assert.ok(!existsSync(holdsPath(runId)));
});

test("an option carrying costUsdReported is refused — the stream's figure is not a price", () => {
  // FOC-165 carries over: costUsdReported must never appear in a hold's options.
  const runId = freshRun();
  const r = gate([
    ...HOLD_ARGS({
      extra: ["--option", JSON.stringify({ label: "x", model: "test/priced-model", costUsdReported: 0.21 })],
    }),
    "--run", runId,
  ]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /costUsdReported/);
  assert.ok(!existsSync(holdsPath(runId)));
});

test("a numeric costUsd with no price row is refused, naming the model and the fix", () => {
  const runId = freshRun();
  const r = gate([
    ...HOLD_ARGS({
      extra: ["--option", JSON.stringify({ label: "x", model: "test/unpriced-model", costUsd: 0.5 })],
    }),
    "--run", runId,
  ]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /test\/unpriced-model/);
  assert.match(parse(r).error, /config\/models\.json/);
  assert.ok(!existsSync(holdsPath(runId)));
});

test("a negative or non-numeric costUsd is refused", () => {
  const runId = freshRun();
  for (const bad of [-1, "cheap"]) {
    const r = gate([
      ...HOLD_ARGS({
        extra: ["--option", JSON.stringify({ label: "x", model: "test/priced-model", costUsd: bad })],
      }),
      "--run", runId,
    ]);
    assert.equal(r.status, 1, `costUsd ${JSON.stringify(bad)} was accepted`);
    assert.ok(!existsSync(holdsPath(runId)), `costUsd ${JSON.stringify(bad)} left a store behind`);
  }
});

// ── 3. AC2 — answers survive restart; answered once; append-only ─────────────
console.log("\nanswer --hold — odpowiedź przeżywa proces");

test("an answer recorded by one process is in force for the next, and stays singular", () => {
  const runId = freshRun();
  gate([...HOLD_ARGS(), "--run", runId]);

  // Separate CLI invocation = fresh module instance, everything read from disk.
  const r = gate(["answer", "--hold", "hold-1", "--text", "wznów", "--note", "TEST passed", "--run", runId]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(parse(r).next, /in force/);

  // Read the FILE back (a new readHolds in a new process): the answer is there.
  const store = readStore(runId);
  const hold = store.holds[0];
  assert.equal(hold.state, "answered");
  assert.equal(hold.answer.text, "wznów");
  assert.equal(hold.answer.note, "TEST passed");
  assert.ok(hold.answer.answeredAt);

  // History is append-only: created AND answered, in order, both readable back.
  assert.deepEqual(hold.history.map((h) => h.event), ["created", "answered"]);

  // A second answer is refused and NAMES the answer in force.
  const second = gate(["answer", "--hold", "hold-1", "--text", "nie, jednak nie", "--run", runId]);
  assert.equal(second.status, 1);
  assert.match(parse(second).error, /the answer in force is "wznów"/);
  assert.match(parse(second).hint, /a hold is answered once/);

  // The refusal rewrote nothing: still exactly the two history entries.
  const after = readStore(runId);
  assert.deepEqual(after.holds[0].history.map((h) => h.event), ["created", "answered"]);
  assert.equal(after.holds[0].answer.text, "wznów");
});

test("the store read back carries every hold's history — append-only across holds", () => {
  const runId = freshRun();
  gate([...HOLD_ARGS(), "--run", runId]);
  gate([...HOLD_ARGS({ question: "druga?" }), "--run", runId]);
  gate(["answer", "--hold", "hold-2", "--text", "odpowiedź na drugą", "--run", runId]);
  gate(["defer", "--hold", "hold-1", "--until", "2999-01-01T00:00:00Z", "--run", runId]);

  const store = readStore(runId);
  assert.equal(store.holds.length, 2, "both entries are in the file");
  assert.deepEqual(store.holds[0].history.map((h) => h.event), ["created", "deferred"]);
  assert.deepEqual(store.holds[1].history.map((h) => h.event), ["created", "answered"]);
  assert.equal(store.holds[1].state, "answered");
  assert.equal(store.holds[0].state, "open", "a deferral is not an answer");
});

test("answer refuses an unknown hold and lists the ones that exist; --gate and --hold are exclusive", () => {
  const runId = freshRun();
  gate([...HOLD_ARGS(), "--run", runId]);
  const unknown = gate(["answer", "--hold", "hold-9", "--text", "x", "--run", runId]);
  assert.equal(unknown.status, 1);
  assert.deepEqual(parse(unknown).known, ["hold-1"]);

  const both = gate(["answer", "--hold", "hold-1", "--gate", "gate-dev-1-1", "--text", "x", "--run", runId]);
  assert.equal(both.status, 1);
  assert.match(parse(both).error, /mutually exclusive/);
});

test("defer requires --hold and a parseable --until; an answered hold is not deferrable", () => {
  const runId = freshRun();
  gate([...HOLD_ARGS(), "--run", runId]);
  assert.equal(gate(["defer", "--until", "2999-01-01T00:00:00Z", "--run", runId]).status, 1);
  assert.equal(gate(["defer", "--hold", "hold-1", "--run", runId]).status, 1);
  const badTs = gate(["defer", "--hold", "hold-1", "--until", "kiedyś", "--run", runId]);
  assert.equal(badTs.status, 1);
  assert.match(parse(badTs).error, /not a parseable timestamp/);

  gate(["answer", "--hold", "hold-1", "--text", "done", "--run", runId]);
  const deferred = gate(["defer", "--hold", "hold-1", "--until", "2999-01-01T00:00:00Z", "--run", runId]);
  assert.equal(deferred.status, 1);
  assert.match(parse(deferred).error, /already answered/);
});

// ── 4. the turn-end guard ────────────────────────────────────────────────────
console.log("\nguard — blokada końca tury");

test("the guard blocks on an un-presented open hold and names it", () => {
  const runId = freshRun();
  assert.equal(guard(runId).status, 0, "no holds, no block");
  gate([...HOLD_ARGS(), "--run", runId]);

  const r = guard(runId);
  assert.equal(r.status, 2, "an open, never-presented hold is owed work — exactly like a pending gate");
  assert.match(r.stderr, /hold-1/);
});

test("AC2: presented-unanswered still blocks; future defer quiets it; past defer resurfaces; answer closes it", () => {
  const runId = freshRun();
  gate([...HOLD_ARGS(), "--run", runId]);

  // Presenting is not laundering: presented but neither answered nor deferred
  // still blocks — the answer is still owed.
  assert.equal(gate(["list", "--open", "--run", runId]).status, 0);
  assert.equal(guard(runId).status, 2, "presented but unanswered still owes the answer");

  // `defer --until` in the FUTURE: the guard leaves it alone.
  const future = gate(["defer", "--hold", "hold-1", "--until", "2999-01-01T00:00:00Z", "--run", runId]);
  assert.equal(future.status, 0, future.stdout + future.stderr);
  assert.equal(guard(runId).status, 0, "a deferred hold does not block the turn end");

  // `defer --until` in the PAST: it resurfaces — counts as open again, blocks again.
  assert.equal(gate(["defer", "--hold", "hold-1", "--until", "2020-01-01T00:00:00Z", "--run", runId]).status, 0);
  assert.equal(guard(runId).status, 2, "an expired deferral resurfaced the hold");

  // Only an ANSWER closes a hold for good.
  assert.equal(gate(["answer", "--hold", "hold-1", "--text", "wznów", "--run", runId]).status, 0);
  assert.equal(guard(runId).status, 0);
});

test("the guard fails closed on a holds store nobody can parse", () => {
  const runId = freshRun();
  writeFileSync(holdsPath(runId), "{not json");
  const r = guard(runId);
  assert.equal(r.status, 2, "unreadable must not read as nothing owed");
  assert.match(r.stderr, /holds store unreadable/);
});

test("holdBlocksTurnEnd matches the three-line rule; a missing store is no holds, no error", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const base = { state: "open", presentedAt: null, until: null };
  assert.equal(holdBlocksTurnEnd(base, now), true, "open + not presented blocks");
  assert.equal(holdBlocksTurnEnd({ ...base, presentedAt: "2026-09-30T10:00:00Z" }, now), true, "presented + no answer + no deferral blocks");
  assert.equal(holdBlocksTurnEnd({ ...base, presentedAt: "2026-09-30T10:00:00Z", until: "2999-01-01T00:00:00Z" }, now), false, "deferred into the future does not block");
  assert.equal(holdBlocksTurnEnd({ ...base, presentedAt: "2026-09-30T10:00:00Z", until: "2026-09-30T11:00:00Z" }, now), true, "an expired deferral resurfaces");
  assert.equal(holdBlocksTurnEnd({ ...base, state: "answered", presentedAt: "2026-09-30T10:00:00Z", until: "2020-01-01T00:00:00Z" }, now), false, "answered never blocks again");
  assert.deepEqual(holdsOwingTurnEnd("no-such-run-here"), { blocking: [], error: null });
});

// ── 5. AC1 — blocks: null means nothing waits ────────────────────────────────
console.log("\nAC1 — otwarta blokada nie zatrzymuje sąsiadów");

test("AC1: an open hold stops only the queue item that names it", () => {
  const runId = freshRun();
  gate([...HOLD_ARGS(), "--run", runId]);
  gate([...HOLD_ARGS({ question: "druga, na nikim nie zależy" }), "--run", runId]);

  // A fixture queue: two independent items and one that names hold-1.
  const items = [
    { id: "queue.dev-2", dependsOn: null },
    { id: "queue.review-1", dependsOn: "hold-1" },
    { id: "queue.test-1" },
  ];
  const holds = readHolds(runId).holds;

  let part = partitionByHolds(items, holds);
  assert.deepEqual(part.runnable.map((i) => i.id), ["queue.dev-2", "queue.test-1"],
    "the independent items complete while the hold sits open");
  assert.deepEqual(part.waiting.map((i) => i.id), ["queue.review-1"], "only the dependent one waits");
  assert.deepEqual(part.blocks["hold-1"], ["queue.review-1"]);
  // THE assertion the AC names: blocks: null on hold-2, and nothing about
  // hold-2 stops anything.
  assert.equal(part.blocks["hold-2"], null);

  // The record field carries what the partition computed.
  setHoldBlocks(runId, part.blocks);
  const store = readStore(runId);
  assert.deepEqual(store.holds[0].blocks, ["queue.review-1"]);
  assert.equal(store.holds[1].blocks, null);

  // The answer releases exactly the dependent item.
  gate(["answer", "--hold", "hold-1", "--text", "idź", "--run", runId]);
  part = partitionByHolds(items, readHolds(runId).holds);
  assert.deepEqual(part.runnable.map((i) => i.id), ["queue.dev-2", "queue.review-1", "queue.test-1"]);
  assert.deepEqual(part.waiting, []);
  assert.equal(part.blocks["hold-1"], null, "blocks: null — nothing waits any more");
});

test("setHoldBlocks refuses unknown holds and non-id blocks", () => {
  const runId = freshRun();
  assert.throws(() => setHoldBlocks(runId, { "hold-9": ["x"] }), /does not exist/);
  gate([...HOLD_ARGS(), "--run", runId]);
  assert.throws(() => setHoldBlocks(runId, { "hold-1": [42] }), /array of item ids/);
});

// ── 6. neverCovers — refused at load, per entry, no shared loop ──────────────
console.log("\nneverCovers — nigdy objęte holdem");

// A valid hold record otherwise — so each block below isolates the resolution
// field as the ONLY reason the store is refused.
function rawHold(over = {}) {
  return {
    id: "hold-1",
    origin: "supervisor",
    question: "q?",
    options: [PRICED_OPTION],
    recommendation: "r",
    impact: "medium",
    resolution: null,
    state: "open",
    createdAt: "2026-09-30T00:00:00Z",
    presentedAt: null,
    until: null,
    answer: null,
    blocks: null,
    history: [{ event: "created", at: "2026-09-30T00:00:00Z" }],
    ...over,
  };
}
function seedStore(runId, hold) {
  writeFileSync(holdsPath(runId), JSON.stringify({ version: HOLDS_SCHEMA_VERSION, holds: [hold] }));
}

test("neverCovers 'push': a hold naming it is refused at write AND at load", () => {
  const runId = freshRun();
  const r = gate([...HOLD_ARGS({ extra: ["--resolution", "push"] }), "--run", runId]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /\bpush\b/);
  assert.ok(!existsSync(holdsPath(runId)));
  seedStore(runId, rawHold({ resolution: "push" }));
  assert.throws(() => readHolds(runId), /\bpush\b.*neverCovers/, "refused at load, not honoured");
});

test("neverCovers 'force': a hold naming it is refused at write AND at load", () => {
  const runId = freshRun();
  const r = gate([...HOLD_ARGS({ extra: ["--resolution", "force"] }), "--run", runId]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /\bforce\b/);
  seedStore(runId, rawHold({ resolution: "force" }));
  assert.throws(() => readHolds(runId), /\bforce\b.*neverCovers/);
});

test("neverCovers 'discard': a hold naming it is refused at write AND at load", () => {
  const runId = freshRun();
  const r = gate([...HOLD_ARGS({ extra: ["--resolution", "discard"] }), "--run", runId]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /\bdiscard\b/);
  seedStore(runId, rawHold({ resolution: "discard" }));
  assert.throws(() => readHolds(runId), /\bdiscard\b.*neverCovers/);
});

test("neverCovers 'delete-branch': a hold naming it is refused at write AND at load", () => {
  const runId = freshRun();
  const r = gate([...HOLD_ARGS({ extra: ["--resolution", "delete-branch"] }), "--run", runId]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /delete-branch/);
  seedStore(runId, rawHold({ resolution: "delete-branch" }));
  assert.throws(() => readHolds(runId), /delete-branch.*neverCovers/);
});

test("neverCovers 'secrets': a hold naming it is refused at write AND at load", () => {
  const runId = freshRun();
  const r = gate([...HOLD_ARGS({ extra: ["--resolution", "secrets"] }), "--run", runId]);
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /\bsecrets\b/);
  seedStore(runId, rawHold({ resolution: "secrets" }));
  assert.throws(() => readHolds(runId), /\bsecrets\b.*neverCovers/);
});

test("the five entries are exactly NEVER_COVERS — no drift between the two lists", () => {
  assert.deepEqual(NEVER_COVERS, ["push", "force", "discard", "delete-branch", "secrets"]);
});

// ── 7. versioning of the store itself ────────────────────────────────────────
console.log("\nwersjonowanie");

test("an unsupported store version is refused, never guessed across", () => {
  assert.throws(
    () => validateHoldStore({ version: 2, holds: [] }),
    /version/,
  );
  assert.throws(() => validateHoldStore({ holds: [] }), /version/, "a store with no version is not v1 by default");
});

test("the loader refuses a hand-broken hold, naming the field", () => {
  const runId = freshRun();
  seedStore(runId, rawHold({ recommendation: "" }));
  assert.throws(() => readHolds(runId), /recommendation/);
  seedStore(runId, rawHold({ options: [] }));
  assert.throws(() => readHolds(runId), /options/);
});

// ── 8. hasPriceRow — the pricing basis check ─────────────────────────────────
console.log("\nhasPriceRow — wycena przez config/models.json");

test("exact, short-name, other-scope and unpriced resolution", () => {
  assert.equal(hasPriceRow("test/priced-model", MODELS_ROOT).priced, true);
  assert.equal(hasPriceRow("priced-model", MODELS_ROOT).priced, true, "short-name match, as resolveInScope does");
  assert.equal(hasPriceRow("test/other-scope", MODELS_ROOT).priced, true, "a non-openrouter scope counts");
  assert.equal(hasPriceRow("test/unpriced-model", MODELS_ROOT).priced, false);
});

test("a flat pricing shape is treated as the openrouter scope, like pricingSnapshot", () => {
  const flatRoot = mkdtempSync(join(tmpdir(), "la-sup-holds-flat-"));
  cleanupLater(flatRoot);
  mkdirSync(join(flatRoot, "config"), { recursive: true });
  writeFileSync(
    join(flatRoot, "config", "models.json"),
    JSON.stringify({ pricing: { "flat/model": { input: 1, output: 2 } } }),
  );
  assert.equal(hasPriceRow("flat/model", flatRoot).priced, true);
});

test("an unreadable pricing table is priced:false WITH the error, never silently unpriced", () => {
  const empty = mkdtempSync(join(tmpdir(), "la-sup-holds-empty-"));
  cleanupLater(empty);
  const out = hasPriceRow("test/priced-model", empty);
  assert.equal(out.priced, false);
  assert.match(out.error, /could not be read/);
});

// ── 9. run completion — no run completes over an open hold ───────────────────
console.log("\nrun completion — run nie kończy się z otwartym holdem");

// graph-runner harnesses are async; this file's shared harness is sync, so the
// completion tests are queued here and awaited just before the summary, with
// their failures folded into the same PASS/FAIL stream and count.
const asyncTests = [];
const testAsync = (name, fn) => asyncTests.push({ name, fn });

const graphConfig = JSON.parse(readFileSync(join(ROOT, "config", "graph.json"), "utf8"));

// A minimal v2 graph: the real plan node's contract fields with ONLY the
// plan.push step (copied verbatim from config/graph.json, so it carries the
// exact D7 field set graph-validate requires AND satisfies the step↔registry
// cross-check against config/decisions.json) and an empty stepFlow — the
// runner walks zero steps and reaches the completion line directly. The [D]
// step's real execution path is graph-runner.test.mjs's territory; this file
// only exercises what sits AFTER the walk.
function completionGraph() {
  const plan = graphConfig.nodes.plan;
  return {
    version: 2,
    entryNodes: ["plan"],
    edges: [],
    nodes: {
      plan: {
        ...plan,
        steps: { "plan.push": plan.steps["plan.push"] },
        stepFlow: [],
      },
    },
  };
}

// The reads `plan.push` (a [D] step, copied verbatim from config/graph.json)
// consumes to build its linear payload — including the rendered issue text
// plan.render (FOC-520) puts on the chain before gate2. The runner resolves
// reads from inputs before the step runs; the shapes are loose on purpose —
// the fixture only needs the step to reach "done" (the linearEffect stub
// answers it) so the walk ends and the completion line is what the tests
// exercise.
const COMPLETION_INPUTS = {
  "plan.decompose.record": { output: { tasks: [] } },
  "plan.render.issueText": "Rendered issue text (fixture).",
  "gate.plan.gate2.record": { status: "answered" },
};

const tempStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "la-sup-holds-runner-"));
  cleanupLater(dir);
  return join(dir, "graph-steps.jsonl");
};

const completionRunner = (runId, { storePath, listOpenHolds } = {}) =>
  createGraphRunner({
    graph: completionGraph(),
    runId,
    storePath,
    caller: async () => {
      throw new Error("no seam calls in this fixture");
    },
    generator: async () => {
      throw new Error("no generator calls in this fixture");
    },
    linearEffect: async () => ({ epicId: "FEN-900", childrenIds: ["FEN-901"], handoffCommentPosted: true }),
    ...(listOpenHolds ? { listOpenHolds } : {}),
  });

testAsync("closing a run with an open hold refuses and names the open holds", async () => {
  const runner = completionRunner("run-holds-open", {
    storePath: tempStore(),
    listOpenHolds: () => ({ open: [{ id: "hold-1", question: "?" }], error: null }),
  });
  const result = await runner.run({ inputs: COMPLETION_INPUTS });
  assert.equal(result.status, "stopped");
  assert.equal(result.record.error.code, "holds_open");
  assert.match(result.record.error.message, /hold-1/, "the refusal names the open hold");
  assert.deepEqual(result.record.openHolds, [{ id: "hold-1", question: "?" }]);
});

testAsync("closing a run with no open holds completes", async () => {
  const runner = completionRunner("run-no-holds", {
    storePath: tempStore(),
    listOpenHolds: () => ({ open: [], error: null }),
  });
  assert.equal((await runner.run({ inputs: COMPLETION_INPUTS })).status, "completed");
});

testAsync("an unreadable holds store refuses completion too — fail-closed", async () => {
  const runner = completionRunner("run-broken-holds", {
    storePath: tempStore(),
    listOpenHolds: () => ({ open: [], error: "holds.json is not readable JSON: boom" }),
  });
  const result = await runner.run({ inputs: COMPLETION_INPUTS });
  assert.equal(result.status, "stopped");
  assert.equal(result.record.error.code, "holds_unreadable");
});

testAsync("the DEFAULT completion check reads the holds store through the seam: hold blocks, answer releases", async () => {
  const runId = freshRun();
  gate([...HOLD_ARGS(), "--run", runId]);
  // No listOpenHolds injected — the default reads <STATE_HOME>/<runId>/holds.json.
  const runner = completionRunner(runId, { storePath: tempStore() });

  const refused = await runner.run({ inputs: COMPLETION_INPUTS });
  assert.equal(refused.status, "stopped");
  assert.equal(refused.record.error.code, "holds_open");
  assert.match(refused.record.error.message, /hold-1/);

  // The answer is the only key that opens the door — a deferral does not.
  assert.equal(gate(["defer", "--hold", "hold-1", "--until", "2999-01-01T00:00:00Z", "--run", runId]).status, 0);
  const stillRefused = await runner.run({ inputs: COMPLETION_INPUTS });
  assert.equal(stillRefused.status, "stopped", "a deferred hold is unanswered — the run stays open");
  assert.equal(stillRefused.record.error.code, "holds_open");

  assert.equal(gate(["answer", "--hold", "hold-1", "--text", "idź", "--run", runId]).status, 0);
  assert.equal((await runner.run({ inputs: COMPLETION_INPUTS })).status, "completed", "answered — the run completes");
});

testAsync("holdsForCompletion mirrors the store, and a corrupt one is an error not an empty list", async () => {
  const runId = freshRun();
  assert.deepEqual(holdsForCompletion(runId), { open: [], error: null }, "no store = no holds");
  gate([...HOLD_ARGS(), "--run", runId]);
  const out = holdsForCompletion(runId);
  assert.deepEqual(out.open.map((h) => h.id), ["hold-1"]);
  assert.equal(out.error, null);

  writeFileSync(holdsPath(runId), "{broken");
  const broken = holdsForCompletion(runId);
  assert.deepEqual(broken.open, []);
  assert.match(broken.error, /not readable JSON/);
});

// Run the queued async tests before the summary — the harness is sync, so the
// failures are folded into the same PASS/FAIL stream.
for (const { name, fn } of asyncTests) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    state.passed++;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`);
    state.failures.push(name);
  }
}

summary();
