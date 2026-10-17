// scripts/agent-state-hook.test.mjs — FOC-729 task 3/5: the SessionStart hook
// re-injects the WORKING STATE block, and spawn seeds PINNED STATE.
//
// Written against docs/plans/foc-729-working-state-hook.md — the modules under
// test (agent-state-hook.mjs, agent-state-seed.mjs) encode the same plan.
// Everything runs against mkdtemp scratch dirs: a temp git repo (one commit on
// branch foc-9-x), a temp LA_SUPERVISOR_STATE_HOME with <run>/children.json, a
// temp LA_ROOT carrying the byte-copied real registry, config/projects.json and
// docs/STATE.md, and the store behind LA_AGENT_STATE_DB. The hook is offline by
// design and the fixture env strips every Linear credential and mounts no
// fixture, so a resolver can never reach the network from here. The hook's git
// resolvers aim where the session sits (env.PWD || process.cwd()), so the CLI
// children run with cwd at the fixture repo. CLI children print a node:sqlite
// ExperimentalWarning on stderr — error assertions slice stdout or use
// substrings, never "stderr is empty".
// Run:
//   node --test scripts/agent-state-hook.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("./agent-state-hook.mjs", import.meta.url));
const REAL_REGISTRY = fileURLToPath(new URL("../config/agent-state.json", import.meta.url));

// Fake clock: every stored row stamps LA_AGENT_STATE_NOW so expectations stay
// literal.
const NOW = "2026-10-16T10:00:00.000Z";
// Matches RUN_ID_RE in supervisor-current-run.mjs — the shape the hook's
// run-dir derivation (runIdOfNamespace → runDir) trusts.
const RUN = "2026-10-16T00-00-00-000-supervisor-abcd";
const CHILD = "c1";
const NS_CHILD = `child:${RUN}/${CHILD}`;
const NS_SUPERVISOR = `supervisor:${RUN}`;

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-state-hook-"));
  const repo = join(root, "repo");
  const stateHome = join(root, "state-home");
  const laRoot = join(root, "la-root");
  const dbPath = join(root, "agent-state.sqlite");
  const registryFile = join(root, "agent-state.json");

  // Temp git repo: one commit, branch foc-9-x.
  const gitOpts = { cwd: repo, encoding: "utf8" };
  mkdirSync(repo, { recursive: true });
  execGit(["init", "-q"], gitOpts);
  execGit(["config", "user.email", "fixture@example.com"], gitOpts);
  execGit(["config", "user.name", "Fixture"], gitOpts);
  writeFileSync(join(repo, "README.md"), "fixture repo\n");
  execGit(["add", "."], gitOpts);
  execGit(["commit", "-q", "-m", "fixture"], gitOpts);
  execGit(["checkout", "-q", "-b", "foc-9-x"], gitOpts);
  const sha = execGit(["rev-parse", "HEAD"], gitOpts).trim();

  // Run dir with one dev child.
  mkdirSync(join(stateHome, RUN), { recursive: true });
  writeFileSync(
    join(stateHome, RUN, "children.json"),
    JSON.stringify(
      {
        runId: RUN,
        children: {
          c1: {
            childId: CHILD,
            squad: "dev",
            taskId: "FOC-9",
            worktree: repo,
            branch: "foc-9-x",
            baseRevision: sha,
            status: "running",
          },
        },
        rounds: {},
      },
      null,
      2,
    ) + "\n",
  );

  // LA_ROOT: the byte-copied real registry, one projects.json entry matching
  // the fixture repo by absolute path, and the STATE.md labels the supervisor
  // role resolves from.
  mkdirSync(join(laRoot, "config"), { recursive: true });
  mkdirSync(join(laRoot, "docs"), { recursive: true });
  copyFileSync(REAL_REGISTRY, registryFile);
  writeFileSync(
    join(laRoot, "config", "projects.json"),
    JSON.stringify(
      { projects: [{ linearProject: "Fenix", workspace: "joi", repo, teamKey: "FOC" }] },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(laRoot, "docs", "STATE.md"),
    ["# State", "", "- Active issue: FOC-9", "- Queue head: FOC-729", "- Known reds: none", ""].join("\n"),
  );

  // Fixture-driven resolution must never reach the network, even on a machine
  // with a Linear key in its OS environment: strip the credential seams and no
  // fixture is mounted (the hook strips them again itself — both belts).
  const env = { ...process.env };
  delete env.LINEAR_API_KEY;
  delete env.LINEAR_API_KEY_PISI;
  delete env.LINEAR_WORKSPACE;
  delete env.LA_AGENT_STATE_LINEAR_FIXTURE;
  delete env.FENIX_SUPERVISOR_SESSION_ID;
  Object.assign(env, {
    LA_SUPERVISOR_STATE_HOME: stateHome,
    LA_AGENT_STATE_DB: dbPath,
    LA_AGENT_STATE_REGISTRY: registryFile,
    LA_ROOT: laRoot,
    LA_AGENT_STATE_NOW: NOW,
    LA_SUPERVISOR_RUN: RUN,
    LA_SUPERVISOR_CHILD: CHILD,
    FENIX_STAGE: "dev",
    LA_TASK_ID: "FOC-9",
  });

  return { root, repo, stateHome, laRoot, sha, dbPath, registryFile, env };
}

function execGit(args, opts) {
  return execFileSync("git", args, opts);
}

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
}

// The base keys spawn seeds for one dev child, as tier-base facts.
const BASE_KEYS = ["issue", "worktree", "branch", "base_revision", "repo", "run_id", "role", "la_root"];

async function seedChildBase(fixture, { keys = BASE_KEYS } = {}) {
  const { openAgentState, setFact } = await import("./agent-state.mjs");
  const values = {
    issue: "FOC-9",
    worktree: fixture.repo,
    branch: "foc-9-x",
    base_revision: fixture.sha,
    repo: basename(fixture.repo),
    run_id: RUN,
    role: "dev",
    la_root: fixture.laRoot,
  };
  const store = openAgentState(fixture.dbPath);
  try {
    for (const key of keys) {
      setFact(store, {
        namespace: NS_CHILD,
        key,
        value: values[key],
        tier: "base",
        source: "spawn",
        evidence: "test seed",
        now: NOW,
      });
    }
  } finally {
    store.close();
  }
  return keys;
}

// Over-cap rendering needs MORE agent rows than the store's own write cap
// (AGENT_KEY_CAP, a FOC-727 behaviour guarded by agent-state.test.mjs) allows
// through the API, so the rows past the cap go in below it — same column
// shape, tier agent, reason required.
async function fillAgentKeys(fixture, count) {
  const { openAgentState, setFact } = await import("./agent-state.mjs");
  const store = openAgentState(fixture.dbPath);
  try {
    for (let i = 1; i <= count; i++) {
      const key = `agent_${String(i).padStart(2, "0")}`;
      const value = `working fact ${i}`;
      try {
        setFact(store, {
          namespace: NS_CHILD,
          key,
          value,
          tier: "agent",
          reason: "test working state",
          now: NOW,
        });
      } catch (err) {
        if (err?.code !== "AGENT_KEY_CAP") throw err;
        store.db
          .prepare(
            `INSERT INTO facts
               (namespace, key, value, tier, status, source, evidence, reason, scope,
                expires_at, created_at, updated_at, last_read_at, read_count, version)
             VALUES (?, ?, ?, 'agent', 'active', 'agent', NULL, 'test working state', 'task',
                     NULL, ?, ?, NULL, 0, 1)`,
          )
          .run(NS_CHILD, key, value, NOW, NOW);
      }
    }
  } finally {
    store.close();
  }
}

// The hook prints the block plus one trailing newline; the record counts the
// block itself, so strip exactly that newline before comparing.
const blockOf = (stdout) => stdout.replace(/\n$/, "");

function runHookSync(env, payload, { cwd } = {}) {
  return spawnSync(process.execPath, [HOOK, "SessionStart"], {
    // A string payload rides verbatim (the malformed-stdin case); anything
    // else is the JSON hook payload.
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    // env.PWD wins over process.cwd() in the hook — keep both at the fixture
    // repo, where the session under test "sits".
    env: cwd ? { ...env, PWD: cwd } : env,
    cwd,
  });
}

function readRenders(fixture) {
  const path = join(fixture.stateHome, RUN, "agent-state-renders.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function carriesLine(block, prefix) {
  return block.split("\n").some((line) => line.startsWith(prefix));
}

// Env seams read at call time by the modules under test; API-level tests set
// them on process.env around the call and restore afterwards.
const SEAMS = [
  "LA_SUPERVISOR_STATE_HOME",
  "LA_AGENT_STATE_DB",
  "LA_AGENT_STATE_REGISTRY",
  "LA_AGENT_STATE_LINEAR_FIXTURE",
  "LA_ROOT",
  "LA_AGENT_STATE_NOW",
  "LA_SUPERVISOR_RUN",
  "LA_SUPERVISOR_CHILD",
  "LA_TASK_ID",
  "FENIX_STAGE",
];

function applySeams(env) {
  const saved = {};
  for (const key of SEAMS) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  return saved;
}

function restoreSeams(saved) {
  for (const key of SEAMS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

test("compact payload for the seeded child namespace prints the block and records one render row", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    const seeded = await seedChildBase(fixture);
    const res = runHookSync(
      fixture.env,
      { hook_event_name: "SessionStart", source: "compact" },
      { cwd: fixture.repo },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const block = blockOf(res.stdout);
    assert.ok(block.startsWith("=== WORKING STATE ==="), `block: ${block.slice(0, 120)}`);
    const expectedLines = {
      issue: "issue: FOC-9",
      worktree: `worktree: ${fixture.repo}`,
      branch: "branch: foc-9-x",
      base_revision: `base_revision: ${fixture.sha}`,
      repo: `repo: ${basename(fixture.repo)}`,
      run_id: `run_id: ${RUN}`,
      role: "role: dev",
      la_root: `la_root: ${fixture.laRoot}`,
    };
    for (const key of seeded) {
      assert.ok(carriesLine(block, expectedLines[key]), `block carries "${expectedLines[key]}"`);
    }

    const rows = readRenders(fixture);
    assert.equal(rows.length, 1, `one render row, got ${JSON.stringify(rows)}`);
    const row = rows[0];
    assert.equal(row.source, "compact");
    assert.equal(row.namespace, NS_CHILD);
    assert.equal(row.role, "dev");
    assert.equal(row.lines, block.split("\n").length, `lines: ${row.lines}`);
    assert.equal(row.bytes, Buffer.byteLength(block, "utf8"), `bytes: ${row.bytes}`);
    assert.equal(typeof row.resolved, "number", `resolved: ${row.resolved}`);
    assert.equal(typeof row.missing, "number", `missing: ${row.missing}`);
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("supervisor namespace resolves STATE.md labels offline and records the supervisor role", () => {
  const fixture = makeFixture();
  try {
    const env = { ...fixture.env };
    delete env.LA_SUPERVISOR_CHILD;
    delete env.FENIX_STAGE;
    delete env.LA_TASK_ID;
    const res = runHookSync(env, { hook_event_name: "SessionStart", source: "startup" }, { cwd: fixture.repo });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const block = blockOf(res.stdout);
    assert.ok(block.startsWith("=== WORKING STATE ==="), `block: ${block.slice(0, 120)}`);
    for (const prefix of ["active_issue: FOC-9", "queue_head: FOC-729", "known_reds: none", "cost_basis: priced"]) {
      assert.ok(carriesLine(block, prefix), `block carries "${prefix}":\n${block}`);
    }

    const rows = readRenders(fixture);
    assert.equal(rows.length, 1, `one render row, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0].source, "startup");
    assert.equal(rows[0].namespace, NS_SUPERVISOR);
    assert.equal(rows[0].role, "supervisor");
  } finally {
    cleanup(fixture);
  }
});

test("no run id anywhere renders exactly the unavailable line and records nothing", () => {
  const fixture = makeFixture();
  const emptyData = mkdtempSync(join(tmpdir(), "agent-state-nodata-"));
  try {
    const env = { ...fixture.env };
    delete env.LA_SUPERVISOR_RUN;
    delete env.LA_SUPERVISOR_CHILD;
    delete env.FENIX_STAGE;
    delete env.LA_TASK_ID;
    // readCurrentRun locates its pointer at <LA_DATA_HOME>/supervisor/
    // current-run.json — an empty data home means no pointer, no adoption.
    env.LA_DATA_HOME = emptyData;
    const res = runHookSync(env, { hook_event_name: "SessionStart", source: "startup" });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(res.stdout.trim(), "WORKING STATE unavailable: no run id");
    assert.equal(existsSync(join(fixture.stateHome, RUN, "agent-state-renders.jsonl")), false);
  } finally {
    rmSync(emptyData, { recursive: true, force: true });
    cleanup(fixture);
  }
});

test("a current-run pointer at a run whose dir is gone is not adopted", () => {
  const fixture = makeFixture();
  const dataHome = mkdtempSync(join(tmpdir(), "agent-state-data-"));
  try {
    const env = { ...fixture.env };
    delete env.LA_SUPERVISOR_RUN;
    delete env.LA_SUPERVISOR_CHILD;
    delete env.FENIX_STAGE;
    delete env.LA_TASK_ID;
    // readCurrentRun reads <LA_DATA_HOME>/supervisor/current-run.json; the
    // record shape it validates (supervisor-current-run.mjs) is { runId, ... }
    // with runId matching RUN_ID_RE. The pointed-at run has NO directory — the
    // hook must not adopt it (the resolve would recreate the dir from nothing).
    const goneRun = "2026-10-15T00-00-00-000-supervisor-dead";
    mkdirSync(join(dataHome, "supervisor"), { recursive: true });
    writeFileSync(
      join(dataHome, "supervisor", "current-run.json"),
      `${JSON.stringify(
        { runId: goneRun, model: null, startedAt: NOW, updatedAt: NOW, source: "pointer" },
        null,
        2,
      )}\n`,
    );
    env.LA_DATA_HOME = dataHome;
    const res = runHookSync(env, { hook_event_name: "SessionStart", source: "startup" });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(res.stdout.trim(), "WORKING STATE unavailable: no run id");
    assert.equal(existsSync(join(fixture.stateHome, goneRun)), false, "no run dir was created");

    // No holds.json anywhere under the state home — the hold store lives in the
    // run dir, so an unadopted pointer must not seed one either.
    const holdsFiles = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name === "holds.json") holdsFiles.push(path);
      }
    };
    walk(fixture.stateHome);
    assert.deepEqual(holdsFiles, [], `holds.json found: ${holdsFiles.join(", ")}`);
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
    cleanup(fixture);
  }
});

test("a render failure after resolve still records an error row and prints the unavailable line", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    await seedChildBase(fixture);
    // Both seams must be set — a stray FAIL_RENDER on a real session is inert.
    const env = {
      ...fixture.env,
      LA_AGENT_STATE_TEST_SEAMS: "1",
      LA_AGENT_STATE_HOOK_FAIL_RENDER: "1",
    };
    const res = runHookSync(env, { hook_event_name: "SessionStart", source: "compact" }, { cwd: fixture.repo });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(
      res.stdout.trim(),
      "WORKING STATE unavailable: injected render failure (test seam)",
      `stdout: ${res.stdout}`,
    );

    const rows = readRenders(fixture);
    assert.equal(rows.length, 1, `one error row, got ${JSON.stringify(rows)}`);
    const row = rows[0];
    assert.equal(row.namespace, NS_CHILD);
    assert.equal(row.role, "dev");
    assert.equal(row.source, "compact");
    assert.equal(row.lines, 0);
    assert.equal(row.omitted, 0);
    assert.equal(row.bytes, 0);
    assert.equal(typeof row.resolved, "number", `resolved: ${row.resolved}`);
    assert.equal(typeof row.missing, "number", `missing: ${row.missing}`);
    assert.match(row.error, /injected render failure/);
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("an unreadable store prints the unavailable line and exits 0", () => {
  const fixture = makeFixture();
  try {
    const dbDir = join(fixture.root, "store-dir");
    mkdirSync(dbDir);
    const res = runHookSync(
      { ...fixture.env, LA_AGENT_STATE_DB: dbDir },
      { hook_event_name: "SessionStart", source: "startup" },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.stdout.startsWith("WORKING STATE unavailable:"), `stdout: ${res.stdout}`);
  } finally {
    cleanup(fixture);
  }
});

test("malformed stdin still prints the block and records source startup", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    await seedChildBase(fixture);
    const res = runHookSync(fixture.env, "{not json", { cwd: fixture.repo });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(
      blockOf(res.stdout).startsWith("=== WORKING STATE ==="),
      `block: ${res.stdout.slice(0, 120)}`,
    );
    const rows = readRenders(fixture);
    assert.equal(rows.length, 1, `one render row, got ${JSON.stringify(rows)}`);
    assert.equal(rows[0].source, "startup");
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("an over-cap store renders every base line, the tail line, and records omitted > 0", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    await seedChildBase(fixture, { keys: ["issue", "worktree", "branch"] });
    await fillAgentKeys(fixture, 60);
    const res = runHookSync(fixture.env, { hook_event_name: "SessionStart", source: "startup" }, { cwd: fixture.repo });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const text = res.stdout;
    const block = blockOf(text);
    for (const prefix of ["issue: FOC-9", `worktree: ${fixture.repo}`, "branch: foc-9-x"]) {
      assert.ok(carriesLine(block, prefix), `base line "${prefix}" survived the cap:\n${block}`);
    }
    const lines = block.split("\n");
    assert.match(lines[lines.length - 1], /^\d+ more — use agent-state get$/, `tail: ${lines.at(-1)}`);

    const rows = readRenders(fixture);
    assert.equal(rows.length, 1, `one render row, got ${JSON.stringify(rows)}`);
    assert.ok(rows[0].omitted > 0, `omitted: ${rows[0].omitted}`);
    assert.ok(text.split("\n").length <= 61, `printed lines: ${text.split("\n").length}`);
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("offline by construction: a dummy Linear key never reaches the network and issue_title never renders", () => {
  const fixture = makeFixture();
  try {
    const env = { ...fixture.env, LINEAR_API_KEY: "dummy-not-a-key" };
    const started = Date.now();
    const res = runHookSync(env, { hook_event_name: "SessionStart", source: "startup" }, { cwd: fixture.repo });
    const duration = Date.now() - started;
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(!blockOf(res.stdout).includes("issue_title"), "issue_title must not render");
    assert.ok(duration < 5000, `hook took ${duration} ms — it tried the network`);
  } finally {
    cleanup(fixture);
  }
});

test("an unknown squad role renders the unavailable line naming the role", () => {
  const fixture = makeFixture();
  try {
    const res = runHookSync(
      { ...fixture.env, FENIX_STAGE: "bogus" },
      { hook_event_name: "SessionStart", source: "startup" },
      { cwd: fixture.repo },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok(res.stdout.startsWith("WORKING STATE unavailable:"), `stdout: ${res.stdout}`);
    assert.ok(res.stdout.includes("bogus"), `stdout names the role: ${res.stdout}`);
  } finally {
    cleanup(fixture);
  }
});

test("runHook in-process: the resume source is passed through to the record", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    await seedChildBase(fixture);
    const { runHook } = await import("./agent-state-hook.mjs");
    const result = await runHook({
      argv: ["SessionStart"],
      env: { ...fixture.env, PWD: fixture.repo },
      stdin: '{"source":"resume"}',
    });
    assert.equal(result.code, 0);
    assert.ok(result.text.startsWith("=== WORKING STATE ==="), `text: ${result.text.slice(0, 120)}`);
    assert.ok(result.record, "a record was returned");
    assert.equal(result.record.source, "resume");
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("seedPinnedState skips undeclared keys, ignores empty values, and never rewrites unchanged rows", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  const { openAgentState } = await import("./agent-state.mjs");
  const store = openAgentState(fixture.dbPath);
  try {
    const { seedPinnedState } = await import("./agent-state-seed.mjs");
    const { loadRegistry } = await import("./agent-state-registry.mjs");
    const registry = loadRegistry(fixture.registryFile);

    const first = seedPinnedState(store, {
      namespace: NS_CHILD,
      registry,
      values: { issue: "FOC-9", made_up: "zzz" },
      now: NOW,
    });
    assert.deepEqual(first.seeded, ["issue"]);
    assert.deepEqual(first.skipped, ["made_up"]);
    const issueRow = () =>
      store.db.prepare("SELECT value, tier, source, version FROM facts WHERE namespace = ? AND key = 'issue'").get(NS_CHILD);
    assert.equal(issueRow().tier, "base");
    assert.equal(issueRow().source, "spawn");
    assert.equal(issueRow().value, "FOC-9");
    assert.equal(issueRow().version, 1);

    // Empty values are ignored — neither seeded nor skipped.
    const empty = seedPinnedState(store, {
      namespace: NS_CHILD,
      registry,
      values: { issue: "", branch: "" },
      now: NOW,
    });
    assert.deepEqual(empty.seeded, []);

    // Seeding the same values again reports the same keys and leaves the row
    // at version 1 — no churn behind an unchanged value.
    const again = seedPinnedState(store, {
      namespace: NS_CHILD,
      registry,
      values: { issue: "FOC-9", made_up: "zzz" },
      now: NOW,
    });
    assert.deepEqual(again.seeded, first.seeded);
    assert.equal(issueRow().version, 1);
  } finally {
    store.close();
    restoreSeams(saved);
    cleanup(fixture);
  }
});
