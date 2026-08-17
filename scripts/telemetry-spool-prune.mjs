#!/usr/bin/env node
// scripts/telemetry-spool-prune.mjs — bring the spool archive back in line with
// the events table.
//
// emitEvent() writes every event to spool/pending as JSON BEFORE touching the
// database, so a crashed or failed write can be replayed later. On success the
// file is moved to spool/archive/<YYYY-MM>/<eventId>.json.
//
// Nothing ever reads the archive. replayPending() reads `pending`; `archive` has
// no reader anywhere in the codebase — it is a write-only safety net that grows
// without bound. The quality.reported leak turned that slow growth into 5 795 233
// files / 2 650 MB, against 75 859 events actually in the store.
//
// This keeps exactly the files that mirror a row in `events` and removes the
// rest. It does NOT decide what belongs in the database — telemetry-prune.mjs
// does that; run it first and this one follows.
//
// Speed: enumerating millions of files on NTFS takes minutes, so the keepers are
// located by id (one stat each) rather than by walking the tree, and the removal
// is a directory swap plus one bulk tree delete instead of millions of unlinks.
//
// Usage:
//   node scripts/telemetry-spool-prune.mjs            report only, no writes
//   node scripts/telemetry-spool-prune.mjs --apply    swap in the pruned archive
//   node scripts/telemetry-spool-prune.mjs --apply --keep-purged
//                                                     swap but leave the old tree
//
// STOP telemetry-server first — it writes into the archive on every ingest tick.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function telemetryHome() {
  if (process.env.LA_TELEMETRY_HOME) return process.env.LA_TELEMETRY_HOME;
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(local, "linear-agents", "telemetry");
}

const HOME = telemetryHome();
const DB_PATH = process.env.LA_TELEMETRY_DB || join(HOME, "telemetry.sqlite");
const ARCHIVE = join(HOME, "spool", "archive");

const n = (v) => Number(v).toLocaleString("en-US");
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

/** Month folders present in the archive, newest last. */
function monthDirs() {
  if (!existsSync(ARCHIVE)) return [];
  return readdirSync(ARCHIVE, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Locate the archive file for one event.
 *
 * archiveEvent() files by observedAt.slice(0,7), so the month is usually known
 * up front. It falls back to now() when observedAt is missing, and a row can be
 * re-observed across a month boundary, so miss → scan the other month folders.
 */
function locate(eventId, observedAt, months) {
  const preferred = (observedAt || "").slice(0, 7);
  const order = preferred ? [preferred, ...months.filter((m) => m !== preferred)] : months;
  for (const m of order) {
    const p = join(ARCHIVE, m, `${eventId}.json`);
    if (existsSync(p)) return p;
  }
  return null;
}

function main() {
  const apply = process.argv.includes("--apply");
  const keepPurged = process.argv.includes("--keep-purged");

  if (!existsSync(ARCHIVE)) {
    console.error(`[spool] archive not found: ${ARCHIVE}`);
    process.exit(1);
  }
  if (!existsSync(DB_PATH)) {
    console.error(`[spool] database not found: ${DB_PATH}`);
    process.exit(1);
  }
  console.log(`[spool] archive:  ${ARCHIVE}`);
  console.log(`[spool] database: ${DB_PATH}`);

  const months = monthDirs();
  console.log(`[spool] month folders: ${months.join(", ") || "(none)"}`);

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 30000");
  const rows = db.prepare("SELECT event_id, observed_at FROM events").all();
  db.close();
  console.log(`[spool] events in store: ${n(rows.length)}`);

  let found = 0;
  let missing = 0;
  let keptBytes = 0;
  const keepers = [];
  for (const row of rows) {
    const path = locate(row.event_id, row.observed_at, months);
    if (!path) { missing++; continue; }
    found++;
    try { keptBytes += statSync(path).size; } catch { /* raced; counted anyway */ }
    keepers.push([row.event_id, path]);
  }
  console.log(`[spool] archived copies found:   ${n(found)} (${mb(keptBytes)})`);
  console.log(`[spool] events with no archived copy: ${n(missing)}`);
  console.log(`[spool] everything else in the archive will be removed.`);

  if (!apply) {
    console.log("\n[spool] dry run — nothing written. Re-run with --apply.");
    return;
  }

  // Build the replacement tree beside the old one, then swap. The swap is
  // atomic-ish and instant, so the system is correct again immediately and the
  // slow bulk delete happens afterwards with nothing depending on it.
  const staging = `${ARCHIVE}.keep`;
  const purged = `${ARCHIVE}.purge-${Date.now()}`;
  if (existsSync(staging)) {
    console.error(`[spool] staging dir already exists, refusing: ${staging}`);
    process.exit(1);
  }
  mkdirSync(staging, { recursive: true });

  let moved = 0;
  for (const [eventId, path] of keepers) {
    const month = path.slice(ARCHIVE.length + 1).split(/[\\/]/)[0];
    const destDir = join(staging, month);
    mkdirSync(destDir, { recursive: true });
    try {
      renameSync(path, join(destDir, `${eventId}.json`));
      moved++;
    } catch (error) {
      console.error(`[spool] could not move ${eventId}: ${error.message}`);
    }
  }
  console.log(`[spool] moved ${n(moved)} keepers into the replacement tree`);

  if (moved !== found) {
    console.error(`[spool] REFUSING TO SWAP: moved ${moved} of ${found} keepers — leaving both trees in place`);
    console.error(`[spool]   replacement: ${staging}`);
    process.exit(1);
  }

  renameSync(ARCHIVE, purged);
  renameSync(staging, ARCHIVE);
  console.log(`[spool] swapped in the pruned archive; old tree parked at ${purged}`);

  if (keepPurged) {
    console.log("[spool] --keep-purged: leaving the old tree for manual removal.");
    return;
  }
  console.log("[spool] deleting the old tree (millions of files — this takes a while) ...");
  const t = Date.now();
  rmSync(purged, { recursive: true, force: true });
  console.log(`[spool] old tree deleted in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

main();
