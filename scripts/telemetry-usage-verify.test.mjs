// Contract test for the independent store-vs-transcript usage verifier
// (FOC-381). The verifier re-derives per-message token totals from the raw
// transcripts and compares them against the deduped usage_facts rows; these
// fixtures pin every decision that could silently mask a real problem:
// duplicate lines with zeros, the ingest byte horizon (lines appended after
// the snapshot must NOT count), shared files across runs, the legacy
// message_id IS NULL bucket, path-derived squads, the tolerance boundary,
// byte-exact offsets under CRLF + multi-byte UTF-8, the per-file duplicate
// gate (duplicateMessageRows) and the cross-file overlap it must NOT punish
// (crossFileDuplicates — same message id in lead + subagent transcripts).
//
// Fixtures are minimal SQLite databases holding only the columns the
// verifier reads — never a real store — under mkdtemp temporaries.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verifyUsage } from "./telemetry-usage-verify.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./telemetry-usage-verify.mjs", import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// --- fixture helpers --------------------------------------------------------

const usage = (i, o, cr, cc) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cc });
const msgLine = (id, u) => JSON.stringify({ type: "assistant", message: { id, usage: u } });
const userLine = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });

// Minimal store: only the tables/columns verifyUsage reads. usage_facts has
// the rewritten per-message shape (message_id NOT NULL) plus a legacy slot
// (message_id NULL) for the inflated per-line bucket.
function makeDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, squad TEXT);
    CREATE TABLE transcript_sources (source_path TEXT, run_id TEXT, byte_offset INTEGER);
    CREATE TABLE usage_facts (
      run_id TEXT, usage_id TEXT, source_path TEXT, source_offset INTEGER,
      message_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      agent_key TEXT, model TEXT
    );
  `);
  return db;
}

const addRun = (db, runId, squad) =>
  db.prepare("INSERT INTO runs (run_id, squad) VALUES (?, ?)").run(runId, squad);

const addFact = (db, { run = "r1", path, id = null, u, offset = 0, usageId = "u" }) =>
  db.prepare(
    "INSERT INTO usage_facts (run_id, usage_id, source_path, source_offset, message_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, agent_key, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
  ).run(run, `${usageId}-${Math.random()}`, path, offset, id, u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens);

const addSource = (db, path, byteOffset, run = "r1") =>
  db.prepare("INSERT INTO transcript_sources (source_path, run_id, byte_offset) VALUES (?, ?, ?)").run(path, run, byteOffset);

// Write a transcript under <tmp>/agents/<squad>/projects/x/<name> and return
// its absolute path (source_path in the store is absolute).
function writeTranscript(temp, squad, name, lines, { crlf = false } = {}) {
  const sep = crlf ? "\r\n" : "\n";
  const dir = join(temp, "agents", squad, "projects", "x");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, lines.join(sep) + sep);
  return filePath;
}

// Byte horizon covering the first `n` lines (joined with \n): the store was
// snapshotted exactly there.
const horizonOf = (lines, n) => Buffer.byteLength(lines.slice(0, n).join("\n") + "\n", "utf8");

function closeTo(actual, expected, eps = 1e-9) {
  return Math.abs(actual - expected) < eps;
}

// Scenario one (tests 1, 2, 6 share the shape): two messages over five
// lines, one of them a zeros line — the exact duplicate-line pattern that
// made naive sums over-count ~2-3x.
const fiveLines = [
  msgLine("m1", usage(10, 20, 5, 5)),
  msgLine("m1", usage(0, 0, 0, 0)), // zeros copy — must never be summed
  msgLine("m1", usage(10, 20, 5, 5)), // identical duplicate
  msgLine("m2", usage(100, 200, 1000, 0)),
  msgLine("m2", usage(0, 0, 0, 0)),
];

// --- 1. exact match ---------------------------------------------------------

{
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-1-"));
  try {
    const file = writeTranscript(temp, "alpha", "a.jsonl", fiveLines);
    const dbPath = join(temp, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "alpha");
    addSource(db, file, Buffer.byteLength(fiveLines.join("\n") + "\n", "utf8"));
    addFact(db, { path: file, id: "m1", u: usage(10, 20, 5, 5) });
    addFact(db, { path: file, id: "m2", u: usage(100, 200, 1000, 0) });
    db.close();

    const report = verifyUsage({ dbPath });
    check("t1 pass", report.pass === true, JSON.stringify(report.bySquad));
    check("t1 matched 2", report.messages.matched === 2, `got ${report.messages.matched}`);
    check("t1 mismatched 0", report.messages.mismatched === 0);
    check("t1 no missing", report.messages.missingInStore === 0 && report.messages.missingInScan === 0);
    check("t1 overall diff 0", closeTo(report.overall.diffPct, 0), `got ${report.overall.diffPct}`);
    check("t1 overall tokens", report.overall.storeTokens === 1340 && report.overall.scanTokens === 1340, `store ${report.overall.storeTokens} scan ${report.overall.scanTokens}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- 2. one counter off by one ----------------------------------------------

{
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-2-"));
  try {
    const file = writeTranscript(temp, "alpha", "a.jsonl", fiveLines);
    const dbPath = join(temp, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "alpha");
    addSource(db, file, Buffer.byteLength(fiveLines.join("\n") + "\n", "utf8"));
    addFact(db, { path: file, id: "m1", u: usage(11, 20, 5, 5) }); // off by one
    addFact(db, { path: file, id: "m2", u: usage(100, 200, 1000, 0) });
    db.close();

    const report = verifyUsage({ dbPath });
    check("t2 mismatched 1", report.messages.mismatched === 1, `got ${report.messages.mismatched}`);
    check("t2 pass false", report.pass === false);
    check("t2 example has both tuples", report.mismatchExamples.length === 1 && report.mismatchExamples[0].store.input_tokens === 11 && report.mismatchExamples[0].scan.input_tokens === 10);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- 3. lines past the ingest horizon are ignored ----------------------------

{
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-3-"));
  try {
    // Message B was appended to the transcript AFTER the store snapshot:
    // ingest never saw it, so the store must not be expected to hold it.
    const inScope = [msgLine("mA", usage(10, 20, 5, 5))];
    const appended = msgLine("mB", usage(50, 50, 0, 0));
    const file = writeTranscript(temp, "alpha", "a.jsonl", [inScope[0], appended]);
    const dbPath = join(temp, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "alpha");
    addSource(db, file, Buffer.byteLength(inScope[0] + "\n", "utf8")); // horizon before mB
    addFact(db, { path: file, id: "mA", u: usage(10, 20, 5, 5) });
    db.close();

    const report = verifyUsage({ dbPath });
    check("t3 appended message not missingInStore", report.messages.missingInStore === 0, `got ${report.messages.missingInStore}`);
    check("t3 matched 1", report.messages.matched === 1);
    check("t3 scan sees only in-horizon message", report.messages.scan === 1, `got ${report.messages.scan}`);
    check("t3 pass", report.pass === true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- 4. in-horizon message absent from the store ------------------------------

{
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-4-"));
  try {
    const lines = [msgLine("mA", usage(10, 20, 5, 5)), msgLine("mB", usage(50, 50, 0, 0))];
    const file = writeTranscript(temp, "alpha", "a.jsonl", lines);
    const dbPath = join(temp, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "alpha");
    addSource(db, file, Buffer.byteLength(lines.join("\n") + "\n", "utf8"));
    addFact(db, { path: file, id: "mA", u: usage(10, 20, 5, 5) }); // mB never ingested
    db.close();

    const report = verifyUsage({ dbPath });
    check("t4 missingInStore 1", report.messages.missingInStore === 1, `got ${report.messages.missingInStore}`);
    check("t4 pass false", report.pass === false);
    check("t4 diff shows the gap", closeTo(report.overall.diffPct, (40 - 140) / 140), `got ${report.overall.diffPct}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- 5. two runs sharing one file --------------------------------------------

{
  // a) identical rows in both runs: the message must count ONCE in the squad
  //    totals (one row per message per run is the contract) and no
  //    disagreement may be reported.
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-5a-"));
  try {
    const lines = [msgLine("m1", usage(30, 40, 0, 0))];
    const file = writeTranscript(temp, "alpha", "a.jsonl", lines);
    const dbPath = join(temp, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "alpha");
    addRun(db, "r2", "alpha");
    addSource(db, file, Buffer.byteLength(lines[0] + "\n", "utf8"), "r1");
    addSource(db, file, Buffer.byteLength(lines[0] + "\n", "utf8"), "r2");
    addFact(db, { run: "r1", path: file, id: "m1", u: usage(30, 40, 0, 0) });
    addFact(db, { run: "r2", path: file, id: "m1", u: usage(30, 40, 0, 0) });
    db.close();

    const report = verifyUsage({ dbPath });
    check("t5a no double counting", report.overall.storeTokens === 70, `got ${report.overall.storeTokens}`);
    check("t5a no disagreement", report.messages.runDisagreements === 0, `got ${report.messages.runDisagreements}`);
    check("t5a matched 1", report.messages.matched === 1);
    check("t5a pass", report.pass === true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  // b) runs disagree on the same message: counted as run_disagreement, MAX
  //    wins for the comparison, so a scan matching the larger run matches.
  const temp2 = mkdtempSync(join(tmpdir(), "usage-verify-5b-"));
  try {
    const lines = [msgLine("m1", usage(35, 40, 0, 0))];
    const file = writeTranscript(temp2, "alpha", "a.jsonl", lines);
    const dbPath = join(temp2, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "alpha");
    addRun(db, "r2", "alpha");
    addSource(db, file, Buffer.byteLength(lines[0] + "\n", "utf8"), "r1");
    addSource(db, file, Buffer.byteLength(lines[0] + "\n", "utf8"), "r2");
    addFact(db, { run: "r1", path: file, id: "m1", u: usage(30, 40, 0, 0) });
    addFact(db, { run: "r2", path: file, id: "m1", u: usage(35, 40, 0, 0) });
    db.close();

    const report = verifyUsage({ dbPath });
    check("t5b runDisagreements 1", report.messages.runDisagreements === 1, `got ${report.messages.runDisagreements}`);
    check("t5b MAX wins, matched", report.messages.matched === 1 && report.messages.mismatched === 0);
    check("t5b storeTokens use MAX", report.overall.storeTokens === 75, `got ${report.overall.storeTokens}`);
  } finally {
    rmSync(temp2, { recursive: true, force: true });
  }
}

// --- 6. legacy NULL-message rows ----------------------------------------------

{
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-6-"));
  try {
    const file = writeTranscript(temp, "alpha", "a.jsonl", fiveLines);
    const dbPath = join(temp, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "alpha");
    addSource(db, file, Buffer.byteLength(fiveLines.join("\n") + "\n", "utf8"));
    addFact(db, { path: file, id: "m1", u: usage(10, 20, 5, 5) });
    addFact(db, { path: file, id: "m2", u: usage(100, 200, 1000, 0) });
    // Legacy per-line rows: message_id NULL, still inflated, must be
    // reported in `legacy` and excluded from the message comparison.
    addFact(db, { path: file, u: usage(7, 8, 0, 0), usageId: "legacy-1" });
    addFact(db, { path: file, u: usage(7, 8, 0, 0), usageId: "legacy-2" });
    db.close();

    const report = verifyUsage({ dbPath });
    check("t6 legacy rows 2", report.legacy.rows === 2, `got ${report.legacy.rows}`);
    check("t6 legacy tokens 30", report.legacy.tokens === 30, `got ${report.legacy.tokens}`);
    check("t6 legacy bySquad squad alpha", report.legacy.bySquad.length === 1 && report.legacy.bySquad[0].squad === "alpha");
    check("t6 legacy excluded from comparison", report.messages.matched === 2 && report.messages.mismatched === 0);
    check("t6 legacy tokens out of comparison totals", report.overall.storeTokens === 1340, `got ${report.overall.storeTokens}`);
    check("t6 pass unaffected by legacy", report.pass === true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- 7. squad from path + tolerance boundary ----------------------------------

{
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-7-"));
  try {
    // Exactly +1%: one 10000-token scan message, plus a store-only message
    // (missingInScan) worth exactly 100 tokens -> diffPct = 100/10000 = 0.01,
    // which must PASS at tolerance 0.01 (inclusive) with mismatched == 0.
    const bigLine = msgLine("mbig", usage(2500, 2500, 2500, 2500));
    const file = writeTranscript(temp, "beta", "b.jsonl", [bigLine]);
    // A file outside any `agents` segment: squad must fall back to runs.squad.
    const outsideDir = join(temp, "outside");
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, "o.jsonl");
    writeFileSync(outsideFile, msgLine("mo", usage(0, 0, 0, 0)) + "\n");
    const dbPath = join(temp, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "beta");
    addRun(db, "r2", "gamma");
    addSource(db, file, Buffer.byteLength(bigLine + "\n", "utf8"), "r1");
    addSource(db, outsideFile, Buffer.byteLength(msgLine("mo", usage(0, 0, 0, 0)) + "\n", "utf8"), "r2");
    addFact(db, { run: "r1", path: file, id: "mbig", u: usage(2500, 2500, 2500, 2500) });
    addFact(db, { run: "r1", path: file, id: "extra", u: usage(25, 25, 25, 25) }); // +100 tokens, scan-invisible
    addFact(db, { run: "r2", path: outsideFile, id: "mo", u: usage(0, 0, 0, 0) });
    db.close();

    const report = verifyUsage({ dbPath, tolerance: 0.01 });
    const beta = report.bySquad.find((s) => s.squad === "beta");
    const gamma = report.bySquad.find((s) => s.squad === "gamma");
    check("t7 squad derived from path", !!beta, `squads: ${report.bySquad.map((s) => s.squad).join(",")}`);
    check("t7 fallback to runs.squad", !!gamma, `squads: ${report.bySquad.map((s) => s.squad).join(",")}`);
    check("t7 boundary +1% passes", beta && beta.pass === true && Math.abs(beta.diffPct - 0.01) < 1e-12, beta ? `diff ${beta.diffPct}` : "no beta");
    check("t7 mismatched still 0", report.messages.mismatched === 0);
    check("t7 beta tokens", beta && beta.storeTokens === 10100 && beta.scanTokens === 10000, beta ? `${beta.storeTokens}/${beta.scanTokens}` : "no beta");

    // One token more (+1.01%): must fail.
    const dbPath2 = join(temp, "t2.db");
    const db2 = makeDb(dbPath2);
    addRun(db2, "r1", "beta");
    addSource(db2, file, Buffer.byteLength(bigLine + "\n", "utf8"), "r1");
    addFact(db2, { run: "r1", path: file, id: "mbig", u: usage(2500, 2500, 2500, 2500) });
    addFact(db2, { run: "r1", path: file, id: "extra", u: usage(25, 25, 25, 26) }); // +101 tokens
    db2.close();
    const report2 = verifyUsage({ dbPath: dbPath2, tolerance: 0.01 });
    const beta2 = report2.bySquad.find((s) => s.squad === "beta");
    check("t7 just past boundary fails", beta2 && beta2.pass === false && Math.abs(beta2.diffPct - 0.0101) < 1e-12, beta2 ? `diff ${beta2.diffPct}` : "no beta");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- 8. CRLF + multi-byte UTF-8 keep byte offsets exact ------------------------

{
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-8-"));
  try {
    // A multi-byte line sits BETWEEN the two messages. If offsets were
    // computed in characters instead of UTF-8 bytes, m2's start offset would
    // come out too small and slip under a horizon that should exclude it.
    const l1 = msgLine("m1", usage(10, 20, 5, 5));
    const l2 = JSON.stringify({ type: "user", message: { content: "zażółć gęślą jaźń 🦆 — ℮" } });
    const l3 = msgLine("m2", usage(100, 200, 1000, 0));
    const file = writeTranscript(temp, "alpha", "a.jsonl", [l1, l2, l3], { crlf: true });

    // Horizon excludes m2 (covers l1 + l2 incl. their CRLFs).
    const dbPath = join(temp, "t1.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "alpha");
    addSource(db, file, Buffer.byteLength(l1 + "\r\n" + l2 + "\r\n", "utf8"));
    addFact(db, { path: file, id: "m1", u: usage(10, 20, 5, 5) });
    db.close();
    const report = verifyUsage({ dbPath });
    check("t8 m2 past horizon ignored", report.messages.missingInStore === 0, `got ${report.messages.missingInStore}`);
    check("t8 m1 matched under CRLF", report.messages.matched === 1 && report.messages.mismatched === 0);
    check("t8 pass", report.pass === true);

    // Horizon covers everything: both messages must now be found and match.
    const dbPath2 = join(temp, "t2.db");
    const db2 = makeDb(dbPath2);
    addRun(db2, "r1", "alpha");
    addSource(db2, file, Buffer.byteLength(l1 + "\r\n" + l2 + "\r\n" + l3 + "\r\n", "utf8"));
    addFact(db2, { path: file, id: "m1", u: usage(10, 20, 5, 5) });
    addFact(db2, { path: file, id: "m2", u: usage(100, 200, 1000, 0) });
    db2.close();
    const report2 = verifyUsage({ dbPath: dbPath2 });
    check("t8 full horizon matches both", report2.messages.matched === 2 && report2.messages.missingInStore === 0, JSON.stringify(report2.messages));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- 9. CLI exit codes ----------------------------------------------------------

{
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-9-"));
  try {
    const file = writeTranscript(temp, "alpha", "a.jsonl", fiveLines);
    const goodDb = join(temp, "good.db");
    const badDb = join(temp, "bad.db");
    const g = makeDb(goodDb);
    const b = makeDb(badDb);
    for (const [db, m1In] of [[g, 10], [b, 11]]) {
      addRun(db, "r1", "alpha");
      addSource(db, file, Buffer.byteLength(fiveLines.join("\n") + "\n", "utf8"));
      addFact(db, { path: file, id: "m1", u: usage(m1In, 20, 5, 5) });
      addFact(db, { path: file, id: "m2", u: usage(100, 200, 1000, 0) });
    }
    g.close();
    b.close();

    const run = (args) => spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: "utf8" });

    const ok = run(["--db", goodDb]);
    check("t9 exit 0 on pass", ok.status === 0, `status ${ok.status}, stderr: ${ok.stderr}`);
    const okJson = run(["--db", goodDb, "--json"]);
    check("t9 --json parses", okJson.status === 0 && JSON.parse(okJson.stdout).pass === true, `status ${okJson.status}`);
    const bad = run(["--db", badDb]);
    check("t9 exit 1 on fail", bad.status === 1, `status ${bad.status}`);
    const noDb = run([]);
    check("t9 exit 2 without --db", noDb.status === 2, `status ${noDb.status}`);
    const ghost = run(["--db", join(temp, "nope.db")]);
    check("t9 exit 2 on unopenable db", ghost.status === 2, `status ${ghost.status}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- 10. duplicate (run_id, message_id) rows fail pass --------------------------

{
  // Two usage_facts rows for the SAME (run, message) — exactly what an
  // explicit usageId override would produce — still MAX-compare equal, so
  // only the new strict check can catch them.
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-10-"));
  try {
    const file = writeTranscript(temp, "alpha", "a.jsonl", fiveLines);
    const dbPath = join(temp, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "alpha");
    addSource(db, file, Buffer.byteLength(fiveLines.join("\n") + "\n", "utf8"));
    addFact(db, { path: file, id: "m1", u: usage(10, 20, 5, 5) });
    addFact(db, { path: file, id: "m1", u: usage(10, 20, 5, 5), usageId: "dupe" }); // second row, same run+message
    addFact(db, { path: file, id: "m2", u: usage(100, 200, 1000, 0) });
    db.close();

    const report = verifyUsage({ dbPath });
    check("t10 duplicates counted", report.messages.duplicateMessageRows === 1, `got ${report.messages.duplicateMessageRows}`);
    check("t10 example carries the group", report.duplicateExamples.length === 1
      && report.duplicateExamples[0].run_id === "r1"
      && report.duplicateExamples[0].message_id === "m1"
      && report.duplicateExamples[0].rows === 2, JSON.stringify(report.duplicateExamples));
    check("t10 comparison itself still matches", report.messages.matched === 2 && report.messages.mismatched === 0
      && report.messages.missingInStore === 0 && report.messages.missingInScan === 0, JSON.stringify(report.messages));
    check("t10 pass false on duplicates", report.pass === false);
    // Both rows live in ONE file, so the cross-file informational counter
    // must stay silent — the defect here is per-file, not cross-file.
    check("t10 no cross-file overlap", report.crossFileDuplicates.messages === 0, JSON.stringify(report.crossFileDuplicates));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- 11. zero-count gates: a leak inside tolerance still fails -------------------

{
  // (a) A store-only message worth exactly +1%: the squad diff sits INSIDE
  // tolerance (t7 pinned that behaviour) but missingInScan>0 must fail pass.
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-11a-"));
  try {
    const bigLine = msgLine("mbig", usage(2500, 2500, 2500, 2500));
    const file = writeTranscript(temp, "beta", "b.jsonl", [bigLine]);
    const dbPath = join(temp, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "beta");
    addSource(db, file, Buffer.byteLength(bigLine + "\n", "utf8"));
    addFact(db, { path: file, id: "mbig", u: usage(2500, 2500, 2500, 2500) });
    addFact(db, { path: file, id: "extra", u: usage(25, 25, 25, 25) }); // scan-invisible, +1%
    db.close();
    const report = verifyUsage({ dbPath, tolerance: 0.01 });
    check("t11a squad still within tolerance", report.bySquad.every((s) => s.pass) === true, JSON.stringify(report.bySquad));
    check("t11a missingInScan 1", report.messages.missingInScan === 1, `got ${report.messages.missingInScan}`);
    check("t11a pass false despite tolerance", report.pass === false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  // (b) A scan-only message the store never deduped: missingInStore>0 fails
  // even when the token leak is far inside tolerance (a 1-token message
  // against a 4000-token squad sits at -0.025%).
  const temp2 = mkdtempSync(join(tmpdir(), "usage-verify-11b-"));
  try {
    const mA = msgLine("mA", usage(1000, 1000, 1000, 1000));
    const mTiny = msgLine("mTiny", usage(1, 0, 0, 0));
    const file = writeTranscript(temp2, "alpha", "a.jsonl", [mA, mTiny]);
    const dbPath = join(temp2, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "alpha");
    addSource(db, file, Buffer.byteLength(mA + "\n" + mTiny + "\n", "utf8"));
    addFact(db, { path: file, id: "mA", u: usage(1000, 1000, 1000, 1000) }); // mTiny never ingested
    db.close();
    const report = verifyUsage({ dbPath, tolerance: 0.01 });
    check("t11b missingInStore 1", report.messages.missingInStore === 1, `got ${report.messages.missingInStore}`);
    check("t11b squad within tolerance", report.bySquad.every((s) => s.pass) === true, JSON.stringify(report.bySquad));
    check("t11b pass false despite tolerance", report.pass === false);
  } finally {
    rmSync(temp2, { recursive: true, force: true });
  }
}

// --- 12. same message in two files of one run: cross-file duplicate ----------

{
  // The real-data shape behind FOC-381's 36 "duplicate" groups: the lead
  // transcript AND a subagent transcript of the same run log the same
  // OpenRouter gen-... message id, one row in each file. Each file honors the
  // per-file invariant (one row per message per file), so duplicateMessageRows
  // must be 0 and pass must hold; the overlap is informational only.
  const temp = mkdtempSync(join(tmpdir(), "usage-verify-12-"));
  try {
    const linesA = [msgLine("m1", usage(10, 20, 5, 5))];
    const linesB = [msgLine("m1", usage(10, 20, 5, 5))];
    const fileA = writeTranscript(temp, "alpha", "lead.jsonl", linesA);
    const fileB = writeTranscript(temp, "alpha", "sub.jsonl", linesB);
    const dbPath = join(temp, "t.db");
    const db = makeDb(dbPath);
    addRun(db, "r1", "alpha");
    addSource(db, fileA, Buffer.byteLength(linesA[0] + "\n", "utf8"));
    addSource(db, fileB, Buffer.byteLength(linesB[0] + "\n", "utf8"));
    addFact(db, { path: fileA, id: "m1", u: usage(10, 20, 5, 5) });
    addFact(db, { path: fileB, id: "m1", u: usage(10, 20, 5, 5) });
    db.close();

    const report = verifyUsage({ dbPath });
    // tokensOf(usage(10,20,5,5)) = 40: two identical rows -> extra = 40+40-40.
    check("t12 per-file invariant holds", report.messages.duplicateMessageRows === 0, `got ${report.messages.duplicateMessageRows}`);
    check("t12 pass true", report.pass === true, JSON.stringify(report.bySquad));
    check("t12 both files matched", report.messages.matched === 2 && report.messages.mismatched === 0, JSON.stringify(report.messages));
    check("t12 cross-file counted once", report.crossFileDuplicates.messages === 1 && report.crossFileDuplicates.rows === 2, JSON.stringify(report.crossFileDuplicates));
    check("t12 extraTokens is the overlap", report.crossFileDuplicates.extraTokens === 40, `got ${report.crossFileDuplicates.extraTokens}`);
    check("t12 example has both paths", report.crossFileDuplicates.examples.length === 1
      && report.crossFileDuplicates.examples[0].run_id === "r1"
      && report.crossFileDuplicates.examples[0].message_id === "m1"
      && report.crossFileDuplicates.examples[0].paths.length === 2
      && report.crossFileDuplicates.examples[0].paths.includes(fileA)
      && report.crossFileDuplicates.examples[0].paths.includes(fileB)
      && report.crossFileDuplicates.examples[0].rowsTokens.every((t) => t === 40), JSON.stringify(report.crossFileDuplicates.examples));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// --- summary -------------------------------------------------------------------

console.log(`telemetry-usage-verify.test.mjs: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}