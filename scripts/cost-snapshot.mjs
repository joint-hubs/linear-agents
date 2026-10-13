#!/usr/bin/env node
// scripts/cost-snapshot.mjs — the Costs & quality screen's cost truth
// (FOC-785, plan §Shared decisions).
//
// WHY A CHILD PROCESS: a ticketCostReport without a window bound scans the
// whole store, and the dashboard server must never block its event loop on
// that — the routes serve the LAST snapshot with its computedAt instead
// (FOC-547). This CLI is that off-path computation: the server spawns
// `node scripts/cost-snapshot.mjs --json` at most every 2 min and keeps the
// last output (stale after 5 min, spec §8).
//
// READ-ONLY by construction: the store is opened with
// DatabaseSync(path, { readOnly: true }) — the same rule ticket-cost.mjs
// follows — because a snapshot must never migrate, lock or write the store as
// a side effect of reading it (openTelemetryDb() is read-write and runs
// migrations on open). A store written before FOC-769 (no run_focus table)
// still reports: ticketCostReport handles the missing table itself.
//
// CLI:
//   node scripts/cost-snapshot.mjs --json [--db <path>] [--cutoffs <file>]
//
// --db defaults to the store telemetryDbPath() resolves (LA_TELEMETRY_DB /
// LA_TELEMETRY_HOME). --cutoffs is a JSON file `{ "<telemetryRunId>":
// "<ISO start of turn 2>" }`; absent, the runs section is {}. --json is the
// only output mode — this tool exists to be parsed by the server. JSON-out /
// stderr-log / exit-1 conventions, like ticket-cost.mjs.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { isSyntheticModel, telemetryDbPath, ticketCostReport } from "./telemetry-store.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseCutoffs(cutoffs) {
  if (cutoffs == null || typeof cutoffs !== "object" || Array.isArray(cutoffs)) {
    throw new Error("cutoffs must be an object mapping telemetryRunId to an ISO timestamp");
  }
  const normalized = {};
  for (const [runId, value] of Object.entries(cutoffs)) {
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`cutoff for run ${JSON.stringify(runId)} is not a parseable date: ${JSON.stringify(value)}`);
    }
    // ISO-normalized, so the string comparison against observed_at (also ISO
    // UTC in the store) is a real time comparison.
    normalized[runId] = parsed.toISOString();
  }
  return normalized;
}

// Per-run cost, the SAME join ticketCostReport applies: cost_facts at the
// run's OWN price set (one message never counted twice across price sets), a
// NULL cost is unpriced, never $0. `runs` is LEFT-joined so a usage row whose
// run is missing from the runs table reports unpriced too — a missing run
// cannot price its rows. Bound per run over the run_id index
// (idx_usage_facts_run): one prepared statement, no full-store scan.
const RUN_COST_SQL = `
  SELECT u.model, u.observed_at, c.cost_usd
  FROM usage_facts u
  LEFT JOIN runs r ON r.run_id = u.run_id
  LEFT JOIN cost_facts c
    ON c.run_id = u.run_id AND c.usage_id = u.usage_id AND c.price_set_id = r.price_set_id
  WHERE u.run_id = ?`;

function runCosts(db, runIds, cutoffs) {
  const statement = db.prepare(RUN_COST_SQL);
  const runs = {};
  for (const runId of [...runIds].sort()) {
    const cutoff = cutoffs[runId];
    let usd = 0;
    let reworkUsd = 0;
    let messages = 0;
    let unpricedMessages = 0;
    for (const row of statement.iterate(runId)) {
      messages++;
      if (row.cost_usd == null && !isSyntheticModel(row.model)) unpricedMessages++;
      const cost = row.cost_usd ?? 0;
      usd += cost;
      // Rework = this run's spend at/after the cutoff (turn ≥ 2). A row
      // without an observed_at cannot prove it is at/after the cutoff, so it
      // is excluded — the same [since, ..) predicate ticketCostReport uses.
      if (cutoff && row.observed_at != null && row.observed_at >= cutoff) reworkUsd += cost;
    }
    runs[runId] = { usd, reworkUsd, messages, unpricedMessages };
  }
  return runs;
}

export function buildCostSnapshot({ dbPath, cutoffs = {}, now } = {}) {
  if (!dbPath) dbPath = telemetryDbPath();
  const at = now instanceof Date ? now : new Date(now ?? Date.now());
  if (Number.isNaN(at.getTime())) throw new Error(`now is not a parseable date: ${JSON.stringify(now)}`);
  const normalizedCutoffs = parseCutoffs(cutoffs);
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 10000;");
    return {
      computedAt: at.toISOString(),
      storePath: resolve(dbPath),
      windows: {
        all: ticketCostReport(db),
        "30d": ticketCostReport(db, { since: new Date(at.getTime() - 30 * DAY_MS).toISOString() }),
        "7d": ticketCostReport(db, { since: new Date(at.getTime() - 7 * DAY_MS).toISOString() }),
      },
      runs: runCosts(db, Object.keys(normalizedCutoffs), normalizedCutoffs),
    };
  } finally {
    db.close();
  }
}

function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--json") flags.json = true;
    else if (token === "--db" || token === "--cutoffs") {
      if (i + 1 >= argv.length) throw new Error(`${token} requires a value`);
      flags[token.slice(2)] = argv[++i];
    } else throw new Error(`unknown option '${token}'`);
  }
  if (!flags.json) throw new Error("cost-snapshot only prints JSON; pass --json");
  let cutoffs = {};
  if (flags.cutoffs) {
    cutoffs = JSON.parse(readFileSync(flags.cutoffs, "utf8"));
    if (cutoffs == null || typeof cutoffs !== "object" || Array.isArray(cutoffs)) {
      throw new Error(`cutoffs file ${flags.cutoffs} must hold an object mapping runId to ISO timestamp`);
    }
  }
  const snapshot = buildCostSnapshot({ dbPath: flags.db, cutoffs });
  console.log(JSON.stringify(snapshot, null, 2));
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`cost-snapshot: ${err.message}`);
    process.exit(1);
  }
}
