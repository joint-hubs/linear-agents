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
// mem_cache_mb and disk_used_mb are collected as raw evidence only — the report does not band
// them; the cache/storage sizing decisions read them straight from samples.jsonl.
//
// Run: node scripts/vm-sampler-report.mjs --samples samples.jsonl [--registry <stateHome>]
//      [--marks marks.jsonl] [--supervisor-cpu-threshold 5] [--json]

import { existsSync, readFileSync, readdirSync } from "node:fs";
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

// Every timestamp comparison is done on epoch ms, never on the raw strings: ISO forms differ
// (millis, an explicit +00:00 offset) yet are equal on the timeline. Unparseable → null: a
// sample with an unparseable ts is classified `idle` (phaseOf), a turn with an unparseable
// startedAt/endedAt is skipped (loadRegistryTurns).
function toMs(value) {
  if (typeof value === "number") return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// Collapse the mark events per phase into windows (open the latest start, close it at the
// next end of the same phase). A window covers the closed interval start ≤ ts ≤ end.
function markWindows(marks) {
  const byPhase = {};
  for (const m of marks) (byPhase[m.phase] ??= []).push(m);
  const windows = [];
  for (const [phase, events] of Object.entries(byPhase)) {
    events.sort((a, b) => a.ts - b.ts);
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

export function phaseOf(sample, {marks = [], turns = [], threshold = 5, openUntil = null, windows} = {}) {
  const ts = toMs(sample.ts);
  if (ts === null) return "idle"; // unparseable sample timestamp — nothing to classify against
  // buildReport passes prebuilt windows; a direct call falls back to building them once here.
  for (const w of windows ?? markWindows(marks)) {
    if (ts >= w.startTs && ts <= w.endTs) return w.phase;
  }
  // endedAt null/undefined/"" = the turn is still open; an open turn is capped at openUntil
  // (the newest sample ts) so a never-closed turn cannot swallow samples from after the report.
  const cap = openUntil ?? Number.POSITIVE_INFINITY;
  let best = null;
  for (const t of turns) {
    const startedAt = toMs(t.startedAt);
    if (startedAt === null) continue;
    const open = t.endedAt == null || t.endedAt === "";
    if (
      ts >= startedAt &&
      (open ? ts <= cap : ts <= toMs(t.endedAt)) &&
      (!best || startedAt > best.startedAt)
    ) {
      best = { squad: t.squad, startedAt };
    }
  }
  if (best) return `${best.squad}-child`;
  const supervisor = findContainer(sample, "supervisor");
  if (supervisor && supervisor.cpu_pct >= threshold) return "supervisor-active";
  return "idle";
}

// Read every <dir>/<runId>/children.json: {"children": {"<childId>": { childId, squad, status,
// turns: [{ startedAt, endedAt? }] }}} → a flat [{ runId, childId, squad, startedAt, endedAt }].
// A corrupt or missing children.json is skipped — one bad run must not sink the report. A
// missing or unreadable registry directory yields [] — no child turns at all, not a crash.
export function loadRegistryTurns(dir) {
  const turns = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
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
        const startedAt = toMs(turn.startedAt);
        if (startedAt === null) continue; // unparseable startedAt — the turn cannot be placed on the timeline
        const rawEnd = turn.endedAt;      // null/undefined/"" = the turn is still open
        if (rawEnd != null && rawEnd !== "" && toMs(rawEnd) === null) continue; // unparseable endedAt
        turns.push({
          runId: entry.name,
          childId: child.childId ?? "",
          squad: child.squad ?? "",
          startedAt,
          endedAt: rawEnd == null || rawEnd === "" ? null : toMs(rawEnd),
        });
      }
    }
  }
  return turns;
}

export function loadMarks(file) {
  return readJsonl(file)
    .map((m) => ({ ...m, ts: toMs(m.ts) }))
    .filter((m) => m.ts !== null); // a mark whose ts cannot be parsed has no place on the timeline
}

// Tolerant loader: a line that does not parse is skipped, not fatal — a live-appended
// samples.jsonl can carry a truncated tail line when read mid-write.
export function readJsonl(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

// Anchored role match: the supervisor container is the one whose name ENDS with "supervisor"
// (optionally followed by a replica suffix: "fenix-fenix-supervisor-1", "fenix-supervisor"),
// so a container like "fenix-supervisor-log-tail" must not match. The `includes` fallback
// applies only when no anchored name exists.
function findContainer(sample, role) {
  const containers = sample.containers ?? [];
  const re = new RegExp(`(^|-)${role}(-\\d+)?$`);
  return containers.find((c) => re.test(c.name)) ?? containers.find((c) => c.name.includes(role));
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
  const windows = markWindows(marks); // built once, not per sample
  let openUntil = null;               // newest sample ts — the cap for open turns
  for (const s of samples) {
    const ms = toMs(s.ts);
    if (ms !== null && (openUntil === null || ms > openUntil)) openUntil = ms;
  }
  for (const sample of samples) {
    const phase = phaseOf(sample, { turns, threshold, openUntil, windows });
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
  // a phase name is user data — escape it so it stays one table cell
  const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = ["| phase | metric | n | p20 | p50 | p80 | peak |", "|---|---|---|---|---|---|---|"];
  for (const phase of Object.keys(report.phases).sort()) {
    const { n, metrics } = report.phases[phase];
    for (const metric of METRICS) {
      const m = metrics[metric];
      lines.push(`| ${cell(phase)} | ${metric} | ${m.n} | ${fmt(m.p20)} | ${fmt(m.p50)} | ${fmt(m.p80)} | ${fmt(m.peak)} |`);
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
  // timestamps become epoch ms at load time; unparseable ts → null (phaseOf classifies it idle)
  const samples = readJsonl(samplesPath).map((s) => ({ ...s, ts: toMs(s.ts) }));
  if (registry && !existsSync(registry)) {
    console.error(`registry: ${registry} not readable — no child turns (every sample is idle/supervisor-active/marked)`);
  }
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