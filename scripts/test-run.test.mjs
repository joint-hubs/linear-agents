// scripts/test-run.test.mjs — self-contained tests for scripts/test-run.mjs (FOC-614).
//
// The runner is the single owner of test execution: lanes from test-lanes.json,
// a coverage check (every discovered test file in exactly one lane), a static
// isolation audit of the parallel lane, and the wall-clock budget. These tests
// prove the guard rails actually fail:
//   - coverage: a file in zero lanes, a file in both lanes, a stale lane entry
//   - static audit: a synthetic parallel-lane file containing a disqualifying marker
//   - budget: --max-wall-ms stops admitting, kills in-flight, reports buckets
//   - the FOC-295 env scrub still holds for every spawned child
//
// Each case builds its own sandbox: a temp dir with a COPY of the runner, a
// fixture test-lanes.json, and fixture *.test.mjs files. The real repo and the
// real lane config are never touched.
//
// Marker sources below are built by string concatenation so this file itself —
// a parallel-lane file the real static audit regex-scans — does not contain a
// literal marker.
//
// Run: node scripts/test-run.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_SRC = join(HERE, "test-run.mjs");

const OK = 'console.log("ok");\n';
const EXIT1 = 'console.error("boom");\nprocess.exit(1);\n';
const SLOW = "setTimeout(() => process.exit(0), 5000);\n";
const MARKER_SERVER = `const srv = ${JSON.parse('"create"') + "Server"}();\n${OK}`;
const MARKER_INERT = `if (false) { const srv = ${JSON.parse('"create"') + "Server"}(); }\n${OK}`;
const MARKER_SEAM = `const env = { ...process.env };\n${"delete"} env.LA_TELEMETRY_DB;\n${OK}`;

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
const fail = (msg) => { throw new Error(msg); };

// ── sandbox helpers ──────────────────────────────────────────────────────────

const sandboxes = [];

function sandbox(lanes, files) {
  const root = mkdtempSync(join(tmpdir(), "test-run-sandbox-"));
  sandboxes.push(root);
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  copyFileSync(RUNNER_SRC, join(scripts, "test-run.mjs"));
  writeFileSync(join(scripts, "test-lanes.json"), JSON.stringify(lanes, null, 2));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(scripts, name), body);
  return root;
}

const run = (root, extraArgs = [], env = process.env) =>
  spawnSync(process.execPath, [join(root, "scripts", "test-run.mjs"), ...extraArgs], {
    encoding: "utf8",
    env: { ...env },
  });

const lane = (file, reason = "sandbox fixture") => ({ file, reason });

// ── coverage check ───────────────────────────────────────────────────────────

test("coverage check fails on a file in zero lanes", () => {
  const root = sandbox(
    { parallel: [lane("a.test.mjs")], serial: [] },
    { "a.test.mjs": OK, "b.test.mjs": OK },
  );
  const r = run(root);
  if (r.status === 0) fail("the runner accepted a test file listed in zero lanes");
  if (!r.stderr.includes("b.test.mjs")) fail(`the failure does not name the uncovered file:\n${r.stderr}`);
  if (r.stdout.includes("passed")) fail("a failed coverage check must not print a pass summary:\n" + r.stdout);
});

test("coverage check fails on a file listed in both lanes", () => {
  const root = sandbox(
    { parallel: [lane("a.test.mjs")], serial: [lane("a.test.mjs")] },
    { "a.test.mjs": OK },
  );
  const r = run(root);
  if (r.status === 0) fail("the runner accepted a test file listed in two lanes");
  if (!r.stderr.includes("a.test.mjs") || !r.stderr.includes("2 lanes")) {
    fail(`the failure does not name the double-laned file:\n${r.stderr}`);
  }
});

test("coverage check fails on a stale lane entry", () => {
  const root = sandbox(
    { parallel: [lane("a.test.mjs"), lane("ghost.test.mjs")], serial: [] },
    { "a.test.mjs": OK },
  );
  const r = run(root);
  if (r.status === 0) fail("the runner accepted a lane entry naming a nonexistent file");
  if (!r.stderr.includes("ghost.test.mjs")) fail(`the failure does not name the stale entry:\n${r.stderr}`);
});

// ── static isolation audit ───────────────────────────────────────────────────

test("static audit fails on a parallel-lane file containing a server-bind marker", () => {
  const root = sandbox(
    { parallel: [lane("a.test.mjs")], serial: [] },
    { "a.test.mjs": MARKER_SERVER },
  );
  const r = run(root);
  if (r.status === 0) fail("the runner accepted a parallel-lane file that binds a server");
  if (!r.stderr.includes("a.test.mjs") || !r.stderr.includes("createServer")) {
    fail(`the failure does not name the file and the marker:\n${r.stderr}`);
  }
});

test("static audit fails on a parallel-lane file unsetting the live DB seam", () => {
  const root = sandbox(
    { parallel: [lane("a.test.mjs")], serial: [] },
    { "a.test.mjs": MARKER_SEAM },
  );
  const r = run(root);
  if (r.status === 0) fail("the runner accepted a parallel-lane file that unsets the LA_TELEMETRY_DB seam");
  if (!r.stderr.includes("LA_TELEMETRY_DB")) fail(`the failure does not name the seam marker:\n${r.stderr}`);
});

test("the same marker in the serial lane is accepted (audit scopes to the parallel lane)", () => {
  const root = sandbox(
    { parallel: [], serial: [lane("a.test.mjs")] },
    { "a.test.mjs": MARKER_INERT },
  );
  const r = run(root);
  if (r.status !== 0) fail(`serial-lane marker was flagged:\n${r.stderr}`);
  if (!r.stdout.includes("1/1 passed")) fail(`the file did not run:\n${r.stdout}`);
});

// ── execution ────────────────────────────────────────────────────────────────

test("a green run reports N/M passed and exits 0", () => {
  const root = sandbox(
    { parallel: [lane("a.test.mjs"), lane("b.test.mjs")], serial: [lane("c.test.mjs")] },
    { "a.test.mjs": OK, "b.test.mjs": OK, "c.test.mjs": OK },
  );
  const r = run(root);
  if (r.status !== 0) fail(`green run exited ${r.status}:\n${r.stderr}`);
  if (!r.stdout.includes("3/3 passed")) fail(`summary missing:\n${r.stdout}`);
  for (const f of ["a.test.mjs", "b.test.mjs", "c.test.mjs"]) {
    if (!r.stdout.includes(`✓ ${f}`)) fail(`no per-file line for ${f}:\n${r.stdout}`);
  }
});

test("a failing file exits 1 with its captured output under its own block", () => {
  const root = sandbox(
    { parallel: [lane("a.test.mjs")], serial: [] },
    { "a.test.mjs": EXIT1 },
  );
  const r = run(root);
  if (r.status !== 1) fail(`failing run exited ${r.status}`);
  if (!r.stderr.includes("✗ a.test.mjs")) fail(`no failure line:\n${r.stderr}`);
  if (!r.stderr.includes("boom")) fail(`captured output not shown for the failing file:\n${r.stderr}`);
});

test("--max-wall-ms stops admitting, kills in-flight, and reports the buckets", () => {
  const root = sandbox(
    { parallel: [lane("slow1.test.mjs"), lane("slow2.test.mjs")], serial: [] },
    { "slow1.test.mjs": SLOW, "slow2.test.mjs": SLOW },
  );
  const r = run(root, ["--jobs", "1", "--max-wall-ms", "400"]);
  if (r.status === 0) fail("a budget-exceeded run must exit non-zero");
  if (!r.stdout.includes("never started: 1")) fail(`the never-started bucket is wrong:\n${r.stdout}`);
  if (!r.stdout.includes("cut short: 1")) fail(`the cut-short bucket is wrong:\n${r.stdout}`);
  if (!r.stderr.includes("slow1.test.mjs")) fail(`the killed file is not reported:\n${r.stderr}`);
});

test("the runner strips LA_SUPERVISOR* from every spawned child (FOC-295)", () => {
  const PROBE = 'if (Object.keys(process.env).some((k) => k.startsWith("LA_SUPERVISOR"))) process.exit(1);\n' + OK;
  const root = sandbox({ parallel: [lane("a.test.mjs")], serial: [] }, { "a.test.mjs": PROBE });
  const poisoned = {
    ...process.env,
    LA_SUPERVISOR: "1",
    LA_SUPERVISOR_CHILD: "dev-1",
    LA_SUPERVISOR_RUN: "2026-01-01T00-00-00-test",
  };
  const r = run(root, [], poisoned);
  if (r.status !== 0) fail(`the probe saw a LA_SUPERVISOR* variable:\n${r.stderr}`);
});

// ── summary ──────────────────────────────────────────────────────────────────

for (const root of sandboxes) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
}

console.log(`\n${passed}/${passed + failures.length} passed.`);
if (failures.length > 0) {
  console.error(`${failures.length} test(s) failed.`);
  process.exit(1);
}