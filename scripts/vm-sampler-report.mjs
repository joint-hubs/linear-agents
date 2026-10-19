#!/usr/bin/env node
// scripts/vm-sampler-report.mjs — FOC-809: p20/p50/p80/peak bands per phase from the VM
// sampler's samples.jsonl (see tools/vm-sampler/sample.sh on the host side).
//
// Phases, first match wins, per sample:
//   1. a mark window     — --marks is a JSONL of { ts, phase, event: "start"|"end" } pairs; a
//                          sample whose ts falls between a start and the next end of that phase
//                          gets that phase (e.g. `image-build` during ./fenix update);
//   2. a registry child  — --registry is the Supervisor state home: every <runId>/children.json
//                          lists each child's squad and its turns (startedAt/endedAt, endedAt
//                          absent = still open). A sample inside a turn gets `<squad>-child`
//                          (several at once → the squad whose turn started latest);
//   3. supervisor-active — the container whose name contains "supervisor" is at cpu_pct >=
//                          threshold (default 5). The phase is CPU-derived on purpose: the
//                          Supervisor's own claude process is ALWAYS present inside
//                          fenix-supervisor, so process presence alone cannot separate an
//                          active turn from an idle one — its activity is exactly what the
//                          container CPU shows;
//   4. idle              — none of the above.
//
// Metrics per phase: load1, mem_used_mb, supervisor_cpu_pct, supervisor_mem_mb, api_mem_mb,
// claude_procs — each as n, p20, p50, p80, peak. Phases with n < 10 are listed as `thin`
// evidence (the band is not trusted yet).
//
// Run: node scripts/vm-sampler-report.mjs --samples samples.jsonl [--registry <stateHome>]
//      [--marks marks.jsonl] [--supervisor-cpu-threshold 5] [--json]

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const METRICS = ["load1", "mem_used_mb", "supervisor_cpu_pct", "supervisor_mem_mb", "api_mem_mb", "claude_procs"];

// Percentile with linear interpolation on the sorted values:
// rank = p/100 × (n−1); value = v[floor] + (v[ceil] − v[floor]) × frac.
// An empty vector → null (the band simply has no evidence).
export function percentile(values, p) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (v.length - 1);
  const lo = Math.floor(rank);
  const frac = rank - lo;
  return v[lo] + (v[Math.ceil(rank)] - v[lo]) * frac;
}

// Collapse the mark events per phase into windows (open the latest start, close it at the
// next end of the same phase). A window covers the closed interval start ≤ ts ≤ end.
function markWindows(marks) {
  const byPhase = {};
  for (const m of marks) (byPhase[m.phase] ??= []).push(m);
  const windows = [];
  for (const [phase, events] of Object.entries(byPhase)) {
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let open = null;
    for (const e of events) {
      if (e.event === "start") open = e.ts;
      else if (e.event === "end" && open !== null) {
        windows.push({ phase, startTs: open, endTs: e.ts });
        open = null;
      }
    }
  }
  return windows;
}

export function phaseOf(sample, { marks = [], turns = [], threshold = 5 } = {}) {
  if (marks.length) {
    for (const w of markWindows(marks)) {
      if (sample.ts >= w.startTs && sample.ts <= w.endTs) return w.phase;
    }
  }
  let best = null;
  for (const t of turns) {
    if (
      sample.ts >= t.startedAt &&
      (t.endedAt === undefined || sample.ts <= t.endedAt) &&
      (!best || t.startedAt > best.startedAt)
    ) {
      best = t;
    }
  }
  if (best) return `${best.squad}-child`;
  const supervisor = (sample.containers ?? []).find((c) => c.name.includes("supervisor"));
  if (supervisor && supervisor.cpu_pct >= threshold) return "supervisor-active";
  return "idle";
}

// Read every <dir>/<runId>/children.json: {"children": {"<childId>": { childId, squad, status,
// turns: [{ startedAt, endedAt? }] }}} → a flat [{ runId, childId, squad, startedAt, endedAt }].
// A corrupt or missing children.json is skipped — one bad run must not sink the report.
export function loadRegistryTurns(dir) {
  const turns = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, entry.name, "children.json"), "utf8"));
    } catch {
      continue;
    }
    for (const child of Object.values(parsed?.children ?? {})) {
      for (const turn of child?.turns ?? []) {
        if (!turn?.startedAt) continue;
        turns.push({
          runId: entry.name,
          childId: child.childId ?? "",
          squad: child.squad ?? "",
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
        });
      }
    }
  }
  return turns;
}

export function loadMarks(file) {
  return readJsonl(file);
}

function readJsonl(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function findContainer(sample, needle) {
  return (sample.containers ?? []).find((c) => c.name.includes(needle));
}

function metricValue(sample, metric) {
  switch (metric) {
    case "load1": return sample.load1 ?? null;
    case "mem_used_mb": return sample.mem_used_mb ?? null;
    case "claude_procs": return sample.claude_procs ?? null;
    case "supervisor_cpu_pct": return findContainer(sample, "supervisor")?.cpu_pct ?? null;
    case "supervisor_mem_mb": return findContainer(sample, "supervisor")?.mem_mb ?? null;
    case "api_mem_mb": return findContainer(sample, "api")?.mem_mb ?? null;
    default: return null;
  }
}

export function buildReport(samples, { marks = [], turns = [], threshold = 5 } = {}) {
  const counts = {};
  const vectors = {};
  for (const sample of samples) {
    const phase = phaseOf(sample, { marks, turns, threshold });
    counts[phase] = (counts[phase] ?? 0) + 1;
    for (const metric of METRICS) {
      const value = metricValue(sample, metric);
      if (value === null || value === undefined) continue;
      ((vectors[phase] ??= {})[metric] ??= []).push(value);
    }
  }
  const report = { phases: {}, thin: [] };
  for (const phase of Object.keys(counts).sort()) {
    const metrics = {};
    for (const metric of METRICS) {
      const values = vectors[phase]?.[metric] ?? [];
      metrics[metric] = {
        n: values.length,
        p20: percentile(values, 20),
        p50: percentile(values, 50),
        p80: percentile(values, 80),
        peak: values.length ? Math.max(...values) : null,
      };
    }
    report.phases[phase] = { n: counts[phase], metrics };
    if (counts[phase] < 10) report.thin.push(phase);
  }
  return report;
}

export function renderMarkdown(report) {
  const fmt = (v) => (v === null || v === undefined ? "null" : v.toFixed(1));
  const lines = ["| phase | metric | n | p20 | p50 | p80 | peak |", "|---|---|---|---|---|---|---|"];
  for (const phase of Object.keys(report.phases).sort()) {
    const { n, metrics } = report.phases[phase];
    for (const metric of METRICS) {
      const m = metrics[metric];
      lines.push(`| ${phase} | ${metric} | ${m.n} | ${fmt(m.p20)} | ${fmt(m.p50)} | ${fmt(m.p80)} | ${fmt(m.peak)} |`);
    }
  }
  const thin = report.thin.length ? report.thin.join(", ") : "none";
  lines.push("", `Thin phases (n < 10): ${thin}`);
  return lines.join("\n");
}

function main(argv) {
  let samplesPath = null;
  let registry = null;
  let marksPath = null;
  let threshold = 5;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--samples") samplesPath = argv[++i];
    else if (arg === "--registry") registry = argv[++i];
    else if (arg === "--marks") marksPath = argv[++i];
    else if (arg === "--supervisor-cpu-threshold") threshold = Number(argv[++i]);
    else if (arg === "--json") json = true;
    else {
      console.error(`unknown argument: ${arg}`);
      console.error("usage: node scripts/vm-sampler-report.mjs --samples <jsonl> [--registry <stateHome>] [--marks <jsonl>] [--supervisor-cpu-threshold 5] [--json]");
      return 2;
    }
  }
  if (!samplesPath) {
    console.error("usage: node scripts/vm-sampler-report.mjs --samples <jsonl> [--registry <stateHome>] [--marks <jsonl>] [--supervisor-cpu-threshold 5] [--json]");
    return 2;
  }
  const samples = readJsonl(samplesPath);
  const report = buildReport(samples, {
    marks: marksPath ? loadMarks(marksPath) : [],
    turns: registry ? loadRegistryTurns(registry) : [],
    threshold,
  });
  console.log(json ? JSON.stringify(report, null, 2) : renderMarkdown(report));
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main(process.argv.slice(2)));