// scripts/supervisor-headless.test.mjs — a child has no terminal, and three
// separate mechanisms assumed it did.
//
// Found during the first real e2e (2026-08-27), not by any test here. The
// Supervisor reported a child started, an EMPTY console window appeared next to
// it, and the dashboard showed that child as `done` after 6 seconds with 0
// tokens — while the child process was alive, 292 MB in, and 7 042 thinking
// events into the task.
//
// One theme, four defects:
//
//   1. run-manifest recorded `consolePid: process.ppid`. For a supervisor child
//      that is the short-lived spawn process, so the dashboard's reconciler
//      closed the run on "console pid gone" seconds after it started.
//   2. `interactive: true` was hardcoded — a headless run is not interactive.
//   3. The child inherited the Supervisor's RUN_ID, so telemetry-hook.mjs filed
//      the child's session, tokens and cost against the PARENT's run: 54 usage
//      rows and 565k tokens on the Supervisor, 0 on the child.
//   4. `spawn(detached)` without windowsHide gives win32 a console window.
//
// Every one of them is silent. The child still works; only the record lies.
//
// Run: node scripts/supervisor-headless.test.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT, harness } from "./supervisor-test-fixtures.mjs";

const { test, fail, summary } = harness();
const MANIFEST = join(ROOT, "scripts", "run-manifest.mjs");
const SPAWN_SRC = readFileSync(join(ROOT, "scripts", "supervisor-spawn.mjs"), "utf8");

// Strip comments before scanning source: a promise in a comment is not a
// behaviour, and this file has burned that lesson once already elsewhere.
const code = SPAWN_SRC.split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

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

/** Write a manifest into an isolated .state, so the real one is untouched. */
function manifestFor(extraArgs) {
  const home = mkdtempSync(join(tmpdir(), "la-headless-"));
  homes.push(home);
  const runId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}-dev`;

  execFileSync(process.execPath, [MANIFEST, "start", runId, "dev", ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      // Keep this out of the real telemetry store and the real .state/runs.
      LA_TELEMETRY_DB: join(home, "telemetry.sqlite"),
      LA_TELEMETRY_HOME: home,
    },
  });

  const path = join(ROOT, ".state", "runs", `${runId}.json`);
  if (!existsSync(path)) fail(`no manifest written at ${path}`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  rmSync(path, { force: true });
  return manifest;
}

console.log("\nrun bez konsoli");

test("--headless records no console pid", () => {
  // The whole bug: process.ppid here is the caller, and for a supervisor child
  // the caller exits in seconds. A null pid is the honest answer and the
  // reconciler already knows how to handle one — it judges by transcript
  // idleness instead.
  const m = manifestFor(["--headless"]);
  assert.equal(m.consolePid, null, "a headless run recorded a console pid");
});

test("--headless is not interactive", () => {
  const m = manifestFor(["--headless"]);
  assert.equal(m.interactive, false);
});

test("without the flag nothing changes for launcher runs", () => {
  // The .bat launchers depend on consolePid: the terminal panel uses it to focus
  // and stop the right window, and the reconciler uses it to close a run whose
  // window was shut. This flag must not touch them.
  const m = manifestFor([]);
  assert.ok(Number.isInteger(m.consolePid) && m.consolePid > 0, `expected a real pid, got ${m.consolePid}`);
  assert.equal(m.interactive, true);
});

test("--headless does not eat the optional source argument", () => {
  // `start <runId> <squad> [sourcePath]` — the flag is positional-adjacent, and
  // a naive implementation would read it as the source path.
  const m = manifestFor(["--headless"]);
  assert.equal(m.source, null, `--headless leaked into source: ${m.source}`);
});

console.log("\nspawn nie udaje terminala");

test("spawn starts its telemetry run headless", () => {
  assert.match(code, /"start",\s*telemetryRunId,\s*squad,\s*"--headless"/);
});

test("the detached watcher gets windowsHide", () => {
  // win32 gives a detached process its own console unless told otherwise. An
  // empty window is not just noise — it invites someone to type into a session
  // nobody is reading, which is the one thing ADR-0009 exists to prevent.
  assert.match(code, /windowsHide:\s*true/);
});

test("the child's env carries its OWN telemetry run id", () => {
  // telemetry-hook.mjs reads RUN_ID / LA_RUN_ID on SessionStart. The child
  // inherits the Supervisor's environment, so without this override every
  // child's session, tokens and cost were filed against the parent.
  assert.match(code, /RUN_ID:\s*telemetryRunId/);
  assert.match(code, /LA_RUN_ID:\s*telemetryRunId/);
});

test("LA_SUPERVISOR_RUN still points at the Supervisor", () => {
  // Two different ideas that were sharing one value by accident: the telemetry
  // run is the child's, the supervisor run addresses the gate and registry
  // directory and genuinely belongs to the parent. Overriding both would break
  // every gate the child raises.
  assert.match(code, /LA_SUPERVISOR_RUN:\s*runId/);
  assert.doesNotMatch(code, /LA_SUPERVISOR_RUN:\s*telemetryRunId/);
});

summary();
