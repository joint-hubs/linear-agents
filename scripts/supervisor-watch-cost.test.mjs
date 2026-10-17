// scripts/supervisor-watch-cost.test.mjs — the watcher's turn-end cost is the
// child's transcript price, SET not accumulated (FOC-760).
//
// End-to-end through supervisor-watch.mjs itself, with a fake claude behind the
// LA_CLAUDE_BIN seam (the same seam supervisor-test-fixtures.mjs uses): the fake
// emits system/init + THREE result events whose modelUsage is CUMULATIVE — the
// exact shape a background-task wake-up re-emits — and writes a transcript under
// $CLAUDE_CONFIG_DIR/projects/<cwdToHashName(cwd)>/<session>.jsonl. The old
// watcher summed those results (~6x truth); a result-max fallback would read
// ~3x. The registry must carry the transcript price — neither of the others.
//
// Everything runs in temp dirs: LA_SUPERVISOR_STATE_HOME, LA_SQUAD_HOME,
// CLAUDE_CONFIG_DIR, LA_SUPERVISOR_NO_TELEMETRY=1 and no --telemetry-run flag,
// so the real .state/ and the telemetry store are never touched.
//
// Run: node scripts/supervisor-watch-cost.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { cwdToHashName } from "./ledger.mjs";
import { calculateCost, pricingSnapshot } from "./telemetry-store.mjs";
import { costFromResult, ensureRunDir, readRegistry, runDir, writeRegistry } from "./supervisor-lib.mjs";
import { priceTranscripts } from "./transcript-cost.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WATCH = join(ROOT, "scripts", "supervisor-watch.mjs");
const MODEL = "z-ai/glm-5.2";

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

const base = mkdtempSync(join(tmpdir(), "la-watch-cost-"));
const stateHome = join(base, "state");
const squadHome = join(base, "agents");
const configDir = join(base, "config");
const cwd = join(base, "wt");
// Pinned BEFORE any supervisor-lib call: the fixture registry must land in the
// temp tree, never in the repo's real .state/supervisor/.
process.env.LA_SUPERVISOR_STATE_HOME = stateHome;
process.env.LA_SQUAD_HOME = squadHome;
mkdirSync(stateHome, { recursive: true });
mkdirSync(join(squadHome, "dev"), { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
process.on("exit", () => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {}
});

// The fake claude: one session, one transcript, three cumulative results.
const FAKE_CLAUDE = join(base, "fake-claude.mjs");
writeFileSync(
  FAKE_CLAUDE,
  [
    `import { mkdirSync, writeFileSync } from "node:fs";`,
    `import { dirname } from "node:path";`,
    `const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");`,
    `out({ type: "system", subtype: "init", session_id: process.env.FAKE_SESSION_ID, tools: [], model: ${JSON.stringify(MODEL)} });`,
    `const path = process.env.FAKE_TRANSCRIPT_PATH;`,
    `mkdirSync(dirname(path), { recursive: true });`,
    `const line = (id, input, output) => JSON.stringify({`,
    `  type: "assistant",`,
    `  message: { id, model: ${JSON.stringify(MODEL)}, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },`,
    `});`,
    `writeFileSync(path, [line("msg-a", 200000, 5000), line("msg-b", 100000, 3000)].join("\\n") + "\\n");`,
    // Three result events, modelUsage CUMULATIVE across them (1x, 2x, 3x).
    `for (const mult of [1, 2, 3]) {`,
    `  out({`,
    `    type: "result",`,
    `    subtype: "success",`,
    `    session_id: process.env.FAKE_SESSION_ID,`,
    `    total_cost_usd: Number((0.21 * mult).toFixed(4)),`,
    `    usage: { input_tokens: 300000 * mult, output_tokens: 10000 * mult, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },`,
    `    modelUsage: { ${JSON.stringify(MODEL)}: { inputTokens: 300000 * mult, outputTokens: 10000 * mult, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },`,
    `  });`,
    `}`,
    `process.exit(0);`,
    ``,
  ].join("\n"),
);

const runId = `test-watch-cost-${process.pid}`;
ensureRunDir(runId);
// The entry carries the OLD inflated total (5.0) so the test proves SET, not add.
writeRegistry(runId, {
  runId,
  children: {
    "dev-1": {
      childId: "dev-1",
      squad: "dev",
      taskId: "FOC-999",
      status: "starting",
      sessionId: null,
      costUsd: 5.0,
      costSource: "result-max",
      turns: [],
      worktree: cwd,
      permissionMode: "bypassPermissions",
    },
  },
  rounds: {},
});

const sessionId = `watch-cost-${process.pid}`;
const transcriptPath = join(configDir, "projects", cwdToHashName(cwd), `${sessionId}.jsonl`);
const promptFile = join(base, "prompt.txt");
writeFileSync(promptFile, "k");

const result = spawnSync(
  process.execPath,
  [WATCH, "--run", runId, "--child", "dev-1", "--cwd", cwd, "--prompt-file", promptFile, "--turn", "0"],
  {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LA_SUPERVISOR_STATE_HOME: stateHome,
      LA_SQUAD_HOME: squadHome,
      CLAUDE_CONFIG_DIR: configDir,
      LA_SUPERVISOR_NO_TELEMETRY: "1",
      LA_SUPERVISOR_NO_CODEGRAPH: "1",
      LA_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_SESSION_ID: sessionId,
      FAKE_TRANSCRIPT_PATH: transcriptPath,
    },
  },
);

test("the watcher ran the fake claude to a clean exit", () => {
  assert.equal(result.status, 0, `watcher exit ${result.status}: ${result.stderr}`);
  const entry = readRegistry(runId).children["dev-1"];
  assert.equal(entry.status, "exited");
  assert.equal(entry.sessionId, sessionId, "system/init's session id reached the registry");
});

test("registry costUsd is the transcript price, SET over the inflated entry", () => {
  const entry = readRegistry(runId).children["dev-1"];
  const priced = priceTranscripts([transcriptPath]);
  assert.ok(priced && priced.costUsd !== null, "precondition: the fake's transcript must price");
  assert.equal(entry.costUsd, priced.costUsd, `expected the transcript price ${priced.costUsd}, got ${entry.costUsd}`);
  assert.ok(entry.costUsd < 5.0, "SET, not added to the entry's stale 5.0");
  assert.equal(entry.costSource, "transcript");
  assert.equal(entry.costMessages, priced.messages);
});

test("the cumulative results lost to the transcript — neither sum nor max leaks through", () => {
  // The three cumulative snapshots price at 1x, 2x, 3x the same tokens; the
  // transcript is a FRACTION of one snapshot. If either the old addCost sum or
  // the result-max fallback had won, costUsd would be far above the transcript.
  const entry = readRegistry(runId).children["dev-1"];
  const transcriptPrice = priceTranscripts([transcriptPath]).costUsd;
  // The largest (3x) cumulative snapshot, priced exactly as the fallback would.
  const snapshot = pricingSnapshot();
  const maxResult = costFromResult(
    {
      usage: { input_tokens: 900_000, output_tokens: 30_000 },
      modelUsage: { [MODEL]: { inputTokens: 900_000, outputTokens: 30_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    },
    null,
    (u, m) => calculateCost(u, m, snapshot.prices, null, snapshot.scoped),
  );
  assert.ok(maxResult.computed > transcriptPrice, `precondition: the 3x snapshot (${maxResult.computed}) must price above the transcript (${transcriptPrice}) — otherwise the test cannot tell the two apart`);
  assert.equal(entry.costUsd, transcriptPrice, "the transcript price must be the registry value exactly");
});

test("costUsdReported kept the largest cumulative reported figure", () => {
  const entry = readRegistry(runId).children["dev-1"];
  assert.equal(entry.costUsdReported, 0.63, "MAX(0.21, 0.42, 0.63) — evidence only, beside the computed cost");
});

// ── FOC-761: a resumed turn re-opens the telemetry run BEFORE claude spawns ──
console.log("\nwznowiona tura otwiera run telemetrii (FOC-761)");

const stateRoot = join(base, "la-state");
const telemetryHome = join(base, "tel");
mkdirSync(join(stateRoot, "runs"), { recursive: true });
mkdirSync(telemetryHome, { recursive: true });

const telemetryRunId = `tel-${process.pid}`;
const manifestPath = join(stateRoot, "runs", `${telemetryRunId}.json`);
// The shape run-manifest `start`/`end` leaves behind: turn 1 already ended.
writeFileSync(
  manifestPath,
  JSON.stringify({
    runId: telemetryRunId,
    squad: "dev",
    turns: 1,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    exitCode: 0,
    cwd,
  }),
);

const runId2 = `test-watch-resume-${process.pid}`;
ensureRunDir(runId2);
writeRegistry(runId2, {
  runId: runId2,
  children: {
    "dev-1": {
      childId: "dev-1",
      squad: "dev",
      taskId: "FOC-999",
      status: "starting",
      sessionId: null,
      costUsd: 0,
      turns: [],
      worktree: cwd,
      permissionMode: "bypassPermissions",
    },
  },
  rounds: {},
});

const sessionId2 = `watch-resume-${process.pid}`;
const transcriptPath2 = join(configDir, "projects", cwdToHashName(cwd), `${sessionId2}.jsonl`);

const result2 = spawnSync(
  process.execPath,
  [
    WATCH, "--run", runId2, "--child", "dev-1", "--cwd", cwd,
    "--prompt-file", promptFile, "--turn", "1", "--telemetry-run", telemetryRunId,
  ],
  {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LA_SUPERVISOR_STATE_HOME: stateHome,
      LA_SQUAD_HOME: squadHome,
      LA_STATE_ROOT: stateRoot,
      LA_TELEMETRY_HOME: telemetryHome,
      CLAUDE_CONFIG_DIR: configDir,
      LA_SUPERVISOR_NO_TELEMETRY: "1",
      LA_SUPERVISOR_NO_CODEGRAPH: "1",
      LA_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_SESSION_ID: sessionId2,
      FAKE_TRANSCRIPT_PATH: transcriptPath2,
    },
  },
);

test("a resumed turn (turnIndex > 0) re-opens the run manifest before spawning", () => {
  assert.equal(result2.status, 0, `watcher exit ${result2.status}: ${result2.stderr}`);
  assert.equal(readRegistry(runId2).children["dev-1"].status, "exited");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // reopen's fingerprints: it alone sets resumedAt and raises turns; the later
  // `end` only stamps endedAt/exitCode/endSeq on top of them.
  assert.ok(manifest.resumedAt, "reopen must stamp resumedAt on the manifest");
  assert.equal(manifest.turns, 2, "reopen must raise turns to turnIndex + 1");
  assert.ok(manifest.endedAt, "the resumed turn's own end follows");
});

test("turn 0 does NOT touch the run manifest", () => {
  // Scenario 1 ran with no --telemetry-run; scenario 2's manifest was written
  // by hand and only scenario 2's watcher touched it. The negative control is
  // the manifest's own history — reopen on turn 0 would have raised turns to 1
  // and stamped nothing; assert the first run's registry is intact instead.
  assert.equal(readRegistry(runId).children["dev-1"].costSource, "transcript");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.turns, 2, "only the resumed turn moved the manifest");
});

// ── a resume that forked a NEW session id prices BOTH transcripts (FOC-760) ──
console.log("\nwznowiona tura z nowym session id (FOC-760)");

const runId3 = `test-watch-fork-${process.pid}`;
ensureRunDir(runId3);
const sessionIdOld = `watch-fork-old-${process.pid}`;
const sessionIdNew = `watch-fork-new-${process.pid}`;
const transcriptPathOld = join(configDir, "projects", cwdToHashName(cwd), `${sessionIdOld}.jsonl`);
const transcriptPathNew = join(configDir, "projects", cwdToHashName(cwd), `${sessionIdNew}.jsonl`);
// The lead session's transcript is already on disk (the child's earlier turn).
const oldLine = (id, input, output) =>
  JSON.stringify({
    type: "assistant",
    message: {
      id,
      model: MODEL,
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
mkdirSync(dirname(transcriptPathOld), { recursive: true });
writeFileSync(transcriptPathOld, [oldLine("msg-old-1", 50_000, 1_000)].join("\n") + "\n");
writeRegistry(runId3, {
  runId: runId3,
  children: {
    "dev-1": {
      childId: "dev-1",
      squad: "dev",
      taskId: "FOC-999",
      status: "starting",
      sessionId: sessionIdOld, // the pre-turn registry id — different from init's
      costUsd: 0,
      turns: [],
      worktree: cwd,
      permissionMode: "bypassPermissions",
    },
  },
  rounds: {},
});
const promptFile3 = join(base, "prompt3.txt");
writeFileSync(promptFile3, "k");

const result3 = spawnSync(
  process.execPath,
  [WATCH, "--run", runId3, "--child", "dev-1", "--cwd", cwd, "--prompt-file", promptFile3, "--turn", "1"],
  {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LA_SUPERVISOR_STATE_HOME: stateHome,
      LA_SQUAD_HOME: squadHome,
      CLAUDE_CONFIG_DIR: configDir,
      LA_SUPERVISOR_NO_TELEMETRY: "1",
      LA_SUPERVISOR_NO_CODEGRAPH: "1",
      LA_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_SESSION_ID: sessionIdNew,
      FAKE_TRANSCRIPT_PATH: transcriptPathNew,
    },
  },
);

test("a resume that forked a new session id prices BOTH transcripts", () => {
  assert.equal(result3.status, 0, `watcher exit ${result3.status}: ${result3.stderr}`);
  const entry = readRegistry(runId3).children["dev-1"];
  assert.equal(entry.sessionId, sessionIdNew, "init's new session id reached the registry");
  const priced = priceTranscripts([transcriptPathOld, transcriptPathNew]);
  assert.ok(priced && priced.costUsd !== null, "precondition: both transcripts must price");
  assert.equal(
    entry.costUsd,
    priced.costUsd,
    `the cost must cover BOTH files: expected ${priced.costUsd}, got ${entry.costUsd}`,
  );
  assert.equal(entry.costMessages, priced.messages, "the old session's messages are priced too");
  const newOnly = priceTranscripts([transcriptPathNew]);
  assert.ok(entry.costUsd > newOnly.costUsd, "the pre-fork transcript is included, not just the new one");
});

// ── FOC-913: the turn is reported done only after the stdout tail drained ────
console.log("\nturn-end czeka na ogon stdout (FOC-913)");

// The flake's shape, loaded: ~5 MB of non-JSON pad lines push the three
// cumulative result events to the very tail of the stream, and claude exits
// right after they flush. The parent must pump ~80 read events before EOF;
// the old finalizer (running on 'exit') froze resultCosts mid-drain and the
// registry came up without costUsdReported — exactly the FOC-913 failure under
// test-suite load, where 'exit' beats the in-transit pipe data. The finalizer
// now runs on 'close', which fires only after every stream byte is delivered.
const FAKE_CLAUDE_BUSY = join(base, "fake-claude-busy.mjs");
writeFileSync(
  FAKE_CLAUDE_BUSY,
  [
    `import { mkdirSync, writeFileSync } from "node:fs";`,
    `import { dirname } from "node:path";`,
    `const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");`,
    `const result = (mult) => ({`,
    `  type: "result",`,
    `  subtype: "success",`,
    `  total_cost_usd: Number((0.21 * mult).toFixed(4)),`,
    `  usage: { input_tokens: 300000 * mult, output_tokens: 10000 * mult, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },`,
    `  modelUsage: { ${JSON.stringify(MODEL)}: { inputTokens: 300000 * mult, outputTokens: 10000 * mult, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },`,
    `});`,
    `out({ type: "system", subtype: "init", session_id: process.env.FAKE_SESSION_ID, tools: [], model: ${JSON.stringify(MODEL)} });`,
    `const path = process.env.FAKE_TRANSCRIPT_PATH;`,
    `mkdirSync(dirname(path), { recursive: true });`,
    `const line = (id, input, output) => JSON.stringify({`,
    `  type: "assistant",`,
    `  message: { id, model: ${JSON.stringify(MODEL)}, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },`,
    `});`,
    `writeFileSync(path, [line("msg-a", 200000, 5000), line("msg-b", 100000, 3000)].join("\\n") + "\\n");`,
    // 200 pad lines (~5 MB), backpressure-aware, so the results land at the
    // very tail of the stream just before the process exits.
    `const PAD = ${JSON.stringify(`pad ${"x".repeat(25_000)}\n`)};`,
    `let pads = 0;`,
    `function pump() {`,
    `  while (pads < 200) {`,
    `    pads++;`,
    `    if (!process.stdout.write(PAD)) { process.stdout.once("drain", pump); return; }`,
    `  }`,
    `  out(result(1)); out(result(2)); out(result(3));`,
    `  if (process.stdout.writableLength) process.stdout.once("drain", () => process.exit(0));`,
    `  else process.exit(0);`,
    `}`,
    `pump();`,
    ``,
  ].join("\n"),
);

const runId4 = `test-watch-tail-${process.pid}`;
ensureRunDir(runId4);
writeRegistry(runId4, {
  runId: runId4,
  children: {
    "dev-1": {
      childId: "dev-1",
      squad: "dev",
      taskId: "FOC-999",
      status: "starting",
      sessionId: null,
      costUsd: 0,
      turns: [],
      worktree: cwd,
      permissionMode: "bypassPermissions",
    },
  },
  rounds: {},
});
const sessionId4 = `watch-tail-${process.pid}`;
const transcriptPath4 = join(configDir, "projects", cwdToHashName(cwd), `${sessionId4}.jsonl`);

const result4 = spawnSync(
  process.execPath,
  [WATCH, "--run", runId4, "--child", "dev-1", "--cwd", cwd, "--prompt-file", promptFile, "--turn", "0"],
  {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      LA_SUPERVISOR_STATE_HOME: stateHome,
      LA_SQUAD_HOME: squadHome,
      CLAUDE_CONFIG_DIR: configDir,
      LA_SUPERVISOR_NO_TELEMETRY: "1",
      LA_SUPERVISOR_NO_CODEGRAPH: "1",
      LA_CLAUDE_BIN: FAKE_CLAUDE_BUSY,
      FAKE_SESSION_ID: sessionId4,
      FAKE_TRANSCRIPT_PATH: transcriptPath4,
    },
  },
);

test("the stdout tail (results behind a busy stream) reached the registry", () => {
  assert.equal(result4.status, 0, `watcher exit ${result4.status}: ${result4.stderr}`);
  const entry = readRegistry(runId4).children["dev-1"];
  assert.equal(entry.status, "exited", "the turn is still reported done");
  assert.equal(entry.costSource, "transcript");
  assert.equal(
    entry.costUsdReported,
    0.63,
    "the tail drained before the exit was recorded — MAX(0.21, 0.42, 0.63)",
  );
});

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);