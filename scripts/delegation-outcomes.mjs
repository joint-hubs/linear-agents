#!/usr/bin/env node
/**
 * scripts/delegation-outcomes.mjs — join review verdicts back onto the delegations
 * that produced the code (JOI-210).
 *
 * The system measures cost everywhere and quality nowhere. Telemetry knows the DEV
 * implementer on GLM-5.2 cost $37.15; it does not know whether that code passed
 * review first time or came back twice. Without that, "is GLM better than DeepSeek
 * on implementer" can only be argued from public benchmarks — see
 * docs/prd/model-role-fit-analysis.md, which stops at exactly this wall.
 *
 * Nothing new has to be produced. REVIEW already writes a verdict per round to
 * .state/reviews/<taskId>-round<N>.md and keeps a round counter in
 * .state/review-rounds.json. This reads both and attributes them to the delegations
 * recorded in telemetry for the same task.
 *
 * Signal, weakest to strongest (FOC-218: verdicts are explicit, never guessed):
 *   outcome PASS on round 1 → the work passed first time
 *   outcome FAIL            → REVIEW returned the work; each extra round is rework
 *   outcome UNKNOWN         → no anchored verdict found, or files and the round
 *                             counter disagree — surfaced with a reason, never a
 *                             default PASS
 *
 * Usage:
 *   node scripts/delegation-outcomes.mjs              # model x role summary
 *   node scripts/delegation-outcomes.mjs --by-task    # per-task detail
 *   node scripts/delegation-outcomes.mjs --json
 *   node scripts/delegation-outcomes.mjs --csv <dir>  # export outcomes_by_task.csv,
 *                                                      # outcomes_by_pair.csv, usage_by_role_model.csv,
 *                                                      # task_delegations.csv
 *                                                      # (01_LLM_EVAL/docs/PRD-telemetry-effectiveness.md §5)
 *
 * Read-only. Touches .state/ and the telemetry DB, writes nothing except the files named
 * explicitly by --csv <dir>.
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEWS = join(ROOT, ".state", "reviews");
const ROUNDS = join(ROOT, ".state", "review-rounds.json");
const DB_PATH = process.env.LA_TELEMETRY_DB
  || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
          "linear-agents", "telemetry", "telemetry.sqlite");

const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const BY_TASK = args.includes("--by-task");
const CSV_DIR = (() => {
  const i = args.indexOf("--csv");
  return i >= 0 ? args[i + 1] : null;
})();

// ── read the verdicts REVIEW already wrote ────────────────────────────────────
//
// FOC-218: verdict extraction is an anchored allowlist over the WHOLE file. The
// old parser word-sniffed the first 2000 chars — "No 🔴 blocker." counted as a
// blocker, a missing RETURN counted as a pass, and verdicts sitting beyond 2k
// were invisible. REVIEW round files always carry an explicit verdict on a
// Verdict-keyword line/heading, the later **Status:** header, or inside a
// verdict section (12+ distinct shapes in the legacy corpus, incl. Polish
// section bodies). Anything the parser cannot anchor becomes UNKNOWN with a
// reason and verbatim evidence — never PASS-by-default.

const VERDICT_WORD_RE = /verdict/i;
// Unanchored so it also matches "- **Round:** 1 of 2 · **Status:** …" — the shape
// the four corpus **Status:** files actually use.
const STATUS_HEADER_RE = /\*\*Status:\*\*/;
const HEADING_RE = /^#{1,6}\s/;
const FENCE_RE = /^\s*```/;
const JSON_LINE_RE = /^\s*[{"]/; // counter JSON quoted inside a review
// "Round-1 verdict: FAIL …" describes a previous round whose own file carries the
// verdict — a recap, never this file's verdict. Only this shape is ignored: a
// verdict line that merely MENTIONS a later round (FOC-151-r3 "VERDICT PROPOSAL:
// APPROVE — the round-2 blocker …") is this file's verdict and must classify.
const RECAP_LINE_RE = /round\s*-?\s*\d+\s+verdict/i;
const PROCESS_STATE_RE = /\b(?:escalated|in review|in progress)\b/i;
const UNKNOWN_VALUE_RE = /\b(?:verdict|status)\s*\*{0,2}\s*[:=]\s*\*{0,2}\s*unknown\b/i;

// Negation families (FOC-218 §4.1.5), removed from the line before keyword
// classification so a negated blocker mention cannot fire FAIL. A count-zero
// mention is itself the PASS signal — the Polish "**Blokerów (🔴 `issue:`): 0.**"
// bodies carry the whole verdict.
const COUNT_ZERO_BEFORE_RE = /\b(?:0|zero)\b[^.\n]{0,40}?\b(?:blockers?|bloker\w*|issues?|blocking)\b/i;
const COUNT_ZERO_AFTER_RE = /(?:[🔴🔶🟠][^\w\n]{0,4})?\b(?:blockers?|bloker\w*|issues?)\b[^.\n]{0,40}?[:=]\s*0\b/iu;
const NEG_DIRECT_RE = /\b(?:no|none|zero|without|nie ma|brak)\b(?:\s+\S+){0,2}\s+[^\w\s]{0,2}\s*\b(?:blockers?|bloker\w*|issues?|blocking)\b/gi;
const NEG_COUNT_ZERO_BEFORE_RE = /\b(?:0|zero)\b[^.\n]{0,40}?\b(?:blockers?|bloker\w*|issues?|blocking)\b/giu;
const NEG_COUNT_ZERO_AFTER_RE = /(?:[🔴🔶🟠][^\w\n]{0,4})?\b(?:blockers?|bloker\w*|issues?)\b[^.\n]{0,40}?[:=]\s*0\b/giu;
// Bare negated severity emoji: "no 🟠", "0 🔴" (JOI-70-r1, JOI-69-r1) — runs after
// the word families so "No 🔴 blocker" is consumed whole by NEG_DIRECT first.
const NEG_NEGATED_EMOJI_RE = /\b(?:no|none|zero|0)\b\s*[🔴🔶🟠]/gi;
const NEG_NONE_AFTER_RE = /\b(?:blockers?|bloker\w*)[^.\n]{0,40}?\bnone\b/gi;
// Resolved blocker: "Round-1 blocker closed", "blocker fixed correctly",
// "🔴 blocker → FIXED", "5 blocking findings all verified fixed" (FOC-156-r2).
// The gab is tempered so "blocker was never fixed" keeps firing FAIL, and the
// optional leading emoji rides along so a resolved mention cannot fire FAIL
// through its own severity marker. (/u: these emoji are astral-plane chars —
// without it the class matches the shared high surrogate.)
const NEG_RESOLVED_RE = /(?:[🔴🔶🟠][^\w\n]{0,4})?\bblock(?:ers?|ing)\b(?:(?!\b(?:not|never)\b)[^.\n]){0,40}?(?:closed|fixed)\b/giu;

// Compound guard: "fail-closed", "single-pass", "pass-all", "non-blocking" are not
// verdict words — the hyphen must not count as a token boundary for them.
const FAIL_TOKEN_RES = [
  // Severity emoji (/u — astral-plane chars) counts only line-initial (after
  // bullet/quote/bold/number prefixes) or verdict-adjacent (right after a
  // Verdict:/Status: label). A historical mention inside verdict prose
  // (JOI-69-r2:60 "the r1 🟠 security issue") is not a verdict signal.
  /^[\s>*_`\d.)\-–—•·]*[🔴🔶🟠]/u,
  /\b(?:verdict|status)\b[^:\n]{0,12}[:：][^:\n]{0,16}?[🔴🔶🟠]/iu,
  /(?<![\w-])FAIL(?![\w-])/i,
  /(?<![\w-])(?:blockers?|bloker\w*)\b/i,    // incl. Polish inflection; guard keeps "non-blockers" out
  /(?<![\w-])blocking(?![\w-])/i,
  /\brequest[\s-]changes\b/i,                // REQUEST CHANGES / request-changes
  /\bchanges\s+(?:requested|required)\b/i,
  /\brequires?\s+changes\b/i,
  /\bfindings\s+require\s+changes\b/i,
  /\b(?:back|returns?|returned?)\s+to\s+dev\b/i, // send/sent/sending/returns back to DEV
  /\bRETURN\s+to\s+DEV\b/i,
  /\bissues?(?![:\w])\s*\(\s*\d+\s*\)/i,     // "issues(9)" — a count, not the issue: marker
  /\bbloker\w*[^.\n]{0,40}?[:=]\s*[1-9]/i,   // Polish count ≥ 1
];
const PASS_TOKEN_RES = [
  /[✅🟢]/u,
  /\bclean\b/i,
  /(?<![\w-])pass(?![\w-])/i,
  /(?<![\w-])approve[ds]?(?![\w-])/i,
  /\bhand(?:ing)?\s+to\s+test\b/i,
  /\bproceed(?:ing)?\s+to\s+test\b/i,
];

/**
 * Classify one anchor-candidate line. Negation families are removed before the
 * keyword scan (a count-zero mention sets the PASS signal); process-state tokens
 * with no verdict signal are ignored; a labelled line that still fires no rule is
 * reported back as unrecognized so the caller can decide what it is worth.
 */
function classifyLine(line) {
  if (JSON_LINE_RE.test(line) || RECAP_LINE_RE.test(line)) return null;

  const countZero = COUNT_ZERO_BEFORE_RE.test(line) || COUNT_ZERO_AFTER_RE.test(line);
  let scrubbed = line;
  const scrub = (re) => {
    scrubbed = scrubbed.replace(re, (m) => " ".repeat(m.length));
  };
  scrub(NEG_COUNT_ZERO_BEFORE_RE);
  scrub(NEG_COUNT_ZERO_AFTER_RE);
  scrub(NEG_DIRECT_RE);
  scrub(NEG_NEGATED_EMOJI_RE);
  scrub(NEG_NONE_AFTER_RE);
  scrub(NEG_RESOLVED_RE);

  if (UNKNOWN_VALUE_RE.test(scrubbed)) return { verdict: "UNKNOWN" };
  if (FAIL_TOKEN_RES.some((re) => re.test(scrubbed))) return { verdict: "FAIL" };
  if (countZero || PASS_TOKEN_RES.some((re) => re.test(scrubbed))) return { verdict: "PASS" };
  if (PROCESS_STATE_RE.test(scrubbed)) return null; // process state, no verdict signal
  return { unrecognized: true };
}

/**
 * Parse one review round file from its TEXT (I/O-free; exported for tests).
 * The format is REVIEW's own output (see agents/review/CLAUDE.md §4-5), so this
 * reads what the squad genuinely produced rather than a shape invented here.
 *
 * Verdict resolution (FOC-218 §4.1.7): one classified anchor decides; several
 * agreeing anchors decide with the first as evidence; conflicting anchors are a
 * contradiction surfaced with every conflicting line; nothing anchored at all is
 * UNKNOWN no-verdict-anchor. Conventional-Comments counts and the **Run:** id are
 * advisory quantities, kept unchanged.
 */
export function parseReview(text, taskId, round) {
  const raw = String(text ?? "");
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const findings = [];
  const unrecognized = [];

  let inFence = false;
  let inVerdictSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const isHeading = HEADING_RE.test(line);
    const verdictLine = VERDICT_WORD_RE.test(line);
    const statusHeader = !verdictLine && STATUS_HEADER_RE.test(line);
    const sectionLine = !verdictLine && !statusHeader && !isHeading && inVerdictSection;

    if (isHeading) inVerdictSection = verdictLine; // any heading closes a section; a verdict heading reopens one

    const kind = verdictLine ? "verdict-line" : statusHeader ? "status-header" : sectionLine ? "verdict-section" : null;
    if (!kind) continue;

    const cls = classifyLine(line);
    if (!cls) continue; // JSON / recap / process state — ignored before classification
    if (cls.verdict) {
      findings.push({ verdict: cls.verdict, line, lineNo: i + 1, anchor: kind });
      continue;
    }
    // No keyword fired. A verdict heading is a section opener and section prose is
    // not a finding; only a labelled non-heading line with no signal at all is an
    // unrecognized verdict.
    if (kind === "verdict-section" || (kind === "verdict-line" && isHeading)) continue;
    unrecognized.push({ line, lineNo: i + 1, anchor: kind });
  }

  let verdict;
  let evidence = null;
  let unknownReasons = [];
  let conflictingEvidence = null;

  const decisive = findings.filter((f) => f.verdict !== "UNKNOWN");
  if (!findings.length && !unrecognized.length) {
    verdict = "UNKNOWN";
    unknownReasons = ["no-verdict-anchor"];
  } else if (!decisive.length) {
    verdict = "UNKNOWN";
    if (unrecognized.length) {
      unknownReasons = ["unrecognized-verdict"];
      evidence = { ...unrecognized[0] };
    }
    // else: the reviewer's own explicit VERDICT: UNKNOWN — no parser reason to add
  } else if (new Set(decisive.map((f) => f.verdict)).size > 1) {
    verdict = "UNKNOWN";
    unknownReasons = ["contradictory-in-file"];
    conflictingEvidence = decisive.map((f) => ({ line: f.line, lineNo: f.lineNo, anchor: f.anchor }));
    evidence = { ...conflictingEvidence[0] };
  } else {
    verdict = decisive[0].verdict;
    evidence = { line: decisive[0].line, lineNo: decisive[0].lineNo, anchor: decisive[0].anchor };
  }

  const head = raw.slice(0, 2000);
  const count = (marker) => (raw.match(new RegExp(`\\b${marker}\\s*(\\(|:)`, "gi")) || []).length;

  return {
    taskId, round,
    verdict,
    evidence,
    unknownReasons,
    ...(conflictingEvidence ? { conflictingEvidence } : {}),
    // Legacy fields, tightened (FOC-218 §4.4): a round "returned"/"blocked" iff
    // its verdict is FAIL. Was: literal "RETURN to DEV" / 🔴|blocker anywhere in
    // the first 2000 chars — which matched negations in 16 PASS files.
    returned: verdict === "FAIL",
    blocker: verdict === "FAIL",
    issues: count("issue"),
    nitpicks: count("nitpick"),
    suggestions: count("suggestion"),
    reviewRunId: (head.match(/\*\*Run:\*\*\s*`([^`]+)`/) || [])[1] || null,
  };
}

// Exported for verdict-evidence.mjs (FOC-219): the projection reuses this loader
// verbatim instead of re-parsing round files. Additive keyword only — F1 semantics
// and its 123-check suite are untouched.
export function loadReviews(reviewsDir = REVIEWS) {
  if (!existsSync(reviewsDir)) return { reviews: [], readErrors: [] };
  const reviews = [];
  const readErrors = [];
  for (const file of readdirSync(reviewsDir)) {
    const m = file.match(/^(.+)-round(\d+)\.md$/);
    if (!m) continue; // helpers (_prompt-*.txt, _run-pass.sh) and non-round files never match
    try {
      reviews.push(parseReview(readFileSync(join(reviewsDir, file), "utf8"), m[1], Number(m[2])));
    } catch (error) {
      // FOC-218 §4.1.9: a read failure is evidence, not something to swallow.
      // The round counts as UNKNOWN and the error surfaces in parseAnomalies.
      readErrors.push({
        file: join(reviewsDir, file),
        taskId: m[1],
        round: Number(m[2]),
        reason: "read-error",
        detail: String(error?.message || error),
      });
      reviews.push({
        taskId: m[1], round: Number(m[2]),
        verdict: "UNKNOWN", evidence: null, unknownReasons: ["read-error"],
        returned: false, blocker: false,
        issues: 0, nitpicks: 0, suggestions: 0, reviewRunId: null,
      });
    }
  }
  reviews.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.round - b.round);
  return { reviews, readErrors };
}

/**
 * Fold per-round verdicts into per-task outcomes (FOC-218 §4.3). Pure: the same
 * file set + round counter always yields the same outcome, so a round file added
 * later recomputes it deterministically. The counter (REVIEW's own
 * .state/review-rounds.json) may extend `rounds` for display but can never
 * fabricate a verdict — a task it knows without round files stays UNKNOWN.
 *
 * Returns { byTask: Map<taskId, record>, anomalies: [] }. The anomalies are the
 * task-level contradictions (contradictory-rounds, status-vs-issues-contradiction);
 * file-level parse reasons travel on the round records' unknownReasons and read
 * errors on the loadReviews() result.
 */
export function aggregateOutcomes(roundReviews, roundsCounter = {}) {
  const byTask = new Map();
  const anomalies = [];
  const grouped = new Map();
  for (const r of roundReviews) {
    if (!grouped.has(r.taskId)) grouped.set(r.taskId, []);
    grouped.get(r.taskId).push(r);
  }

  for (const [taskId, rounds] of grouped) {
    rounds.sort((a, b) => a.round - b.round);
    const counterRounds = Number(roundsCounter[taskId]) || 0;
    const maxFileRound = rounds[rounds.length - 1].round;
    const deciding = rounds[rounds.length - 1]; // outcome = verdict of the highest round present
    const round1 = rounds.find((r) => r.round === 1);

    const record = {
      taskId,
      rounds: Math.max(counterRounds, maxFileRound),
      blockers: rounds.filter((r) => r.verdict === "FAIL").length,
      issues: rounds.reduce((sum, r) => sum + r.issues, 0),
      returned: rounds.filter((r) => r.verdict === "FAIL").length,
      firstPassClean: round1 ? (round1.verdict === "PASS" ? true : round1.verdict === "FAIL" ? false : null) : null,
      outcome: deciding.verdict,
      unknownReasons: [],
      roundVerdicts: rounds.map((r) => ({
        round: r.round,
        verdict: r.verdict,
        ...(r.verdict === "UNKNOWN" && r.unknownReasons.length ? { unknownReasons: r.unknownReasons } : {}),
      })),
      evidence: deciding.evidence,
    };

    if (deciding.verdict === "UNKNOWN") record.unknownReasons.push(...deciding.unknownReasons);
    if (counterRounds > maxFileRound) {
      // The counter knows a round whose file is gone (or never written) — that
      // verdict is unknowable, so the outcome cannot stand on the files alone.
      record.outcome = "UNKNOWN";
      record.unknownReasons.unshift("rounds-missing-verdicts");
    }
    if (!round1) record.unknownReasons.push("round-1-missing");

    // Contradictions are surfaced, never silently overwritten (FOC-218 §4.2).
    // PASS is terminal per REVIEW §5 — a later round file implies a return that
    // REVIEW recorded somewhere else.
    for (let i = 0; i < rounds.length - 1; i++) {
      if (rounds[i].verdict === "PASS") {
        anomalies.push({
          taskId,
          reason: "contradictory-rounds",
          detail: `round ${rounds[i].round} is PASS but round ${rounds[i + 1].round} file exists`,
        });
      }
    }
    for (const r of rounds) {
      if (r.verdict === "PASS" && r.issues > 0) {
        anomalies.push({ taskId, round: r.round, reason: "status-vs-issues-contradiction", issues: r.issues });
      }
    }

    byTask.set(taskId, record);
  }

  // The counter may know tasks whose round files were cleaned up — or that never
  // existed (mock ids). The old code turned those into firstPassClean: true.
  for (const [taskId, counterRounds] of Object.entries(roundsCounter)) {
    if (byTask.has(taskId)) continue;
    byTask.set(taskId, {
      taskId,
      rounds: Number(counterRounds) || 0,
      blockers: 0,
      issues: 0,
      returned: 0,
      firstPassClean: null,
      roundsOnly: true,
      outcome: "UNKNOWN",
      unknownReasons: ["rounds-only"],
      roundVerdicts: [],
      evidence: null,
    });
  }

  return { byTask, anomalies };
}

// ── join to the delegations that produced the work ────────────────────────────

/**
 * Which delegations worked on this task, per telemetry. Uses run_task_links so a
 * turn counts for the task that was actually linked AT THAT MOMENT — the same
 * temporal rule the cost views use, otherwise a retagged run would move its
 * quality signal too.
 */
// Exported for verdict-evidence.mjs (FOC-219): the optional telemetry axis reuses
// the same temporal run_task_links join — one definition of "which delegation
// worked on this task". Additive keyword only.
export function delegationsByTask(db) {
  const rows = db.prepare(`
    SELECT l.task_id AS taskId, r.squad AS squad, u.agent_key AS agent, u.model AS model,
           COUNT(*) AS turns, ROUND(SUM(COALESCE(c.cost_usd, 0)), 4) AS usd,
           SUM(u.input_tokens) AS inputTokens, SUM(u.output_tokens) AS outputTokens,
           SUM(u.cache_read_tokens) AS cacheReadTokens, SUM(u.cache_creation_tokens) AS cacheCreationTokens
    FROM usage_facts u
    JOIN runs r            ON r.run_id = u.run_id
    JOIN run_task_links l  ON l.run_id = u.run_id
                           AND u.observed_at >= l.valid_from
                           AND (l.valid_to IS NULL OR u.observed_at < l.valid_to)
    LEFT JOIN cost_facts c ON c.run_id = u.run_id AND c.usage_id = u.usage_id
    WHERE l.role = 'primary' AND u.agent_key IS NOT NULL
    GROUP BY l.task_id, r.squad, u.agent_key, u.model
  `).all();
  // Token sums riding along on the same rows computeOutcomes() already builds from this
  // function — additive fields, existing consumers (computeOutcomes -> pair.usd) only read
  // the columns they already knew about, so this cannot change their behaviour.
  const byTask = new Map();
  for (const row of rows) {
    if (!byTask.has(row.taskId)) byTask.set(row.taskId, []);
    byTask.get(row.taskId).push(row);
  }
  return byTask;
}

/**
 * `z-ai/glm-5.2` and `z-ai/glm-5.2-20260616` are one model under two ids; leaving
 * them apart splits a small sample into two smaller ones and invents a difference
 * (27% clean vs 100%) that is an artefact of the id, not of the model.
 */
function normaliseModel(model) {
  return String(model || "?").replace(/-\d{8}$/, "");
}
const isNoiseModel = (m) => !m || m === "<synthetic>" || m === "synthetic";
// Ephemeral sub-agent ids (`agent-a83cd8...`) are one-off handles, not roles.
const isNoiseAgent = (a) => !a || /^agent-[0-9a-f]{8,}/i.test(a);

/**
 * `claude-4.8-opus-20260528` (after date-strip: `claude-4.8-opus`) and `claude-opus-4.8` are
 * the same model logged two ways — telemetry has both forms in the wild. Reorder
 * `claude-<version>-<name>` to `claude-<name>-<version>` so both collapse onto the id used in
 * 00_LLM_PRICE (01_LLM_EVAL). Only touches that one naming pattern; every other model already
 * matches as-is.
 */
function bareModel(model) {
  let s = normaliseModel(model).replace(/^.*\//, "");
  const m = s.match(/^claude-(\d+\.\d+)-([a-z]+)$/);
  if (m) s = `claude-${m[2]}-${m[1]}`;
  return s;
}

// ── report ────────────────────────────────────────────────────────────────────

/**
 * Compute the whole report. Exported so telemetry-server can serve it without
 * shelling out to this CLI. Returns null when there is nothing to read, rather
 * than throwing — a dashboard panel must degrade, not take the page down.
 */
export function computeOutcomes({ dbPath = DB_PATH, reviewsDir = REVIEWS, roundsPath = ROUNDS } = {}) {
  const { reviews, readErrors } = loadReviews(reviewsDir);
  if (!reviews.length) return null;

  // The round counter is REVIEW's own state; it may know about tasks whose round
  // files were cleaned up. aggregateOutcomes() folds it in without ever letting a
  // counter value fabricate a verdict (FOC-218 §4.3). A malformed counter degrades
  // to {} — same contract as a read-error: the dashboard keeps working and the
  // evidence surfaces in parseAnomalies.
  let counter = {};
  let counterAnomaly = null;
  if (existsSync(roundsPath)) {
    try {
      counter = JSON.parse(readFileSync(roundsPath, "utf8"));
    } catch (error) {
      counterAnomaly = {
        reason: "rounds-counter-parse-error",
        detail: String(error?.message || error),
      };
    }
  }
  const { byTask: taskOutcomes, anomalies: aggregateAnomalies } = aggregateOutcomes(reviews, counter);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const delegations = delegationsByTask(db);
  db.close(); // done with the handle — telemetry-server recomputes per request and must not accumulate open DBs

  // model x role: how did work from this pairing fare downstream
  const pair = new Map();
  let matched = 0, unmatched = 0;
  for (const [taskId, outcome] of taskOutcomes) {
    const dels = delegations.get(taskId);
    if (!dels) { unmatched++; continue; }
    matched++;
    for (const d of dels) {
      // Only DEV is on trial. REVIEW writes the verdict, and PLAN/TEST/CADENCE
      // touch the same task without producing the code being judged — crediting a
      // cadence digest with a review round it had no hand in is not a weak signal,
      // it is a wrong one.
      if (d.squad !== "dev") continue;
      if (isNoiseAgent(d.agent) || isNoiseModel(d.model)) continue;
      const key = `${d.agent}|${normaliseModel(d.model)}`;
      const cur = pair.get(key) || { squad: d.squad, agent: d.agent, model: normaliseModel(d.model), tasks: 0, clean: 0, unknown: 0, rounds: 0, blockers: 0, usd: 0 };
      cur.tasks++;
      // clean counts only explicit round-1 PASSes; an UNKNOWN verdict (null) is
      // counted separately so "clean" never hides an unreadable verdict (FOC-218 §4.3.2).
      cur.clean += outcome.firstPassClean === true ? 1 : 0;
      cur.unknown += outcome.outcome === "UNKNOWN" ? 1 : 0;
      cur.rounds += outcome.rounds;
      cur.blockers += outcome.outcome === "FAIL" ? 1 : 0;
      cur.usd += d.usd || 0;
      pair.set(key, cur);
    }
  }

  let tasksPass = 0, tasksFail = 0, tasksUnknown = 0;
  for (const t of taskOutcomes.values()) {
    if (t.outcome === "PASS") tasksPass++;
    else if (t.outcome === "FAIL") tasksFail++;
    else tasksUnknown++;
  }

  // File-level parse anomalies: every UNKNOWN round's reasons, plus read errors
  // from loadReviews(). Task-level contradictions come from aggregateOutcomes().
  const parseAnomalies = [...readErrors];
  if (counterAnomaly) parseAnomalies.push(counterAnomaly);
  for (const r of reviews) {
    if (r.verdict !== "UNKNOWN") continue;
    for (const reason of r.unknownReasons) {
      parseAnomalies.push(reason === "contradictory-in-file"
        ? { taskId: r.taskId, round: r.round, reason, lines: r.conflictingEvidence }
        : { taskId: r.taskId, round: r.round, reason, ...(r.evidence ? { line: r.evidence.line, lineNo: r.evidence.lineNo } : {}) });
    }
  }
  parseAnomalies.push(...aggregateAnomalies);

  return {
    tasksWithVerdict: taskOutcomes.size,
    matched,
    unmatched,
    tasksPass,
    tasksFail,
    tasksUnknown,
    parseAnomalies,
    byTask: [...taskOutcomes.values()],
    byPair: [...pair.values()].sort((a, b) => b.tasks - a.tasks),
  };
}

// ── canonical role taxonomy (mirrors ROLES[].id in 01_LLM_EVAL/data_analysis.R) ─────────────

/**
 * `worker` in data_analysis.R is explicitly a combined bucket — label "Worker / flash / push"
 * — so all three real agent_key values fold into it. Roles a squad has but that were never
 * modelled theoretically (spec-review, discovery, root-cause, runner, scenario-gen, retro,
 * collector) fall to "other", same as telemetry noise (Explore, general-purpose, ephemeral
 * agent-<hash> subagent ids, <synthetic>).
 */
const ROLE_MAP = {
  _lead: "lead",
  implementer: "impl",
  refactorer: "refac",
  debugger: "debug",
  recon: "recon",
  deep: "deep",
  security: "sec",
  "first-pass": "first",
  spec: "spec",
  decomposer: "decomp",
  deployer: "deploy",
  worker: "worker",
  flash: "worker",
  push: "worker",
  digest: "digest",
};

function normalizeRole(agentKey) {
  return ROLE_MAP[agentKey] || "other";
}

// ── all-squad usage volume, independent of REVIEW verdicts ─────────────────────────────────

function loadUsageTurns(db) {
  return db.prepare(`
    SELECT u.run_id AS runId, u.agent_key AS agentKey, u.model AS model, u.observed_at AS observedAt,
           u.input_tokens AS inputTokens, u.output_tokens AS outputTokens,
           u.cache_read_tokens AS cacheReadTokens, u.cache_creation_tokens AS cacheCreationTokens,
           r.squad AS squad, COALESCE(c.cost_usd, 0) AS costUsd
    FROM usage_facts u
    JOIN runs r ON r.run_id = u.run_id
    LEFT JOIN cost_facts c ON c.run_id = u.run_id AND c.usage_id = u.usage_id
    WHERE u.agent_key IS NOT NULL
  `).all();
}

function loadPrimaryTaskLinks(db) {
  return db.prepare(`
    SELECT run_id AS runId, task_id AS taskId, valid_from AS validFrom, valid_to AS validTo
    FROM run_task_links WHERE role = 'primary'
  `).all();
}

function indexLinksByRun(links) {
  const byRun = new Map();
  for (const l of links) {
    if (!byRun.has(l.runId)) byRun.set(l.runId, []);
    byRun.get(l.runId).push(l);
  }
  return byRun;
}

function taskIdForTurn(linksByRun, runId, observedAt) {
  for (const l of linksByRun.get(runId) || []) {
    if (observedAt >= l.validFrom && (l.validTo == null || observedAt < l.validTo)) return l.taskId;
  }
  return null;
}

/** Monday of the UTC week containing `observedAt`, as YYYY-MM-DD — the trend bucket (PRD §6 pkt 9). */
function isoWeekStart(observedAt) {
  const d = new Date(observedAt);
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/**
 * Volume (turns/tokens/cost) per (squad, agent_key, model, week), across ALL squads. Unlike
 * the DEV-only `pair` map in computeOutcomes(), this needs no REVIEW verdict, so it also
 * covers plan/test/cadence where "clean/rounds" has no meaning but tokens and cost still do.
 * `week_start` is included so the same file answers both the totals views (group_by ignoring
 * week) and the time-trend view (group_by keeping week) — one export, two uses.
 */
function usageByRoleModel(db) {
  const turns = loadUsageTurns(db);
  const linksByRun = indexLinksByRun(loadPrimaryTaskLinks(db));
  const map = new Map();
  for (const t of turns) {
    if (isNoiseAgent(t.agentKey) || isNoiseModel(t.model)) continue;
    const model = normaliseModel(t.model);
    const week = isoWeekStart(t.observedAt);
    const key = `${t.squad}|${t.agentKey}|${model}|${week}`;
    const cur = map.get(key) || {
      squad: t.squad, agent_key: t.agentKey, canonical_role: normalizeRole(t.agentKey), model,
      week_start: week,
      turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
      cost_usd: 0, taskIds: new Set(), runIds: new Set(),
    };
    cur.turns += 1;
    cur.input_tokens += t.inputTokens || 0;
    cur.output_tokens += t.outputTokens || 0;
    cur.cache_read_tokens += t.cacheReadTokens || 0;
    cur.cache_creation_tokens += t.cacheCreationTokens || 0;
    cur.cost_usd += t.costUsd || 0;
    cur.runIds.add(t.runId);
    const taskId = taskIdForTurn(linksByRun, t.runId, t.observedAt);
    if (taskId) cur.taskIds.add(taskId);
    map.set(key, cur);
  }
  return [...map.values()]
    .map((r) => ({
      squad: r.squad, agent_key: r.agent_key, canonical_role: r.canonical_role, model: r.model,
      week_start: r.week_start,
      turns: r.turns, input_tokens: r.input_tokens, output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens, cache_creation_tokens: r.cache_creation_tokens,
      cost_usd: Math.round(r.cost_usd * 10000) / 10000,
      distinct_tasks: r.taskIds.size, distinct_runs: r.runIds.size,
    }))
    .sort((a, b) => a.week_start.localeCompare(b.week_start) || b.turns - a.turns);
}

/**
 * Flattened task × delegation rows (all squads) — the grain the per-task ±1 sensitivity
 * analysis needs (01_LLM_EVAL/docs/PRD-telemetry-effectiveness.md §7 step 5): which role AND
 * model actually touched a given task, with its tokens/cost, so the R side can join each task
 * to the theoretical parameters of the model that worked it.
 */
function taskDelegationRows(db) {
  const delegations = delegationsByTask(db);
  const rows = [];
  for (const [taskId, dels] of delegations) {
    for (const d of dels) {
      if (isNoiseAgent(d.agent) || isNoiseModel(d.model)) continue;
      rows.push({
        task_id: taskId, squad: d.squad, agent_key: d.agent, canonical_role: normalizeRole(d.agent),
        model: normaliseModel(d.model), model_bare: bareModel(d.model),
        turns: d.turns, input_tokens: d.inputTokens || 0, output_tokens: d.outputTokens || 0,
        cache_read_tokens: d.cacheReadTokens || 0, cache_creation_tokens: d.cacheCreationTokens || 0,
        cost_usd: d.usd || 0,
      });
    }
  }
  return rows.sort((a, b) => a.task_id.localeCompare(b.task_id));
}

// ── CSV export (01_LLM_EVAL/docs/PRD-telemetry-effectiveness.md §5) ────────────────────────

export function toCsvValue(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(path, columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => toCsvValue(row[c])).join(","));
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

/**
 * Builds the three CSV exports for 01_LLM_EVAL. Opens its own DB handle rather than reusing
 * computeOutcomes()'s internals, so the function telemetry-server imports stays untouched —
 * this is purely additive.
 */
function buildCsvExports(dir) {
  mkdirSync(dir, { recursive: true });

  const result = computeOutcomes();
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const delegations = delegationsByTask(db);

  const taskRows = (result ? result.byTask : []).map((t) => ({
    task_id: t.taskId,
    squad_key_prefix: (t.taskId.match(/^([A-Za-z]+)-/) || [null, "OTHER"])[1],
    rounds: t.rounds,
    returned_count: t.returned,
    blockers: t.blockers,
    issues: t.issues,
    nitpicks: t.nitpicks || 0,
    suggestions: t.suggestions || 0,
    first_pass_clean: t.firstPassClean,
    has_delegation_match: delegations.has(t.taskId),
    // FOC-218 additive columns (existing columns keep names and positions):
    // outcome is the explicit PASS/FAIL/UNKNOWN behind first_pass_clean, which is
    // now blank when the verdict is unknown rather than guessed.
    outcome: t.outcome,
    unknown_reasons: (t.unknownReasons || []).join("|"),
    round_verdicts: (t.roundVerdicts || []).map((rv) => `${rv.round}:${rv.verdict}`).join("|"),
  }));
  writeCsv(join(dir, "outcomes_by_task.csv"),
    ["task_id", "squad_key_prefix", "rounds", "returned_count", "blockers", "issues",
      "nitpicks", "suggestions", "first_pass_clean", "has_delegation_match",
      "outcome", "unknown_reasons", "round_verdicts"], taskRows);

  const pairRows = (result ? result.byPair : []).map((p) => ({
    // computeOutcomes()'s pair map only ever aggregates squad==="dev" delegations
    // (see the `if (d.squad !== "dev") continue;` guard above) — squad is a
    // literal here, not read off `p`, but it must be present so a consumer can
    // join this file by (squad, agent_key, model) and not silently leak DEV-only
    // quality numbers onto another squad that happens to share an agent_key+model
    // (e.g. "_lead"/"z-ai/glm-5.2" also exists under squad=review).
    squad: "dev",
    agent_key: p.agent,
    canonical_role: normalizeRole(p.agent),
    model: p.model,
    model_bare: bareModel(p.model),
    tasks: p.tasks,
    clean_pct: p.tasks ? Math.round((p.clean / p.tasks) * 1000) / 10 : null,
    avg_rounds: p.tasks ? Math.round((p.rounds / p.tasks) * 100) / 100 : null,
    blocker_rate: p.tasks ? Math.round((p.blockers / p.tasks) * 1000) / 10 : null,
    cost_usd: Math.round(p.usd * 10000) / 10000,
    cost_per_clean_task: p.clean ? Math.round((p.usd / p.clean) * 100) / 100 : null,
    sample_size_flag: p.tasks < 5 ? "low" : "ok",
    // FOC-218 additive columns: clean_pct keeps its legacy denominator (tasks);
    // clean_pct_known excludes UNKNOWN-outcome tasks so the rate is honest about
    // what could actually be read.
    unknown_tasks: p.unknown,
    clean_pct_known: p.tasks - p.unknown > 0 ? Math.round((p.clean / (p.tasks - p.unknown)) * 1000) / 10 : null,
  }));
  writeCsv(join(dir, "outcomes_by_pair.csv"),
    ["squad", "agent_key", "canonical_role", "model", "model_bare", "tasks", "clean_pct",
      "avg_rounds", "blocker_rate", "cost_usd", "cost_per_clean_task", "sample_size_flag",
      "unknown_tasks", "clean_pct_known"], pairRows);

  const usageRows = usageByRoleModel(db).map((r) => ({ ...r, model_bare: bareModel(r.model) }));
  writeCsv(join(dir, "usage_by_role_model.csv"),
    ["squad", "agent_key", "canonical_role", "model", "model_bare", "week_start", "turns",
      "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd",
      "distinct_tasks", "distinct_runs"],
    usageRows);

  const taskDelegationRowsData = taskDelegationRows(db);
  writeCsv(join(dir, "task_delegations.csv"),
    ["task_id", "squad", "agent_key", "canonical_role", "model", "model_bare", "turns",
      "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd"],
    taskDelegationRowsData);

  db.close();
  return {
    outcomesByTask: taskRows.length,
    outcomesByPair: pairRows.length,
    usageByRoleModel: usageRows.length,
    taskDelegations: taskDelegationRowsData.length,
    dir,
  };
}

function main() {
  if (CSV_DIR) {
    const outDir = resolve(CSV_DIR);
    const summary = buildCsvExports(outDir);
    console.log(`\n[delegation-outcomes] CSV -> ${summary.dir}`);
    console.log(`  outcomes_by_task.csv    (${summary.outcomesByTask} wierszy)`);
    console.log(`  outcomes_by_pair.csv    (${summary.outcomesByPair} wierszy)`);
    console.log(`  usage_by_role_model.csv (${summary.usageByRoleModel} wierszy)`);
    console.log(`  task_delegations.csv    (${summary.taskDelegations} wierszy)\n`);
    return;
  }

  const result = computeOutcomes();
  if (!result) {
    console.error("[delegation-outcomes] brak plików w .state/reviews/ — nie ma z czego liczyć");
    process.exit(1);
  }
  const { tasksWithVerdict, matched, unmatched, byTask, byPair } = result;
  const taskOutcomes = new Map(byTask.map((t) => [t.taskId, t]));
  const pair = new Map(byPair.map((p) => [`${p.agent}|${p.model}`, p]));

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n  Zadania z werdyktem REVIEW: ${taskOutcomes.size}  ·  dopasowane do delegacji: ${matched}  ·  bez delegacji w telemetrii: ${unmatched}\n`);

  if (BY_TASK) {
    console.log("  zadanie      rund  zwrotów  blokerów  issues  czysto?  werdykt");
    console.log("  " + "─".repeat(74));
    for (const t of [...taskOutcomes.values()].sort((a, b) => b.rounds - a.rounds || a.taskId.localeCompare(b.taskId))) {
      const clean = t.firstPassClean === null ? "?" : t.firstPassClean ? "tak" : "nie";
      console.log(`  ${t.taskId.padEnd(12)} ${String(t.rounds).padStart(4)} ${String(t.returned).padStart(8)} ${String(t.blockers).padStart(9)} ${String(t.issues).padStart(7)}  ${clean.padEnd(7)}  ${t.outcome}${t.roundsOnly ? "   (tylko licznik)" : ""}`);
    }
    console.log("");
    return;
  }

  const rows = [...pair.values()].filter(p => p.tasks > 0).sort((a, b) => b.tasks - a.tasks);
  console.log("  rola DEV            model                        zadań  czysto  śr.rund  z blokerem   koszt");
  console.log("  " + "─".repeat(96));
  for (const p of rows) {
    const cleanPct = ((p.clean / p.tasks) * 100).toFixed(0) + "%";
    console.log(
      `  ${p.agent.padEnd(20)}${(p.model || "?").padEnd(29)}` +
      `${String(p.tasks).padStart(5)}${cleanPct.padStart(8)}${(p.rounds / p.tasks).toFixed(1).padStart(9)}` +
      `${String(p.blockers).padStart(12)}${("$" + p.usd.toFixed(2)).padStart(9)}`,
    );
  }
  console.log(`\n  „czysto" = review przeszedł za pierwszym razem bez zwrotu. Tylko role DEV —`);
  console.log(`  to one wytwarzają kod, który REVIEW ocenia.`);
  console.log(`\n  OGRANICZENIE: werdykt zadania przypisywany jest KAŻDEJ roli DEV, która go`);
  console.log(`  dotknęła. Gdy recon i implementer pracowali nad tym samym zadaniem, oba dostają`);
  console.log(`  ten sam wynik — nie wiadomo, które spowodowało zwrot. Do rozróżnienia trzeba`);
  console.log(`  powiązać findings review z plikami, a pliki z konkretną delegacją.`);
  console.log(`  Przy próbce rzędu kilku zadań to sygnał do obserwacji, nie werdykt o modelu.`);

  const unknownTasks = byTask.filter((t) => t.outcome === "UNKNOWN").sort((a, b) => a.taskId.localeCompare(b.taskId));
  if (unknownTasks.length) {
    console.log(`\n  WERDYKT NIEZNANY: ${unknownTasks.length} z ${taskOutcomes.size} zadań — brak jawnego werdyktu w plikach rund:`);
    for (const t of unknownTasks.slice(0, 10)) {
      console.log(`    ${t.taskId.padEnd(12)} ${(t.unknownReasons || []).join(", ") || "—"}`);
    }
    if (unknownTasks.length > 10) console.log(`    … i ${unknownTasks.length - 10} więcej (--json poda pełną listę)`);
  }
  console.log(`\n  ZASADA (FOC-218): „czysto" i werdykt pochodzą z jawnie oznaczonej linii werdyktu`);
  console.log(`  w pliku rundy (Verdict / **Status:** / sekcja werdyktu — skan całego pliku, nie`);
  console.log(`  pierwszych 2000 znaków). Plik bez rozpoznawalnego werdyktu to UNKNOWN — nigdy`);
  console.log(`  domyślny PASS. Powody UNKNOWN i sprzeczności: parseAnomalies w --json.\n`);
}

// Only run the CLI when executed directly. telemetry-server imports
// computeOutcomes() from here; without this guard every server start would print
// the whole report to stdout.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
