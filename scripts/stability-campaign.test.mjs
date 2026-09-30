// scripts/stability-campaign.test.mjs — FOC-626 pure-logic tests for the
// stability campaign instrument. Seconds, not minutes: no suite iteration and
// no campaign run happens here — only the crash classifier, the JSONL row
// contract, the resume state, and the load generator's process lifecycle
// (tiny budget, test-only marker).
//
// Isolation (the claim this file's parallel-lane entry in test-lanes.json
// makes): mkdtemp/tmpdir fixtures only; no ports, no socket binds, no
// real-repo-path writes; no telemetry DB. The one thing spawned is
// scripts/stability-load.mjs with a short budget and a TEST-ONLY marker
// (foc-626-test-burst); the lifecycle test asserts zero matching processes
// remain after it stops, and the forced-kill test leaves the same zero behind
// after a taskkill tree kill.
//
// Run: node scripts/stability-campaign.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  aggregateLoadStats,
  classifyCrash,
  crashesFromOutput,
  crashesFromRegistry,
  loadStatsBase,
  readResultsFile,
  resumeState,
  validateRow,
} from "./stability-campaign.mjs";
import { parentStatsFile } from "./stability-load.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOAD = join(HERE, "stability-load.mjs");
// TEST-ONLY marker — never the campaign's foc-626-burst, so a stray generator
// from this test cannot be confused with a real campaign's load tree.
const TEST_MARKER = "foc-626-test-burst";

const ROW = {
  seq: 1,
  mode: "standalone",
  command: "node scripts/test-all.mjs supervisor-gate",
  startedAt: "2026-09-30T10:00:00.000Z",
  durationMs: 12345,
  ok: true,
  exitCode: 0,
  crashes: [],
  tail: "",
  logFile: "standalone.iter1.log",
};

const withTempDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "foc-626-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// Write raw lines (strings, not objects) so tests control exact file bytes —
// including truncated and non-JSON lines a dead process leaves behind.
const writeResultsFile = (dir, rawLines) => {
  const file = join(dir, "results.jsonl");
  writeFileSync(file, rawLines.join("\n") + "\n");
  return file;
};

const jsonLines = (rows) => rows.map((r) => JSON.stringify(r));

// Test-side heartbeat reader (same skip-if-unreadable contract as the
// runner's): the polling loop in the forced-kill test uses it before the
// runner's aggregateLoadStats ever runs.
const readHeartbeatFile = (file) => {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return typeof s.spawns === "number" ? s : null;
  } catch {
    return null;
  }
};

// Independent process-table check: how many live processes carry the marker on
// their command line. The querying powershell's own command line contains the
// marker too, so it is excluded by name; on POSIX the ps output is filtered in
// this process.
function countMarkerProcesses(marker) {
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${marker}' -and $_.Name -notmatch 'powershell|pwsh|cmd' }).Count`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    const n = Number((r.stdout || "").trim());
    return Number.isFinite(n) ? n : -1;
  }
  const r = spawnSync("ps", ["-eo", "args="], { encoding: "utf8", timeout: 15_000 });
  return (r.stdout || "").split("\n").filter((l) => l.includes(marker) && !l.startsWith("ps ")).length;
}

describe("row schema", () => {
  it("a well-formed row validates with no problems", () => {
    assert.deepEqual(validateRow({ ...ROW }), []);
  });

  it("every required field is checked for presence and type", () => {
    for (const key of Object.keys(ROW)) {
      const broken = { ...ROW };
      delete broken[key];
      assert.ok(validateRow(broken).length > 0, `missing ${key} must be a problem`);
    }
  });

  it("wrong types are problems", () => {
    assert.ok(validateRow({ ...ROW, seq: 0 }).length > 0);
    assert.ok(validateRow({ ...ROW, seq: "2" }).length > 0);
    assert.ok(validateRow({ ...ROW, mode: "other" }).length > 0);
    assert.ok(validateRow({ ...ROW, command: "" }).length > 0);
    assert.ok(validateRow({ ...ROW, startedAt: "not-a-date" }).length > 0);
    assert.ok(validateRow({ ...ROW, durationMs: -1 }).length > 0);
    assert.ok(validateRow({ ...ROW, durationMs: "fast" }).length > 0);
    assert.ok(validateRow({ ...ROW, ok: "yes" }).length > 0);
    assert.ok(validateRow({ ...ROW, exitCode: 0.5 }).length > 0);
    assert.ok(validateRow({ ...ROW, crashes: {} }).length > 0);
  });

  it("ok must agree with exitCode", () => {
    assert.ok(validateRow({ ...ROW, ok: true, exitCode: 1 }).length > 0);
    assert.deepEqual(validateRow({ ...ROW, ok: false, exitCode: 1 }), []);
    assert.deepEqual(validateRow({ ...ROW, ok: false, exitCode: null }), []);
  });

  it("a crash entry without a writer is a problem — a bare crashed is a fail", () => {
    const problems = validateRow({ ...ROW, ok: false, exitCode: 1, crashes: [{ evidence: "boom" }] });
    assert.ok(problems.some((p) => p.includes("writer")), `expected a writer problem, got: ${problems.join("; ")}`);
    assert.ok(validateRow({ ...ROW, crashes: [{ writer: "", evidence: "boom" }] }).length > 0);
    assert.ok(validateRow({ ...ROW, crashes: ["crashed"] }).length > 0);
  });

  it("rows round-trip through the JSONL file; truncated and non-JSON lines are skipped", () => {
    withTempDir((dir) => {
      const file = writeResultsFile(dir, [
        JSON.stringify({ ...ROW, seq: 1 }),
        JSON.stringify({ ...ROW, seq: 2, mode: "under-load", ok: false, exitCode: 1 }),
        '{"seq":3,"mode":"standal', // truncated mid-write — a dead process's last line
        "not json at all",
        "",
        JSON.stringify({ ...ROW, seq: 3 }),
      ]);
      const { rows, skippedLines } = readResultsFile(file);
      assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3]);
      assert.equal(skippedLines, 2);
      for (const r of rows) assert.deepEqual(validateRow(r), []);
    });
  });
});

describe("resume", () => {
  const CMD = "node scripts/test-all.mjs supervisor-gate";
  const sevenRows = Array.from({ length: 7 }, (_, i) => ({ ...ROW, seq: i + 1, command: CMD }));

  it("7 valid rows continue from seq 8 with 3 remaining toward 10", () => {
    withTempDir((dir) => {
      const { rows } = readResultsFile(writeResultsFile(dir, jsonLines(sevenRows)));
      assert.equal(rows.length, 7); // assert on the parsed rows, not a log line
      assert.deepEqual(resumeState(rows, "standalone", CMD, 10), { done: 7, remaining: 3, nextSeq: 8 });
    });
  });

  it("rows of another mode or command do not count toward the total", () => {
    withTempDir((dir) => {
      const mixed = [
        ...jsonLines(sevenRows),
        JSON.stringify({ ...ROW, seq: 8, mode: "under-load", command: CMD }),
        JSON.stringify({ ...ROW, seq: 9, command: "node scripts/test-all.mjs" }),
      ];
      const { rows } = readResultsFile(writeResultsFile(dir, mixed));
      assert.deepEqual(resumeState(rows, "standalone", CMD, 10), { done: 7, remaining: 3, nextSeq: 10 });
    });
  });

  it("a truncated trailing line does not change the continue-from state", () => {
    withTempDir((dir) => {
      const file = writeResultsFile(dir, [...jsonLines(sevenRows), '{"seq":8,"mode":"standal']);
      const { rows, skippedLines } = readResultsFile(file);
      assert.equal(rows.length, 7);
      assert.equal(skippedLines, 1);
      assert.deepEqual(resumeState(rows, "standalone", CMD, 10), { done: 7, remaining: 3, nextSeq: 8 });
    });
  });

  it("a target already reached leaves nothing to run", () => {
    withTempDir((dir) => {
      const { rows } = readResultsFile(writeResultsFile(dir, jsonLines(sevenRows)));
      assert.deepEqual(resumeState(rows, "standalone", CMD, 7), { done: 7, remaining: 0, nextSeq: 8 });
    });
  });
});

describe("crash classifier", () => {
  // Synthetic registry child entries, one per discriminated writer.
  const fixtures = {
    initTimeout: { status: "crashed", error: "no system/init within 30000 ms" },
    spawnFailure: { status: "crashed", error: "spawn ENOENT" },
    signalKill: { status: "crashed", exitCode: null, signal: "SIGTERM" },
    nonzeroExit: { status: "crashed", exitCode: 1, signal: null },
  };

  it("an init-timeout error names supervisor-spawn.mjs:883", () => {
    const c = classifyCrash(fixtures.initTimeout);
    assert.match(c.writer, /supervisor-spawn\.mjs init-timeout \(supervisor-spawn\.mjs:883\)/);
    assert.equal(c.evidence, "no system/init within 30000 ms");
  });

  it("any other truthy error names supervisor-watch.mjs:261 child.on(error)", () => {
    const c = classifyCrash(fixtures.spawnFailure);
    assert.match(c.writer, /supervisor-watch\.mjs child\.on\(error\) spawn failure \(supervisor-watch\.mjs:261\)/);
    assert.equal(c.evidence, "spawn ENOENT");
  });

  it("a signal kill without an error names supervisor-watch.mjs:298 exit handler, killed by signal", () => {
    const c = classifyCrash(fixtures.signalKill);
    assert.match(c.writer, /supervisor-watch\.mjs exit handler, killed by signal \(supervisor-watch\.mjs:298\)/);
    assert.match(c.evidence, /SIGTERM/);
  });

  it("a non-zero exit without error or signal names supervisor-watch.mjs:298 exit handler, non-zero exit", () => {
    const c = classifyCrash(fixtures.nonzeroExit);
    assert.match(c.writer, /supervisor-watch\.mjs exit handler, non-zero exit \(supervisor-watch\.mjs:298\)/);
    assert.match(c.evidence, /exitCode 1/);
  });

  it("every crashed classification carries a non-empty writer name — a bare crashed is a fail", () => {
    for (const f of [...Object.values(fixtures), { status: "crashed" }]) {
      const c = classifyCrash(f);
      assert.ok(c, `fixture ${JSON.stringify(f)} must classify`);
      assert.equal(typeof c.writer, "string");
      assert.ok(c.writer.trim() !== "", `writer must be non-empty for ${JSON.stringify(f)}`);
      assert.ok(c.evidence && c.evidence.trim() !== "", `evidence must be non-empty for ${JSON.stringify(f)}`);
    }
  });

  it("non-crashed entries classify to null", () => {
    assert.equal(classifyCrash({ status: "exited", exitCode: 0 }), null);
    assert.equal(classifyCrash({ status: "waiting_gate" }), null);
    assert.equal(classifyCrash({ status: "stopped", exitCode: null }), null);
    assert.equal(classifyCrash(null), null);
  });

  it("a clean registry yields crashes: []", () => {
    assert.deepEqual(
      crashesFromRegistry({
        c1: { status: "exited", exitCode: 0 },
        c2: { status: "waiting_gate" },
        c3: { status: "stopped", exitCode: null },
      }),
      [],
    );
  });

  it("crashesFromRegistry names the crashed child", () => {
    const crashes = crashesFromRegistry({ abc: fixtures.signalKill, fine: { status: "exited", exitCode: 0 } });
    assert.equal(crashes.length, 1);
    assert.equal(crashes[0].childId, "abc");
  });

  it("crashesFromOutput classifies each registry error excerpt", () => {
    const output = [
      "  ✗ the watcher writes waiting_gate when a real child leaves a pending gate (490ms)",
      "      status was crashed (registry error: no system/init within 30000 ms)",
      "registry error: spawn ENOENT",
    ].join("\n");
    const crashes = crashesFromOutput(output);
    assert.equal(crashes.length, 2);
    assert.match(crashes[0].writer, /supervisor-spawn\.mjs init-timeout/);
    assert.match(crashes[1].writer, /child\.on\(error\) spawn failure/);
  });

  it("output without a registry error excerpt yields []", () => {
    assert.deepEqual(crashesFromOutput("all green\n64/64 passed"), []);
    assert.deepEqual(crashesFromOutput(""), []);
  });
});

describe("observed load", () => {
  const statsFile = (dir) => join(dir, "results.load-stats.json");

  it("aggregateLoadStats sums the parents' heartbeats and carries the FOC-407 targets", () => {
    withTempDir((dir) => {
      const base = statsFile(dir);
      writeFileSync(parentStatsFile(base, 0), `${JSON.stringify({ spawns: 120, live: 4, peakLive: 8 })}\n`);
      writeFileSync(parentStatsFile(base, 1), `${JSON.stringify({ spawns: 118, live: 3, peakLive: 7 })}\n`);
      const agg = aggregateLoadStats(join(dir, "results.jsonl"), 2, 5000);
      assert.equal(agg.spawns, 238);
      assert.equal(agg.peakLiveSum, 15);
      assert.equal(agg.liveSum, 7);
      assert.equal(agg.parentsReporting, 2);
      assert.equal(agg.parentsExpected, 2);
      assert.equal(agg.wallMs, 5000);
      assert.equal(agg.ratePerSec, 47.6);
      assert.deepEqual(agg.recordedTargets, { ratePerSec: 24, peakLive: "45-46 (FOC-407)" });
      assert.deepEqual(validateRow({ ...ROW, mode: "under-load", observedLoad: agg }), []);
    });
  });

  it("missing and torn heartbeats are skipped and counted, not fatal", () => {
    withTempDir((dir) => {
      const base = statsFile(dir);
      writeFileSync(parentStatsFile(base, 1), `${JSON.stringify({ spawns: 50, live: 0, peakLive: 6 })}\n`);
      writeFileSync(parentStatsFile(base, 2), '{"spawns":'); // torn mid-write by a kill
      const agg = aggregateLoadStats(join(dir, "results.jsonl"), 3, 1000);
      assert.equal(agg.spawns, 50);
      assert.equal(agg.parentsReporting, 1);
      assert.equal(agg.parentsExpected, 3);
      assert.ok(validateRow({ ...ROW, mode: "under-load", observedLoad: agg }).length === 0);
    });
  });

  it("no heartbeats at all → null, which a row may carry", () => {
    withTempDir((dir) => {
      assert.equal(aggregateLoadStats(join(dir, "results.jsonl"), 2, 1000), null);
      assert.deepEqual(validateRow({ ...ROW, mode: "under-load", observedLoad: null }), []);
    });
  });

  it("broken observedLoad shapes are problems", () => {
    for (const bad of [{}, { spawns: -1 }, { spawns: "many" }, { spawns: 1 }, { spawns: 1, wallMs: 1 }, { spawns: 1, wallMs: 1, ratePerSec: 0, peakLiveSum: 0, parentsReporting: 0 }, { spawns: 1, wallMs: 1, ratePerSec: 0, peakLiveSum: 0, parentsReporting: 0, recordedTargets: { ratePerSec: 1, peakLive: "x" } }]) {
      assert.ok(validateRow({ ...ROW, mode: "under-load", observedLoad: bad }).length > 0, `expected a problem for ${JSON.stringify(bad)}`);
    }
    assert.ok(validateRow({ ...ROW, mode: "under-load", observedLoad: 7 }).length > 0);
    assert.ok(validateRow({ ...ROW, mode: "under-load", observedLoad: [{}] }).length > 0);
  });

  it("standalone rows are unaffected by the field", () => {
    assert.deepEqual(validateRow({ ...ROW }), []);
  });

  it("the runner passes the generator a --stats-file whose per-parent files land where the aggregation reads them", () => {
    // Path-identity check, no processes: the exact mismatch that would
    // silently produce nulls on every real iteration.
    withTempDir((dir) => {
      const resultsPath = join(dir, "results.jsonl");
      const base = loadStatsBase(resultsPath);
      for (let i = 0; i < 2; i++) {
        writeFileSync(parentStatsFile(base, i), `${JSON.stringify({ spawns: 1, live: 0, peakLive: 1 })}\n`);
      }
      const agg = aggregateLoadStats(resultsPath, 2, 1000);
      assert.equal(agg.parentsReporting, 2, `aggregation must find both heartbeats beside the results file`);
      assert.equal(readFileSync(parentStatsFile(base, 0), "utf8").trim().endsWith("}"), true);
    });
  });
});

describe("load generator lifecycle", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A CIM query can fail transiently (returns -1 here); retry before reading it
  // as evidence, and never let a query error masquerade as a real count.
  const countWithRetry = async (marker, attempts = 3) => {
    for (let i = 0; i < attempts; i++) {
      const n = countMarkerProcesses(marker);
      if (n >= 0) return n;
      await sleep(500);
    }
    return -1;
  };

  it("marker-matching processes exist during the run and zero remain after it stops", async () => {
    // Warm the CIM query first: on a cold/loaded box the first query can take
    // longer than the generator's whole budget, which once read as "counted 0"
    // against an already-finished run (observed on this machine).
    const warm = await countWithRetry(TEST_MARKER);
    assert.ok(warm >= 0, `the process-table query itself failed ${warm === -1 ? "(counted -1)" : ""}`);
    const gen = spawn(
      process.execPath,
      [LOAD, "--parents", "1", "--burst", "3", "--budget-ms", "10000", "--child-ms", "500", "--interval-ms", "400", "--marker", TEST_MARKER],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    gen.stdout.on("data", (d) => {
      out += d;
    });
    gen.stderr.on("data", (d) => {
      out += d;
    });
    try {
      // Poll rather than sample once: the first round may still be ramping up.
      // The window matches the 10 s budget rather than the budget itself, so a
      // slow-but-warming query still lands while the generator is alive.
      let during = -1;
      for (let waited = 0; waited <= 10000 && during < 1; waited += 500) {
        await sleep(500);
        during = await countWithRetry(TEST_MARKER);
      }
      assert.ok(during >= 1, `expected marker-matching processes during the run, counted ${during}`);

      const code = await new Promise((res) => {
        if (gen.exitCode !== null) return res(gen.exitCode);
        const timer = setTimeout(() => {
          try {
            gen.kill();
          } catch {
            /* already gone */
          }
          res(-1);
        }, 15_000);
        gen.once("close", (c) => {
          clearTimeout(timer);
          res(c);
        });
      });
      assert.equal(code, 0, `generator exited ${code} — output: ${out}`);

      await sleep(300);
      const after = await countWithRetry(TEST_MARKER);
      assert.equal(after, 0, `marker-matching processes must remain after the generator stops (counted ${after}; -1 = the query itself failed)`);
      assert.match(out, /summary \{/, "the generator must record what it actually did beside the FOC-407 targets");
      assert.match(out, /ratePerSec/);
    } finally {
      if (gen.exitCode === null) {
        try {
          gen.kill();
        } catch {
          /* already gone */
        }
      }
    }
  });

  it("heartbeat stats survive a forced kill of the whole tree (the campaign's taskkill path)", async () => {
    // Not withTempDir: the rmSync in its finally would run as soon as this
    // async body returns its first await, while the tree is still live.
    const dir = mkdtempSync(join(tmpdir(), "foc-626-"));
    const resultsPath = join(dir, "results.jsonl");
    const base = loadStatsBase(resultsPath);
    const gen = spawn(
      process.execPath,
      [LOAD, "--parents", "1", "--burst", "3", "--budget-ms", "60000", "--child-ms", "500", "--interval-ms", "300", "--marker", TEST_MARKER, "--stats-file", base],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform === "win32" },
    );
    let out = "";
    gen.stdout.on("data", (d) => {
      out += d;
    });
    try {
      // Wait until the parent has actually spawned children (i.e. has written
      // a non-zero heartbeat), then hard-kill the tree exactly the way the
      // campaign runner stops the load — taskkill /T /F on win32, the group
      // kill on POSIX. No graceful exit, no stdout summary.
      let spawns = 0;
      for (let waited = 0; waited <= 8000 && spawns === 0; waited += 400) {
        await new Promise((r) => setTimeout(r, 400));
        const hb = readHeartbeatFile(parentStatsFile(base, 0));
        if (hb) spawns = hb.spawns;
      }
      assert.ok(spawns > 0, `expected a non-zero heartbeat before the kill; output: ${out}`);

      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(gen.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        try {
          process.kill(-gen.pid, "SIGKILL");
        } catch {
          try {
            gen.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
      await new Promise((res) => {
        if (gen.exitCode !== null || gen.signalCode !== null) return res();
        const timer = setTimeout(res, 10_000);
        gen.once("close", () => {
          clearTimeout(timer);
          res();
        });
      });

      const agg = aggregateLoadStats(resultsPath, 1, 1234);
      assert.ok(agg, `no heartbeat survived the forced kill; generator output: ${out}`);
      assert.ok(agg.spawns > 0, `the surviving heartbeat must record spawns, got ${JSON.stringify(agg)}`);
      assert.ok(agg.peakLiveSum > 0, `the surviving heartbeat must record a live peak, got ${JSON.stringify(agg)}`);
      assert.equal(agg.parentsReporting, 1);
      // The generator's stdout summary (the only place spawns were recorded
      // before) is printed by runTop after the parents close — a tree kill
      // takes runTop itself, so it must never have been printed here.
      assert.doesNotMatch(out, /parentFailures/, "the forced kill must pre-empt the stdout summary — the heartbeat is the only evidence");
      assert.deepEqual(validateRow({ ...ROW, mode: "under-load", observedLoad: agg }), []);
    } finally {
      if (gen.exitCode === null) {
        try {
          gen.kill();
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
