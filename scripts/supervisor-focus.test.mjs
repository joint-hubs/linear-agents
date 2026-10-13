// scripts/supervisor-focus.test.mjs — the Supervisor's declared focus (FOC-769,
// supervisor-focus.mjs).
//
// The properties worth protecting:
//   · normalizeFocus accepts ticket ids (uppercased) and "overhead"
//     case-insensitively, and THROWS on everything else;
//   · setFocus appends one line per CHANGE — a repeated set is a no-op, a
//     switch appends; the telemetry identity is a hash of the change's
//     content, `line` is informational for humans only;
//   · the current-run record gains `focus` only when its runId matches — a
//     stale pointer is never rewritten to claim a focus it never had;
//   · a runId that fails RUN_ID_RE throws;
//   · the CLI refuses without a run id (exit 1, JSON ok:false on stdout) and
//     set/show work end-to-end through the env seams;
//   · with telemetry on, one supervisor.focus row lands in the events table
//     per change (distinct content-hash event ids, no source offset — two
//     racing changes both land, a replay of the same event is a no-op).
//
// Everything runs in mkdtemp dirs: LA_SUPERVISOR_STATE_HOME (library +
// supervisorStateHome), LA_DATA_HOME (supervisorCurrentRunPath →
// current-run.json) and LA_TELEMETRY_DB / LA_TELEMETRY_HOME (the store) are
// all pointed at temp dirs. The real .state, LOCALAPPDATA and the live
// telemetry store are never touched.
//
// Run: node --test scripts/supervisor-focus.test.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  focusPath,
  normalizeFocus,
  readFocus,
  setFocus,
} from "./supervisor-focus.mjs";
import { readCurrentRun, writeCurrentRun, RUN_ID_RE } from "./supervisor-current-run.mjs";
import { applyEvent, openTelemetryDb } from "./telemetry-store.mjs";

// The store's seams are pointed at a scratch dir up front and left set for the
// whole process: the unset state would resolve the live default telemetry DB
// path, so these env vars are never deleted here (static isolation audit,
// test-run.mjs). The store resolves them at call time, after imports.
const SEAM_HOME = mkdtempSync(join(tmpdir(), "la-sup-focus-seam-"));
process.env.LA_TELEMETRY_HOME = SEAM_HOME;
process.env.LA_TELEMETRY_DB = join(SEAM_HOME, "telemetry.sqlite");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "supervisor-focus.mjs");

const NOW = new Date("2026-10-12T12:00:00.000Z");
const VALID_ID = "2026-10-12T12-00-00-000-supervisor-26c7";
const OTHER_ID = "2026-10-12T11-00-00-000-supervisor-ffff";
// env LA_SUPERVISOR_NO_TELEMETRY=1 in every CLI/library child: no test may
// touch the real telemetry store, and the explicit seam keeps the library's
// own default from firing even where a caller forgets telemetry: false.
const NO_TELEMETRY = "LA_SUPERVISOR_NO_TELEMETRY";

function tempHome(label) {
  return mkdtempSync(join(tmpdir(), `la-sup-focus-${label}-`));
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const pointerPath = (home) => join(home, "supervisor", "current-run.json");

// ── normalizeFocus ───────────────────────────────────────────────────────────

test("normalizeFocus: ticket id uppercased", () => {
  assert.deepEqual(normalizeFocus("foc-12"), { kind: "ticket", taskId: "FOC-12" });
  assert.deepEqual(normalizeFocus(" FOC-123 "), { kind: "ticket", taskId: "FOC-123" });
  assert.deepEqual(normalizeFocus("abc-9"), { kind: "ticket", taskId: "ABC-9" });
});

test("normalizeFocus: overhead case-insensitive", () => {
  assert.deepEqual(normalizeFocus("overhead"), { kind: "overhead", taskId: null });
  assert.deepEqual(normalizeFocus("OVERHEAD"), { kind: "overhead", taskId: null });
  assert.deepEqual(normalizeFocus(" OverHead "), { kind: "overhead", taskId: null });
});

test("normalizeFocus: anything else throws", () => {
  for (const bad of ["", null, undefined, "FOC", "12", "FOC-12a", "overhead2", "-FOC-1", "FOC_12"]) {
    assert.throws(() => normalizeFocus(bad), /focus must be a ticket id like FOC-123 or 'overhead'/);
  }
});

// ── setFocus / readFocus ─────────────────────────────────────────────────────

// The live session's record, as supervisor-current-run already wrote it —
// setFocus annotates an EXISTING record (spec: write only when the record
// exists and its runId matches), it never creates the pointer.
function seedRecord(home, runId = VALID_ID) {
  writeCurrentRun(
    { runId, model: null, startedAt: NOW.toISOString(), source: "new", updatedAt: NOW.toISOString() },
    { path: pointerPath(home) },
  );
}

test("first set appends line 0 and the record points at the run", () => {
  const home = tempHome("first");
  try {
    seedRecord(home);
    const result = setFocus({
      runId: VALID_ID,
      value: "FOC-123",
      note: "kickoff",
      source: "manual",
      now: NOW,
      stateHome: home,
      currentRunPath: pointerPath(home),
      telemetry: false,
    });
    assert.deepEqual(
      { ok: result.ok, changed: result.changed, runId: result.runId, focus: result.focus, line: result.line },
      { ok: true, changed: true, runId: VALID_ID, focus: { kind: "ticket", taskId: "FOC-123" }, line: 0 },
    );
    const { current, history } = readFocus(VALID_ID, { stateHome: home });
    assert.equal(history.length, 1);
    assert.deepEqual(current, { at: NOW.toISOString(), kind: "ticket", taskId: "FOC-123", note: "kickoff", source: "manual" });

    const record = readCurrentRun({ path: pointerPath(home) });
    assert.equal(record.runId, VALID_ID);
    assert.deepEqual(record.focus, { kind: "ticket", taskId: "FOC-123", at: NOW.toISOString(), source: "manual" });
  } finally {
    cleanup(home);
  }
});

test("same focus again → changed false, nothing written", () => {
  const home = tempHome("same");
  try {
    seedRecord(home);
    const first = setFocus({
      runId: VALID_ID, value: "foc-7", now: NOW, stateHome: home, currentRunPath: pointerPath(home), telemetry: false,
    });
    const second = setFocus({
      runId: VALID_ID, value: "FOC-7", now: NOW, stateHome: home, currentRunPath: pointerPath(home), telemetry: false,
    });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.deepEqual(second.focus, { kind: "ticket", taskId: "FOC-7" });
    // "foc-7" and "FOC-7" are one focus — the same spelling may not buy two lines
    assert.equal(readFocus(VALID_ID, { stateHome: home }).history.length, 1);
    // the record is untouched by a no-op (same at as the first write)
    assert.equal(readCurrentRun({ path: pointerPath(home) }).focus.at, NOW.toISOString());
  } finally {
    cleanup(home);
  }
});

test("switch ticket → overhead → ticket appends 3 lines with sources", () => {
  const home = tempHome("switch");
  try {
    seedRecord(home);
    const t = (offset) => new Date(Date.parse(NOW) + offset * 60_000);
    const opts = (i) => ({
      runId: VALID_ID, now: t(i), stateHome: home, currentRunPath: pointerPath(home), telemetry: false,
    });
    assert.equal(setFocus({ ...opts(0), value: "FOC-1", source: "spawn" }).changed, true);
    assert.equal(setFocus({ ...opts(1), value: "overhead", source: "manual" }).changed, true);
    assert.equal(setFocus({ ...opts(2), value: "foc-1", source: "followup" }).changed, true);

    const { current, history } = readFocus(VALID_ID, { stateHome: home });
    assert.equal(history.length, 3);
    assert.deepEqual(
      history.map((h) => [h.kind, h.taskId, h.source]),
      [
        ["ticket", "FOC-1", "spawn"],
        ["overhead", null, "manual"],
        ["ticket", "FOC-1", "followup"],
      ],
    );
    assert.deepEqual(current, { at: t(2).toISOString(), kind: "ticket", taskId: "FOC-1", note: null, source: "followup" });
    // the record tracks the LAST change, not the first
    assert.deepEqual(readCurrentRun({ path: pointerPath(home) }).focus, {
      kind: "ticket", taskId: "FOC-1", at: t(2).toISOString(), source: "followup",
    });
  } finally {
    cleanup(home);
  }
});

test("current-run record gains focus only when its runId matches", () => {
  const home = tempHome("pointer");
  try {
    // a record for a DIFFERENT run (the stale-pointer case: the supervisor
    // restarted without recording this run)
    writeCurrentRun(
      { runId: OTHER_ID, startedAt: NOW.toISOString(), source: "new", updatedAt: NOW.toISOString() },
      { path: pointerPath(home) },
    );
    const result = setFocus({
      runId: VALID_ID, value: "FOC-1", now: NOW, stateHome: home, currentRunPath: pointerPath(home), telemetry: false,
    });
    assert.equal(result.changed, true);
    const record = readCurrentRun({ path: pointerPath(home) });
    assert.equal(record.runId, OTHER_ID);
    assert.equal(record.focus, undefined, "a stale pointer must not claim this run's focus");

    // and a MISSING record is not created by setFocus
    const home2 = tempHome("nopointer");
    try {
      setFocus({ runId: VALID_ID, value: "FOC-1", now: NOW, stateHome: home2, telemetry: false });
      assert.equal(readCurrentRun({ path: pointerPath(home2) }), null);
    } finally {
      cleanup(home2);
    }
  } finally {
    cleanup(home);
  }
});

test("invalid runId throws", () => {
  const home = tempHome("badrun");
  try {
    for (const bad of ["garbage", "FOC-123", ""]) {
      assert.throws(
        () => setFocus({ runId: bad, value: "FOC-1", stateHome: home, telemetry: false }),
        /invalid run id/,
      );
    }
    assert.equal(existsSync(focusPath(VALID_ID, { stateHome: home })), false);
  } finally {
    cleanup(home);
  }
});

test("invalid focus value throws and writes nothing", () => {
  const home = tempHome("badfocus");
  try {
    assert.throws(
      () => setFocus({ runId: VALID_ID, value: "no-ticket", stateHome: home, telemetry: false }),
      /focus must be a ticket id/,
    );
    assert.equal(existsSync(focusPath(VALID_ID, { stateHome: home })), false);
  } finally {
    cleanup(home);
  }
});

test("readFocus skips malformed lines and keeps the valid ones", () => {
  const home = tempHome("torn");
  try {
    const path = focusPath(VALID_ID, { stateHome: home });
    const good1 = JSON.stringify({ at: NOW.toISOString(), kind: "ticket", taskId: "FOC-1", note: null, source: "manual" });
    const good2 = JSON.stringify({ at: NOW.toISOString(), kind: "overhead", taskId: null, note: null, source: "manual" });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${good1}\n{torn\n${good2}\n`, "utf8");
    const { current, history } = readFocus(VALID_ID, { stateHome: home });
    assert.equal(history.length, 2);
    assert.equal(current.kind, "overhead");
  } finally {
    cleanup(home);
  }
});

// ── CLI ──────────────────────────────────────────────────────────────────────

function runCli(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LA_SUPERVISOR_STATE_HOME: env.stateHome,
      LA_DATA_HOME: env.dataHome,
      LA_SUPERVISOR_RUN: env.laRun ?? "",
      [NO_TELEMETRY]: "1",
    },
  });
}

test("CLI set without a run id → exit 1, JSON ok:false on stdout", () => {
  const stateHome = tempHome("cli-norun");
  const dataHome = tempHome("cli-nodata");
  try {
    const r = runCli(["set", "FOC-12"], { stateHome, dataHome });
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error, /no run id/);
  } finally {
    cleanup(stateHome);
    cleanup(dataHome);
  }
});

test("CLI set FOC-12 --run and show end-to-end through the env seams", () => {
  const stateHome = tempHome("cli-set");
  const dataHome = tempHome("cli-setdata");
  try {
    // the live session's record already exists (the CLI annotates, never creates)
    mkdirSync(join(dataHome, "supervisor"), { recursive: true });
    writeCurrentRun(
      { runId: VALID_ID, model: null, startedAt: NOW.toISOString(), source: "new", updatedAt: NOW.toISOString() },
      { path: pointerPath(dataHome) },
    );
    const env = { stateHome, dataHome };
    const set = runCli(["set", "foc-12", "--note", "slice S5a", "--run", VALID_ID], env);
    assert.equal(set.status, 0, set.stderr);
    const setResult = JSON.parse(set.stdout);
    assert.deepEqual(setResult, {
      ok: true, changed: true, runId: VALID_ID, focus: { kind: "ticket", taskId: "FOC-12" }, line: 0,
    });
    assert.match(set.stderr, /focus: FOC-12 \(was none\)/);

    // the record landed under the LA_DATA_HOME seam (supervisorCurrentRunPath)
    const record = JSON.parse(readFileSync(pointerPath(dataHome), "utf8"));
    assert.equal(record.runId, VALID_ID);
    assert.equal(record.focus.taskId, "FOC-12");

    const show = runCli(["show", "--run", VALID_ID], env);
    assert.equal(show.status, 0, show.stderr);
    const shown = JSON.parse(show.stdout);
    assert.equal(shown.ok, true);
    assert.equal(shown.runId, VALID_ID);
    assert.equal(shown.current.taskId, "FOC-12");
    assert.equal(shown.changes, 1);

    // LA_SUPERVISOR_RUN as the fallback (no --run)
    const viaEnv = runCli(["set", "overhead"], { ...env, laRun: VALID_ID });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.equal(JSON.parse(viaEnv.stdout).focus.kind, "overhead");
  } finally {
    cleanup(stateHome);
    cleanup(dataHome);
  }
});

test("CLI set with a malformed run id → exit 1, JSON ok:false", () => {
  const stateHome = tempHome("cli-badrun");
  const dataHome = tempHome("cli-baddata");
  try {
    const r = runCli(["set", "FOC-12", "--run", "garbage"], { stateHome, dataHome });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).ok, false);
    assert.match(JSON.parse(r.stdout).error, /invalid run id/);
  } finally {
    cleanup(stateHome);
    cleanup(dataHome);
  }
});

test("CLI unknown verb → usage on stderr, exit 2", () => {
  const stateHome = tempHome("cli-verb");
  const dataHome = tempHome("cli-verbdata");
  try {
    const r = runCli(["teleport"], { stateHome, dataHome });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage:/);
  } finally {
    cleanup(stateHome);
    cleanup(dataHome);
  }
});

// ── telemetry ────────────────────────────────────────────────────────────────

test("with telemetry on, two racing-style changes → two distinct events, replay a no-op", () => {
  const home = tempHome("telemetry");
  const dbPath = join(home, "telemetry", "telemetry.sqlite");
  try {
    // the store's own seams pointed at the temp home — emitEvent/openTelemetryDb
    // resolve LA_TELEMETRY_HOME / LA_TELEMETRY_DB at call time
    process.env.LA_TELEMETRY_DB = dbPath;
    process.env.LA_TELEMETRY_HOME = join(home, "telemetry");
    delete process.env[NO_TELEMETRY];

    const t = (offset) => new Date(Date.parse(NOW) + offset * 60_000);
    const first = setFocus({
      runId: VALID_ID, value: "FOC-1", now: t(0), stateHome: home, currentRunPath: pointerPath(home),
    });
    assert.equal(first.changed, true);
    assert.equal(first.line, 0); // informational only — not the event identity
    assert.equal(first.telemetryError, undefined);

    const second = setFocus({
      runId: VALID_ID, value: "overhead", now: t(1), stateHome: home, currentRunPath: pointerPath(home),
    });
    assert.equal(second.changed, true);
    assert.equal(second.line, 1);
    assert.equal(second.telemetryError, undefined);

    const db = openTelemetryDb(dbPath);
    try {
      const rows = db
        .prepare("SELECT event_id, source_path, source_offset, run_id, host_id, observed_at, payload_json FROM events WHERE event_type = 'supervisor.focus'")
        .all();
      // Two racing-style changes are TWO events: identity is the content
      // hash, so neither change is dropped by the source-identity dedup —
      // and there is no source offset to collide on at all.
      assert.equal(rows.length, 2);
      assert.notEqual(rows[0].event_id, rows[1].event_id);
      assert.equal(rows[0].source_offset, null);
      assert.equal(rows[1].source_offset, null);
      const ticketRow = rows.find((r) => JSON.parse(r.payload_json).kind === "ticket");
      const overheadRow = rows.find((r) => JSON.parse(r.payload_json).kind === "overhead");
      assert.ok(ticketRow && overheadRow, "one ticket change, one overhead change");
      assert.equal(ticketRow.run_id, VALID_ID);
      assert.match(ticketRow.source_path.replace(/\\/g, "/"), /focus\.jsonl$/);
      assert.equal(JSON.parse(ticketRow.payload_json).taskId, "FOC-1");

      // Both changes project: two run_focus intervals after applying.
      const focusRows = db
        .prepare("SELECT valid_from, kind, task_id FROM run_focus WHERE run_id=? ORDER BY valid_from")
        .all(VALID_ID);
      assert.equal(focusRows.length, 2);

      // Replaying the TICKET event (same eventId) is a no-op — no third
      // event, no third interval.
      const row = ticketRow;
      const replay = {
        eventId: row.event_id,
        eventType: "supervisor.focus",
        runId: row.run_id,
        observedAt: row.observed_at,
        hostId: row.host_id,
        source: { kind: "supervisor-focus", path: row.source_path, offset: row.source_offset },
        payload: JSON.parse(row.payload_json),
      };
      assert.equal(applyEvent(db, replay).duplicate, true);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'supervisor.focus'").get().n,
        2,
      );
    } finally {
      db.close();
    }
  } finally {
    // LA_TELEMETRY_DB / LA_TELEMETRY_HOME stay set (scratch dir from the top
    // of the file) — deleting them would put the live store in play.
    delete process.env[NO_TELEMETRY];
    cleanup(home);
  }
});

test("LA_SUPERVISOR_NO_TELEMETRY=1 suppresses the emit even with telemetry on", () => {
  const home = tempHome("notelemetry");
  try {
    process.env[NO_TELEMETRY] = "1";
    const result = setFocus({
      runId: VALID_ID, value: "FOC-2", now: NOW, stateHome: home, currentRunPath: pointerPath(home),
    });
    assert.equal(result.changed, true);
    assert.equal(result.telemetryError, undefined);
    assert.equal(existsSync(join(home, "telemetry")), false, "no telemetry home is created");
  } finally {
    delete process.env[NO_TELEMETRY];
    cleanup(home);
  }
});

// RUN_ID_RE is re-exported through the pair this file tests together — keep the
// import honest so a dropped export fails here and not only in S5b.
test("RUN_ID_RE accepts the documented supervisor run id shape", () => {
  assert.match(VALID_ID, RUN_ID_RE);
  assert.doesNotMatch("FOC-12", RUN_ID_RE);
});
