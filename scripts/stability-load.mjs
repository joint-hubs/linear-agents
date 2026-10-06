#!/usr/bin/env node
// scripts/stability-load.mjs — FOC-626 process-churn load generator.
//
// Reproduces the load class recorded in FOC-407 — process churn, NOT CPU load
// (a CPU-spinner produced none of the three `crashed` writers; churn did):
//
//   recorded:  2 parent generators, each bursting 12 short-lived `node`
//              processes, ≈24 spawns/s aggregate, 45-46 live `node` at peak.
//
//   arithmetic against the recorded targets:
//     spawn rate = parents × burst / round-interval
//                = 2 × 12 / 1000 ms = 24 spawns/s (exact)
//     peak live  ≈ parents × burst × ceil(child-ms / round-interval)
//                = 2 × 12 × ceil(1900 / 1000) = 48 — slightly above the
//                recorded 45-46. The burst shape is kept faithful and the
//                summary line records what was actually observed next to the
//                recorded targets instead of fudging either number.
//
// Budget default 900000 ms: the full suite ran ≈780 s in FOC-407, plus margin,
// so the load outlasts one full-suite campaign iteration.
//
// Stop predicate — every process this generator spawns carries the marker
// string on its command line (parents via --marker, children via argv), so
// Win32_Process finds the whole tree (the querying powershell matches too —
// exclude it by Name when counting). Exact stop command:
//
//   Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'foc-626-burst' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }
//
// With --stats-file <path> each parent rewrites its own heartbeat file
// <path sans .json>.p<N>.json at startup, after every spawn round, and once
// more before exiting — cumulative spawns, current/peak live children, start
// and write timestamps. Rewritten files (not an appended log) are the point:
// the campaign runner stops the load with a forced taskkill tree kill, so the
// top-level never gets to print its summary — whatever the parents counted
// last is already on disk and survives the kill.
//
// Touches nothing but the process table and, with --stats-file, the
// caller-designated stats file: no ports, no sockets, no repo-tree writes, no
// telemetry DB.
//
// Run: node scripts/stability-load.mjs [--parents 2] [--burst 12] [--budget-ms 900000] [--child-ms 1900] [--interval-ms 1000] [--marker foc-626-burst] [--stats-file <path>]

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const posInt = (flag, v) => {
  if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1) {
    throw new Error(`${flag} needs a positive integer, got ${v === undefined ? "nothing" : `"${v}"`}`);
  }
  return Number(v);
};

function parseArgs(argv) {
  const args = { role: null, parents: 2, burst: 12, budgetMs: 900_000, childMs: 1_900, intervalMs: 1_000, marker: "foc-626-burst", statsFile: null, parentIndex: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--role") {
      args.role = argv[++i];
      if (!args.role) throw new Error("--role needs a role name");
    } else if (a === "--parents") {
      args.parents = posInt(a, argv[++i]);
    } else if (a === "--burst") {
      args.burst = posInt(a, argv[++i]);
    } else if (a === "--budget-ms") {
      args.budgetMs = posInt(a, argv[++i]);
    } else if (a === "--child-ms") {
      args.childMs = posInt(a, argv[++i]);
    } else if (a === "--interval-ms") {
      args.intervalMs = posInt(a, argv[++i]);
    } else if (a === "--marker") {
      args.marker = argv[++i];
      if (!args.marker) throw new Error("--marker needs a marker string");
    } else if (a === "--stats-file") {
      args.statsFile = argv[++i];
      if (!args.statsFile) throw new Error("--stats-file needs a path");
    } else if (a === "--parent-index") {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) throw new Error(`--parent-index needs a non-negative integer, got ${v === undefined ? "nothing" : `"${v}"`}`);
      args.parentIndex = Number(v);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

// One short-lived child: lives `--child-ms` on a bare timer (churn is the load,
// CPU is not) and carries the marker on its command line via argv so the
// documented stop predicate finds it. The marker is passed but unread — that is
// the point: its only job is to be visible to Win32_Process.
const CHILD_SCRIPT = "setTimeout(() => {}, Number(process.argv[2]) || 1000);";

// Heartbeat: rewrite the parent's own stats file with the counts as of now.
// Rewrite (not append) so a mid-write kill leaves the previous complete
// snapshot, not a torn tail; the parent writes only to its own
// <stem>.p<index>.json — one writer per file, no locking.
function writeHeartbeat(file, stats) {
  try {
    writeFileSync(file, `${JSON.stringify({ ...stats, writtenAt: new Date().toISOString() })}\n`);
  } catch {
    // A stats write must never take the load generator down — the load IS the
    // deliverable; the heartbeat is best-effort evidence.
  }
}

// Parent: rounds of `--burst` short-lived children every `--interval-ms` until
// the budget elapses, then stops spawning and reaps the in-flight children
// (they exit on their own timers) so zero matching processes remain behind.
// With a stats file, every state change (start, each round, graceful exit) is
// rewritten to the parent's own heartbeat file.
async function runParent({ burst, childMs, budgetMs, intervalMs, marker, statsFile, parentIndex }) {
  const stats = { role: "parent", marker, parentIndex, burst, childMs, intervalMs, spawns: 0, live: 0, peakLive: 0, startedAt: new Date().toISOString() };
  if (statsFile) writeHeartbeat(statsFile, stats);
  const deadline = Date.now() + budgetMs;
  const children = new Set();
  while (Date.now() < deadline) {
    for (let i = 0; i < burst && Date.now() < deadline; i++) {
      const child = spawn(process.execPath, ["-e", CHILD_SCRIPT, marker, String(childMs)], {
        stdio: "ignore",
        windowsHide: true,
      });
      stats.spawns++;
      stats.live++;
      if (stats.live > stats.peakLive) stats.peakLive = stats.live;
      child.on("exit", () => {
        stats.live--;
        children.delete(child);
      });
      children.add(child);
    }
    if (statsFile) writeHeartbeat(statsFile, stats);
    await sleep(intervalMs);
  }
  await Promise.all(
    [...children].map((c) => (c.exitCode !== null || c.signalCode !== null ? null : new Promise((res) => c.once("exit", res)))),
  );
  if (statsFile) writeHeartbeat(statsFile, stats);
  console.log(JSON.stringify({ role: "parent", marker, spawns: stats.spawns, peakLive: stats.peakLive }));
}

// The parent role's own file, derived from --stats-file: <stem>.p<index>.json
// so N parents never write the same path. Exported so the campaign runner and
// the tests enumerate exactly the same files.
export function parentStatsFile(statsFile, parentIndex) {
  return statsFile.replace(/\.json$/i, "") + `.p${parentIndex}.json`;
}

// Read one heartbeat. Truncated mid-write JSON (a kill landed during the
// writeFileSync) is skipped — the next rewrite was seconds away.
export function readHeartbeat(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const s = JSON.parse(text);
    return typeof s.spawns === "number" ? s : null;
  } catch {
    return null;
  }
}

async function runTop(args) {
  const start = Date.now();
  const parents = [];
  for (let i = 0; i < args.parents; i++) {
    const parentArgs = [
      SELF,
      "--role", "parent",
      "--burst", String(args.burst),
      "--child-ms", String(args.childMs),
      "--budget-ms", String(args.budgetMs),
      "--interval-ms", String(args.intervalMs),
      "--marker", args.marker,
    ];
    if (args.statsFile) parentArgs.push("--stats-file", parentStatsFile(args.statsFile, i), "--parent-index", String(i));
    const p = spawn(process.execPath, parentArgs, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const record = { p, out: "", err: "" };
    parents.push(record);
    p.stdout.on("data", (d) => {
      record.out += d;
    });
    p.stderr.on("data", (d) => {
      record.err += d;
    });
  }

  // The generator top-level is itself killed by the documented marker sweep or
  // by the campaign runner's tree kill; this handler is only for an operator
  // Ctrl-C on the console, where the parents would otherwise outlive the stop.
  const stopParents = () => {
    for (const { p } of parents) {
      try {
        p.kill();
      } catch {
        /* already gone */
      }
    }
  };
  process.on("SIGINT", () => {
    stopParents();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stopParents();
    process.exit(143);
  });

  const results = await Promise.all(
    parents.map((record) => new Promise((res) => record.p.once("close", (code, signal) => res({ code, signal, out: record.out, err: record.err })))),
  );

  let spawns = 0;
  let peakLiveSum = 0;
  let parentFailures = 0;
  const perParent = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const lastLine = r.out.split("\n").filter(Boolean).pop();
    let summary = null;
    try {
      summary = JSON.parse(lastLine);
    } catch {
      /* not the parent's summary line */
    }
    if (r.code !== 0 || !summary) {
      parentFailures++;
      console.error(`a parent generator failed (exit ${r.code}): ${(r.err.trim() || r.out.trim()) || "no output"}`);
      // A forced kill on this parent leaves no stdout summary — its heartbeat
      // file (written through the last spawn round) is the surviving evidence.
      const hb = args.statsFile ? readHeartbeat(parentStatsFile(args.statsFile, i)) : null;
      if (hb) {
        spawns += hb.spawns || 0;
        peakLiveSum += hb.peakLive || 0;
      }
      perParent.push(hb);
      continue;
    }
    spawns += summary.spawns || 0;
    peakLiveSum += summary.peakLive || 0;
    perParent.push(summary);
  }

  const wallMs = Date.now() - start;
  const ratePerSec = wallMs > 0 ? Math.round((spawns / (wallMs / 1000)) * 100) / 100 : 0;
  // peakLiveSum is the sum of per-parent peaks sampled at different instants —
  // an upper bound on the true concurrent peak, which is why it is recorded
  // beside (not instead of) the FOC-407 target.
  console.log(
    `summary ${JSON.stringify({
      marker: args.marker,
      parents: args.parents,
      burst: args.burst,
      intervalMs: args.intervalMs,
      childMs: args.childMs,
      budgetMs: args.budgetMs,
      wallMs,
      spawns,
      ratePerSec,
      peakLiveSum,
      recordedTargets: { ratePerSec: 24, peakLive: "45-46 (FOC-407)" },
      parentFailures,
      perParent,
    })}`,
  );
  process.exit(parentFailures ? 1 : 0);
}

// Main-module guard: importing this file (the campaign runner imports
// parentStatsFile/readHeartbeat, tests import the same) must never start the
// load — only a direct `node scripts/stability-load.mjs` invocation runs it.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.role === "parent") await runParent(args);
    else await runTop(args);
  } catch (err) {
    console.error(`stability-load: ${err.message}`);
    console.error("Run with no arguments to see the defaults in the header comment.");
    process.exit(2);
  }
}
