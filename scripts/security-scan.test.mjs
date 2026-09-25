// Tests for scripts/security-scan.mjs — run with: node scripts/security-scan.test.mjs
//
// Proves the FOC-285 scanner contract: a planted secret AND a planted SAST
// pattern exit 1 and are NAMED with file + line; the semgrep row is always
// honest — 'ok' only with a parseable scanner version, and a scanner without
// evidence (missing binary, empty stdout, unverifiable version) is an explicit
// "NOT SCANNED" + exit 2, never a pass (FOC-285, FOC-576); the JSON report
// carries file/line/rule/severity only — the matched secret value never
// appears in any output (AC4). Fixtures live in temp directories; the real
// repo tree is scanned once as the end-to-end negative case (secretlint must
// pass; semgrep must be honest about whatever actually ran).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCAN_PATH = join(__dirname, "security-scan.mjs");
const NODE = process.execPath;

// Fake secrets for the positive fixture. These are NOT credentials — they are
// random-shape strings matching the published formats (40-char AWS secret in
// the AWS_ prefix context the rule requires, 36-char GitHub PAT). Built at
// runtime from split literals: a contiguous literal in THIS file would itself
// trip the preset's rules — and the egress screen — and make the repo-wide
// scan permanently red. The
// redaction test asserts the tool output never echoes the assembled value.
const FAKE_AWS_SECRET = "kRz9XqPbWmF4nTcJvHs".concat("LdYgEoAuIiBbCcDdEeFfG");
const FAKE_GITHUB_PAT = "ghp_" + ["9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c", "3fXX"].join("");
const FAKE_AWS_KEY_ID = "AKIA" + ["J7XKQSYQZ4TG", "NB2A"].join("");

// ---------------------------------------------------------------------------
// Test harness (mirrors scripts/lint.test.mjs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

function scan(args, opts = {}) {
  const res = spawnSync(NODE, [SCAN_PATH, ...args], {
    encoding: "utf-8",
    timeout: 120000,
    env: opts.env || process.env,
  });
  return { status: res.status, out: res.stdout || "", err: res.stderr || "" };
}

function fixtureDir() {
  return mkdtempSync(join(tmpdir(), "secscan-test-"));
}

// FOC-576 honesty probes: drive scanSast through a preload stub of the
// semgrep spawnSync calls — no real semgrep needed (SECSCAN_STUB_MODE picks
// the simulated failure). The stub intercepts the native 'semgrep' calls AND
// the LA_SEMGREP_CMD executable named via SECSCAN_STUB_CMD (a configured
// command means the spawned executable is no longer 'semgrep', e.g. 'docker');
// everything else passes through. Intercept keys moved with the FOC-576 step-2
// change: the scan call is recognized by its '--config' flag (native: args[0]
// === 'scan'; configured: the semgrep argv sits behind the launcher's fixed
// args), the version probe by a trailing '--version'. Every intercepted call
// is recorded to SECSCAN_SPAWN_LOG so tests can assert the spawned command
// line. The stub lives OUTSIDE the scanned fixture so it never enters the
// report.
function stubScan(args, mode, extraEnv = {}) {
  const stubDir = fixtureDir();
  const stubFile = join(stubDir, "semgrep-stub.cjs");
  const logFile = join(stubDir, "spawn-log.jsonl");
  writeFileSync(
    stubFile,
    [
      "// Test preload: intercepts semgrep scanner spawnSync calls only; everything else passes through.",
      "const cp = require('node:child_process');",
      "const fs = require('node:fs');",
      "const realSpawnSync = cp.spawnSync;",
      "const STUB_CMD = process.env.SECSCAN_STUB_CMD;",
      "const LOG = process.env.SECSCAN_SPAWN_LOG;",
      "cp.spawnSync = function (cmd, args, opts) {",
      "  const isScanner = cmd === 'semgrep' || (STUB_CMD && cmd === STUB_CMD);",
      "  if (isScanner && LOG) fs.appendFileSync(LOG, JSON.stringify({ cmd, args }) + '\\n');",
      "  if (isScanner && args.includes('--config')) {",
      "    if (process.env.SECSCAN_STUB_MODE === 'empty-stdout') {",
      "      return { status: 2, stdout: '', stderr: 'simulated: launcher blocked', error: undefined };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'version-unknown') {",
      "      return { status: 0, stdout: '{\"results\": [], \"errors\": []}', stderr: '' };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'ok') {",
      "      return { status: 0, stdout: '{\"results\": [], \"errors\": []}', stderr: '' };",
      "    }",
      "  }",
      "  if (isScanner && args[args.length - 1] === '--version') {",
      "    if (process.env.SECSCAN_STUB_MODE === 'version-unknown') {",
      "      return { status: 0, stdout: 'not-a-version-line\\n', stderr: '' };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'ok') {",
      "      return { status: 0, stdout: '1.178.0\\n', stderr: '' };",
      "    }",
      "  }",
      "  return realSpawnSync(cmd, args, opts);",
      "};",
    ].join("\n"),
  );
  try {
    const res = scan(args, {
      env: {
        ...process.env,
        SECSCAN_STUB_MODE: mode,
        NODE_OPTIONS: `--require=${stubFile}`,
        SECSCAN_SPAWN_LOG: logFile,
        ...extraEnv,
      },
    });
    let log = [];
    try {
      log = readFileSync(logFile, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch (e) {
      log = [];
    }
    return { ...res, log };
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

console.log("positive case: planted secret + eval → exit 1, rows named, values redacted");
{
  const dir = fixtureDir();
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "app.js"),
      [
        `const c = { AWS_SECRET_ACCESS_KEY: "${FAKE_AWS_SECRET}" };`,
        `const pat = "${FAKE_GITHUB_PAT}";`,
        `const keyId = "${FAKE_AWS_KEY_ID}";`,
        `const out = eval(userInput);`,
      ].join("\n"),
    );
    const res = scan(["--root", dir]);
    assert(res.status === 1, `exit 1 on findings (got ${res.status})`);
    assert(res.out.includes("[secretlint] src/app.js:1 @secretlint/secretlint-rule-aws"), "secretlint names AWS secret at file:line");
    assert(res.out.includes("@secretlint/secretlint-rule-github"), "secretlint catches GitHub PAT");
    assert(res.out.includes("security.eval-usage"), "semgrep catches eval() usage");
    assert(!res.out.includes(FAKE_AWS_SECRET), "redaction: AWS secret value not in stdout");
    assert(!res.out.includes(FAKE_GITHUB_PAT), "redaction: GitHub PAT value not in stdout");
    assert(!res.out.includes(FAKE_AWS_KEY_ID), "redaction: AWS key ID value not in stdout");
    assert(!res.err.includes(FAKE_AWS_SECRET), "redaction: AWS secret value not in stderr");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("negative case: clean fixture → secretlint PASS; semgrep row honest, never a false clean");
{
  const dir = fixtureDir();
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "clean.js"), "export const add = (a, b) => a + b;\n");
    const res = scan(["--root", dir]);
    assert(res.out.includes("PASS secretlint"), "secretlint PASS row");
    assert(res.out.includes("0 findings"), "zero-findings stated explicitly");
    // FOC-576: the semgrep row must be honest — 'ok' is only legal with a
    // parseable version; without a working scanner the row is an explicit
    // not-clean and the process exits 2, never a PASS nothing backs up.
    const semgrepPass = res.out.includes("PASS semgrep");
    const semgrepNotScanned = res.out.includes("NOT SCANNED semgrep");
    assert(semgrepPass || semgrepNotScanned, "semgrep row present and honest");
    assert(!/PASS semgrep \(unknown\)/.test(res.out), "PASS semgrep never carries version unknown");
    if (semgrepPass) {
      assert(res.status === 0, `exit 0 with both scanners PASS (got ${res.status})`);
    } else {
      assert(res.status === 2, `exit 2 when semgrep did not run cleanly (got ${res.status})`);
      assert(res.out.includes("never reported as clean"), "incomplete-evidence statement printed");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("JSON report: structured rows, no matched values");
{
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "leak.js"), `const c = { AWS_SECRET_ACCESS_KEY: "${FAKE_AWS_SECRET}" };\n`);
    const res = scan(["--root", dir, "--json"]);
    assert(res.status === 1, `exit 1 with JSON mode (got ${res.status})`);
    let report = null;
    try {
      report = JSON.parse(res.out);
    } catch (e) {
      report = null;
    }
    assert(report && report.ok === false, "JSON report ok=false");
    assert(report && report.tools.length === 2, "JSON report lists both scanners");
    const sl = report.tools.find((t) => t.tool === "secretlint");
    assert(sl && sl.findingsCount >= 1 && sl.findings[0].line === 1, "JSON finding carries file/line");
    assert(!res.out.includes(FAKE_AWS_SECRET), "redaction: secret value not in JSON report");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("honesty: semgrep missing → NOT SCANNED row, exit 2, never clean");
{
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    // PATH stripped so spawnSync('semgrep') cannot resolve the binary.
    const res = scan(["--root", dir], { env: { ...process.env, PATH: "", PATHEXT: "" } });
    assert(res.status === 2, `exit 2 when semgrep unavailable (got ${res.status})`);
    assert(res.out.includes("NOT SCANNED semgrep"), "NOT SCANNED row names the tool");
    assert(res.out.includes("never reported as clean"), "incomplete-evidence statement printed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("honesty (FOC-576): semgrep empty stdout → error row, exit 2, never clean");
{
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    const res = stubScan(["--root", dir], "empty-stdout");
    assert(res.status === 2, `exit 2 when semgrep produced no output (got ${res.status})`);
    assert(res.out.includes("NOT SCANNED semgrep"), "semgrep row is an explicit not-scanned, not a PASS");
    assert(
      res.out.includes("semgrep produced no output (exit 2) — no scan evidence"),
      "reason names the missing scan evidence",
    );
    assert(!res.out.includes("PASS semgrep"), "no PASS row for a scan that produced nothing");
    assert(res.out.includes("never reported as clean"), "incomplete-evidence statement printed");
    assert(res.out.includes("PASS secretlint"), "secretlint still reports normally");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("honesty (FOC-576): semgrep version unknown → error row, exit 2, never clean");
{
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    const res = stubScan(["--root", dir, "--json"], "version-unknown");
    assert(res.status === 2, `exit 2 when semgrep version is unknown (got ${res.status})`);
    let report = null;
    try {
      report = JSON.parse(res.out);
    } catch (e) {
      report = null;
    }
    assert(report && report.ok === false, "JSON report ok=false");
    assert(report && report.exitCode === 2, "JSON exitCode=2");
    const sg = report && report.tools.find((t) => t.tool === "semgrep");
    assert(sg && sg.status === "error" && !sg.version, "semgrep row status=error with no version claim");
    assert(
      sg && /version could not be determined/.test(sg.reason || ""),
      "reason names the unverifiable scanner version",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("LA_SEMGREP_CMD: configured command is used — executable + fixed args reach the spawn");
{
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    // The stub intercepts the configured executable (SECSCAN_STUB_CMD) and
    // records every intercepted spawn, so the test can assert the exact
    // command line the wrapper built (FOC-576 step 2).
    const res = stubScan(["--root", dir], "ok", {
      LA_SEMGREP_CMD: "semgrep-stub-exe --fixed-a --fixed-b",
      SECSCAN_STUB_CMD: "semgrep-stub-exe",
    });
    assert(res.status === 0, `clean scan via configured command exits 0 (got ${res.status})`);
    assert(res.out.includes("PASS semgrep (1.178.0)"), "version attested from the configured command's --version");
    const scanCall = res.log.find((e) => e.args.includes("--config"));
    assert(scanCall && scanCall.cmd === "semgrep-stub-exe", "spawned executable is the configured one, not native semgrep");
    assert(
      scanCall && scanCall.args[0] === "--fixed-a" && scanCall.args[1] === "--fixed-b" && scanCall.args[2] === "scan",
      "launcher fixed args precede the semgrep argv",
    );
    const cfgIdx = scanCall ? scanCall.args.indexOf("--config") : -1;
    const cfg = cfgIdx >= 0 ? scanCall.args[cfgIdx + 1] : "";
    assert(
      cfg.endsWith("config/security/semgrep-rules.yml") && !cfg.includes("\\") && !/^[A-Za-z]:/.test(cfg) && !cfg.startsWith("/"),
      `config path is root-relative with forward slashes (got ${cfg})`,
    );
    assert(scanCall && scanCall.args[scanCall.args.length - 1] === ".", "scan target is the cwd-relative root ('.')");
    const versionCall = res.log.find((e) => e.args[e.args.length - 1] === "--version");
    assert(
      versionCall && versionCall.cmd === "semgrep-stub-exe" && versionCall.args[0] === "--fixed-a",
      "--version probe runs through the same configured command",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("LA_SEMGREP_CMD: honesty contract holds for the configured command (empty stdout)");
{
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    const res = stubScan(["--root", dir], "empty-stdout", {
      LA_SEMGREP_CMD: "semgrep-stub-exe",
      SECSCAN_STUB_CMD: "semgrep-stub-exe",
    });
    assert(res.status === 2, `exit 2 when the configured command produced no output (got ${res.status})`);
    assert(res.out.includes("NOT SCANNED semgrep"), "configured-command scan without evidence is NOT SCANNED");
    assert(
      res.out.includes("semgrep produced no output (exit 2) — no scan evidence"),
      "reason names the missing scan evidence",
    );
    assert(!res.out.includes("PASS semgrep"), "no PASS row for a scan that produced nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("LA_SEMGREP_CMD: honesty contract holds for the configured command (version unknown)");
{
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    const res = stubScan(["--root", dir, "--json"], "version-unknown", {
      LA_SEMGREP_CMD: "semgrep-stub-exe",
      SECSCAN_STUB_CMD: "semgrep-stub-exe",
    });
    assert(res.status === 2, `exit 2 when the configured command's version is unknown (got ${res.status})`);
    let report = null;
    try {
      report = JSON.parse(res.out);
    } catch (e) {
      report = null;
    }
    const sg = report && report.tools.find((t) => t.tool === "semgrep");
    assert(sg && sg.status === "error" && !sg.version, "configured-command row status=error with no version claim");
    assert(
      sg && /version could not be determined/.test(sg.reason || ""),
      "reason names the unverifiable scanner version",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("LA_SEMGREP_CMD: nonexistent executable → unavailable row, exit 2, no native fallback");
{
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    // No stub: the real spawnSync hits ENOENT for the configured executable.
    const res = scan(["--root", dir], {
      env: { ...process.env, LA_SEMGREP_CMD: "secscan-no-such-exe-does-not-exist" },
    });
    assert(res.status === 2, `exit 2 when the configured executable is missing (got ${res.status})`);
    assert(res.out.includes("NOT SCANNED semgrep"), "unavailable row names the tool");
    assert(
      res.out.includes("secscan-no-such-exe-does-not-exist") && res.out.includes("LA_SEMGREP_CMD"),
      "reason names the configured executable and the env var",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("LA_SEMGREP_CMD: empty/whitespace-only value fails closed — error row, exit 2, never native");
{
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    for (const blank of ["", "   "]) {
      const res = scan(["--root", dir, "--json"], { env: { ...process.env, LA_SEMGREP_CMD: blank } });
      let report = null;
      try {
        report = JSON.parse(res.out);
      } catch (e) {
        report = null;
      }
      const sg = report && report.tools.find((t) => t.tool === "semgrep");
      assert(res.status === 2, `exit 2 for LA_SEMGREP_CMD=${JSON.stringify(blank)} (got ${res.status})`);
      assert(sg && sg.status === "error", `semgrep row status=error for LA_SEMGREP_CMD=${JSON.stringify(blank)}`);
      assert(
        sg && /LA_SEMGREP_CMD/.test(sg.reason || "") && /refusing to fall back/.test(sg.reason || ""),
        `reason names the misconfiguration for LA_SEMGREP_CMD=${JSON.stringify(blank)}`,
      );
      assert(!res.out.includes("PASS semgrep"), "blank value never degrades to a native PASS");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("taint precision: repo-standard schema interpolation is NOT flagged");
{
  const dir = fixtureDir();
  try {
    writeFileSync(
      join(dir, "schema.js"),
      [
        "const RUN_COLUMNS = [['status', 'TEXT']];",
        "for (const [name, type] of RUN_COLUMNS) { db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`); }",
      ].join("\n"),
    );
    const res = scan(["--root", dir]);
    // FOC-576: only a running scanner can prove non-flagging. Whatever semgrep's
    // state, the fixture must never come back FLAGGED, and the row must be
    // honest — a dead semgrep exits 2 as NOT SCANNED, it never reads as clean.
    assert(res.status !== 1, `schema fixture never flagged (exit ${res.status})`);
    assert(!res.out.includes("[semgrep] src/schema.js"), "no SAST finding row names the schema fixture");
    const semgrepPass = res.out.includes("PASS semgrep");
    const semgrepNotScanned = res.out.includes("NOT SCANNED semgrep");
    assert(semgrepPass || semgrepNotScanned, "semgrep row present and honest");
    assert(!/PASS semgrep \(unknown\)/.test(res.out), "PASS semgrep never carries version unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("ruleset precision: REVIEW round-1 probe forms — flagged vs clean split");
{
  // Regression for the two round-1 rule findings: bare exec/execSync with a
  // concatenated/template command must fire (a top-level metavariable-regex on
  // an arm-local metavariable used to disable those arms), and req.* request
  // forms beyond two attribute segments (req.params.*, bracket access) must
  // reach the path.join/path.resolve rule. Clean forms in the same fixtures
  // assert the split — a rule that fires on everything is as broken as one
  // that fires on nothing. Probe code lives in string data here; it only
  // becomes executable in the temp fixture written below.
  const dir = fixtureDir();
  try {
    const execSrc = [
      "const host = 'example.com';",
      "const dir2 = '/tmp';",
      "const cp = require('child_process');",
      'execSync("ping " + host);',
      'exec("ls " + dir2);',
      "execSync(`ping ${host}`);",
      'cp.exec("ls " + dir2);',
      'child_process.execSync("ping " + host);',
      'execSync("ping localhost");', // clean: literal command
    ];
    const pathSrc = [
      "const path = require('path');",
      "const baseDir = '/var/data';",
      "const req = { params: { file: 'a' }, file: 'b' };",
      "const request = { query: { p: 'c' } };",
      "path.join(baseDir, req.params.file);",
      "path.resolve(baseDir, request.query.p);",
      "path.join(baseDir, req['file']);",
      "path.join(baseDir, req.file);", // pre-fix form — regression guard
      "path.resolve(baseDir, req.params.file);",
      "path.join(baseDir, req.file, 'sub');",
      "path.join(baseDir, 'static', 'index.html');", // clean: literal segments
      "path.join(baseDir, userChoice);", // clean: not request-scoped
    ];
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "execprobe.js"), execSrc.join("\n") + "\n");
    writeFileSync(join(dir, "src", "pathprobe.js"), pathSrc.join("\n") + "\n");
    const res = scan(["--root", dir]);
    const ln = (src, prefix) => src.findIndex((l) => l.startsWith(prefix)) + 1;

    assert(res.status === 1, `exit 1 with probe fixture (got ${res.status})`);
    for (const prefix of [
      'execSync("ping " + host)',
      'exec("ls " + dir2)',
      "execSync(`ping ${host}`)",
      "cp.exec(",
      "child_process.execSync(",
    ]) {
      assert(
        res.out.includes(`src/execprobe.js:${ln(execSrc, prefix)} security.child-process-exec-concat`),
        `exec probe fires: ${prefix}`,
      );
    }
    assert(
      !res.out.includes(`src/execprobe.js:${ln(execSrc, 'execSync("ping localhost")')} security.`),
      "clean exec literal does NOT fire",
    );
    for (const prefix of [
      "path.join(baseDir, req.params.file)",
      "path.resolve(baseDir, request.query.p)",
      "path.join(baseDir, req['file'])",
      "path.join(baseDir, req.file)",
      "path.resolve(baseDir, req.params.file)",
      "path.join(baseDir, req.file, 'sub')",
    ]) {
      assert(
        res.out.includes(`src/pathprobe.js:${ln(pathSrc, prefix)} security.path-join-request-data`),
        `path probe fires: ${prefix}`,
      );
    }
    assert(
      !res.out.includes(`src/pathprobe.js:${ln(pathSrc, "path.join(baseDir, 'static'")} security.`),
      "literal path join does NOT fire",
    );
    assert(
      !res.out.includes(`src/pathprobe.js:${ln(pathSrc, "path.join(baseDir, userChoice)")} security.`),
      "non-request variable does NOT fire",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("end-to-end: the real repo tree — secretlint PASS; semgrep row honest, never a false clean");
{
  // This doubles as the AC3 holdability check in CI when semgrep runs: a
  // committed secret or a tainted SQL flow fails the suite. FOC-576: the
  // assertions never demand a clean scan that did not happen — honest
  // statuses (incl. semgrep NOT SCANNED + exit 2) are acceptable outcomes;
  // 'ok' without a running scanner is not.
  const res = scan([]);
  assert(res.out.includes("Scope covered:"), "scope statement present (never a silent pass)");
  assert(res.out.includes("PASS secretlint"), "secretlint ran and found no committed secrets");
  const semgrepPass = res.out.includes("PASS semgrep");
  const semgrepNotScanned = res.out.includes("NOT SCANNED semgrep");
  assert(semgrepPass || semgrepNotScanned, "semgrep row present and honest");
  assert(!/PASS semgrep \(unknown\)/.test(res.out), "PASS semgrep never carries version unknown");
  if (semgrepPass) {
    assert(res.status === 0 && res.out.includes("2 scanners, 0 findings"), `explicit OK for the repo (exit ${res.status})`);
  } else {
    assert(res.status === 2, `exit 2 when semgrep evidence is incomplete (got ${res.status})`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);