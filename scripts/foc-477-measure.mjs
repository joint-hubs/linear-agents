#!/usr/bin/env node
// scripts/foc-477-measure.mjs — FOC-477 measurement tabulator.
//
// Paired replay: PLAN graph (arm A) vs historical PLAN squad (arm B), per the
// frozen protocol docs/plans/foc-477-measurement-protocol.md (CONFIRMED
// 2026-10-07, Q1=A go/no-go rule; amended Q3 2026-10-07: the study runs on
// TWO axes — cost and time; body-delta quality is withdrawn as an axis and
// gate friction becomes a per-pair descriptive derived from run state).
//
// Reproducer (protocol §4.1):
//   node scripts/foc-477-measure.mjs --runs docs/research/foc-477-runs.json
//
// Output: JSON on stdout — one row per corpus pair plus the aggregate
// go/no-go (GO | NO-GO | INCONCLUSIVE) and the mandatory per-axis
// win/draw/loss table (protocol §5).
//
// Cost is `costUsd` only. `costUsdReported` is never read, computed or
// emitted (protocol §4.1 and §9 — it is FOC-165 evidence, not a metric).
//
// Exit codes: 0 on success (including pairs with missing arms), 2 on
// malformed input — unparseable JSON or missing required fields, in the
// corpus or in any children.json run data it points at.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class InputError extends Error {}

// ---------------------------------------------------------------------------
// Pure helpers (no filesystem) — the test file drives these directly.
// ---------------------------------------------------------------------------

export function median(values) {
  const xs = (values ?? [])
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function round(value, digits) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function ratioAB(a, b) {
  if (typeof a !== "number" || !Number.isFinite(a)) return null;
  if (typeof b !== "number" || !Number.isFinite(b) || b === 0) return null;
  return round(a / b, 3);
}

// --- corpus ----------------------------------------------------------------

// runId is joined into a filesystem path (children.json lookup) — restrict it
// to the supervisor run-id shape before it ever touches the path.
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

export function parseCorpus(text, warn) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new InputError(`corpus is not valid JSON (${e.message})`);
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.corpus)) {
    throw new InputError('corpus must be an object with a "corpus" array');
  }
  doc.corpus.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new InputError(`corpus[${i}] is not an object`);
    }
    if (typeof entry.issue !== "string" || !entry.issue) {
      throw new InputError(`corpus[${i}]: "issue" is required`);
    }
    const armB = entry.armB;
    if (
      !armB || typeof armB !== "object" ||
      typeof armB.runId !== "string" || !armB.runId ||
      typeof armB.childId !== "string" || !armB.childId
    ) {
      throw new InputError(
        `corpus[${i}] (${entry.issue}): armB { runId, childId } is required`,
      );
    }
    if (!RUN_ID_RE.test(armB.runId)) {
      throw new InputError(
        `corpus[${i}] (${entry.issue}): armB.runId "${armB.runId}" has characters outside [A-Za-z0-9._-]`,
      );
    }
    if (entry.armA != null) {
      if (typeof entry.armA !== "object" || typeof entry.armA.runId !== "string" || !entry.armA.runId) {
        throw new InputError(
          `corpus[${i}] (${entry.issue}): armA, when present, must carry a runId`,
        );
      }
      if (!RUN_ID_RE.test(entry.armA.runId)) {
        throw new InputError(
          `corpus[${i}] (${entry.issue}): armA.runId "${entry.armA.runId}" has characters outside [A-Za-z0-9._-]`,
        );
      }
    }
    // gateFriction (protocol §5, Q3 amendment): optional non-negative integer
    // per arm. Absent/null = "no data" — stays null downstream, never coerced
    // to 0; an explicit 0 is a real value.
    for (const [armName, arm] of [["armB", armB], ["armA", entry.armA]]) {
      const gf = arm?.gateFriction;
      if (gf == null) continue;
      if (!Number.isInteger(gf) || gf < 0) {
        throw new InputError(
          `corpus[${i}] (${entry.issue}): ${armName}.gateFriction must be a non-negative integer (got ${JSON.stringify(gf)})`,
        );
      }
    }
  });
  const seenIssues = new Set();
  for (const entry of doc.corpus) {
    if (seenIssues.has(entry.issue)) {
      warn?.(`corpus: duplicate issue ${entry.issue} — both rows are tabulated`);
    }
    seenIssues.add(entry.issue);
  }
  return doc;
}

// --- arm extraction from a parsed children.json ----------------------------

// Wall time from a child's turns[]: exec = sum of turn spans; gate-wait = sum
// of the gaps BETWEEN turns (reported in its own column, excluded from exec —
// protocol §4.2). Queue time is not derivable: children.json carries no
// child-level start timestamp, so it is reported as null rather than dropped
// into another column. Turns without parseable timestamps are skipped for
// time math but never affect cost. Seconds are raw here; rounding to the
// published precision happens once, at serialization (roundForDisplay).
export function childWallTime(turns) {
  if (!Array.isArray(turns)) {
    return { totalSec: null, queueSec: null, execSec: null, gateWaitSec: null };
  }
  let execMs = 0;
  let gapMs = 0;
  let firstStart = null;
  let prevEnd = null;
  for (const turn of turns) {
    const s = Date.parse(turn?.startedAt);
    const e = Date.parse(turn?.endedAt);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (firstStart === null || s < firstStart) firstStart = s;
    if (prevEnd !== null && s > prevEnd) gapMs += s - prevEnd;
    execMs += Math.max(0, e - s);
    prevEnd = prevEnd === null ? e : Math.max(prevEnd, e);
  }
  if (firstStart === null) {
    return { totalSec: null, queueSec: null, execSec: null, gateWaitSec: null };
  }
  return {
    totalSec: (prevEnd - firstStart) / 1000,
    queueSec: null,
    execSec: execMs / 1000,
    gateWaitSec: gapMs / 1000,
  };
}

// Locate a child inside a parsed children.json. `childId` null picks the
// first child (used for arm-A runs where the corpus may not pin a child).
// Only `costUsd` is read — `costUsdReported` is deliberately untouched.
export function extractArmFromChildren(parsed, { childId = null, warn } = {}) {
  if (!parsed || typeof parsed !== "object" || !parsed.children || typeof parsed.children !== "object") {
    throw new InputError('children.json has no "children" object');
  }
  const children = Object.values(parsed.children);
  if (!children.length) return { status: "missing-child" };
  if (!childId && children.length > 1) {
    warn?.(`children.json ${parsed.runId ?? "(no runId)"} has ${children.length} children and no childId pinned — using the first (${children[0].childId ?? "?"})`);
  }
  const child = childId
    ? parsed.children[childId] ?? null
    : children[0];
  if (!child) return { status: "missing-child" };
  return {
    status: "ok",
    runId: parsed.runId ?? null,
    childId: child.childId ?? childId,
    taskId: child.taskId ?? null,
    squad: child.squad ?? null,
    childStatus: child.status ?? null,
    costUsd: typeof child.costUsd === "number" && Number.isFinite(child.costUsd) ? child.costUsd : null,
    turns: Array.isArray(child.turns) ? child.turns.length : null,
    wallTime: childWallTime(child.turns),
  };
}

// --- go/no-go rule (protocol §5, amended Q3 2026-10-07: two axes) -----------

// One axis: win = A < B × 0.85; loss = A > B × 1.05; between = draw.
// Null when either median is unavailable (not enough arm-A data).
export function decideAxis(medianA, medianB) {
  if (medianA == null || medianB == null) return null;
  if (medianA < medianB * 0.85) return "win";
  if (medianA > medianB * 1.05) return "loss";
  return "draw";
}

// Verdict (protocol §5, amended Q3 2026-10-07): the study runs on TWO axes —
// cost and time. GO iff both axes are win AND zero axes are in regression
// > 5% (with two axes, both-win already means zero regressions); NO-GO
// otherwise, and NO-GO always carries a contract-delta list (§6).
// INCONCLUSIVE ONLY when cost or timeExec could not be computed (a null
// median). The withdrawn body-delta axis and gate friction never enter the
// decision and never cause INCONCLUSIVE.
export function decide(axes) {
  const cost = axes?.cost;
  const timeExec = axes?.timeExec;
  if (cost == null || timeExec == null) return "INCONCLUSIVE";
  return cost === "win" && timeExec === "win" ? "GO" : "NO-GO";
}

// --- pair metrics -----------------------------------------------------------

// One row per corpus entry. `armA`/`armB` are resolved arm objects (or the
// literal { status: "pending" } / { status: "missing" }). Quality is the
// withdrawn body-delta descriptive (Q3 amendment 2026-10-07): reported when
// both arms carry it, never an axis, never in the verdict. Gate friction is
// attached by tabulate (corpus literal, else derived from run state) and
// rides on each arm as a descriptive.
export function pairRow(entry, armA, armB) {
  // Optional-chain the metric fields so a future arm producer that forgets
  // one degrades to a null metric, never a TypeError.
  const costA = armA?.status === "ok" ? armA.costUsd : null;
  const costB = armB?.status === "ok" ? armB.costUsd : null;
  const execA = armA?.status === "ok" ? armA.wallTime?.execSec ?? null : null;
  const execB = armB?.status === "ok" ? armB.wallTime?.execSec ?? null : null;
  const editsA = armA?.status === "ok" ? armA.bodyDelta?.editCount ?? null : null;
  const editsB = armB?.status === "ok" ? armB.bodyDelta?.editCount ?? null : null;
  return {
    issue: entry.issue,
    estimate: entry.estimate ?? null,
    shape: entry.shape ?? null,
    armA: armOut(entry.armA ?? null, armA),
    armB: armOut(entry.armB, armB),
    metrics: {
      costRatioAB: ratioAB(costA, costB),
      execTimeRatioAB: ratioAB(execA, execB),
      qualityDelta:
        editsA != null && editsB != null ? { editCount: editsA - editsB } : null,
      escalations: armA?.status === "ok" ? armA.escalations : null,
      gateAgreement: armA?.status === "ok" ? armA.gateAgreement : null,
    },
  };
}

// `entryArm` is the corpus's arm descriptor for THIS arm (entry.armA or
// entry.armB) — a non-ok arm still carries the runId/childId the corpus
// named. Values are kept raw here; rounding to the published precision
// happens once, at serialization (roundForDisplay), so aggregate medians
// are computed from raw numbers, never from already-rounded ones.
function armOut(entryArm, arm) {
  if (arm?.status === "ok") {
    return {
      status: "ok",
      runId: arm.runId,
      childId: arm.childId,
      childStatus: arm.childStatus,
      costUsd: arm.costUsd,
      turns: arm.turns,
      wallTime: arm.wallTime,
      bodyDelta: arm.bodyDelta,
      gateFriction: arm.gateFriction ?? null,
    };
  }
  return {
    status: arm?.status ?? "pending",
    runId: entryArm?.runId ?? null,
    childId: arm?.childId ?? entryArm?.childId ?? null,
    childStatus: null,
    costUsd: null,
    turns: null,
    wallTime: { totalSec: null, queueSec: null, execSec: null, gateWaitSec: null },
    bodyDelta: { editCount: null, charDelta: null },
    gateFriction: arm?.gateFriction ?? null,
  };
}

// --- aggregate ---------------------------------------------------------------

export function aggregate(pairs) {
  const ok = (arm) => pairs.filter((p) => p[arm].status === "ok");
  const aRows = ok("armA");
  const bRows = ok("armB");

  // Medians run on the raw row values; serialization rounding happens
  // afterwards (roundForDisplay) so it can never feed back into the math.
  const medianA = median(aRows.map((p) => p.armA.costUsd));
  const medianB = median(bRows.map((p) => p.armB.costUsd));
  const medianExecA = median(aRows.map((p) => p.armA.wallTime?.execSec ?? null));
  const medianExecB = median(bRows.map((p) => p.armB.wallTime?.execSec ?? null));
  const medianQualA = median(aRows.map((p) => p.armA.bodyDelta?.editCount ?? null));
  const medianQualB = median(bRows.map((p) => p.armB.bodyDelta?.editCount ?? null));
  const medianQualDelta = median(pairs.map((p) => p.metrics.qualityDelta?.editCount ?? null));
  // Gate friction (Q3 amendment): a descriptive — median per arm, no axis,
  // never in the verdict. Runs over ALL pairs, not just ok arms: the value
  // derives from the run's gates/ directory and survives a degraded
  // children.json.
  const medianGateA = median(pairs.map((p) => p.armA.gateFriction ?? null));
  const medianGateB = median(pairs.map((p) => p.armB.gateFriction ?? null));

  const axes = {
    cost: decideAxis(medianA, medianB),
    timeExec: decideAxis(medianExecA, medianExecB),
  };

  return {
    pairs: pairs.length,
    pairsArmAOk: aRows.length,
    pairsArmBOk: bRows.length,
    cost: { medianA, medianB, ratioAB: ratioAB(medianA, medianB) },
    timeExec: { medianA: medianExecA, medianB: medianExecB, ratioAB: ratioAB(medianExecA, medianExecB) },
    quality: {
      medianA: medianQualA === null ? null : { editCount: medianQualA },
      medianB: medianQualB === null ? null : { editCount: medianQualB },
      delta: medianQualDelta === null ? null : { editCount: medianQualDelta },
    },
    gateFriction: { medianA: medianGateA, medianB: medianGateB },
    escalations: mergeEscalations(pairs.map((p) => p.metrics.escalations)),
    gateAgreement: mergeGateAgreement(pairs.map((p) => p.metrics.gateAgreement)),
    axes,
    rule: "GO iff both axes are win AND zero axes are in regression > 5%. NO-GO otherwise, and NO-GO always carries a contract-delta list (§6). win: medianA < medianB * 0.85; loss: medianA > medianB * 1.05; between: draw (reportable, never a win)",
    verdict: decide(axes),
  };
}

function mergeEscalations(list) {
  const present = list.filter(Boolean);
  if (!present.length) return null;
  const byReason = {};
  let total = 0;
  for (const esc of present) {
    for (const [reason, count] of Object.entries(esc.byReason ?? {})) {
      byReason[reason] = (byReason[reason] ?? 0) + count;
      total += count;
    }
  }
  return { total, byReason };
}

function mergeGateAgreement(list) {
  const present = list.filter(Boolean);
  if (!present.length) return null;
  let agreed = 0;
  let total = 0;
  for (const g of present) {
    agreed += g.agreed ?? 0;
    total += g.total ?? 0;
  }
  return total ? { agreed, total, rate: round(agreed / total, 3) } : null;
}

// ---------------------------------------------------------------------------
// I/O layer
// ---------------------------------------------------------------------------

// Arm-A and arm-B run directories live under a supervisor root
// (.state/supervisor/<runId>/children.json). Arm A does not exist yet
// (protocol §8 step 3) — its absence is a normal state, not an error.
export function loadArmFromDisk(runRoot, runId, childId, { warn } = {}) {
  if (!runRoot) return { status: "missing", runId };
  const childrenPath = join(runRoot, runId, "children.json");
  if (!existsSync(childrenPath)) {
    return { status: "missing", runId };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(childrenPath, "utf8"));
  } catch (e) {
    throw new InputError(`${childrenPath} is not valid JSON (${e.message})`);
  }
  const arm = extractArmFromChildren(parsed, { childId, warn });
  if (arm.status !== "ok") return { ...arm, runId };
  // Optional per-run decision log (escalations + gate agreement). Absent
  // today — null, never fabricated.
  const decisions = readDecisions(join(runRoot, runId), { warn });
  return {
    ...arm,
    bodyDelta: { editCount: null, charDelta: null },
    escalations: decisions?.escalations ?? null,
    gateAgreement: decisions?.gateAgreement ?? null,
  };
}

// Optional <runDir>/decisions.json — an array of decision records. Two
// optional shapes are read: { decision: "escalated", reason } for
// escalations (protocol §4.4) and { asked, answered } pairs for gate
// agreement (protocol §4.5). A file that exists but is unparseable warns on
// stderr and is treated as absent (optional data, never a crash).
function readDecisions(runDir, { warn } = {}) {
  const path = join(runDir, "decisions.json");
  if (!existsSync(path)) return null;
  let records;
  try {
    records = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    warn?.(`${path} is not valid JSON (${e.message}) — treated as absent`);
    return null;
  }
  if (!Array.isArray(records)) return null;
  const byReason = {};
  let asked = 0;
  let answeredMatch = 0;
  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.decision === "escalated") {
      const reason = typeof rec.reason === "string" && rec.reason ? rec.reason : "unspecified";
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
    if (typeof rec.asked === "string" && typeof rec.answered === "string") {
      asked += 1;
      if (rec.asked === rec.answered) answeredMatch += 1;
    }
  }
  return {
    escalations: Object.keys(byReason).length ? { total: Object.values(byReason).reduce((a, b) => a + b, 0), byReason } : { total: 0, byReason },
    gateAgreement: asked ? { agreed: answeredMatch, total: asked, rate: round(answeredMatch / asked, 3) } : null,
  };
}

// Gate-friction derivation (protocol §5, Q3 amendment): count the plan gates
// a run actually produced, from its <runId>/gates/ directory — the same
// derivation path for both arms so the comparison is symmetric. Arm A (plan
// graph): records whose `kind` is "plan.gate1" or "draft-approval". Arm B
// (squad): records whose `gateId` names the plan child ("gate-plan-*").
// Implementation-review verdicts live in a sibling verdicts/ directory and
// are never read here — they review the code, not the plan, and real runs
// hold up to a dozen of them. No gates directory (or an unreadable one) →
// null: an honest "no data", never 0, never a crash.
function gateRecordMatches(rec, arm) {
  if (!rec || typeof rec !== "object") return false;
  if (arm === "A") return rec.kind === "plan.gate1" || rec.kind === "draft-approval";
  return typeof rec.gateId === "string" && /^gate-plan-/.test(rec.gateId);
}

export function deriveGateFriction(runDir, { arm, warn } = {}) {
  if (!runDir || (arm !== "A" && arm !== "B")) return null;
  const gatesDir = join(runDir, "gates");
  let names;
  try {
    names = readdirSync(gatesDir);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      warn?.(`cannot read ${gatesDir} (${e.message}) — gate friction reported as null`);
    }
    return null;
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(gatesDir, name), "utf8"));
    } catch (e) {
      warn?.(`${join(gatesDir, name)} is not valid JSON (${e.message}) — excluded from the gate-friction count`);
      continue;
    }
    if (gateRecordMatches(rec, arm)) count += 1;
  }
  return count;
}

// Default supervisor root for this repo layout. The worktree has no .state/
// — the data lives in the main checkout, reachable through the worktree's
// .git pointer (gitdir: <main>/.git/worktrees/<name>). Falls back to the
// tree this script runs from (covers running inside the main checkout).
export function resolveDefaultSupervisorDir(root = SCRIPT_ROOT) {
  const candidates = [];
  const gitPath = join(root, ".git");
  try {
    if (existsSync(gitPath)) {
      let mainRoot = null;
      if (statSync(gitPath).isDirectory()) {
        mainRoot = root;
      } else {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, "utf8"));
        if (m) {
          let gitDir = resolve(dirname(gitPath), m[1].trim());
          // climb to the .git dir; stop at the filesystem root too, so a
          // pointer naming a path without a .git component cannot loop forever
          while (gitDir && basename(gitDir) !== ".git" && dirname(gitDir) !== gitDir) {
            gitDir = dirname(gitDir);
          }
          if (gitDir && basename(gitDir) === ".git") mainRoot = dirname(gitDir);
        }
      }
      if (mainRoot) candidates.push(join(mainRoot, ".state", "supervisor"));
    }
  } catch {
    // fall through to the local candidate
  }
  candidates.push(join(root, ".state", "supervisor"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Display rounding: the aggregate math runs on raw values; this rounds each
// row to the published precision exactly once, at serialization. Aggregate
// medians are NOT re-rounded here — they stay raw so the published table and
// the published medians can never disagree about precision.
function roundForDisplay(row) {
  const arm = (a) => {
    if (a.status !== "ok") return a;
    return {
      ...a,
      costUsd: round(a.costUsd, 4),
      wallTime: {
        ...a.wallTime,
        totalSec: round(a.wallTime?.totalSec, 2),
        execSec: round(a.wallTime?.execSec, 2),
        gateWaitSec: round(a.wallTime?.gateWaitSec, 2),
      },
    };
  };
  return { ...row, armA: arm(row.armA), armB: arm(row.armB) };
}

// Provenance without absolute paths: run roots are emitted relative to the
// repo root this script ships in.
function displayPath(dir) {
  if (!dir) return null;
  const rel = relative(SCRIPT_ROOT, dir);
  if (!rel) return ".";
  return rel.split(sep).join("/");
}

export function tabulate({ corpusDoc, supervisorDir, armADir, stateRoot, warn } = {}) {
  const armBRoot = supervisorDir;
  const armARoot = armADir ?? supervisorDir;
  const gatesRoot = stateRoot ?? supervisorDir;
  // Gate friction for one corpus arm (protocol §5, Q3 amendment): a corpus
  // literal wins; without one the value derives from the run's gates/
  // directory; neither source → null. Descriptive only — never an axis,
  // never in the verdict.
  const gateFrictionFor = (entryArm, arm) => {
    if (entryArm?.gateFriction != null) return entryArm.gateFriction;
    if (!entryArm?.runId || !gatesRoot) return null;
    return deriveGateFriction(join(gatesRoot, entryArm.runId), { arm, warn });
  };
  const pairs = corpusDoc.corpus.map((entry) => {
    let armB = loadArmFromDisk(armBRoot, entry.armB.runId, entry.armB.childId, { warn });
    if (armB.status === "ok") {
      if (armB.taskId && armB.taskId !== entry.issue) {
        warn?.(`${entry.issue}: arm-B child ${armB.childId} in run ${armB.runId} records taskId "${armB.taskId}" (corpus mismatch)`);
      }
      if (armB.squad && armB.squad !== "plan") {
        warn?.(`${entry.issue}: arm-B child ${armB.childId} has squad "${armB.squad}", expected "plan"`);
      }
      if (typeof entry.armB.costUsd === "number" && typeof armB.costUsd === "number") {
        const drift = Math.abs(armB.costUsd - entry.armB.costUsd) / Math.abs(entry.armB.costUsd || 1);
        if (drift > 0.01) {
          warn?.(`${entry.issue}: children.json costUsd ${armB.costUsd} drifts >1% from corpus armB.costUsd ${entry.armB.costUsd} — using children.json`);
        }
      }
    }
    let armA;
    if (entry.armA?.runId) {
      armA = loadArmFromDisk(armARoot, entry.armA.runId, entry.armA.childId ?? null, { warn });
    } else {
      armA = { status: "pending" };
    }
    armB = { ...armB, gateFriction: gateFrictionFor(entry.armB, "B") };
    armA = { ...armA, gateFriction: gateFrictionFor(entry.armA ?? null, "A") };
    return pairRow(entry, armA, armB);
  });
  return {
    protocol: corpusDoc.protocol ?? null,
    confirmedAt: corpusDoc.confirmedAt ?? null,
    qualityAxis: corpusDoc.qualityAxis ?? null,
    supervisorDir: displayPath(armBRoot),
    armADir: displayPath(armARoot),
    stateRoot: displayPath(gatesRoot),
    notes: [
      "cost = costUsd only (protocol §4.1); costUsdReported is never read",
      "wall time: queue not recorded in children.json (null); gate-wait = inter-turn gaps, own column, excluded from exec (§4.2)",
      "body delta withdrawn as an axis (Q3 amendment 2026-10-07) — reported as a descriptive only, never in the verdict",
      "gate friction = plan gates per run, derived from <runId>/gates/ (Q3 amendment 2026-10-07) — a descriptive, never an axis, never in the verdict",
      "arm-A runs do not exist yet (§8 step 3) — pending rows are the normal state today",
    ],
    pairs: pairs.map(roundForDisplay),
    aggregate: aggregate(pairs),
  };
}

// ---------------------------------------------------------------------------

function usage() {
  return [
    "Usage: node scripts/foc-477-measure.mjs --runs <corpus.json> [options]",
    "",
    "  --runs <path>          corpus JSON (docs/research/foc-477-runs.json) — required",
    "  --supervisor-dir <dir> supervisor runs root (.state/supervisor); default resolves",
    "                         the main checkout through this worktree's .git pointer",
    "  --arm-a-dir <dir>      root holding arm-A run dirs; defaults to --supervisor-dir",
    "  --state-root <dir>     root holding <runId>/gates/ for gate-friction",
    "                         derivation; defaults to the supervisor runs root",
    "  -h, --help             this text",
    "",
    "Emits the per-pair table + aggregate go/no-go as JSON on stdout.",
  ].join("\n");
}

function fail(message, exitFn) {
  console.error(`foc-477-measure: ${message}`);
  exitFn(2);
}

export function run({ argv = process.argv.slice(2), stdout = console.log, exitFn = process.exit, root = SCRIPT_ROOT } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        runs: { type: "string" },
        "supervisor-dir": { type: "string" },
        "arm-a-dir": { type: "string" },
        "state-root": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    fail(`${e.message}\n\n${usage()}`, exitFn);
    return 2;
  }
  if (values.help) {
    stdout(usage());
    return 0;
  }
  if (!values.runs) {
    fail(`--runs <corpus.json> is required\n\n${usage()}`, exitFn);
    return 2;
  }

  const warnings = [];
  const warn = (message) => {
    warnings.push(message);
    console.error(`foc-477-measure: warning: ${message}`);
  };

  let corpusDoc;
  try {
    corpusDoc = parseCorpus(readFileSync(values.runs, "utf8"), warn);
  } catch (e) {
    if (e instanceof InputError) fail(e.message, exitFn);
    else fail(`cannot read corpus ${values.runs}: ${e.message}`, exitFn);
    return 2;
  }

  const supervisorDir = values["supervisor-dir"] ?? resolveDefaultSupervisorDir(root);
  if (!supervisorDir) {
    warn("no supervisor runs root found — arm-B rows will be flagged missing (pass --supervisor-dir)");
  }

  let output;
  try {
    output = tabulate({
      corpusDoc,
      supervisorDir,
      armADir: values["arm-a-dir"] ?? supervisorDir,
      stateRoot: values["state-root"],
      warn,
    });
  } catch (e) {
    if (e instanceof InputError) fail(e.message, exitFn);
    else fail(`tabulation failed: ${e.message}`, exitFn);
    return 2;
  }
  stdout(JSON.stringify(output, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run());
}
