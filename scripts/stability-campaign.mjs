#!/usr/bin/env node
// scripts/stability-campaign.mjs — FOC-626 stability campaign runner.
//
// Question the campaign answers: does the FOC-407 fix keep "the watcher writes
// waiting_gate when a real child leaves a pending gate"
// (scripts/supervisor-gate.test.mjs:490) green under volume? The runner spins
// that test standalone, or the whole suite under the recorded FOC-407
// process-churn load class, N times, and appends one JSONL row per iteration.
// A row names WHICH of the three `crashed` writers fired with its
// discriminating evidence — a bare "crashed" is a fail:
//
//   supervisor-spawn.mjs init-timeout (supervisor-spawn.mjs:883)
//       error matching "no system/init within <N> ms"
//   supervisor-watch.mjs child.on(error) spawn failure (supervisor-watch.mjs:261)
//       any other truthy error
//   supervisor-watch.mjs exit handler, killed by signal (supervisor-watch.mjs:298)
//       signal set, no error
//   supervisor-watch.mjs exit handler, non-zero exit (supervisor-watch.mjs:298)
//       non-zero exitCode, no error or signal
//
// Crash sources, both attributed per iteration:
//   - children.json entries under .state/supervisor/test-*/ (suite debris, the
//     FOC-602 accumulation) that are new or modified since the iteration
//     started — unchanged files belong to earlier iterations and are never
//     re-reported;
//   - `registry error:` excerpts in the iteration's own suite output.
//
// Results: --results <path> takes a .jsonl file or a directory (which gets
// <mode>.jsonl); the default directory is .state/stability/. Full suite output
// per iteration goes to <results-base>.iter<seq>.log beside the results file
// and is kept; the row carries only a short tail.
//
// --resume counts the valid rows already on the results file (same mode and
// command) and runs only the remainder toward the requested total. A line that
// does not parse is skipped, never fatal — the previous process may have died
// mid-write, and resume must work with a truncated trailing line.
//
// --daemon re-spawns this runner without --daemon, detached and unref'd, and
// exits 0 at once — the documented launch command returns immediately and the
// campaign survives the launching process (and any agent turn) ending; a turn
// dying costs at most the in-flight iteration.
//
// The runner invokes scripts/test-all.mjs and nothing else of the suite
// machinery — lanes, budgets and isolation logic stay owned by test-run.mjs.
// It writes only under .state/stability/ (plus whatever the spawned suite
// writes) and never touches live telemetry.
//
// Run: node scripts/stability-campaign.mjs --standalone 3

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const SELF = fileURLToPath(import.meta.url);
const TEST_ALL = join(HERE, "test-all.mjs");
const STABILITY_DIR = join(REPO_ROOT, ".state", "stability");
const LOAD_SCRIPT = join(HERE, "stability-load.mjs");

// The FOC-407 recorded load class, passed through to stability-load.mjs's
// defaults: 2 parents bursting 12 short-lived node processes, ≈24 spawns/s,
// 45-46 live node at peak. The budget is one full suite (≈780 s) plus margin,
// so the load outlasts a full-suite iteration.
const LOAD_ARGS = [
  "--parents", "2",
  "--burst", "12",
  "--child-ms", "1900",
  "--interval-ms", "1000",
  "--budget-ms", "900000",
  "--marker", "foc-626-burst",
];

// Row tail budget: the full evidence lives in the iteration's .log file; the
// row carries just enough to see WHAT failed without opening it.
const TAIL_LINES = 40;
const TAIL_CHARS = 4000;
// Registry-scan cap for one row: a crashed suite can mark many children; the
// row needs the writers, the .log keeps the rest.
const MAX_CRASHES_PER_ROW = 20;

export const WRITER_INIT_TIMEOUT = "supervisor-spawn.mjs init-timeout (supervisor-spawn.mjs:883)";
export const WRITER_SPAWN_FAILURE = "supervisor-watch.mjs child.on(error) spawn failure (supervisor-watch.mjs:261)";
export const WRITER_SIGNAL_KILL = "supervisor-watch.mjs exit handler, killed by signal (supervisor-watch.mjs:298)";
export const WRITER_NONZERO_EXIT = "supervisor-watch.mjs exit handler, non-zero exit (supervisor-watch.mjs:298)";
export const WRITER_EXIT_HANDLER = "supervisor-watch.mjs exit handler (supervisor-watch.mjs:298)";

const INIT_TIMEOUT_RE = /no system\/init within \d+ ms/;

// Pure classifier: a registry child entry (or an output excerpt dressed as
// one) → { writer, evidence } naming WHICH writer produced the crash, or null
// when the entry is not a crash. The invariant the tests hold: any crashed
// classification carries a non-empty writer name — a bare "crashed" is a fail.
export function classifyCrash(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.status !== "crashed") return null;
  const error = typeof entry.error === "string" ? entry.error.trim() : "";
  if (error) {
    if (INIT_TIMEOUT_RE.test(error)) return { writer: WRITER_INIT_TIMEOUT, evidence: error };
    return { writer: WRITER_SPAWN_FAILURE, evidence: error };
  }
  if (entry.signal) {
    return { writer: WRITER_SIGNAL_KILL, evidence: `signal ${entry.signal}, exitCode ${entry.exitCode ?? null}` };
  }
  if (entry.exitCode != null && entry.exitCode !== 0) {
    return { writer: WRITER_NONZERO_EXIT, evidence: `exitCode ${entry.exitCode}, no error or signal recorded` };
  }
  // A crash with no discriminating field at all can only come from the exit
  // handler (the other two writers always write an `error`); keep the
  // never-a-bare-crashed invariant by naming it and quoting the raw fields.
  return {
    writer: WRITER_EXIT_HANDLER,
    evidence: `status "crashed" with no error, signal ${JSON.stringify(entry.signal ?? null)} and exitCode ${JSON.stringify(entry.exitCode ?? null)}`,
  };
}

// Classify every crashed entry of a registry `children` map (the shape of
// children.json's `children` key), tagging each crash with its child id.
export function crashesFromRegistry(children) {
  const out = [];
  for (const [childId, entry] of Object.entries(children ?? {})) {
    const crash = classifyCrash(entry);
    if (crash) out.push({ ...crash, childId });
  }
  return out;
}

// The failing suite output surfaces a child's `error` field as
// `registry error: <text>` (also seen wrapped: "status was crashed (registry
// error: ...)"). Each excerpt is classified like a crashed registry entry.
export function crashesFromOutput(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/registry error:\s*(.+)/g)) {
    const excerpt = m[1].trim();
    const crash = classifyCrash({ status: "crashed", error: excerpt });
    if (crash) out.push({ ...crash, excerpt });
  }
  return out;
}

// Row contract (one JSONL row appended per iteration, as it completes):
//   seq        1-based across the results file (continues across --resume)
//   mode       "standalone" | "under-load"
//   command    the suite command the iteration ran
//   startedAt  ISO timestamp
//   durationMs per-iteration wall time (AC requirement)
//   ok         the suite exit code was 0
//   exitCode   integer, or null when the suite could not be spawned at all
//   crashes    array of { writer, evidence, ... } — never a bare "crashed"
//   tail       short tail of the iteration's suite output
//   logFile    the full-output log beside the results file
export function validateRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return ["row is not a JSON object"];
  const problems = [];
  if (!Number.isInteger(row.seq) || row.seq < 1) problems.push(`seq must be a positive integer, got ${JSON.stringify(row.seq)}`);
  if (row.mode !== "standalone" && row.mode !== "under-load") {
    problems.push(`mode must be "standalone" or "under-load", got ${JSON.stringify(row.mode)}`);
  }
  if (typeof row.command !== "string" || row.command === "") problems.push("command must be a non-empty string");
  if (typeof row.startedAt !== "string" || Number.isNaN(Date.parse(row.startedAt))) {
    problems.push("startedAt must be an ISO timestamp string");
  }
  if (typeof row.durationMs !== "number" || !Number.isFinite(row.durationMs) || row.durationMs < 0) {
    problems.push(`durationMs must be a non-negative finite number, got ${JSON.stringify(row.durationMs)}`);
  }
  if (typeof row.ok !== "boolean") problems.push("ok must be a boolean");
  if (row.exitCode !== null && !Number.isInteger(row.exitCode)) {
    problems.push(`exitCode must be an integer or null, got ${JSON.stringify(row.exitCode)}`);
  }
  if (row.ok !== (row.exitCode === 0)) problems.push("ok must equal (exitCode === 0)");
  if (!Array.isArray(row.crashes)) {
    problems.push("crashes must be an array");
  } else {
    row.crashes.forEach((c, i) => {
      if (!c || typeof c !== "object" || typeof c.writer !== "string" || c.writer.trim() === "") {
        problems.push(`crashes[${i}] must name its writer — a bare "crashed" is a fail`);
      } else if (typeof c.evidence !== "string" || c.evidence.trim() === "") {
        problems.push(`crashes[${i}] must quote the discriminating evidence`);
      }
    });
  }
  if (typeof row.tail !== "string") problems.push("tail must be a string — the row carries a short output tail");
  if (typeof row.logFile !== "string" || row.logFile === "") {
    problems.push("logFile must be a non-empty string — the full output lives in the log beside the results file");
  }
  return problems;
}

// Parse a JSONL results file. A line that fails to parse or validate is
// skipped, never fatal — the previous process may have died mid-write and
// resume must work with a truncated trailing line.
export function readResultsFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { rows: [], skippedLines: 0 };
    throw err;
  }
  const rows = [];
  let skippedLines = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    let parsed = null;
    try {
      parsed = JSON.parse(t);
    } catch {
      skippedLines++;
      continue;
    }
    if (validateRow(parsed).length > 0) {
      skippedLines++;
      continue;
    }
    rows.push(parsed);
  }
  return { rows, skippedLines };
}

// --resume: valid rows already on the file with the same mode and command count
// toward the requested total; completed iterations are NOT re-run. seq stays
// 1-based across the whole file, so it continues from the highest row on it.
export function resumeState(rows, mode, command, target) {
  const done = rows.filter((r) => r.mode === mode && r.command === command).length;
  const nextSeq = rows.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
  return { done, remaining: Math.max(0, target - done), nextSeq };
}

// .state/supervisor/test-* run dirs are suite debris (the FOC-602
// accumulation); live supervisor runs never carry the test- prefix, so this
// scan stays out of live telemetry.
function registrySnapshots() {
  const dir = join(REPO_ROOT, ".state", "supervisor");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const snaps = [];
  for (const e of entries) {
    if (!e.isDirectory() || !/^test-/.test(e.name)) continue;
    const file = join(dir, e.name, "children.json");
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    snaps.push({ file, mtimeMs: st.mtimeMs });
  }
  return snaps;
}

function collectCrashes(before, after, output) {
  const crashes = [];
  const seen = new Set();
  const push = (c) => {
    const key = `${c.writer}|${c.evidence}`;
    if (seen.has(key) || crashes.length >= MAX_CRASHES_PER_ROW) return;
    seen.add(key);
    crashes.push(c);
  };
  const beforeMtimes = new Map(before.map((s) => [s.file, s.mtimeMs]));
  for (const snap of after) {
    // Unchanged since the iteration started → debris from an earlier
    // iteration, not evidence for this one.
    if (beforeMtimes.get(snap.file) === snap.mtimeMs) continue;
    let registry;
    try {
      registry = JSON.parse(readFileSync(snap.file, "utf8"));
    } catch {
      continue;
    }
    const children = registry && typeof registry === "object" && registry.children ? registry.children : registry;
    for (const c of crashesFromRegistry(children)) push(c);
  }
  for (const c of crashesFromOutput(output)) push(c);
  return crashes;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Await a child's close. timeoutMs 0 = wait forever (the suite owns its own
// duration); otherwise the child is killed when the timeout lands.
function closeOf(child, timeoutMs) {
  return new Promise((res) => {
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      res(r);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish({ code: null, signal: null, forced: true });
      }, timeoutMs);
    }
    child.once("close", (code, signal) => finish({ code, signal }));
    // A spawn that fails outright (e.g. ENOENT) never emits close.
    child.once("error", (err) => finish({ code: null, signal: null, spawnError: err.message }));
  });
}

// Stop the load tree. The generator's own budget (900 s) is the backstop; the
// primary stop is a tree kill so the next iteration does not inherit leftover
// churn. taskkill /T walks the whole parent→parent-role→child tree on win32;
// POSIX uses a process-group kill (the generator is spawned detached).
async function stopLoadTree(gen) {
  if (!gen || gen.exitCode !== null || gen.signalCode !== null) return null;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(gen.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-gen.pid, "SIGTERM");
    } catch {
      try {
        gen.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  const close = await closeOf(gen, 10_000);
  return close.forced ? `the load generator (PID ${gen.pid}) needed a forced kill — its budget backstop is 900000 ms` : null;
}

function tailOf(text) {
  const lines = String(text ?? "")
    .split("\n")
    .filter((l) => l.trim() !== "");
  return lines.slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
}

async function runIteration({ seq, mode, suiteArgs, suiteCommand, resultsPath, withLoad }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const before = registrySnapshots();

  let gen = null;
  let genOut = "";
  if (withLoad) {
    gen = spawn(process.execPath, [LOAD_SCRIPT, ...LOAD_ARGS], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    gen.stdout.on("data", (d) => {
      genOut += d;
    });
    gen.stderr.on("data", (d) => {
      genOut += d;
    });
  }

  const suite = spawn(process.execPath, suiteArgs, {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  suite.stdout.on("data", (d) => {
    out += d;
  });
  suite.stderr.on("data", (d) => {
    out += d;
  });
  const close = await closeOf(suite, 0);
  if (close.spawnError) out += `\n[stability-campaign] the suite could not be spawned: ${close.spawnError}`;
  const exitCode = close.code ?? null;

  if (gen) {
    const warning = await stopLoadTree(gen);
    if (warning) out += `\n[stability-campaign] ${warning}`;
    if (genOut.trim()) out += `\n--- load generator output ---\n${genOut}`;
  }

  const crashes = collectCrashes(before, registrySnapshots(), out);
  const durationMs = Date.now() - t0;
  const logFile = `${basename(resultsPath).replace(/\.jsonl$/i, "")}.iter${seq}.log`;
  appendFileSync(join(dirname(resultsPath), logFile), `${out}${out.endsWith("\n") ? "" : "\n"}`);
  const row = { seq, mode, command: suiteCommand, startedAt, durationMs, ok: exitCode === 0, exitCode, crashes, tail: tailOf(out), logFile };
  appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
  return row;
}

function usage() {
  return `Usage:
  node scripts/stability-campaign.mjs --standalone N [--results <path>] [--resume] [--daemon]
  node scripts/stability-campaign.mjs --under-load N [--suite-pattern <p>] [--results <path>] [--resume] [--daemon]

Measures whether the FOC-407 fix keeps "the watcher writes waiting_gate when a
real child leaves a pending gate" (scripts/supervisor-gate.test.mjs:490) green
under volume, one JSONL row per iteration.

  --standalone N       N iterations of: node scripts/test-all.mjs supervisor-gate
  --under-load N       N iterations of: node scripts/test-all.mjs [pattern]
                       while the FOC-407 process-churn load generator
                       (scripts/stability-load.mjs) runs beside the suite
  --suite-pattern <p>  substring filter forwarded to test-all — run a short
                       suite under load instead of the full one
                       (under-load only; no pattern = full suite)
  --results <path>     a .jsonl file or a directory (which gets <mode>.jsonl);
                       default directory .state/stability/. Iteration logs are
                       written beside it and kept.
  --resume             count the valid rows already on the results file (same
                       mode and command) and run only the remainder toward N;
                       a truncated trailing line is skipped, so this works when
                       the previous process died mid-file
  --daemon             re-spawn this command detached and return immediately —
                       the campaign survives the launching process ending

Every row names the crashed writer with its discriminating evidence — a bare
"crashed" is a fail. A failed iteration is a finding, not a runner error: the
runner exits 0 when the campaign completes, 2 on usage errors.`;
}

function resolveResultsPath(results, mode) {
  if (!results) return join(STABILITY_DIR, `${mode}.jsonl`);
  const p = resolve(results);
  return p.toLowerCase().endsWith(".jsonl") ? p : join(p, `${mode}.jsonl`);
}

// --daemon: re-spawn this runner without --daemon, detached and unref'd, and
// exit 0 at once. The documented launch command returns immediately and the
// campaign survives the launching process (and any agent turn) ending — a turn
// dying costs at most the in-flight iteration. Runner console output goes to
// runner.log beside the results file; the results file and iteration logs are
// the durable record.
function spawnDaemon(args, resultsPath) {
  const runnerLog = join(dirname(resultsPath), "runner.log");
  const fd = openSync(runnerLog, "a");
  const childArgs = process.argv.slice(2).filter((a) => a !== "--daemon");
  const child = spawn(process.execPath, [SELF, ...childArgs], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  closeSync(fd);
  console.log(`Campaign detached (PID ${child.pid}). Results: ${resultsPath} — runner log: ${runnerLog}.`);
}

function parseArgs(argv) {
  const args = { mode: null, count: null, results: null, suitePattern: null, resume: false, daemon: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help") {
      args.help = true;
    } else if (a === "--resume") {
      args.resume = true;
    } else if (a === "--daemon") {
      args.daemon = true;
    } else if (a === "--standalone" || a === "--under-load") {
      if (args.mode) throw new Error(`cannot combine ${a} with the ${args.mode} flag`);
      const n = argv[++i];
      if (n === undefined || !/^\d+$/.test(n) || Number(n) < 1) {
        throw new Error(`${a} needs a positive integer, got ${n === undefined ? "nothing" : `"${n}"`}`);
      }
      args.mode = a === "--standalone" ? "standalone" : "under-load";
      args.count = Number(n);
    } else if (a === "--results") {
      args.results = argv[++i];
      if (!args.results) throw new Error("--results needs a path");
    } else if (a === "--suite-pattern") {
      args.suitePattern = argv[++i];
      if (!args.suitePattern) throw new Error("--suite-pattern needs a pattern");
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.mode) throw new Error("exactly one of --standalone N / --under-load N is required");
  if (args.mode === "standalone" && args.suitePattern) {
    throw new Error("--suite-pattern only applies to --under-load; standalone always runs the target test");
  }

  const resultsPath = resolveResultsPath(args.results, args.mode);
  mkdirSync(dirname(resultsPath), { recursive: true });
  if (args.daemon) {
    spawnDaemon(args, resultsPath);
    return;
  }

  const suitePattern = args.mode === "standalone" ? "supervisor-gate" : args.suitePattern;
  const suiteArgs = [TEST_ALL, ...(suitePattern ? [suitePattern] : [])];
  const suiteCommand = `node scripts/test-all.mjs${suitePattern ? ` ${suitePattern}` : ""}`;

  let rows = [];
  let skippedLines = 0;
  if (existsSync(resultsPath)) {
    if (!args.resume) {
      throw new Error(`${resultsPath} already exists — pass --resume to continue it, or --results to start a different file`);
    }
    ({ rows, skippedLines } = readResultsFile(resultsPath));
  }
  const state = resumeState(rows, args.mode, suiteCommand, args.count);
  if (skippedLines) {
    console.log(`Skipped ${skippedLines} unparseable line(s) on ${resultsPath} — truncated mid-write rows.`);
  }
  if (state.remaining === 0) {
    console.log(`${state.done}/${args.count} ${args.mode} iteration(s) already on ${resultsPath} — nothing to run.`);
    return;
  }
  console.log(`Running ${state.remaining} ${args.mode} iteration(s) toward ${args.count} (continuing after ${state.done}); suite: ${suiteCommand}.`);

  let failed = 0;
  let crashCount = 0;
  for (let i = 0; i < state.remaining; i++) {
    const row = await runIteration({
      seq: state.nextSeq + i,
      mode: args.mode,
      suiteArgs,
      suiteCommand,
      resultsPath,
      withLoad: args.mode === "under-load",
    });
    if (!row.ok) failed++;
    crashCount += row.crashes.length;
    console.log(
      `[iter ${row.seq}] ${row.ok ? "ok" : `FAILED (exit ${row.exitCode})`} in ${row.durationMs} ms — ${row.crashes.length} crash record(s): ${row.crashes.map((c) => c.writer).join("; ") || "none"}`,
    );
  }
  console.log(`Campaign complete: ${state.remaining} iteration(s) appended to ${resultsPath} — ${failed} failed, ${crashCount} crash record(s) total.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`stability-campaign: ${err.message}`);
    console.error("Run with --help for usage.");
    process.exit(2);
  });
}