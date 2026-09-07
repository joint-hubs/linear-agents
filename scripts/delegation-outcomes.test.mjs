// Contract test for explicit legacy review outcomes (FOC-218).
//
// The old parser word-sniffed the first 2000 chars: "No 🔴 blocker." counted as a
// blocker, a missing RETURN counted as a pass, unreadable rounds vanished, and a
// round counter fabricated firstPassClean for tasks with no round files. Every
// assertion here is a way that can silently come back: an unanchored verdict, a
// negated blocker firing FAIL, a counter value overriding files, or a
// contradiction swallowed instead of surfaced.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openTelemetryDb } from "./telemetry-store.mjs";
import { parseReview, aggregateOutcomes, computeOutcomes, toCsvValue } from "./delegation-outcomes.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const temp = mkdtempSync(join(tmpdir(), "delegation-outcomes-test-"));
const FENCE = "```";

// --- parseReview: anchored verdict shapes (§5 fixture table) ---------------

// status-pass (JOI-262/263 shape)
let r = parseReview("- **Round:** 1 of 2 · **Status:** 🟢 clean → hand to TEST", "FXT", 1);
check("status-pass is PASS", r.verdict === "PASS", JSON.stringify(r.verdict));
check("status-pass evidence anchors the Status header", r.evidence?.anchor === "status-header" && r.evidence?.lineNo === 1, JSON.stringify(r.evidence));
check("status-pass aggregates firstPassClean true",
  aggregateOutcomes([r], {}).byTask.get("FXT").firstPassClean === true);

// status-fail (FOC-41 shape)
r = parseReview(["- **Round:** 1 of 2 · **Status:** 🔴 blocker → RETURN to DEV", "", "issue: (correctness) This breaks the build"].join("\n"), "FXT", 1);
check("status-fail is FAIL", r.verdict === "FAIL");
check("status-fail legacy returned/blocker true", r.returned === true && r.blocker === true);
check("status-fail counts the issue marker", r.issues === 1, `issues=${r.issues}`);
const fxt = aggregateOutcomes([r], {}).byTask.get("FXT");
check("status-fail counts blockers/returned per task", fxt.blockers === 1 && fxt.returned === 1);

// status-lowsev-fail (JOI-261 shape)
r = parseReview("**Status:** 🟠 low-severity issue → RETURN to DEV", "FXT", 1);
check("status-lowsev-fail is FAIL (🟠 is not PASS)", r.verdict === "FAIL");

// verdict-title-pass (FOC-211 — the named defect: title verdict + body negation)
r = parseReview(["# REVIEW — FXT — round 1 — VERDICT: PASS", "", "No `🔴 blocker`."].join("\n"), "FXT", 1);
check("verdict-title-pass is PASS", r.verdict === "PASS", JSON.stringify(r.unknownReasons));
check("verdict-title-pass evidence is the title line", r.evidence?.lineNo === 1 && r.evidence?.anchor === "verdict-line");
check("verdict-title-pass has no unknown reasons", r.unknownReasons.length === 0);

// verdict-pass-variants (FOC-171, FOC-142-r2, JOI-70, FOC-75, FOC-76 shapes)
const passVariants = [
  "## VERDICT: PASS",
  "- **Verdict:** ✅ **Clean — no actionable issues.**",
  "- **Verdict: APPROVE**",
  "**Verdict:** clean",
  "| **Verdict** | **Clean** — handed to TEST |",
];
for (const [i, text] of passVariants.entries()) {
  const pr = parseReview(text, "FXT", 1);
  check(`verdict-pass-variant ${i + 1} is PASS`, pr.verdict === "PASS", `${pr.verdict} ${JSON.stringify(pr.unknownReasons)}`);
}

// verdict-fail-variants (FEN-30, FOC-73-r1, FOC-77-r1, FOC-147-r1, FOC-91-r1 shapes)
const failVariants = [
  "**Verdict:** 🔴 Changes required — sending back to DEV",
  "**Verdict:** **Send back to DEV** — 1× issue:",
  "**Verdict:** request-changes",
  "| Verdict | **issues(9)** — no 🔴 blocker → sent back to DEV — 4 majors, 6 suggestions |",
  "# Review\n\n" + "x".repeat(2200) + "\n\n**Verdict:** **Findings require changes** — 1 blocking issue:",
];
for (const [i, text] of failVariants.entries()) {
  const pr = parseReview(text, "FXT", 1);
  check(`verdict-fail-variant ${i + 1} is FAIL`, pr.verdict === "FAIL", `${pr.verdict} ${JSON.stringify(pr.unknownReasons)}`);
}
check("verdict-fail-variant 4 (inline negation) still FAIL — FAIL dominates",
  parseReview(failVariants[3], "FXT", 1).verdict === "FAIL");
check("verdict-fail-variant 5 verdict beyond 2000 chars is found",
  parseReview(failVariants[4], "FXT", 1).evidence?.lineNo === 5);

// proposal-fail (FOC-151-r2 shape)
r = parseReview("- **VERDICT PROPOSAL: FAIL** — one platform-conditional blocker", "FXT", 1);
check("proposal-fail is FAIL", r.verdict === "FAIL");

// polish-merge-verdict (JOI-54..67 shape: section + count-zero, beyond 2k)
r = parseReview([
  "# REVIEW — FXT — round 1",
  "",
  "x".repeat(2200),
  "",
  "## Merge & verdict",
  "",
  "**Blokerów (🔴 `issue:`): 0.** Kieruję do TEST.",
].join("\n"), "FXT", 1);
check("polish-merge-verdict is PASS via section + count-zero", r.verdict === "PASS", JSON.stringify(r.unknownReasons));
check("polish-merge-verdict evidence is the count-zero line", r.evidence?.anchor === "verdict-section" && r.evidence?.lineNo === 7);

// polish-blocker-1 (JOI-68-r1 shape)
r = parseReview(["## Merge & verdict", "", "**Bloker 🔴 `issue:`: 1** — kieruję z powrotem do DEV."].join("\n"), "FXT", 1);
check("polish-blocker-1 is FAIL", r.verdict === "FAIL", JSON.stringify(r.unknownReasons));

// negation-families (FOC-173, FOC-78, FOC-73-r2, FOC-91-r2, FOC-151-r1 lines)
const negationFiles = [
  ["## Verdict", "", "- **Verdict: PASS**", "", "Uwagi: …none is a blocker."].join("\n"),
  ["## Verdict", "", "- **Verdict: PASS**", "", "**Blockers:** none"].join("\n"),
  ["## Verdict", "", "- **Verdict: PASS**", "", "Round-1 blocker closed."].join("\n"),
  ["## Verdict", "", "- **Verdict: PASS**", "", "blocker fixed correctly"].join("\n"),
  ["## Verdict", "", "", "0 blockers, 0 majors."].join("\n"),
];
for (const [i, text] of negationFiles.entries()) {
  const pr = parseReview(text, "FXT", 1);
  check(`negation-family ${i + 1} is PASS`, pr.verdict === "PASS", `${pr.verdict} ${JSON.stringify(pr.unknownReasons)}`);
}
check("count-zero alone carries the PASS verdict", parseReview(negationFiles[4], "FXT", 1).evidence?.lineNo === 4);

// negation shapes found in the real corpus that the closed family list missed:
// backtick/paren-wrapped targets (FEN-28, FOC-177-r2), emoji-lead count-zero with
// markdown gap (JOI-68-r2/JOI-70-r1), bare negated emoji (JOI-70-r1 "no 🟠").
const corpusNegationLines = [
  ["- **Verdict: PASS** → hand to TEST. No blocking `issue:` findings.", "PASS"],
  ["**CLEAN.** No `issue:` (blocking) findings. All items are `nitpick:`.", "PASS"],
  ["- **🟠 `issue:`: 0.** (D-Q2b fixed, both verified live.)", "PASS"],
  ["- **Verdict: APPROVE** — clean. All ACs met, no blockers, no 🟠.", "PASS"],
  ["After the fix, please address the two strongest non-blockers:", null],
  ["deep issue(non-blocking)→follow-up suggestion.", null],
  ["…FP-nitpick DoD-claim) + 0 🔴.", null],
];
for (const [i, [line, expected]] of corpusNegationLines.entries()) {
  const pr = parseReview(["## Verdict", "", line].join("\n"), "FXT", 1);
  const got = pr.verdict === "UNKNOWN" ? null : pr.verdict; // any UNKNOWN flavour = "no verdict"
  check(`corpus negation shape ${i + 1} → ${expected ?? "no verdict"}`, got === expected, `${pr.verdict} ${JSON.stringify(pr.unknownReasons)}`);
}

// compound-guard: hyphenated compounds are not verdict words (FOC-151-r4 "fail-closed",
// FOC-147-r1 "pass-all")
const compoundLines = [
  ["VERDICT: APPROVE — both fixes verified; fail-closed semantics hold.", "PASS"],
  ["G2 pass-all holds (identical raw_hash).", null],
];
for (const [i, [line, expected]] of compoundLines.entries()) {
  const pr = parseReview(["## Verdict", "", line].join("\n"), "FXT", 1);
  const got = pr.verdict === "UNKNOWN" ? null : pr.verdict;
  check(`compound guard ${i + 1} → ${expected ?? "no verdict"}`, got === expected, `${pr.verdict} ${JSON.stringify(pr.unknownReasons)}`);
}

// review round 1 follow-ups: recap scope, resolved gab, emoji anchoring
r = parseReview([
  "## Verdict",
  "",
  "- **VERDICT PROPOSAL: APPROVE** — the round-2 blocker and both fixed findings are independently verified CLOSED; one round-2 nit remains open by design (not under fix).",
].join("\n"), "FXT", 1);
check("verdict proposal mentioning a later round still classifies (FOC-151-r3)",
  r.verdict === "PASS", `${r.verdict} ${JSON.stringify(r.unknownReasons)}`);

r = parseReview([
  "## Verdict",
  "",
  "**PASS** — round 1's 5 blocking findings all verified fixed in code; regression hunt clean.",
].join("\n"), "FXT", 1);
check("blocking findings verified fixed is resolved, not FAIL (FOC-156-r2)",
  r.verdict === "PASS", `${r.verdict} ${JSON.stringify(r.unknownReasons)}`);
r = parseReview("**Verdict:** FAIL — the blocker was never fixed.", "FXT", 1);
check("blocker never fixed still fires FAIL", r.verdict === "FAIL", `${r.verdict}`);

r = parseReview(["## Verdict", "", "- **🟠 `issue:`: 1** (D-S1 — CSRF on the launch endpoint)."].join("\n"), "FXT", 1);
check("line-initial severity emoji fires FAIL", r.verdict === "FAIL", `${r.verdict}`);
r = parseReview("- **Verdict:** 🔴 changes required — sending back to DEV.", "FXT", 1);
check("verdict-adjacent severity emoji fires FAIL", r.verdict === "FAIL", `${r.verdict}`);
r = parseReview("- **Verdict: APPROVE** — D-S1 (the r1 🟠 security issue) fixed and live-verified; clean.", "FXT", 1);
check("historical emoji mention inside verdict prose does not fire FAIL (JOI-69-r2)",
  r.verdict === "PASS", `${r.verdict} ${JSON.stringify(r.unknownReasons)}`);
r = parseReview(["## Verdict", "", "  1. **D-S1 (🟠 security, priority):** add Origin-header allowlist."].join("\n"), "FXT", 1);
check("mid-list emoji mention is not a FAIL signal",
  r.verdict === "UNKNOWN", `${r.verdict}`);

// recap-line (FOC-177-r2 shape): a previous round's verdict is not a contradiction
r = parseReview(["- **Verdict: PASS**", "", "Round-1 verdict: FAIL on artifact integrity (4 blockers)."].join("\n"), "FXT", 1);
check("recap-line keeps PASS", r.verdict === "PASS", JSON.stringify(r.unknownReasons));
check("recap-line is not contradictory-in-file", !r.unknownReasons.includes("contradictory-in-file"));

// process-status (FOC-79-r3 + FOC-73..79 artifact shapes)
r = parseReview([
  "## Merge & verdict",
  "",
  "- **Verdict:** clean",
  "- Status: **In Review**",
  "",
  "{round:3,status:escalated}",
].join("\n"), "FXT", 1);
check("process-status keeps PASS", r.verdict === "PASS", JSON.stringify(r.unknownReasons));
check("quoted counter JSON ignored", !r.unknownReasons.includes("contradictory-in-file"));
check("status-header In Progress only is no-verdict-anchor, not unrecognized",
  parseReview("- **Status:** In Progress", "FXT", 1).unknownReasons.join(",") === "no-verdict-anchor");
check("status-header escalated only is ignored too",
  parseReview("- **Status:** escalated", "FXT", 1).unknownReasons.join(",") === "no-verdict-anchor");

// fenced code blocks are never verdicts
r = parseReview([
  "**Verdict:** clean",
  "",
  FENCE,
  "{round:9,status:escalated}",
  "VERDICT: FAIL — blocker found",
  FENCE,
].join("\n"), "FXT", 1);
check("fenced verdict keywords ignored", r.verdict === "PASS", JSON.stringify(r.unknownReasons));

// no-verdict (JOI-57 shape: prose-only, verdict buried in praise)
r = parseReview([
  "# REVIEW — FXT — round 1",
  "",
  "Świetna robota. praise: przemyślany podział na moduły, testy zgodne z kontraktem.",
].join("\n"), "FXT", 1);
check("no-verdict is UNKNOWN", r.verdict === "UNKNOWN");
check("no-verdict reason is no-verdict-anchor", r.unknownReasons.join(",") === "no-verdict-anchor");
check("no-verdict has no evidence", r.evidence === null);
check("no-verdict firstPassClean is null", aggregateOutcomes([r], {}).byTask.get("FXT").firstPassClean === null);

// explicit VERDICT: UNKNOWN (REVIEW §5 contract)
r = parseReview("## VERDICT: UNKNOWN", "FXT", 1);
check("explicit VERDICT: UNKNOWN is UNKNOWN", r.verdict === "UNKNOWN");

// truncated (file cut mid-verdict-line) — never PASS
r = parseReview("**Verdict:** — everything looks", "FXT", 1);
check("truncated verdict is UNKNOWN", r.verdict === "UNKNOWN");
check("truncated reason is unrecognized-verdict", r.unknownReasons.join(",") === "unrecognized-verdict");
check("truncated evidence quotes the verbatim line", r.evidence?.line === "**Verdict:** — everything looks");

// contradictory-in-file (synthetic; corpus near-misses are prevented above)
r = parseReview(["**Verdict: PASS**", "", "later…", "", "**Verdict: FAIL** — sent back to DEV"].join("\n"), "FXT", 1);
check("contradictory-in-file is UNKNOWN", r.verdict === "UNKNOWN");
check("contradictory-in-file reason", r.unknownReasons.join(",") === "contradictory-in-file");
check("contradictory-in-file surfaces BOTH lines", Array.isArray(r.conflictingEvidence) && r.conflictingEvidence.length === 2
  && r.conflictingEvidence[0].lineNo === 1 && r.conflictingEvidence[1].lineNo === 5, JSON.stringify(r.conflictingEvidence));

// crlf-joined (FOC-73..79 shape): CRLF endings must not move the verdict
r = parseReview("- **Status:** 🟢 clean → hand to TEST\r\n\r\nissue: (nit) minor\r\n", "FXT", 1);
check("crlf-joined verdict unaffected", r.verdict === "PASS" && r.evidence?.lineNo === 1);

// malformed-read: 0-byte file parses empty → no-verdict-anchor
r = parseReview("", "FXT", 1);
check("0-byte file is UNKNOWN no-verdict-anchor", r.verdict === "UNKNOWN" && r.unknownReasons.join(",") === "no-verdict-anchor");

// advisory quantities unchanged
r = parseReview([
  "**Run:** `run-abc-123`",
  "",
  "- issue: (correctness) wrong",
  "- issue: (perf) slow",
  "- nitpick: style",
  "- suggestion: (api) rename",
].join("\n"), "FXT", 1);
check("marker counts unchanged", r.issues === 2 && r.nitpicks === 1 && r.suggestions === 1,
  `issues=${r.issues} nitpicks=${r.nitpicks} suggestions=${r.suggestions}`);
check("reviewRunId extracted", r.reviewRunId === "run-abc-123");
check("reviewRunId beyond 2000 chars stays null (unchanged)",
  parseReview("x".repeat(2100) + "\n**Run:** `late`", "FXT", 1).reviewRunId === null);

// --- aggregateOutcomes: pure per-task aggregation (§4.3) --------------------

const failR1 = parseReview("**Verdict:** 🔴 blocker → RETURN to DEV", "T", 1);
const passR2 = parseReview("**Verdict:** clean", "T", 2);
const proseR2 = parseReview("Świetna robota, bez uwag.", "T", 2);

// multi-round (FOC-73 shape): r1 FAIL → r2 PASS
let agg = aggregateOutcomes([failR1, passR2], {});
let t = agg.byTask.get("T");
check("multi-round outcome is the highest round", t.outcome === "PASS");
check("multi-round firstPassClean false", t.firstPassClean === false);
check("multi-round returned counts FAIL rounds", t.returned === 1 && t.blockers === 1);
check("multi-round roundVerdicts preserved", JSON.stringify(t.roundVerdicts.map((v) => [v.round, v.verdict])) === "[[1,\"FAIL\"],[2,\"PASS\"]]");
check("multi-round evidence is the deciding round", t.evidence?.lineNo === 1);

// determinism: same inputs ⇒ same outcome
check("aggregateOutcomes is deterministic",
  JSON.stringify(aggregateOutcomes([failR1, passR2], {})) === JSON.stringify(aggregateOutcomes([failR1, passR2], {})));

// add round 2 later ⇒ outcome flips deterministically
check("r1-only outcome is FAIL", aggregateOutcomes([failR1], {}).byTask.get("T").outcome === "FAIL");
check("adding r2 flips the outcome to PASS deterministically",
  aggregateOutcomes([failR1, passR2], {}).byTask.get("T").outcome === "PASS");

// multi-round-unknown-tail: r1 FAIL, r2 unparseable
agg = aggregateOutcomes([failR1, proseR2], {});
t = agg.byTask.get("T");
check("unknown tail makes the outcome UNKNOWN", t.outcome === "UNKNOWN");
check("unknown tail reason travels", t.unknownReasons.join(",") === "no-verdict-anchor");
check("round-1 verdict preserved in roundVerdicts", t.roundVerdicts[0].verdict === "FAIL");

// rounds-only (counter knows a task with no files — never a fabricated PASS)
for (const [id, n] of [["A", 1], ["B", 2]]) {
  const rec = aggregateOutcomes([], { [id]: n }).byTask.get(id);
  check(`rounds-only ${id} outcome UNKNOWN`, rec.outcome === "UNKNOWN");
  check(`rounds-only ${id} reason`, rec.unknownReasons.join(",") === "rounds-only");
  check(`rounds-only ${id} firstPassClean null (not fabricated)`, rec.firstPassClean === null);
  check(`rounds-only ${id} keeps counter rounds for display`, rec.rounds === n && rec.roundsOnly === true);
}

// counter-ahead (FOC-79 w/o r3 shape): counter 3, files r1-r2
agg = aggregateOutcomes([failR1, passR2], { T: 3 });
t = agg.byTask.get("T");
check("counter-ahead outcome UNKNOWN", t.outcome === "UNKNOWN");
check("counter-ahead reason rounds-missing-verdicts", t.unknownReasons.includes("rounds-missing-verdicts"));
check("counter-ahead effective rounds 3", t.rounds === 3);

// round-gap (FOC-177 shape): files start at round 2
agg = aggregateOutcomes([parseReview("**Verdict: PASS**", "T", 2)], {});
t = agg.byTask.get("T");
check("round-gap firstPassClean null", t.firstPassClean === null);
check("round-gap reason round-1-missing", t.unknownReasons.includes("round-1-missing"));
check("round-gap outcome from the highest present round", t.outcome === "PASS");

// contradictory-rounds (FOC-151 r1→r2 real case): surfaced, outcome from r2
agg = aggregateOutcomes([parseReview("**Verdict: APPROVE**", "T", 1), failR1], {});
t = agg.byTask.get("T");
check("contradictory-rounds anomaly surfaced", agg.anomalies.some((a) => a.taskId === "T" && a.reason === "contradictory-rounds"));
check("contradictory-rounds outcome from highest round", t.outcome === "FAIL");

// clean-with-issues: PASS verdict + issue: marker
agg = aggregateOutcomes([parseReview(["**Verdict:** clean", "", "issue: (correctness) off-by-one"].join("\n"), "T", 1)], {});
t = agg.byTask.get("T");
check("clean-with-issues anomaly surfaced", agg.anomalies.some((a) => a.taskId === "T" && a.reason === "status-vs-issues-contradiction" && a.issues === 1));
check("clean-with-issues outcome unchanged", t.outcome === "PASS");

// --- computeOutcomes: end-to-end on injected fixtures (legacy compat) -------

const dbPath = join(temp, "t.sqlite");
const db = openTelemetryDb(dbPath);
db.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
  VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`).run("runT1", "dev", "2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z", "ps1", "completed");
db.prepare(`INSERT INTO runs (run_id, squad, started_at, ended_at, price_set_id, status, updated_at)
  VALUES (?,?,?,?,?,?,'2026-09-01T00:00:00.000Z')`).run("runT2", "dev", "2026-09-01T12:00:00.000Z", "2026-09-01T13:00:00.000Z", "ps1", "completed");
db.prepare("INSERT INTO price_sets (price_set_id, config_hash, created_at, source) VALUES (?,?,?,?)")
  .run("ps1", "hash1", "2026-09-01T00:00:00.000Z", "test");
for (const taskId of ["T1", "T2"]) {
  db.prepare("INSERT INTO work_items (task_id, identifier, created_at) VALUES (?,?,?)")
    .run(taskId, taskId, "2026-09-01T00:00:00.000Z");
  db.prepare(`INSERT INTO run_task_links (link_id, run_id, task_id, role, valid_from, valid_to, source, confidence, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`l-${taskId}`, `run${taskId}`, taskId, "primary", "2026-09-01T00:00:00.000Z", null, "test", 1.0, "2026-09-01T00:00:00.000Z");
  db.prepare(`INSERT INTO usage_facts (usage_id, run_id, session_id, agent_key, model, observed_at,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source_path, source_offset, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`u-${taskId}`, `run${taskId}`, "s1", "implementer", "z-ai/glm-5.2", "2026-09-01T10:30:00.000Z", 10, 20, 0, 0, "/t.jsonl", 1, "2026-09-01T00:00:00.000Z");
}
db.close();

const reviewsDir = join(temp, "reviews");
mkdirSync(reviewsDir);
writeFileSync(join(reviewsDir, "T1-round1.md"), "**Verdict:** clean\n", "utf8");
writeFileSync(join(reviewsDir, "T2-round1.md"), "**Verdict:** 🔴 blocker → RETURN to DEV\n", "utf8");
const roundsPath = join(temp, "review-rounds.json");
writeFileSync(roundsPath, JSON.stringify({ T1: 1, T2: 1, "MOCK-A": 1 }), "utf8");

const result = computeOutcomes({ dbPath, reviewsDir, roundsPath });
check("computeOutcomes keeps legacy top-level keys",
  ["tasksWithVerdict", "matched", "unmatched", "byTask", "byPair"].every((k) => k in result));
check("computeOutcomes adds the FOC-218 top-level fields",
  ["tasksPass", "tasksFail", "tasksUnknown", "parseAnomalies"].every((k) => k in result));
check("tasksPass/Fail/Unknown counted", result.tasksPass === 1 && result.tasksFail === 1 && result.tasksUnknown === 1,
  JSON.stringify([result.tasksPass, result.tasksFail, result.tasksUnknown]));
check("tasksWithVerdict includes rounds-only tasks", result.tasksWithVerdict === 3);
check("matched/unmatched unchanged", result.matched === 2 && result.unmatched === 1);

const t1 = result.byTask.find((x) => x.taskId === "T1");
const t2 = result.byTask.find((x) => x.taskId === "T2");
const mock = result.byTask.find((x) => x.taskId === "MOCK-A");
check("file-backed PASS task", t1?.outcome === "PASS" && t1?.firstPassClean === true);
check("file-backed FAIL task", t2?.outcome === "FAIL" && t2?.firstPassClean === false && t2?.returned === 1);
check("rounds-only task is UNKNOWN, never a fabricated PASS",
  mock?.outcome === "UNKNOWN" && mock?.firstPassClean === null && mock?.roundsOnly === true
  && mock?.unknownReasons.join(",") === "rounds-only");

check("byPair keeps legacy shape fields",
  ["squad", "agent", "model", "tasks", "clean", "rounds", "blockers", "usd"].every((k) => k in result.byPair[0]));
check("byPair adds unknown and counts only explicit PASSes",
  result.byPair[0].tasks === 2 && result.byPair[0].clean === 1 && result.byPair[0].unknown === 0 && result.byPair[0].blockers === 1,
  JSON.stringify(result.byPair[0]));
check("clean counts exclude UNKNOWN (null firstPassClean never counted)",
  result.byPair.every((p) => p.clean + p.unknown <= p.tasks));

// malformed-read: an unreadable round (directory with a round-file name) is
// evidence in parseAnomalies; other files are unaffected.
const reviewsDir2 = join(temp, "reviews2");
mkdirSync(reviewsDir2);
writeFileSync(join(reviewsDir2, "GOOD-round1.md"), "**Verdict:** clean\n", "utf8");
mkdirSync(join(reviewsDir2, "BAD-round1.md")); // readFileSync on a directory throws
const result2 = computeOutcomes({ dbPath, reviewsDir: reviewsDir2, roundsPath: join(temp, "absent.json") });
const bad = result2.byTask.find((x) => x.taskId === "BAD");
check("unreadable round counts as UNKNOWN", bad?.outcome === "UNKNOWN" && bad?.unknownReasons.includes("read-error"));
check("read error surfaces in parseAnomalies",
  result2.parseAnomalies.some((a) => a.reason === "read-error" && a.file.endsWith("BAD-round1.md")));
check("other files unaffected by a read error", result2.byTask.find((x) => x.taskId === "GOOD")?.outcome === "PASS");

// malformed review-rounds.json degrades to {} plus a parseAnomalies entry, no throw
const reviewsDir4 = join(temp, "reviews4");
mkdirSync(reviewsDir4);
writeFileSync(join(reviewsDir4, "GOOD-round1.md"), "**Verdict:** clean\n", "utf8");
const malformedRounds = join(temp, "review-rounds-broken.json");
writeFileSync(malformedRounds, "{not json", "utf8");
const result4 = computeOutcomes({ dbPath, reviewsDir: reviewsDir4, roundsPath: malformedRounds });
check("malformed rounds counter does not throw and degrades to {}",
  result4.byTask.length === 1 && result4.byTask[0].outcome === "PASS",
  JSON.stringify(result4?.byTask ?? null));
check("malformed rounds counter surfaces in parseAnomalies",
  result4.parseAnomalies.some((a) => a.reason === "rounds-counter-parse-error"));

// helper-files: only <task>-round<N>.md files are parsed
const reviewsDir3 = join(temp, "reviews3");
mkdirSync(reviewsDir3);
writeFileSync(join(reviewsDir3, "_prompt-x.txt"), "VERDICT: FAIL", "utf8");
writeFileSync(join(reviewsDir3, "_run-pass.sh"), "VERDICT: FAIL", "utf8");
writeFileSync(join(reviewsDir3, "x-round1.md"), "**Verdict:** clean\n", "utf8");
writeFileSync(join(reviewsDir3, "JOI-71-r2-brief.md"), "VERDICT: FAIL", "utf8");
writeFileSync(join(reviewsDir3, "JOI-71-crossref-1.md"), "VERDICT: FAIL", "utf8");
const result3 = computeOutcomes({ dbPath, reviewsDir: reviewsDir3, roundsPath: join(temp, "absent.json") });
check("helper and non-round files never parsed",
  result3.byTask.length === 1 && result3.byTask[0].taskId === "x" && result3.byTask[0].outcome === "PASS",
  JSON.stringify(result3.byTask.map((x) => x.taskId)));

// nothing to read degrades to null (dashboard empty state)
check("computeOutcomes returns null with no reviews dir",
  computeOutcomes({ dbPath, reviewsDir: join(temp, "no-such-dir") }) === null);

// --- legacy CSV value contract ----------------------------------------------

check("toCsvValue(null) is blank so first_pass_clean blanks on UNKNOWN", toCsvValue(null) === "");
check("toCsvValue(undefined) is blank", toCsvValue(undefined) === "");
check("toCsvValue(false) is the literal", toCsvValue(false) === "false");
check("toCsvValue quotes separators", toCsvValue("a,\"b\"") === "\"a,\"\"b\"\"\"");

// --- report -----------------------------------------------------------------

rmSync(temp, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
