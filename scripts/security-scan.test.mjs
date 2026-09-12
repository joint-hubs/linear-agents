// Tests for scripts/security-scan.mjs — run with: node scripts/security-scan.test.mjs
//
// Proves the FOC-285 scanner contract: a planted secret AND a planted SAST
// pattern exit 1 and are NAMED with file + line; a clean fixture exits 0 with
// an explicit OK; a missing semgrep binary is "NOT SCANNED" + exit 2 (a
// scanner that did not run is never a pass); the JSON report carries
// file/line/rule/severity only — the matched secret value never appears in any
// output (AC4). Fixtures live in temp directories; the real repo tree is
// scanned once as the end-to-end negative case (exit 0 = no committed secrets).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
// trip the preset's rules and make the repo-wide scan permanently red. The
// redaction test asserts the tool output never echoes the assembled value.
const FAKE_AWS_SECRET = "kRz9XqPbWmF4nTcJvHsLdYgEoAuIiBbCcDdEeFf".concat("G");
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

console.log("negative case: clean fixture → exit 0, explicit OK");
{
  const dir = fixtureDir();
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "clean.js"), "export const add = (a, b) => a + b;\n");
    const res = scan(["--root", dir]);
    assert(res.status === 0, `exit 0 on clean fixture (got ${res.status})`);
    assert(res.out.includes("PASS secretlint"), "secretlint PASS row");
    assert(res.out.includes("PASS semgrep"), "semgrep PASS row");
    assert(res.out.includes("0 findings"), "zero-findings stated explicitly");
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
    assert(res.status === 0, `exit 0 — internal schema constants are not external data (got ${res.status})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("end-to-end: the real repo tree scans clean (no committed secrets, no SAST findings)");
{
  // This doubles as the AC3 holdability check in CI: a committed secret or a
  // tainted SQL flow fails the suite. Scoped to the repo the test ships in.
  const res = scan([]);
  assert(res.status === 0, `repo scan exits 0 (got ${res.status})`);
  assert(res.out.includes("2 scanners, 0 findings"), "explicit OK line for the repo");
  assert(res.out.includes("Scope covered:"), "scope statement present (never a silent pass)");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);