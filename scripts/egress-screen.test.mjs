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

const { scanEgress, assertEgressClean, egressLeaves, EgressBlockedError, EGRESS_BLOCKED } = await import(
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
// 6. egressLeaves — the ONE shared raw-leaf extractor for the egress
//    checkpoints (decision seam FOC-643, shadow-run live replay FOC-646)
// ---------------------------------------------------------------------------

console.log("egressLeaves: the shared raw-leaf extractor");
{
  // The decision seam's screened leaf set is pinned EXACTLY — labels, values,
  // and order. This is the contract FOC-643 shipped; drift here would change
  // what the seam screens (or blind a family it used to catch).
  const seamLeaves = egressLeaves({
    state: "state prose",
    questions: {
      q0: { type: "noul", instructions: "judge this", criteria: { true: "yes", false: "no" } },
    },
  });
  assert(
    JSON.stringify(seamLeaves) === JSON.stringify([
      ["state", "state prose"],
      ["questions.q0", "q0"],
      ["questions.q0.type", "noul"],
      ["questions.q0.instructions", "judge this"],
      ["questions.q0.criteria.true", "true"],
      ["questions.q0.criteria.true", "yes"],
      ["questions.q0.criteria.false", "false"],
      ["questions.q0.criteria.false", "no"],
    ]),
    "the seam's {state, questions} leaf set is byte-exact (FOC-643, unchanged)",
  );

  assert(
    JSON.stringify(egressLeaves({ text: "dictated text" })) === JSON.stringify([["text", "dictated text"]]),
    "extraction replay shape {text} yields the raw text leaf",
  );
  assert(
    JSON.stringify(egressLeaves({ prompt: "p", features: [{ name: "f1", size: "small" }, { name: "f2" }] })) === JSON.stringify([
      ["prompt", "p"],
      ["features.0.name", "f1"],
      ["features.0.size", "small"],
      ["features.1.name", "f2"],
    ]),
    "refinement replay shape {prompt, features} yields prompt and per-feature leaves",
  );
  assert(egressLeaves({}).length === 0, "an empty input yields no leaves");
}

// ---------------------------------------------------------------------------
// 7. Linear issue-URL slug exemption (FOC-733) — family E only, deliberately
//    narrow: the segment IMMEDIATELY after /issue/<KEY>/ on https://linear.app,
//    and only when it is a COMPLETE path segment (terminated by /, ?, #, end
//    of string or a closing delimiter). Anything else stays screened.
// ---------------------------------------------------------------------------

{
  // The four real flagged strings from docs/research/foc-477-runs.json
  // (egressScreenScan20261008.distinctFlaggedStrings) — issue-TITLE slugs, not
  // secrets; the false positive this exemption exists for.
  const CORPUS = [
    ["FOC-143", "foc-143-r5-red-team-ip-extraction-attempt-on-deployed-protected-stack"],
    ["FOC-143", "foc-143-r6-raise-the-bar-crown-jewel-logic-server-side-key"],
    ["FOC-209", "foc-209-f12-set-document-content-encryption-key-docs-at-rest"],
    ["FOC-209", "foc-209-f8-installer-chmod-600-env-640-realm-json-world-readable"],
  ];
  // Synthetic fake, same shape as the corpus slugs: lowercase + digits + hyphen
  // (3 classes), 39 chars, well over the relaxed threshold. Assembled at
  // runtime per the file convention.
  const FAKE_KEBAB = "nq7z".concat("-x4m2-k9p5-", "r3t8-w1v6-", "y4b2-c9l5-", "d8j3");
  const issueUrl = (i) => `https://linear.app/joint-hubs/issue/${CORPUS[i][0]}/${CORPUS[i][1]}`;

  console.log("linear-slug: the four corpus issue slugs scan clean inside their Linear issue URLs");
  for (let i = 0; i < CORPUS.length; i++) {
    const short = CORPUS[i][1].slice(0, 24);
    assert(scanEgress(`state ${issueUrl(i)}`).length === 0, `corpus slug exempt at end of string (#${i + 1}, ${short}...)`);
    // The corpus states are JSON.stringify'd into ONE line — the raw JSON quote
    // is the closing delimiter that terminated the really-flagged segments.
    assert(scanEgress(`{"url":"${issueUrl(i)}"}`).length === 0, `corpus slug exempt inside a one-line JSON state (#${i + 1}, ${short}...)`);
    assert(scanEgress(`prose ${CORPUS[i][1]} end`).length >= 1, `same corpus slug OUTSIDE a Linear URL is still blocked (#${i + 1}, ${short}...)`);
  }

  console.log("linear-slug: same-shape secret outside any Linear URL is still blocked");
  assert(scanEgress(`rotated ${FAKE_KEBAB} today`).length >= 1, "kebab-shaped synthetic secret in prose is still blocked");

  console.log("linear-slug: a secret in the URL query stays blocked while the slug stays exempt");
  {
    const text = `${issueUrl(0)}?token=${FAKE_ENTROPY}`;
    const hits = scanEgress(text);
    assert(hits.length === 1, "exactly one hit: the query value, not the slug");
    assert(hits[0].family === "high-entropy", "query hit is family E");
    assert(hits[0].column === `${issueUrl(0)}?token=`.length + 1, "hit sits at the query value's position, past the exempted slug");
  }

  console.log("linear-slug: the same path shape on another host is still blocked");
  {
    const slug = CORPUS[0][1];
    assert(scanEgress(`https://evil.example.com/joint-hubs/issue/FOC-143/${slug}`).length >= 1, "non-linear.app host is blocked");
    assert(scanEgress(`https://linear.app.evil.test/joint-hubs/issue/FOC-143/${slug}`).length >= 1, "linear.app SUBDOMAIN lookalike is blocked (host must be exactly linear.app)");
  }

  console.log("linear-slug: per-run scoping and family-E-only reach");
  {
    // A legitimate Linear URL and an unrelated secret in the SAME text: the
    // slug stays exempt, the secret is caught, and nothing else is excused.
    const mixed = `{"url":"${issueUrl(0)}"} rotated with ${FAKE_KEBAB}`;
    const hits = scanEgress(mixed);
    assert(hits.length === 1 && hits[0].family === "high-entropy", "Linear URL in the text does not shield the unrelated secret (1 hit)");
    // A space is NOT a segment terminator: the slug is not a complete path
    // segment there, so the narrow exemption does not apply.
    assert(scanEgress(`${issueUrl(0)} more prose`).length >= 1, "slug followed by whitespace (not a complete-segment terminator) is still blocked");
    // The exemption feeds family E only — family A still fires on a prefixed
    // token even in the exempted segment position.
    const prefixed = scanEgress(`https://linear.app/joint-hubs/issue/FOC-143/${FAKE_SK_OR}`);
    assert(prefixed.some((h) => h.family === "key-prefix"), "key-prefix family still fires in the slug position (exemption is family-E-only)");
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${passed}/${passed + failed} assertions passed.`);
if (failed > 0) process.exit(1);
