// scripts/graph-validate.mjs — validate config/graph.json, and render it.
//
// The topology used to live in prose (agents/*/CLAUDE.md) plus four routing
// rules in config/handoff-rules.json. Prose cannot be checked, and the two
// drifted apart silently — the review→dev return path was never in
// handoff-rules.json, so returns routed to null in the dashboard and nobody
// noticed. FOC-284 closed that gap: both return edges are routable and emitted,
// keyed on the returned-by:* flags that supervisor-verdict.mjs applies on a
// review fail. A graph you can validate is the point of FOC-158.
//
// v2 (FOC-397, Option A — docs/plans/graph-json-v2-design.md §6.1): version 2
// is additive. Node contracts, the top-level `edges` array and both emitters
// stay v1-untouched; a squad node may carry `steps` (its step decomposition —
// each step object is exactly the D7 list: kind, reads, output, tier, failure,
// writes, keyed by id) plus `stepFlow` (sequence edges), and the graph may
// carry a top-level `decisionEdges` array. v2 mode additionally cross-checks
// every step's D7 fields deep-equal against its config/decisions.json entry —
// the two files must not drift.
//
// Usage:
//   node scripts/graph-validate.mjs                       validate, exit 0/1
//   node scripts/graph-validate.mjs --emit-puml           PlantUML on stdout
//   node scripts/graph-validate.mjs --emit-handoff-rules  handoff-rules JSON on stdout
//   node scripts/graph-validate.mjs <path>                validate another graph file
//
// The positional path exists so the failure paths are testable end-to-end against
// a broken fixture, not only through the exported functions. The v2 step
// cross-check always compares against the committed config/decisions.json —
// that file is the drift baseline, whatever graph path is being validated.
//
// Both emitters validate first: never render a broken graph.
// Human output goes to stderr, machine output to stdout, so a redirect
// (`> docs/diagrams/07_squad_graph.puml`) captures only the artifact.

import { readFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EDGE_TYPES = ["handoff", "return", "escalate", "gate"];
const CONTRACT_FIELDS = ["input", "output", "completion", "failure", "budget"];
const AUTONOMY_LEVELS = ["supervised", "bounded", "scheduled"];
const GRAPH_VERSIONS = [1, 2];

// D7 — the seven fields a v2 step object carries (design doc §6.2, verbatim
// binding); the step's key in `steps` is its id, so it is not a field itself.
const D7_FIELDS = ["kind", "reads", "output", "tier", "failure", "writes"];
const STEP_KINDS = ["D", "J", "A", "H", "G"];
const STEP_FAILURES = ["stop", "escalate"];
const STEP_WRITES = ["run-record", "envelope", "graph-state"];

// The tier shape follows the step kind (design doc §6.3): deterministic [D] and
// human [H] steps run on no model tier, [G] is pinned to the cheap tier, [A]
// runs on the agent tier, and a [J] decision carries the cascade-ladder pin.
const TIER_OK = {
  D: (t) => t === null,
  H: (t) => t === null,
  G: (t) => t === "cheap",
  A: (t) => t === "agent",
  J: (t) => t !== null && typeof t === "object" && t.cascade === true && [1, 2, 3].includes(t.min),
};
const TIER_EXPECTED = {
  D: "null",
  H: "null",
  G: '"cheap"',
  A: '"agent"',
  J: "{ cascade: true, min: 1 | 2 | 3 }",
};

export function loadGraph(path = join(ROOT, "config", "graph.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// The step↔registry cross-check baseline. Plain JSON.parse, not the registry
// loader: the validator checks shape, it does not need the loader's ajv pass.
function loadRegistryEntries(problems) {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, "config", "decisions.json"), "utf8"));
    return parsed.entries || {};
  } catch (err) {
    problems.push(`config/decisions.json could not be read for the step cross-check: ${err.message}`);
    return {};
  }
}

function sameValue(a, b) {
  try {
    deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

// ── v2 steps ─────────────────────────────────────────────────────────────────
// A step object carries exactly the D7 list — a step carrying anything else
// (budget, autonomy, a prompt) is a drift away from the registry contract, and
// budget on a step would quietly re-open the squad-granularity question FOC-162
// answered at node level.
function validateSteps(nodeName, steps, problems) {
  for (const [stepId, step] of Object.entries(steps)) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      problems.push(
        `node "${nodeName}" step "${stepId}" must be an object carrying exactly the D7 list (${D7_FIELDS.join(", ")})`,
      );
      continue;
    }
    const unknown = Object.keys(step).filter((k) => !D7_FIELDS.includes(k));
    if (unknown.length) {
      problems.push(
        `step "${stepId}" carries field(s) ${unknown.join(", ")} outside the D7 list (${D7_FIELDS.join(", ")}) — a step object carries nothing else`,
      );
    }
    for (const field of D7_FIELDS) {
      if (step[field] === undefined) problems.push(`step "${stepId}" is missing D7 field "${field}"`);
    }
    if (step.kind != null && !STEP_KINDS.includes(step.kind)) {
      problems.push(`step "${stepId}" has kind "${step.kind}", expected one of ${STEP_KINDS.join(" | ")}`);
    }
    if (step.kind in TIER_OK && !TIER_OK[step.kind](step.tier)) {
      problems.push(
        `step "${stepId}" has tier ${JSON.stringify(step.tier)} — kind ${step.kind} expects ${TIER_EXPECTED[step.kind]}`,
      );
    }
    if (Array.isArray(step.reads)) {
      if (!step.reads.length) problems.push(`step "${stepId}" declares no reads`);
      else if (step.reads.some((r) => typeof r !== "string")) {
        problems.push(`step "${stepId}" has non-string reads`);
      } else if (step.reads.length > 12) {
        problems.push(`step "${stepId}" declares ${step.reads.length} reads — at most 12 per step`);
      }
    }
    if (step.output != null && (typeof step.output !== "object" || Array.isArray(step.output))) {
      problems.push(`step "${stepId}" declares a non-object "output" — it must be a JSON Schema object`);
    }
  }
}

function validateStepFlow(nodeName, steps, flow, problems) {
  if (!Array.isArray(flow)) {
    problems.push(`node "${nodeName}" declares steps but "stepFlow" is not an array`);
    return;
  }
  const ids = Object.keys(steps);
  for (const [i, e] of flow.entries()) {
    const label = `stepFlow edge #${i}`;
    if (e.type !== "sequence") problems.push(`${label} has type "${e.type}", expected "sequence"`);
    if (!steps[e.from]) problems.push(`${label} references unknown step "${e.from}" as from`);
    if (!steps[e.to]) problems.push(`${label} references unknown step "${e.to}" as to`);
  }
  if (flow.length !== Math.max(ids.length - 1, 0)) {
    problems.push(
      `node "${nodeName}" declares ${ids.length} steps but ${flow.length} sequence edges — a linear step chain carries exactly n-1`,
    );
  }
  const inbound = {};
  const outbound = {};
  for (const e of flow) {
    outbound[e.from] = (outbound[e.from] || 0) + 1;
    inbound[e.to] = (inbound[e.to] || 0) + 1;
  }
  for (const id of ids) {
    if ((inbound[id] || 0) > 1) {
      problems.push(`step "${id}" has ${inbound[id]} inbound sequence edges — stepFlow is a linear chain, at most one each`);
    }
    if ((outbound[id] || 0) > 1) {
      problems.push(`step "${id}" has ${outbound[id]} outbound sequence edges — stepFlow is a linear chain, at most one each`);
    }
  }
  const heads = ids.filter((id) => !inbound[id]);
  const tails = ids.filter((id) => !outbound[id]);
  if (heads.length !== 1 || tails.length !== 1) {
    problems.push(
      `stepFlow must be one linear chain — found ${heads.length} step(s) without inbound and ${tails.length} without outbound edges`,
    );
  }
  if (heads.length === 1) {
    const seen = new Set([heads[0]]);
    let cursor = heads[0];
    for (let i = 0; i <= ids.length; i++) {
      const next = flow.find((e) => e.from === cursor);
      if (!next) break;
      if (seen.has(next.to)) {
        problems.push("stepFlow contains a cycle — steps execute once, in sequence");
        break;
      }
      seen.add(next.to);
      cursor = next.to;
    }
    if (seen.size !== ids.length) {
      problems.push(`stepFlow reaches ${seen.size} of ${ids.length} declared steps — every step must sit on the chain`);
    }
  }
}

// ── v2 decisionEdges ─────────────────────────────────────────────────────────
// Decide edges never match a task state — graph-route reads `edges` only, so
// they are inert by construction; what must hold is that they name real scopes
// and a registry entry, because the registry entry owns the autonomy fields.
function validateDecisionEdges(graph, nodes, entries, problems) {
  const dec = graph.decisionEdges;
  if (dec === undefined) return;
  if (!Array.isArray(dec)) {
    problems.push("graph.decisionEdges must be an array");
    return;
  }
  const seen = new Set((graph.edges || []).map((e) => e.id));
  for (const [i, e] of dec.entries()) {
    const label = e.id ? `decision edge "${e.id}"` : `decision edge #${i}`;

    if (!e.id) problems.push(`${label} has no id`);
    else if (seen.has(e.id)) problems.push(`duplicate decision edge id "${e.id}"`);
    else seen.add(e.id);

    if (e.from !== "*" && !nodes[e.from]) problems.push(`${label} references unknown node "${e.from}" as from`);
    if (e.to !== "*" && !nodes[e.to]) problems.push(`${label} references unknown node "${e.to}" as to`);
    if (e.type !== "decide") problems.push(`${label} has type "${e.type}", expected "decide"`);
    if (!e.registry) {
      problems.push(`${label} names no registry entry — the registry entry owns autonomy, threshold, fallback and metrics`);
    } else if (!entries[e.registry]) {
      problems.push(`${label} names registry entry "${e.registry}", which does not exist in config/decisions.json`);
    } else if (entries[e.registry].kind !== "J") {
      problems.push(`${label} names registry entry "${e.registry}" of kind ${entries[e.registry].kind} — decision edges bind kind-J entries`);
    }
    if (!e.why) problems.push(`${label} has no "why" — the rationale is the thing worth keeping, not the rule`);
    if (
      e.when !== undefined &&
      (e.when === null || typeof e.when !== "object" || Array.isArray(e.when) || !Object.keys(e.when).length)
    ) {
      problems.push(`${label} has an empty or non-object "when"`);
    }
  }
}

// ── v2 step↔registry cross-check ────────────────────────────────────────────
// Each step's D7 fields must deep-equal its registry entry. The copy in
// graph.json is a rendered view; the registry is the contract. A drift between
// the two files is exactly the class of silent divergence this file exists to
// catch (see the FOC-284 paragraph in the header).
function crossCheckSteps(graph, entries, problems) {
  for (const node of Object.values(graph.nodes || {})) {
    for (const [stepId, step] of Object.entries(node.steps || {})) {
      const entry = entries[stepId];
      if (!entry) {
        problems.push(`step "${stepId}" has no config/decisions.json entry — the step↔registry cross-check cannot hold`);
        continue;
      }
      for (const field of D7_FIELDS) {
        if (!sameValue(step[field], entry[field])) {
          problems.push(
            `step "${stepId}" drifts from its config/decisions.json entry on "${field}" — copy the D7 fields from the registry`,
          );
        }
      }
    }
  }
}

// Every check returns a list of human-readable problems. A problem names the
// offending node or edge by id — a validator that says "invalid graph" and
// makes you diff by hand is not worth running.
export function validateGraph(graph) {
  const problems = [];

  const nodes = graph.nodes || {};
  const edges = graph.edges || [];
  const nodeNames = Object.keys(nodes);
  const entryNodes = graph.entryNodes || [];

  if (!nodeNames.length) problems.push("graph declares no nodes");
  if (!Array.isArray(graph.edges)) problems.push("graph.edges must be an array");

  // ── version ─────────────────────────────────────────────────────────────────
  if (graph.version == null) {
    problems.push('graph has no "version" — v1 squad topology declares 1, v2 (additive steps/decisionEdges) declares 2');
  } else if (!GRAPH_VERSIONS.includes(graph.version)) {
    problems.push(
      `graph version ${JSON.stringify(graph.version)} — expected one of ${GRAPH_VERSIONS.join(" | ")}`,
    );
  }

  for (const name of entryNodes) {
    if (!nodes[name]) problems.push(`entryNodes lists "${name}", which is not a declared node`);
  }

  // ── node contracts ──────────────────────────────────────────────────────────
  for (const [name, node] of Object.entries(nodes)) {
    for (const field of CONTRACT_FIELDS) {
      if (node[field] == null) {
        problems.push(`node "${name}" is missing required contract field "${field}"`);
      }
    }
    if (node.autonomy == null) {
      problems.push(`node "${name}" is missing "autonomy"`);
    } else if (!AUTONOMY_LEVELS.includes(node.autonomy)) {
      problems.push(
        `node "${name}" has autonomy "${node.autonomy}", expected one of ${AUTONOMY_LEVELS.join(" | ")}`,
      );
    }
  }

  // ── edges reference real nodes ──────────────────────────────────────────────
  // `from: "*"` is the any-source wildcard (the needs:* gate applies wherever the
  // task is); it is not a node and must not be reported as unknown.
  const seenIds = new Set();
  for (const [i, edge] of edges.entries()) {
    const label = edge.id ? `edge "${edge.id}"` : `edge #${i}`;

    if (!edge.id) problems.push(`${label} has no id`);
    else if (seenIds.has(edge.id)) problems.push(`duplicate edge id "${edge.id}"`);
    else seenIds.add(edge.id);

    if (edge.from !== "*" && !nodes[edge.from]) {
      problems.push(`${label} references unknown node "${edge.from}" as from`);
    }
    if (!nodes[edge.to]) {
      problems.push(`${label} references unknown node "${edge.to}" as to`);
    }
    if (!EDGE_TYPES.includes(edge.type)) {
      problems.push(`${label} has type "${edge.type}", expected one of ${EDGE_TYPES.join(" | ")}`);
    }
    if (edge.routable && !edge.when) {
      problems.push(`${label} is routable but declares no "when" condition`);
    }
    if (!edge.why) {
      problems.push(`${label} has no "why" — the rationale is the thing worth keeping, not the rule`);
    }
  }

  // ── reachability ────────────────────────────────────────────────────────────
  // A node nothing routes to is dead topology. Entry nodes are exempt by
  // declaration: `plan` is triggered by the inbox and `cadence` by a timer,
  // before any task exists for an edge to match against.
  const hasInbound = new Set(edges.map((e) => e.to));
  for (const name of nodeNames) {
    if (entryNodes.includes(name)) continue;
    if (!hasInbound.has(name)) {
      problems.push(
        `node "${name}" has no inbound edge and is not declared in entryNodes — nothing can reach it`,
      );
    }
  }

  // ── routable order is the matcher's first-match-wins order ──────────────────
  const routable = edges.filter((e) => e.routable);
  const orders = routable.map((e) => e.order);
  if (new Set(orders).size !== orders.length) {
    problems.push("routable edges share an `order` — first-match-wins routing would be ambiguous");
  }
  for (const edge of routable) {
    if (!Number.isFinite(edge.order)) {
      problems.push(`edge "${edge.id}" is routable but has no numeric "order"`);
    }
  }

  // ── v2: steps, stepFlow, decisionEdges, step↔registry cross-check ──────────
  if (graph.version === 2) {
    const entries = loadRegistryEntries(problems);
    for (const [name, node] of Object.entries(nodes)) {
      if (node.steps) {
        if (node.stepFlow == null) {
          problems.push(`node "${name}" declares steps but no "stepFlow" — the step chain needs its sequence edges`);
        }
        validateSteps(name, node.steps, problems);
        validateStepFlow(name, node.steps, node.stepFlow, problems);
      } else if (node.stepFlow != null) {
        problems.push(`node "${name}" declares a "stepFlow" but no "steps"`);
      }
    }
    validateDecisionEdges(graph, nodes, entries, problems);
    crossCheckSteps(graph, entries, problems);
  } else if (graph.version === 1) {
    // A v1 graph must not silently carry v2 fields: no v1 consumer reads them,
    // so they would be dead config wearing a v1 badge.
    for (const [name, node] of Object.entries(nodes)) {
      if (node.steps != null || node.stepFlow != null) {
        problems.push(`node "${name}" declares steps/stepFlow but the graph is version 1 — bump version to 2`);
      }
    }
    if (graph.decisionEdges !== undefined) {
      problems.push("graph carries decisionEdges but is version 1 — bump version to 2");
    }
  }

  return problems;
}

// handoff-rules.json shape: [{ comment, when, next }], ordered — the matcher in
// telemetry-server.mjs takes the first match, so order carries meaning.
export function emitHandoffRules(graph) {
  return (graph.edges || [])
    .filter((e) => e.routable)
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ comment: e.why, when: e.when, next: e.to }));
}

const conditionText = (when) => {
  if (!when) return "";
  const parts = [];
  if (when.state) parts.push(when.state);
  if (when.labels?.length) parts.push(when.labels.join(" + "));
  if (when.gates?.length) parts.push(when.gates.join(" / "));
  if (when.trigger) parts.push(when.trigger);
  return parts.join(" + ");
};

const ARROW = { handoff: "-->", return: "-[#B5651D]->", escalate: "-[#C0392B]->", gate: "-[#7D3C98]->" };

export function emitPuml(graph) {
  const lines = [];
  lines.push("@startuml");
  lines.push("!pragma layout smetana");
  lines.push(
    `title Squad graph (generated from config/graph.json — do not edit by hand)\\n` +
      `node contracts + typed edges · handoff / return / escalate / gate`,
  );
  lines.push("");
  lines.push("skinparam rectangle {");
  lines.push("  BackgroundColor #EAF3FF");
  lines.push("  BorderColor #336699");
  lines.push("  FontName Helvetica");
  lines.push("}");
  lines.push("");

  const entry = new Set(graph.entryNodes || []);
  for (const [name, node] of Object.entries(graph.nodes || {})) {
    const stage = node.budget?.stage ?? "—";
    const tag = entry.has(name) ? " «entry»" : "";
    lines.push(`rectangle "${name}${tag}\\n${node.autonomy} · ${stage}" as ${name}`);
  }
  lines.push("");

  // "*" is not a node; render the any-source gate from a dedicated marker so the
  // diagram does not silently drop the rule that matters most.
  if ((graph.edges || []).some((e) => e.from === "*")) {
    lines.push('rectangle "any node" as ANY #FFF2CC');
    lines.push("");
  }

  for (const edge of graph.edges || []) {
    const from = edge.from === "*" ? "ANY" : edge.from;
    const arrow = ARROW[edge.type] || "-->";
    const cond = conditionText(edge.when);
    const dormant = edge.routable ? "" : " (declared, not routed)";
    const label = [edge.type, cond].filter(Boolean).join(": ") + dormant;
    lines.push(`${from} ${arrow} ${edge.to} : ${label}`);
  }

  lines.push("");
  lines.push("legend right");
  lines.push("  handoff = normal forward flow");
  lines.push("  return = work sent back");
  lines.push("  escalate = out to a human on failure");
  lines.push("  gate = blocked awaiting a human decision");
  lines.push("  (declared, not routed) = in the topology, not yet in the matcher");
  lines.push("end legend");
  lines.push("@enduml");
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("usage: node scripts/graph-validate.mjs [--emit-puml | --emit-handoff-rules]");
    return 0;
  }

  const path = args.find((a) => !a.startsWith("-")) ?? join(ROOT, "config", "graph.json");

  let graph;
  try {
    graph = loadGraph(path);
  } catch (err) {
    console.error(`${path} could not be read: ${err.message}`);
    return 1;
  }

  const problems = validateGraph(graph);
  if (problems.length) {
    console.error(`${path} is invalid — ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  · ${p}`);
    return 1;
  }

  if (args.includes("--emit-puml")) {
    console.log(emitPuml(graph));
    return 0;
  }
  if (args.includes("--emit-handoff-rules")) {
    console.log(JSON.stringify(emitHandoffRules(graph), null, 2));
    return 0;
  }

  const nodeCount = Object.keys(graph.nodes || {}).length;
  const routable = (graph.edges || []).filter((e) => e.routable).length;
  let summary = `${path} OK — ${nodeCount} nodes, ${graph.edges.length} edges (${routable} routable)`;
  if (graph.version === 2) {
    const stepNodes = Object.entries(graph.nodes || {}).filter(([, n]) => n.steps);
    const steps = stepNodes.reduce((acc, [, n]) => acc + Object.keys(n.steps).length, 0);
    summary += ` — v2: ${steps} step(s) on ${stepNodes.map(([n]) => `"${n}"`).join(", ")}, ${(graph.decisionEdges || []).length} decision edge(s)`;
  }
  console.error(summary);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("graph-validate.mjs")) {
  process.exit(main());
}