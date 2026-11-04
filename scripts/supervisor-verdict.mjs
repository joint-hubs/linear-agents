#!/usr/bin/env node
// scripts/supervisor-verdict.mjs — a REVIEW verdict has to cite something.
//
//   node scripts/supervisor-verdict.mjs record --child <id> --verdict pass|fail [--work-child <id>]
//        [--work-run <runId>] [--finding '<json>' ...] [--ac '<json>' ...]
//        [--failing-test <id> ...] [--no-failing-tests '<reason>']
//        [--decision-event <eventId> ...] [--decision-run <runId> ...]
//        [--ran '{"cmd":"...","exit":0,"outputRef":"<path>"}' ...]          (FOC-1170)
//        [--red-first '{"cmd":"...","baseExit":1,"candidateExit":0,"outputRef":"..."}' ...]
//        [--container-run '{"cmd":"...","exit":0,"outputRef":"..."}']       (FOC-1179, TEST pass)
//        [--container-unavailable '<why>']                                  (FOC-1179, when docker is not)
//        [--dry-run]
//   node scripts/supervisor-verdict.mjs record --delivery --run <runId> --task FOC-n
//        --verdict pass|fail --reason <design|evidence|test-gap|ci|scope|other>
//        [--finding '<json>' ...] [--work-child <id>] [--round N]
//        [--recorded-at <iso> --backfill] [--contradicts-round N] [--dry-run]     (FOC-1169)
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
// its predecessor's diff and failures is the first round billed twice. On a
// fail the test axis is a declaration, not a default: a fail with no failing
// test is refused unless --no-failing-tests states why (FOC-220), because an
// empty axis by omission makes two rounds that fixed nothing compare equal on
// half the fingerprint.
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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  ROOT,
  asArray,
  ensureRunDir,
  failJson,
  isPathSafeRunId,
  latestVerdict,
  mergeOnlySincePass,
  normalizeFailingTests,
  parseArgs,
  producerOf,
  progressFingerprint,
  readRegistry,
  registryPath,
  roundsAcross,
  roundsFor,
  runDir,
  updateChild,
  verdictPath,
  worktreeHead,
  verdictsDir,
} from "./supervisor-lib.mjs";
import { autoLabel, pairDecisionEvents } from "./decision-log.mjs";
import { loadGraph } from "./graph-validate.mjs";
import { atomicWriteJSON } from "./utils.mjs";

const VERDICTS = ["pass", "fail"];
const SEVERITIES = ["issue", "todo", "nit", "question", "praise"];

// Strict ISO 8601 for a backfilled record's `--recorded-at`: calendar date, T,
// time, optional fraction, Z or an explicit offset. Nothing locale-shaped.
// The offset is bounded to ISO 8601's max magnitude, ±14:00 EXACTLY — hour 14
// admits only :00, so neither `+99:99` (not a timezone) nor `+14:01`
// (beyond the standard) is read as one.
const RE_ISO_STAMP = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;

// The closed set a delivery verdict's `--reason` comes from (FOC-1169). The
// reason IS the label: `ci` feeds ciRedAfterReady, the rest categorize why a
// READY TO PUSH was accepted or rejected. Unknown reasons are refused rather
// than recorded — a fail nobody can categorize is a fail nobody learns from.
const DELIVERY_REASONS = ["design", "evidence", "test-gap", "ci", "scope", "other"];

// The cheap ways to satisfy "cite something" without citing anything. Checked
// after trimming and lowercasing.
const NON_EVIDENCE = ["", "-", "--", "n/a", "na", "none", "todo", "tbd", "?", "see above", "obvious"];

const REPEATABLE = new Set(["finding", "ac", "failing-test", "decision-event", "decision-run", "ran", "red-first", "container-run", "container-unavailable"]);

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
 * `opts.workRunId` (FOC-1155): when `--work-run` names another run, the registry
 * searched here is THAT run's and the refusals name it — a missing run is
 * refused before this is called, a missing child and a different task here.
 * `opts.producer` overrides the graph lookup. The delivery verdict (FOC-1169)
 * has no node of its own in config/graph.json, but the work it judges is the
 * dev child's — it passes its producer explicitly and gets the same
 * fail-closed resolution as a review verdict.
 *
 * Fail-closed on ambiguity. Guessing here is how a verdict ends up fingerprinting
 * a tree nobody was reviewing, which is exactly the bug this function exists to
 * have fixed — and a wrong fingerprint is silent: it reads as "no progress" and
 * stops the loop.
 */
function resolveWorkChild(registry, entry, taskId, args, opts = {}) {
  const children = Object.values(registry.children ?? {});
  const workRunId = opts.workRunId ?? null;

  if (args["work-child"] && args["work-child"] !== true) {
    const named = children.find((c) => c.childId === args["work-child"]);
    if (!named) {
      failJson(
        workRunId
          ? `missing child "${args["work-child"]}" in run "${workRunId}"`
          : `--work-child "${args["work-child"]}" is not in the registry`,
        { known: children.map((c) => c.childId) },
      );
    }
    // FOC-1155, fail-closed on the task too — cross-run the child was found by
    // id alone, so a same-id-different-task child would otherwise fingerprint
    // an unrelated tree silently. Without --work-run the old behaviour stands.
    if (workRunId && String(named.taskId ?? "").toLowerCase() !== String(taskId).toLowerCase()) {
      failJson(
        `child "${named.childId}" in run "${workRunId}" has task ${named.taskId ?? "none"} but the verdict is for task ${taskId}`,
      );
    }
    return named;
  }

  const graph = loadGraphOrNull();
  const producer = opts.producer ?? (graph ? producerOf(entry.squad, graph) : null);

  // A node with no producer reviews its own work — the recording child IS the
  // work child, and that is not a guess.
  if (!producer) return entry;

  const matches = children.filter((c) => c.squad === producer && c.taskId === taskId && c.worktree);
  if (matches.length === 1) return matches[0];

  if (matches.length === 0) {
    // A delivery verdict has no child of its own — the hint must not print
    // "Fingerprinting null's own tree"; name what WOULD be fingerprinted.
    const who = entry.childId ?? (entry.squad === "delivery" ? "the delivery owner's (nonexistent) own tree" : "the recording child's own tree");
    failJson(
      `no ${producer} child for ${taskId} in ${workRunId ? `run "${workRunId}"` : "this run"}, ` +
        `so there is no tree holding the work ${entry.squad} is reviewing`,
      {
        hint: workRunId
          ? `name it: --work-child <id> (with --work-run). Fingerprinting ${who} would measure the reviewer, not the work.`
          : `name it: --work-child <id>. Fingerprinting ${who} would measure the reviewer, not the work.`,
        candidates: children.map((c) => ({ childId: c.childId, squad: c.squad, taskId: c.taskId })),
      },
    );
  }

  failJson(`${matches.length} ${producer} children carry ${taskId} — which one is under review?`, {
    hint: workRunId ? "--work-child <id> --work-run <runId>" : "--work-child <id>",
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
// roundsFor / latestVerdict / roundsAcross live in supervisor-lib.mjs
// (supervisor-followup reads the same chain); the byte-identical copies that
// used to sit here are gone — the lib ones follow workRun provenance and
// merge multi-run chains across a run split.

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

// Findings, each cited. Shared by the review path and the delivery path
// (FOC-1169) — a delivery finding is the delivery owner's rejection note, and
// it is held to the same WHERE as a reviewer's.
function citedFindings(args) {
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
  return findings;
}

// The failing-test axis is a declaration, not a default (FOC-220). Shared by
// the review path and the delivery path: both records land in the same
// roundsFor chain, whose fingerprint is compared on the test axis — so the
// declaration discipline has to be one gate, not two habits.
function declaredFailingTests(args, verdict, taskId, warnings) {
  // Normalized the way the fingerprint hashes it, so what is enforced here IS
  // what lands in the record — `--failing-test " "` must not count as declared.
  const failingTests = normalizeFailingTests(asArray(args["failing-test"]));
  const declaredNone = args["no-failing-tests"]; // absent, `true` (flag without a reason), or the reason

  if (declaredNone !== undefined) {
    // FOC-220. A fail that is not test-backed — a design failure — is a real
    // category, so the gate stays escapable; but the escape is an explicit,
    // on-the-command-line declaration with a reason, never an omission. It
    // rides the record out as `noFailingTests`, so an operator reading the JSON
    // later can tell "declared none, here is why" from an axis left empty by
    // accident (which the branch below stops new records from having).
    if (verdict !== "fail") {
      failJson("--no-failing-tests only means something on a fail verdict", {
        verdict,
        hint: "drop the flag, or move to a fail verdict that declares its failing tests",
      });
    }
    if (failingTests.length) {
      failJson(`--no-failing-tests and ${failingTests.length} --failing-test value(s) contradict each other`, {
        failingTests,
        hint: "declare the failing tests, or declare there are none — not both",
      });
    }
    if (declaredNone === true || !isEvidence(declaredNone)) {
      failJson("--no-failing-tests is a declaration and needs a reason: why does this fail cite no test?", {
        hint: `example: --no-failing-tests "design failure: the AC contradicts the spec, no test can be red"`,
      });
    }
    warnings.push(`failing tests declared absent on this fail: ${declaredNone}`);
  } else if (verdict === "fail" && !failingTests.length) {
    // FOC-220. This used to be a warning; 86 of 89 recorded verdicts shipped an
    // empty test axis anyway, and two rounds that fixed nothing then compared
    // equal on a fingerprint whose tests half hashed the empty string.
    failJson("a fail verdict must declare its failing tests — the detector compares rounds on the test axis", {
      taskId,
      hint:
        "pass --failing-test <test id> once per failing test; if the fail is not test-backed " +
        '(a design failure), declare that instead: --no-failing-tests "<why this fail cites no test>"',
    });
  }
  return { failingTests, declaredNone };
}

// ── the pass cites a command the reviewer ran itself (FOC-1170) ──────────────
//
// Three REVIEW passes in the 2026-11-01/02 session accepted evidence that could
// not have come out differently: a dry-run that skipped every input and printed
// "0 targets", a test whose `created: true` was set by hand, a liveness probe
// that returned "dead" because PowerShell was missing. In each case the reviewer
// read the output and not the script. A kickoff rule saying otherwise did not
// hold — so the rule lives in the tool: a review PASS has to cite at least one
// command the reviewer ran ITSELF (`--ran`), with the output saved where the run
// can audit it. A result that could not have come out differently is not
// evidence, and a citation of a file that does not exist is not a citation.

/**
 * Parse and shape-validate `--ran` / `--red-first` (FOC-1170). Shape errors are
 * refused for ANY verdict — evidence that does not parse is not evidence on a
 * fail either. The outputRef existence/containment check runs later, in
 * checkOutputRef, so every entry carries a resolved, auditable path by the time
 * it reaches the record.
 */
function evidenceRuns(args) {
  const ran = asArray(args.ran).map((raw, i) => parseJsonFlag(raw, "ran", i));
  const redFirst = asArray(args["red-first"]).map((raw, i) => parseJsonFlag(raw, "red-first", i));

  const problems = [];
  ran.forEach((r, i) => {
    if (!isEvidence(r.cmd)) problems.push(`--ran #${i + 1} names no command`);
    if (!Number.isInteger(r.exit)) problems.push(`--ran #${i + 1} has no integer exit`);
    if (!isEvidence(r.outputRef)) problems.push(`--ran #${i + 1} names no outputRef`);
  });
  redFirst.forEach((r, i) => {
    if (!isEvidence(r.cmd)) problems.push(`--red-first #${i + 1} names no command`);
    if (!Number.isInteger(r.baseExit) || !Number.isInteger(r.candidateExit)) {
      problems.push(`--red-first #${i + 1} needs integer baseExit and candidateExit`);
    }
    if (!isEvidence(r.outputRef)) problems.push(`--red-first #${i + 1} names no outputRef`);
  });
  if (problems.length) {
    failJson(`the evidence flags are malformed`, {
      problems,
      hint: `--ran '{"cmd":"node scripts/x.test.mjs","exit":0,"outputRef":"<path under the run's scratch or the reviewer worktree>"}'`,
    });
  }

  // The one semantic check the flag's name promises: a red-first claim whose
  // base and candidate exited identically describes no change — the cheapest
  // way to claim "it was red before" without ever running it red.
  for (const [i, r] of redFirst.entries()) {
    if (r.baseExit === r.candidateExit) {
      failJson(
        `red-first-not-red: --red-first #${i + 1} has baseExit ${r.baseExit} === candidateExit — ` +
          `a red-first claim needs a base that failed and a candidate that exited differently`,
        {
          hint: `--red-first '{"cmd":"node scripts/x.test.mjs","baseExit":1,"candidateExit":0,"outputRef":"..."}'`,
        },
      );
    }
  }
  return { ran, redFirst };
}

/**
 * `outputRef` must exist, hold at least a byte, and sit under the run's scratch
 * dir or the reviewer's own worktree (FOC-1170) — the two places whose content
 * the run can audit after the fact. A relative ref is resolved against the
 * REVIEWER's worktree first (that is the cwd the reviewer ran the command in),
 * then the tool's cwd, then the run dir; the first that exists wins. The
 * resolved ABSOLUTE path is what lands on the record — the citation has to be
 * readable from wherever the record is read, not from where it was typed.
 */
function checkOutputRef(ref, flag, index, runId, worktree) {
  const raw = String(ref);
  const candidates = isAbsolute(raw)
    ? [raw]
    : [...(worktree ? [resolve(worktree, raw)] : []), resolve(process.cwd(), raw), resolve(runDir(runId), raw)];
  const found = candidates.map((c) => resolve(c)).find((c) => existsSync(c));
  if (!found) {
    failJson(`evidence-outputRef-missing: ${flag} #${index + 1} outputRef does not exist: ${raw}`, {
      outputRef: raw,
      hint: "the output the citation points at has to be on disk — a missing file is not evidence",
    });
  }
  const st = statSync(found);
  const empty = st.isFile() ? st.size === 0 : readdirSync(found).length === 0;
  if (empty) {
    failJson(`evidence-outputRef-empty: ${flag} #${index + 1} outputRef holds nothing: ${found}`, {
      outputRef: found,
      hint: "a zero-byte file is a citation of nothing — the same cheat as a dash",
    });
  }
  const roots = [join(runDir(runId), "scratch"), worktree].filter(Boolean).map((r) => resolve(r));
  // Containment is a STRING compare, and win32 paths are case-insensitive while
  // this string is not: a citation typed with a different drive-letter casing
  // resolved fine on the filesystem and was then refused as outside-run
  // although the file sat exactly where it should (review round 1, probe P15).
  // Fold BOTH sides for the containment test only — posix paths are
  // case-sensitive, so the fold must never run there.
  const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const inside = roots.some((root) => {
    const r = fold(root);
    const f = fold(found);
    return f === r || f.startsWith(r + sep);
  });
  if (!inside) {
    failJson(
      `evidence-outputRef-outside-run: ${flag} #${index + 1} outputRef sits outside the run's ` +
        `scratch dir and the reviewer's worktree: ${found}`,
      { outputRef: found, roots },
    );
  }
  return found;
}

// ── a TEST pass ran the suite the way CI runs it (FOC-1179) ──────────────────
//
// TEST re-ran REVIEW's checks on win32 only; both Linux-only CI reds of the
// 2026-11-01/02 session (FOC-1151, FOC-1162) were invisible to it. A TEST pass
// therefore has to cite the run CI would run — lint, the count guard and the
// touched suites inside the Fenix image (`docker/test-in-container.sh`) — via
// `--container-run`, with the output saved where the run can audit it (the
// same roots `--ran` uses). When docker is NOT available the record must still
// SAY why: `--container-unavailable "<why>"` lands as
// `containerRun: "unavailable: <why>"`. Either way the field exists on a TEST
// pass — delivery can always see whether the container ran. A fail does not
// need it (the same asymmetry the `--ran` gate has).

/**
 * The probe command itself, exported so the suite can hold it: plain
 * `docker info` with NO --format. Its Go-template field names drift between
 * Docker CLI versions — CLI 28.4.0 refuses `{{.Server.Version}}` outright
 * ("can't evaluate field Server in type system.dockerInfo", exit 1), so a
 * templated probe reports a HEALTHY daemon as absent. The availability answer
 * is the exit code only, which no CLI version can reinterpret.
 */
export const DOCKER_PROBE = { cmd: "docker", args: ["info"] };

/**
 * Is docker usable on this host? The env override is the TEST seam first
 * (`LA_DOCKER_AVAILABLE=1|0` — the suites set it so both gate branches are
 * pinnable offline and no suite depends on the host having a daemon); without
 * it the daemon itself is probed: `docker info` answers "could this host run
 * the Fenix container", which `docker --version` (CLI present, daemon dead)
 * does not.
 */
export function dockerAvailability(env = process.env) {
  const override = env.LA_DOCKER_AVAILABLE;
  if (override === "1") return { available: true, detail: "seam: LA_DOCKER_AVAILABLE=1" };
  if (override === "0") return { available: false, detail: "seam: LA_DOCKER_AVAILABLE=0" };
  try {
    execFileSync(DOCKER_PROBE.cmd, DOCKER_PROBE.args, {
      timeout: 20_000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return { available: true, detail: "docker daemon reachable (docker info exit 0)" };
  } catch (err) {
    const why = String(err?.message ?? err).split("\n").map((l) => l.trim()).filter(Boolean)[0];
    return { available: false, detail: why || "docker probe failed" };
  }
}

/**
 * FOC-1231: is the repo the record is ABOUT a Fenix repo? The marker is the
 * script CI runs — `docker/test-in-container.sh` at the target repo's root.
 * Detection reads the TARGET worktree (the child's own checkout, from the run
 * registry), never this script's ROOT: this file lives in linear-agents, but a
 * verdict can be about a service repo (joint-flows) where the fenix:dev image
 * and its script do not exist — the Fenix hint there names a remedy the repo
 * cannot use (FOC-1181 blocked a verdict whose TEST parts had both passed).
 */
function isFenixRepo(targetWorktree) {
  return Boolean(targetWorktree) && existsSync(join(targetWorktree, "docker", "test-in-container.sh"));
}

/**
 * Parse and shape-validate `--container-run` / `--container-unavailable`
 * (FOC-1179). One of each, at most — the record field is singular. Shape
 * errors and the contradiction are refused for ANY verdict: the container
 * either ran or it did not, and evidence that does not exist is not evidence
 * on a fail either. The outputRef existence/containment check runs later, in
 * checkOutputRef — the SAME path the review evidence uses, never a fork.
 * `targetWorktree` decides whose example the malformed hint shows (FOC-1231):
 * a service repo gets the Linux-container example, a Fenix repo fenix:dev.
 */
function containerRunEvidence(args, targetWorktree) {
  const runs = asArray(args["container-run"]).map((raw, i) => parseJsonFlag(raw, "container-run", i));
  const whys = asArray(args["container-unavailable"]);
  if (runs.length > 1) {
    failJson(`--container-run takes ONE entry — the record field is singular; cite the decisive run`);
  }
  if (whys.length > 1) {
    failJson(`--container-unavailable takes ONE why — the record field is singular`);
  }
  const problems = [];
  runs.forEach((r) => {
    if (!isEvidence(r.cmd)) problems.push(`--container-run names no command`);
    if (!Number.isInteger(r.exit)) problems.push(`--container-run has no integer exit`);
    if (!isEvidence(r.outputRef)) problems.push(`--container-run names no outputRef`);
  });
  if (problems.length) {
    const malHint = isFenixRepo(targetWorktree)
      ? `--container-run '{"cmd":"docker run --rm -v <checkout>:/src:ro fenix:dev sh /src/docker/test-in-container.sh","exit":0,"outputRef":"<path under the run's scratch or the test worktree>"}'`
      : `--container-run '{"cmd":"docker run --rm -v <checkout>:/src -w /src python:3.12-slim <the affected suites' test command>","exit":0,"outputRef":"<path under the run's scratch or the test worktree>"}'`;
    failJson(`the container-run flags are malformed`, {
      problems,
      hint: malHint,
    });
  }
  if (runs.length && whys.length) {
    failJson(
      `container-run-contradiction: --container-run and --container-unavailable are mutually exclusive — ` +
        `the container either ran or it did not`,
      { hint: "cite the run, or explain its absence — never both" },
    );
  }
  if (whys.length && !isEvidence(whys[0])) {
    failJson(
      `--container-unavailable needs a non-empty why — "unavailable: ${whys[0]}" tells delivery nothing`,
      { hint: `--container-unavailable "docker daemon not installed on this runner"` },
    );
  }
  return { run: runs[0] ?? null, unavailableWhy: whys[0] ?? null };
}

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
  // FOC-1169: the delivery mode is a separate path, not a flag threaded through
  // the review one — its record has no child to derive from, and the normal
  // shape stays byte-identical only if the two never share a code line.
  if (args.delivery) return cmdRecordDelivery(args);
  const runId = requireRun(args);
  const childId = args.child;
  if (!childId || childId === true) failJson("--child <childId> is required");

  const registry = readRegistry(runId);
  const entry = registry.children[childId];
  if (!entry) {
    failJson(`no child "${childId}" in run ${runId}`, { known: Object.keys(registry.children) });
  }

  // ── FOC-1159: a verdict is recorded by the child that produced it ──────────
  // Run 3f52's incident: `record --child review-2` was invoked by a session
  // that was NOT review-2, writing a FAIL for work the named child never
  // looked at — recorded, attributed to "the owner", and applied Linear
  // effects. A session running AS one child cannot speak for another: the
  // recorder's own identity (LA_SUPERVISOR_CHILD, set by spawn) must match the
  // child the verdict names. Refuse the mismatch before anything is written.
  // (An unset identity — the Supervisor recording on behalf of a child — is a
  // separate path: that one is the followup/gate-answer route, not a bare
  // record; see FOC-1159 for the design note.)
  const selfChild = process.env.LA_SUPERVISOR_CHILD;
  if (selfChild && selfChild !== childId) {
    failJson(
      `child "${selfChild}" cannot record a verdict as child "${childId}" — ` +
        `a verdict is recorded by the child that produced it`,
      { recorder: selfChild, namedChild: childId },
    );
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
  const findings = citedFindings(args);

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

  // ── the failing-test axis is a declaration, not a default ──────────────────
  const { failingTests, declaredNone } = declaredFailingTests(args, verdict, taskId, warnings);

  // ── FOC-1170: the pass cites a command the reviewer ran itself ─────────────
  // Shape + outputRef checks for any verdict that cites them; the ≥1 requirement
  // is a review-pass gate only — a fail does not need an evidence run.
  const { ran, redFirst } = evidenceRuns(args);
  const ranChecked = ran.map((r, i) => ({ ...r, outputRef: checkOutputRef(r.outputRef, "--ran", i, runId, entry.worktree) }));
  const redFirstChecked = redFirst.map((r, i) => ({
    ...r,
    outputRef: checkOutputRef(r.outputRef, "--red-first", i, runId, entry.worktree),
  }));
  if (verdict === "pass" && entry.squad === "review" && !ranChecked.length) {
    failJson(
      `review-pass-without-evidence-run: a review pass must cite at least one command the reviewer ` +
        `ran itself (--ran '{"cmd":"...","exit":0,"outputRef":"<path under the run's scratch or the reviewer worktree>"}')`,
      {
        hint:
          "a result that could not have come out differently is not evidence — run the cited script " +
          "yourself and keep its output where the run can read it",
      },
    );
  }

  // ── FOC-1179: a TEST pass ran the suite the way CI runs it ─────────────────
  // Shape + outputRef checks for any verdict that cites them; the REQUIREMENT
  // is a test-pass gate only — a fail does not need a container run, and other
  // squads are not asked for one.
  const { run: containerRun, unavailableWhy } = containerRunEvidence(args, entry.worktree);
  const fenixTarget = isFenixRepo(entry.worktree);
  if (unavailableWhy) {
    // "Unavailable" while the daemon answers is a lie IN the record — the
    // why flag is the escape hatch for a host that cannot run the container,
    // not a skip button (REVIEW r1 probe P3b: seam=1 + a reason recorded
    // ok:true with containerRun: "unavailable: …"). Claim-level, so it
    // protects a fail verdict citing it just the same. The remedy is
    // repo-shaped (FOC-1231): the Fenix container here, a Linux container
    // for a service repo — the refusal itself is unchanged for both.
    const docker = dockerAvailability();
    if (docker.available) {
      failJson(
        `container-run-unavailable-while-docker-up: the record says the container could not run, ` +
          `but the docker probe answers (${docker.detail}) — ` +
          (fenixTarget
            ? `run the Fenix container and cite it, or fix the record`
            : `run the affected suites in a Linux container (e.g. python:3.12-slim) and cite it, or fix the record`),
        { dockerAvailable: true, hint: "delivery has to be able to see whether the container ran" },
      );
    }
  }
  let containerRunField;
  if (containerRun) {
    containerRunField = {
      ...containerRun,
      outputRef: checkOutputRef(containerRun.outputRef, "--container-run", 0, runId, entry.worktree),
    };
  } else if (unavailableWhy) {
    containerRunField = `unavailable: ${unavailableWhy}`;
  }
  if (verdict === "pass" && entry.squad === "test") {
    if (!containerRunField) {
      const docker = dockerAvailability();
      const gateHint = fenixTarget
        ? `test-pass-without-container-run: a TEST pass must cite the Fenix-container run ` +
          `(--container-run '{"cmd":"...","exit":0,"outputRef":"..."}' — docker/test-in-container.sh ` +
          `on the fenix:dev image, as CI runs it; ` +
          `on Git Bash/MSYS prefix the command with MSYS_NO_PATHCONV=1 or the container-side path is rewritten) ` +
          `or, when docker is not available, say why (--container-unavailable "<why>")`
        : `test-pass-without-container-run: a TEST pass must cite a suite run in a Linux container ` +
          `(--container-run '{"cmd":"...","exit":0,"outputRef":"..."}' — this repo has no Fenix image; ` +
          `the affected suites on the verdict commit in e.g. python:3.12-slim, command + exit code + outputRef; ` +
          `on Git Bash/MSYS prefix the command with MSYS_NO_PATHCONV=1 or the container-side path is rewritten) ` +
          `or, when docker is not available, say why (--container-unavailable "<why>")`;
      failJson(gateHint, {
        dockerAvailable: docker.available,
        hint: "delivery has to be able to see whether the container ran",
      });
    }
    if (!containerRun) {
      const docker = dockerAvailability();
      warnings.push(`container run skipped — docker probe: ${docker.detail}`);
    }
    if (containerRun && containerRun.exit !== 0) {
      // Delivery r4: the gate checked the citation's shape and the file's
      // existence, never the exit — so a pass citing fenix:dev exit 125
      // (image name mismatch) recorded ok. A pass whose only container
      // evidence is red contradicts itself — the red-first-not-red class
      // FOC-1170 refuses for --red-first. On a FAIL the exit stays verbatim:
      // red evidence on a fail is the report doing its job.
      failJson(
        `container-run-not-green: a TEST pass cites a container run that exited ` +
          `${containerRun.exit} — a pass whose container evidence is red contradicts itself; ` +
          `fix the suite or record a fail`,
        { exit: containerRun.exit, hint: "fix the suite or record a fail" },
      );
    }
  }

  // ── FOC-449: explicit decision provenance ───────────────────────────────────
  // The decision events this verdict labels with its outcome (the verdict
  // value itself, by:"agent", via:"verdict"). Same plumbing as the gate emit:
  // validated before anything is written, and the record key exists only when
  // flags were passed. No flags → nothing labelled, nothing warned.
  let decisionEvents = [];
  try {
    decisionEvents = pairDecisionEvents(asArray(args["decision-event"]), asArray(args["decision-run"]));
  } catch (err) {
    failJson(err.message);
  }

  // WHICH TREE. Not the reviewer's — the one holding the work under review.
  //
  // The first version fingerprinted `entry.worktree`, the recording child's own
  // checkout. A REVIEW child's tree does not contain DEV's changes and barely
  // moves between rounds, so consecutive rounds fingerprinted IDENTICALLY and
  // the review loop refused at round 2 however much DEV had fixed. That is
  // worse than the counter it replaced, which at least allowed two rounds.
  // Caught by writing the scenario out and running it, not by reading the code.
  //
  // FOC-1155: a launcher restart mid-task starts a NEW run, so the DEV child
  // whose tree is under review can still be registered in the OLD run's
  // children.json while this verdict's own registry is the new run's (seen
  // 2026-11-01, FOC-1110 — worked around by hand-copying the entry).
  // `--work-run <runId>` says WHICH run holds the work child; resolution
  // happens there, fail-closed, and the record carries the provenance
  // (`workRun`). Without the flag nothing changes: the single-registry
  // binding stays.
  const workRunId = (() => {
    if (args["work-run"] === undefined) return null;
    if (args["work-run"] === true) failJson("--work-run needs a run id: --work-run <supervisorRunId>");
    const id = String(args["work-run"]);
    // FOC-1155 round 2: the value becomes a path segment (registryPath), so a
    // traversal-shaped id is refused by SHAPE, not by luck of the filesystem —
    // `<runB>/../<runB>` normalizes to an existing registry and would
    // otherwise read fine.
    if (!isPathSafeRunId(id)) {
      failJson(`--work-run "${id}" is not a legal run id — path separators, "." and ".." are refused (the value becomes a path)`);
    }
    if (!existsSync(registryPath(id))) {
      failJson(`missing run ${id} — no registry at ${registryPath(id)}`);
    }
    return id;
  })();
  const workRegistry = workRunId ? readRegistry(workRunId) : registry;
  const workChild = resolveWorkChild(workRegistry, entry, taskId, args, { workRunId });
  // Where the work child's OWN registry entry lives — updateChild below must
  // write to that run, not to the verdict's.
  const workChildRunId = workRunId && workChild !== entry ? workRunId : runId;
  const fingerprint = progressFingerprint({
    worktree: workChild.worktree,
    baseRevision: workChild.baseRevision,
    failingTests,
  });
  if (fingerprint.error) warnings.push(`fingerprint is UNKNOWN: ${fingerprint.error}`);
  if (workChild.childId !== entry.childId) {
    warnings.push(`fingerprinted ${workChild.childId}'s tree (${workChild.squad}) — the work under review`);
  }
  // FOC-1222: the sha the verdict covers — HEAD of the judged tree. A dirty
  // tree does not block the record (the fingerprint already folds the
  // porcelain in), but the dirt is named: a bare sha would claim a
  // reproducibility the tree does not have.
  const candidate = worktreeHead(workChild.worktree);
  if (candidate.error) {
    warnings.push(`candidate sha is UNKNOWN: ${candidate.error}`);
  } else if (fingerprint.changedFiles > 0 && !warnings.some((w) => /uncommitted|dirty|porcelain/i.test(w))) {
    warnings.push(
      `fingerprinted a tree with ${fingerprint.changedFiles} uncommitted change(s) — ` +
        `the candidate sha covers the tree as it stands, the dirt is folded into the diff hash`,
    );
  }

  // Round numbering continues across the split (roundsAcross reads the work
  // run's chain when --work-run was given) — a restart mid-task must not make
  // round 3 of a loop think it is round 1.
  const chain = roundsAcross([runId, ...(workRunId ? [workRunId] : [])], taskId);
  const prior = chain[chain.length - 1] ?? null;
  const round = Number(args.round ?? (prior?.round ?? 0) + 1);

  const record = {
    taskId,
    runId,
    // FOC-1155: only when the work child was resolved in another run — a
    // verdict without it stays byte-identical to before.
    ...(workRunId ? { workRun: workRunId } : {}),
    childId,
    squad: entry.squad ?? null,
    round,
    verdict,
    findings,
    acMapping,
    // FOC-1170: the commands the reviewer ran itself (and its red-first claims),
    // with outputRef resolved to the auditable absolute path. Keys only when the
    // flags were passed — a dev/test record without them stays byte-identical.
    ...(ranChecked.length ? { ran: ranChecked } : {}),
    ...(redFirstChecked.length ? { redFirst: redFirstChecked } : {}),
    // FOC-1179: the Fenix-container run a TEST pass cites — the evidence object
    // when --container-run was given, `unavailable: <why>` when the why was.
    // Required on a test pass, absent otherwise; a record without the flags
    // stays byte-identical.
    ...(containerRunField !== undefined ? { containerRun: containerRunField } : {}),
    declaredAcs: declared,
    fingerprint,
    // FOC-1222: the commit this record covers — the work child's HEAD. null is
    // honest UNKNOWN (an unreadable tree), never a guess.
    candidate: candidate.sha ?? null,
    // FOC-220: present only when the fail DECLARED an empty test axis, carrying
    // the reason that earned it. A fail record with an empty
    // fingerprint.failingTests and no such field is a pre-enforcement record,
    // written by omission — the two must stay distinguishable on disk.
    ...(declaredNone !== undefined ? { noFailingTests: { reason: declaredNone } } : {}),
    // FOC-449: the decision events this verdict labels. Key only when
    // provenance was given — a verdict without it stays byte-identical.
    ...(decisionEvents.length ? { decisionEvents } : {}),
    recordedAt: new Date().toISOString(),
  };

  const path = verdictPath(runId, taskId, round);
  if (existsSync(path) && !args.force) {
    failJson(`round ${round} of ${taskId} is already recorded — a verdict is recorded once`, {
      path,
      hint: "record the next round, or pass --force if this is deliberately a correction",
    });
  }

  // ── FOC-1159: idempotent per child + fingerprint ────────────────────────────
  // Run ff22's incident: review-4 recorded the SAME verdict twice ~7s apart —
  // round 4 and round 5, one fingerprint, one findings set — because a
  // re-record with no --round simply took the next round number. The counter
  // moved 4→5 for ONE review, and the followup guard then refused "round 5
  // reproduced round 4", so the FAIL's findings never reached DEV. A re-record
  // of the SAME verdict — same child, same fingerprint, same verdict, same
  // findings (the followup guard's own definition of "reproduced", applied
  // here at record time) — is the same record, not a new round: refused.
  // The newest record FROM THIS CHILD is the comparison base — a record from
  // another child in between does not make this child's verdict new again.
  // Deliberately NOT refused: a changed verdict on the same tree (a new
  // opinion, FOC-1146), a new finding on the same verdict (something to act
  // on), a different fingerprint (the tree moved). --force stays the one
  // correction path, same as the exists-once check above.
  const priorSameChild =
    [...chain].reverse().find((r) => r && r.childId === childId && !r.unreadable) ?? null;
  // Both sides are findings ARRAYS here (the record's and the prior's), not
  // record objects — unlike the followup guard, which reads whole records.
  const findingTexts = (list) =>
    new Set((Array.isArray(list) ? list : []).map((f) => String(f?.text ?? "").trim()).filter(Boolean));
  const sameFindings = (a, b) => {
    const ta = findingTexts(a);
    const tb = findingTexts(b);
    return ta.size === tb.size && [...ta].every((t) => tb.has(t));
  };
  if (
    priorSameChild &&
    priorSameChild.fingerprint?.combined === fingerprint.combined &&
    priorSameChild.verdict === verdict &&
    sameFindings(priorSameChild.findings, findings) &&
    !args.force
  ) {
    failJson(
      `round ${priorSameChild.round} of ${taskId} already carries this verdict ` +
        `(child ${childId}, fingerprint ${fingerprint.combined}, same findings) — ` +
        `a re-record of the same verdict is not a new round`,
      {
        childId,
        taskId,
        fingerprint: fingerprint.combined,
        priorRound: priorSameChild.round,
        priorPath: verdictPath(runId, taskId, priorSameChild.round),
        hint:
          "record the next round after real progress (a moved tree, a changed verdict, or a new finding), " +
          "or pass --force if this is deliberately a correction",
      },
    );
  }

  // FOC-1155 round 2, the reverse half of the bridge: the record carries
  // `workRun` (B → A), and this stamps the work child's entry in ITS run with
  // the run holding the verdict (A → B) — so a review loop resumed with
  // `--run A` (the only run dev-1 can be resumed from) reads the full chain
  // instead of stale findings or a bogus "nothing recorded". Both verdicts
  // stamp alike; the dedup keeps repeated cross-run records idempotent.
  // Stamped BEFORE the record write: a bridge without a record is a harmless
  // no-op (roundsFor reads nothing there), the reverse is a blind loop. A
  // failed stamp refuses the record — fail closed, an unstamped bridge is the
  // bug this fixes, not a degraded feature.
  if (workRunId && workChildRunId !== runId) {
    const workEntry = workRegistry.children[workChild.childId] ?? {};
    const verdictRuns = [...new Set([...(workEntry.verdictRuns ?? []), runId])];
    try {
      updateChild(workChildRunId, workChild.childId, { verdictRuns });
    } catch (err) {
      failJson(
        `verdictRuns could not be stamped on child "${workChild.childId}" in run "${workChildRunId}": ` +
          `${err.message.split("\n")[0]} — refusing to record a cross-run verdict without its bridge`,
      );
    }
  }

  // Record FIRST (round 2, N3): the file lands with per-op status "pending"
  // before any Linear op can run, so no Linear write happens without a verdict
  // record on disk. A crash between this write and the amend leaves "pending"
  // on disk — distinct from NO linearEffects, which means an older tool wrote
  // the record; supervisor-followup's review-loop catcher tells them apart.
  record.linearEffects = planReturnEffects(record, taskId, verdict, args, warnings);

  ensureRunDir(runId);
  mkdirSync(verdictsDir(runId), { recursive: true });
  atomicWriteJSON(path, record);
  if (verdict === 'fail' && ['review','test'].includes(entry.squad) && workChild.squad === 'dev' && entry.attemptId) {
    try {
      // FOC-1155: the touched entry lives in the work child's own run, and —
      // when that is another run — carries the provenance so the patch is
      // traceable back to the cross-run record that caused it.
      updateChild(workChildRunId, workChild.childId, {
        pendingRuntimeReturn: {
          sourceAttemptId: entry.attemptId,
          source: entry.squad,
          reason: 'rejected',
          evidenceRef: runId + ':verdict:' + taskId + ':' + round,
          evidenceKind: 'direct',
          ...(workChildRunId !== runId ? { workRun: workRunId } : {}),
        },
      });
    }
    catch { warnings.push('runtime return evidence could not be staged'); }
  }

  // FOC-449 auto-join: the verdict IS the outcome for the decision events it
  // carries provenance for — outcome = the verdict value, by:"agent",
  // via:"verdict". Best-effort: a failed label is a warning in the record's
  // own warnings trail, never a broken verdict.
  warnings.push(...autoLabel(record.decisionEvents, { outcome: verdict, by: "agent", via: "verdict" }).warnings);

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

// ── record --delivery (FOC-1169) ─────────────────────────────────────────────

// The delivery verdict is the label the plan asked for: every accept/reject of
// a READY TO PUSH, and every CI red after READY, recorded by the delivery
// owner — NOT by a child, so there is no --child and no AC mapping. It lands
// in the same roundsFor chain a review verdict does, fingerprinting the dev
// child's tree through the same resolveWorkChild path, so the FOC-1146
// progress guard reads a delivery fail after a review pass as what it is: a
// new opinion on the same tree.
function cmdRecordDelivery(args) {
  const runId = requireRun(args);

  // A child in the invocation would be a different record pretending to be
  // this one — the delivery record's childId is null by definition.
  if (args.child) {
    failJson("--child is not used in --delivery mode — a delivery verdict is recorded by the delivery owner, not a child", {
      hint: "drop --child; the work child's tree is resolved from the registry (--work-child when ambiguous)",
    });
  }
  // An AC mapping is the review approve's claim; a delivery verdict judges the
  // delivered tree, not the issue's criteria list.
  if (args.ac) {
    failJson("--ac is not used in --delivery mode — an AC-by-AC mapping is a REVIEW approve requirement");
  }
  // The evidence flags are REVIEW-pass requirements (FOC-1170); silently
  // accepting them here would be the exact silent-accept class this tool
  // exists to kill, one layer over. Refused by name, like --child/--ac above.
  if (args.ran) {
    failJson("--ran is not used in --delivery mode — an evidence run is a REVIEW pass requirement");
  }
  if (args["red-first"]) {
    failJson("--red-first is not used in --delivery mode — a red-first claim is a REVIEW pass requirement");
  }
  // The container run is a TEST-pass requirement (FOC-1179); delivery judges the
  // delivered tree, it does not run suites. Refused by name, like --ran above.
  if (args["container-run"]) {
    failJson("--container-run is not used in --delivery mode — the container run is a TEST pass requirement");
  }
  if (args["container-unavailable"]) {
    failJson("--container-unavailable is not used in --delivery mode — the container run is a TEST pass requirement");
  }

  const verdict = args.verdict;
  if (!VERDICTS.includes(verdict)) failJson(`--verdict must be one of ${VERDICTS.join(" | ")}`);

  // No child to derive the task from, so --task is required here.
  const taskId = args.task && args.task !== true ? String(args.task).trim() : null;
  if (!taskId) {
    failJson("--task <id> is required in --delivery mode — there is no child to derive the task from");
  }
  // Same entry check as the normal path (R2-2): the file name, the work-child
  // resolution and the round chain all derive from the id.
  if (!RE_TASK_ID.test(taskId)) {
    failJson(
      `taskId "${taskId}" is neither an issue identifier (TEAM-123) nor a UUID — ` +
        `refusing to derive a verdict file, linear-ops ops or enforcement gate from it`,
    );
  }

  // A backdated record must ADMIT being a backfill: --recorded-at is accepted
  // only together with --backfill, and the record carries backfill:true. That
  // is how the 2026-11-01/02 baseline is written from the delivery owner's
  // notes — with the timestamps the delivery verdicts actually happened, not
  // the moment they were typed in.
  const backfill = args.backfill === true;
  const recordedAtArg = args["recorded-at"];
  if (recordedAtArg !== undefined && !backfill) {
    failJson("--recorded-at is accepted only together with --backfill — a backdated record must admit being a backfill");
  }
  let recordedAt = new Date().toISOString();
  if (backfill) {
    if (!recordedAtArg || recordedAtArg === true) {
      failJson("--backfill needs --recorded-at <iso> — the baseline's when is part of the record");
    }
    // Strict ISO: Date.parse is a locale-tolerant reader ("11/01/2026" parses),
    // and a backdated record whose when depends on the recorder's locale is not
    // a baseline anyone can reproduce. The shape is ISO 8601 only.
    // And a real calendar check: Date.parse ROLLS OVER an impossible date
    // (2026-02-30 parses as 2026-03-02), so the record would carry a WHEN the
    // operator never typed. The typed date components are validated directly
    // against the calendar — the date as typed, offset-independent: a typed
    // local time earlier than the offset magnitude shifts the UTC DATE too
    // (09:30+14:00 records 2026-10-31, a date that was never typed), so the
    // parsed UTC datetime is NOT the comparison target.
    const isoMatch = RE_ISO_STAMP.exec(String(recordedAtArg));
    const ms = isoMatch ? Date.parse(String(recordedAtArg)) : NaN;
    if (!isoMatch || Number.isNaN(ms)) {
      failJson(`--recorded-at "${recordedAtArg}" is not an ISO timestamp (expected e.g. 2026-11-01T10:00:00.000Z)`);
    }
    const [y, mo, d] = [Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3])];
    // Date.UTC maps years 0-99 onto 1900-1999 (Date.UTC(26, 2, 1) is
    // 1926-03-01), so the anchor year 2000 keeps the mapping away from the
    // typed year; setUTCFullYear then lands on it exactly, and the round-trip
    // below holds for every year the shape allows.
    const asUTC = new Date(Date.UTC(2000, mo - 1, d));
    asUTC.setUTCFullYear(y);
    if (asUTC.getUTCFullYear() !== y || asUTC.getUTCMonth() !== mo - 1 || asUTC.getUTCDate() !== d) {
      failJson(`--recorded-at "${recordedAtArg}" is not a real calendar date (${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")} does not exist)`);
    }
    recordedAt = new Date(ms).toISOString();
  }

  // FOC-1194: a backfilled delivery fail can name the round it CONTRADICTS and
  // carry that round's fingerprint verbatim. A backfill recomputes from the dev
  // child's tree as it is NOW — for a removed tree (most of the 2026-11-01/02
  // baseline) that is diff: null, an UNKNOWN that matches nothing, and the
  // reviewFalsePass pair is uncountable. Naming the round copies the
  // fingerprint that round judged.
  //
  // FOC-1210: the flag now also works on a LIVE record — the FOC-1179 case.
  // Merging main into the work branch between the REVIEW pass and the delivery
  // read is a normal step of the flow (plan §4b), and it moves the diff axis
  // the live fingerprint computes, so the pair is uncountable by the metric
  // even though the delivered work is exactly what the pass judged. A live
  // record keeps its own "now" fingerprint and ADDITIONALLY carries the pass's
  // fingerprint in `contradicts` — but only once merge-only is PROVEN
  // (mergeOnlySincePass below); anything it cannot prove is refused, never
  // guessed, because a copied fingerprint mislabels whose defect it was.
  const contradictsArg = args["contradicts-round"];
  // r2 finding 4 — decision journaled: the flag is a FAIL's provenance. A
  // delivery pass contradicts nothing; accepting it would put named delivery
  // passes into the quality signal's contradicted set with nothing to falsify.
  if (contradictsArg !== undefined && verdict !== "fail") {
    failJson("--contradicts-round is a fail's provenance — a delivery pass contradicts nothing");
  }

  // reason: required for fail, optional for pass, always from the closed set.
  const reasonArg = args.reason && args.reason !== true ? String(args.reason).trim() : null;
  if (verdict === "fail" && !reasonArg) {
    failJson(`a delivery fail needs --reason <${DELIVERY_REASONS.join("|")}>`, {
      hint: "the reason is the label's whole point — a fail nobody can categorize is a fail nobody learns from",
    });
  }
  if (reasonArg !== null && !DELIVERY_REASONS.includes(reasonArg)) {
    failJson(`unknown delivery reason "${reasonArg}" — expected ${DELIVERY_REASONS.join(" | ")}`);
  }

  const findings = citedFindings(args);
  const warnings = [];
  const { failingTests, declaredNone } = declaredFailingTests(args, verdict, taskId, warnings);

  // WHICH TREE — the same resolveWorkChild path the review verdict uses, with
  // the producer pinned to dev: the work being delivered is the dev child's.
  // Fail-closed on ambiguity, exactly as a review verdict is.
  const registry = readRegistry(runId);
  const workChild = resolveWorkChild(registry, { squad: "delivery", childId: null, taskId }, taskId, args, {
    producer: "dev",
  });
  let fingerprint;
  // FOC-1210: live base-merge provenance — set only on the live contradicts
  // route, after mergeOnlySincePass proves it.
  let contradicts = null;
  if (contradictsArg !== undefined) {
    // The named round must exist in THIS run's chain, be readable, and carry a
    // diff: a copy of null would silently match nothing — exactly the UNKNOWN
    // this flag exists to stop recording.
    const n = contradictsArg === true || contradictsArg === "" ? NaN : Number(contradictsArg);
    if (!Number.isInteger(n) || n < 1) {
      failJson(`--contradicts-round "${contradictsArg === true ? "" : contradictsArg}" is not a round number N ≥ 1`);
    }
    const chain = roundsFor(runId, taskId);
    const named = chain.find((r) => r.round === n);
    if (!named) {
      failJson(`round ${n} of ${taskId} does not exist in run ${runId} — there is no verdict record to copy the fingerprint from`, {
        known: chain.map((r) => r.round),
      });
    }
    if (named.unreadable) {
      failJson(`round ${n} of ${taskId} is unreadable — the fingerprint cannot be copied from it`);
    }
    // The source marker must RESOLVE: the quality signal pairs it with review
    // rows by round, so naming a delivery record would write provenance no
    // consumer can resolve. A null squad is a legacy (pre-FOC-1169) record —
    // those were review records by construction and stay allowed.
    if (named.squad && named.squad !== "review") {
      failJson(
        `round ${n} of ${taskId} is a ${named.squad} verdict, not a REVIEW pass — ` +
          `the flag names the round whose pass this record contradicts, and the copy must come from that pass`,
      );
    }
    if (named.fingerprint?.diff == null) {
      failJson(`round ${n} of ${taskId} has no diff on its fingerprint — nothing to contradict (its tree was already UNKNOWN)`);
    }
    const { diff, tests, combined, changedFiles, failingTests: namedTests } = named.fingerprint;
    if (backfill) {
      fingerprint = { diff, tests, combined, changedFiles, failingTests: namedTests, source: `round-${n}` };
      warnings.push(`fingerprint copied from round ${n} of ${taskId} (--contradicts-round ${n}) — the tree as that round judged it, not the tree now`);
      // r2 finding 3: the FOC-220-gated declaration must not vanish — the copy
      // supersedes the fingerprint's failing-tests axis with round N's, so the
      // operator's own words carry separately on the record. (The live route
      // keeps its own fingerprint, so the declaration lives inside it and
      // needs no separate carrier.)
      if (failingTests.length) {
        warnings.push(
          `the --failing-test declaration (${failingTests.join(", ")}) is recorded as declaredFailingTests — ` +
            `the fingerprint's failing-tests axis is round ${n}'s, superseded by the copy`,
        );
      }
    } else {
      // FOC-1210 live route: keep the tree as it is NOW and prove that the
      // only change since the pass is a merge of the base branch. Fail closed
      // — a copy written without the proof would mislabel a later DEV round's
      // defect as the reviewer's miss.
      if (changedFiles > 0) {
        failJson(
          `--contradicts-round ${n} refused on a live record: round ${n} of ${taskId} judged a tree with ` +
            `${changedFiles} uncommitted change(s) — uncommitted state cannot be reproduced from history, ` +
            `so merge-only cannot be proven; refusing`,
        );
      }
      const proof = mergeOnlySincePass({
        worktree: workChild.worktree,
        baseRevision: workChild.baseRevision,
        passDiff: diff,
      });
      if (!proof.ok) {
        failJson(`--contradicts-round ${n} refused on a live record: ${proof.error}`, {
          hint: "record without --contradicts-round, or backfill the record with --backfill --recorded-at",
        });
      }
      fingerprint = progressFingerprint({
        worktree: workChild.worktree,
        baseRevision: workChild.baseRevision,
        failingTests,
      });
      if (fingerprint.error) warnings.push(`fingerprint is UNKNOWN: ${fingerprint.error}`);
      // resolveWorkChild fails closed, so workChild here is always the registry's
      // dev child — name it, the way the review record does.
      warnings.push(`fingerprinted ${workChild.childId}'s tree (${workChild.squad}) — the work under delivery review`);
      contradicts = { round: n, reason: "base-merge", fingerprint: { ...named.fingerprint } };
      warnings.push(
        `live --contradicts-round ${n}: only merges of the base branch landed since the pass ` +
          `(base-merge, pass tree ${String(proof.passTip).slice(0, 12)}) — the fingerprint above is the tree as it is NOW; ` +
          `the copy that pairs with the pass is in contradicts`,
      );
    }
  } else {
    fingerprint = progressFingerprint({
      worktree: workChild.worktree,
      baseRevision: workChild.baseRevision,
      failingTests,
    });
    if (fingerprint.error) warnings.push(`fingerprint is UNKNOWN: ${fingerprint.error}`);
    // resolveWorkChild fails closed, so workChild here is always the registry's
    // dev child — name it, the way the review record does.
    warnings.push(`fingerprinted ${workChild.childId}'s tree (${workChild.squad}) — the work under delivery review`);
  }

  // FOC-1222: the sha the delivery record covers. Live routes read the tree's
  // HEAD now; a backfill copies round N's fingerprint and cannot name the sha
  // that tree stood at — null is the honest answer, never this tree's HEAD.
  const candidate = backfill ? { sha: null } : worktreeHead(workChild.worktree);
  if (backfill) {
    warnings.push(`candidate is null — a backfilled record copies an earlier round's fingerprint; the sha that tree stood at is not recorded`);
  } else if (candidate.error) {
    warnings.push(`candidate sha is UNKNOWN: ${candidate.error}`);
  } else if (fingerprint.changedFiles > 0 && !warnings.some((w) => /uncommitted|dirty|porcelain/i.test(w))) {
    warnings.push(
      `fingerprinted a tree with ${fingerprint.changedFiles} uncommitted change(s) — ` +
        `the candidate sha covers the tree as it stands, the dirt is folded into the diff hash`,
    );
  }

  const prior = latestVerdict(runId, taskId);
  const round = Number(args.round ?? (prior?.round ?? 0) + 1);

  const record = {
    taskId,
    runId,
    childId: null,
    squad: "delivery",
    round,
    verdict,
    findings,
    acMapping: [],
    // No AC read in delivery mode: the verdict judges the delivered tree, not
    // the issue's criteria list. null is honest UNKNOWN, never a count.
    declaredAcs: null,
    fingerprint,
    // FOC-1222: the commit this record covers — the work child's HEAD on a
    // live record; null on a backfill (the judged tree predates this read).
    candidate: candidate.sha ?? null,
    // FOC-1169: the label. reason is required on a fail; null on a pass that
    // carried none. recordedBy separates this record's author from the
    // (absent) recording child.
    reason: reasonArg,
    recordedBy: "delivery",
    ...(backfill ? { backfill: true } : {}),
    // r2 finding 3: on the copy path the record's fingerprint is round N's —
    // the operator's own declaration carries here instead (empty on a fail is
    // impossible: the FOC-220 gate forces --failing-test or --no-failing-tests,
    // and the latter keeps its noFailingTests carrier). The live contradicts
    // route keeps its own fingerprint, so the declaration is inside it.
    ...(contradictsArg !== undefined && backfill && failingTests.length ? { declaredFailingTests: failingTests } : {}),
    // FOC-1210: the live base-merge route — the record's own fingerprint stays
    // "now", the contradicted pass's fingerprint rides in `contradicts`.
    ...(contradicts ? { contradicts } : {}),
    ...(declaredNone !== undefined ? { noFailingTests: { reason: declaredNone } } : {}),
    recordedAt,
  };

  const path = verdictPath(runId, taskId, round);
  if (existsSync(path) && !args.force) {
    failJson(`round ${round} of ${taskId} is already recorded — a verdict is recorded once`, {
      path,
      hint: "record the next round, or pass --force if this is deliberately a correction",
    });
  }

  // Delivery has no return emitter; the effects block is planned anyway so the
  // record shape stays the normal one — both ops come back "not-applicable"
  // (RETURN_EDGE_BY_SQUAD has no delivery entry), nothing is written to Linear.
  record.linearEffects = planReturnEffects(record, taskId, verdict, args, warnings);

  ensureRunDir(runId);
  mkdirSync(verdictsDir(runId), { recursive: true });
  atomicWriteJSON(path, record);

  // FOC-449 auto-join — inert unless --decision-event/--decision-run were
  // passed, same as the normal path.
  warnings.push(...autoLabel(record.decisionEvents, { outcome: verdict, by: "agent", via: "verdict" }).warnings);

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

export { VERDICTS, SEVERITIES, DELIVERY_REASONS, isEvidence, roundsFor, returnGateQuestion };

if (process.argv[1]?.endsWith("supervisor-verdict.mjs")) main();
