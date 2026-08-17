#!/usr/bin/env node
// scripts/telemetry-reproject.mjs — rebuild projections from the event log.
//
// The events table is the source of truth; runs, usage_facts, cost_facts and the
// rest are projections of it. Until now there was no way to run that projection
// again, which made one failure mode permanent: if an event row was written but
// its handler never completed, every later re-ingest saw the event already
// recorded, returned duplicate, and skipped the handler. The facts were gone for
// good even though the evidence was sitting right there.
//
// This never deletes and never writes to `events` — it only folds stored events
// forward into the projections. Handlers are idempotent, so replaying an event
// that was already projected is a no-op.
//
// Usage:
//   node scripts/telemetry-reproject.mjs --run <RUN_ID>          report only
//   node scripts/telemetry-reproject.mjs --run <RUN_ID> --apply
//   node scripts/telemetry-reproject.mjs --all --apply           every run
//   node scripts/telemetry-reproject.mjs --stuck                 list candidates
//
// --stuck lists runs that have usage.recorded events but no usage_facts, i.e.
// exactly the runs this tool exists for.

import { openTelemetryDb, reprojectEvents, sqliteAvailable } from "./telemetry-store.mjs";

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function main() {
  if (!sqliteAvailable()) {
    console.error("[reproject] node:sqlite unavailable");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const runId = argVal(args, "--run");
  const all = args.includes("--all");
  const stuck = args.includes("--stuck");

  if (!runId && !all && !stuck) {
    console.error("[reproject] pass --run <RUN_ID>, --all, or --stuck");
    process.exit(2);
  }

  const db = openTelemetryDb();
  try {
    const candidates = db.prepare(
      `SELECT r.run_id,
              (SELECT COUNT(*) FROM events e WHERE e.run_id=r.run_id AND e.event_type='usage.recorded') ev,
              (SELECT COUNT(*) FROM usage_facts u WHERE u.run_id=r.run_id) uf
         FROM runs r WHERE ev > 0 AND uf = 0 ORDER BY r.started_at`,
    ).all();

    if (stuck) {
      console.log(`[reproject] runs with usage events but no facts: ${candidates.length}`);
      for (const c of candidates) console.log(`  ${c.run_id}  events=${c.ev} facts=${c.uf}`);
      return;
    }

    const targets = all ? candidates.map((c) => c.run_id) : [runId];
    for (const target of targets) {
      const before = db.prepare("SELECT COUNT(*) n FROM usage_facts WHERE run_id=?").get(target).n;
      const summary = reprojectEvents(db, { runId: target, dryRun: !apply });
      const after = apply ? db.prepare("SELECT COUNT(*) n FROM usage_facts WHERE run_id=?").get(target).n : before;
      console.log(`[reproject] ${target}: scanned=${summary.scanned} projected=${summary.projected} ` +
        `duplicate=${summary.duplicate} failed=${summary.failed} facts ${before}->${after}${apply ? "" : " (dry)"}`);
      for (const e of summary.errors) console.log(`    ! ${e}`);
    }
    if (!apply) console.log("\n[reproject] dry run — nothing written. Re-run with --apply.");
  } finally {
    db.close();
  }
}

main();
