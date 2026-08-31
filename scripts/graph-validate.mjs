// scripts/graph-validate.mjs — validate config/graph.json, and render it.
//
// The topology used to live in prose (agents/*/CLAUDE.md) plus four routing
// rules in config/handoff-rules.json. Prose cannot be checked, and the two
// drifted apart silently — the review→dev return path has never been in
// handoff-rules.json at all, so returns route to null in the dashboard and
// nobody noticed. A graph you can validate is the point of FOC-158.
//
// Usage:
//   node scripts/graph-validate.mjs                       validate, exit 0/1
//   node scripts/graph-validate.mjs --emit-puml           PlantUML on stdout
//   node scripts/graph-validate.mjs --emit-handoff-rules  handoff-rules JSON on stdout
//   node scripts/graph-validate.mjs <path>                validate another graph file
//
// The positional path exists so the failure paths are testable end-to-end against
// a broken fixture, not only through the exported functions.
//
// Both emitters validate first: never render a broken graph.
// Human output goes to stderr, machine output to stdout, so a redirect
// (`> docs/diagrams/07_squad_graph.puml`) captures only the artifact.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EDGE_TYPES = ["handoff", "return", "escalate", "gate"];
const CONTRACT_FIELDS = ["input", "output", "completion", "failure", "budget"];
const AUTONOMY_LEVELS = ["supervised", "bounded", "scheduled"];

export function loadGraph(path = join(ROOT, "config", "graph.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
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
  console.error(
    `${path} OK — ${nodeCount} nodes, ${graph.edges.length} edges (${routable} routable)`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("graph-validate.mjs")) {
  process.exit(main());
}
