// scripts/gen-model-map.mjs
// Reads config/models.json (source of truth for model routing), resolves model keys
// to full model IDs, and writes config/models.map as flat KEY=VALUE lines.
// The map is consumed by bin/agent.bat (for /f parsing).
//
// Usage: node scripts/gen-model-map.mjs
// Output: config/models.map  (overwritten)

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, "config", "models.json");
const DST = join(ROOT, "config", "models.map");

// ---------------------------------------------------------------------------
// Mapping from agent.bat CLI role names to models.json routing keys.
// This is the bridge between the CLI interface (stable) and the routing config
// (source of truth). When a new role is added to models.json, add its CLI name here.
// ---------------------------------------------------------------------------
const ROLE_MAP = {
  // plan
  discovery:    { area: "plan", key: "discovery" },
  spec:         { area: "plan", key: "spec" },
  "spec-review":{ area: "plan", key: "spec_review" },
  decomposer:   { area: "plan", key: "decompose" },
  push:         { area: "plan", key: "push" },
  // dev
  recon:        { area: "dev", key: "recon" },
  implementer:  { area: "dev", key: "implement" },
  refactorer:   { area: "dev", key: "multifile" },
  debugger:     { area: "dev", key: "hard" },
  // review
  "first-pass": { area: "review", key: "first_pass" },
  security:     { area: "review", key: "security" },
  deep:         { area: "review", key: "deep" },
  // test
  deployer:     { area: "test", key: "deploy" },
  "scenario-gen":{ area: "test", key: "scenarios" },
  runner:       { area: "test", key: "run" },
  "root-cause": { area: "test", key: "root_cause" },
  // cadence
  collector:    { area: "cadence", key: "default" },
  retro:        { area: "cadence", key: "retro" },
  digest:       { area: "cadence", key: "pl" },
};

// ---------------------------------------------------------------------------
// Read source of truth
// ---------------------------------------------------------------------------
const cfg = JSON.parse(readFileSync(SRC, "utf8"));
const { ids, routing } = cfg;

// Resolve a model key (e.g. "minimax", "deepseek_pro") to the full model ID
// (e.g. "minimax/minimax-m3", "deepseek/deepseek-v4-pro").
function resolve(key) {
  if (ids[key]) return ids[key];
  // Fallback: pass through as-is (e.g. if key is already a full model id)
  return key;
}

// ---------------------------------------------------------------------------
// Build map lines
// ---------------------------------------------------------------------------
const lines = [];

for (const [role, { area, key }] of Object.entries(ROLE_MAP)) {
  const areaRouting = routing[area];
  if (!areaRouting) {
    console.error(`[warn] No routing section for area "${area}" (role "${role}") — skipping`);
    continue;
  }
  const modelKey = areaRouting[key];
  if (!modelKey) {
    console.error(`[warn] No routing entry for ${area}.${key} (CLI role "${role}") — skipping`);
    continue;
  }
  const modelId = resolve(modelKey);
  lines.push(`${area}.${role}=${modelId}`);
}

// Also emit the default model ids (opus, sonnet, etc.) for other .bat files
for (const [name, modelId] of Object.entries(ids)) {
  lines.push(`_id.${name}=${modelId}`);
}

// ---------------------------------------------------------------------------
// Write map
// ---------------------------------------------------------------------------
lines.sort();
writeFileSync(DST, lines.join("\n") + "\n", "utf8");
console.log(`[gen-model-map] Wrote ${lines.length} entries to ${DST}`);
