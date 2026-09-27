// FOC-547 AC4 payload diff — compares two API payload captures (before vs
// after) after stripping volatile fields. Volatile = wall-clock stamps, cache
// flags, health/uptime counters (see the implementer's volatile-fields list).
//
// Usage: node experiments/foc-547-payload-diff.mjs <before.json> <after.json>

import { readFileSync } from "node:fs";

const VOLATILE = new Set([
  "generatedAt", "at", "observedAt", "lastActivityAt", "modifiedAt",
  "updatedAt", "updated_at", "endedAt", "startedAt", "recordedAt",
  "recorded_at", "computedAt", "ingestedAt", "finishedAt", "created_at",
  "uptime", "readSource", "cache", "cached", "consolePid", "source",
]);

const VOLATILE_PREDICATES = [
  // ingest summary counters depend on tick timing, not served facts
  (path) => path.startsWith("ingest."),
];

function strip(value, path = "") {
  if (Array.isArray(value)) return value.map((v, i) => strip(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (VOLATILE.has(key) || VOLATILE_PREDICATES.some((p) => p(childPath))) continue;
      out[key] = strip(v, childPath);
    }
    return out;
  }
  return value;
}

function collectDiffs(a, b, path = "", out = [], depthBudget = [200]) {
  if (depthBudget[0]-- <= 0) { out.push(`${path}: ...diff budget reached`); return out; }
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: array length ${a.length} vs ${b.length}`);
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) collectDiffs(a[i], b[i], `${path}[${i}]`, out, depthBudget);
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      collectDiffs(a[key], b[key], path ? `${path}.${key}` : key, out, depthBudget);
    }
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return out;
}

const [beforePath, afterPath] = process.argv.slice(2);
const before = strip(JSON.parse(readFileSync(beforePath, "utf8")));
const after = strip(JSON.parse(readFileSync(afterPath, "utf8")));
const diffs = collectDiffs(before, after);
console.log(`normalized-diffs=${diffs.length}`);
for (const line of diffs.slice(0, 40)) console.log(line);
