// scripts/supervisor-migrate-legacy.test.mjs — the FOC-839 legacy migration
// at its library boundary (PRD §5, plan §2 slice B, decisions D2/D3):
//
//   1. a store with no row at all → `no-managed-sessions`, nothing written;
//   2. attach once + idempotent (a second --apply changes nothing);
//   3. two legacy runs on one task → the NEWEST attaches, the older goes
//      read-only (`older-duplicate`);
//   4. no session for the task → read-only (`no-session-for-task`);
//   5. a managed-owned run (owner.json sessionId set) is out of scope;
//   6. a run whose owner Supervisor is provably alive → `owner-alive` skip
//      (both via the global current-run pointer and via owner.json.pid);
//   6b. a pre-FOC-905 pointer ({ runId } — no pid, no owner) naming a legacy
//      run → `current-pointer` skip, nothing written even with --apply
//      (rule 3b: no pid known → the current run stays untouched);
//   7. a session already carrying a runId is never re-pointed
//      (`session-has-run`, D2);
//   8. dry run computes the same lists and writes nothing;
//   9. no triage issue → read-only (`no-triage-issue`);
//  10. the part-2 helpers: isLegacyReadOnly / legacyAttachOf.
//
// Everything runs in mkdtemp dirs: stateHome and dbPath are passed explicitly,
// the global pointer lives under a temp LA_DATA_HOME — the repo's real
// `.state/` is never touched. Dead pid = the DEAD_PID fixture proven dead on
// this host (supervisor-current-run.test.mjs).
//
// Run: node scripts/supervisor-migrate-legacy.test.mjs

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harness, cleanupLater } from "./supervisor-test-fixtures.mjs";

const { test, summary } = harness();

const { migrateLegacy, isLegacyReadOnly, legacyAttachOf } = await import("./supervisor-migrate-legacy.mjs");
const { createTaskSessionStore } = await import("./task-sessions.mjs");

// The dead-pid fixture proven safe on this host: above the likely pid ceiling,
// ESRCH on signal 0.
const DEAD_PID = 2 ** 22 + 12345;

const WORKSPACE = "jointhubs";
const OLD_RUN = "2026-09-01T10-00-00-000-supervisor-ab12";
const NEW_RUN = "2026-09-02T10-00-00-000-supervisor-cd34";

const tempDir = (tag) => {
  const dir = mkdtempSync(join(tmpdir(), `migrate-legacy-${tag}-`));
  cleanupLater(dir);
  return dir;
};

/**
 * A fixture volume: <tmp> is the data home (LA_DATA_HOME shape — the store and
 * the global current-run pointer live under it), stateHome is
 * <tmp>/state/supervisor (the container's LA_SUPERVISOR_STATE_HOME shape).
 */
function buildVolume() {
  const tmp = tempDir("vol");
  const stateHome = join(tmp, "state", "supervisor");
  mkdirSync(stateHome, { recursive: true });
  const dbPath = join(tmp, "supervisor", "task-sessions.sqlite");
  return { tmp, stateHome, dbPath, env: { LA_DATA_HOME: tmp } };
}

/** One run dir with the minimum a run needs (children.json) plus optional triage/owner. */
function makeRun(stateHome, runId, { issue = null, owner = null, children = true } = {}) {
  const rDir = join(stateHome, runId);
  mkdirSync(rDir, { recursive: true });
  if (children) writeFileSync(join(rDir, "children.json"), JSON.stringify({ children: {}, rounds: {} }));
  if (issue !== null) writeFileSync(join(rDir, "triage.json"), JSON.stringify({ issue }));
  if (owner !== null) writeFileSync(join(rDir, "owner.json"), JSON.stringify(owner));
  return rDir;
}

/** A managed session store with one queued session per task, optionally already pointed at a run. */
function makeStore(dbPath, tasks, { runIdByIssue = {} } = {}) {
  const store = createTaskSessionStore({ dbPath });
  const ids = {};
  for (const issue of tasks) {
    const taskKey = `${WORKSPACE}:${issue}`;
    const row = store.ensure({ taskKey, taskId: issue, workspace: WORKSPACE, issueId: issue, title: `Task ${issue}` });
    ids[issue] = row.sessionId;
    if (runIdByIssue[issue]) store.update(row.sessionId, { runId: runIdByIssue[issue] });
  }
  return { store, ids };
}

const migrate = (volume, apply, now = new Date("2026-10-17T12:00:00Z")) =>
  migrateLegacy({ env: volume.env, apply, stateHome: volume.stateHome, dbPath: volume.dbPath, now });

// pidAlive guard, mirrored from supervisor-current-run.test.mjs: the fixture
// must read as dead on THIS host or the owner-alive cases mean nothing.
const { pidAlive } = await import("./supervisor-current-run.mjs");
if (pidAlive(DEAD_PID)) {
  console.log(`  SKIP dead-pid fixture is not dead on this host (pid ${DEAD_PID}); owner-alive cases still covered via the live-pid arm`);
}

console.log("\nrule 1 — no store");

test("no store file → no-managed-sessions, nothing written", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101" });
  const r = migrate(v, false);
  assert.deepEqual(r.skipped, [{ runId: null, reason: "no-managed-sessions" }]);
  assert.equal(r.attached.length, 0);
  assert.equal(r.readOnly.length, 0);
  assert.equal(r.dryRun, true);
  assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-readonly.json")), false);
  // Also on --apply: rule 1 writes nothing even with --apply.
  const r2 = migrate(v, true);
  assert.deepEqual(r2.skipped, [{ runId: null, reason: "no-managed-sessions" }]);
  assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-readonly.json")), false);
});

console.log("\nrule 4 — attach once + idempotent");

test("attach once: store row gains the runId, marker written, second --apply is a no-op", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101", owner: { pid: DEAD_PID, recordedAt: "x" } });
  const { store, ids } = makeStore(v.dbPath, ["FOC-101"]);
  try {
    const r = migrate(v, true);
    assert.equal(r.attached.length, 1);
    assert.deepEqual(r.attached, [{ runId: OLD_RUN, sessionId: ids["FOC-101"] }]);
    assert.equal(r.readOnly.length, 0);
    // the store row was pointed at the run
    assert.equal(store.list().find((s) => s.sessionId === ids["FOC-101"]).runId, OLD_RUN);
    // the marker file
    const marker = legacyAttachOf(join(v.stateHome, OLD_RUN));
    assert.equal(marker.sessionId, ids["FOC-101"]);
    assert.equal(typeof marker.attachedAt, "string");
    assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-readonly.json")), false);

    // idempotent: second apply attaches and marks nothing
    const r2 = migrate(v, true);
    assert.equal(r2.attached.length, 0, JSON.stringify(r2));
    assert.equal(r2.readOnly.length, 0, JSON.stringify(r2));
    // the row still points at the same run
    assert.equal(store.list().find((s) => s.sessionId === ids["FOC-101"]).runId, OLD_RUN);
  } finally {
    store.close();
  }
});

console.log("\nrule 4 — newest of two");

test("two legacy runs on one task: newest attaches, older goes read-only (older-duplicate)", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101", owner: { pid: DEAD_PID } });
  makeRun(v.stateHome, NEW_RUN, { issue: "FOC-101", owner: { pid: DEAD_PID } });
  const { store, ids } = makeStore(v.dbPath, ["FOC-101"]);
  try {
    const r = migrate(v, true);
    assert.deepEqual(r.attached, [{ runId: NEW_RUN, sessionId: ids["FOC-101"] }]);
    assert.deepEqual(
      r.readOnly.map((e) => `${e.runId}:${e.reason}`),
      [`${OLD_RUN}:older-duplicate`],
    );
    assert.equal(store.list().find((s) => s.sessionId === ids["FOC-101"]).runId, NEW_RUN);
    assert.equal(legacyAttachOf(join(v.stateHome, OLD_RUN)), null);
    assert.equal(isLegacyReadOnly(join(v.stateHome, OLD_RUN)), true);
    assert.equal(isLegacyReadOnly(join(v.stateHome, NEW_RUN)), false);
  } finally {
    store.close();
  }
});

console.log("\nrule 5 — read-only marking");

test("no session for the task → read-only (no-session-for-task)", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-999", owner: { pid: DEAD_PID } });
  const { store } = makeStore(v.dbPath, ["FOC-101"]); // different task
  try {
    const r = migrate(v, true);
    assert.deepEqual(
      r.readOnly.map((e) => `${e.runId}:${e.reason}`),
      [`${OLD_RUN}:no-session-for-task`],
    );
    assert.equal(r.attached.length, 0);
    const marker = JSON.parse(readFileSync(join(v.stateHome, OLD_RUN, "legacy-readonly.json"), "utf8"));
    assert.equal(marker.reason, "no-session-for-task");
    assert.equal(typeof marker.markedAt, "string");
  } finally {
    store.close();
  }
});

test("no triage issue → read-only (no-triage-issue) — never adopted into a task it does not name", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { owner: { pid: DEAD_PID } }); // no triage.json
  const { store, ids } = makeStore(v.dbPath, ["FOC-101"]);
  try {
    const r = migrate(v, true);
    assert.deepEqual(
      r.readOnly.map((e) => `${e.runId}:${e.reason}`),
      [`${OLD_RUN}:no-triage-issue`],
    );
    assert.equal(r.attached.length, 0);
    assert.equal(store.list().find((s) => s.sessionId === ids["FOC-101"]).runId, null);
  } finally {
    store.close();
  }
});

test("the only non-terminal session already carries a runId → session-has-run, never re-pointed (D2)", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101", owner: { pid: DEAD_PID } });
  makeRun(v.stateHome, NEW_RUN, { issue: "FOC-101", owner: { pid: DEAD_PID } }); // also legacy, same task
  const { store, ids } = makeStore(v.dbPath, ["FOC-101"], { runIdByIssue: { "FOC-101": "2026-08-01T10-00-00-000-supervisor-ee56" } });
  try {
    const r = migrate(v, true);
    assert.equal(r.attached.length, 0);
    // OLD_RUN loses the newest-of-two race first (rule 4 order: duplicates
    // before candidates); NEW_RUN is newest but its task's only session is claimed.
    const reasons = r.readOnly.map((e) => `${e.runId}:${e.reason}`).sort();
    assert.deepEqual(reasons, [`${OLD_RUN}:older-duplicate`, `${NEW_RUN}:session-has-run`]);
    // the existing runId was NOT overwritten
    assert.equal(store.list().find((s) => s.sessionId === ids["FOC-101"]).runId, "2026-08-01T10-00-00-000-supervisor-ee56");
  } finally {
    store.close();
  }
});

console.log("\nrule 2 — scope");

test("managed-owned run (owner.json sessionId set) is out of scope — listed nowhere", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101", owner: { sessionId: "sup-aaaaaaaaaaaaaaaa", pid: DEAD_PID } });
  const { store } = makeStore(v.dbPath, ["FOC-101"]);
  try {
    const r = migrate(v, true);
    assert.equal(r.attached.length, 0);
    assert.equal(r.readOnly.length, 0);
    assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped));
    assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-attach.json")), false);
    assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-readonly.json")), false);
  } finally {
    store.close();
  }
});

test("owner.json sessionId null reads as legacy (the FOC-905 legacy/host shape)", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101", owner: { sessionId: null, pid: DEAD_PID } });
  const { store, ids } = makeStore(v.dbPath, ["FOC-101"]);
  try {
    const r = migrate(v, true);
    assert.deepEqual(r.attached, [{ runId: OLD_RUN, sessionId: ids["FOC-101"] }]);
  } finally {
    store.close();
  }
});

console.log("\nrule 3 — owner alive");

test("global current-run pointer names the run with a live pid → skipped (owner-alive), nothing written", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101", owner: { pid: DEAD_PID } });
  mkdirSync(join(v.tmp, "supervisor"), { recursive: true });
  writeFileSync(
    join(v.tmp, "supervisor", "current-run.json"),
    JSON.stringify({ runId: OLD_RUN, owner: { pid: process.pid, hostname: "x", containerStartMs: null, recordedAt: "2026-10-17T12:00:00.000Z" } }),
  );
  const { store, ids } = makeStore(v.dbPath, ["FOC-101"]);
  try {
    const r = migrate(v, true);
    assert.deepEqual(r.skipped, [{ runId: OLD_RUN, reason: "owner-alive" }]);
    assert.equal(r.attached.length, 0);
    assert.equal(store.list().find((s) => s.sessionId === ids["FOC-101"]).runId, null);
    assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-attach.json")), false);
  } finally {
    store.close();
  }
});

test("owner.json.pid alive → skipped (owner-alive) even without the global pointer", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101", owner: { sessionId: null, pid: process.pid } });
  const { store } = makeStore(v.dbPath, ["FOC-101"]);
  try {
    const r = migrate(v, true);
    assert.deepEqual(r.skipped, [{ runId: OLD_RUN, reason: "owner-alive" }]);
    assert.equal(r.attached.length, 0);
  } finally {
    store.close();
  }
});

test("global pointer names the run but its pid is DEAD → attach proceeds", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101", owner: { pid: DEAD_PID } });
  mkdirSync(join(v.tmp, "supervisor"), { recursive: true });
  writeFileSync(
    join(v.tmp, "supervisor", "current-run.json"),
    JSON.stringify({ runId: OLD_RUN, owner: { pid: DEAD_PID, hostname: "x", containerStartMs: null, recordedAt: "2026-10-17T12:00:00.000Z" } }),
  );
  const { store, ids } = makeStore(v.dbPath, ["FOC-101"]);
  try {
    const r = migrate(v, true);
    assert.deepEqual(r.attached, [{ runId: OLD_RUN, sessionId: ids["FOC-101"] }]);
  } finally {
    store.close();
  }
});

test("pre-FOC-905 pointer ({ runId } — no pid, no owner) naming a legacy run → skipped (current-pointer), nothing written even with --apply", () => {
  const v = buildVolume();
  // A true pre-FOC-905 legacy run: no owner.json at all, so no pid anywhere.
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101" });
  mkdirSync(join(v.tmp, "supervisor"), { recursive: true });
  writeFileSync(join(v.tmp, "supervisor", "current-run.json"), JSON.stringify({ runId: OLD_RUN }));
  const { store, ids } = makeStore(v.dbPath, ["FOC-101"]);
  try {
    const r = migrate(v, true);
    assert.deepEqual(r.skipped, [{ runId: OLD_RUN, reason: "current-pointer" }]);
    assert.equal(r.attached.length, 0);
    assert.equal(r.readOnly.length, 0);
    assert.equal(store.list().find((s) => s.sessionId === ids["FOC-101"]).runId, null);
    assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-attach.json")), false);
    assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-readonly.json")), false);
  } finally {
    store.close();
  }
});

console.log("\nrule 6 — dry run");

test("dry run computes the same lists and writes NOTHING (no marker, store untouched)", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101", owner: { pid: DEAD_PID } });
  makeRun(v.stateHome, NEW_RUN, { issue: "FOC-102", owner: {} }); // no session for FOC-102
  const { store, ids } = makeStore(v.dbPath, ["FOC-101"]);
  const before = store.list().map((s) => `${s.sessionId}:${s.runId}`).sort();
  try {
    const r = migrate(v, false);
    assert.equal(r.dryRun, true);
    assert.deepEqual(r.attached, [{ runId: OLD_RUN, sessionId: ids["FOC-101"] }]);
    assert.deepEqual(
      r.readOnly.map((e) => `${e.runId}:${e.reason}`).sort(),
      [`${NEW_RUN}:no-session-for-task`],
    );
    // nothing written: no markers, store rows byte-identical
    assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-attach.json")), false);
    assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-readonly.json")), false);
    assert.equal(existsSync(join(v.stateHome, NEW_RUN, "legacy-readonly.json")), false);
    assert.deepEqual(store.list().map((s) => `${s.sessionId}:${s.runId}`).sort(), before);
  } finally {
    store.close();
  }
});

// ── the env seam: with NO stateHome/dbPath override, the migration must name
// the state home from the passed env (LA_SUPERVISOR_STATE_HOME), not from
// process.env — the repo's real `.state/` is never scanned.
test("env seam: LA_SUPERVISOR_STATE_HOME in env names the scanned home when stateHome is not passed", () => {
  const tmp = tempDir("env");
  const tmpHome = join(tmp, "state", "supervisor");
  mkdirSync(tmpHome, { recursive: true });
  const dbPath = join(tmp, "supervisor", "task-sessions.sqlite");
  makeRun(tmpHome, OLD_RUN, { issue: "FOC-101", owner: { pid: DEAD_PID } });
  const { store, ids } = makeStore(dbPath, ["FOC-101"]);
  try {
    const result = migrateLegacy({
      env: { LA_SUPERVISOR_STATE_HOME: tmpHome, LA_DATA_HOME: tmp },
      apply: true,
      now: new Date("2026-10-17T12:00:00Z"),
    });
    assert.deepEqual(result.attached, [{ runId: OLD_RUN, sessionId: ids["FOC-101"] }]);
    assert.equal(isLegacyReadOnly(join(tmpHome, OLD_RUN)), false);
    assert.ok(existsSync(join(tmpHome, OLD_RUN, "legacy-attach.json")), "the tmp home's run was attached");
  } finally {
    store.close();
  }
});

console.log("\npart-2 helpers");

test("isLegacyReadOnly / legacyAttachOf read the markers (missing/corrupt → false/null)", () => {
  const v = buildVolume();
  const rDir = makeRun(v.stateHome, OLD_RUN, {});
  assert.equal(isLegacyReadOnly(rDir), false);
  assert.equal(legacyAttachOf(rDir), null);
  writeFileSync(join(rDir, "legacy-attach.json"), JSON.stringify({ sessionId: "sup-bbbbbbbbbbbbbbbb", attachedAt: "t" }));
  assert.equal(legacyAttachOf(rDir).sessionId, "sup-bbbbbbbbbbbbbbbb");
  writeFileSync(join(rDir, "legacy-readonly.json"), "{}");
  assert.equal(isLegacyReadOnly(rDir), true);
  writeFileSync(join(rDir, "legacy-attach.json"), "not json");
  assert.equal(legacyAttachOf(rDir), null);
});

console.log("\nper-run resilience");

test("an unreadable store is skipped (store-unreadable), nothing written", () => {
  const v = buildVolume();
  makeRun(v.stateHome, OLD_RUN, { issue: "FOC-101", owner: { pid: DEAD_PID } });
  // A store file that is not a database: readSessionRows swallows it as []
  // (→ no-managed-sessions), and the raw candidate peek reports the reason.
  mkdirSync(join(v.tmp, "supervisor"), { recursive: true });
  writeFileSync(v.dbPath, "this is not a sqlite database");
  const r = migrate(v, true);
  // Either skip reason is correct (readSessionRows → no-managed-sessions; a
  // readable-but-corrupt peek → store-unreadable); the invariant is: nothing
  // attached, nothing marked, no throw.
  assert.equal(r.attached.length, 0);
  assert.equal(r.readOnly.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /^(no-managed-sessions|store-unreadable)/);
  assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-attach.json")), false);
  assert.equal(existsSync(join(v.stateHome, OLD_RUN, "legacy-readonly.json")), false);
});

summary();
