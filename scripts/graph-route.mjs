// scripts/graph-route.mjs — "given a task's state and labels, which node picks
// it up next?" One matcher, two callers.
//
// This lived as a private function inside telemetry-server.mjs. FOC-123 needed
// the same answer from a CLI (supervisor-triage.mjs), and the tempting move — a
// second copy of the matching semantics — is precisely how the prose topology
// and config/handoff-rules.json drifted apart without anyone noticing (see the
// header of graph-validate.mjs). So the function moved here instead of being
// re-typed there.
//
// The two callers still READ the rules from different files: telemetry-server
// from config/handoff-rules.json, supervisor-triage from the edges of
// config/graph.json. graph-validate.test.mjs asserts those two are identical,
// so both route the same way today. Pointing telemetry-server at the graph is
// the single deliberate change graph.json `_migration` describes — it is not
// something to slip in sideways from here.

// Evaluate handoff rules against a task. First match wins — rule order in the
// config is significant. `labels:["needs:*"]` is a wildcard matching any
// `needs:` label, so a blocked task routes to the human regardless of state
// (put that rule first in the config, per HOW-TO §6 "dowolny → człowiek").
//
// The wildcard is separator-agnostic: it matches BOTH the colon form
// (`needs:answer`, the HOW-TO §6 doc convention) AND the hyphen form
// (`needs-decision`, the actual label name Linear returns in this workspace).
// Linear lets you name a label either way; the doc uses `needs:` while the
// live workspace uses `needs-`, and the matcher must not let that discrepancy
// silently drop blocked tasks (JOI-68 review round 1 found 6 needs-decision
// tasks routing to null instead of human).
export function suggestedSquad(task, rules) {
  const labels = new Set(task.labels || []);
  for (const rule of rules) {
    const w = rule.when || {};
    if (w.state && task.state !== w.state) continue;
    if (w.labels && w.labels.length) {
      const ok = w.labels.every((l) => {
        if (l.endsWith(':*')) {
          // Strip ":*" → stem (e.g. "needs:*" → "needs"). Match the stem
          // exactly or followed by either separator, so colon- and hyphen-
          // named labels both route.
          const stem = l.slice(0, -2);
          return [...labels].some(
            (t) => t === stem || t.startsWith(stem + ':') || t.startsWith(stem + '-'),
          );
        }
        return labels.has(l);
      });
      if (!ok) continue;
    }
    return rule.next;
  }
  return null;
}

// Same evaluation, but it also tells you WHICH rule fired. The Supervisor has
// to show Mateusz the reason for a proposal, and "dev" with no rationale is
// exactly the kind of unexplained verdict the triage gate exists to prevent.
export function matchRule(task, rules) {
  for (let i = 0; i < rules.length; i++) {
    if (suggestedSquad(task, [rules[i]]) !== null) return { rule: rules[i], index: i };
  }
  return { rule: null, index: -1 };
}

// Where does work go after `nodeId` finishes? Read from the graph's `handoff`
// edges rather than hardcoded, so adding a node to the topology is a config
// edit and not a code change. Returns null for a terminal node (`test` has no
// outgoing handoff) and throws on an ambiguous topology, which the validator
// does not currently forbid — two handoffs out of one node would make "the
// next squad" a guess, and guessing is what this whole file exists to avoid.
export function handoffTargetFrom(graph, nodeId) {
  const out = (graph.edges || []).filter((e) => e.type === "handoff" && e.from === nodeId);
  if (out.length > 1) {
    throw new Error(
      `node "${nodeId}" has ${out.length} outgoing handoff edges (${out.map((e) => e.id).join(", ")}) — ` +
        `"the next squad" is not defined for it`,
    );
  }
  return out[0]?.to ?? null;
}
