// Contract test for scripts/cost-reconcile.mjs — the shared acceptance of
// FOC-760 (registry vs transcript truth) and FOC-761 (telemetry vs truth).
//
// Everything runs against TEMP dirs: a temp state home holds the run registry,
// a temp squad home (LA_SQUAD_HOME) holds the child transcripts, and a temp
// telemetry store is built with openTelemetryDb + events, CLOSED, and only
// then read by the CLI through its read-only path. The real store and the
// real .state/ are never touched. The CLI runs via spawnSync (the CLI is the
// contract — flags, exit codes, JSON shape), pointed at the temp dirs.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cwdToHashName } from "./ledger.mjs";
import {
  applyEvent,
  calculateCost,
  makeEvent,
  openTelemetryDb,
  pricingSnapshot,
} from "./telemetry-store.mjs";
import { priceTranscripts } from "./transcript-cost.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "cost-reconcile.mjs");

// ── fixture ──────────────────────────────────────────────────────────────────

const temp = mkdtempSync(join(tmpdir(), "cost-reconcile-test-"));
const stateHome = join(temp, "state");
const squadHome = join(temp, "squad");
const runId = "run-reconcile";
const model = "deepseek-v4-flash"; // priced in the committed config/models.json

const snapshot = pricingSnapshot();
const price = (tokens) =>
  calculateCost(
    {
      inputTokens: tokens.input ?? 0,
      outputTokens: tokens.output ?? 0,
      cacheReadTokens: tokens.cacheRead ?? 0,
      cacheCreationTokens: tokens.cacheWrite ?? 0,
    },
    model,
    snapshot.prices,
    null,
    snapshot.scoped,
  );
assert(typeof price({ input: 1000 }) === "number", "precondition: the fixture model must be priceable");

// One assistant line per message — the transcript pricing merges per
// message.id with MAX per counter, so a single line per message is the
// simplest shape that still exercises the merge rule.
function writeTranscript(worktree, sessionId, messages) {
  const dir = join(squadHome, "dev", "projects", cwdToHashName(worktree));
  mkdirSync(dir, { recursive: true });
  const lines = messages.map((m, i) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id: `msg-${sessionId}-${i}`,
        model,
        usage: {
          input_tokens: m.input ?? 0,
          output_tokens: m.output ?? 0,
          cache_read_input_tokens: m.cacheRead ?? 0,
          cache_creation_input_tokens: m.cacheWrite ?? 0,
        },
      },
    }),
  );
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

const wt1 = join(temp, "wt-exact");
const wt2 = join(temp, "wt-resumed");
const wt3 = join(temp, "wt-missing");
const wtZero = join(temp, "wt-zero");
const wtOrphan = join(temp, "wt-orphan");
const wtNotel = join(temp, "wt-notel");

// Child 1 — single turn, registry exact: one message, truth = its price.
const m1 = { input: 1000, output: 100 };
const truth1 = price(m1);

// Child 2 — two turns (the FOC-761 shape), registry 5× truth: the F4 lie.
const m2a = { input: 2000, output: 200 };
const m2b = { input: 3000, output: 300 };
const truth2 = price(m2a) + price(m2b);

// One priced 1000-input telemetry row — the seeded telemetry of the zero-truth
// and orphan children.
const telRow = { input: 1000 };
const telRowUsd = price(telRow);

writeTranscript(wt1, "sess-exact", [m1]);
writeTranscript(wt2, "sess-resumed", [m2a, m2b]);
writeTranscript(wtZero, "sess-zero", [{ input: 0, output: 0 }]); // truth = $0
writeTranscript(wtOrphan, "sess-orphan", [m1]);
writeTranscript(wtNotel, "sess-notel", [m2a, m2b]);
writeTranscript(wt1, "sess-norows", [m1]);

// Child 3 — no transcript anywhere under the squad home.
// Child 4 — in flight (running): cost not settled, skipped.
// Child 5 — zero truth ($0 transcript) over a non-zero registry: off.
// Child 6 — telemetry usage rows whose run will be deleted from `runs` (surgery below).
// Child 7 — multi-turn WITHOUT telemetry: must not dilute multi.telemetryRatio.
// Child 8 — telemetryRunId never seeded: telemetry null, never $0.
// Child 9 — squad null: the lookup throws → lookup-error, never a crashed run.

const ended = "2026-10-13T10:00:00.000Z";
const registry = {
  runId,
  children: {
    "exact-1": {
      childId: "exact-1",
      squad: "dev",
      worktree: wt1,
      sessionId: "sess-exact",
      status: "exited",
      turns: [{ startedAt: ended, endedAt: ended, exitCode: 0 }],
      costUsd: truth1,
      telemetryRunId: "run-telemetry-exact",
    },
    "resumed-2": {
      childId: "resumed-2",
      squad: "dev",
      worktree: wt2,
      sessionId: "sess-resumed",
      status: "exited",
      turns: [
        { startedAt: ended, endedAt: ended, exitCode: 0 },
        { startedAt: ended, endedAt: ended, exitCode: 0 },
      ],
      costUsd: truth2 * 5,
      telemetryRunId: "run-telemetry-resumed",
    },
    "no-transcript-3": {
      childId: "no-transcript-3",
      squad: "dev",
      worktree: wt3,
      sessionId: "sess-nowhere",
      status: "exited",
      turns: [{ startedAt: ended, endedAt: ended, exitCode: 0 }],
      costUsd: 0.25,
      telemetryRunId: null,
    },
    "in-flight-4": {
      childId: "in-flight-4",
      squad: "dev",
      worktree: wt2, // transcript exists — must still be skipped
      sessionId: "sess-resumed",
      status: "running",
      turns: [{ startedAt: ended, endedAt: ended, exitCode: 0 }],
      costUsd: 9.99,
      telemetryRunId: "run-telemetry-exact",
    },
    "zerotruth-5": {
      childId: "zerotruth-5",
      squad: "dev",
      worktree: wtZero,
      sessionId: "sess-zero",
      status: "exited",
      turns: [{ startedAt: ended, endedAt: ended, exitCode: 0 }],
      costUsd: 0.5, // non-zero over a $0 truth — off, ratio null or not
      telemetryRunId: "run-telemetry-zerotruth",
    },
    "orphan-6": {
      childId: "orphan-6",
      squad: "dev",
      worktree: wtOrphan,
      sessionId: "sess-orphan",
      status: "exited",
      turns: [{ startedAt: ended, endedAt: ended, exitCode: 0 }],
      costUsd: truth1,
      telemetryRunId: "run-telemetry-orphan",
    },
    "multi-notel-7": {
      childId: "multi-notel-7",
      squad: "dev",
      worktree: wtNotel,
      sessionId: "sess-notel",
      status: "exited",
      turns: [
        { startedAt: ended, endedAt: ended, exitCode: 0 },
        { startedAt: ended, endedAt: ended, exitCode: 0 },
      ],
      costUsd: truth2, // registry exact — only its TELEMETRY is missing
      telemetryRunId: null,
    },
    "no-rows-8": {
      childId: "no-rows-8",
      squad: "dev",
      worktree: wt1,
      sessionId: "sess-norows",
      status: "exited",
      turns: [{ startedAt: ended, endedAt: ended, exitCode: 0 }],
      costUsd: truth1,
      telemetryRunId: "run-telemetry-never-seeded",
    },
    "broken-9": {
      childId: "broken-9",
      squad: null, // squadConfigDir(null) throws — the lookup must be guarded
      worktree: wt3,
      sessionId: "sess-broken",
      status: "exited",
      turns: [{ startedAt: ended, endedAt: ended, exitCode: 0 }],
      costUsd: 0.75,
      telemetryRunId: null,
    },
  },
  rounds: {},
};

mkdirSync(join(stateHome, runId), { recursive: true });
writeFileSync(join(stateHome, runId, "children.json"), JSON.stringify(registry, null, 2));

// The telemetry store: run.started for each telemetryRunId (stamps the run's
// price set), then usage.recorded per message — the ingest prices each row
// into cost_facts at the run's own price set (follows telemetry-store.test.mjs).
const dbPath = join(temp, "telemetry.sqlite");
const db = openTelemetryDb(dbPath);
let offset = 0;
const ev = (type, payload, at) =>
  applyEvent(db, makeEvent(type, payload, {
    runId: payload.runId,
    observedAt: at,
    sourceKind: "test",
    sourcePath: `C:/fixture/${payload.runId}.jsonl`,
    sourceOffset: offset++,
  }));

function seedTelemetry(runIdTelemetry, messages) {
  ev("run.started", { runId: runIdTelemetry, squad: "dev", startedAt: ended }, ended);
  for (const [i, m] of messages.entries()) {
    ev("usage.recorded", {
      runId: runIdTelemetry,
      agentKey: "_lead",
      model,
      messageId: `${runIdTelemetry}-msg-${i}`,
      observedAt: ended,
      inputTokens: m.input ?? 0,
      outputTokens: m.output ?? 0,
      cacheReadTokens: m.cacheRead ?? 0,
      cacheCreationTokens: m.cacheWrite ?? 0,
    }, ended);
  }
}

seedTelemetry("run-telemetry-exact", [m1]);
seedTelemetry("run-telemetry-resumed", [m2a, m2b]);
seedTelemetry("run-telemetry-zerotruth", [telRow]);
seedTelemetry("run-telemetry-orphan", [telRow]);
// One legacy row (no messageId — pre-FOC-381 per-line history) on the resumed
// child, zero-token so it prices to $0 and does not bend the telemetry ratio;
// it must surface as legacyRows + the flag, not as cost.
ev("usage.recorded", {
  runId: "run-telemetry-resumed",
  agentKey: "_lead",
  model,
  usageId: "legacy-line-1",
  observedAt: ended,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}, ended);
db.close();

// ── helpers ──────────────────────────────────────────────────────────────────

function runCli(extraArgs = [], { env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LA_SQUAD_HOME: squadHome, ...env },
  });
}

const baseArgs = ["--json", "--state-home", stateHome, "--db", dbPath];
let firstRun;

test("ratios: exact child at 1×, resumed child at 5× registry / 1× telemetry", () => {
  const proc = runCli(baseArgs);
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
  firstRun = JSON.parse(proc.stdout);

  const byId = Object.fromEntries(firstRun.children.map((c) => [c.childId, c]));
  const exact = byId["exact-1"];
  const resumed = byId["resumed-2"];

  assert.ok(Math.abs(exact.registryRatio - 1) < 1e-9, `exact registryRatio=${exact.registryRatio}`);
  assert.ok(Math.abs(exact.telemetryRatio - 1) < 1e-9, `exact telemetryRatio=${exact.telemetryRatio}`);
  assert.ok(Math.abs(resumed.registryRatio - 5) < 1e-9, `resumed registryRatio=${resumed.registryRatio} (truth=${resumed.truthUsd}, registry=${resumed.registryUsd})`);
  assert.ok(Math.abs(resumed.telemetryRatio - 1) < 1e-9, `resumed telemetryRatio=${resumed.telemetryRatio}`);

  assert.equal(exact.turns, 1);
  assert.equal(resumed.turns, 2);
  // FOC-381: the resumed child's telemetry carried one legacy NULL-message row.
  assert.equal(resumed.legacyRows, 1, `legacyRows=${resumed.legacyRows}`);
  assert.ok(resumed.flags.includes("legacyRows"), `flags=${resumed.flags}`);
  assert.ok(Math.abs(exact.truthUsd - truth1) < 1e-12, `truth1 mismatch: ${exact.truthUsd} vs ${truth1}`);
});

test("summary: buckets, registryOff holds the 5× and the zero-truth child, exclusions counted", () => {
  const { summary } = firstRun;
  // single = exact-1, no-rows-8, orphan-6, zerotruth-5: three $truth1 children
  // plus the $0-truth child carrying a 0.5 registry.
  assert.equal(summary.single.n, 4);
  assert.ok(Math.abs(summary.single.truthUsd - 3 * truth1) < 1e-12, `single=${JSON.stringify(summary.single)}`);
  assert.ok(Math.abs(summary.single.registryUsd - (3 * truth1 + 0.5)) < 1e-12);
  assert.ok(Math.abs(summary.single.registryRatio - (3 * truth1 + 0.5) / (3 * truth1)) < 1e-9);
  // multi = resumed-2 (5× lie) + multi-notel-7 (exact): ratio 3 over the pair.
  assert.equal(summary.multi.n, 2);
  assert.ok(Math.abs(summary.multi.registryRatio - 3) < 1e-9, `multi=${JSON.stringify(summary.multi)}`);
  assert.deepEqual(summary.registryOff, ["resumed-2", "zerotruth-5"]);
  assert.equal(summary.noTranscript, 2); // no-transcript-3 + broken-9
  assert.equal(summary.unpriced, 0);
  assert.equal(summary.skipped, 1);
  const byId = Object.fromEntries(firstRun.children.map((c) => [c.childId, c]));
  assert.ok(byId["no-transcript-3"].flags.includes("noTranscript"));
  assert.equal(byId["no-transcript-3"].registryRatio, null);
  assert.equal(byId["in-flight-4"].flags.includes("inFlight"), true);
});

test("zero truth: a non-zero registry is off, a non-zero telemetry is flagged", () => {
  const byId = Object.fromEntries(firstRun.children.map((c) => [c.childId, c]));
  const zero = byId["zerotruth-5"];
  assert.equal(zero.truthUsd, 0);
  assert.equal(zero.registryRatio, null, "ratio(part, 0) is null — a null ratio must not read as verified");
  assert.ok(zero.flags.includes("registryOff"), `flags=${zero.flags}`);
  assert.ok(zero.flags.includes("telemetryOff"), `flags=${zero.flags}`);
});

test("telemetry that saw NO usage rows for the run is null, never $0", () => {
  const byId = Object.fromEntries(firstRun.children.map((c) => [c.childId, c]));
  const norows = byId["no-rows-8"];
  assert.equal(norows.telemetryUsd, null, "unseeded run id — unknown, not a laundered zero");
  assert.equal(norows.telemetryRatio, null);
  assert.ok(!norows.flags.includes("telemetryOff"), "unknown telemetry is not a non-zero telemetry");
});

test("multi.telemetryRatio covers only children WITH telemetry (multi.withTelemetry)", () => {
  const { multi } = firstRun.summary;
  assert.equal(multi.withTelemetry, 1, "only resumed-2 reported; multi-notel-7 has telemetryRunId null");
  assert.ok(
    Math.abs(multi.telemetryRatio - 1) < 1e-9,
    `multi.telemetryRatio=${multi.telemetryRatio} — resumed-2 alone, NOT diluted to 0.5 by the no-telemetry child`,
  );
});

test("a throwing transcript lookup is lookup-error + noTranscript, never a crashed run", () => {
  const byId = Object.fromEntries(firstRun.children.map((c) => [c.childId, c]));
  const broken = byId["broken-9"];
  assert.ok(broken.flags.includes("lookup-error"), `flags=${broken.flags}`);
  assert.ok(broken.flags.includes("noTranscript"), `flags=${broken.flags}`);
  assert.equal(broken.registryRatio, null);
});

test("missing db: telemetry columns null, registry-vs-transcript still reported", () => {
  const proc = runCli(["--json", "--state-home", stateHome, "--db", join(temp, "missing.sqlite")]);
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.meta.dbAvailable, false);
  for (const child of out.children) {
    assert.equal(child.telemetryUsd, null, `${child.childId} telemetryUsd`);
    assert.equal(child.telemetryRatio, null);
  }
  const byId = Object.fromEntries(out.children.map((c) => [c.childId, c]));
  assert.ok(Math.abs(byId["resumed-2"].registryRatio - 5) < 1e-9, "registry comparison must survive a missing store");
});

test("read-only: the store file's mtime and size are unchanged after a run", () => {
  const before = statSync(dbPath);
  const proc = runCli(baseArgs);
  assert.equal(proc.status, 0);
  const after = statSync(dbPath);
  assert.equal(after.mtimeMs, before.mtimeMs, "mtime changed — the run wrote to the store");
  assert.equal(after.size, before.size, "size changed — the run wrote to the store");
});

test("usage rows whose run is missing from `runs` count as unpriced, never $0", () => {
  // A normal delete cascades usage_facts (FK ON DELETE CASCADE), so the raw
  // connection drops ONLY the runs row with FKs off — the usage rows survive
  // without their price set. The LEFT JOIN must surface them as unpriced
  // (telemetryUnpriced), not drop them into a clean-looking $0.
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec("PRAGMA foreign_keys = OFF;");
    raw.prepare("DELETE FROM runs WHERE run_id = 'run-telemetry-orphan'").run();
  } finally {
    raw.close();
  }
  const out = JSON.parse(runCli(baseArgs).stdout);
  const orphan = out.children.find((c) => c.childId === "orphan-6");
  assert.ok(orphan.flags.includes("telemetryUnpriced"), `flags=${orphan.flags}`);
  assert.equal(orphan.telemetryUsd, 0, "nothing priced — but the rows were seen and counted, not dropped");
});

test("human output: summary table and worst-children listing name the 5× child", () => {
  const proc = runCli(["--state-home", stateHome, "--db", dbPath]);
  assert.equal(proc.status, 0);
  assert.match(proc.stdout, /cost-reconcile/);
  assert.match(proc.stdout, /single/);
  assert.match(proc.stdout, /multi/);
  assert.match(proc.stdout, /resumed-2/, "the 5× child must appear in the worst-children listing");
});

test("human output: sub-cent truth keeps its significant digits, never a bare $0", () => {
  // The single bucket's truth is 3× truth1 (exact-1, no-rows-8, orphan-6; the
  // $0-truth child adds 0). With the fixture model's pricing that is a
  // sub-cent figure — exactly what the old $${v.toFixed(4)} collapsed to $0.
  assert.ok(truth1 > 0 && truth1 < 0.01, `precondition: truth1=${truth1} must be sub-cent and non-zero`);
  const proc = runCli(["--state-home", stateHome, "--db", dbPath]);
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
  const single = proc.stdout.split("\n").find((line) => line.startsWith("single"));
  assert.ok(single, `single bucket row missing:\n${proc.stdout}`);
  const truthCell = single.trim().split(/\s+/)[2];
  assert.ok(truthCell !== "$0", `sub-cent truth collapsed to $0: ${truthCell}`);
  const shown = Number(truthCell.replace("$", ""));
  assert.ok(
    Math.abs(shown - 3 * truth1) <= 3 * truth1 * 0.05,
    `truth cell ${truthCell} does not show ${3 * truth1} to 2 significant digits`,
  );
  // Zero stays zero — distinguishable from the sub-cent cell above.
  assert.match(proc.stdout, /(^|\s)\$0(\s|$)/m, "an exactly-zero cell must print $0");
});

test("--strict exits 1 while the lies stand, 0 after the registries are fixed", () => {
  const before = runCli(["--strict", "--state-home", stateHome, "--db", dbPath]);
  assert.equal(before.status, 1, `expected strict failure, stderr: ${before.stderr}`);
  assert.match(before.stderr, /resumed-2/);
  assert.match(before.stderr, /zerotruth-5/, "a $0 truth over a non-zero registry fails strict too");

  // Fix: set the children's registry costs to the transcript truth — what the
  // FOC-760 watcher now does at every turn end.
  const path = join(stateHome, runId, "children.json");
  const fixed = JSON.parse(readFileSync(path, "utf8"));
  fixed.children["resumed-2"].costUsd = truth2;
  fixed.children["zerotruth-5"].costUsd = 0; // the transcript truth is $0
  writeFileSync(path, JSON.stringify(fixed, null, 2));

  const after = runCli(["--strict", "--state-home", stateHome, "--db", dbPath]);
  assert.equal(after.status, 0, `expected strict pass, stderr: ${after.stderr}`);
  const { summary } = JSON.parse(runCli(baseArgs).stdout);
  assert.deepEqual(summary.registryOff, []);
});

test("cleanup: temp fixture removed", () => {
  rmSync(temp, { recursive: true, force: true });
  assert.equal(existsSync(temp), false);
  assert.ok(priceTranscripts !== undefined); // keep the import honest
});
