// Contract test for the read-only SQL console backend (analysis-sql.mjs).
//
// The console exists so a human can type arbitrary SQL against the
// telemetry store without being able to break it. Every assertion here is
// a way that promise can silently break: a write/DDL keyword slipping past
// the static scan, a statement smuggled behind a comment, the read-only
// flag not actually being enforced, a runaway query hanging the server
// because the timeout never fires, the row cap flooding the browser, TEMP
// tables (extraTables) being un-joinable, or a >2^53 integer silently
// losing precision on its way to JSON.
//
// Each scenario targets one failure mode, and the two most dangerous ones
// (writes, timeouts) get an end-to-end assertion, not just a scanner one.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import {
  checkSql,
  runReadOnlyQuery,
  DEFAULT_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
} from "./analysis-sql.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// Await a rejection and assert its .code; report the actual code on mismatch.
async function expectReject(promise, code, name) {
  try {
    await promise;
    check(name, false, "resolved instead of rejecting");
  } catch (err) {
    check(name, err?.code === code, `expected code "${code}", got "${err?.code}" (${err?.message ?? err})`);
    return err;
  }
  return null;
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "analysis-sql-test-"));
  const dbPath = join(temp, "fixture.sqlite");

  // --- fixture (read-write, for fixture creation only) -------------------
  const rw = new DatabaseSync(dbPath);
  rw.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, name TEXT)");
  rw.exec("CREATE TABLE big (v INTEGER)");
  rw.exec("CREATE TABLE blobs (b BLOB)");
  const insertSession = rw.prepare("INSERT INTO sessions (name) VALUES (?)");
  for (let i = 1; i <= 12; i++) insertSession.run(`s${i}`);
  // Bind as BigInt: a JS Number literal would already have lost precision.
  rw.prepare("INSERT INTO big (v) VALUES (?)").run(42n);
  rw.prepare("INSERT INTO big (v) VALUES (?)").run(9223372036854775807n);
  rw.prepare("INSERT INTO blobs (b) VALUES (x'41424344')").run();
  rw.close();

  // --- API surface --------------------------------------------------------
  check("DEFAULT_MAX_ROWS is 5000", DEFAULT_MAX_ROWS === 5000);
  check("DEFAULT_TIMEOUT_MS is 10000", DEFAULT_TIMEOUT_MS === 10000);

  // --- checkSql: accepts ---------------------------------------------------
  let v = checkSql("SELECT 1");
  check("accepts plain SELECT", v.ok === true, JSON.stringify(v));
  check("accepts plain SELECT, trimmed sql", v.ok === true && v.sql === "SELECT 1");

  v = checkSql("  SELECT 1  ");
  check("trims surrounding whitespace", v.ok === true && v.sql === "SELECT 1");

  v = checkSql("WITH x AS (SELECT 1 AS a) SELECT a FROM x");
  check("accepts WITH ... SELECT", v.ok === true, JSON.stringify(v));

  v = checkSql("SELECT 1;");
  check("accepts single trailing ;", v.ok === true, JSON.stringify(v));
  check("strips the trailing ;", v.ok === true && v.sql === "SELECT 1");

  v = checkSql("SELECT 'drop table x' AS v");
  check("keywords inside a string literal are not rejected", v.ok === true, JSON.stringify(v));

  v = checkSql('SELECT "delete" FROM sessions');
  check("keywords inside a quoted identifier are not rejected", v.ok === true, JSON.stringify(v));

  v = checkSql("SELECT 'a''b' AS v");
  check("escaped quote inside a literal does not end the literal", v.ok === true, JSON.stringify(v));

  v = checkSql("SELECT 1 -- ; a comment with a semicolon");
  check("semicolon inside a line comment is ignored", v.ok === true && v.sql === "SELECT 1", JSON.stringify(v));

  // --- checkSql: rejects ---------------------------------------------------
  const rejections = [
    ["INSERT", "INSERT INTO sessions (name) VALUES ('x')"],
    ["UPDATE", "UPDATE sessions SET name = 'x'"],
    ["DELETE", "DELETE FROM sessions"],
    ["DROP", "DROP TABLE sessions"],
    ["ATTACH", "ATTACH DATABASE 'evil.sqlite' AS evil"],
    ["PRAGMA", "PRAGMA journal_mode"],
    ["VACUUM", "VACUUM"],
    ["two statements", "SELECT 1; SELECT 2"],
    ["WITH ... DELETE", "WITH x AS (SELECT 1) DELETE FROM t"],
    ["statement after a comment", "SELECT 1 /* x */; DELETE FROM t"],
    ["empty string", ""],
    ["whitespace/comments only", "   -- nothing here"],
    ["non-string input", null],
    ["over 20000 chars", "SELECT '" + "a".repeat(20001) + "' AS v"],
    ["first keyword is not SELECT/WITH", "EXPLAIN SELECT 1"],
  ];
  for (const [label, sql] of rejections) {
    v = checkSql(sql);
    check(`rejects ${label}`,
      v.ok === false && v.code === "rejected" && typeof v.reason === "string" && v.reason.length > 0,
      JSON.stringify(v));
  }

  // --- runReadOnlyQuery: basic SELECT --------------------------------------
  const result = await runReadOnlyQuery("SELECT id, name FROM sessions ORDER BY id", { dbPath });
  check("returns columns from metadata", JSON.stringify(result.columns) === JSON.stringify(["id", "name"]), JSON.stringify(result.columns));
  check("returns all 12 rows", result.rows.length === 12 && result.rowCount === 12, `rows=${result.rows.length}`);
  check("row values line up with columns", result.rows[0][0] === 1 && result.rows[0][1] === "s1", JSON.stringify(result.rows[0]));
  check("not truncated under the cap", result.truncated === false);
  check("elapsedMs is a number", typeof result.elapsedMs === "number" && result.elapsedMs >= 0);

  const empty = await runReadOnlyQuery("SELECT id FROM sessions WHERE id > 100", { dbPath });
  check("empty result keeps its columns", JSON.stringify(empty.columns) === JSON.stringify(["id"]), JSON.stringify(empty.columns));
  check("empty result has no rows", empty.rows.length === 0 && empty.rowCount === 0 && empty.truncated === false);

  // --- layer 2: the read-only connection refuses writes ---------------------
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  try {
    ro.prepare("INSERT INTO sessions (name) VALUES ('x')").run();
    check("INSERT on a readOnly DatabaseSync throws", false, "did not throw");
  } catch {
    check("INSERT on a readOnly DatabaseSync throws", true);
  } finally {
    ro.close();
  }

  // And the console itself rejects writes before ever opening the DB:
  await expectReject(
    runReadOnlyQuery("INSERT INTO sessions (name) VALUES ('x')", { dbPath }),
    "rejected", "runReadOnlyQuery rejects INSERT with code rejected");

  // --- row cap --------------------------------------------------------------
  const capped = await runReadOnlyQuery("SELECT id FROM sessions ORDER BY id", { dbPath, maxRows: 10 });
  check("maxRows caps the result at 10", capped.rows.length === 10 && capped.rowCount === 10, `rows=${capped.rows.length}`);
  check("over-cap result is flagged truncated", capped.truncated === true);

  const uncapped = await runReadOnlyQuery("SELECT id FROM sessions ORDER BY id", { dbPath, maxRows: 20 });
  check("maxRows above the result keeps all rows", uncapped.rows.length === 12 && uncapped.rowCount === 12, `rows=${uncapped.rows.length}`);
  check("under-cap result is not truncated", uncapped.truncated === false);

  // --- timeout ---------------------------------------------------------------
  // A recursive CTE that never emits a matching row: the row cap cannot
  // save us, only the hard kill can. If the timeout is broken this hangs
  // forever — which is exactly what happened with worker_thread +
  // terminate() (terminate cannot interrupt a thread blocked in
  // node:sqlite's native call); hence the child-process design.
  const started = Date.now();
  await expectReject(
    runReadOnlyQuery(
      "WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t) SELECT x FROM t WHERE x = -1",
      { dbPath, timeoutMs: 500 },
    ),
    "timeout", "runaway query rejects with code timeout");
  const elapsed = Date.now() - started;
  check("timeout fires well under 5 s", elapsed < 5000, `${elapsed} ms`);

  // --- sql_error --------------------------------------------------------------
  const sqlErr = await expectReject(
    runReadOnlyQuery("SELECT * FROM no_such_table", { dbPath }),
    "sql_error", "missing table rejects with code sql_error");
  check("sql_error carries SQLite's message", (sqlErr?.message ?? "").includes("no_such_table"), sqlErr?.message);

  await expectReject(
    runReadOnlyQuery("SELECT FROM WHERE", { dbPath }),
    "sql_error", "syntax error rejects with code sql_error");

  // --- extraTables -------------------------------------------------------------
  const joined = await runReadOnlyQuery(
    `SELECT s.id, s.name, e.label
       FROM sessions s JOIN extra_labels e ON e.id = s.id
      ORDER BY s.id`,
    {
      dbPath,
      extraTables: {
        extra_labels: { columns: ["id", "label"], rows: [[1, "one"], [2, "two"]] },
      },
    });
  check("extraTables rows are queryable and joinable",
    JSON.stringify(joined.rows) === JSON.stringify([[1, "s1", "one"], [2, "s2", "two"]]),
    JSON.stringify(joined.rows));

  const direct = await runReadOnlyQuery("SELECT id, label FROM extra_labels ORDER BY id", {
    dbPath,
    extraTables: { extra_labels: { columns: ["id", "label"], rows: [[1, "one"], [2, "two"]] } },
  });
  check("extraTables readable on their own",
    JSON.stringify(direct.rows) === JSON.stringify([[1, "one"], [2, "two"]]),
    JSON.stringify(direct.rows));

  await expectReject(
    runReadOnlyQuery("SELECT 1 FROM t", {
      dbPath,
      extraTables: { "bad name!": { columns: ["id"], rows: [[1]] } },
    }),
    "rejected", "extraTables with an invalid table name is rejected");

  await expectReject(
    runReadOnlyQuery("SELECT 1 FROM t", {
      dbPath,
      extraTables: { t: { columns: ["not ok"], rows: [[1]] } },
    }),
    "rejected", "extraTables with an invalid column name is rejected");

  // --- value conversion ----------------------------------------------------------
  const big = await runReadOnlyQuery("SELECT v FROM big ORDER BY v", { dbPath });
  check("BigInt within MAX_SAFE_INTEGER comes back as Number",
    big.rows[0][0] === 42 && typeof big.rows[0][0] === "number", JSON.stringify(big.rows[0]));
  check("BigInt above 2^53 comes back as a string",
    big.rows[1][0] === "9223372036854775807" && typeof big.rows[1][0] === "string", JSON.stringify(big.rows[1]));

  const blob = await runReadOnlyQuery("SELECT b FROM blobs", { dbPath });
  check("BLOB becomes a size placeholder",
    blob.rows[0][0] === "<blob 4 bytes>", JSON.stringify(blob.rows[0]));

  // --- worker_thread mode of the worker file (still supported, tested) ------
  const workerReply = await new Promise((resolve, reject) => {
    const w = new Worker(new URL("./analysis-sql-worker.mjs", import.meta.url), {
      workerData: { sql: "SELECT 1 AS x", dbPath, maxRows: 10, extraTables: {} },
    });
    w.on("message", resolve);
    w.on("error", reject);
  });
  check("worker_thread mode answers over parentPort",
    workerReply.ok === true && workerReply.result.columns[0] === "x" && workerReply.result.rows[0][0] === 1,
    JSON.stringify(workerReply).slice(0, 200));

  // --- the worker re-validates: a rejected statement sent DIRECTLY is refused --
  // The parent scans before spawning, but the worker file is also reachable
  // on its own (worker_thread mode above, or a hand-rolled child spawn) —
  // checkSql must run there too, no single check is load-bearing.
  const workerPath = fileURLToPath(new URL("./analysis-sql-worker.mjs", import.meta.url));
  const directReply = await new Promise((resolve, reject) => {
    const w = spawn(process.execPath, [workerPath], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    w.stdout.on("data", (d) => { out += d; });
    w.on("error", reject);
    w.on("close", () => resolve(out));
    w.stdin.on("error", () => { /* EPIPE if the child died early */ });
    w.stdin.write(JSON.stringify({ sql: "DELETE FROM sessions", dbPath, maxRows: 10, extraTables: {} }) + "\n");
    w.stdin.end();
  });
  {
    const lines = directReply.split("\n").filter((l) => l.trim() !== "");
    const payload = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
    check("worker (child mode) refuses a rejected statement sent directly",
      payload?.ok === false && payload?.code === "rejected",
      JSON.stringify(payload));
  }
  const workerReject = await new Promise((resolve, reject) => {
    const w = new Worker(new URL("./analysis-sql-worker.mjs", import.meta.url), {
      workerData: { sql: "DROP TABLE sessions", dbPath, maxRows: 10, extraTables: {} },
    });
    w.on("message", resolve);
    w.on("error", reject);
  });
  check("worker (thread mode) refuses a rejected statement sent directly",
    workerReject?.ok === false && workerReject?.code === "rejected",
    JSON.stringify(workerReject));

  rmSync(temp, { recursive: true, force: true });
}

main().then(() => {
  for (const f of failures) console.log(`FAIL: ${f}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
