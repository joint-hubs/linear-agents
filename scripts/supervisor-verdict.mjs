#!/usr/bin/env node
// scripts/supervisor-verdict.mjs — a REVIEW verdict has to cite something.
//
//   node scripts/supervisor-verdict.mjs record --child <id> --verdict pass|fail
//        [--finding '<json>' ...] [--ac '<json>' ...] [--failing-test <id> ...]
//   node scripts/supervisor-verdict.mjs show --task <id> [--round N]
//   node scripts/supervisor-verdict.mjs list
//
// WHY (FOC-163). Today a REVIEW verdict rests on the reviewer having read a diff.
// Nothing checks that. "Looks fine" and "I traced every caller" produce the same
// record, and the second dev↔review round is cut off by a counter that does not
// know whether anything improved.
//
// This makes two things schema requirements rather than prompt advice:
//
//   1. EVERY finding cites an artefact — a symbol or path from the code graph
//      (`codegraph_impact` gives the blast radius), or the specific AC it maps
//      to. An uncited finding is refused by name, and the child is asked to
//      ground it. A reviewer who cannot say WHERE has not reviewed.
//
//   2. An APPROVE carries an AC-by-AC mapping. "Approved" then means "each
//      acceptance criterion, with the evidence that it holds" instead of "no
//      objections occurred to me". Absence of objection is not evidence, and it
//      is the failure mode an unaided approve path produces by default.
//
// And it records a PROGRESS FINGERPRINT: the diff against the round's base plus
// the declared failing-test set. supervisor-followup.mjs compares consecutive
// rounds and refuses to spawn a third identical one — a round that reproduces
// its predecessor's diff and failures is the first round billed twice.
//
// Placeholder evidence ("n/a", "-", "TODO") is refused too. A requirement that
// can be satisfied by typing a dash is not a requirement; the cheapest way past
// this gate has to be actually looking.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  ROOT,
  asArray,
  ensureRunDir,
  failJson,
  parseArgs,
  progressFingerprint,
  readRegistry,
  verdictPath,
  verdictsDir,
} from "./supervisor-lib.mjs";
import { atomicWriteJSON } from "./utils.mjs";

const VERDICTS = ["pass", "fail"];
const SEVERITIES = ["issue", "todo", "nit", "question", "praise"];

// The cheap ways to satisfy "cite something" without citing anything. Checked
// after trimming and lowercasing.
const NON_EVIDENCE = ["", "-", "--", "n/a", "na", "none", "todo", "tbd", "?", "see above", "obvious"];

const REPEATABLE = new Set(["finding", "ac", "failing-test"]);

const isEvidence = (v) => {
  const s = String(v ?? "").trim();
  if (NON_EVIDENCE.includes(s.toLowerCase())) return false;
  // Three characters is not a citation either. `codegraph_impact` output, a
  // path:line, or an AC id all clear this comfortably.
  return s.length >= 4;
};

function parseJsonFlag(raw, flag, index) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      failJson(`--${flag} #${index + 1} must be a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`);
    }
    return parsed;
  } catch (err) {
    failJson(`--${flag} #${index + 1} is not readable JSON: ${err.message}`, {
      hint: `example: --${flag} '{"text":"...","evidence":"scripts/foo.mjs:42 resolvePrice"}'`,
    });
  }
}

// ── the acceptance criteria this verdict has to cover ────────────────────────

/**
 * How many AC blocks does the issue declare? The repo writes them as
 * `**Given** … **When** … **Then**`, so counting `**Given**` counts criteria.
 *
 * Returns null when the issue cannot be read. That is UNKNOWN, and an unknown
 * count must not be treated as zero — zero would mean "an approve needs no
 * mapping", which is the exact hole this task exists to close.
 */
function acCount(taskId, args) {
  let body = null;
  if (args["issue-file"] && args["issue-file"] !== true) {
    try {
      const parsed = JSON.parse(readFileSync(args["issue-file"], "utf8"));
      body = (parsed.issue ?? parsed)?.description ?? null;
    } catch {
      return null;
    }
  } else if (taskId) {
    try {
      const out = execFileSync(
        process.execPath,
        [join(ROOT, "scripts", "linear-query.mjs"), "issue", taskId, "--json"],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      body = JSON.parse(out)?.description ?? null;
    } catch {
      return null;
    }
  }
  if (!body) return null;
  const matches = body.match(/\*\*Given\*\*/g);
  return matches ? matches.length : 0;
}

// ── rounds ───────────────────────────────────────────────────────────────────

function roundsFor(runId, taskId) {
  const dir = verdictsDir(runId);
  if (!existsSync(dir)) return [];
  const prefix = `${String(taskId).toLowerCase()}-round`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        return { round: Number(f.slice(prefix.length, -5)) || 0, unreadable: true };
      }
    })
    .sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
}

export function latestVerdict(runId, taskId) {
  const all = roundsFor(runId, taskId);
  return all.length ? all[all.length - 1] : null;
}

// ── record ───────────────────────────────────────────────────────────────────

function cmdRecord(args) {
  const runId = requireRun(args);
  const childId = args.child;
  if (!childId || childId === true) failJson("--child <childId> is required");

  const registry = readRegistry(runId);
  const entry = registry.children[childId];
  if (!entry) {
    failJson(`no child "${childId}" in run ${runId}`, { known: Object.keys(registry.children) });
  }

  const verdict = args.verdict;
  if (!VERDICTS.includes(verdict)) failJson(`--verdict must be one of ${VERDICTS.join(" | ")}`);

  const taskId = args.task && args.task !== true ? args.task : entry.taskId;
  if (!taskId) failJson("no taskId on the child and none given — a verdict has to be about something");

  // ── findings, each cited ───────────────────────────────────────────────────
  const findings = asArray(args.finding).map((raw, i) => parseJsonFlag(raw, "finding", i));

  const uncited = [];
  findings.forEach((f, i) => {
    if (!String(f.text ?? "").trim()) uncited.push(`finding #${i + 1} has no text`);
    else if (!isEvidence(f.evidence)) {
      uncited.push(`finding #${i + 1} ("${String(f.text).slice(0, 60)}") cites ${JSON.stringify(f.evidence ?? null)}`);
    }
    if (f.severity && !SEVERITIES.includes(f.severity)) {
      uncited.push(`finding #${i + 1} has severity "${f.severity}" (expected ${SEVERITIES.join(" | ")})`);
    }
  });

  if (uncited.length) {
    failJson(`this verdict has ${uncited.length} uncited finding(s) — send it back to be grounded`, {
      uncited,
      hint:
        "every finding names WHERE: a symbol or path from the code graph (codegraph_impact gives the " +
        "blast radius), or the AC it maps to. A reviewer who cannot say where has not reviewed.",
    });
  }

  // ── an approve has to map the ACs ──────────────────────────────────────────
  const acMapping = asArray(args.ac).map((raw, i) => parseJsonFlag(raw, "ac", i));
  const acProblems = [];
  acMapping.forEach((m, i) => {
    if (!String(m.ac ?? "").trim()) acProblems.push(`--ac #${i + 1} names no criterion`);
    else if (!isEvidence(m.evidence)) {
      acProblems.push(`--ac #${i + 1} (${m.ac}) cites ${JSON.stringify(m.evidence ?? null)}`);
    }
  });
  if (acProblems.length) failJson(`the AC mapping is not grounded`, { problems: acProblems });

  const declared = acCount(taskId, args);
  const warnings = [];

  if (verdict === "pass") {
    if (!acMapping.length) {
      failJson(
        `an approve needs an AC-by-AC mapping — "approved" has to be a claim with a trail, not an absence of objections`,
        {
          taskId,
          declaredAcs: declared,
          hint: `--ac '{"ac":"AC-1","evidence":"scripts/foo.test.mjs:120 asserts it"}' once per criterion`,
        },
      );
    }
    if (declared !== null && acMapping.length < declared) {
      failJson(`${taskId} declares ${declared} acceptance criteria and the mapping covers ${acMapping.length}`, {
        taskId,
        declaredAcs: declared,
        mapped: acMapping.length,
        mappedIds: acMapping.map((m) => m.ac),
        hint: "a partial mapping approves the criteria nobody looked at",
      });
    }
    if (declared === null) {
      // Refusing here would make Linear being down block a legitimate approve.
      // Saying so out loud is the honest middle: the mapping exists, its
      // completeness is unverified, and the record says which.
      warnings.push(
        `could not read ${taskId} from Linear, so the mapping's COMPLETENESS is unverified — ` +
          `${acMapping.length} criteria mapped, against an unknown total`,
      );
    }
    const blocking = findings.filter((f) => (f.severity ?? "issue") === "issue");
    if (blocking.length) {
      failJson(`a pass cannot carry ${blocking.length} blocking issue finding(s)`, {
        blocking: blocking.map((f) => f.text),
        hint: 'either the verdict is fail, or those findings are severity "nit"/"question"',
      });
    }
  }

  // ── the fingerprint ────────────────────────────────────────────────────────
  const failingTests = asArray(args["failing-test"]).map(String);
  if (verdict === "fail" && !failingTests.length) {
    // Not fatal — a review can fail on design, not only on a red test — but a
    // fail with no failing test makes the fingerprint depend on the diff alone,
    // and two rounds that fix nothing then look identical for the wrong reason.
    warnings.push(
      "a fail with no --failing-test fingerprints on the diff alone; declare the failures if there are any",
    );
  }

  const fingerprint = progressFingerprint({
    worktree: entry.worktree,
    baseRevision: entry.baseRevision,
    failingTests,
  });
  if (fingerprint.error) warnings.push(`fingerprint is UNKNOWN: ${fingerprint.error}`);

  const prior = latestVerdict(runId, taskId);
  const round = Number(args.round ?? (prior?.round ?? 0) + 1);

  const record = {
    taskId,
    runId,
    childId,
    squad: entry.squad ?? null,
    round,
    verdict,
    findings,
    acMapping,
    declaredAcs: declared,
    fingerprint,
    recordedAt: new Date().toISOString(),
  };

  const path = verdictPath(runId, taskId, round);
  if (existsSync(path) && !args.force) {
    failJson(`round ${round} of ${taskId} is already recorded — a verdict is recorded once`, {
      path,
      hint: "record the next round, or pass --force if this is deliberately a correction",
    });
  }

  ensureRunDir(runId);
  mkdirSync(verdictsDir(runId), { recursive: true });
  atomicWriteJSON(path, record);

  for (const w of warnings) console.error(`[verdict] ${w}`);
  console.log(JSON.stringify({ ok: true, path, warnings, ...record }, null, 2));
}

// ── show / list ──────────────────────────────────────────────────────────────

function cmdShow(args) {
  const runId = requireRun(args);
  const taskId = args.task;
  if (!taskId || taskId === true) failJson("--task <id> is required");

  const all = roundsFor(runId, taskId);
  if (!all.length) failJson(`no verdicts recorded for ${taskId} in run ${runId}`);

  const wanted = args.round ? all.filter((v) => String(v.round) === String(args.round)) : all;
  console.log(JSON.stringify({ ok: true, taskId, rounds: wanted.length, verdicts: wanted }, null, 2));
}

function cmdList(args) {
  const runId = requireRun(args);
  const dir = verdictsDir(runId);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

  const byTask = new Map();
  for (const f of files) {
    try {
      const v = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const list = byTask.get(v.taskId) ?? [];
      list.push({ round: v.round, verdict: v.verdict, fingerprint: v.fingerprint?.combined ?? null, findings: v.findings?.length ?? 0 });
      byTask.set(v.taskId, list);
    } catch {
      /* a malformed file must not hide the well-formed ones */
    }
  }

  const tasks = [...byTask.entries()].map(([taskId, rounds]) => {
    rounds.sort((a, b) => a.round - b.round);
    const last = rounds[rounds.length - 1];
    const prev = rounds.length > 1 ? rounds[rounds.length - 2] : null;
    return {
      taskId,
      rounds,
      // The signal that replaced the counter. `null` = cannot tell, and that is
      // NOT the same as "no progress" — see comparableProgress in supervisor-lib.
      repeatedLastRound:
        prev && last.fingerprint && prev.fingerprint ? last.fingerprint === prev.fingerprint : null,
    };
  });

  console.log(JSON.stringify({ ok: true, runId, tasks }, null, 2));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function requireRun(args) {
  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  if (!runId || runId === true) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");
  return runId;
}

function main() {
  const args = parseArgs(process.argv.slice(2), REPEATABLE);
  const cmd = args._[0];

  if (cmd === "record") return cmdRecord(args);
  if (cmd === "show") return cmdShow(args);
  if (cmd === "list") return cmdList(args);

  failJson(`unknown subcommand "${cmd ?? ""}" — expected record | show | list`);
}

export { VERDICTS, SEVERITIES, isEvidence, roundsFor };

if (process.argv[1]?.endsWith("supervisor-verdict.mjs")) main();
