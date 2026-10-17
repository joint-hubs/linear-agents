#!/usr/bin/env node
// scripts/test-spawn.test.mjs — tests for scripts/test-spawn.mjs (FOC-840).
//
// Proves the spawn helper end to end: spawn a real node HTTP server child on
// an ephemeral probed port, health-poll it, verify the registry row, and that
// stop() tree-kills it (probed dead) and removes the row; that a health
// timeout rejects with the stderr tail and leaves the child dead; and the
// shape of probePid. The runner-level orphan sweep itself is covered by
// test-run.test.mjs.
//
// Lane: serial, on purpose. This file spawns a real server child that binds a
// loopback port (through the helper it tests) — exactly what the parallel-lane
// static audit rightly refuses.
//
// Run: node scripts/test-spawn.test.mjs

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { spawnTestServer, probePid, registryRows, openRegistryRows } from "./test-spawn.mjs";

// The fake server under test: answers 200 on any path, listens on the port the
// helper passes via TELEMETRY_PORT. The body reports the canary env key so the
// inheritEnv test can prove what the child actually saw.
const FAKE_SERVER_SRC = `import http from "node:http";
http.createServer((req, res) => {
  res.statusCode = 200;
  res.end(JSON.stringify({ canary: process.env.LA_TEST_SPAWN_CANARY ?? null }));
})
  .listen(Number(process.env.TELEMETRY_PORT), "127.0.0.1");
`;

// Alive but never serves anything: the health deadline must fire against it.
const DEAF_SERVER_SRC = "setTimeout(() => {}, 60000);\n";

let passed = 0;
const failures = [];

const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(
      () => {
        passed++;
        console.log(`  PASS ${name}`);
      },
      (err) => {
        failures.push(name);
        console.log(`  FAIL ${name}\n       ${err.message}`);
      },
    );

const fail = (msg) => { throw new Error(msg); };

const pollUntil = async (check, capMs = 5000) => {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};

const withRegistry = (dir) => {
  const prev = process.env.LA_TEST_SPAWN_REGISTRY;
  process.env.LA_TEST_SPAWN_REGISTRY = join(dir, "spawns.jsonl");
  return () => {
    if (prev === undefined) delete process.env.LA_TEST_SPAWN_REGISTRY;
    else process.env.LA_TEST_SPAWN_REGISTRY = prev;
  };
};

const writeServer = (dir, src, name = "server.mjs") => {
  const p = join(dir, name);
  writeFileSync(p, src, "utf8");
  return p;
};

const tmp = (tag) => mkdtempSync(join(tmpdir(), `test-spawn-${tag}-`));

await test("spawn → health answers → registry row; stop() kills and removes the row", async () => {
  const dir = tmp("ok");
  const restore = withRegistry(dir);
  try {
    const serverPath = writeServer(dir, FAKE_SERVER_SRC);
    const { child, port, stop } = await spawnTestServer({ script: serverPath, label: "ok-case" });
    const res = await fetch(`http://127.0.0.1:${port}/api/telemetry/health`);
    if (!res.ok) fail(`the spawned server answered ${res.status}`);
    const rows = registryRows(process.env.LA_TEST_SPAWN_REGISTRY);
    if (rows.length !== 1) fail(`expected exactly 1 registry row, got ${rows.length}`);
    if (rows[0].pid !== child.pid) fail("registry row pid mismatch");
    if (rows[0].port !== port) fail("registry row port mismatch");
    if (rows[0].script !== serverPath) fail("registry row script mismatch");
    if (rows[0].label !== "ok-case") fail("registry row label mismatch");
    if (rows[0].file !== process.argv[1]) fail("registry row file is not the caller test file");
    if (typeof rows[0].startedAt !== "string") fail("registry row has no startedAt");
    await stop();
    if (!(await pollUntil(() => !probePid(child.pid)))) fail("stop() left the server alive");
    // The registry is append-only: stop() appends a tombstone next to the
    // spawn row; the folded view no longer lists the pid.
    const rawRows = registryRows(process.env.LA_TEST_SPAWN_REGISTRY);
    if (rawRows.length !== 2) fail(`expected the spawn row and a tombstone after stop(), got ${rawRows.length} rows`);
    if (!rawRows.some((row) => row.pid === child.pid && row.stoppedAt)) {
      fail("stop() did not append a tombstone for the child");
    }
    if (openRegistryRows(process.env.LA_TEST_SPAWN_REGISTRY).length !== 0) {
      fail("openRegistryRows still lists the stopped pid");
    }
  } finally {
    restore();
  }
});

await test("health timeout rejects with the stderr tail and the child is dead", async () => {
  const dir = tmp("timeout");
  const restore = withRegistry(dir);
  try {
    const serverPath = writeServer(dir, DEAF_SERVER_SRC, "deaf.mjs");
    // Grab the registry row the helper writes mid-spawn so the child's pid can
    // be probed dead after the rejection (the row itself is removed on timeout).
    let row = null;
    const spawning = spawnTestServer({ script: serverPath, timeoutMs: 400, label: "deaf-case" });
    const t0 = Date.now();
    const watcher = (async () => {
      while (!row && Date.now() - t0 < 10000) {
        row = registryRows(process.env.LA_TEST_SPAWN_REGISTRY)[0] || null;
        if (!row) await new Promise((r) => setTimeout(r, 25));
      }
    })();
    const err = await spawning.then(() => null, (e) => e);
    await watcher;
    if (!row) fail("the helper never appended its registry row");
    if (!err) fail("a server that never serves must make spawnTestServer reject");
    if (!err.message.includes("not ready in 400ms")) fail(`wrong timeout message:\n${err.message}`);
    if (!(await pollUntil(() => !probePid(row.pid)))) {
      fail("the timed-out server was left running");
    }
    if (openRegistryRows(process.env.LA_TEST_SPAWN_REGISTRY).length !== 0) {
      fail("the timed-out spawn left its registry row behind");
    }
  } finally {
    restore();
  }
});

await test("probePid: live pid true, dead pid false", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
  const gone = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await gone;
  if (!probePid(process.pid)) fail("probePid reported this very process as dead");
  if (!(await pollUntil(() => !probePid(child.pid)))) fail(`probePid reported dead pid ${child.pid} as alive`);
});

await test("inheritEnv: false — the child does not see the parent shell's extra keys", async () => {
  const dir = tmp("env");
  const restore = withRegistry(dir);
  process.env.LA_TEST_SPAWN_CANARY = "leak";
  try {
    const serverPath = writeServer(dir, FAKE_SERVER_SRC);
    const { port, stop } = await spawnTestServer({
      script: serverPath,
      // Exactly what the child gets, nothing inherited: PATH/SystemRoot keep
      // node itself runnable on win32; the canary must NOT travel through.
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
      },
      inheritEnv: false,
      label: "env-case",
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/telemetry/health`);
    const body = await res.json();
    if (body.canary !== null) fail(`the child saw LA_TEST_SPAWN_CANARY=${JSON.stringify(body.canary)}`);
    await stop();
  } finally {
    delete process.env.LA_TEST_SPAWN_CANARY;
    restore();
  }
});

await test("port: a fixed port is used, returned, and recorded", async () => {
  const dir = tmp("fixed-port");
  const restore = withRegistry(dir);
  try {
    const fixed = await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
      probe.on("error", reject);
    });
    const serverPath = writeServer(dir, FAKE_SERVER_SRC);
    const { port, stop } = await spawnTestServer({ script: serverPath, port: fixed, label: "fixed-port-case" });
    if (port !== fixed) fail(`expected the fixed port ${fixed}, got ${port}`);
    const res = await fetch(`http://127.0.0.1:${fixed}/api/telemetry/health`);
    if (!res.ok) fail(`the spawned server on the fixed port answered ${res.status}`);
    const rows = registryRows(process.env.LA_TEST_SPAWN_REGISTRY);
    if (rows.length !== 1 || rows[0].port !== fixed) fail("the registry row does not record the fixed port");
    await stop();
  } finally {
    restore();
  }
});

console.log(`\n${passed}/${passed + failures.length} passed.`);
if (failures.length > 0) {
  console.error(`${failures.length} test(s) failed.`);
  process.exit(1);
}