// agent-state-seed.mjs — spawn-time seeding of the PINNED STATE (FOC-729).
//
// supervisor-spawn writes the spawn facts it already renders into the prologue
// into the working-state store as tier-base facts (source "spawn", evidence
// "supervisor-spawn PINNED STATE"), so a SessionStart hook can re-inject them
// after a compaction. Only keys the registry declares for the child role set
// (all + child) are written — undeclared values are reported as skipped, never
// invented. An already-stored row with the same value and source is left alone
// (no version churn); a changed value is updated in place. Store errors
// propagate: the caller decides whether they block.

import { listFacts, setFact } from "./agent-state.mjs";
import { keysForRole } from "./agent-state-registry.mjs";

/**
 * Seed `values` into `namespace` as base facts. Null/undefined/"" values are
 * ignored (neither seeded nor skipped). Returns { seeded, skipped } — key
 * lists; `skipped` carries values present but not declared by the registry.
 */
export function seedPinnedState(store, { namespace, registry, values, now, actor = "supervisor-spawn" } = {}) {
  // keysForRole(registry, "dev") is the all ∪ child set (every squad role maps
  // to child), not a dev-specific list.
  const declared = new Map(keysForRole(registry, "dev"));
  const active = new Map(listFacts(store, { namespace, status: "active" }).rows.map((row) => [row.key, row]));
  const seeded = [];
  const skipped = [];
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value == null || value === "") continue;
    if (!declared.has(key)) {
      skipped.push(key);
      continue;
    }
    const stored = active.get(key);
    if (!(stored && stored.value === String(value) && stored.source === "spawn")) {
      setFact(store, {
        namespace,
        key,
        value: String(value),
        tier: "base",
        source: "spawn",
        evidence: "supervisor-spawn PINNED STATE",
        scope: "run",
        actor,
        now,
      });
    }
    seeded.push(key);
  }
  return { seeded, skipped };
}