// scripts/analysis-sql.mjs — read-only SQL console backend for the local
// analytics dashboard over the telemetry SQLite store.
//
// Why this exists. The dashboard lets a human type arbitrary SQL against the
// telemetry database and see a table. Arbitrary SQL from a text box is the
// textbook injection surface, so this module never trusts a single guard —
// safety is layered, and no one layer is load-bearing:
//
//   1. checkSql() — a static scan that runs before anything touches a DB.
//      Comments are stripped, string literals and quoted identifiers are
//      ignored while scanning, exactly one statement is allowed (a single
//      optional trailing `;`), the first keyword must be SELECT or WITH, and
//      write/DDL/attach keywords (INSERT, DROP, PRAGMA, ATTACH, …) are
//      rejected as whole words outside literals. `WITH x AS (…) DELETE …`
//      is caught here like any other keyword.
//   2. The connection itself is `new DatabaseSync(dbPath, { readOnly: true })`
//      — SQLite refuses writes to the main database at the C level
//      ("attempt to write a readonly database"), so even a scanner bypass
//      cannot mutate the store.
//   3. Execution happens in a separate PROCESS (analysis-sql-worker.mjs,
//      child-process mode: JSON request in on stdin, JSON response out on
//      stdout). `node:sqlite` has no interrupt API, so a runaway query can
//      only be stopped by killing whatever is executing it; at timeoutMs
//      runReadOnlyQuery() sends SIGKILL (TerminateProcess on Windows — an
//      unconditional kill that lands even mid-native-call) and rejects
//      with code "timeout". A worker_thread + terminate() was tried first
//      and rejected: terminate() cannot interrupt a thread blocked inside
//      node:sqlite's native call (verified on Node 22.20/Windows — see the
//      worker file header). The worker still supports worker_thread mode
//      and it is contract-tested, but runReadOnlyQuery() does not use it.
//   4. Row cap: the worker stops iterating after maxRows + 1 rows and
//      reports `truncated: true`, so a billion-row scan cannot flood the
//      browser with one response.
//   5. extraTables (e.g. decision-log rows supplied by another module) are
//      created as TEMP tables on the read-only connection — the temp schema
//      is separate from the main database and stays writable (verified:
//      creating, inserting into and joining a TEMP table on a readOnly
//      DatabaseSync works on Node 22.20; the main database still refuses
//      writes).
//
// Column names come from the statement's metadata (`stmt.columns()`,
// available on Node 22.20, valid even when the result is empty), so an
// empty result yields the real column header and `[]` rows. Unnamed
// expressions get SQLite's default names (`1+1`); a null name (not observed
// in practice) falls back to `col_<n>`.
//
// Error codes: "rejected" (bad input, failed the static scan, invalid
// options), "timeout" (worker terminated at timeoutMs), "sql_error"
// (SQLite rejected the statement — bad syntax, missing table — or the
// worker exited unexpectedly; a crashed worker has no honest code of its
// own and is reported under "sql_error" with the exit reason in the
// message).
//
// The live store is never touched by this module's tests; callers pass the
// path (the dashboard will point at the telemetry DB of their choosing).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_ROWS = 5000;
export const DEFAULT_TIMEOUT_MS = 10000;

// Hard ceiling on the console input, checked before any scanning work.
const MAX_SQL_LENGTH = 20000;

// Keywords that must never appear as whole words outside string literals.
// UPSERT is listed even though SQLite spells it "INSERT ... ON CONFLICT";
// REPLACE covers "INSERT OR REPLACE" and "CREATE OR REPLACE" view tricks.
const FORBIDDEN_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "REPLACE", "UPSERT",
  "CREATE", "DROP", "ALTER",
  "ATTACH", "DETACH", "PRAGMA", "VACUUM", "REINDEX", "ANALYZE",
  "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE",
];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function rejected(reason) {
  return { ok: false, code: "rejected", reason };
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * One pass over the SQL producing two same-length strings:
 *  - clean: comments replaced by a single space, literals and everything
 *    else verbatim — this is (a trimmed form of) what will actually run.
 *  - masked: additionally, the CONTENTS of '…' literals and "…" / `…` /
 *    […] quoted identifiers replaced by spaces, so structural scanning
 *    (keywords, `;`) only ever sees real SQL structure.
 *
 * Handles the SQLite quoting rules: '' inside a '…' literal is an escaped
 * quote, "" inside a "…" identifier likewise; `[ … ]` is a compatibility
 * identifier quote and has no escape.
 */
function scanSql(sql) {
  let clean = "";
  let masked = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    // -- line comment: swallowed, one space in its place.
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      clean += " ";
      masked += " ";
      continue;
    }
    // /* block comment */ — must be terminated.
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      let closed = false;
      while (i < n) {
        if (sql[i] === "*" && sql[i + 1] === "/") { i += 2; closed = true; break; }
        i++;
      }
      if (!closed) return { error: "unterminated /* … */ comment" };
      clean += " ";
      masked += " ";
      continue;
    }
    // 'literal', "identifier", `identifier`, [identifier].
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      clean += ch;
      masked += ch;
      i++;
      let closed = false;
      while (i < n) {
        const c = sql[i];
        clean += c;
        masked += c === close ? c : " ";
        i++;
        if (c === close) {
          // A doubled quote inside '…'/"…"/`…` is an escape, not the end.
          if (close !== "]" && i < n && sql[i] === close) {
            clean += sql[i];
            masked += sql[i];
            i++;
            continue;
          }
          closed = true;
          break;
        }
      }
      if (!closed) return { error: "unterminated string literal or quoted identifier" };
      continue;
    }
    clean += ch;
    masked += ch;
    i++;
  }
  return { clean, masked };
}

/**
 * Static safety scan, run before anything touches a database.
 *
 *   → { ok: true, sql: <trimmed statement without trailing ;> }
 *   → { ok: false, code: "rejected", reason: <human-readable why> }
 */
export function checkSql(sql) {
  if (typeof sql !== "string") return rejected("SQL must be a string");
  if (sql.length > MAX_SQL_LENGTH) {
    return rejected(`SQL is ${sql.length} characters; the console allows at most ${MAX_SQL_LENGTH}`);
  }
  const scan = scanSql(sql);
  if (scan.error) return rejected(scan.error);
  const { clean, masked } = scan;
  if (masked.trim() === "") return rejected("statement is empty (or contains only comments)");

  // Statement boundaries: in `masked` every `;` is a real separator
  // (literals are blanked, comments already removed).
  const semicolons = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === ";") semicolons.push(i);
  }
  if (semicolons.length > 1) return rejected("only one statement is allowed");
  let statement = clean;
  if (semicolons.length === 1) {
    if (!masked.trimEnd().endsWith(";")) {
      return rejected("only one statement is allowed (`;` found mid-statement)");
    }
    statement = clean.slice(0, semicolons[0]);
  }
  const trimmed = statement.trim();
  if (trimmed === "") return rejected("statement is empty");

  const firstWord = /^[A-Za-z_]+/.exec(masked.trim());
  const firstKeyword = firstWord ? firstWord[0].toUpperCase() : "";
  if (firstKeyword !== "SELECT" && firstKeyword !== "WITH") {
    return rejected(`statement must start with SELECT or WITH (starts with ${firstKeyword ? `"${firstKeyword}"` : "something else"})`);
  }
  for (const keyword of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`(^|[^A-Za-z0-9_$])${keyword}(?![A-Za-z0-9_$])`, "i");
    if (re.test(masked)) {
      return rejected(`forbidden keyword "${keyword}" — the console runs SELECT/WITH statements only`);
    }
  }
  return { ok: true, sql: trimmed };
}

function validateExtraTables(extraTables) {
  if (extraTables == null || typeof extraTables !== "object" || Array.isArray(extraTables)) {
    throw codedError("rejected", "extraTables must be an object of { tableName: { columns, rows } }");
  }
  for (const [name, spec] of Object.entries(extraTables)) {
    if (!IDENTIFIER.test(name)) {
      throw codedError("rejected", `extra table name "${name}" is not a plain identifier ([A-Za-z_][A-Za-z0-9_]*)`);
    }
    const { columns, rows } = spec ?? {};
    if (!Array.isArray(columns) || columns.length === 0 ||
        !columns.every((c) => typeof c === "string" && IDENTIFIER.test(c))) {
      throw codedError("rejected", `extra table "${name}" needs a non-empty columns array of plain identifiers`);
    }
    if (!Array.isArray(rows) || !rows.every((r) => Array.isArray(r) && r.length === columns.length)) {
      throw codedError("rejected", `extra table "${name}" needs rows as arrays matching the columns arity`);
    }
  }
}

/**
 * Run one (already scanned-or-scan-it-yourself) read-only statement against
 * the telemetry DB, in a child process with a hard timeout and a row cap.
 *
 * Resolves → { columns: string[], rows: any[][], rowCount, truncated, elapsedMs }
 * Rejects  → Error with .code "rejected" | "timeout" | "sql_error".
 *
 * extraTables: { <name>: { columns: string[], rows: any[][] } } — created
 * as TEMP tables on the read-only connection, joinable with the telemetry
 * tables.
 */
export async function runReadOnlyQuery(sql, options = {}) {
  const verdict = checkSql(sql);
  if (!verdict.ok) throw codedError("rejected", verdict.reason);

  const {
    dbPath,
    maxRows = DEFAULT_MAX_ROWS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    extraTables = {},
  } = options ?? {};
  if (typeof dbPath !== "string" || dbPath === "") {
    throw codedError("rejected", "dbPath is required (path to a telemetry SQLite file)");
  }
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw codedError("rejected", `maxRows must be a positive integer, got ${maxRows}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw codedError("rejected", `timeoutMs must be a positive integer, got ${timeoutMs}`);
  }
  validateExtraTables(extraTables);

  const workerPath = fileURLToPath(new URL("./analysis-sql-worker.mjs", import.meta.url));

  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const child = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      // SIGKILL = TerminateProcess on Windows: unconditional, lands even
      // while the child is blocked inside node:sqlite's native call — which
      // is exactly when the timeout fires.
      child.kill("SIGKILL");
      settle(reject, codedError("timeout", `query exceeded ${timeoutMs} ms and was terminated`));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.stdin.on("error", () => { /* EPIPE if the child died before reading */ });
    child.stdin.write(JSON.stringify({ sql: verdict.sql, dbPath, maxRows, extraTables }, jsonSafeReplacer) + "\n");
    child.stdin.end();

    child.on("error", (err) => {
      settle(reject, codedError("sql_error", `failed to spawn the query worker: ${err?.message ?? err}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      // One JSON line is the whole protocol; take the last line in case a
      // runtime warning ever lands on stdout.
      const lines = stdout.split("\n").filter((l) => l.trim() !== "");
      const payload = lines.length > 0 ? tryParseJson(lines[lines.length - 1]) : null;
      if (payload && payload.ok === true) {
        settle(resolve, { ...payload.result, elapsedMs: Date.now() - startedAt });
      } else if (payload && payload.ok === false) {
        settle(reject, codedError(payload.code, payload.message));
      } else {
        const why = signal
          ? `worker was killed (signal ${signal})`
          : `worker exited with code ${code}`;
        settle(reject, codedError(
          "sql_error",
          `${why} without returning a result${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`,
        ));
      }
    });
  });
}

// BigInts are not JSON-serializable; extraTables rows may legally contain
// them (another module supplies decision-log rows), so apply the same
// contract conversion before piping the request to the worker.
function jsonSafeReplacer(key, value) {
  if (typeof value === "bigint") {
    return value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return value;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
