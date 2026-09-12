// Versioning-contract test for the tool-input identity scheme (FOC-220 AC1).
//
// The identity recipe (canonicalInputJson + HMAC) is INPUT_IDENTITY_SCHEME_VERSION;
// the store records which scheme produced its stored identities
// (store_settings.tool_identity_scheme) and the write paths refuse on mismatch.
// Without that, a change to the normalization would silently mix incomparable
// digests — two digests differing because of scheme drift would read as
// "different input", a measurement that cannot be wrong.
//
// Scenarios:
//   (1) the scheme version is exported, pinned, and stamped into a fresh store
//   (2) normal operation under a matching scheme is unaffected
//   (3) a store written under a different scheme is refused with an actionable
//       message, writes nothing, and the mismatch shows up in queryHealth
//   (4) a pre-contract store (no recorded scheme) adopts the current one —
//       cheap for existing data, no re-derivation of backfilled rows
//   (5) telemetry-normalize-tools.mjs (the re-derivation CLI) refuses on the
//       same mismatch, before any pass writes

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { INPUT_IDENTITY_SCHEME_VERSION } from "./tool-identity.mjs";
import { openTelemetryDb, queryHealth, recordToolFact, toolIdentityScheme } from "./telemetry-store.mjs";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, "..");

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

// Same sentinel as telemetry-store-migration.test.mjs: an environment gap is
// counted separately, never as a pass.
class TestSkip extends Error {}

function assert(value, message) {
  if (!value) throw new Error(message || "assertion failed");
}

function requireSqlite() {
  if (!DatabaseSync) throw new TestSkip("node:sqlite unavailable");
}

const testQueue = [];
function test(name, fn) {
  testQueue.push({ name, fn });
}

function freshStore(temp, name) {
  const dbPath = join(temp, name);
  const db = openTelemetryDb(dbPath);
  db.prepare("INSERT INTO runs (run_id, squad, status, updated_at) VALUES ('run-id-1','dev','completed','2026-09-12T00:00:00.000Z')").run();
  return { db, dbPath };
}

function recordFor(offset) {
  return {
    run_id: "run-id-1", agent_key: "implementer", tool_name_raw: "Read", tool_name_canon: "read_file",
    tool_input: '{"file_path":"/tmp/x"}', tool_input_full: '{"file_path":"/tmp/x"}',
    tool_result_state: "ok", tool_result_bytes: 11, tool_result_full: "hello world",
    tool_has_error: 0, turn_index: 0, tool_index: 0,
    source_path: "C:/sessions/id.jsonl", source_offset: offset,
  };
}

// (1) The version exists and is pinned. A bump MUST be deliberate: update this
// assertion in the same commit, and reconcile stores recorded under the old
// scheme (queryHealth.identityScheme / toolIdentityScheme make the drift visible).
test("scenario (1): scheme version exported, a positive integer, pinned to 1", () => {
  assert(Number.isInteger(INPUT_IDENTITY_SCHEME_VERSION) && INPUT_IDENTITY_SCHEME_VERSION >= 1,
    `INPUT_IDENTITY_SCHEME_VERSION=${INPUT_IDENTITY_SCHEME_VERSION} (expected a positive integer)`);
  assert(INPUT_IDENTITY_SCHEME_VERSION === 1,
    `INPUT_IDENTITY_SCHEME_VERSION=${INPUT_IDENTITY_SCHEME_VERSION} (expected 1 — a bump is a deliberate contract change: update this pin and reconcile stores)`);
});

// (2) Matching scheme: stamping + ordinary writes unaffected.
test("scenario (2): fresh store adopts and stamps the current scheme; recordToolFact writes as before", async () => {
  requireSqlite();
  const temp = mkdtempSync(join(tmpdir(), "tool-id-2-"));
  try {
    const { db, dbPath } = freshStore(temp, "a.sqlite");
    try {
      const scheme = toolIdentityScheme(db);
      assert(scheme.adopted === true, `adopted=${scheme.adopted} (expected true on first contact)`);
      assert(scheme.stored === scheme.current && scheme.mismatch === false,
        `stored=${scheme.stored} current=${scheme.current} mismatch=${scheme.mismatch}`);
      const row = db.prepare("SELECT value FROM store_settings WHERE key='tool_identity_scheme'").get();
      assert(row?.value === String(INPUT_IDENTITY_SCHEME_VERSION),
        `store_settings.tool_identity_scheme=${row?.value} (expected ${INPUT_IDENTITY_SCHEME_VERSION})`);

      const result = await recordToolFact(recordFor(1), { dbPath });
      assert(result.recorded === true, `recordToolFact recorded=${result.recorded} (${JSON.stringify(result)})`);
      const fact = db.prepare("SELECT tool_input_id FROM tool_facts WHERE run_id='run-id-1'").get();
      assert(/^[0-9a-f]{64}$/.test(fact.tool_input_id), `tool_input_id=${fact.tool_input_id} (expected 64-hex HMAC)`);

      // Re-open: the recorded scheme is stable and matches.
      db.close();
      const db2 = openTelemetryDb(dbPath);
      try {
        const again = toolIdentityScheme(db2);
        assert(again.mismatch === false && again.adopted === false,
          `reopen: mismatch=${again.mismatch} adopted=${again.adopted} (expected false/false)`);
      } finally { db2.close(); }
      return; // db already closed
    } catch (error) {
      try { db.close(); } catch { /* may already be closed */ }
      throw error;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// (3) The drift case: a store recorded under a different scheme refuses writes
// with an actionable message, and the state is visible in queryHealth.
test("scenario (3): store written under a different scheme is refused, writes nothing, health reports the mismatch", async () => {
  requireSqlite();
  const temp = mkdtempSync(join(tmpdir(), "tool-id-3-"));
  try {
    const { db, dbPath } = freshStore(temp, "b.sqlite");
    try {
      toolIdentityScheme(db); // stamp, then simulate a store written by other-scheme code
      db.prepare("UPDATE store_settings SET value='99' WHERE key='tool_identity_scheme'").run();

      const scheme = toolIdentityScheme(db);
      assert(scheme.mismatch === true && scheme.stored === 99 && scheme.current === INPUT_IDENTITY_SCHEME_VERSION,
        `scheme=${JSON.stringify(scheme)} (expected mismatch with stored=99)`);

      let threw = null;
      try {
        await recordToolFact(recordFor(2), { dbPath });
      } catch (error) {
        threw = error;
      }
      assert(threw !== null, `recordToolFact must refuse the write (threw=${threw})`);
      assert(/scheme 99/.test(threw.message) && new RegExp(`scheme ${INPUT_IDENTITY_SCHEME_VERSION}\\b`).test(threw.message),
        `message must name both schemes, got: ${threw.message}`);
      assert(threw.message.includes("tool-identity.mjs"),
        `message must point at the versioning contract, got: ${threw.message}`);

      const count = db.prepare("SELECT COUNT(*) AS n FROM tool_facts").get().n;
      assert(count === 0, `tool_facts rows=${count} (expected 0 — the refused fact must not be written)`);

      const health = queryHealth(db);
      assert(health.identityScheme?.mismatch === true && health.identityScheme?.stored === 99,
        `queryHealth.identityScheme=${JSON.stringify(health.identityScheme)} (expected the reported mismatch)`);
    } finally { db.close(); }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// (4) Cheap for existing data: a store with NO recorded scheme (written before
// the versioned contract) adopts the current scheme with one INSERT — no
// re-derivation of the backfilled rows.
test("scenario (4): pre-contract store (no scheme key) adopts the current scheme and keeps writing", async () => {
  requireSqlite();
  const temp = mkdtempSync(join(tmpdir(), "tool-id-4-"));
  try {
    const { db, dbPath } = freshStore(temp, "c.sqlite");
    try {
      toolIdentityScheme(db);
      db.prepare("DELETE FROM store_settings WHERE key='tool_identity_scheme'").run();

      const result = await recordToolFact(recordFor(3), { dbPath });
      assert(result.recorded === true, `recordToolFact recorded=${result.recorded} (${JSON.stringify(result)})`);
      const row = db.prepare("SELECT value FROM store_settings WHERE key='tool_identity_scheme'").get();
      assert(row?.value === String(INPUT_IDENTITY_SCHEME_VERSION),
        `adopted scheme=${row?.value} (expected ${INPUT_IDENTITY_SCHEME_VERSION} — one INSERT, no re-derivation)`);
    } finally { db.close(); }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// (5) The re-derivation CLI must refuse the same mismatch, before any pass
// (canon included) writes — and run clean when the scheme matches.
test("scenario (5): telemetry-normalize-tools.mjs exits 1 on scheme mismatch, 0 when matching", () => {
  requireSqlite();
  const temp = mkdtempSync(join(tmpdir(), "tool-id-5-"));
  try {
    const badPath = join(temp, "bad.sqlite");
    {
      const db = openTelemetryDb(badPath);
      try {
        toolIdentityScheme(db);
        db.prepare("UPDATE store_settings SET value='99' WHERE key='tool_identity_scheme'").run();
      } finally { db.close(); }
    }
    const bad = spawnSync(process.execPath, [join(repoRoot, "scripts", "telemetry-normalize-tools.mjs"), "--json"], {
      cwd: repoRoot, encoding: "utf8",
      env: { ...process.env, LA_TELEMETRY_DB: badPath },
    });
    assert(bad.status === 1, `mismatch run exit=${bad.status} (expected 1); stderr: ${bad.stderr}`);
    assert(bad.stderr.includes("identity-scheme mismatch") && bad.stderr.includes("99"),
      `stderr must name the refusal and both schemes, got: ${bad.stderr}`);

    const goodPath = join(temp, "good.sqlite");
    openTelemetryDb(goodPath).close(); // healthy store, no scheme key yet — the CLI's own adoption path is exercised
    const good = spawnSync(process.execPath, [join(repoRoot, "scripts", "telemetry-normalize-tools.mjs"), "--json"], {
      cwd: repoRoot, encoding: "utf8",
      env: { ...process.env, LA_TELEMETRY_DB: goodPath },
    });
    assert(good.status === 0, `matching run exit=${good.status} (expected 0); stderr: ${good.stderr}`);
    assert(good.stderr === "" || !good.stderr.includes("identity-scheme mismatch"),
      `matching run must not report a mismatch, stderr: ${good.stderr}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

for (const { name, fn } of testQueue) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    if (error instanceof TestSkip) {
      skipped++;
      console.log(`  SKIP ${name}: ${error.message}`);
      continue;
    }
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}
console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
if (failed) console.log(failures.join("\n"));
process.exit(failed ? 1 : 0);
