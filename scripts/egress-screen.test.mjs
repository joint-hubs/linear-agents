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

const { scanEgress, assertEgressClean, egressLeaves, EgressBlockedError, EGRESS_BLOCKED, egressSpans } = await import(
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

console.log("unit: egressSpans — the same families as [start, end) spans (FOC-958)");
{
  // Same five-family corpus as the scanEgress shape test, asserted as spans:
  // every family produces a span that covers the secret-shaped material, the
  // spans are sorted and merged, and masking them leaves readable prose.
  const cases = [
    ["key-prefix", `token ${FAKE_SK_OR} for the run`],
    ["pem", FAKE_PEM],
    ["env-assignment", FAKE_ENV],
    ["jwt", `bearer ${FAKE_JWT} expired`],
    ["high-entropy", `secret ${FAKE_ENTROPY} rotated`],
  ];
  for (const [family, text] of cases) {
    const spans = egressSpans(text);
    assert(spans.length >= 1, `${family}: at least one span`);
    assert(spans.every(([s, e]) => Number.isInteger(s) && Number.isInteger(e) && e > s), `${family}: well-formed [start, end)`);
    const masked = spans.reverse().reduce((acc, [s, e]) => acc.slice(0, s) + "[REDACTED]" + acc.slice(e), text);
    assert(!masked.includes("[REDACTED][REDACTED]"), `${family}: spans sorted+merged (no double mask)`);
  }
  // Clean hard negatives produce no spans — the exemptions scanEgress honours
  // (public certificates, commit SHAs, UUIDs) are not masked.
  const clean = SYNTHETIC_SET.filter((e) => e.label === "clean");
  const offenders = clean.filter((e) => egressSpans(e.text).length > 0);
  assert(offenders.length === 0, `all ${clean.length} labelled-clean texts are span-free (offenders: ${offenders.map((o) => o.id).join(", ") || "none"})`);
  // Empty / non-string input: the same degenerate contract as scanEgress.
  assert(egressSpans("").length === 0, "empty text → no spans");
  assert(egressSpans(undefined).length === 0, "undefined text → no spans");
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

// The four real flagged strings from docs/research/foc-477-runs.json
// (egressScreenScan20261008.distinctFlaggedStrings) — issue-TITLE slugs, not
// secrets; the false positive this exemption exists for. Shared by blocks 7
// and 8.
const CORPUS = [
  ["FOC-143", "foc-143-r5-red-team-ip-extraction-attempt-on-deployed-protected-stack"],
  ["FOC-143", "foc-143-r6-raise-the-bar-crown-jewel-logic-server-side-key"],
  ["FOC-209", "foc-209-f12-set-document-content-encryption-key-docs-at-rest"],
  ["FOC-209", "foc-209-f8-installer-chmod-600-env-640-realm-json-world-readable"],
];
const issueUrl = (i) => `https://linear.app/joint-hubs/issue/${CORPUS[i][0]}/${CORPUS[i][1]}`;

{
  // Synthetic fake, same shape as the corpus slugs: lowercase + digits + hyphen
  // (3 classes), 39 chars, well over the relaxed threshold. Assembled at
  // runtime per the file convention.
  const FAKE_KEBAB = "nq7z".concat("-x4m2-k9p5-", "r3t8-w1v6-", "y4b2-c9l5-", "d8j3");

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
// 8. Q1-B + Q2-B (Mateusz's decisions, 2026-10-09).
//    Q1-B: `>` terminates the exempt slug segment — the closing delimiter the
//          round-1 declaration already listed and the code lacked.
//    Q2-B: the exemption fires only for a segment shaped like a Linear issue
//          title slug. Everything else in that position falls back to the
//          ordinary family E rules — asserted here AS AN IDENTITY: the slug
//          position must score exactly like the same string in prose.
// ---------------------------------------------------------------------------

{
  // Synthetic secrets, assembled from split literals per the file convention.
  const HEX40 = "a1b2c3d4".concat("e5f60718", "293a4b5c", "6d7e8f90", "a1b2c3d4");
  const DIGITS40 = "01234567".concat("89012345", "67890123", "45678901", "23456789");
  const B64 = "QUJDREVGR0h".concat("JSktMTU5PUFF", "SU1RVVldYWVo");
  const MIXED20 = "aBcDeFgHiJ".concat("kLmNoP0123");

  // A profile-conforming Linear title slug: lowercase kebab, alpha tokens <= 20,
  // alnum-with-digit tokens <= 8. This is the real corpus slug, already pinned
  // above as blocked in prose — so the fixture is known to be live.
  const SLUG = CORPUS[0][1];
  const url = (seg) => `https://linear.app/joint-hubs/issue/FOC-143/${seg}`;
  const prose = (seg) => `rotated ${seg} today`;

  console.log("q1-b: `>` terminates the exempt slug segment (autolink / HTML shape)");
  assert(scanEgress(`<${url(SLUG)}>`).length === 0, "slug closed by `>` is exempt (Q1-B adds the gt terminator)");

  console.log("q2-b: a slug-profile segment is still exempt");
  assert(scanEgress(url(SLUG)).length === 0, "profile-conforming title slug is exempt in the slug position");
  assert(scanEgress(`${url(SLUG)}/`).length === 0, "profile-conforming slug terminated by `/` is exempt");
  assert(scanEgress(`${url(SLUG)}?x=1`).length === 0, "profile-conforming slug terminated by `?` is exempt");

  console.log("q2-b: a non-slug-shaped segment falls back to the ordinary family E rules");
  assert(scanEgress(url(`${SLUG}--x`)).length >= 1, "double hyphen (empty token) is not a slug profile - blocked");
  assert(scanEgress(url(`${SLUG}-`)).length >= 1, "trailing hyphen (empty token) is not a slug profile - blocked");
  assert(scanEgress(url(SLUG.toUpperCase())).length >= 1, "uppercase tokens are not a slug profile - blocked");

  console.log("q2-b: slug position scores exactly like prose (the identity behind 'returns to the ordinary rules')");
  const SECRETS = { "40-char hex": HEX40, "40-char digits": DIGITS40, base64: B64, "20-char mixed": MIXED20 };
  const POSITIONS = {
    "alone in the slug position": (s) => s,
    "appended (<slug>-<secret>)": (s) => `${SLUG}-${s}`,
    "before the slug (<secret>-<slug>)": (s) => `${s}-${SLUG}`,
  };
  const blindSpots = [];
  for (const [shapeName, secret] of Object.entries(SECRETS)) {
    for (const [posName, seg] of Object.entries(POSITIONS)) {
      const segment = seg(secret);
      const inSlug = scanEgress(url(segment)).length;
      const outside = scanEgress(prose(segment)).length;
      assert(inSlug === outside, `${shapeName}, ${posName}: slug position scores exactly like prose (${inSlug} vs ${outside})`);
      if (outside >= 1) {
        assert(inSlug >= 1, `${shapeName}, ${posName}: blocked in the slug position`);
      } else {
        blindSpots.push(`${shapeName}, ${posName}`);
      }
    }
  }

  // The cases the identity does NOT turn into a block: family E cannot see them
  // anywhere, and a slug-position exception cannot invent a signal family E does
  // not have. A pure hex run is skipped by design (HEX_RUN_RE - this repo cites
  // commit SHAs constantly), and 40 decimal digits top out at log2(10) = 3.32
  // bits/char against the 3.9 relaxed threshold. Their composite variants above
  // ARE blocked; only the bare run is invisible.
  console.log("q2-b: family E's documented blind spots are unchanged by the narrowing");
  assert(scanEgress(prose(HEX40)).length === 0, "a pure hex run is not a family E hit anywhere (documented HEX_RUN_RE blind spot)");
  assert(scanEgress(prose(DIGITS40)).length === 0, "a pure digit run is not a family E hit anywhere (entropy below threshold)");
  assert(blindSpots.length === 2, `exactly 2 of the 12 slug-position cases are outside family E's reach (got ${blindSpots.length}: ${blindSpots.join(" | ")})`);
}

// ---------------------------------------------------------------------------
// 8b. FOC-512: terminator class extended — a slug closed by end of line or a
//     trailing `,`, `.`, `:`, `;` (and `)`/`]`, already in the class) is now
//     exempt. Still fail-closed: the full linear.app/<ws>/issue/<KEY>/ prefix
//     must sit on the SAME line's segment, whitespace is still not a
//     terminator, and a non-slug-shaped segment still falls back to family E.
// ---------------------------------------------------------------------------

{
  const SLUG = CORPUS[0][1];
  const url = (seg) => `https://linear.app/joint-hubs/issue/FOC-143/${seg}`;
  // Fake 48-char base62 token on the sk-or- prefix (matches the KEY_PREFIX_RE
  // shape example), assembled from split literals like every fixture here.
  const SK62 = "sk-or-".concat("Zx2Kp9Qw", "Lm4Rt7Ye", "Vb6Nc1Hd", "Gs3Ja5Fk", "Ue8Iy0Oq", "Tg2Wv5Pb");
  // Uppercase/base64-shaped 40-char run — not slug-shaped (SLUG_TOKEN_RE is
  // lowercase-only), so the exemption must not fire.
  const B64SEG = "QlUjD8Rx".concat("Ne2Gm5Zs", "Kw7Pv3Yb", "Tf6Hc1Lq", "Xe9Ao4Md");

  console.log("foc-512: the new terminators close the slug exemption");
  assert(scanEgress(`${url(SLUG)}\n`).length === 0, "slug at end of line (\\n) is exempt");
  assert(scanEgress(`${url(SLUG)}\r\n`).length === 0, "slug at end of line (\\r\\n) is exempt");
  assert(scanEgress(`${url(SLUG)}\nnext prose line here`).length === 0, "slug closed by end of line followed by prose is exempt");
  assert(scanEgress(`see ${url(SLUG)}, then continue`).length === 0, "slug closed by `,` in prose is exempt");
  assert(scanEgress(`see ${url(SLUG)}. more prose`).length === 0, "slug closed by `.` in prose is exempt");
  assert(scanEgress(`(${url(SLUG)}) end of aside`).length === 0, "slug closed by `)` in prose is exempt");
  assert(scanEgress(`${url(SLUG)}:`.concat(" details")).length === 0, "slug closed by `:` is exempt");
  assert(scanEgress(`ticket ${url(SLUG)}; nothing after`).length === 0, "slug closed by `;` is exempt");
  assert(scanEgress(`list [${url(SLUG)}] done`).length === 0, "slug closed by `]` is exempt");

  console.log("foc-512: fail-closed — whitespace still not a terminator, non-slug shapes still blocked");
  {
    // The space after the URL is not a terminator, so the slug itself stays
    // screened and keeps its own family-E hit; the invariant here is that the
    // key-prefix family names the secret by shape on top of that.
    const hits = scanEgress(`${url(SLUG)} ${SK62}`);
    assert(hits.some((h) => h.family === "key-prefix"), "a secret right after the URL (space-separated) is still a key-prefix hit, named by shape");
    // Mirrors the FOC-733 family-E identification: the space closes nothing,
    // so the slug segment itself keeps its own family-E hit — asserted at its
    // exact 1-based position (slug starts right after the trailing `/`).
    assert(hits.some((h) => h.family === "high-entropy" && h.column === url(SLUG).length - SLUG.length + 1), "the slug segment itself is not exempted — it keeps its own family-E hit at the slug's position");
  }
  assert(scanEgress(`${url(B64SEG)} prose`).length >= 1, "an uppercase/base64-shaped slug segment is still blocked");
}

// ---------------------------------------------------------------------------
// 9. Managed spawn-ref exemption (FOC-788, Mateusz 2026-10-15: "tak w
//    komentarzu linear podaj tez nazwe galezi"). Shape-gated on the spawn
//    shape <teamKey>-<n>-<slug>-<hash12>, family-E-only, and deliberately
//    NARROWER than Q2-B's slug gate: the trailing 12-hex attempt hash is what
//    a Linear title slug never has. The interlock with Q2-B is asserted, not
//    assumed — the corpus title slugs stay blocked in bare prose.
// ---------------------------------------------------------------------------

{
  const REF = "foc-788-push-pr-from-dashboard-1a2b3c4d5e6f"; // <team>-<n>-<slug>-<hash12>
  const REF_JOI = "joi-70-gantt-snapshot-cost-breakdown-0f1e2d3c4b5a"; // any team key, not just foc

  console.log("managed-ref: spawn-shaped refs are exempt (the published branch may be named)");
  assert(scanEgress(`- Branch: \`${REF}\``).length === 0, "managed ref in backticks is exempt");
  assert(scanEgress(`pushed ${REF_JOI} to origin`).length === 0, "managed ref for another team key is exempt");
  assert(scanEgress(`${REF}\nHead \`a1b2c3d4e5f6\` · base \`main\``).length === 0, "managed ref beside a hex sha and a short base is exempt");

  console.log("managed-ref: the Q2-B interlock — a Linear TITLE slug has no attempt hash and stays blocked");
  for (let i = 0; i < CORPUS.length; i++) {
    const short = CORPUS[i][1].slice(0, 24);
    assert(scanEgress(`prose ${CORPUS[i][1]} end`).length >= 1, `corpus title slug still blocked in prose (#${i + 1}, ${short}...)`);
  }

  console.log("managed-ref: anything not shaped like the spawn ref falls back to the ordinary rules");
  assert(scanEgress(`prose ${REF.toUpperCase()} end`).length >= 1, "uppercase variant is not the managed shape - blocked");
  assert(scanEgress(`prose foc-788-push-pr-from-dashboard-1a2b3c4d5e6 end`).length >= 1, "11-hex tail is not the managed shape - blocked");
  assert(scanEgress(`prose foc-788-push-pr-from-dashboard-1a2b3c4d5e6f78 end`).length >= 1, "14-hex tail is not the managed shape - blocked");
  assert(scanEgress(`prose foc-788-push-pr-from-dashboard-1a2b3c4d5e6fk end`).length >= 1, "non-hex tail is not the managed shape - blocked");
  assert(scanEgress(`prose ${REF_JOI.toUpperCase()} end`).length >= 1, "the second fixture's uppercase variant is blocked (fixture proven live)");

  console.log("managed-ref: family-E-only reach — the ref shields nothing else");
  {
    const mixed = `${REF} rotated with ${FAKE_ENTROPY}`;
    const hits = scanEgress(mixed);
    assert(hits.length === 1 && hits[0].family === "high-entropy", "managed ref does not shield a neighbouring high-entropy secret (1 hit)");
    const prefixed = scanEgress(`${REF} ${FAKE_SK_OR}`);
    assert(prefixed.some((h) => h.family === "key-prefix"), "key-prefix family still fires beside a managed ref (exemption is family-E-only)");
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${passed}/${passed + failed} assertions passed.`);
if (failed > 0) process.exit(1);
