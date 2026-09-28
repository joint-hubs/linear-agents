#!/usr/bin/env node
// scripts/supervisor-guard.mjs — the Stop-hook turn-end guard (FOC-609).
//
//   node scripts/supervisor-guard.mjs [--run <id>]     (Stop hook: payload on stdin)
//
// The Supervisor session must not end a turn while it still owes work: a child
// running, a spawn held for a slot, a gate awaiting an answer. The harness calls
// this script when the session tries to stop:
//
//   · exit 0  — allow the stop (nothing owed, or a --wait is armed, or the
//               block budget is exhausted — see below)
//   · exit 2  — block the stop; stderr names what is still live/held/pending
//
// `stop_hook_active: true` in the payload means this stop is already the result
// of a previous block: exit 0 immediately, or blocking again would loop forever.
//
// Block budget 3 (consecutive). Blocks 1–3 exit 2; the count is persisted in
// guard/state.json, so the budget survives across turns. On the 4th consecutive
// block the guard concludes the lead is stuck in a stop-restart loop, allows the
// turn to end, and records exactly one alarm in guard/alarms.jsonl — evidence
// for the escalation instead of an infinite loop.
//
// PRIVACY (FOC-220): nothing from tool results or tees is persisted. The alarm
// carries ids, statuses and gate KINDS — never gate summaries or event text.
//
// Writer discipline: this script writes ONLY guard/state.json and
// guard/alarms.jsonl under the run dir. The registry, the wake queue, gates and
// held records are read-only here (they belong to the watcher / spawn / gate /
// status, see supervisor-lib.mjs). wait-armed.json is written by --wait, not by
// this script; the guard only reads it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  GUARD_BLOCK_LIMIT,
  guardAlarmsPath,
  guardDir,
  guardStatePath,
  liveChildren,
  parseArgs,
  readHeld,
  readJsonOr,
  readRegistry,
  readWaitArmed,
  runDir,
} from "./supervisor-lib.mjs";
import { atomicWriteJSON } from "./utils.mjs";

// Read the hook payload from stdin. Tolerant: an empty or malformed payload is
// an unknown stop, not a crash — the guard still judges the run's own state.
function readPayload() {
  try {
    return JSON.parse(readFileSync(0, "utf8")) ?? {};
  } catch {
    return {};
  }
}

function pendingGateRefs(runId) {
  const dir = join(runDir(runId), "gates");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const gate = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (gate.status === "pending") out.push({ gateId: gate.gateId ?? file.replace(/\.json$/, ""), kind: gate.kind ?? null });
    } catch {
      // Unreadable is not absent — same rule as hasPendingGate: a gate nobody
      // can parse still counts as an open question.
      out.push({ gateId: file.replace(/\.json$/, ""), kind: "unreadable" });
    }
  }
  return out;
}

// Counted blocks only. state.json is the guard's own single-writer record, so
// read-modify-write needs no lock (one Stop hook fires per turn end).
function readBlockCount(runId) {
  const state = readJsonOr(guardStatePath(runId), null);
  return typeof state?.consecutiveBlocks === "number" ? state.consecutiveBlocks : 0;
}

function resetCounter(runId) {
  mkdirSync(guardDir(runId), { recursive: true });
  atomicWriteJSON(guardStatePath(runId), { consecutiveBlocks: 0, updatedAt: new Date().toISOString() });
}

const allow = (runId, note = "") => {
  if (note) console.error(note);
  if (runId && readBlockCount(runId) > 0) resetCounter(runId);
  process.exit(0);
};

const payload = readPayload();

// A stop that is itself the product of a previous block: never block again.
if (payload.stop_hook_active === true) process.exit(0);

const args = parseArgs(process.argv.slice(2));
const runId = args.run || process.env.LA_SUPERVISOR_RUN;

// No run resolvable, or the run dir is not there yet: nothing to guard.
if (!runId || !existsSync(runDir(runId))) process.exit(0);

const live = liveChildren(readRegistry(runId));
const held = readHeld(runId);
const pending = pendingGateRefs(runId);
const wait = readWaitArmed(runId);

if (!live.length && !held.length && !pending.length) {
  // Nothing owed. An expired marker may still be on disk — it is expired, so
  // the guard's answer does not depend on it and it is left for its owner.
  allow(runId);
}

// A `--wait` blocked in this turn is the one legitimate way to end a turn with
// work outstanding: the turn is not really ending while the wait holds it open.
if (wait.armed) allow(runId);

const describe = () => {
  const parts = [];
  if (live.length) parts.push(`${live.length} live child(ren): ${live.map((c) => `${c.childId} (${c.status})`).join(", ")}`);
  if (held.length) parts.push(`${held.length} held spawn(s): ${held.map((h) => h.heldId).join(", ")}`);
  if (pending.length) parts.push(`${pending.length} pending gate(s): ${pending.map((g) => `${g.gateId}${g.kind ? ` [${g.kind}]` : ""}`).join(", ")}`);
  return parts.join("; ");
};

const blocks = readBlockCount(runId) + 1;

if (blocks <= GUARD_BLOCK_LIMIT) {
  mkdirSync(guardDir(runId), { recursive: true });
  atomicWriteJSON(guardStatePath(runId), {
    consecutiveBlocks: blocks,
    lastBlockAt: new Date().toISOString(),
    lastReason: describe(),
  });
  console.error(
    `supervisor-guard: turn-end blocked (block ${blocks}/${GUARD_BLOCK_LIMIT}) — still owed: ${describe()}. ` +
      `Do not end the turn: drain the wake queue, judge the events, or issue a --wait.`,
  );
  process.exit(2);
}

// Fourth consecutive block: the lead is not listening. Allow the stop — a hook
// that blocks forever just hangs the session — and leave exactly one alarm as
// the record of what was walked past.
mkdirSync(guardDir(runId), { recursive: true });
appendFileSync(
  guardAlarmsPath(runId),
  JSON.stringify({
    ts: new Date().toISOString(),
    reason: `turn end allowed after ${GUARD_BLOCK_LIMIT} consecutive guard blocks`,
    blocksWaited: GUARD_BLOCK_LIMIT,
    live: live.map((c) => ({ childId: c.childId, squad: c.squad ?? null, status: c.status })),
    held: held.map((h) => ({ heldId: h.heldId, squad: h.squad ?? null })),
    pendingGates: pending,
    waitArmed: wait.armed,
  }) + "\n",
);
resetCounter(runId);
console.error(
  `supervisor-guard: ${GUARD_BLOCK_LIMIT} consecutive blocks — allowing the stop and recording an alarm ` +
    `(guard/alarms.jsonl). Still owed: ${describe()}.`,
);
process.exit(0);
