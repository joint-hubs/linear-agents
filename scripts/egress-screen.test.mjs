// Tests for scripts/egress-screen.mjs — run with: node scripts/egress-screen.test.mjs
//
// Proves the FOC-450 contract: all five shape families are detected; clean
// texts (including hard negatives: commit SHAs, UUIDs, public certificates,
// data URIs) pass; the typed refusal names the hit by SHAPE and never contains
// the offending value; the screen is offline (fetch stubbed to throw); the
// linear-ops chokepoints block a secret body BEFORE the dry-run echo and any
// network call, while a clean body passes the screen and proceeds (offline, via
// LA_LINEAR_NO_ENV_FILE=1 — graphql then fails on the missing key without
// fetching). The labelled synthetic set is scored with floor assertions so a
// detector regression fails the suite.
//
// Every secret-shaped string below is ASSEMBLED AT RUNTIME from split
// literals (same convention as security-scan.test.mjs): they are fake by
// construction — generated random-shape strings matching published formats,
// authenticating to nothing — and a contiguous literal in THIS file would trip
// the repo-wide secretlint scan.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");
const NODE = process.execPath;

const { scanEgress, assertEgressClean, EgressBlockedError, EGRESS_BLOCKED } = await import(
  pathToFileURL(join(__dirname, "egress-screen.mjs")).href
);
const { SYNTHETIC_SET } = await import(
  pathToFileURL(join(__dirname, "fixtures", "egress-eval-synthetic.mjs")).href
);
const { loadLabelledSets, scoreSet } = await import(
  pathToFileURL(join(__dirname, "egress-eval.mjs")).href
);

// Fake constructions — NOT credentials. Split literals, never contiguous.
const FAKE_SK_OR = "sk-or-".concat("v1-", "0123456789abcdef", "0123456789abcdef", "0123456789abcdef", "0123456789abcdef");
const FAKE_GHP = "ghp_".concat("9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c", "3fXX");
const FAKE_ENV = "FAKE_".concat("TEST_TOKEN", "=Zx9qWm3NbR7", "Kc2Vf8LhT");
const FAKE_JWT = "eyJ".concat("hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "SflKxwRJSMeKKF2QT4fwpMeJ");
const FAKE_ENTROPY = "Nq7Zx4mKp2Wv9RtYb3Cc6Ld8Jf1HgS4T";
const FAKE_PEM = [
  "-----BEGIN ".concat("RSA PRIVATE KEY", "-----"),
  "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/yGwfMRvHwF4XKrJ7tLnRi1GaaQhhh",
  "dQ0Z1vNxO8z2lKUm7SjpU9wYbHCsQfTmAoEeJkXcPvN3gRdLI6Bu==",
  "-----END ".concat("RSA PRIVATE KEY", "-----"),
].join("\n");

// ---------------------------------------------------------------------------
// Test harness (mirrors scripts/security-scan.test.mjs)
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

function spawnOps(args, env = {}) {
  const res = spawnSync(NODE, [join(__dirname, "linear-ops.mjs"), ...args], {
    encoding: "utf-8",
    timeout: 60000,
    // Hermetic by construction: LA_LINEAR_NO_ENV_FILE=1 skips the .env read
    // (FOC-355 seam) and LINEAR_API_KEY="" makes chooseApiKey return falsy, so
    // graphql() throws on the missing key BEFORE its fetch. Blocked cases exit
    // even earlier — the screen fires before the first graphql call.
    env: { ...process.env, LA_LINEAR_NO_ENV_FILE: "1", LINEAR_API_KEY: "", ...env },
  });
  return { status: res.status, out: res.stdout || "", err: res.stderr || "" };
}

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "egress-test-"));
  const file = join(dir, name);
  writeFileSync(file, content, "utf8");
  return { dir, file };
}

// ---------------------------------------------------------------------------
// 1. Unit: every family is detected, by shape, with no value in the shape
// ---------------------------------------------------------------------------

console.log("unit: five shape families detected");
{
  const cases = [
    ["key-prefix", `token ${FAKE_SK_OR} for the run`, "prefix sk-or-"],
    ["pem", FAKE_PEM, "PEM private-key block"],
    ["env-assignment", FAKE_ENV, "FAKE_TEST_TOKEN"],
    ["jwt", `bearer ${FAKE_JWT} expired`, "JWT-shaped token"],
    ["high-entropy", `secret ${FAKE_ENTROPY} rotated`, "high-entropy"],
  ];
  for (const [family, text, shapePart] of cases) {
    const hits = scanEgress(text);
    assert(hits.length >= 1, `${family}: at least one hit`);
    assert(hits.some((h) => h.family === family), `${family}: right family`);
    assert(hits.some((h) => h.shape.includes(shapePart)), `${family}: shape names the form (${shapePart})`);
    const hit = hits.find((h) => h.family === family);
    assert(hit.line >= 1 && hit.column >= 1, `${family}: 1-based line/column reported`);
    assert(!hits.some((h) => h.shape.includes("Zx9qWm3NbR7") || h.shape.includes("Nq7Zx4mK")), `${family}: shape carries no value fragment`);
  }
}

console.log("unit: PEM spans multiple lines and reports its line count");
{
  const hits = scanEgress(FAKE_PEM);
  assert(hits.some((h) => h.family === "pem" && h.shape.includes("4 lines")), "PEM block line count reported (4)");
  const truncated = "paste below\n-----BEGIN ".concat("OPENSSH PRIVATE KEY", "-----\nb3BlbnNzaC1rZXktdjEAAAAABG9vaXAAAAAA");
  const tHits = scanEgress(truncated);
  assert(tHits.some((h) => h.family === "pem" && h.shape.includes("BEGIN without END")), "truncated PEM (BEGIN without END) still caught");
}

console.log("unit: refusal is typed and never carries the value");
{
  const secretText = `see ${FAKE_SK_OR}`;
  try {
    assertEgressClean(secretText, "comment body");
    assert(false, "assertEgressClean throws on a hit");
  } catch (e) {
    assert(e instanceof EgressBlockedError, "EgressBlockedError is the thrown type");
    assert(e.code === EGRESS_BLOCKED, "error.code === EGRESS_BLOCKED");
    assert(e.message.includes("[egress-blocked]"), "message carries the machine token");
    assert(e.message.split("\n").pop().startsWith("Blocked (first hit):"), "LAST stderr line is self-describing (supervisor-verdict surfaces it)");
    assert(!e.message.includes(FAKE_SK_OR.slice(7)), "refusal contains no fragment of the token body");
    assert(!e.message.includes("0123456789abcdef"), "refusal contains no fragment of the token body (2)");
  }
}

console.log("unit: trivial inputs");
{
  assert(scanEgress("").length === 0, "empty text → no hits");
  assert(scanEgress(undefined).length === 0, "undefined text → no hits");
  assert(scanEgress.constructor.name === "Function", "scanEgress is synchronous (not async)");
}

console.log("unit: clean hard negatives all pass");
{
  const clean = SYNTHETIC_SET.filter((e) => e.label === "clean");
  const offenders = clean.filter((e) => scanEgress(e.text).length > 0);
  assert(offenders.length === 0, `all ${clean.length} labelled-clean texts pass (offenders: ${offenders.map((o) => o.id).join(", ") || "none"})`);
}

// ---------------------------------------------------------------------------
// 2. Offline guarantee: fetch stubbed to throw; the scan never reaches for it
// ---------------------------------------------------------------------------

console.log("offline: scan makes no outbound call");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("NETWORK CALL ATTEMPTED DURING SCAN");
  };
  try {
    let scans = 0;
    for (const e of SYNTHETIC_SET) {
      scanEgress(e.text);
      scans++;
    }
    assert(scans === SYNTHETIC_SET.length, `scan completed over ${scans} texts with fetch stubbed to throw`);
  } catch (e) {
    assert(false, `scan attempted an outbound call: ${e.message}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// 3. Labelled evaluation: floors + loader (thresholds fail a detector regression)
// ---------------------------------------------------------------------------

console.log("eval: synthetic floors");
{
  const s = scoreSet(SYNTHETIC_SET);
  assert(s.total >= 50, `labelled set has >= 50 texts (got ${s.total})`);
  assert(s.recall >= 0.95, `synthetic recall >= 0.95 (got ${s.recall.toFixed(3)})`);
  assert(s.precision >= 0.9, `synthetic precision >= 0.9 (got ${s.precision.toFixed(3)})`);
  for (const [family, v] of Object.entries(s.perFamily)) {
    assert(v.labelled > 0, `family ${family} represented in the set (${v.labelled} texts)`);
  }
}

console.log("eval: real-population loader (gitignored, optional by contract)");
{
  const { real, realSource } = loadLabelledSets();
  assert(Array.isArray(real) && real.length === 0, "clean run: real population absent → empty, no error");
  assert(realSource === null, "clean run: real population source null");
  const fakeReal = [
    { id: "real-test-1", label: "secret", family: "key-prefix", text: `posted ${FAKE_GHP} in a comment` },
    { id: "real-test-2", label: "clean", text: "no secrets here, just prose about the run" },
  ];
  const { dir, file } = tmpFile("real.json", JSON.stringify(fakeReal, null, 2));
  try {
    const loaded = loadLabelledSets(); // env not yet set → default path
    assert(loaded.real.length === 0, "default path untouched by the temp file");
    process.env.EGRESS_EVAL_REAL_FILE = file;
    const withReal = loadLabelledSets();
    assert(withReal.real.length === 2, "EGRESS_EVAL_REAL_FILE override loads the labelled file");
    const rs = scoreSet([...loaded.synthetic, ...withReal.real]);
    assert(rs.secrets > SYNTHETIC_SET.filter((e) => e.label === "secret").length, "real entries join the scoring population");
  } finally {
    delete process.env.EGRESS_EVAL_REAL_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. Chokepoint wiring (spawn linear-ops.mjs — hermetic, offline)
// ---------------------------------------------------------------------------

console.log("chokepoint: comment body with a synthetic sk-or- token is BLOCKED");
{
  const r = spawnOps(["comment", "FOC-450", "--body", `retry with ${FAKE_SK_OR} pls`]);
  assert(r.status === 1, "exit 1 (blocked)");
  assert(r.err.includes("[egress-blocked]"), "stderr carries the typed marker");
  assert(r.err.includes("prefix sk-or-"), "refusal names the SHAPE");
  assert(!r.err.includes("0123456789abcdef"), "stderr contains no token-body fragment");
  assert(r.err.trim().split("\n").pop().includes("Blocked (first hit)"), "last stderr line self-describing");
  assert(!r.out.includes("would post"), "dry-run/echo never printed");
}

console.log("chokepoint: comment-replace body-file with a PEM block is BLOCKED");
{
  const { dir, file } = tmpFile("body.md", `the key:\n${FAKE_PEM}\n`);
  try {
    const r = spawnOps(["comment-replace", "FOC-450", "--dedup-tag", "foc-450-test", "--body-file", file]);
    assert(r.status === 1, "exit 1 (blocked)");
    assert(r.err.includes("PEM private-key block"), "refusal names the PEM shape");
    assert(!r.err.includes("MIIEpAIBAAKCAQEA"), "stderr contains no key-body fragment");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("chokepoint: update-description with an env-style credential is BLOCKED");
{
  const r = spawnOps(["update-description", "FOC-450", "--body", `config:\n${FAKE_ENV}\n`]);
  assert(r.status === 1, "exit 1 (blocked)");
  assert(r.err.includes("env-style assignment to secret-bearing name FAKE_TEST_TOKEN"), "refusal names the env NAME (a config name, not a value)");
}

console.log("chokepoint: create-child TITLE with a JWT is BLOCKED");
{
  const r = spawnOps(["create-child", "FOC-450", "--title", `fix ${FAKE_JWT}`, "--body", "clean description"]);
  assert(r.status === 1, "exit 1 (blocked)");
  assert(r.err.includes("JWT-shaped token"), "refusal names the JWT shape");
}

console.log("chokepoint: --dry-run echo is screened too (blocked BEFORE the print)");
{
  const r = spawnOps(["comment", "FOC-450", "--body", `leak ${FAKE_ENV}`, "--dry-run"]);
  assert(r.status === 1, "exit 1 (blocked)");
  assert(!r.out.includes("would post comment"), "the would-be body was never echoed");
  assert(!r.err.includes("Zx9qWm3NbR7"), "neither stream carries the value");
}

console.log("chokepoint: clean body passes the screen (fails later, offline, on the missing key)");
{
  const r = spawnOps(["comment", "FOC-450", "--body", "handoff recorded; tests 85/85 files, next: review"]);
  assert(r.status === 1, "exit 1 (but from the API layer, not the screen)");
  assert(!r.err.includes("[egress-blocked]"), "no egress refusal for clean text");
  assert(r.err.includes("LINEAR_API_KEY not set"), "execution proceeded past the screen (offline key check precedes any fetch)");
}

// ---------------------------------------------------------------------------
// 5. Standalone CLI guard — the local check for text composed outside a
//    chokepoint (PR bodies: the Supervisor runs this before `gh pr create`)
// ---------------------------------------------------------------------------

console.log("cli: egress-screen.mjs check");
{
  const blocked = spawnSync(NODE, [join(__dirname, "egress-screen.mjs"), "check", "--body", `pat ${FAKE_GHP}`], { encoding: "utf-8" });
  assert(blocked.status === 1, "blocked text → exit 1");
  assert(blocked.stderr.includes("prefix ghp_"), "CLI refusal names the shape");

  const clean = spawnSync(NODE, [join(__dirname, "egress-screen.mjs"), "check", "--body", "plain prose with no secrets, promise"], { encoding: "utf-8" });
  assert(clean.status === 0, "clean text → exit 0");
  assert(clean.stdout.includes("OK: no secret-shaped hits"), "clean text prints the OK line");

  const usage = spawnSync(NODE, [join(__dirname, "egress-screen.mjs"), "check"], { encoding: "utf-8" });
  assert(usage.status === 2, "no text source → exit 2 (usage)");
}

// ---------------------------------------------------------------------------
console.log(`\n${passed}/${passed + failed} assertions passed.`);
if (failed > 0) process.exit(1);
