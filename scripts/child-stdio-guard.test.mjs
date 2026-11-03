// scripts/child-stdio-guard.test.mjs — FOC-1207: an uncaught child-stdio
// socket error must not kill the telemetry server, and every OTHER uncaught
// error must still exit non-zero.
//
// Spawns the REAL telemetry-server (spawnTestServer, FOC-840) twice:
//   - LA_UNCAUGHT_CHILD_STDIO_TEST=match   → a synthetic error with the exact
//     child-stdio shape (read syscall, ENOTCONN, stack through
//     node:internal/child_process) is thrown after listen; the server must
//     answer GET /api/telemetry/health afterwards and log one guard line.
//   - LA_UNCAUGHT_CHILD_STDIO_TEST=foreign → an error that FAILS the guard's
//     predicate (no child_process frame in the stack) must still take the
//     process down non-zero — the guard is not a blanket swallow.
//
// The hook's synthetic throw exercises the same uncaughtException path a real
// stdio socket error takes; the real win32 race cannot be reproduced on demand.
//
// Serial lane: it spawns the server on a real port.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnTestServer } from "./test-spawn.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dir, "telemetry-server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  return fn()
    .then(() => { passed++; console.log(`  PASS ${name}`); })
    .catch((error) => { failed++; failures.push(`${name}: ${error.message}`); console.log(`  FAIL ${name}: ${error.message}`); });
}

/** Resolves with the child's exit code, or null if it is still alive past the deadline. */
async function exitCodeWithin(child, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return child.exitCode ?? child.signalCode;
    await sleep(100);
  }
  return null;
}

/** Isolated telemetry home/db/state-root for one server spawn, plus the hook env. */
function spawnEnv(kind, delayMs) {
  const dir = mkdtempSync(join(tmpdir(), `stdio-guard-${kind}-`));
  const home = join(dir, "telemetry-home");
  mkdirSync(join(home, "spool", "pending"), { recursive: true });
  mkdirSync(join(dir, "state-root"), { recursive: true });
  return {
    dir,
    env: {
      NODE_ENV: "test",
      LA_UNCAUGHT_CHILD_STDIO_TEST: `${kind}:${delayMs}`,
      LA_TELEMETRY_DB: join(dir, "telemetry.sqlite"),
      LA_TELEMETRY_HOME: home,
      LA_STATE_ROOT: join(dir, "state-root"),
    },
  };
}

// ── case 1: the matching child-stdio error keeps the server serving ──────────
await test("FOC-1207: a child-stdio socket error keeps the server serving", async () => {
  const { dir, env } = spawnEnv("match", 1500);
  let server = null;
  try {
    server = await spawnTestServer({ script: SERVER_SCRIPT, env, label: "stdio-guard-match" });
    const url = `http://127.0.0.1:${server.port}/api/telemetry/health`;
    const before = await fetch(url);
    assert.equal(before.status, 200, "health must answer before the synthetic error");
    // Wait past the hook's listen+1500 ms throw.
    await sleep(2500);
    assert.equal(server.child.exitCode, null, "the server process must still be alive");
    const after = await fetch(url);
    assert.equal(after.status, 200, "health must answer after the swallowed error");
    assert(server.child.stderrBuf.includes("ignored a child-stdio socket error"),
      `guard log line missing; stderr tail: ${server.child.stderrBuf.slice(-400)}`);
  } finally {
    await server?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 2: a foreign uncaught error still exits non-zero ────────────────────
await test("FOC-1207: a foreign uncaught error still exits non-zero", async () => {
  const { dir, env } = spawnEnv("foreign", 1200);
  let server = null;
  try {
    try {
      server = await spawnTestServer({ script: SERVER_SCRIPT, env, label: "stdio-guard-foreign" });
    } catch (err) {
      // A slow boot can lose the race against the hook's throw — spawnTestServer
      // then reports the early exit itself; that IS the expected outcome, as
      // long as the exit was non-zero.
      if (/exited early \((?!0\))/.test(String(err?.message))) return;
      throw err;
    }
    const code = await exitCodeWithin(server.child, 10_000);
    assert.notEqual(code, null, "the server must exit after a non-matching uncaught error");
    assert.notEqual(code, 0, `the exit code must be non-zero, got ${code}`);
    assert(!server.child.stderrBuf.includes("ignored a child-stdio socket error"),
      "the guard must not swallow a non-matching error");
  } finally {
    await server?.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(failures.join("\n"));
process.exit(failed ? 1 : 0);
