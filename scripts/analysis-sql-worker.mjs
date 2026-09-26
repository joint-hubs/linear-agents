// scripts/analysis-sql-worker.mjs — the query executor behind
// runReadOnlyQuery() in analysis-sql.mjs.
//
// Why this exists. `node:sqlite` is synchronous and has no interrupt API:
// once a statement starts, nothing in JS can stop it, so the query must run
// off the dashboard's main thread. This file is dual-mode on purpose:
//
//   - worker_thread mode (imported as a Worker with workerData): reports
//     over parentPort. Supported and contract-tested, but NOT used by
//     runReadOnlyQuery(), because `worker.terminate()` cannot interrupt a
//     thread blocked inside node:sqlite's native call — verified on Node
//     22.20/Windows: a pure-JS `while(true)` worker terminates in ~15 ms,
//     while a worker stuck in an infinite recursive CTE was still running
//     30 s later and the terminate() promise never settled. A worker that
//     cannot be killed cannot back a timeout.
//   - child-process mode (run directly, the default path): reads one JSON
//     request line from stdin, runs the query, writes one JSON response
//     line to stdout, exits. The parent kills this process with SIGKILL
//     (TerminateProcess on Windows) at the timeout — an unconditional kill
//     that works even mid-native-call. This is how runReadOnlyQuery()
//     guarantees the timeout.
//
// Both modes share the same execution core, so the safety layers are
// identical either way:
//   - the connection is opened { readOnly: true } — SQLite refuses writes
//     to the main database at the C level;
//   - extraTables become TEMP tables, which live in the separate temp
//     schema and stay writable on a read-only connection (verified on
//     Node 22.20);
//   - rows are streamed via stmt.iterate() and stopped at maxRows + 1;
//   - stmt.setReadBigInts(true) so no 64-bit integer is silently lossy,
//     then BigInts are converted per the JSON contract (safe → Number,
//     else string); BLOBs become "<blob N bytes>" placeholders.
//
// The main module re-validates every input before spawning this file; the
// executor re-validates anyway because no single check is load-bearing: the
// static scan (checkSql from analysis-sql.mjs) runs here too, and bad
// identifiers, bad extraTables shapes and SQLite errors are all caught here
// and reported as { ok: false, code, message }.

import { parentPort, isMainThread, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { checkSql } from "./analysis-sql.mjs";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function rejectedError(message) {
  const err = new Error(message);
  err.code = "rejected";
  return err;
}

// Convert one SQLite value to the JSON-friendly contract:
//   bigint  → Number when |v| <= Number.MAX_SAFE_INTEGER, else String(v)
//   blob    → "<blob N bytes>" (Uint8Array; Buffer is a subclass)
//   null    → null
function jsonValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    return (value >= -MAX_SAFE && value <= MAX_SAFE) ? Number(value) : value.toString();
  }
  if (value instanceof Uint8Array) return `<blob ${value.length} bytes>`;
  return value;
}

// Values bound into a TEMP table: node:sqlite has no boolean or undefined,
// so those get canonicalized; everything else it accepts as-is.
function bindValue(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function executeRequest({ sql, dbPath, maxRows, extraTables }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const [name, spec] of Object.entries(extraTables ?? {})) {
      if (!IDENTIFIER.test(name)) {
        throw rejectedError(`extra table name "${name}" is not a plain identifier`);
      }
      const columns = spec?.columns;
      if (!Array.isArray(columns) || columns.length === 0 ||
          !columns.every((c) => typeof c === "string" && IDENTIFIER.test(c))) {
        throw rejectedError(`extra table "${name}" needs non-empty plain-identifier column names`);
      }
      if (!Array.isArray(spec?.rows) ||
          !spec.rows.every((r) => Array.isArray(r) && r.length === columns.length)) {
        throw rejectedError(`extra table "${name}" needs rows as arrays matching the columns arity`);
      }
      const columnList = columns.map((c) => `"${c}"`).join(", ");
      db.exec(`CREATE TEMP TABLE "${name}" (${columnList})`);
      if (spec.rows.length > 0) {
        const placeholders = columns.map(() => "?").join(", ");
        const insert = db.prepare(`INSERT INTO "${name}" (${columnList}) VALUES (${placeholders})`);
        for (const row of spec.rows) {
          insert.run(...row.map(bindValue));
        }
      }
    }

    const stmt = db.prepare(sql);
    // Columns from the statement metadata (Node 22.20): works before any row
    // is produced, so empty results still get their header. Unnamed
    // expressions get SQLite's default names ("1+1"); the col_N fallback is
    // for a null name, which SQLite can emit but we have not observed.
    const columns = stmt.columns().map((c, i) => c.name ?? `col_${i + 1}`);

    // Arrays (not objects) so row[i] lines up with columns[i], and BigInts
    // so nothing is silently rounded by JS before we decide.
    stmt.setReturnArrays(true);
    stmt.setReadBigInts(true);

    const rows = [];
    let truncated = false;
    for (const row of stmt.iterate()) {
      rows.push(row.map(jsonValue));
      if (rows.length > maxRows) {
        // We read one row beyond the cap to KNOW more existed.
        truncated = true;
        break;
      }
    }
    if (truncated) rows.length = maxRows;

    return { columns, rows, rowCount: rows.length, truncated };
  } finally {
    db.close();
  }
}

function send(payload) {
  if (isMainThread) {
    // Child-process mode: one JSON line on stdout is the whole protocol.
    process.stdout.write(JSON.stringify(payload) + "\n");
    process.exit(0);
  }
  parentPort.postMessage(payload);
}

try {
  const request = isMainThread
    ? JSON.parse(readFileSync(0, "utf8")) // stdin, closed by the parent after the request line
    : workerData;
  // Defence in depth: the parent scans before spawning, but this file is also
  // reachable directly (worker_thread mode, or a hand-rolled spawn), so the
  // executor runs checkSql itself — no single check is load-bearing.
  const verdict = checkSql(request?.sql);
  if (!verdict.ok) {
    send({ ok: false, code: "rejected", message: verdict.reason });
  } else {
    const result = executeRequest({ ...request, sql: verdict.sql });
    send({ ok: true, result });
  }
} catch (err) {
  send({ ok: false, code: err?.code === "rejected" ? "rejected" : "sql_error", message: err?.message ?? String(err) });
}
