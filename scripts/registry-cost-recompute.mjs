// scripts/registry-cost-recompute.mjs — one-time recompute of registry child
// costs from the children's own transcripts (FOC-760).
//
// Why: the watcher used to ADD every result event's cost to the registry entry,
// but `result.modelUsage` is CUMULATIVE for the session — background-task
// wake-ups re-emit it and a resumed turn carries the whole session — so the
// registries ran at ~5x ground truth ($781.85 vs $154.70, 366 children). The
// watcher now SETs the cost from the child's transcripts at every turn end;
// this script applies the same truth to the registries that already exist,
// child by child, using the same pricing path (priceChildTranscripts).
//
// DRY RUN BY DEFAULT. Without --apply nothing is written — the report only
// says what WOULD change. --apply is Mateusz's explicit consent, given after
// he has reviewed the dry-run numbers (plan FOC-760 §3); the script never
// invents it, and one --apply pass is idempotent (see costUsdLegacy below).
//
// What "legacy-unverified" means: no transcript for this child could be found,
// so its recorded costUsd cannot be checked against ground truth. The value is
// KEPT unchanged but flagged (`costSource: "legacy-unverified"` — status names
// these children beside the run total) so it is never silently trusted. It is
// NOT an assertion that the value is wrong; it is an assertion nobody verified
// it. A child already carrying `costSource: "transcript"` is left entirely
// alone — it was verified at its own turn end.
//
// In-flight children (status running/starting, or any turn without endedAt)
// are SKIPPED: their cost is not settled, and the watcher writes it at the
// turn's end — patching under a live writer would race updateChild. The check
// runs twice: at compute, and again at apply time on the freshly re-read
// registry (a child that started a turn since the compute is skipped then, as
// `in-flight-at-apply`). A corrupt children.json is an error row for that run;
// the sweep continues with the others and --apply writes only computed runs.
//
// Usage:
//   node scripts/registry-cost-recompute.mjs                       # dry run, all runs
//   node scripts/registry-cost-recompute.mjs --run <runId>         # dry run, one run
//   node scripts/registry-cost-recompute.mjs --apply               # write (Mateusz only)
//   node scripts/registry-cost-recompute.mjs --json                # full per-child detail
//   node scripts/registry-cost-recompute.mjs --state-home <dir>    # redirect the state root

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { squadConfigDir } from "./fenix-paths.mjs";
import { LIVE_STATUSES, parseArgs, readRegistry, supervisorStateHome, writeRegistry } from "./supervisor-lib.mjs";
import { priceChildTranscripts } from "./transcript-cost.mjs";

const args = parseArgs(process.argv.slice(2));

// One seam for the whole tree: --state-home feeds the same env var the library
// reads, so runDir/readRegistry/writeRegistry follow it without a second path
// derivation that could drift.
if (args["state-home"]) process.env.LA_SUPERVISOR_STATE_HOME = resolve(args["state-home"]);

// LIVE_STATUSES is supervisor-lib's exported source of truth — the same list
// cleanup, cockpit and the orphans sweep judge liveness by.
const inFlight = (child) =>
  LIVE_STATUSES.includes(child.status) ||
  (Array.isArray(child.turns) && child.turns.some((t) => t && !t.endedAt));

/**
 * A total that respects the null contract: undefined never priced counts as 0
 * (budgetStatus's reading), but one explicitly UNKNOWN child drags the whole
 * total to null — a sum over "unknown" is how an unpriced model becomes free.
 */
function totalUsd(children) {
  let sum = 0;
  for (const c of children) {
    const cost = c.costUsd === undefined ? 0 : c.costUsd;
    if (cost === null) return null;
    sum += cost;
  }
  return sum;
}

/**
 * One child's verdict. Returns { verdict, patch, detail } — patch empty means
 * the registry entry is left as it stands.
 */
function recomputeChild(child) {
  const base = {
    childId: child.childId,
    costUsdOld: child.costUsd === undefined ? null : child.costUsd,
  };
  if (inFlight(child)) {
    return { verdict: "skipped", patch: {}, detail: { ...base, reason: "in-flight" } };
  }
  const priced = (() => {
    try {
      return priceChildTranscripts({
        configDir: squadConfigDir(child.squad),
        cwd: child.worktree,
        sessionId: child.sessionId,
      });
    } catch {
      return null; // an unreadable config dir is "not found", not a crash
    }
  })();
  if (priced) {
    // costUsdLegacy keeps the ORIGINAL value: set only when not already
    // present, so a re-run of --apply (the transcript price may move with a
    // pricing sync) never overwrites the one number that documents what the
    // buggy accumulator had recorded.
    const patch = {
      costUsd: priced.costUsd,
      costSource: "transcript",
      costMessages: priced.messages,
      unpricedModels: priced.unpricedModels ?? [],
    };
    if (!("costUsdLegacy" in child)) patch.costUsdLegacy = child.costUsd ?? null;
    return {
      verdict: "recomputed",
      patch,
      detail: {
        ...base,
        costUsdNew: priced.costUsd,
        costSourceNew: "transcript",
        costUsdLegacy: patch.costUsdLegacy ?? child.costUsdLegacy ?? null,
        costMessages: priced.messages,
        unpricedModels: priced.unpricedModels ?? [],
        transcriptPath: priced.transcriptPath,
      },
    };
  }
  // Already verified at its own turn end — do not downgrade it, do not touch it.
  if (child.costSource === "transcript") {
    return { verdict: "kept-transcript", patch: {}, detail: { ...base, reason: "already transcript" } };
  }
  return {
    verdict: "unverified",
    patch: { costSource: "legacy-unverified" },
    detail: { ...base, costSourceNew: "legacy-unverified" },
  };
}

function computeRun(runId) {
  let registry;
  try {
    registry = readRegistry(runId);
  } catch (err) {
    // A corrupt/unreadable children.json is an error ROW for that run, not a
    // crashed sweep — the other runs still recompute. --apply skips runs that
    // carry an error, so nothing is written for this one.
    return { runId, error: `children.json unreadable: ${err.message}` };
  }
  const computed = [];
  for (const [childId, child] of Object.entries(registry.children || {})) {
    const { verdict, patch, detail } = recomputeChild(child);
    computed.push({ childId, child, patch, verdict, detail });
  }
  // Totals over ALL children, old vs new — skipped/unverified keep their old
  // value, so "new" is "the registry after this script", whatever it changed.
  const oldTotal = totalUsd(computed.map(({ child }) => child));
  const newTotal = totalUsd(computed.map(({ child, patch }) => ({ ...child, ...patch })));
  return {
    runId,
    oldTotalUsd: oldTotal,
    newTotalUsd: newTotal,
    recomputed: computed.filter((c) => c.verdict === "recomputed").length,
    unverifiable: computed.filter((c) => c.verdict === "unverified").length,
    skipped: computed.filter((c) => c.verdict === "skipped").length,
    children: computed.map(({ childId, verdict, detail }) => ({ childId, verdict, ...detail })),
    patches: computed.map(({ childId, patch }) => [childId, patch]),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
const stateHome = supervisorStateHome();
if (!existsSync(stateHome)) {
  const empty = { dryRun: !args.apply, stateHome, error: "state home does not exist", runs: [] };
  if (args.json) console.log(JSON.stringify(empty, null, 2));
  else console.log(`no state home at ${stateHome} — nothing to recompute`);
  process.exit(0);
}

const runIds = args.run
  ? [args.run]
  : readdirSync(stateHome)
      .filter((d) => existsSync(join(stateHome, d, "children.json")))
      .sort();

const runs = [];
for (const runId of runIds) {
  if (!existsSync(join(stateHome, runId, "children.json"))) {
    runs.push({ runId, error: "no children.json" });
    continue;
  }
  runs.push(computeRun(runId));
}

const apply = Boolean(args.apply);
if (apply) {
  // Re-read right before writing: the dry-run numbers above were computed
  // earlier, and a watcher may have written the registry in between. Only the
  // cost fields of the computed children are patched onto the FRESH registry
  // — and the in-flight check is RE-RUN on the fresh entry: a child that
  // started a turn since the compute is owned by its watcher again, so its
  // patch is skipped (verdict `skipped`, reason `in-flight-at-apply`) rather
  // than raced in under a live writer.
  for (const run of runs) {
    if (run.error) continue;
    let fresh;
    try {
      fresh = readRegistry(run.runId);
    } catch (err) {
      run.error = `children.json unreadable at apply: ${err.message}`;
      continue;
    }
    if (!fresh || typeof fresh !== "object" || typeof fresh.children !== "object" || fresh.children === null) {
      run.error = "children.json has no children object at apply";
      continue;
    }
    for (const [childId, patch] of run.patches) {
      if (!patch || !Object.keys(patch).length) continue;
      const freshChild = fresh.children[childId];
      if (!freshChild) continue;
      if (inFlight(freshChild)) {
        const row = run.children.find((c) => c.childId === childId);
        if (row) {
          row.verdict = "skipped";
          row.reason = "in-flight-at-apply";
        }
        continue;
      }
      fresh.children[childId] = { ...freshChild, ...patch };
    }
    writeRegistry(run.runId, fresh);
  }
  // The verdicts above moved — re-derive the per-run counters from the children
  // rows so the sweep totals reflect what was actually written.
  for (const run of runs) {
    if (run.error) continue;
    run.recomputed = run.children.filter((c) => c.verdict === "recomputed").length;
    run.unverifiable = run.children.filter((c) => c.verdict === "unverified").length;
    run.skipped = run.children.filter((c) => c.verdict === "skipped").length;
  }
}

const totals = runs.reduce(
  (acc, r) => {
    if (r.error) return acc;
    acc.oldTotalUsd = acc.oldTotalUsd === null || r.oldTotalUsd === null ? null : acc.oldTotalUsd + r.oldTotalUsd;
    acc.newTotalUsd = acc.newTotalUsd === null || r.newTotalUsd === null ? null : acc.newTotalUsd + r.newTotalUsd;
    acc.recomputed += r.recomputed;
    acc.unverifiable += r.unverifiable;
    acc.skipped += r.skipped;
    return acc;
  },
  { oldTotalUsd: 0, newTotalUsd: 0, recomputed: 0, unverifiable: 0, skipped: 0 },
);
const ratio =
  totals.oldTotalUsd !== null && totals.newTotalUsd !== null && totals.newTotalUsd > 0
    ? totals.oldTotalUsd / totals.newTotalUsd
    : null;

if (args.json) {
  console.log(
    JSON.stringify(
      {
        dryRun: !apply,
        stateHome,
        runs: runs.map(({ registry, patches, ...rest }) => rest),
        totals: { ...totals, ratioOldOverNew: ratio },
      },
      null,
      2,
    ),
  );
} else {
  const usd = (v) => (v === null ? "UNKNOWN" : `$${v.toFixed(4)}`);
  for (const r of runs) {
    if (r.error) {
      console.log(`${r.runId}: ${r.error}`);
      continue;
    }
    console.log(
      `${r.runId}: ${usd(r.oldTotalUsd)} -> ${usd(r.newTotalUsd)} | ` +
        `recomputed ${r.recomputed}, unverified ${r.unverifiable}, skipped ${r.skipped}`,
    );
  }
  console.log(
    `TOTAL${apply ? " (applied)" : " (dry run — rerun with --apply to write)"}: ` +
      `${usd(totals.oldTotalUsd)} -> ${usd(totals.newTotalUsd)} | ` +
      `old/new ${ratio === null ? "n/a" : `${ratio.toFixed(2)}x`} | ` +
      `recomputed ${totals.recomputed}, unverified ${totals.unverifiable}, skipped ${totals.skipped}`,
  );
  const nullRuns = runs.filter((r) => !r.error && (r.oldTotalUsd === null || r.newTotalUsd === null));
  if (nullRuns.length) {
    console.log(
      `note: ${nullRuns.length} run(s) carry a child with costUsd null (unpriced) — ` +
        `their totals read UNKNOWN, never 0`,
    );
  }
}
process.exit(0);