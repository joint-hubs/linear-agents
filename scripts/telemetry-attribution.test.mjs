// scripts/telemetry-attribution.test.mjs — a child's tokens belong to the child.
//
// Found 2026-08-31 by reading the store, not by any test here: 9 149 usage
// events were attributed to more than one run, double-counting 1.25 billion
// tokens and 52.5% of the recorded cost. $1 949 of that sat on `supervisor`
// runs — one run showed 94.8M tokens of which only 24.2M were its own.
//
// TWO defects, both reproduced by running the hook under the two environments
// the two launch paths actually build:
//
//   A. supervisor-followup.mjs did not override RUN_ID/LA_RUN_ID the way
//      supervisor-spawn.mjs does. `claude --resume` fires SessionStart like any
//      other start, so every FOLLOW-UP turn filed the child's session against
//      the parent's run. Turn 0 was fixed in 06051c6 and turns 1..n were not,
//      which is why the earlier fix looked complete and was not.
//
//   B. telemetry-hook.mjs preferred process.env.CLAUDE_CODE_SESSION_ID over the
//      session id on stdin. A child launched from inside another Claude session
//      inherits the PARENT's value, so it recorded the parent's session id.
//
// Both now fail closed: when there is no telemetry run the launchers export an
// EMPTY RUN_ID rather than leaving the parent's inherited. A child recorded
// nowhere is a visible gap; a child recorded against its parent silently
// doubles the parent's cost, which is the failure that actually happened.
//
// Run: node scripts/telemetry-attribution.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT, harness } from "./supervisor-test-fixtures.mjs";

const { test, fail, summary } = harness();
const HOOK = join(ROOT, "scripts", "telemetry-hook.mjs");

const homes = [];
process.on("exit", () => {
  for (const h of homes) {
    try {
      rmSync(h, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/**
 * Run telemetry-hook.mjs against an isolated store and return the session links
 * it wrote. `env` is merged over a cleared baseline so the ambient
 * CLAUDE_CODE_SESSION_ID of whoever runs the suite cannot leak in — that leak
 * is defect B, and a test that inherits it would pass for the wrong reason.
 */
function linksFor(env, payload) {
  const home = mkdtempSync(join(tmpdir(), "la-attrib-"));
  homes.push(home);
  const db = join(home, "telemetry.sqlite");

  const clean = { ...process.env };
  delete clean.CLAUDE_CODE_SESSION_ID;
  delete clean.RUN_ID;
  delete clean.LA_RUN_ID;

  try {
    execFileSync(process.execPath, [HOOK], {
      cwd: ROOT,
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...clean, ...env, LA_TELEMETRY_DB: db, LA_TELEMETRY_HOME: home },
      stdio: ["pipe", "ignore", "pipe"],
    });
  } catch (err) {
    fail(`hook exited non-zero: ${String(err.stderr || err.message).split("\n")[0]}`);
  }

  if (!existsSync(db)) return [];
  // Opened via a child process: node:sqlite is experimental and the suite must
  // not warn on every file that touches the store.
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      `const{DatabaseSync}=require("node:sqlite");
       const d=new DatabaseSync(process.argv[1],{readOnly:true});
       console.log(JSON.stringify(d.prepare("SELECT run_id,session_id,source FROM run_sessions").all()));`,
      db,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return JSON.parse(out);
}

const PAYLOAD = { session_id: "CHILD-SESSION", hook_event_name: "SessionStart" };

console.log("\ndziecko nie jest rodzicem");

test("a spawn-shaped env files the child against the CHILD's run", () => {
  const links = linksFor({ RUN_ID: "CHILD-RUN", LA_RUN_ID: "CHILD-RUN" }, PAYLOAD);
  assert.equal(links.length, 1, JSON.stringify(links));
  assert.equal(links[0].run_id, "CHILD-RUN");
  assert.equal(links[0].session_id, "CHILD-SESSION");
});

test("an inherited supervisor RUN_ID wins nothing once the child sets its own", () => {
  // The shape of the bug: LA_RUN_ID is read before RUN_ID, so a launcher that
  // sets only one of the two leaves the other inherited from the parent. Both
  // must be exported together or the parent's value comes back through the gap.
  const links = linksFor({ RUN_ID: "SUPERVISOR-RUN", LA_RUN_ID: "CHILD-RUN" }, PAYLOAD);
  assert.equal(links.length, 1, JSON.stringify(links));
  assert.equal(links[0].run_id, "CHILD-RUN");

  const reversed = linksFor({ RUN_ID: "CHILD-RUN", LA_RUN_ID: "" }, PAYLOAD);
  assert.equal(reversed.length, 1, JSON.stringify(reversed));
  assert.equal(reversed[0].run_id, "CHILD-RUN", "an empty LA_RUN_ID must fall through to RUN_ID");
});

test("an inherited parent session id does not win over the payload", () => {
  // Defect B: with env first, this recorded PARENT-SESSION.
  const links = linksFor(
    { RUN_ID: "CHILD-RUN", LA_RUN_ID: "CHILD-RUN", CLAUDE_CODE_SESSION_ID: "PARENT-SESSION" },
    PAYLOAD,
  );
  assert.equal(links.length, 1, JSON.stringify(links));
  assert.equal(links[0].session_id, "CHILD-SESSION");
});

test("the env var still answers when the payload carries no session id", () => {
  // It is a fallback, not dead code — some hook events have no session id.
  const links = linksFor(
    { RUN_ID: "CHILD-RUN", LA_RUN_ID: "CHILD-RUN", CLAUDE_CODE_SESSION_ID: "FROM-ENV" },
    { hook_event_name: "SessionStart" },
  );
  assert.equal(links.length, 1, JSON.stringify(links));
  assert.equal(links[0].session_id, "FROM-ENV");
});

test("an empty RUN_ID records nothing rather than guessing", () => {
  // Fail-closed. No run id means no link — NOT a link to whatever run happened
  // to be in the environment.
  const links = linksFor({ RUN_ID: "", LA_RUN_ID: "" }, PAYLOAD);
  assert.equal(links.length, 0, `expected no link, got ${JSON.stringify(links)}`);
});

console.log("\nlaunchery eksportują własny run, nie rodzica");

// Source assertions, following supervisor-headless.test.mjs: the env plumbing
// between three processes (supervisor → watcher → claude) cannot be exercised
// end to end without launching a real model, and the defect lived in exactly
// one missing key of one object literal.
const strip = (s) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

const followup = strip(readFileSync(join(ROOT, "scripts", "supervisor-followup.mjs"), "utf8"));
const spawnSrc = strip(readFileSync(join(ROOT, "scripts", "supervisor-spawn.mjs"), "utf8"));

test("followup exports the child's telemetry run", () => {
  assert.match(followup, /RUN_ID:\s*entry\.telemetryRunId/);
  assert.match(followup, /LA_RUN_ID:\s*entry\.telemetryRunId/);
});

test("followup keeps LA_SUPERVISOR_RUN pointing at the supervisor", () => {
  // Two different ideas: the telemetry run is the child's, the supervisor run
  // addresses the gate and registry directories and belongs to the parent.
  // Overriding both would break every gate the child raises.
  assert.match(followup, /LA_SUPERVISOR_RUN:\s*runId/);
});

test("neither launcher leaves RUN_ID conditionally inherited", () => {
  // `...(x ? {RUN_ID: x} : {})` reads as safe and is not: the fallback is the
  // parent's value, so a telemetry hiccup becomes a mis-billed child.
  for (const [name, src] of [["followup", followup], ["spawn", spawnSrc]]) {
    if (/\.\.\.\(\s*\w[\w.]*\s*\?\s*\{\s*RUN_ID/.test(src)) {
      fail(`${name} still spreads RUN_ID conditionally — an absent run inherits the parent's`);
    }
  }
});

summary();
