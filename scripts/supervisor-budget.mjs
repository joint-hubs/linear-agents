#!/usr/bin/env node
// scripts/supervisor-budget.mjs — split an issue budget before anything spends it.
//
//   node scripts/supervisor-budget.mjs allocate  --total <usd> [--run <id>]
//   node scripts/supervisor-budget.mjs status    [--run <id>]
//   node scripts/supervisor-budget.mjs authorise --stage <s> --reason "..." [--run <id>]
//   node scripts/supervisor-budget.mjs reconcile [--run <id>] [--json]
//
// WHY (FOC-162). FOC-116 shipped one global cap that trips post-hoc on `result`
// events. One number cannot express the failure that actually costs money: DEV
// consumes the whole issue budget and REVIEW/TEST have nothing left, so the run
// ends with work that was never verified. A single cap only tells you that
// AFTER it has happened, and by then the money is gone and the code is unread.
//
// So the budget is split up front — B_discovery + B_verification + B_synthesis
// + B_reserve — from the `budget.shareHint` values in config/graph.json, and
// enforced per stage at every turn boundary. A stage that runs out is REFUSED
// and surfaced to Mateusz. It does not borrow. Money left in verification is
// the whole mechanism by which a run cannot end unverified.
//
// TWO CAPS, ORDERED, NOT COMPETING. `LA_SUPERVISOR_MAX_COST_USD` stays as the
// OUTER BACKSTOP above the split: the stage gate refuses first and names the
// stage; the global cap still stops the whole run if anything gets past it.
// Every refusal says which of the two it was, because two caps that could each
// be the binding one are two ways to be surprised.
//
// THE RESERVE IS ACCOUNTED FROM ACTUAL OVERSPEND, not from a number reserved in
// advance: `reserveDrawn` is the sum of how far each stage has gone past its own
// allocation. An `authorise` is permission to overspend; what it costs is
// measured afterwards. Same discipline as the cost figures themselves (FOC-165).
//
// `shareHint` is explicitly a guess — config/graph.json says so. `reconcile` is
// what turns it into a measured number, by attributing real per-stage spend from
// telemetry and printing it against the allocation.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  ROOT,
  allocateBudget,
  budgetPath,
  ensureRunDir,
  failJson,
  parseArgs,
  readRegistry,
  runDir,
  stageBudgetStatus,
  stageForSquad,
} from "./supervisor-lib.mjs";
import { loadGraph } from "./graph-validate.mjs";
import { atomicWriteJSON } from "./utils.mjs";

// ── allocate ─────────────────────────────────────────────────────────────────

function cmdAllocate(args) {
  const runId = requireRun(args);
  const total = Number(args.total);
  if (!Number.isFinite(total) || total <= 0) {
    failJson(`--total <usd> must be a number > 0 (got ${JSON.stringify(args.total ?? null)})`);
  }

  const graph = loadGraphOrFail();
  let plan;
  try {
    plan = allocateBudget(total, graph);
  } catch (err) {
    failJson(err.message);
  }

  const path = budgetPath(runId);
  const prior = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  if (prior && !args.force) {
    // Re-allocating mid-run silently rewrites the denominator every earlier
    // refusal was measured against. It is a legitimate thing for Mateusz to
    // decide and an illegitimate thing to do by accident.
    failJson(`run ${runId} already has an allocation of $${prior.total} — re-allocating changes what every stage was judged against`, {
      existing: prior,
      hint: "pass --force if raising the total is the decision",
    });
  }

  const record = {
    ...plan,
    runId,
    allocatedAt: new Date().toISOString(),
    // Authorisations survive a --force re-allocation: they record decisions
    // Mateusz already made, and a bigger budget does not un-make them.
    authorisations: prior?.authorisations ?? [],
  };

  ensureRunDir(runId);
  atomicWriteJSON(path, record);
  console.log(JSON.stringify({ ok: true, path, ...record }, null, 2));
}

// ── authorise ────────────────────────────────────────────────────────────────

function cmdAuthorise(args) {
  const runId = requireRun(args);
  const stage = args.stage;
  const reason = args.reason;
  if (!stage || stage === true) failJson("--stage <name> is required");
  if (!reason || reason === true) {
    // An authorisation with no reason is a rubber stamp, and the reconciliation
    // later has to be able to say WHY a stage was allowed past its allocation.
    failJson('--reason "..." is required — an overrun nobody explained cannot be tuned from afterwards');
  }

  const path = budgetPath(runId);
  if (!existsSync(path)) failJson(`run ${runId} has no allocation — run \`allocate --total <usd>\` first`);
  const plan = JSON.parse(readFileSync(path, "utf8"));
  if (!plan.stages?.[stage]) {
    failJson(`"${stage}" is not a stage in this allocation`, { stages: Object.keys(plan.stages ?? {}) });
  }

  plan.authorisations = [
    ...(plan.authorisations ?? []),
    { stage, reason, authorisedAt: new Date().toISOString() },
  ];
  atomicWriteJSON(path, plan);

  const budget = stageBudgetStatus(runId, { graph: loadGraphOrFail() });
  console.log(
    JSON.stringify(
      {
        ok: true,
        stage,
        reason,
        // Authorising is not funding. The reserve is finite and shared, so say
        // what is actually left rather than implying the stage is now unbounded.
        reserveRemaining: budget?.reserveRemaining ?? null,
        note: "the reserve is the only pool this draws from, and it is released last",
        ...plan,
      },
      null,
      2,
    ),
  );
}

// ── status ───────────────────────────────────────────────────────────────────

function cmdStatus(args) {
  const runId = requireRun(args);
  const budget = stageBudgetStatus(runId, { graph: loadGraphOrFail() });
  if (!budget) {
    failJson(`run ${runId} has no allocation`, {
      hint: "node scripts/supervisor-budget.mjs allocate --total <usd>",
      note: "without one, only LA_SUPERVISOR_MAX_COST_USD applies — one number for the whole run",
    });
  }
  console.log(JSON.stringify({ ok: true, runId, ...budget }, null, 2));
}

// ── reconcile ────────────────────────────────────────────────────────────────

function telemetryDbPath() {
  if (process.env.LA_TELEMETRY_DB) return process.env.LA_TELEMETRY_DB;
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(localAppData, "linear-agents", "telemetry", "telemetry.sqlite");
}

/**
 * Allocation vs what was actually spent, per stage — the step that turns
 * `shareHint` from a guess into a measured number.
 *
 * Two independent sources on purpose: the registry (what the Supervisor
 * computed from token counts, FOC-165) and telemetry `usage_facts` (what the
 * ingest recorded). They should agree; when they do not, that disagreement is
 * evidence about the pipeline, not noise to average away.
 */
async function cmdReconcile(args) {
  const runId = requireRun(args);
  const graph = loadGraphOrFail();
  const budget = stageBudgetStatus(runId, { graph });
  if (!budget) failJson(`run ${runId} has no allocation to reconcile against`);

  const registry = readRegistry(runId);
  const children = Object.values(registry.children ?? {});

  // Telemetry side, best effort: a missing DB must not make reconciliation fail,
  // it must make the telemetry column say so.
  const telemetryByStage = {};
  let telemetryNote = null;
  const dbPath = telemetryDbPath();
  const runIds = children.map((c) => c.telemetryRunId).filter(Boolean);

  if (!runIds.length) {
    telemetryNote = "no child carries a telemetryRunId — nothing to cross-check against";
  } else if (!existsSync(dbPath)) {
    telemetryNote = `no telemetry DB at ${dbPath}`;
  } else {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const stmt = db.prepare(
        `SELECT SUM(c.cost_usd) AS cost FROM cost_facts c WHERE c.run_id = ?`,
      );
      for (const child of children) {
        const stage = stageForSquad(child.squad, graph);
        if (!stage || !child.telemetryRunId) continue;
        const row = stmt.get(child.telemetryRunId);
        telemetryByStage[stage] = (telemetryByStage[stage] ?? 0) + (row?.cost ?? 0);
      }
      db.close();
    } catch (err) {
      telemetryNote = `telemetry read failed: ${err.message.split("\n")[0]}`;
    }
  }

  const rows = Object.entries(budget.stages).map(([stage, s]) => {
    const telemetry = telemetryByStage[stage] ?? null;
    const drift =
      telemetry === null || s.spent === null ? null : Math.round((telemetry - s.spent) * 10_000) / 10_000;
    return {
      stage,
      allocated: s.allocated,
      spent: s.spent,
      telemetry,
      drift,
      usedShare: s.spent === null ? null : Math.round((s.spent / s.allocated) * 1000) / 10,
      // What the hint SHOULD have been, given what this run actually did. This
      // is the number that tunes config/graph.json — from evidence, not taste.
      observedShare: null,
    };
  });

  const totalSpent = rows.reduce((a, r) => (a === null || r.spent === null ? null : a + r.spent), 0);
  for (const r of rows) {
    r.observedShare = totalSpent ? Math.round((r.spent / totalSpent) * 1000) / 1000 : null;
  }

  const out = {
    ok: true,
    runId,
    total: budget.total,
    reserve: budget.reserve,
    reserveDrawn: budget.reserveDrawn,
    authorisations: budget.authorisations ?? [],
    stages: rows,
    telemetryNote,
    hint: "observedShare is what budget.shareHint would have been for THIS run — one run is not a trend",
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`\nreconciliation — run ${runId}, total $${budget.total}`);
  console.log(`  ${"stage".padEnd(14)}${"alloc".padStart(9)}${"spent".padStart(10)}${"used".padStart(8)}${"telemetry".padStart(11)}${"hint→obs".padStart(12)}`);
  console.log(`  ${"-".repeat(62)}`);
  for (const r of rows) {
    const hint = budget.hints?.[r.stage];
    console.log(
      `  ${r.stage.padEnd(14)}${("$" + r.allocated.toFixed(2)).padStart(9)}` +
        `${(r.spent === null ? "UNKNOWN" : "$" + r.spent.toFixed(4)).padStart(10)}` +
        `${(r.usedShare === null ? "—" : r.usedShare + "%").padStart(8)}` +
        `${(r.telemetry === null ? "—" : "$" + r.telemetry.toFixed(4)).padStart(11)}` +
        `${`${hint ?? "—"}→${r.observedShare ?? "—"}`.padStart(12)}`,
    );
  }
  console.log(`  ${"-".repeat(62)}`);
  console.log(`  reserve $${budget.reserve.toFixed(2)}, drawn $${budget.reserveDrawn.toFixed(4)}`);
  if (telemetryNote) console.log(`  telemetry: ${telemetryNote}`);
  console.log(`  observedShare is this ONE run — tune config/graph.json from several, not from this.`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function loadGraphOrFail() {
  try {
    return loadGraph();
  } catch (err) {
    failJson(`config/graph.json could not be read: ${err.message}`);
  }
}

function requireRun(args) {
  const runId = args.run || process.env.LA_SUPERVISOR_RUN;
  if (!runId || runId === true) failJson("--run <supervisorRunId> is required (or set LA_SUPERVISOR_RUN)");
  if (!existsSync(runDir(runId))) failJson(`no such run: ${runId}`, { expected: runDir(runId) });
  return runId;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd === "allocate") return cmdAllocate(args);
  if (cmd === "authorise" || cmd === "authorize") return cmdAuthorise(args);
  if (cmd === "status") return cmdStatus(args);
  if (cmd === "reconcile") return cmdReconcile(args);

  failJson(`unknown subcommand "${cmd ?? ""}" — expected allocate | authorise | status | reconcile`);
}

if (process.argv[1]?.endsWith("supervisor-budget.mjs")) await main();
