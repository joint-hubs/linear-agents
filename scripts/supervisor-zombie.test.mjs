// scripts/supervisor-zombie.test.mjs — a turn reported as started actually started.
//
// FOC-271. Observed twice in one run (2026-09-09, 11:25 and 11:44):
// supervisor-followup.mjs answered ok:true, the watcher never got claude off
// the ground, and the registry showed a turn with 0 bytes in the tee and a null
// pid. The Supervisor then waited on a child that did not exist — 7 and 12
// minutes of silence before anyone noticed.
//
// supervisor-spawn.mjs has had this check from the start and refused correctly
// on the same day ("no system/init within 30000 ms"). Only the follow-up path
// was blind, and follow-ups are the frequent path: every gate answer, every
// review loop. Same shape as the RUN_ID and windowsHide omissions — a guard
// added to the turn-0 path and never carried to turns 1..n, in the same pair of
// files. Third time, hence this file.
//
// The signal differs from spawn's on purpose. A resumed session has no new
// session_id to wait for, so what is awaited is the status supervisor-watch.mjs
// writes when it sees system/init: the "starting" followup sets becoming
// "running". A turn that finishes before the poll looks is a terminal status,
// which is success rather than silence.
//
// Run: node scripts/supervisor-zombie.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT, harness } from "./supervisor-test-fixtures.mjs";

const { test, fail, summary } = harness();

const strip = (file) =>
  readFileSync(join(ROOT, "scripts", file), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

const followup = strip("supervisor-followup.mjs");
const spawnSrc = strip("supervisor-spawn.mjs");

console.log("\nfollowup nie melduje tury, ktora nie wystartowala");

test("followup waits on the same timeout spawn does", () => {
  // A second, independent constant would drift from spawn's the first time
  // either was tuned.
  assert.match(followup, /INIT_TIMEOUT_MS/, "followup no longer references the init timeout");
  assert.match(spawnSrc, /INIT_TIMEOUT_MS/, "spawn no longer references the init timeout");
  if (/INIT_TIMEOUT_MS\s*=/.test(followup)) {
    fail("followup defines its own init timeout instead of importing the shared one");
  }
});

test("it polls the registry for a status the watcher writes", () => {
  assert.match(followup, /readRegistry\(runId\)\.children\[childId\]/);
  assert.match(followup, /status === "running"/);
});

test("a turn that already finished counts as started, not as silence", () => {
  // Without this a fast turn would be killed for having succeeded too quickly.
  assert.match(followup, /TERMINAL_STATUSES\.includes\(live\.status\)/);
});

test("a turn that never started is killed and recorded as crashed", () => {
  // Degrading this to a warning would put the zombie back: the Supervisor reads
  // ok:true and waits. It has to be a refusal.
  assert.match(followup, /killTree\(/);
  assert.match(followup, /status:\s*"crashed"/);
  assert.match(followup, /failJson\(/);
  const at = followup.indexOf("if (!started)");
  assert.ok(at > -1, "the not-started branch is gone");
  const branch = followup.slice(at, at + 900);
  assert.match(branch, /no system\/init within/, "the refusal no longer names the cause");
});

test("the reported status is observed, not hardcoded", () => {
  // The original returned status:"running" unconditionally — the same class of
  // lie the wait exists to remove, just one step later.
  assert.match(followup, /status:\s*live\?\.status/);
  if (/status:\s*"running",\s*\n\s*turn:/.test(followup)) {
    fail("followup still hardcodes status:\"running\" in its result");
  }
});

console.log("\nobie sciezki maja ten sam straznik");

test("neither spawn nor followup can report a turn without waiting for init", () => {
  // Checked per file so a failure names the path that regressed, and stated as
  // one test because the invariant is about the PAIR: turn 0 and turns 1..n
  // must be equally verified. Every previous omission was exactly this pair
  // drifting apart.
  for (const [name, src] of [["spawn", spawnSrc], ["followup", followup]]) {
    if (!/INIT_TIMEOUT_MS/.test(src)) fail(`${name} no longer waits for system/init`);
    if (!/killTree\(/.test(src)) fail(`${name} no longer disposes of a child that failed to start`);
    const okAt = src.indexOf("ok: true");
    const waitAt = src.indexOf("INIT_TIMEOUT_MS");
    if (okAt === -1) fail(`${name} no longer reports ok:true`);
    if (waitAt > okAt) fail(`${name} reports success before it waits for init`);
  }
});

summary();
