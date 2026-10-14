// scripts/supervisor-host-client.test.mjs — the host client's session-scoped
// helpers (task-workspace plan P1c). Pins the contracts the scoped routes rely
// on: hostSessionPath composes /sessions/<sid> paths ONLY for ids matching the
// strict pattern (anything else throws — never compose a path from unvalidated
// data), sessionScopedEnv returns a COPY with the session id set (global
// process.env is never mutated), and redactSessionRecord passes exactly the
// safe record fields through and drops everything else.
//
// Run: node --test scripts/supervisor-host-client.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hostSessionPath,
  hostBase,
  sessionScopedEnv,
  redactSessionRecord,
} from "./supervisor-host-client.mjs";

test("hostSessionPath: valid ids compose /sessions/<sid> with the suffix", () => {
  assert.equal(hostSessionPath(`sup-${"a".repeat(16)}`), `/sessions/sup-${"a".repeat(16)}`);
  assert.equal(hostSessionPath(`sup-${"a".repeat(32)}`, "/state"), `/sessions/sup-${"a".repeat(32)}/state`);
  assert.equal(hostSessionPath(`sup-${"b".repeat(16)}`, "/terminal"), `/sessions/sup-${"b".repeat(16)}/terminal`);
  // Suffix is optional and defaults to "" — the session root itself.
  assert.equal(hostSessionPath(`sup-${"c".repeat(16)}`), `/sessions/sup-${"c".repeat(16)}`);
});

test("hostSessionPath: malformed ids throw, never compose a path", () => {
  for (const bad of [
    "",
    "sup-",
    "sup-nothex",
    "sup-ABCDEF0123456789", // uppercase — the pattern is lowercase-only
    `sup-${"a".repeat(15)}`, // below the 16-hex floor
    `sup-${"a".repeat(33)}`, // above the 32-hex ceiling
    "task-1",
    "../etc/passwd",
    `sup-${"a".repeat(16)}/message`, // a suffix inside the id — path traversal shape
    null,
    42,
  ]) {
    assert.throws(() => hostSessionPath(bad), /sessionId must match/, `hostSessionPath(${JSON.stringify(bad)}) must throw`);
  }
});

test("sessionScopedEnv: returns a COPY with FENIX_SUPERVISOR_SESSION_ID set", () => {
  const base = { LA_DATA_HOME: "/tmp/x", OTHER: "1" };
  const scoped = sessionScopedEnv(base, `sup-${"d".repeat(16)}`);
  assert.equal(scoped.FENIX_SUPERVISOR_SESSION_ID, `sup-${"d".repeat(16)}`);
  assert.equal(scoped.LA_DATA_HOME, "/tmp/x");
  assert.equal(scoped.OTHER, "1");
  // The copy, not the original: the caller's env object is untouched.
  assert.equal(base.FENIX_SUPERVISOR_SESSION_ID, undefined);
  assert.notEqual(scoped, base);
});

test("sessionScopedEnv: does NOT mutate process.env and validates the id", () => {
  // process.env is a live object — a naive implementation that spread it and
  // mutated the spread still leaks; a naive one that assigns directly is worse.
  // The contract is: process.env never gains the key, even after a call.
  const before = process.env.FENIX_SUPERVISOR_SESSION_ID;
  const scoped = sessionScopedEnv(process.env, `sup-${"e".repeat(16)}`);
  assert.equal(scoped.FENIX_SUPERVISOR_SESSION_ID, `sup-${"e".repeat(16)}`);
  assert.equal(process.env.FENIX_SUPERVISOR_SESSION_ID, before ?? undefined);
  for (const bad of ["", "sup-", "not-a-session", null, undefined, 7]) {
    assert.throws(() => sessionScopedEnv(process.env, bad), /sessionId must match/, `sessionScopedEnv(${JSON.stringify(bad)}) must throw`);
  }
});

test("redactSessionRecord: exactly the safe fields, nothing else", () => {
  const record = {
    sessionId: `sup-${"f".repeat(16)}`,
    taskKey: "jointhubs:FOC-1",
    taskId: "FOC-1",
    workspace: "jointhubs",
    issueId: "FOC-1",
    title: "Do it",
    status: "running",
    runId: "2026-10-14T10-00-00-000-supervisor-abcd",
    pid: 4242,
    processStartedAt: "2026-10-14T10:00:01.000Z",
    createdAt: "2026-10-14T09:59:00.000Z",
    updatedAt: "2026-10-14T10:00:00.000Z",
    lastError: null,
    secret: "drop me", // host-only fields must never pass through
    internalPath: "/data/supervisor/sessions/sup-…",
  };
  const out = redactSessionRecord(record);
  assert.deepEqual(
    Object.keys(out).sort(),
    [
      "createdAt", "issueId", "lastError", "pid", "processStartedAt", "runId",
      "sessionId", "status", "taskId", "taskKey", "title", "updatedAt", "workspace",
    ].sort(),
  );
  assert.equal(out.taskKey, "jointhubs:FOC-1");
  assert.equal(out.pid, 4242);
  assert.equal("secret" in out, false);
  assert.equal("internalPath" in out, false);
});

test("redactSessionRecord: absent fields stay absent, non-objects read as null", () => {
  const partial = redactSessionRecord({ sessionId: `sup-${"1".repeat(16)}`, status: "queued" });
  assert.deepEqual(partial, { sessionId: `sup-${"1".repeat(16)}`, status: "queued" });
  // null/undefined, primitives and arrays are "no record" → null. A plain
  // object IS shaped like a record — it just carries no safe fields, so the
  // whitelist yields the empty object (never an invented null).
  assert.equal(redactSessionRecord(null), null);
  assert.equal(redactSessionRecord(undefined), null);
  assert.equal(redactSessionRecord("text"), null);
  assert.equal(redactSessionRecord(42), null);
  assert.equal(redactSessionRecord([]), null);
  assert.deepEqual(redactSessionRecord({ length: 1 }), {});
});

test("hostBase: trimmed value or null — unchanged contract", () => {
  assert.equal(hostBase({ FENIX_SUPERVISOR_HOST: " http://h:7332 " }), "http://h:7332");
  assert.equal(hostBase({}), null);
  assert.equal(hostBase({ FENIX_SUPERVISOR_HOST: "   " }), null);
});
