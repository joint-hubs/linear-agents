#!/usr/bin/env node
// scripts/test-run.mjs — the single owner of test execution (FOC-614).
// scripts/test-all.mjs is a thin delegate to this file. Every scripts/*.test.mjs
// is assigned to one of two explicit lanes in scripts/test-lanes.json:
//
//   parallel — files proven isolated: mkdtemp/tmpdir fixtures only, no ports,
//     no socket binds, no writes to real repo paths. Run concurrently.
//   serial   — files with shared resources (fixed ports, socket binds, real
//     repo-path writes, live telemetry DB seams). Run one at a time.
//
// The split is not implicit: a coverage check (always on) fails the run when a
// discovered test file is in zero lanes or both lanes, or when a lane entry
// names a file that no longer exists. A static audit fails the run when a
// parallel-lane file contains a known disqualifying marker.
//
// What the isolation proof does and does not show:
//   - The static audit is a regex scan of the parallel lane for known markers
//     (server binds, fixed-port constants, repo-root-anchored writes, the live
//     DB seam being unset, spawning the real telemetry-server). It is a text
//     scan, not a dataflow guarantee: a write through a variable assigned from
//     a repo-root join elsewhere in the file would be missed.
//   - `--prove-isolation` runs every parallel-lane file at once and requires
//     all green. That shows absence of OBSERVED interference at the tested
//     concurrency on this machine — not a formal guarantee. A file that flakes
//     under parallel load belongs in the serial lane.
//
// Usage: node scripts/test-run.mjs [pattern] [--jobs N] [--max-wall-ms X] [--prove-isolation]
//   pattern            substring to filter test file names (e.g. "telemetry")
//   --jobs N           max concurrency for the parallel lane (default 8);
//                      the serial lane is always concurrency 1
//   --max-wall-ms X    wall-clock budget for the whole run. On exceed: stop
//                      admitting new files, kill in-flight files, report the
//                      three buckets (finished / cut short / never started),
//                      exit non-zero. Default: no budget.
//   --prove-isolation  run ALL parallel-lane files concurrently (concurrency =
//                      file count) and require all green. The pattern filter
//                      and --jobs are ignored for this mode.

import { readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const LANES_FILE = join(SCRIPTS_DIR, 'test-lanes.json');
const DEFAULT_JOBS = 8;

// ── args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: node scripts/test-run.mjs [pattern] [--jobs N] [--max-wall-ms X] [--prove-isolation]

Runs every scripts/*.test.mjs in two lanes from scripts/test-lanes.json:
parallel (isolated files, concurrency --jobs) and serial (shared-resource
files, concurrency 1). Both lanes run at the same time; the serial lane
never runs two files at once.

Isolation proof — what it does and does not show:
  - The static audit (always on) regex-scans every parallel-lane file for
    known disqualifying markers: server binds, socket connects, listen(port),
    dgram/WebSocket servers, fixed-port constants, spawns of the real
    telemetry-server, writes whose destination is anchored to the real repo
    root, and unsetting of the LA_TELEMETRY_DB/HOME seam (which puts the live
    default DB path in play). It is a text scan, not a dataflow guarantee —
    a write through a variable assigned from a repo-root join elsewhere in
    the file would be missed.
  - --prove-isolation runs every parallel-lane file at once and requires all
    green. It shows absence of OBSERVED interference at the tested concurrency
    on this machine, not a formal guarantee. New flakes under parallel load
    mean the file belongs in the serial lane.`);
  process.exit(0);
}

let filter = '';
let jobs = DEFAULT_JOBS;
let maxWallMs = 0;
let proveIsolation = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--jobs') {
    jobs = Number(args[++i]);
    if (!Number.isInteger(jobs) || jobs < 1) {
      console.error(`--jobs needs a positive integer, got "${args[i]}"`);
      process.exit(2);
    }
  } else if (a === '--max-wall-ms') {
    maxWallMs = Number(args[++i]);
    if (!Number.isFinite(maxWallMs) || maxWallMs <= 0) {
      console.error(`--max-wall-ms needs a positive number of ms, got "${args[i]}"`);
      process.exit(2);
    }
  } else if (a === '--prove-isolation') {
    proveIsolation = true;
  } else if (!a.startsWith('--')) {
    filter = a;
  } else {
    console.error(`Unknown option: ${a}`);
    process.exit(2);
  }
}

// ── discovery, lanes, coverage check ─────────────────────────────────────────

const discover = () =>
  readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.test.mjs'))
    .filter((f) => !f.startsWith('_')) // skip helpers, defensive (same rule as the old test-all.mjs)
    .sort();

const allFiles = discover();

let lanes;
try {
  lanes = JSON.parse(readFileSync(LANES_FILE, 'utf8'));
} catch (err) {
  console.error(`Cannot read lane config ${LANES_FILE}: ${err.message}`);
  process.exit(1);
}
for (const laneName of ['parallel', 'serial']) {
  if (!Array.isArray(lanes[laneName])) {
    console.error(`Lane config ${LANES_FILE} is missing the "${laneName}" array.`);
    process.exit(1);
  }
}

const coverageErrors = (() => {
  const errors = [];
  const laneCount = new Map(); // file -> number of lanes listing it
  for (const laneName of ['parallel', 'serial']) {
    for (const entry of lanes[laneName]) {
      if (!entry || typeof entry.file !== 'string' || typeof entry.reason !== 'string') {
        errors.push(`Lane "${laneName}" has an entry without "file" and/or "reason".`);
        continue;
      }
      laneCount.set(entry.file, (laneCount.get(entry.file) || 0) + 1);
    }
  }
  const onDisk = new Set(allFiles);
  for (const [file, count] of laneCount) {
    if (count > 1) errors.push(`"${file}" is listed in ${count} lanes — every test file must be in exactly one.`);
  }
  for (const laneName of ['parallel', 'serial']) {
    for (const entry of lanes[laneName]) {
      if (entry?.file && !onDisk.has(entry.file)) {
        errors.push(`"${entry.file}" is listed in the ${laneName} lane but no such test file exists on disk — remove the stale entry.`);
      }
    }
  }
  for (const f of allFiles) {
    if (!laneCount.has(f)) {
      errors.push(`"${f}" is not listed in either lane of scripts/test-lanes.json — add it to exactly one lane with a written reason.`);
    }
  }
  return errors;
})();

if (coverageErrors.length) {
  console.error(`Lane coverage check FAILED (${coverageErrors.length} problem(s)):`);
  for (const e of coverageErrors) console.error(`  - ${e}`);
  process.exit(1);
}

// ── static isolation audit (parallel lane only) ──────────────────────────────

// Comment-only lines are stripped first so a marker mentioned in prose is not
// flagged; markers must appear in actual code to count.
const stripCommentLines = (src) =>
  src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

const AUDIT_MARKERS = [
  { name: 'server bind (createServer)', re: /\bcreateServer\s*\(/ },
  { name: 'socket connect (net.connect/createConnection)', re: /\bnet\s*\.\s*(?:connect|createConnection)\b|\bcreateConnection\s*\(/ },
  { name: 'listen(port) call', re: /\.listen\s*\(\s*\d/ },
  { name: 'dgram socket', re: /\bdgram\b/ },
  { name: 'WebSocket server', re: /\bWebSocketServer\b/ },
  { name: 'fixed-port constant (PORT = n / port: n)', re: /\bPORT\s*[:=]\s*\d{3,}|\bport\s*[:=]\s*\d{3,}/ },
  { name: 'spawns the real telemetry-server', re: /\bspawn(?:Sync)?\(\s*(?:process\.execPath|['"]node['"])\s*,\s*\[[^\]]*telemetry-server\.mjs/ },
  { name: 'write/mkdir destination anchored to the real repo root', re: /\b(?:write|append|mkdir)Sync\(\s*join\(\s*(?:ROOT|process\.cwd\(\)|__dirname)\b/ },
  { name: 'copy/rename destination anchored to the real repo root', re: /\b(?:copy|rename)Sync\([^,]*,\s*join\(\s*(?:ROOT|process\.cwd\(\)|__dirname)\b/ },
  { name: 'unsets the LA_TELEMETRY_DB/HOME seam (live default DB path in play)', re: /\bdelete\s+[A-Za-z_.$]*LA_TELEMETRY_(?:DB|HOME)\b/ },
];

const auditProblems = (() => {
  const problems = [];
  for (const { file } of lanes.parallel) {
    const src = stripCommentLines(readFileSync(join(SCRIPTS_DIR, file), 'utf8'));
    for (const marker of AUDIT_MARKERS) {
      if (marker.re.test(src)) problems.push(`"${file}" (parallel lane): ${marker.name}`);
    }
  }
  return problems;
})();

if (auditProblems.length) {
  console.error(`Static isolation audit FAILED (${auditProblems.length} problem(s)) — these files do not belong on the parallel allowlist:`);
  for (const p of auditProblems) console.error(`  - ${p}`);
  process.exit(1);
}

// ── child env: strip LA_SUPERVISOR* (FOC-295) ────────────────────────────────

// Suite files are hermetic: they assume a clean environment, and supervisor-cleanup
// in particular refuses inside a spawned child (the FOC-167 identity guard). This
// runner usually runs inside one, so the supervisor's LA_SUPERVISOR* variables would
// leak into every child. Strip the prefix for the suite subprocesses — the guard
// itself is untouched. Nothing LA_SUPERVISOR* is added back — zz-suite-env-scrub.test.mjs
// holds that line. Suites that spawn mock children set the offline codegraph seam
// (LA_SUPERVISOR_NO_CODEGRAPH=1) in their own env builders — see baseEnv in
// supervisor-test-fixtures.mjs.
const suiteEnv = { ...process.env };
for (const key of Object.keys(suiteEnv)) {
  if (key.startsWith('LA_SUPERVISOR')) delete suiteEnv[key];
}

// ── execution ────────────────────────────────────────────────────────────────

const makeBudget = (maxMs) => {
  const killers = new Set();
  const budget = {
    exceeded: () => false,
    onKill: (fn) => killers.add(fn),
  };
  if (maxMs > 0) {
    const t0 = Date.now();
    budget.exceeded = () => Date.now() - t0 > maxMs;
    const timer = setInterval(() => {
      if (budget.exceeded()) for (const fn of killers) fn();
    }, 250);
    timer.unref();
  }
  return budget;
};

// Run `files` with at most `concurrency` concurrent children. Returns
// { finished: [...], neverStarted: [...] } — each finished record carries
// { file, code, signal, duration, out, err, killed }.
const runFiles = (files, concurrency, budget) =>
  new Promise((resolve) => {
    const queue = [...files];
    const running = new Map(); // child process -> record
    const finished = [];
    let killed = false;

    const killInFlight = () => {
      if (killed) return;
      killed = true;
      for (const record of running.values()) {
        record.killed = true;
        record.child.kill();
      }
    };
    budget.onKill(killInFlight);

    const admit = () => {
      const file = queue.shift();
      if (!file) return;
      const t0 = Date.now();
      const child = spawn(process.execPath, [join(SCRIPTS_DIR, file)], {
        env: suiteEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const record = { file, child, out: '', err: '', killed: false };
      running.set(child, record);
      child.stdout.on('data', (d) => { record.out += d; });
      child.stderr.on('data', (d) => { record.err += d; });
      let closed = false;
      const settle = (code, signal) => {
        if (closed) return;
        closed = true;
        running.delete(child);
        finished.push({
          file,
          code,
          signal,
          duration: Date.now() - t0,
          out: record.out,
          err: record.err,
          killed: record.killed,
        });
        pump();
      };
      // A spawn that fails outright (e.g. ENOENT) never emits 'close'.
      child.on('error', (e) => {
        record.err += `\n${e.message}`;
        settle(-1, null);
      });
      child.on('close', (code, signal) => {
        settle(code, signal);
      });
    };

    const pump = () => {
      while (!killed && running.size < concurrency && queue.length) {
        if (budget.exceeded()) {
          killInFlight();
          break;
        }
        admit();
      }
      if (running.size === 0) {
        resolve({ finished, neverStarted: queue.splice(0) });
      }
    };
    pump();
  });

// Selected run order: both lanes start together — the parallel lane bounded by
// --jobs, the serial lane strictly one file at a time.
const selected = (list) => list.map((e) => e.file).filter((f) => !filter || f.includes(filter));
const parallelFiles = proveIsolation ? lanes.parallel.map((e) => e.file) : selected(lanes.parallel);
const serialFiles = proveIsolation ? [] : selected(lanes.serial);
const runConcurrency = proveIsolation ? parallelFiles.length : jobs;

if (parallelFiles.length + serialFiles.length === 0) {
  console.error(`No test files matched${filter ? ` filter "${filter}"` : ''}.`);
  process.exit(1);
}

const mode = proveIsolation
  ? `prove-isolation: all ${parallelFiles.length} parallel-lane file(s) at once`
  : `parallel lane: ${parallelFiles.length} file(s) @ jobs ${runConcurrency}, serial lane: ${serialFiles.length} file(s) @ 1 (lanes run at the same time; the serial lane never runs two files at once)`;
console.log(`Running ${parallelFiles.length + serialFiles.length} test file(s)${filter ? ` (filter: "${filter}")` : ''} — ${mode}.\n`);

const budget = makeBudget(maxWallMs);
const t0 = Date.now();
const [parallelRun, serialRun] = await Promise.all([
  runFiles(parallelFiles, runConcurrency, budget),
  runFiles(serialFiles, 1, budget),
]);
const wallMs = Date.now() - t0;

const finished = [...parallelRun.finished, ...serialRun.finished].sort((a, b) => a.file.localeCompare(b.file));
const neverStarted = [...parallelRun.neverStarted, ...serialRun.neverStarted].sort();

// Per-file report, grouped per file: one block per file, captured output shown
// only for failures (passes are verified by exit code; use the file's own run
// to see its full output).
let passed = 0;
const failedFiles = [];
for (const r of finished) {
  if (r.killed) {
    console.error(`  ⏱ ${r.file} — cut short at the wall-clock budget (${r.duration}ms)`);
    continue;
  }
  if (r.code === 0) {
    passed++;
    console.log(`  ✓ ${r.file} (${r.duration}ms)`);
  } else {
    failedFiles.push(r);
    const how = r.signal ? `signal ${r.signal}` : `exit ${r.code}`;
    console.error(`  ✗ ${r.file} (${r.duration}ms, ${how})`);
    const captured = [r.out, r.err].filter(Boolean).join('\n').trim();
    if (captured) {
      for (const line of captured.split('\n')) console.error(`      | ${line}`);
    }
  }
}

// Three-bucket report — only non-empty when a budget tripped, but the bucket
// counts are stated either way so a partial run can never read as complete.
if (maxWallMs > 0) {
  const finishedPass = finished.filter((r) => !r.killed && r.code === 0);
  const finishedFail = finished.filter((r) => !r.killed && r.code !== 0);
  const cutShort = finished.filter((r) => r.killed);
  console.log(`\nWall-clock budget ${maxWallMs}ms ${budget.exceeded() ? 'EXCEEDED' : 'not exceeded'} (${wallMs}ms used):`);
  console.log(`  finished: ${finishedPass.length} passed, ${finishedFail.length} failed${
    finishedPass.length + finishedFail.length ? ` — ${[...finishedPass, ...finishedFail].map((r) => r.file).join(', ')}` : ' — none'
  }`);
  console.log(`  cut short: ${cutShort.length}${cutShort.length ? ` — ${cutShort.map((r) => r.file).join(', ')}` : ''}`);
  console.log(`  never started: ${neverStarted.length}${neverStarted.length ? ` — ${neverStarted.join(', ')}` : ''}`);
}

// Slowest-first timing report.
const slowest = [...finished].sort((a, b) => b.duration - a.duration).slice(0, 20);
if (slowest.length) {
  console.log('\nSlowest test files (top 20):');
  for (const r of slowest) console.log(`  ${String(r.duration).padStart(7)}ms  ${r.file}`);
}

const ranCount = finished.filter((r) => !r.killed).length;
console.log(`\n${passed}/${ranCount} passed in ${wallMs}ms.`);

const killedCount = finished.filter((r) => r.killed).length;
const problems = [];
if (failedFiles.length) problems.push(`${failedFiles.length} test file(s) failed`);
if (killedCount) problems.push(`${killedCount} test file(s) cut short at the wall-clock budget`);
if (neverStarted.length) problems.push(`${neverStarted.length} test file(s) never started`);
if (problems.length) {
  console.error(`\n${problems.join('; ')}.`);
  process.exit(1);
}