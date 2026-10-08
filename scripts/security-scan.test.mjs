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
//
// FOC-667 — scanner states and the skip contract. A scanner row is either
// 'ok' (ran, version attested, evidence complete), 'partial' (the scan
// produced findings but the spawn carried a structural block signal —
// exit 127, EACCES/EPERM, policy text on stderr; findings are reported,
// completeness is NOT attested, scanned:false), 'error' (ran but produced
// unusable evidence — empty/non-JSON/non-report-shaped output, hard scan
// errors, unverifiable version) or 'unavailable' (did not run: not
// installed, or blocked by the environment with no findings to show).
// Post-parse, only structural signals count — policy text inside parsed
// stdout is evidence content (semgrep echoes matched source lines) and can
// never block a healthy scan. The suite gates semgrep-dependent assertions on
// EVIDENCE from that case's own output: semgrep actually ran iff its report
// row is a PASS/FAIL row. When it did not run, every semgrep-dependent
// assertion is reported as a named SKIP carrying the reason from the NOT
// SCANNED row — never silently dropped, never counted as passed, never an
// unconditional skip (the WDAC block on this machine is intermittent, so
// gating is per-case, per-run). Skips are counted separately and summarized
// in a machine-readable SECSCAN_STATE line the test runner surfaces; the
// suite exits 0 on skips (they are one honest state, not a failure) and 1
// only on real failures. Honesty-shaped asserts (row present and honest,
// exit-code honesty, "never reported as clean") stay UNCONDITIONAL — they
// must hold in both worlds.

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
let skipped = 0;
let stateReason = null; // first skip reason — feeds the closing SECSCAN_STATE line

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

// FOC-667 skip plumbing: a skip is a named, visible non-execution — never a
// silent drop, never a pass. The reason always comes from the observed NOT
// SCANNED row of the very case being gated.
function skip(label, reason) {
  console.log(`  SKIP: ${label} — ${reason}`);
  if (!stateReason) stateReason = reason;
  skipped++;
}

// Evidence gate (FOC-667): semgrep actually ran iff its report row is a
// PASS/FAIL row. When it did not, the reason is lifted from the observed
// NOT SCANNED row and returned as the skip reason. Gating is per case, from
// that case's own output — never a cached "machine has no scanner" fact, the
// block on this machine is intermittent.
function semgrepBlockReason(out) {
  if (out.includes("PASS semgrep") || out.includes("FAIL semgrep")) return null;
  const line = out.split("\n").find((l) => l.includes("NOT SCANNED semgrep"));
  return line ? line.replace(/^.*NOT SCANNED semgrep — /, "").trim() : "semgrep row missing from output";
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
// the simulated failure; FOC-667 adds 'app-control': an application-control
// policy block — spawn exit 127, empty stdout, policy text on stderr). The
// stub intercepts the native 'semgrep' calls AND
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
      "    if (process.env.SECSCAN_STUB_MODE === 'finding-policy-text') {",
      "      // FOC-667 round 2 regression shape: a REAL finding (exit 0, valid JSON)",
      "      // whose matched source line quotes an application-control policy",
      "      // phrase. The discriminator must keep this 'ok' — parseable scan",
      "      // evidence wins over block classification.",
      "      const finding = { check_id: 'security.eval-usage', path: 'src/evalprobe.js', start: { line: 1 }, extra: { severity: 'WARNING', lines: { line: '// matched line quoting policy text: blocked by application control policy' } } };",
      "      return { status: 0, stdout: JSON.stringify({ results: [finding], errors: [] }), stderr: '', error: undefined };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'block-clean-json') {",
      "      // FOC-667 round 3 (TEST probe a/e): blocked spawn (exit 127 + WDAC",
      "      // policy text on stderr) whose stdout still parses as an EMPTY report —",
      "      // the round-2 discriminator read this as 'ok' with an attested version.",
      "      // Post-parse structural signals must close it: findings empty →",
      "      // 'unavailable', regardless of what the version probe answers.",
      "      return { status: 127, stdout: '{\"results\":[],\"errors\":[]}', stderr: 'Zasady kontroli aplikacji zablokowaly ten plik (simulated WDAC policy block)', error: undefined };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'block-finding-json') {",
      "      // FOC-667 round 3 (TEST probe d): blocked spawn + well-shaped report",
      "      // WITH a finding → 'partial': findings kept, completeness not attested.",
      "      const finding = { check_id: 'security.eval-usage', path: 'src/evalprobe.js', start: { line: 1 }, extra: { severity: 'WARNING', lines: { line: 'const out = eval(userInput);' } } };",
      "      return { status: 127, stdout: JSON.stringify({ results: [finding], errors: [] }), stderr: 'Zasady kontroli aplikacji zablokowaly ten plik (simulated WDAC policy block)', error: undefined };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'shape-array') {",
      "      // FOC-667 round 3 (TEST probe b): valid JSON, wrong shape — an array",
      "      // parsed as {errors: undefined, results: undefined} → fake-clean. Must",
      "      // be a named 'error', never a clean.",
      "      return { status: 0, stdout: '[1,2,3]', stderr: '', error: undefined };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'shape-null') {",
      "      // FOC-667 round 3 (TEST probe c): JSON.parse('null') returns null —",
      "      // dereferencing it crashed with an uncaught TypeError. Must be a named",
      "      // 'error', never a crash.",
      "      return { status: 0, stdout: 'null', stderr: '', error: undefined };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'shape-truncated') {",
      "      // FOC-667 round 3: truncated JSON → non-JSON branch, named reason.",
      "      return { status: 0, stdout: '{\"results\":', stderr: '', error: undefined };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'policy-in-stdout-clean-json') {",
      "      // FOC-667 round 3 discriminator boundary: policy phrase inside the",
      "      // parsed stdout (semgrep metadata/matched lines) with a healthy spawn",
      "      // (exit 0, clean stderr) — evidence content, never a block signal.",
      "      return { status: 0, stdout: '{\"results\":[],\"errors\":[],\"searched_files\":{\"status\":\"ok\",\"message\":\"policy text embedded in scanner output: blocked by application control policy\"}}', stderr: '', error: undefined };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'app-control') {",
      "      return { status: 127, stdout: '', stderr: 'Zasady kontroli aplikacji zablokowaly ten plik (simulated WDAC policy block)', error: undefined };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'version-unknown') {",
      "      return { status: 0, stdout: '{\"results\": [], \"errors\": []}', stderr: '' };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'ok') {",
      "      return { status: 0, stdout: '{\"results\": [], \"errors\": []}', stderr: '' };",
      "    }",
      "  }",
      "  if (isScanner && args[args.length - 1] === '--version') {",
      "    if (process.env.SECSCAN_STUB_MODE === 'block-clean-json' || process.env.SECSCAN_STUB_MODE === 'block-finding-json' || process.env.SECSCAN_STUB_MODE === 'policy-in-stdout-clean-json' || process.env.SECSCAN_STUB_MODE === 'shape-array' || process.env.SECSCAN_STUB_MODE === 'shape-null' || process.env.SECSCAN_STUB_MODE === 'shape-truncated') {",
      "      return { status: 0, stdout: '1.178.0\\n', stderr: '' };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'finding-policy-text') {",
      "      return { status: 0, stdout: '1.178.0\\n', stderr: '' };",
      "    }",
      "    if (process.env.SECSCAN_STUB_MODE === 'app-control') {",
      "      return { status: 127, stdout: '', stderr: 'Zasady kontroli aplikacji zablokowaly ten plik', error: undefined };",
      "    }",
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
    const childEnv = {
      ...process.env,
      SECSCAN_STUB_MODE: mode,
      NODE_OPTIONS: `--require=${stubFile}`,
      SECSCAN_SPAWN_LOG: logFile,
      // FOC-667: the stub cases exercise the native semgrep path unless they
      // explicitly configure a command via extraEnv — pin the var unset so an
      // outer LA_SEMGREP_CMD (e.g. a forced-unavailable verification run)
      // cannot reroute the spawn the stub is supposed to intercept.
      LA_SEMGREP_CMD: undefined,
      ...extraEnv,
    };
    for (const k of Object.keys(childEnv)) {
      if (childEnv[k] === undefined) delete childEnv[k];
    }
    const res = scan(args, { env: childEnv });
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
    // Exit 1 already holds when secretlint findings exist (loudest fact wins),
    // so it is unconditional; only the SAST detection itself needs a running
    // scanner (FOC-667).
    assert(res.status === 1, `exit 1 on findings (got ${res.status})`);
    assert(res.out.includes("[secretlint] src/app.js:1 @secretlint/secretlint-rule-aws"), "secretlint names AWS secret at file:line");
    assert(res.out.includes("@secretlint/secretlint-rule-github"), "secretlint catches GitHub PAT");
    const evalGate = semgrepBlockReason(res.out);
    if (evalGate === null) {
      assert(res.out.includes("security.eval-usage"), "semgrep catches eval() usage");
    } else {
      skip("semgrep catches eval() usage", evalGate);
    }
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

console.log("honesty (FOC-667): application-control block → unavailable row with environment reason, exit 2");
{
  // Deterministic: the stub simulates WDAC killing the pysemgrep launcher —
  // spawn exit 127, empty stdout, application-control policy text on stderr —
  // so the classification is proven without relying on the machine's
  // intermittent real block. The row must be 'unavailable' with a reason that
  // names the environment (checked BEFORE the generic empty-stdout branch),
  // the JSON row must carry scanned=false with no version claim, and
  // secretlint must be unaffected.
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    // Human rows come from a plain run (--json suppresses humanReport); the
    // JSON rows from a second --json run of the same simulated block.
    const human = stubScan(["--root", dir], "app-control");
    assert(human.status === 2, `exit 2 when the scanner is blocked by application control (got ${human.status})`);
    assert(
      human.out.includes("NOT SCANNED semgrep — scanner unavailable — environment (blocked by application control)"),
      "human row names the environment block",
    );
    assert(human.out.includes("never reported as clean"), "incomplete-evidence statement printed");
    assert(human.out.includes("PASS secretlint"), "secretlint still reports normally");
    assert(!human.out.includes("PASS semgrep"), "no PASS row for a blocked scanner");
    const res = stubScan(["--root", dir, "--json"], "app-control");
    let report = null;
    try {
      report = JSON.parse(res.out);
    } catch (e) {
      report = null;
    }
    const sg = report && report.tools.find((t) => t.tool === "semgrep");
    assert(sg && sg.status === "unavailable", "blocked scanner row status=unavailable, not error");
    assert(sg && sg.scanned === false, "blocked scanner JSON row carries scanned=false");
    assert(sg && !sg.version, "blocked scanner row makes no version claim");
    assert(
      sg && /application control/i.test(sg.reason || "") && !/produced no output/.test(sg.reason || ""),
      "reason names the environment block, not the generic no-output text",
    );
    const sl = report && report.tools.find((t) => t.tool === "secretlint");
    assert(sl && sl.status === "ok" && sl.scanned === true, "secretlint row unaffected, scanned=true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("honesty (FOC-667): policy text in matched source lines cannot swallow a real finding");
{
  // Regression (TEST round 2): the block classifier once tested the WHOLE
  // scanner output, and semgrep's JSON echoes matched source lines — a real
  // finding whose line quotes a policy phrase came back 'unavailable' and the
  // finding vanished behind an environmental excuse. Discriminator: parseable
  // scan evidence wins — the block classification is reachable only when the
  // spawn produced no parseable JSON.
  const dir = fixtureDir();
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "evalprobe.js"),
      "// matched line quoting policy text: blocked by application control policy\nconst out = eval(userInput);\n",
    );
    const res = stubScan(["--root", dir, "--json"], "finding-policy-text");
    assert(res.status === 1, `exit 1 with the real finding (got ${res.status})`);
    let report = null;
    try {
      report = JSON.parse(res.out);
    } catch (e) {
      report = null;
    }
    const sg = report && report.tools.find((t) => t.tool === "semgrep");
    assert(sg && sg.status === "ok", "finding row status=ok — the scanner ran");
    assert(sg && sg.scanned === true, "finding row scanned=true");
    assert(sg && sg.version === "1.178.0", "version attested");
    assert(sg && sg.findingsCount === 1, "findingsCount 1");
    assert(
      sg && sg.findings[0] && sg.findings[0].file === "src/evalprobe.js" && sg.findings[0].line === 1 && sg.findings[0].rule === "security.eval-usage",
      "finding named with file:line + rule",
    );
    assert(!/blocked by application control/i.test(res.out), "no policy-block reason anywhere in the JSON report");
    assert(!/produced no output/.test(res.out), "no generic no-output reason — a clean ok, not an accident");
    // Human rows come from a plain run (--json suppresses humanReport).
    const human = stubScan(["--root", dir], "finding-policy-text");
    assert(human.status === 1, `human run exits 1 (got ${human.status})`);
    assert(human.out.includes("FAIL semgrep"), "human row FAIL semgrep");
    assert(!human.out.includes("NOT SCANNED semgrep"), "no NOT SCANNED semgrep row");
    assert(!/blocked by application control/i.test(human.out), "no policy-block reason in human output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("honesty (FOC-667 round 3): blocked spawn with parseable EMPTY report cannot read as clean");
{
  // TEST's headline fail-open probe at 8db87df: spawn blocked (exit 127 +
  // WDAC policy text on stderr) but stdout parsed as {"results":[],"errors":[]}
  // → the round-2 discriminator returned 'ok' with an attested version. The
  // post-parse structural check closes it: findings empty → 'unavailable',
  // scanned:false, exit 2 — and the healthy --version probe never attests a
  // scan that never ran (the row carries no version).
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    const human = stubScan(["--root", dir], "block-clean-json");
    assert(human.status === 2, `exit 2 when a blocked spawn produced no findings (got ${human.status})`);
    assert(
      human.out.includes("NOT SCANNED semgrep — scanner unavailable — environment (blocked by application control)"),
      "human row names the environment block",
    );
    assert(human.out.includes("never reported as clean"), "incomplete-evidence statement printed");
    assert(!human.out.includes("PASS semgrep"), "no PASS row for a blocked spawn");
    const res = stubScan(["--root", dir, "--json"], "block-clean-json");
    assert(res.status === 2, `JSON run exits 2 (got ${res.status})`);
    let report = null;
    try {
      report = JSON.parse(res.out);
    } catch (e) {
      report = null;
    }
    const sg = report && report.tools.find((t) => t.tool === "semgrep");
    assert(sg && sg.status === "unavailable", "blocked clean-JSON row status=unavailable");
    assert(sg && sg.scanned === false, "scanned=false — a scan that did not run is never scanned");
    assert(sg && sg.findingsCount === 0, "findingsCount 0");
    assert(sg && !sg.version, "healthy --version probe does not attest a scan that never ran");
    assert(sg && /application control/i.test(sg.reason || ""), "reason names the environment block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("honesty (FOC-667 round 3): blocked spawn with findings → PARTIAL, findings kept, never clean");
{
  // TEST probe d: the scan demonstrably started and produced a finding, but
  // the spawn carried a structural block signal — evidence completeness is
  // NOT attested. The finding is reported row by row under an unmistakable
  // PARTIAL label; scanned stays false; exit 1 via the loudest-fact rule.
  const dir = fixtureDir();
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "evalprobe.js"), "const out = eval(userInput);\n");
    const human = stubScan(["--root", dir], "block-finding-json");
    assert(human.status === 1, `exit 1 with partial evidence + findings (got ${human.status})`);
    assert(
      human.out.includes("PARTIAL semgrep (1.178.0) — 1 finding(s) reported, scan did not complete cleanly"),
      "human PARTIAL row names the incomplete scan",
    );
    assert(human.out.includes("[semgrep] src/evalprobe.js:1 security.eval-usage"), "finding printed with file:line + rule");
    assert(human.out.includes("partial scan evidence is never a clean verdict"), "partial verdict statement printed");
    assert(!human.out.includes("NOT SCANNED semgrep"), "findings are not swallowed into NOT SCANNED");
    assert(!human.out.includes("PASS semgrep"), "partial evidence never reads as a PASS");
    const res = stubScan(["--root", dir, "--json"], "block-finding-json");
    assert(res.status === 1, `JSON run exits 1 — loudest fact (got ${res.status})`);
    let report = null;
    try {
      report = JSON.parse(res.out);
    } catch (e) {
      report = null;
    }
    const sg = report && report.tools.find((t) => t.tool === "semgrep");
    assert(sg && sg.status === "partial", "row status=partial");
    assert(sg && sg.scanned === false, "scanned=false — completeness not attested");
    assert(sg && sg.version === "1.178.0", "version carried when attested");
    assert(
      sg && sg.findingsCount === 1 && sg.findings[0].file === "src/evalprobe.js" && sg.findings[0].line === 1 && sg.findings[0].rule === "security.eval-usage",
      "findings array populated with the named row",
    );
    assert(sg && /block signal/.test(sg.reason || ""), "reason names the block signal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("honesty (FOC-667 round 3): JSON that is not report-shaped is a named error, never a crash, never a clean");
{
  // TEST probes b and c: '[1,2,3]' parsed as {errors: undefined,
  // results: undefined} → fake-clean 'ok'; 'null' crashed with an uncaught
  // TypeError. Both must be a named 'error' with exit 2. Truncated JSON stays
  // on the named non-JSON branch.
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    for (const s of [["shape-array", "array"], ["shape-null", "null"]]) {
      const [mode, label] = s;
      const res = stubScan(["--root", dir, "--json"], mode);
      assert(res.status === 2, `exit 2 for ${label} stdout (got ${res.status})`);
      let report = null;
      try {
        report = JSON.parse(res.out);
      } catch (e) {
        report = null;
      }
      const sg = report && report.tools.find((t) => t.tool === "semgrep");
      assert(sg && sg.status === "error", `${label} row status=error`);
      assert(sg && /report-shaped object/.test(sg.reason || ""), `${label} reason names the wrong shape`);
      assert(!/TypeError/.test(res.err), `no crash stack for ${label}`);
      assert(!res.out.includes("PASS semgrep"), `${label} never reads as clean`);
    }
    const trunc = stubScan(["--root", dir, "--json"], "shape-truncated");
    assert(trunc.status === 2, `exit 2 for truncated JSON (got ${trunc.status})`);
    let truncReport = null;
    try {
      truncReport = JSON.parse(trunc.out);
    } catch (e) {
      truncReport = null;
    }
    const tsg = truncReport && truncReport.tools.find((t) => t.tool === "semgrep");
    assert(tsg && tsg.status === "error", "truncated JSON row status=error");
    assert(
      tsg && /output was not JSON/.test(tsg.reason || ""),
      "truncated JSON keeps the named non-JSON reason",
    );
    assert(!/TypeError/.test(trunc.err), "no crash stack for truncated JSON");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("honesty (FOC-667 round 3): policy text inside parsed stdout is evidence content, not a block signal");
{
  // Discriminator boundary, pinned in the fail-closed-safe direction: the
  // JSON CONTENT may quote a policy phrase while the spawn itself is healthy
  // (exit 0, clean stderr). Only structural signals count post-parse — this
  // stays 'ok' with an attested version.
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "clean.js"), "const x = 1;\n");
    const res = stubScan(["--root", dir, "--json"], "policy-in-stdout-clean-json");
    assert(res.status === 0, `exit 0 with healthy spawn, zero findings (got ${res.status})`);
    let report = null;
    try {
      report = JSON.parse(res.out);
    } catch (e) {
      report = null;
    }
    const sg = report && report.tools.find((t) => t.tool === "semgrep");
    assert(sg && sg.status === "ok" && sg.scanned === true, "policy phrase in stdout content never blocks a healthy scan");
    assert(sg && sg.version === "1.178.0", "version attested");
    assert(!/blocked by application control/i.test(res.out), "no block reason anywhere in the report");
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
    // FOC-667: the exit-code honesty assert stays unconditional; the
    // non-flagging row assert is evidence-shaped and skips without a scanner.
    assert(res.status !== 1, `schema fixture never flagged (exit ${res.status})`);
    const taintGate = semgrepBlockReason(res.out);
    if (taintGate === null) {
      assert(!res.out.includes("[semgrep] src/schema.js"), "no SAST finding row names the schema fixture");
    } else {
      skip("no SAST finding row names the schema fixture", taintGate);
    }
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

    // FOC-667: every assert in this block is evidence-shaped — fire splits and
    // no-fire splits alike prove nothing without a running scanner. The gate
    // reads THIS case's own output; when semgrep did not run, each assert
    // becomes a named SKIP and the labels stay identical for the runs where it
    // did.
    const execProbes = [
      'execSync("ping " + host)',
      'exec("ls " + dir2)',
      "execSync(`ping ${host}`)",
      "cp.exec(",
      "child_process.execSync(",
    ];
    const pathProbes = [
      "path.join(baseDir, req.params.file)",
      "path.resolve(baseDir, request.query.p)",
      "path.join(baseDir, req['file'])",
      "path.join(baseDir, req.file)",
      "path.resolve(baseDir, req.params.file)",
      "path.join(baseDir, req.file, 'sub')",
    ];
    const probeGate = semgrepBlockReason(res.out);
    if (probeGate === null) {
      assert(res.status === 1, `exit 1 with probe fixture (got ${res.status})`);
      for (const prefix of execProbes) {
        assert(
          res.out.includes(`src/execprobe.js:${ln(execSrc, prefix)} security.child-process-exec-concat`),
          `exec probe fires: ${prefix}`,
        );
      }
      assert(
        !res.out.includes(`src/execprobe.js:${ln(execSrc, 'execSync("ping localhost")')} security.`),
        "clean exec literal does NOT fire",
      );
      for (const prefix of pathProbes) {
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
    } else {
      skip(`exit 1 with probe fixture (got ${res.status})`, probeGate);
      for (const prefix of execProbes) skip(`exec probe fires: ${prefix}`, probeGate);
      skip("clean exec literal does NOT fire", probeGate);
      for (const prefix of pathProbes) skip(`path probe fires: ${prefix}`, probeGate);
      skip("literal path join does NOT fire", probeGate);
      skip("non-request variable does NOT fire", probeGate);
    }
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

// FOC-667: one machine-readable state line when anything skipped — the test
// runner surfaces it next to the file's pass row so a suite that ran with a
// blocked scanner never reads as an unqualified pass. The reason is the one
// extracted from the observed NOT SCANNED row (first skip).
if (skipped > 0) {
  console.log(`\nSECSCAN_STATE: ${stateReason} — skipped ${skipped} assertion(s)`);
}
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) process.exit(1);