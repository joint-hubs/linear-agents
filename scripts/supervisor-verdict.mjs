#!/usr/bin/env node
// scripts/supervisor-verdict.mjs — a REVIEW verdict has to cite something.
//
//   node scripts/supervisor-verdict.mjs record --child <id> --verdict pass|fail [--work-child <id>]
//        [--finding '<json>' ...] [--ac '<json>' ...] [--failing-test <id> ...] [--dry-run]
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
//
// On a REVIEW fail (FOC-284) record also PERFORMS review.fail's transition: it
// stamps the `returned-by:review` flag and moves the issue to In Progress via
// linear-ops. The flag is the discriminator the routing rule keys on
// (config/graph.json review-to-dev-return) — bare `In Progress` is also the
// state of work DEV already holds, so without it a return could not be routed.
//
// Ordering (round 2): the verdict file is written BEFORE any Linear op runs,
// carrying statuses "pending"; the ops run; the file is amended with the final
// statuses. No Linear write can happen without a verdict record on disk, and a
// crash in between leaves "pending" on disk — distinct from NO linearEffects,
// which means an old tool wrote the record and said nothing at all.
//
// Enforcement (round 2): a side effect that did not land is still warnings-only
// AT THE RECORD LEVEL, but on a real run (no --dry-run, not a child) a failed
// label or transition additionally emits a pending Supervisor gate naming the
// manual fix — a quiet `ok:true` must not be the last word on a return that
// never happened (the round-1 incident: the apply never ran and nothing fired).
//
// Both side effects are warnings-only and never block recording: skipped inside
// spawned children (LA_SUPERVISOR_CHILD, FOC-167), degraded to a warning on any
// linear-ops failure, and the verdict file is written either way. `--dry-run`
// (or one of the explicitly allow-listed *_DRY_RUN=1 envs, which linear-ops
// honours offline via the mock fixture) runs the operations through linear-ops'
// dry-run path instead — loudly, see DRY_RUN_ENV_ALLOWLIST. Any OTHER
// *_DRY_RUN=1 in the session is scrubbed from every spawned Linear op's
// environment (round 3): linear-ops AND linear-query honour the glob for ANY
// name, and an unscrubbed rogue var would drive the offline fixture path — a
// silent "applied" for linear-ops, or a fake issue description into
// declaredAcs via linear-query — while this record still claimed a real run.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  ROOT,
  asArray,
  ensureRunDir,
  failJson,
  parseArgs,
  producerOf,
  progressFingerprint,
  readRegistry,
  verdictPath,
  verdictsDir,
} from "./supervisor-lib.mjs";
import { loadGraph } from "./graph-validate.mjs";
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
      // Same R2-1 shape as runLinearOps: linear-query honours ANY *_DRY_RUN=1
      // for its fixture path, and an unscrubbed FOO_DRY_RUN=1 + a matching
      // .state/mock fixture would hand a FAKE issue description to the AC
      // count below — poisoning pass-record completeness with no warning.
      const out = execFileSync(
        process.execPath,
        [join(ROOT, "scripts", "linear-query.mjs"), "issue", taskId, "--json"],
        { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: scrubbedSpawnEnv() },
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

// ── whose tree holds the work under review ───────────────────────────────────

/**
 * `--work-child <id>` when you want to say it; otherwise the child of this
 * node's PRODUCER (config/graph.json) carrying the same taskId.
 *
 * Fail-closed on ambiguity. Guessing here is how a verdict ends up fingerprinting
 * a tree nobody was reviewing, which is exactly the bug this function exists to
 * have fixed — and a wrong fingerprint is silent: it reads as "no progress" and
 * stops the loop.
 */
function resolveWorkChild(registry, entry, taskId, args) {
  const children = Object.values(registry.children ?? {});

  if (args["work-child"] && args["work-child"] !== true) {
    const named = children.find((c) => c.childId === args["work-child"]);
    if (!named) {
      failJson(`--work-child "${args["work-child"]}" is not in the registry`, {
        known: children.map((c) => c.childId),
      });
    }
    return named;
  }

  const graph = loadGraphOrNull();
  const producer = graph ? producerOf(entry.squad, graph) : null;

  // A node with no producer reviews its own work — the recording child IS the
  // work child, and that is not a guess.
  if (!producer) return entry;

  const matches = children.filter((c) => c.squad === producer && c.taskId === taskId && c.worktree);
  if (matches.length === 1) return matches[0];

  if (matches.length === 0) {
    failJson(
      `no ${producer} child for ${taskId} in this run, so there is no tree holding the work ${entry.squad} is reviewing`,
      {
        hint: `name it: --work-child <id>. Fingerprinting ${entry.childId}'s own tree would measure the reviewer, not the work.`,
        candidates: children.map((c) => ({ childId: c.childId, squad: c.squad, taskId: c.taskId })),
      },
    );
  }

  failJson(`${matches.length} ${producer} children carry ${taskId} — which one is under review?`, {
    hint: "--work-child <id>",
    candidates: matches.map((c) => c.childId),
  });
}

function loadGraphOrNull() {
  try {
    return loadGraph();
  } catch {
    return null;
  }
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

// The consulted allowlist for the fail-transition emitter — NOT documentation.
// Contains ONLY review: test's emitter is deferred (F-05 → FOC-165) and stays
// inert (a test fail must not stamp a flag no code manages). FOC-165 enables
// it by adding `test: "test-to-dev-return"` here — one edit instead of two.
// Keyed by edge id so the lookup cannot silently match a different edge when
// the topology is reordered.
const RETURN_EDGE_BY_SQUAD = { review: "review-to-dev-return" };

// The flag each squad's return edge keys on, read from the edge rather than
// restated here: if the edge is ever re-keyed or un-routed, this follows it and
// the side effect goes dormant instead of stamping a dead label.
function returnFlagFor(squad) {
  const graph = loadGraphOrNull();
  const edge = graph?.edges?.find((e) => e.id === RETURN_EDGE_BY_SQUAD[squad]);
  return edge?.routable ? (edge?.when?.labels?.[0] ?? null) : null;
}

// linear-ops' --dry-run flag alone still reads Linear; a *_DRY_RUN=1 env makes
// it fully offline via .state/mock/<squad>-task.json — which is how the suites
// exercise this branch without ever touching live Linear.
//
// The env names are an EXPLICIT allowlist, deliberately not a `*_DRY_RUN` glob:
// any `FOO_DRY_RUN=1` left over in the Supervisor's session used to engage
// dry-run silently (FOC-284 round 2, F2) — a real fail-record came back
// "applied" with nothing written and no warning. Only the names the repo's own
// tooling sets (bin/*-dry.bat, and the suites) may engage the offline path; an
// unknown `FOO_DRY_RUN=1` is now just a stale env var, not a silent no-op.
const DRY_RUN_ENV_ALLOWLIST = ["REVIEW_DRY_RUN", "DEV_DRY_RUN", "PLAN_DRY_RUN", "TEST_DRY_RUN", "CADENCE_DRY_RUN"];

// Returns the `NAME=1` that engaged dry-run, or null. The name travels into the
// dry-run warning so a stale env var is visible instead of inferred.
const dryRunEnvTrigger = () =>
  DRY_RUN_ENV_ALLOWLIST.find((k) => process.env[k] === "1") ?? null;
const isEnvDryRun = () => dryRunEnvTrigger() !== null;

// R2-1 (round 3, extended to every spawned Linear op): the environment a
// spawned op inherits. linear-ops (dryRunContext) AND linear-query
// (detectDryRun) honour the glob for ANY <NAME>_DRY_RUN=1 and serve the
// matching .state/mock/<name>-task.json fixture. A non-allowlisted var that
// leaked into the Supervisor's session would therefore drive the spawned op
// through its offline path while the record claimed a real run — for
// linear-ops a silent "applied" with nothing written (the round-1 F2
// incident, one layer down); for linear-query a FAKE issue description fed
// into declaredAcs, so a pass mapping could be "verified" against a
// fabricated criterion. Scrub every non-allowlisted dry-run var from the
// child env; the allowlisted names survive — they drive the deliberate
// offline fixture path and are loudly warned on above.
const scrubbedSpawnEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.endsWith("_DRY_RUN") && !DRY_RUN_ENV_ALLOWLIST.includes(key)) delete env[key];
  }
  return env;
};

// A hung linear-ops must not park the FAIL path of every review verdict forever
// (round-1 review, S1). 60 s: an order of magnitude above a normal offline or
// online op, short enough that a hung subprocess surfaces as a failed op (and,
// on a real run, into the enforcement gate) instead of a stalled Supervisor.
const LINEAR_OPS_TIMEOUT_MS = 60_000;

function runLinearOps(argv, dryRun) {
  const args = [...argv, ...(dryRun ? ["--dry-run"] : [])];
  // R2-1 (round 3): the spawned op must not inherit a rogue dry-run var —
  // see scrubbedSpawnEnv above for why.
  const env = scrubbedSpawnEnv();
  try {
    const out = execFileSync(
      process.execPath,
      [join(ROOT, "scripts", "linear-ops.mjs"), ...args],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: LINEAR_OPS_TIMEOUT_MS, env },
    );
    return { status: "applied", detail: out.trim().split("\n")[0] ?? "" };
  } catch (err) {
    // A timed-out child is killed with SIGTERM: say so, rather than surfacing
    // the killed process's truncated output as the "actual reason".
    if (err.killed || err.signal) {
      return {
        status: "failed",
        detail: `linear-ops ${args.join(" ")} → timed out after ${LINEAR_OPS_TIMEOUT_MS} ms and was killed (${err.signal ?? "timeout"})`,
      };
    }
    // execFileSync attaches the child's stderr; linear-ops states the actual
    // reason on its last line (label not found, state not found, auth…).
    const detail = String(err.stderr ?? err.message).trim().split("\n").pop() ?? "";
    return { status: "failed", detail: `linear-ops ${args.join(" ")} → ${detail}` };
  }
}

// ── the fail transition (FOC-284) ────────────────────────────────────────────
//
// review.fail (config/graph.json) declares that a failed review sends the issue
// back to In Progress. The unsupervised flow executed that by hand; the
// supervised one had NOBODY doing it — a review fail recorded a verdict and the
// issue sat in In Review. record is where the supervised flow performs the
// transition, stamping the flag the return edge keys on: without it `In
// Progress` is also the state of work DEV is actively holding and nothing could
// tell the two apart (why the edge stayed non-routable until FOC-284).
//
// Both operations are WARNINGS-ONLY side effects. The verdict file is the
// artifact the whole loop reads; a Linear hiccup (label not yet bootstrapped,
// API down) must never block or corrupt its recording — the label is
// recoverable, a lost verdict is not. What keeps that honest is ORDER: the
// record (with "pending" statuses) lands on disk before the first op, and the
// ops' outcome is amended in afterwards — plus, on a real run, the enforcement
// gate below, so a quiet exit can no longer be the last word on an unlanded
// return (round-1 incident: the apply silently never ran).

/**
 * Stage 1 of the fail transition: decide applicability, resolve every status
 * that is final without running an operation, and leave the live ops as
 * "pending" for executeReturnEffects. Pure w.r.t. Linear — nothing runs here.
 *
 * Statuses: "applied" (linear-ops exited 0), "skipped" (LA_SUPERVISOR_CHILD —
 * a spawned child never writes to Linear, FOC-167), "not-applicable" (pass
 * verdict, or a squad with no emitter), "failed" (linear-ops refused; warning
 * pushed), "pending" (transient — on disk before the op runs, amended after;
 * visible only if the process died in between, which is the point). `dryRun`
 * marks the whole block as exercised against linear-ops' dry-run path —
 * nothing was written to Linear.
 */
function planReturnEffects(record, taskId, verdict, args, warnings) {
  const dryRun = args["dry-run"] === true || isEnvDryRun();
  // R2-N1 (round 3): WHICH trigger engaged dry-run is known at write time and
  // must survive into the record — warnings[] are not persisted, and a later
  // `show` consumer should not have to infer the trigger. Same precedence the
  // execute-time warning uses: an env trigger names itself, the bare flag says
  // so; null on a real run.
  const envTrigger = dryRunEnvTrigger();
  const effects = {
    dryRun,
    dryRunTrigger: envTrigger ? `${envTrigger}=1` : dryRun ? "--dry-run flag" : null,
    label: null,
    transition: null,
  };

  if (verdict !== "fail") {
    const na = { status: "not-applicable", detail: `verdict "${verdict}" — side effects apply to a review fail only` };
    effects.label = na;
    effects.transition = na;
    return effects;
  }
  // R2-N2 (round 3): the record's OWN squad field is the single source for
  // every return-emitter decision — the allowlist gate here, the flag lookups
  // in execute and the enforcement gate. A reader of the record therefore sees
  // the same decision the recorder made (`record.squad` is entry.squad ?? null,
  // frozen at record time rather than re-derived at each stage).
  if (!RETURN_EDGE_BY_SQUAD[record.squad]) {
    const na = {
      status: "not-applicable",
      detail: `squad "${record.squad}" has no return emitter configured (review only; test's is deferred, F-05 → FOC-165)`,
    };
    effects.label = na;
    effects.transition = na;
    return effects;
  }

  const childId = process.env.LA_SUPERVISOR_CHILD;
  if (childId) {
    const skipped = {
      status: "skipped",
      detail: `LA_SUPERVISOR_CHILD=${childId} set — children never write to Linear (FOC-167)`,
    };
    effects.label = skipped;
    effects.transition = skipped;
    warnings.push(`return transition skipped inside child ${childId}: would stamp the return flag + In Progress on ${taskId}`);
    return effects;
  }

  const flag = returnFlagFor(record.squad);
  if (!flag) {
    const why = {
      status: "failed",
      detail: `config/graph.json no longer declares a routable return flag on ${RETURN_EDGE_BY_SQUAD[record.squad]}`,
    };
    effects.label = why;
    effects.transition = why;
    warnings.push(why.detail);
    return effects;
  }

  // taskId shape was validated at cmdRecord entry (R2-2) — the ops and the
  // enforcement gate are the only consumers here, and both get a checked id.

  const pending = (op) => ({
    status: "pending",
    detail: `pending — the verdict file is written before the linear-ops ${op} runs`,
  });
  effects.label = pending("label");
  effects.transition = pending("transition");
  return effects;
}

/**
 * Stage 2: run the pending ops and amend `record.linearEffects` in place.
 * Returns true when the record changed and has to be written again.
 */
function executeReturnEffects(record, taskId, warnings) {
  const effects = record.linearEffects;
  if (!effects || effects.label?.status !== "pending") return false;

  // F2 (round 2): dry-run in the Supervisor's own session is legitimate (the
  // suites) but must never look like a real apply. Loud, and named by the
  // trigger that was persisted at plan time (R2-N1).
  if (effects.dryRun) {
    warnings.push(
      `return side effects ran OFFLINE in dry-run mode (trigger: ${effects.dryRunTrigger}) — ` +
        `linear-ops served its mock fixture; "applied" is simulated and nothing was written to Linear`,
    );
  }

  const flag = returnFlagFor(record.squad);
  effects.label = flag
    ? runLinearOps(["label", taskId, "--add", flag], effects.dryRun)
    : { status: "failed", detail: `config/graph.json no longer declares a routable return flag on ${RETURN_EDGE_BY_SQUAD[record.squad]}` };
  effects.transition = runLinearOps(["transition", taskId, "--status", "In Progress"], effects.dryRun);
  for (const [name, op] of [["label", effects.label], ["transition", effects.transition]]) {
    if (op.status === "failed") warnings.push(`return ${name} failed: ${op.detail}`);
  }
  return true;
}

/**
 * Stage 3 (round 2, F3): on a REAL fail+review record — not a dry run, not a
 * child-guard skip — any status other than "applied" raises a pending
 * Supervisor gate naming the manual fix. linear-ops ensure-create was declined
 * (shared tool mid-wave; bootstrap owns label creation), so the gate is the
 * enforcement: a quiet ok:true no longer hides a return that never landed.
 * Gate-emission failure is a warning, never a block. Returns true when the
 * audit block changed (a `gate` field was recorded) and needs the amend write.
 */
/**
 * The paste-able manual fix the enforcement gate hands the Supervisor.
 * R2-N3 (round 3): the flag is whatever the graph edge resolves to — never a
 * hardcoded name (at FOC-165 a test-side gate would have printed the review
 * flag for an edge no code manages). When the edge cannot resolve, the
 * question names the broken edge instead of inventing a flag to stamp.
 */
function returnGateQuestion(taskId, flag, edgeId) {
  return flag
    ? `apply the return to ${taskId} by hand and resume DEV: ` +
        `node scripts/linear-ops.mjs label ${taskId} --add ${flag} && ` +
        `node scripts/linear-ops.mjs transition ${taskId} --status "In Progress"`
    : `apply the return to ${taskId} by hand and resume DEV: the return flag on ` +
        `${edgeId} is not resolvable from config/graph.json — fix the edge (or stamp the label ` +
        `from its when.labels by hand) and transition ${taskId} to In Progress`;
}

function maybeEmitReturnGate(record, taskId, workChild, runId, warnings) {
  const effects = record.linearEffects;
  if (!effects) return false;
  if (record.verdict !== "fail") return false;
  if (!RETURN_EDGE_BY_SQUAD[record.squad]) return false;
  if (effects.dryRun) return false; // offline exercise — nothing to enforce
  if (effects.label?.status === "skipped") return false; // child guard — the real run applies it
  if (effects.label?.status === "applied" && effects.transition?.status === "applied") return false;

  const failedOps = [
    ["label", effects.label],
    ["transition", effects.transition],
  ].filter(([, op]) => op?.status !== "applied");
  const edgeId = RETURN_EDGE_BY_SQUAD[record.squad];
  const flag = returnFlagFor(record.squad);

  const summary =
    `${taskId} round ${record.round}: the review-fail return did not land — ` +
    `${failedOps.map(([name]) => name).join(" + ")} not applied`;
  const question = returnGateQuestion(taskId, flag, edgeId);

  try {
    const out = execFileSync(
      process.execPath,
      [
        join(ROOT, "scripts", "supervisor-gate.mjs"), "emit",
        "--run", runId,
        "--child", workChild.childId,
        "--kind", "question",
        "--summary", summary,
        "--question", question,
      ],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: LINEAR_OPS_TIMEOUT_MS },
    );
    const gate = JSON.parse(out);
    effects.gate = { emitted: true, gateId: gate.gateId ?? null, childId: workChild.childId };
  } catch (err) {
    const detail = err.killed || err.signal
      ? `timed out after ${LINEAR_OPS_TIMEOUT_MS} ms (${err.signal ?? "timeout"})`
      : String(err.stderr ?? err.message).trim().split("\n").pop() ?? err.message;
    warnings.push(`return-enforcement gate could not be emitted: ${detail}`);
    effects.gate = { emitted: false, detail };
  }
  return true;
}

// ── record ───────────────────────────────────────────────────────────────────

// A verdict is about a Linear issue, and EVERYTHING in cmdRecord derives from
// the id: the verdict file name (a `../`-bearing id would climb out of the
// verdicts dir), the linear-ops invocations, and the enforcement gate's
// paste-able manual-fix command. The id must LOOK like one — an issue
// identifier (FOC-284) or a UUID — and it is checked at ENTRY, before any of
// that derivation runs. R2-2 (round 3): a garbage id used to be refused at the
// ops yet still interpolated RAW into the gate's command; a verdict keyed by a
// garbage id is itself garbage, so it is refused outright — no record written,
// no ops, no gate.
const RE_TASK_ID = /^[A-Za-z]+-\d+$|^[0-9a-f-]{36}$/i;

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

  // R2-2 (round 3): entry-level shape check — before the findings, the AC read,
  // the work-child resolution, the record-once check, the file name, the ops
  // and the gate, all of which derive from the id. failJson names the value.
  if (!RE_TASK_ID.test(String(taskId))) {
    failJson(
      `taskId "${taskId}" is neither an issue identifier (TEAM-123) nor a UUID — ` +
        `refusing to derive a verdict file, linear-ops ops or enforcement gate from it`,
    );
  }

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

  // WHICH TREE. Not the reviewer's — the one holding the work under review.
  //
  // The first version fingerprinted `entry.worktree`, the recording child's own
  // checkout. A REVIEW child's tree does not contain DEV's changes and barely
  // moves between rounds, so consecutive rounds fingerprinted IDENTICALLY and
  // the review loop refused at round 2 however much DEV had fixed. That is
  // worse than the counter it replaced, which at least allowed two rounds.
  // Caught by writing the scenario out and running it, not by reading the code.
  const workChild = resolveWorkChild(registry, entry, taskId, args);
  const fingerprint = progressFingerprint({
    worktree: workChild.worktree,
    baseRevision: workChild.baseRevision,
    failingTests,
  });
  if (fingerprint.error) warnings.push(`fingerprint is UNKNOWN: ${fingerprint.error}`);
  if (workChild.childId !== entry.childId) {
    warnings.push(`fingerprinted ${workChild.childId}'s tree (${workChild.squad}) — the work under review`);
  }

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

  // AFTER the round check: a refused record must not touch Linear.
  //
  // Record FIRST (round 2, N3): the file lands with per-op status "pending"
  // before any Linear op can run, so no Linear write happens without a verdict
  // record on disk. A crash between this write and the amend leaves "pending"
  // on disk — distinct from NO linearEffects, which means an older tool wrote
  // the record; supervisor-followup's review-loop catcher tells them apart.
  record.linearEffects = planReturnEffects(record, taskId, verdict, args, warnings);

  ensureRunDir(runId);
  mkdirSync(verdictsDir(runId), { recursive: true });
  atomicWriteJSON(path, record);

  const opsRan = executeReturnEffects(record, taskId, warnings);
  const gateAttempted = maybeEmitReturnGate(record, taskId, workChild, runId, warnings);

  if (opsRan || gateAttempted) {
    try {
      atomicWriteJSON(path, record);
    } catch (err) {
      warnings.push(
        `the verdict file could not be re-written after the return ops (${err.message}) — ` +
          `the on-disk audit still reads "pending" while the operations did run`,
      );
    }
  }

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

export { VERDICTS, SEVERITIES, isEvidence, roundsFor, returnGateQuestion };

if (process.argv[1]?.endsWith("supervisor-verdict.mjs")) main();
