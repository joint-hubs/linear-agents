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
//   - FOC-840: a test file that leaves a spawned server alive fails the run,
//     and a clean run reports no orphans
//
// Each case builds its own sandbox: a temp dir with a COPY of the runner (plus
// the spawn helper and its library chain the runner imports), a fixture
// test-lanes.json, and fixture *.test.mjs files. The sandbox node_modules is a
// junction to the real one so the supervisor-lib import chain (ajv) resolves.
// The real repo and the real lane config are never touched.
//
// Marker sources below are built by string concatenation so this file itself —
// a parallel-lane file the real static audit regex-scans — does not contain a
// literal marker.
//
// Run: node scripts/test-run.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { probePid } from "./test-spawn.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_SRC = join(HERE, "test-run.mjs");

// The runner imports scripts/test-spawn.mjs (FOC-840), which imports the
// supervisor-lib tree — every file the runner reaches through a relative
// import must exist next to the copied runner. The list is the transitive
// closure of `./x.mjs` imports read from the real tree: the hand-written list
// went stale when FOC-905 added run-owner.mjs to supervisor-lib.mjs and every
// sandbox died with ERR_MODULE_NOT_FOUND, so a new import in that tree must
// never require a matching edit here again.
function localImportClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(join(HERE, file), "utf8");
    for (const m of src.matchAll(/from\s+["']\.\/([^"']+\.mjs)["']/g)) queue.push(m[1]);
    for (const m of src.matchAll(/import\(\s*["']\.\/([^"']+\.mjs)["']\s*\)/g)) queue.push(m[1]);
  }
  seen.delete(entry);
  return [...seen].sort();
}
const RUNNER_DEPS = localImportClosure("test-run.mjs");

const OK = 'console.log("ok");\n';
const EXIT1 = 'console.error("boom");\nprocess.exit(1);\n';
const SLOW = "setTimeout(() => process.exit(0), 5000);\n";
const MARKER_SERVER = `const srv = ${JSON.parse('"create"') + "Server"}();\n${OK}`;
const MARKER_INERT = `if (false) { const srv = ${JSON.parse('"create"') + "Server"}(); }\n${OK}`;
const MARKER_SEAM = `const env = { ...process.env };\n${"delete"} env.LA_TELEMETRY_DB;\n${OK}`;

// The fake server the FOC-840 fixtures spawn through the real helper — bracket
// access keeps the audit marker for createServer( out of this file's source.
// It lives in fixture strings only; the SANDBOX is not scanned, but this file
// (parallel lane) is.
const FAKE_SERVER_SRC = `import http from "node:http";
http[${JSON.stringify("create" + "Server")}]((req, res) => { res.statusCode = 200; res.end("ok"); })
  .listen(Number(process.env.TELEMETRY_PORT), "127.0.0.1");
`;

// Imports the helper by absolute URL from the real scripts dir — the sandbox
// runner has its own copy, but the fake test file may use either. Absolute
// path imports in ESM must be file:// URLs (a bare Windows C:\... path throws
// ERR_UNSUPPORTED_ESM_URL_SCHEME).
const FAKE_FILE_PREAMBLE = `import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnTestServer } from ${JSON.stringify(pathToFileURL(join(HERE, "test-spawn.mjs")).href)};

const dir = mkdtempSync(join(tmpdir(), "test-run-orphan-fixture-"));
const serverPath = join(dir, "server.mjs");
writeFileSync(serverPath, ${JSON.stringify(FAKE_SERVER_SRC)}, "utf8");
`;

const ORPHAN_BODY = FAKE_FILE_PREAMBLE + `const { child } = await spawnTestServer({ script: serverPath, timeoutMs: 15000 });
console.log("spawned", child.pid);
process.exit(0);
`;

const CLEAN_BODY = FAKE_FILE_PREAMBLE + `const { stop } = await spawnTestServer({ script: serverPath, timeoutMs: 15000 });
await stop();
console.log("ok");
`;

// Settings-seam probes: the runner must pin LA_SETTINGS_FILE to a nonexistent
// per-run temp path (empty settings overlay) unless the caller set it.
const SETTINGS_PIN_PROBE = [
  'import { existsSync } from "node:fs";',
  'const p = process.env.LA_SETTINGS_FILE;',
  'if (!p) { console.error("LA_SETTINGS_FILE not set"); process.exit(1); }',
  'if (existsSync(p)) { console.error("LA_SETTINGS_FILE exists: " + p); process.exit(2); }',
  OK,
].join("\n");
const SETTINGS_CALLER_PROBE = [
  'if (process.env.LA_SETTINGS_FILE !== "caller-pinned-settings.json") {',
  '  console.error("caller LA_SETTINGS_FILE lost: " + process.env.LA_SETTINGS_FILE);',
  '  process.exit(1);',
  '}',
  OK,
].join("\n");

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
  for (const dep of RUNNER_DEPS) copyFileSync(join(HERE, dep), join(scripts, dep));
  // The supervisor-lib import chain pulls ajv from node_modules — junction the
  // real one so module resolution walks from the sandbox and finds it.
  symlinkSync(join(HERE, "..", "node_modules"), join(root, "node_modules"), "junction");
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

// ── orphan sweep (FOC-840) ───────────────────────────────────────────────────

test("a test file that never stops its spawned server fails the run with the sweep", () => {
  const root = sandbox({ parallel: [lane("orphan.test.mjs")], serial: [] }, { "orphan.test.mjs": ORPHAN_BODY });
  const r = run(root);
  if (r.status !== 1) fail(`an orphan-leaving run must exit 1, got ${r.status}:\n${r.stdout}\n${r.stderr}`);
  const line = r.stderr.match(/test orphans left running: .*orphan\.test\.mjs pid (\d+) port (\d+) \(killed\)/);
  if (!line) fail(`no orphan line naming the file, pid and port:\n${r.stderr}`);
  if (!r.stdout.includes("1 test orphan(s) killed")) fail(`the summary does not name the orphan count:\n${r.stdout}`);
  // The sweep must have actually killed the survivor, not just listed it.
  const pid = Number(line[1]);
  if (probePid(pid)) fail(`orphan pid ${pid} is still alive after the run`);
});

test("a clean run reports no orphans and exits 0", () => {
  const root = sandbox({ parallel: [lane("clean.test.mjs")], serial: [] }, { "clean.test.mjs": CLEAN_BODY });
  const r = run(root);
  if (r.status !== 0) fail(`clean run exited ${r.status}:\n${r.stdout}\n${r.stderr}`);
  if (!r.stdout.includes("1/1 passed")) fail(`the file did not pass:\n${r.stdout}`);
  if (r.stdout.includes("orphan") || r.stderr.includes("orphan")) {
    fail("a clean run printed an orphan line:\n" + r.stdout + r.stderr);
  }
});

test("the runner strips the task-ownership seams from every spawned child", () => {
  const PROBE = [
    'if ("LA_TASK_OWNERSHIP_CONFIG" in process.env) {',
    '  console.error("LA_TASK_OWNERSHIP_CONFIG leaked");',
    '  process.exit(1);',
    '}',
    'if ("LA_TASK_OWNER" in process.env) {',
    '  console.error("LA_TASK_OWNER leaked");',
    '  process.exit(1);',
    '}',
    OK,
  ].join("\n");
  const root = sandbox({ parallel: [lane("a.test.mjs")], serial: [] }, { "a.test.mjs": PROBE });
  const poisoned = {
    ...process.env,
    LA_TASK_OWNERSHIP_CONFIG: "/nope",
    LA_TASK_OWNER: "zzz",
  };
  const r = run(root, [], poisoned);
  if (r.status !== 0) fail(`the probe saw a task-ownership seam:\n${r.stderr}`);
});

test("the runner pins LA_SETTINGS_FILE to a nonexistent path for every spawned child", () => {
  const root = sandbox({ parallel: [lane("a.test.mjs")], serial: [] }, { "a.test.mjs": SETTINGS_PIN_PROBE });
  const r = run(root);
  if (r.status !== 0) fail(`the settings pin did not hold:\n${r.stderr || r.stdout}`);
});

test("the runner preserves a caller-provided LA_SETTINGS_FILE", () => {
  const root = sandbox({ parallel: [lane("a.test.mjs")], serial: [] }, { "a.test.mjs": SETTINGS_CALLER_PROBE });
  const caller = { ...process.env, LA_SETTINGS_FILE: "caller-pinned-settings.json" };
  const r = run(root, [], caller);
  if (r.status !== 0) fail(`the caller-provided LA_SETTINGS_FILE was overwritten:\n${r.stderr || r.stdout}`);
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