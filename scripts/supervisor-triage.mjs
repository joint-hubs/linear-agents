// scripts/supervisor-triage.mjs — which node of the graph picks this issue up?
//
//   node scripts/supervisor-triage.mjs propose --issue <id> [--issue-file <path>]
//   node scripts/supervisor-triage.mjs record  --issue <id> --verdict <plan|dev|review|test|ask>
//                                              --rationale "..." --confidence <0-100>
//                                              [--proposal <v>] [--unknown "..." ...] [--force]
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
// Vocabulary warning: "entry node" here means "the node where THIS issue enters
// the graph" (which may be dev, review or test). It is NOT graph.json's
// `entryNodes`, which is a topology property — nodes legitimately reachable with
// no inbound edge. The two share a word and mean different things.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadGraph, emitHandoffRules } from "./graph-validate.mjs";
import { handoffTargetFrom, matchRule } from "./graph-route.mjs";
import { ROOT, ensureRunDir, failJson, parseArgs, triagePath } from "./supervisor-lib.mjs";
import { atomicWriteJSON } from "./utils.mjs";

const VERDICTS = ["plan", "dev", "review", "test", "ask"];

// `ask` is not a squad, it is the human node — the one whose contract is "any
// task waiting on Mateusz". Routing an unresolved triage anywhere else would
// mean a machine decided what to do about not knowing what to do.
const ASK_NODE = "human";

const CONFIDENCE_FLOOR = 70;

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
    //    signal. Picking the "stronger" one here would be a judgement call
    //    dressed up as a rule.
    if (byRule && byHandoff && byRule !== byHandoff) {
      return ask(
        `mixed signals: state/labels route to "${byRule}", the latest hand-off comment routes to "${byHandoff}"`,
      );
    }
    if (byRule) return byRule;
    if (byHandoff) return byHandoff;

    // 5. Nothing routed. `In Progress` is the one state where that is actively
    //    dangerous: it is BOTH "returned by review" and "a squad is working on
    //    it right now", and no field on the issue tells the two apart. Same
    //    reason review-to-dev-return is declared non-routable in graph.json.
    if (signals.state === "In Progress") {
      return ask(
        'state "In Progress" matches no routable edge — it is both "returned for rework" and ' +
          '"a squad already holds it", and nothing on the issue discriminates',
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
  };

  ensureRunDir(runId);
  atomicWriteJSON(path, record);
  console.log(JSON.stringify({ ok: true, path, ...record }, null, 2));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2), new Set(["unknown"]));
  const cmd = args._[0];

  if (cmd === "propose") return cmdPropose(args);
  if (cmd === "record") return cmdRecord(args);

  failJson(`unknown subcommand "${cmd ?? ""}" — expected propose | record`);
}

if (process.argv[1]?.endsWith("supervisor-triage.mjs")) main();
