#!/usr/bin/env node
// scripts/ticket-cost.mjs — what each ticket cost, with the Supervisor's own
// spend charged to the focus it DECLARED (FOC-769, plan §FOC-769, slice S5b;
// PRD §3 asks for ≥ 80 % attributed Supervisor spend).
//
// READ-ONLY by construction: the store is opened with
// DatabaseSync(path, { readOnly: true }) — the same rule
// telemetry-analysis.mjs's openAnalysisDb follows — because a report must
// never migrate, lock or write the store as a side effect of reading it
// (openTelemetryDb() is read-write and runs migrations on open). A store
// written before FOC-769 (no run_focus table yet) still reports: every
// Supervisor message simply lands in unattributed.
//
// CLI:
//   node scripts/ticket-cost.mjs [--since <ISO|Nd>] [--until <ISO>] [--db <path>] [--json]
//
// --since/--until take ISO timestamps; --since also accepts `Nd` (N days back
// from now). The window is half-open: observed_at in [since, until). --db
// defaults to the store telemetryDbPath() resolves (LA_TELEMETRY_DB /
// LA_TELEMETRY_HOME). --json prints the raw ticketCostReport payload; the
// human output is one row per ticket (children / supervisor / total), then
// the overhead, unattributed and untagged-children buckets and the
// Supervisor's attributed share.
//
// JSON-out/stderr-log/exit-1 conventions, like supervisor-focus.mjs.

import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { telemetryDbPath, ticketCostReport } from "./telemetry-store.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

// `Nd` = N days back from now; anything else must parse as a date. Garbage is
// refused, not silently dropped — a silently dropped filter lies in the numbers.
function parseWhen(value, label) {
  const raw = String(value ?? "").trim();
  const days = /^(\d+)d$/i.exec(raw);
  if (days) return new Date(Date.now() - Number(days[1]) * DAY_MS).toISOString();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is not a parseable date or Nd offset: ${JSON.stringify(value)}`);
  return parsed.toISOString();
}

// Money for humans. Unknown, zero and positive must stay distinguishable:
// null → "unknown"; exactly 0 → "$0"; >= $0.01 → cents ($12.34); below that
// enough decimals for 2 significant digits ($0.000021) — mock runs, cheap
// models and early-week windows produce sub-cent figures, and printing $0 for
// a non-zero cost is a lie. JSON output is never routed through this.
function usd(value) {
  if (value == null) return "unknown";
  if (value === 0) return "$0";
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(1 - Math.floor(Math.log10(value)))}`;
}
const pct = (share) => (share == null ? "n/a" : `${(share * 100).toFixed(1)}%`);

function printReport(report) {
  console.log(`ticket-cost (FOC-769)  window: ${report.since ?? "beginning"} .. ${report.until ?? "now"}`);
  console.log("");
  console.log(
    "ticket".padEnd(16)
    + "children".padStart(12)
    + "supervisor".padStart(12)
    + "total".padStart(12)
    + "messages".padStart(10),
  );
  for (const ticket of report.tickets) {
    console.log(
      ticket.taskId.padEnd(16)
      + usd(ticket.childrenUsd).padStart(12)
      + usd(ticket.supervisorUsd).padStart(12)
      + usd(ticket.totalUsd).padStart(12)
      + String(ticket.messages).padStart(10),
    );
  }
  console.log("");
  console.log(`overhead           ${usd(report.overheadUsd)}`);
  console.log(`unattributed       ${usd(report.unattributedUsd)}`);
  console.log(`untagged children  ${usd(report.untaggedChildrenUsd)}`);
  console.log(`Supervisor attributed share: ${pct(report.supervisor.attributedShare)}`
    + ` (ticket ${usd(report.supervisor.ticketUsd)} + overhead ${usd(report.supervisor.overheadUsd)}`
    + ` of ${usd(report.supervisor.totalUsd)})`);
  console.log(`unpriced messages: ${report.unpricedMessages}`
    + `  legacy rows (message_id NULL, ~2x per-line counts): ${report.legacyRows}`);
}

function main(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--json") flags.json = true;
    else if (token === "--since" || token === "--until" || token === "--db") {
      if (i + 1 >= argv.length) throw new Error(`${token} requires a value`);
      flags[token.slice(2)] = argv[++i];
    } else throw new Error(`unknown option '${token}'`);
  }
  const since = flags.since ? parseWhen(flags.since, "--since") : null;
  const until = flags.until ? parseWhen(flags.until, "--until") : null;
  const db = new DatabaseSync(flags.db || telemetryDbPath(), { readOnly: true });
  db.exec("PRAGMA busy_timeout = 10000;");
  let report;
  try {
    report = ticketCostReport(db, { since, until });
  } finally {
    db.close();
  }
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`ticket-cost: ${err.message}`);
    process.exit(1);
  }
}
