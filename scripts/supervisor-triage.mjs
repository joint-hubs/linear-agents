// scripts/supervisor-triage.mjs — which node of the graph picks this issue up?
//
//   node scripts/supervisor-triage.mjs propose --issue <id> [--issue-file <path>]
//   node scripts/supervisor-triage.mjs record  --issue <id> --verdict <plan|dev|review|test|ask>
//                                              --rationale "..." --confidence <0-100>
//                                              [--proposal <v>] [--unknown "..." ...] [--force]
//                                              [--size <small|medium|large>]
//   node scripts/supervisor-triage.mjs intake  --issue <id> [--issue-file <path>] --run <runId>
//
// `propose` is advisory and reads only deterministic signals — no model call, no
// judgement. `record` writes the verdict, and THE RECORDED VERDICT IS THE
// CONTRACT (spec §2.4, AC-2): supervisor-spawn.mjs refuses to start a child
// until .state/supervisor/<run>/triage.json exists.
//
// Two things this deliberately does NOT do:
//   · it never picks between four hardcoded squads. Routing comes from the
//     routable edges of config/graph.json, evaluated by the same matcher the
//     dashboard uses (scripts/graph-route.mjs). A proposal that does not resolve
//     to a node DECLARED in the graph is an error, never a fallback to `plan` —
//     silently defaulting is how you end up spawning a squad nobody chose.
//   · it never upgrades its own confidence. Below 70 with a verdict other than
//     `ask` is refused at the CLI, the same way the review-loop cap is (§2.2).
//
// FOC-451 adds `intake`: the three intake decisions (intake.triage_node,
// intake.has_acceptance_criteria, intake.task_size) served through the seam's
// decisionId channel and recorded as .state/supervisor/<run>/intake.json —
// triage.json's sibling. A0 discipline holds: the annotations are DISPLAYED —
// a seam/frontman disagreement is shown, never auto-acted — the recorded
// verdict and the final --size stay the frontman's call, and both final
// choices are logged as FOC-449 label records tied to the exact eventIds the
// intake calls carried. No OPENROUTER_API_KEY → the calls fail closed
// (auth_missing, visible in the record) and triage stays possible on the
// deterministic signals alone.
//
// Vocabulary warning: "entry node" here means "the node where THIS issue enters
// the graph" (which may be dev, review or test). It is NOT graph.json's
// `entryNodes`, which is a topology property — nodes legitimately reachable with
// no inbound edge. The two share a word and mean different things.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SHADOW_EVENT_TYPE, createDecisionCaller } from "./decision-call.mjs";
import { autoLabel, findEventFile } from "./decision-log.mjs";
import { loadGraph, emitHandoffRules } from "./graph-validate.mjs";
import { handoffTargetFrom, matchRule } from "./graph-route.mjs";
import { ROOT, ensureRunDir, failJson, intakePath, parseArgs, triagePath } from "./supervisor-lib.mjs";
import { atomicWriteJSON } from "./utils.mjs";

const VERDICTS = ["plan", "dev", "review", "test", "ask"];

// `ask` is not a squad, it is the human node — the one whose contract is "any
// task waiting on Mateusz". Routing an unresolved triage anywhere else would
// mean a machine decided what to do about not knowing what to do.
const ASK_NODE = "human";

const CONFIDENCE_FLOOR = 70;

// The intake gate (FOC-451): three registry decisions served at run start,
// annotation-only. The order mirrors the decide edges — triage first, the DoR
// readiness check alongside it, size last (it feeds the suggested flow).
const INTAKE_DECISIONS = ["intake.triage_node", "intake.has_acceptance_criteria", "intake.task_size"];

// The seam's state schema (DECISION_STEP.inputSchema) caps state at 16000
// chars — a longer issue body is truncated, never refused: an annotation over
// a truncated body beats no annotation, and the cap is the schema's, not ours.
const STATE_CAP = 16000;

// ── signals ──────────────────────────────────────────────────────────────────
// Every regex here answers a yes/no question about text already on the issue.
// Nothing infers intent; that is the Supervisor's job, with Mateusz.

const RE_AC = /^#{1,6}\s*(acceptance criteria|kryteria akceptacji)\b/im;
const RE_AC_INLINE = /(\*\*Given\*\*|\bAC-\d+\b)/im;
const RE_DOD = /^#{1,6}\s*(definition of done|dod)\b/im;
const RE_LIVE_VERIFY = /\b(live[- ]verif\w*|smoke test|end-to-end|e2e)\b/i;

// A hand-off comment is rendered by publish-linear-comment.mjs: an HTML marker
// carrying the tag, then a `## <squad> · <what> · <runId>` heading. Match either
// form — the heading is what a human reads, the marker is what the tool wrote,
// and a comment edited by hand can lose one without losing the other.
const RE_HANDOFF_HEADING = /^#{1,6}\s*(plan|dev|review|test)\s*·\s*hand-?off/im;
const RE_HANDOFF_MARKER = /<!--\s*run:[^>]*?\b(plan|dev|review|test)-hand-?off\b/i;

export function extractSignals(issue) {
  const description = typeof issue.description === "string" ? issue.description : "";
  const labels = (issue.labels?.nodes || issue.labels || [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter(Boolean);
  const commentBodies = (issue.comments?.nodes || issue.comments || [])
    .map((c) => (typeof c === "string" ? c : c?.body))
    .filter(Boolean);

  let handoffFrom = null;
  // Last one wins: an issue that bounced review→dev→review carries several
  // hand-offs, and the newest is the only one that describes where it is now.
  for (const body of commentBodies) {
    const m = RE_HANDOFF_HEADING.exec(body) || RE_HANDOFF_MARKER.exec(body);
    if (m) handoffFrom = m[1].toLowerCase();
  }

  return {
    identifier: issue.identifier || issue.id || null,
    state: issue.state?.name ?? null,
    stateType: issue.state?.type ?? null,
    labels,
    bodyEmpty: description.trim().length === 0,
    hasAcceptanceCriteria: RE_AC.test(description) || RE_AC_INLINE.test(description),
    hasDefinitionOfDone: RE_DOD.test(description),
    handoffFrom,
    liveVerify: RE_LIVE_VERIFY.test(description),
    estimateMissing: issue.estimate == null,
    subtaskCount: (issue.children?.nodes || []).length,
    commentCount: commentBodies.length,
  };
}

// ── the proposal ─────────────────────────────────────────────────────────────
// Ordered, and the order is the argument. Each step says what it knows and what
// it cannot know; the first step with an UNAMBIGUOUS answer wins, and anything
// ambiguous falls through to `ask` rather than to a default.

export function propose(signals, graph) {
  const rules = emitHandoffRules(graph); // the routable edges, in `order`
  const unknowns = [];
  let confidence = "high";
  const ask = (why) => {
    unknowns.push(why);
    confidence = "low";
    return ASK_NODE;
  };

  // Deterministic gaps, recorded regardless of the verdict — these are what the
  // verdict does NOT cover, and the Supervisor has to show them to Mateusz.
  if (signals.bodyEmpty) unknowns.push("body is empty — nothing states what done looks like");
  if (!signals.hasAcceptanceCriteria) unknowns.push("no acceptance criteria section in the body");
  if (!signals.hasDefinitionOfDone) unknowns.push("no definition of done section in the body");
  if (signals.estimateMissing) unknowns.push("no estimate");
  if (!signals.state) unknowns.push("no workflow state — the routable edges cannot be evaluated");

  // Every branch below returns a NODE id, not a verdict. The two vocabularies
  // coincide for plan/dev/review/test and diverge for `human`/`ask`, and going
  // through the node keeps the graph — not this function — the thing that says
  // where work can go.
  const decide = () => {
    // 1. Finished work. Routing it anywhere means redoing it.
    if (["completed", "canceled"].includes(signals.stateType)) {
      return ask(`issue is already ${signals.state || signals.stateType} — nothing to route`);
    }

    // 2. The graph's own routing. Same matcher, same rules, same order as the
    //    dashboard's suggestion, so triage and the queue never disagree.
    const { rule } = matchRule({ state: signals.state, labels: signals.labels }, rules);
    const byRule = rule?.next ?? null;

    // 3. A hand-off comment says a squad finished; the graph says who is next.
    let byHandoff = null;
    if (signals.handoffFrom) {
      byHandoff = handoffTargetFrom(graph, signals.handoffFrom);
      if (!byHandoff) {
        unknowns.push(
          `hand-off comment from "${signals.handoffFrom}", which has no outgoing handoff edge`,
        );
      }
    }

    // 4. Two independent families disagreeing is the definition of a mixed
    //    signal — with ONE exception (FOC-284 round 2). A `returned-by:*` flag is
    //    the machine stamp supervisor-verdict.mjs applies at the moment of the
    //    fail, so it is newer BY CONSTRUCTION than any hand-off comment: comments
    //    are append-only, and every returned task carries a stale one from the
    //    round before. Flag-gated only — with no flag the two families have no
    //    ordering, and disagreement stays the human question it always was.
    const hasReturnFlag = signals.labels.some((l) => String(l).startsWith("returned-by:"));
    if (byRule && byHandoff && byRule !== byHandoff) {
      if (hasReturnFlag) return byRule;
      return ask(
        `mixed signals: state/labels route to "${byRule}", the latest hand-off comment routes to "${byHandoff}"`,
      );
    }
    if (byRule) return byRule;
    if (byHandoff) return byHandoff;

    // 5. Nothing routed. `In Progress` WITHOUT a returned-by:* flag is the one
    //    state where that is actively dangerous: it is BOTH "returned for
    //    rework" and "a squad is working on it right now". The flag — applied
    //    by supervisor-verdict.mjs `record` on a review fail — is exactly what
    //    makes review-to-dev-return routable in graph.json; without it there is
    //    nothing to match.
    if (signals.state === "In Progress") {
      return ask(
        'state "In Progress" with no returned-by:* flag matches no routable edge — it is both ' +
          '"returned for rework" and "a squad already holds it"; the returned-by:* flag ' +
          '(stamped by supervisor-verdict.mjs on a review fail) is the discriminator that would decide it',
      );
    }

    // 6. Body signals. A task claiming readiness with no body contradicts
    //    itself, and that contradiction is not ours to resolve.
    const claimsReady = signals.labels.some(
      (l) => l === "dor-ok" || l === "ai:planned" || l === "planned",
    );
    if (signals.bodyEmpty && claimsReady) {
      return ask("labels declare the task ready (dor-ok/planned) but the body is empty");
    }
    if (signals.bodyEmpty || !signals.hasAcceptanceCriteria) return "plan";
    return "dev";
  };

  const node = decide();
  assertDeclared(graph, node);
  const proposal = verdictForNode(graph, node);

  return {
    proposal,
    node,
    autonomy: graph.nodes[node].autonomy,
    // AC-3. Every node ships as `supervised`, so this is `true` everywhere
    // today — the field is READ here so the wiring exists, not because a
    // promotion is imminent. Promotion is a human edit gated on FOC-163.
    requiresConfirmation: graph.nodes[node].autonomy === "supervised",
    unknowns,
    confidence,
  };
}

// A verdict is a name Mateusz can say; a node is a thing that exists in the
// topology. These three functions are the only place the two vocabularies are
// joined, and every one of them refuses rather than defaults.

function assertDeclared(graph, nodeId) {
  if (!graph.nodes || !graph.nodes[nodeId]) {
    const declared = Object.keys(graph.nodes || {}).join(", ") || "(none)";
    throw new Error(
      `node "${nodeId}" is not declared in config/graph.json (declared: ${declared})`,
    );
  }
  return nodeId;
}

export function resolveNode(graph, verdict) {
  const id = verdict === "ask" ? ASK_NODE : verdict;
  if (!graph.nodes || !graph.nodes[id]) {
    const declared = Object.keys(graph.nodes || {}).join(", ") || "(none)";
    throw new Error(
      `verdict "${verdict}" resolves to node "${id}", which config/graph.json does not declare (declared: ${declared})`,
    );
  }
  return id;
}

// The inverse. `human` is the node a person owns, and the verdict for "put this
// in front of a person" is `ask`. A node with no verdict name — `cadence` today,
// anything a future edge introduces — is a refusal, not a guess: `record` could
// not express such a verdict, so proposing one would produce a triage nobody
// can act on.
export function verdictForNode(graph, nodeId) {
  if (nodeId === ASK_NODE) return "ask";
  if (VERDICTS.includes(nodeId)) return nodeId;
  throw new Error(
    `the graph routes this issue to node "${nodeId}", which has no verdict name ` +
      `(verdicts: ${VERDICTS.join(", ")}) — triage cannot record a decision it cannot express`,
  );
}

// ── intake (FOC-451) ─────────────────────────────────────────────────────────
// The seam's annotations for the three intake decisions. The caller is the
// decision-call seam addressed BY REGISTRY ID (never inline questions — the
// registry owns the question text), so every answer arrives as the A0
// envelope: annotation, confidence, eventId — never an action flag.

const defaultNow = () => new Date().toISOString();

export function stateOf(issue) {
  const title = typeof issue?.title === "string" ? issue.title.trim() : "";
  const description = typeof issue?.description === "string" ? issue.description : "";
  const state = [title && `Title: ${title}`, description.trim()].filter(Boolean).join("\n\n");
  return state.length > STATE_CAP ? state.slice(0, STATE_CAP) : state;
}

// The seam answers questions as TYPED records (decision-call.mjs normalizeAnswers:
// noul → {type:"noul", noul:<p>}, choice → {type:"choice", choice:<label>},
// score → {type:"score", score:<n>}), while everything downstream of intake
// compares against primitives — verdict strings, size keys, squad-mapping keys.
// The unwrap semantics are the plan-gates precedent (scripts/plan-gates.mjs
// answerValueOf — not exported there, and this module must not import the whole
// plan-gates chain for one helper), replicated here with identical semantics:
// noul → its boolean verdict (p ≥ 0.5), choice → the label, score → the number,
// a non-object → itself, anything else → null. FOC-513: pitting a raw record
// against a string made every comparison disagree and printed "[object Object]";
// a null unwrap is an INCOMPARABLE side — skipped, never invented into agreement.
function answerValueOf(a) {
  if (a === null || a === undefined) return null;
  if (typeof a !== "object") return a;
  if (a.type === "noul") return typeof a.noul === "number" ? a.noul >= 0.5 : null;
  if (a.type === "choice") return typeof a.choice === "string" ? a.choice : null;
  if (a.type === "score") return typeof a.score === "number" && Number.isFinite(a.score) ? a.score : null;
  return null;
}

/**
 * Serve the three intake decisions and build the annotation record. A failed
 * decision (no API key, provider error, schema refusal) is recorded as
 * ok:false with its typed code — fail-closed and visible, triage still
 * possible. The disagreement between the seam's triage_node annotation and
 * the frontman's deterministic proposal is computed here and DISPLAYED by the
 * callers; nothing downstream acts on it.
 */
export async function buildIntake({ issue, graph, caller, runId = null, now = defaultNow }) {
  const signals = extractSignals(issue);
  let frontman;
  try {
    const proposal = propose(signals, graph);
    frontman = { proposal: proposal.proposal, node: proposal.node, confidence: proposal.confidence };
  } catch (err) {
    // A graph that cannot route does not block the annotations — but the
    // disagreement check has nothing to compare against, so it stays null.
    frontman = { error: err.message };
  }

  const state = stateOf(issue);
  const decisions = {};
  const warnings = [];
  for (const decisionId of INTAKE_DECISIONS) {
    try {
      const envelope = await caller({ state, decisionId });
      if (!envelope.ok) {
        decisions[decisionId] = {
          ok: false,
          code: envelope.error?.code ?? null,
          message: envelope.error?.message ?? null,
          ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
        };
        warnings.push(`${decisionId} failed closed (${envelope.error?.code ?? "error"}) — triage proceeds without the annotation`);
      } else {
        decisions[decisionId] = {
          ok: true,
          answer: Object.values(envelope.annotation?.answers ?? {})[0] ?? null,
          confidence: envelope.annotation?.confidence ?? null,
          eventId: envelope.eventId ?? null,
        };
      }
    } catch (err) {
      decisions[decisionId] = { ok: false, code: err?.code ?? null, message: err?.message ?? null };
      warnings.push(`${decisionId} failed closed (${err?.code ?? "error"}) — triage proceeds without the annotation`);
    }
  }

  // FOC-513: the stored answers keep the RAW typed records (fidelity — the
  // FOC-449 join and any later re-read see the seam's exact shape); every
  // comparison, lookup key and display below reads the unwrapped primitive.
  const seamTriage = decisions["intake.triage_node"].ok
    ? answerValueOf(decisions["intake.triage_node"].answer)
    : null;
  const disagreement =
    seamTriage !== null && frontman.proposal != null && seamTriage !== frontman.proposal
      ? { decisionId: "intake.triage_node", seam: seamTriage, frontman: frontman.proposal }
      : null;

  const size = decisions["intake.task_size"].ok
    ? answerValueOf(decisions["intake.task_size"].answer)
    : null;
  let suggestedFlow = null;
  let flowReason = null;
  // Null (no answer, or one that unwraps to nothing) is absent: no lookup, no
  // reason, no disagreement. A boolean/score unwrapped from a malformed size
  // answer still gets its lookup attempt — the failure names the unwrapped
  // key, never the raw record.
  if (size !== null) {
    const squads = graph?.intakeFlows?.[size];
    if (Array.isArray(squads)) suggestedFlow = { size, squads };
    else {
      flowReason = graph?.intakeFlows
        ? `no "${size}" entry in graph.intakeFlows`
        : 'config/graph.json carries no "intakeFlows" size→flow mapping';
    }
  }

  return {
    record: {
      issue: signals.identifier || null,
      createdAt: now(),
      runId,
      decisions,
      frontman,
      disagreement,
      size,
      ...(suggestedFlow ? { suggestedFlow } : {}),
      ...(flowReason ? { flowReason } : {}),
    },
    warnings,
  };
}

/**
 * The size→flow lookup for the FINAL recorded size: validated against the
 * config mapping's own keys, refused otherwise — a size nobody mapped would
 * suggest a flow nobody built.
 */
export function resolveSizeFlow(graph, size) {
  const flows = graph?.intakeFlows;
  if (!flows || typeof flows !== "object") {
    throw new Error('config/graph.json carries no "intakeFlows" size→flow mapping — the final size cannot be validated against it');
  }
  const flow = flows[size];
  if (!Array.isArray(flow)) {
    throw new Error(`unknown size "${size}" — intakeFlows carries: ${Object.keys(flows).join(", ")}`);
  }
  return flow;
}

/**
 * The intake summary that rides the triage record: the seam's answers,
 * confidences and eventIds NEXT TO the verdict, plus both disagreement views.
 * The final-size view can only exist here (the seam's size annotation is
 * compared against what was actually recorded).
 */
function intakeSummaryOf(intake, recordedSize) {
  const decisions = {};
  for (const decisionId of INTAKE_DECISIONS) {
    const d = intake?.decisions?.[decisionId];
    if (!d) continue;
    decisions[decisionId] = {
      ok: d.ok === true,
      answer: d.answer ?? null,
      confidence: d.confidence ?? null,
      ...(d.eventId ? { eventId: d.eventId } : {}),
      ...(d.ok ? {} : { code: d.code ?? null }),
    };
  }
  const seamSize = intake?.decisions?.["intake.task_size"];
  // FOC-513: the comparison — and the seam value this object stores — read the
  // unwrapped primitive. Pitting the raw typed record against the recorded size
  // string made equal values disagree and printed "[object Object]".
  const seamSizeValue = seamSize?.ok ? answerValueOf(seamSize.answer) : null;
  const sizeDisagreement =
    recordedSize && seamSizeValue !== null && seamSizeValue !== recordedSize
      ? { seam: seamSizeValue, recorded: recordedSize }
      : null;
  return {
    decisions,
    disagreement: intake?.disagreement ?? null,
    ...(sizeDisagreement ? { sizeDisagreement } : {}),
  };
}

/**
 * The taskKey of the run-log event an intake eventId points at — the issue the
 * decision call actually served. Null when the event carries none; an event
 * that is nowhere throws, and the caller turns that into the same unknown-event
 * warning the label write would have produced.
 */
function eventTaskKeyOf(eventId, { runId = null, runsDir } = {}) {
  const { path } = findEventFile(eventId, { runId, runsDir });
  const line = readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((l) => l?.type === SHADOW_EVENT_TYPE && l?.eventId === eventId);
  return line?.taskKey ?? null;
}

/**
 * The final-choice auto-join (FOC-449): the recorded verdict and the recorded
 * size are the OUTCOMES the triage_node/task_size events train against, so
 * `record` labels them tied to the exact eventIds the intake calls carried.
 * Before anything is written, every event is checked against the issue being
 * recorded — its taskKey must BE this issue, or the label is skipped with a
 * warning: an outcome must never be joined to another issue's decision event,
 * however the intake file came to carry it. Fail-closed, the same philosophy
 * as the triage guard. Best-effort by contract — a failed label (unknown
 * event, unwritable log) is a warning, never a broken verdict. No eventId →
 * nothing labelled; no size → no size label.
 */
export function labelRecordedIntake({ intake, verdict, size, runsDir, issue } = {}) {
  if (typeof issue !== "string" || !issue.trim()) {
    throw new Error(
      "labelRecordedIntake needs the issue being recorded — the eventId→issue pairing cannot be verified without it",
    );
  }
  const decisions = intake?.decisions ?? {};
  const pairFor = (decisionId) => {
    const d = decisions[decisionId];
    return d?.eventId ? [{ eventId: d.eventId, runId: intake.runId ?? null }] : [];
  };
  const labelled = [];
  const warnings = [];
  const join = (pairs, outcome) => {
    if (!pairs.length || outcome == null) return;
    const paired = [];
    for (const pair of pairs) {
      let taskKey = null;
      let lookupError = null;
      try {
        taskKey = eventTaskKeyOf(pair.eventId, { runId: pair.runId, runsDir });
      } catch (err) {
        lookupError = err;
      }
      if (lookupError) {
        warnings.push(`decision label for event ${pair.eventId} was not written: ${lookupError.message}`);
        continue;
      }
      if (taskKey !== issue) {
        warnings.push(
          `decision label for event ${pair.eventId} was not written: its taskKey is "${taskKey ?? "missing"}", ` +
            `not "${issue}" — a cross-issue outcome is never joined`,
        );
        continue;
      }
      paired.push(pair);
    }
    const res = autoLabel(paired, { outcome: String(outcome), by: "agent", via: "verdict", ...(runsDir ? { runsDir } : {}) });
    labelled.push(...res.labelled);
    warnings.push(...res.warnings);
  };
  join(pairFor("intake.triage_node"), verdict);
  join(pairFor("intake.task_size"), size);
  return { labelled, warnings };
}

// ── issue loading ────────────────────────────────────────────────────────────
// --issue-file is the offline seam: the test suite feeds fixtures through it,
// and it is also how you triage from a saved payload when Linear is down.
function loadIssue(args) {
  if (args["issue-file"]) {
    const path = args["issue-file"];
    if (!existsSync(path)) failJson(`--issue-file ${path} does not exist`);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return parsed.issue ?? parsed;
    } catch (err) {
      failJson(`--issue-file ${path} is not readable JSON: ${err.message}`);
    }
  }
  try {
    const out = execFileSync(
      process.execPath,
      [join(ROOT, "scripts", "linear-query.mjs"), "issue", args.issue, "--json"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return JSON.parse(out);
  } catch (err) {
    failJson(`could not read issue ${args.issue} from Linear: ${err.message.split("\n")[0]}`, {
      hint: "pass --issue-file <path> to triage from a saved payload",
    });
  }
}

function loadGraphOrFail() {
  try {
    return loadGraph();
  } catch (err) {
    failJson(`config/graph.json could not be read: ${err.message}`);
  }
}

// ── subcommands ──────────────────────────────────────────────────────────────

function cmdPropose(args) {
  if (!args.issue) failJson("--issue <id> is required");
  const graph = loadGraphOrFail();
  const issue = loadIssue(args);
  const signals = extractSignals(issue);

  let result;
  try {
    result = propose(signals, graph);
  } catch (err) {
    failJson(err.message);
  }

  console.log(
    JSON.stringify({ ok: true, issue: signals.identifier || args.issue, ...result, signals }, null, 2),
  );
}

const asList = (v) => (v === undefined || v === true ? [] : Array.isArray(v) ? v : [v]);

function cmdRecord(args) {
  if (!args.issue) failJson("--issue <id> is required");
  if (!args.verdict || !VERDICTS.includes(args.verdict)) {
    failJson(`--verdict must be one of ${VERDICTS.join(" | ")}`);
  }
  if (!args.rationale || args.rationale === true) failJson('--rationale "..." is required');

  // Required, not defaulted. A default would be a number nobody chose, and the
  // whole point of keeping confidence is calibration — stated vs. outcome (§6).
  if (args.confidence === undefined || args.confidence === true) {
    failJson(
      "--confidence <0-100> is required — a recorded verdict without one cannot be calibrated",
    );
  }
  const confidence = Number(args.confidence);
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
    failJson(`--confidence must be an integer 0-100 (got "${args.confidence}")`);
  }
  // Fail-closed calibration, enforced in tooling like the review-loop cap.
  if (confidence < CONFIDENCE_FLOOR && args.verdict !== "ask") {
    failJson(
      `confidence ${confidence} is below ${CONFIDENCE_FLOOR}, so the verdict must be "ask" (got "${args.verdict}")`,
      {
        hint: "either raise the confidence with a reason, or record ask and put the question to Mateusz",
      },
    );
  }

  if (args.proposal && args.proposal !== true && !VERDICTS.includes(args.proposal)) {
    failJson(`--proposal must be one of ${VERDICTS.join(" | ")}`);
  }

  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");

  const graph = loadGraphOrFail();
  let node;
  try {
    node = resolveNode(graph, args.verdict);
  } catch (err) {
    failJson(err.message);
  }

  // FOC-451: the final size is optional, but when given it must be one the
  // config's size→flow mapping actually knows — a size nobody mapped would
  // suggest a flow nobody built.
  let sizeFlow = null;
  if (args.size !== undefined) {
    try {
      sizeFlow = resolveSizeFlow(graph, String(args.size));
    } catch (err) {
      failJson(err.message, { hint: "sizes come from graph.intakeFlows (config/graph.json)" });
    }
  }

  // The intake annotations, recorded NEXT TO the verdict: intake.json is the
  // sibling artifact the `intake` subcommand wrote for this run; its summary
  // rides the triage record so a reviewer reads the annotations and the
  // verdict they informed in one place. No intake → no summary, no display.
  let intake = null;
  const intakeFile = intakePath(runId);
  if (existsSync(intakeFile)) {
    try {
      intake = JSON.parse(readFileSync(intakeFile, "utf8"));
    } catch (err) {
      failJson(`${intakeFile} exists but is not readable JSON: ${err.message}`);
    }
  }

  // One triage.json per run, and a run handles one issue. Overwriting the
  // verdict for a DIFFERENT issue would silently retarget every later spawn in
  // the run, so it takes --force. Re-recording the SAME issue is allowed: new
  // information legitimately changes a verdict.
  const path = triagePath(runId);
  if (existsSync(path) && !args.force) {
    let prior = null;
    try {
      prior = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      failJson(`${path} exists but is not readable JSON: ${err.message}`);
    }
    if (prior?.issue && prior.issue !== args.issue) {
      failJson(
        `run ${runId} already has a verdict for ${prior.issue}; recording ${args.issue} would retarget every spawn in this run`,
        { existing: prior, hint: "start a new run, or pass --force if this is deliberate" },
      );
    }
  }

  // One intake.json per run too, and its eventIds belong to the issue `intake`
  // ran for. Recording a DIFFERENT issue would pair this run's outcome with
  // another issue's decision events — silently corrupting the FOC-449 training
  // join — so the mismatch is refused before anything is embedded or labelled.
  // Re-recording the SAME issue is allowed, as with the verdict. Under --force
  // the foreign intake data is DROPPED, never re-parented: --force replaces
  // the verdict, but it cannot make another issue's annotations belong to
  // this one.
  if (intake?.issue && intake.issue !== args.issue) {
    if (!args.force) {
      failJson(
        `run ${runId} already has intake annotations for ${intake.issue}; recording ${args.issue} would pair them with the wrong outcome`,
        { existing: intake, hint: "start a new run, or pass --force to record without the intake data" },
      );
    }
    console.error(
      `[triage] intake.json belongs to ${intake.issue}, not ${args.issue} — dropping the intake summary and its FOC-449 labels`,
    );
    intake = null;
  }

  const size = args.size !== undefined ? String(args.size) : null;
  const intakeView = intake ? intakeSummaryOf(intake, size) : null;
  const record = {
    issue: args.issue,
    verdict: args.verdict,
    node,
    autonomy: graph.nodes[node].autonomy,
    proposal: args.proposal && args.proposal !== true ? args.proposal : null,
    rationale: args.rationale,
    unknowns: asList(args.unknown),
    confidence,
    decidedBy: "supervisor",
    createdAt: new Date().toISOString(),
    ...(size ? { size, suggestedFlow: sizeFlow } : {}),
    ...(intakeView ? { intake: intakeView } : {}),
  };

  ensureRunDir(runId);
  atomicWriteJSON(path, record);

  // A0 display: the seam's annotations are shown next to the recorded choice,
  // never auto-acted — the verdict proceeds regardless of what they say.
  // FOC-513: the triage line's trigger is the seam's UNWRAPPED answer vs the
  // RECORDED verdict (args.verdict) — where the annotation and the actual
  // decision diverge; the stored disagreement keeps the seam-vs-frontman view
  // for the record. Interpolating the raw typed record printed
  // "[object Object]".
  const seamTriage = intakeView?.decisions?.["intake.triage_node"];
  const seamTriageValue = seamTriage?.ok ? answerValueOf(seamTriage.answer) : null;
  if (seamTriageValue !== null && seamTriageValue !== args.verdict) {
    // The seam's stated confidence rides the line; a null one is omitted
    // rather than printed as "(null)".
    const c = seamTriage.confidence;
    console.error(
      `[triage] A0 disagreement — seam intake.triage_node says "${seamTriageValue}"` +
        `${Number.isFinite(c) ? ` (${c})` : ""}, ` +
        `the recorded verdict is "${args.verdict}": displayed, never auto-acted`,
    );
  }
  if (intakeView?.sizeDisagreement) {
    console.error(
      `[triage] A0 disagreement — seam intake.task_size says "${intakeView.sizeDisagreement.seam}", ` +
        `the recorded size is "${intakeView.sizeDisagreement.recorded}": displayed, never auto-acted`,
    );
  }

  // The final choices become FOC-449 labels tied to the intake eventIds.
  // Best-effort: a failed label warns on stderr and never breaks the verdict.
  const { warnings: labelWarnings } = labelRecordedIntake({ intake, verdict: args.verdict, size, issue: args.issue });
  for (const w of labelWarnings) console.error(`[triage] ${w}`);

  console.log(JSON.stringify({ ok: true, path, ...record }, null, 2));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function cmdIntake(args) {
  if (!args.issue) failJson("--issue <id> is required");
  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  if (!runId) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");
  const graph = loadGraphOrFail();
  const issue = loadIssue(args);

  // A0 annotations via the seam's decisionId channel — the registry owns the
  // question text, never inline questions. No OPENROUTER_API_KEY → every call
  // fails closed (auth_missing, before any network attempt); the record shows
  // the failures and the deterministic triage stays usable.
  const caller = createDecisionCaller({ apiKey: process.env.OPENROUTER_API_KEY, runId, taskKey: args.issue });
  let built;
  try {
    built = await buildIntake({ issue, graph, caller, runId });
  } catch (err) {
    failJson(`intake decisions could not be served: ${err.message}`);
  }
  const { record, warnings } = built;
  for (const w of warnings) console.error(`[triage] ${w}`);
  // The record's identity is the id this CLI was invoked with — the SAME
  // vocabulary the events' taskKey and triage.json carry. The payload-derived
  // identifier (extractSignals) falls back to the raw issue id when a payload
  // has no identifier field, which would store a uuid here and break the
  // record-time own-issue comparison against --issue.
  record.issue = args.issue;

  const path = intakePath(runId);
  try {
    ensureRunDir(runId);
    atomicWriteJSON(path, record);
  } catch (err) {
    failJson(`could not write ${path}: ${err.message}`);
  }
  console.log(JSON.stringify({ ok: true, path, ...record, warnings }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), new Set(["unknown"]));
  const cmd = args._[0];

  if (cmd === "propose") return cmdPropose(args);
  if (cmd === "record") return cmdRecord(args);
  if (cmd === "intake") return cmdIntake(args);

  failJson(`unknown subcommand "${cmd ?? ""}" — expected propose | record | intake`);
}

if (process.argv[1]?.endsWith("supervisor-triage.mjs")) main();
