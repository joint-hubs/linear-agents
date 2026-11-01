// scripts/agent-state-isolation.test.mjs — FOC-1161 part 1: the agent-state
// suites must never resolve the host's live run.
//
// The bug: agent-state.test.mjs, agent-state-resolve.test.mjs and
// agent-state-hook.test.mjs pin some state seams (LA_AGENT_STATE_DB,
// LA_SUPERVISOR_STATE_HOME) but leave others — LA_DATA_HOME, LA_STATE_ROOT and
// FENIX_SUPERVISOR_SESSION_ID — at whatever the host session happens to have
// set. On this machine a live supervisor session exists, so an un-pinned suite
// can resolve the host's real current-run.json and reach the live run dir
// (holds.json, children.json).
//
// The proof is a byte snapshot of a fake "live host":
//   - a temp LA_DATA_HOME holding supervisor/current-run.json (the pointer);
//   - a temp LA_SUPERVISOR_STATE_HOME holding <runId>/ with holds.json +
//     children.json (the live run the pointer names);
//   - a temp LA_STATE_ROOT (the store fallback the suites may fall back to).
// The three suites run as `node --test` children with every one of these seams
// pointed at the fake host and FENIX_SUPERVISOR_SESSION_ID stripped — a suite
// that pins its own seams ignores ours entirely, a suite that leaks resolves
// the fake pointer or writes into the fake run dir and the snapshot moves.
// The real host pointer (%LOCALAPPDATA%/linear-agents/supervisor on Windows)
// is never reachable: every path a suite could take is redirected to the fake
// dirs first.
// Run:
//   node --test scripts/agent-state-isolation.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, "..");

// The three suites the bug report covers.
const SUITES = [
  "agent-state.test.mjs",
  "agent-state-resolve.test.mjs",
  "agent-state-hook.test.mjs",
];

// A run id no real run dir can carry — the fake host's only run.
const RUN_ID = "2026-01-01T00-00-00-000-supervisor-1s0l";

/** Recursive byte snapshot: every file path → its bytes, every dir path → null. */
function snapshotTree(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = relative(dir, full);
      if (entry.isDirectory()) {
        out.set(`${rel}/`, null);
        walk(full);
      } else {
        out.set(rel, readFileSync(full));
      }
    }
  };
  walk(dir);
  return out;
}

function sameSnapshot(before, after) {
  const eq = (a, b) =>
    (a === null && b === null) || (Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b));
  return {
    added: [...after.keys()].filter((k) => !before.has(k)),
    removed: [...before.keys()].filter((k) => !after.has(k)),
    changed: [...before.keys()].filter((k) => after.has(k) && !eq(before.get(k), after.get(k))),
  };
}

test("the agent-state suites leave a fake live host byte-identical", { timeout: 300000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "agent-state-isolation-"));
  try {
    // ── the fake live host ─────────────────────────────────────────────────
    const dataHome = join(root, "data-home");
    const stateHome = join(root, "state-home");
    const stateRoot = join(root, "state-root");
    const runDir = join(stateHome, RUN_ID);

    mkdirSync(stateRoot, { recursive: true });

    // The pointer: exactly the shape resolveCurrentRun writes (source
    // "pointer", an updatedAt) — a leaking suite that re-resolves it rewrites
    // the timestamp and the snapshot catches it.
    mkdirSync(join(dataHome, "supervisor"), { recursive: true });
    writeFileSync(
      join(dataHome, "supervisor", "current-run.json"),
      JSON.stringify(
        {
          runId: RUN_ID,
          model: null,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          source: "pointer",
        },
        null,
        2,
      ) + "\n",
    );

    // The live run dir: holds.json is the exact file the bug drops or
    // rewrites in a host run; children.json is the other per-run store.
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "holds.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          holds: [{ id: "hold-live", state: "open", origin: "isolation probe", options: [] }],
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(runDir, "children.json"),
      JSON.stringify({ runId: RUN_ID, children: {}, rounds: {} }, null, 2) + "\n",
    );

    const fakeRoots = [
      ["data-home", dataHome],
      ["state-home", stateHome],
      ["state-root", stateRoot],
    ];
    const before = new Map(fakeRoots.map(([name, dir]) => [name, snapshotTree(dir)]));

    // ── the child env: every seam a suite could leak through, pointed at the
    // fake host. A suite that pins a seam overrides it; a suite that leaks
    // reads ours.
    const env = { ...process.env };
    env.LA_DATA_HOME = dataHome;
    env.LA_SUPERVISOR_STATE_HOME = stateHome;
    env.LA_STATE_ROOT = stateRoot;
    env.LA_SUPERVISOR_RUN = RUN_ID;
    env.LA_SUPERVISOR_CHILD = "probe";
    // A scoped session id would compose a session-scoped pointer path and hide
    // the leak — the suites must strip it themselves, so it starts set here
    // only for suites that never touch it.
    delete env.FENIX_SUPERVISOR_SESSION_ID;
    // No network: the resolve suites carry their own Linear fixture, but a
    // leaked path must never reach a real Linear API even if the host has a key.
    delete env.LINEAR_API_KEY;
    delete env.LINEAR_API_KEY_PISI;
    delete env.LINEAR_WORKSPACE;
    // The grandchild `node --test` must be a fresh runner: the parent
    // `node --test` stamps NODE_TEST_CONTEXT into this process's env, and a
    // grandchild that inherits it skips every file ("run() is being called
    // recursively"). Strip every NODE_TEST* seam.
    for (const key of Object.keys(env)) {
      if (key.startsWith("NODE_TEST")) delete env[key];
    }

    const res = spawnSync(
      process.execPath,
      ["--test", ...SUITES.map((f) => join(SCRIPTS, f))],
      { encoding: "utf8", env, cwd: ROOT, timeout: 240000 },
    );

    const after = new Map(fakeRoots.map(([name, dir]) => [name, snapshotTree(dir)]));

    const problems = [];
    for (const [name] of fakeRoots) {
      const { added, removed, changed } = sameSnapshot(before.get(name), after.get(name));
      for (const p of added) problems.push(`${name}: added ${p}`);
      for (const p of removed) problems.push(`${name}: removed ${p}`);
      for (const p of changed) problems.push(`${name}: modified ${p}`);
    }
    assert.deepEqual(
      problems,
      [],
      `the suites touched the fake live host (${problems.length} change(s)):\n${problems
        .slice(0, 40)
        .join("\n")}`,
    );

    assert.equal(
      res.status,
      0,
      `the suites must still pass under the fake host\nerror: ${res.error}\nstdout tail: ${(
        res.stdout || ""
      ).slice(-2000)}\nstderr tail: ${(res.stderr || "").slice(-2000)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
