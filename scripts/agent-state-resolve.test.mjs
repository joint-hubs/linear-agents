// scripts/agent-state-resolve.test.mjs — FOC-728 slice 2/5: base keys per role,
// deterministic resolvers, unresolved → hold.
//
// The modules under test (agent-state-registry.mjs, agent-state-resolve.mjs and
// the resolve/missing/registry verbs in agent-state.mjs) are written against
// docs/plans/foc-728-agent-state-registry.md; these tests encode the same plan.
// Everything runs against mkdtemp scratch dirs: a temp git repo (one commit on
// branch foc-9-x), a temp LA_SUPERVISOR_STATE_HOME with <run>/children.json, a
// temp LA_ROOT with config/projects.json + docs/STATE.md, a Linear fixture JSON
// behind LA_AGENT_STATE_LINEAR_FIXTURE (the network is never reached) and a
// copy of the real config/agent-state.json as LA_AGENT_STATE_REGISTRY. Store
// access goes through LA_AGENT_STATE_DB / openAgentState(path) — no ports, no
// socket binds, no real-repo writes, no telemetry DB. CLI children print a
// node:sqlite ExperimentalWarning on stderr, so error assertions slice the
// payload from the first `{` to the last `}` or use substring matches — never
// "stderr is empty".
// Run:
//   node --test scripts/agent-state-resolve.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./agent-state.mjs", import.meta.url));
const REAL_REGISTRY = fileURLToPath(new URL("../config/agent-state.json", import.meta.url));

// Fake clock: LA_AGENT_STATE_NOW and every hold answer timestamp pick from this
// so ISO expectations stay literal.
const NOW = "2026-01-01T00:00:00.000Z";
const RUN = "run-foc728";
const NS_CHILD = `child:${RUN}/c1`;
const ORIGIN_CHILD = `agent-state resolve ${NS_CHILD}`;

const LINEAR_FIXTURE = {
  "FOC-9": {
    title: "Fixture issue",
    team: "FOC",
    project: "Fenix",
    projectMilestone: "M5",
    parent: { identifier: "FOC-470", title: "M5 epic" },
  },
};

// Fallback registry mirroring the plan's starting set — used only until the
// real config/agent-state.json (Mateusz-owned, landed by the module slice) is
// copyable; makeFixture prefers the real file whenever it exists.
const FALLBACK_REGISTRY = {
  version: 1,
  roles: {
    all: {
      repo: {
        description: "Repository basename",
        resolvers: [{ kind: "git", fact: "root" }],
        askIfMissing: false,
        refresh: "once",
      },
      la_root: {
        description: "Tooling checkout root",
        resolvers: [{ kind: "env", name: "LA_ROOT" }, { kind: "git", fact: "root" }],
        askIfMissing: false,
        refresh: "once",
      },
      run_id: {
        description: "Supervisor run id",
        resolvers: [{ kind: "env", name: "LA_SUPERVISOR_RUN" }],
        askIfMissing: false,
        refresh: "once",
      },
      role: {
        description: "Resolved role",
        resolvers: [{ kind: "arg", name: "role" }],
        askIfMissing: false,
        refresh: "once",
      },
      linear_team: {
        description: "Linear team key",
        resolvers: [
          { kind: "projects-config", field: "teamKey" },
          { kind: "env", name: "LINEAR_TEAM_KEY_FEN" },
        ],
        askIfMissing: false,
        refresh: "once",
      },
      linear_project: {
        description: "Linear project name",
        resolvers: [{ kind: "projects-config", field: "linearProject" }],
        askIfMissing: false,
        refresh: "once",
      },
    },
    supervisor: {
      active_issue: {
        description: "Issue the supervisor is driving",
        resolvers: [{ kind: "state-md", label: "Active issue" }],
        askIfMissing: true,
        refresh: "once",
      },
      active_milestone: {
        description: "Milestone of the active issue",
        resolvers: [{ kind: "linear", issueKey: "active_issue", field: "projectMilestone" }],
        askIfMissing: true,
        refresh: "once",
      },
      active_epic: {
        description: "Epic of the active issue",
        resolvers: [{ kind: "linear", issueKey: "active_issue", field: "parent" }],
        askIfMissing: true,
        refresh: "once",
      },
      queue_head: {
        description: "Head of the delivery queue",
        resolvers: [{ kind: "state-md", label: "Queue head" }],
        askIfMissing: true,
        refresh: "once",
      },
      landing_flow: {
        description: "How work lands",
        resolvers: [{ kind: "const", value: "branch → PR → Mateusz merges on GitHub" }],
        askIfMissing: false,
        refresh: "once",
      },
      push_policy: {
        description: "Push rules",
        resolvers: [{ kind: "const", value: "feature branches only; never main; no force" }],
        askIfMissing: false,
        refresh: "once",
      },
      cost_basis: {
        description: "Cost accounting basis",
        resolvers: [{ kind: "const", value: "priced" }],
        askIfMissing: false,
        refresh: "once",
      },
      known_reds: {
        description: "Known failing suites",
        resolvers: [{ kind: "state-md", label: "Known reds" }],
        askIfMissing: true,
        refresh: "once",
      },
    },
    child: {
      issue: {
        description: "Current issue identifier",
        resolvers: [{ kind: "env", name: "LA_TASK_ID" }, { kind: "registry", field: "taskId" }],
        askIfMissing: false,
        refresh: "once",
      },
      issue_title: {
        description: "Current issue title",
        resolvers: [{ kind: "linear", issueKey: "issue", field: "title" }],
        askIfMissing: true,
        refresh: "once",
      },
      milestone: {
        description: "Milestone of the current issue",
        resolvers: [{ kind: "linear", issueKey: "issue", field: "projectMilestone" }],
        askIfMissing: true,
        refresh: "once",
      },
      epic: {
        description: "Epic of the current issue",
        resolvers: [{ kind: "linear", issueKey: "issue", field: "parent" }],
        askIfMissing: true,
        refresh: "once",
      },
      worktree: {
        description: "Child worktree",
        resolvers: [{ kind: "registry", field: "worktree" }, { kind: "git", fact: "root" }],
        askIfMissing: false,
        refresh: "once",
      },
      branch: {
        description: "Child branch",
        resolvers: [{ kind: "git", fact: "branch" }, { kind: "registry", field: "branch" }],
        askIfMissing: false,
        refresh: "always",
      },
      base_revision: {
        description: "Revision the child started from",
        resolvers: [{ kind: "registry", field: "baseRevision" }],
        askIfMissing: false,
        refresh: "once",
      },
      candidate: {
        description: "Candidate task id",
        resolvers: [{ kind: "registry", field: "candidate" }],
        askIfMissing: false,
        refresh: "once",
      },
      acceptance_criteria_ref: {
        description: "Where the acceptance criteria live",
        resolvers: [{ kind: "template", value: "linear issue {issue} § Acceptance criteria" }],
        askIfMissing: false,
        refresh: "once",
      },
    },
  },
};

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-state-resolve-"));
  const repo = join(root, "repo");
  const stateHome = join(root, "state-home");
  const laRoot = join(root, "la-root");
  const dbPath = join(root, "agent-state.sqlite");
  const registryFile = join(root, "agent-state.json");
  const linearFixtureFile = join(root, "linear-fixture.json");

  // Temp git repo: one commit, branch foc-9-x.
  const gitOpts = { cwd: repo, encoding: "utf8" };
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], gitOpts);
  execFileSync("git", ["config", "user.email", "fixture@example.com"], gitOpts);
  execFileSync("git", ["config", "user.name", "Fixture"], gitOpts);
  writeFileSync(join(repo, "README.md"), "fixture repo\n");
  execFileSync("git", ["add", "."], gitOpts);
  execFileSync("git", ["commit", "-q", "-m", "fixture"], gitOpts);
  execFileSync("git", ["checkout", "-q", "-b", "foc-9-x"], gitOpts);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], gitOpts).trim();

  // Run dir with one dev child.
  mkdirSync(join(stateHome, RUN), { recursive: true });
  writeFileSync(
    join(stateHome, RUN, "children.json"),
    JSON.stringify(
      {
        runId: RUN,
        children: {
          c1: {
            childId: "c1",
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

  // LA_ROOT: projects.json (repo matched by absolute path) + docs/STATE.md.
  mkdirSync(join(laRoot, "config"), { recursive: true });
  mkdirSync(join(laRoot, "docs"), { recursive: true });
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
    [
      "# State",
      "",
      "- Active issue: FOC-9",
      "- Queue head: FOC-728 then FOC-729",
      "- Known reds: cockpit-routes, task-sessions",
      "",
    ].join("\n"),
  );

  if (existsSync(REAL_REGISTRY)) copyFileSync(REAL_REGISTRY, registryFile);
  else writeFileSync(registryFile, JSON.stringify(FALLBACK_REGISTRY, null, 2) + "\n");

  writeFileSync(linearFixtureFile, JSON.stringify(LINEAR_FIXTURE, null, 2) + "\n");

  // Fixture-driven resolution must never reach the network, even on a machine
  // with a Linear key in its OS environment: strip the credential seams first.
  const env = { ...process.env };
  delete env.LINEAR_API_KEY;
  delete env.LINEAR_API_KEY_PISI;
  delete env.LINEAR_WORKSPACE;
  Object.assign(env, {
    LA_SUPERVISOR_STATE_HOME: stateHome,
    LA_AGENT_STATE_DB: dbPath,
    LA_AGENT_STATE_REGISTRY: registryFile,
    LA_AGENT_STATE_LINEAR_FIXTURE: linearFixtureFile,
    LA_ROOT: laRoot,
    LA_AGENT_STATE_NOW: NOW,
    LA_TASK_OWNER: "fixture-owner",
    LA_SUPERVISOR_RUN: RUN,
    LA_SUPERVISOR_CHILD: "c1",
    LA_TASK_ID: "FOC-9",
  });

  return { root, repo, stateHome, laRoot, sha, dbPath, registryFile, env };
}

function cleanup(fixture) {
  rmSync(fixture.root, { recursive: true, force: true });
}

function runCliSync(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

// The node:sqlite ExperimentalWarning precedes any JSON error payload on
// stderr, and the error payload itself is pretty-printed — slice from the
// first `{` to the last `}` instead of trusting line boundaries.
function errorJson(text) {
  const s = String(text || "");
  return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
}

function envWithoutLinear(env) {
  // Fixture off + every credential seam gone: a host with a real Linear key in
  // its OS environment can never reach the network from the parallel lane.
  const copy = { ...env };
  delete copy.LA_AGENT_STATE_LINEAR_FIXTURE;
  delete copy.LINEAR_API_KEY;
  delete copy.LINEAR_API_KEY_PISI;
  delete copy.LINEAR_WORKSPACE;
  return copy;
}

function readHoldsFile(fixture) {
  return JSON.parse(readFileSync(join(fixture.stateHome, RUN, "holds.json"), "utf8"));
}

function resolvedMap(json) {
  return Object.fromEntries((json.resolved || []).map((entry) => [entry.key, entry]));
}

function missingMap(json) {
  return Object.fromEntries((json.missing || []).map((entry) => [entry.key, entry]));
}

// Env seams read at call time by the modules under test (supervisor-lib derives
// every hold path from LA_SUPERVISOR_STATE_HOME); API tests set them on
// process.env around the call and restore afterwards.
const SEAMS = [
  "LA_SUPERVISOR_STATE_HOME",
  "LA_AGENT_STATE_DB",
  "LA_AGENT_STATE_REGISTRY",
  "LA_AGENT_STATE_LINEAR_FIXTURE",
  "LA_ROOT",
  "LA_AGENT_STATE_NOW",
  "LA_TASK_OWNER",
  "LA_SUPERVISOR_RUN",
  "LA_SUPERVISOR_CHILD",
  "LA_TASK_ID",
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

// The modules under test are landed by a parallel worker; the imports are
// deferred into the tests so this file parses (and lints) standalone. Modules
// read the seams at use time, but the first import still happens under applied
// seams to be safe.
let mods = null;
async function loadMods() {
  if (!mods) {
    mods = {
      agentState: await import("./agent-state.mjs"),
      registry: await import("./agent-state-registry.mjs"),
      resolveMod: await import("./agent-state-resolve.mjs"),
      supervisorLib: await import("./supervisor-lib.mjs"),
    };
  }
  return mods;
}

function errorCodeSync(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to throw");
}

test("loadRegistry validates the real registry; keysForRole orders and scopes roles", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    const { registry } = await loadMods();
    // The real Mateusz-owned registry when it has landed, else the fixture's
    // byte-copy/fallback of the same starting set.
    const target = existsSync(REAL_REGISTRY) ? REAL_REGISTRY : fixture.registryFile;
    const reg = registry.loadRegistry(target);
    assert.equal(reg.version, 1);

    const devKeys = registry.keysForRole(reg, "dev").map(([key]) => key);
    assert.deepEqual(
      devKeys.slice(0, 6),
      ["repo", "la_root", "run_id", "role", "linear_team", "linear_project"],
    );
    for (const key of [
      "issue",
      "issue_title",
      "milestone",
      "epic",
      "worktree",
      "branch",
      "base_revision",
      "candidate",
      "acceptance_criteria_ref",
    ]) {
      assert.ok(devKeys.includes(key), `dev keys include ${key}`);
    }

    const supervisorKeys = registry.keysForRole(reg, "supervisor").map(([key]) => key);
    for (const key of [
      "active_issue",
      "active_milestone",
      "active_epic",
      "queue_head",
      "landing_flow",
      "push_policy",
      "cost_basis",
      "known_reds",
    ]) {
      assert.ok(supervisorKeys.includes(key), `supervisor keys include ${key}`);
    }

    const err = errorCodeSync(() => registry.keysForRole(reg, "bogus"));
    assert.equal(err.code, "FIELD_INVALID");
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("invalid registries fail closed: REGISTRY_INVALID naming the key, exit 1 on the CLI", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    const { registry, agentState } = await loadMods();

    const writeVariant = (name, mutator) => {
      const reg = JSON.parse(readFileSync(fixture.registryFile, "utf8"));
      mutator(reg);
      const path = join(fixture.root, name);
      writeFileSync(path, JSON.stringify(reg, null, 2) + "\n");
      return path;
    };

    // (a) unknown resolver kind under roles.child.issue
    const unknownKind = writeVariant("registry-unknown-kind.json", (reg) => {
      reg.roles.child ??= {};
      reg.roles.child.issue ??= {
        description: "Current issue identifier",
        resolvers: [{ kind: "env", name: "LA_TASK_ID" }],
        askIfMissing: false,
        refresh: "once",
      };
      reg.roles.child.issue.resolvers.push({ kind: "foo" });
    });
    const errA = errorCodeSync(() => registry.loadRegistry(unknownKind));
    assert.ok(errA instanceof agentState.AgentStateError, `expected AgentStateError, got ${errA}`);
    assert.equal(errA.code, "REGISTRY_INVALID");
    assert.ok(errA.message.includes("issue"), `message names the key: ${errA.message}`);
    assert.ok(errA.message.includes("foo"), `message names the kind: ${errA.message}`);

    // (b) the same key in roles.all and roles.child
    const duplicate = writeVariant("registry-duplicate.json", (reg) => {
      reg.roles.all ??= {};
      reg.roles.all.issue = JSON.parse(JSON.stringify(reg.roles.child.issue));
    });
    const errB = errorCodeSync(() => registry.loadRegistry(duplicate));
    assert.equal(errB.code, "REGISTRY_INVALID");
    assert.ok(errB.message.includes("duplicate"), `message says duplicate: ${errB.message}`);
    assert.ok(errB.message.includes("issue"), `message names the key: ${errB.message}`);

    // (c) an entry without a description
    const noDescription = writeVariant("registry-no-description.json", (reg) => {
      reg.roles.child.no_desc_probe = {
        resolvers: [{ kind: "const", value: "x" }],
        askIfMissing: false,
        refresh: "once",
      };
    });
    const errC = errorCodeSync(() => registry.loadRegistry(noDescription));
    assert.equal(errC.code, "REGISTRY_INVALID");
    assert.ok(errC.message.includes("description"), `message names the field: ${errC.message}`);

    // (d) unparsable JSON
    const unparsable = join(fixture.root, "registry-unparsable.json");
    writeFileSync(unparsable, "{ nope\n");
    const errD = errorCodeSync(() => registry.loadRegistry(unparsable));
    assert.equal(errD.code, "REGISTRY_INVALID");

    // CLI: the registry verb exits 1 naming the code and the offending path
    const res = runCliSync(
      ["registry", "--json"],
      { ...fixture.env, LA_AGENT_STATE_REGISTRY: unknownKind },
    );
    assert.equal(res.status, 1, `stderr: ${res.stderr}`);
    const errPayload = errorJson(res.stderr);
    assert.equal(errPayload.code, "REGISTRY_INVALID");
    // The path arrives JSON-escaped (backslashes doubled on Windows), so the
    // assertion matches on the basename — no separator dependence.
    assert.ok(
      errPayload.message.includes(basename(unknownKind)),
      `message names the path: ${errPayload.message}`,
    );
    assert.ok(errPayload.message.includes("foo"), `message names the kind: ${errPayload.message}`);
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("resolve --role dev fills every child base key with source + evidence and stores tier base", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    await loadMods();
    const res = runCliSync(
      ["resolve", "--role", "dev", "--namespace", NS_CHILD, "--cwd", fixture.repo, "--json"],
      fixture.env,
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const json = JSON.parse(res.stdout);
    const resolved = resolvedMap(json);
    const missing = missingMap(json);

    const expectations = {
      repo: { value: basename(fixture.repo), source: "git" },
      run_id: { value: RUN, source: "spawn" },
      role: { value: "dev", source: "spawn" },
      linear_team: { value: "FOC", source: "config" },
      linear_project: { value: "Fenix", source: "config" },
      issue: { value: "FOC-9", source: "spawn" },
      issue_title: { value: "Fixture issue", source: "linear" },
      milestone: { value: "M5", source: "linear" },
      epic: { value: "FOC-470", source: "linear" },
      worktree: { value: fixture.repo },
      branch: { value: "foc-9-x" },
      base_revision: { value: fixture.sha },
      acceptance_criteria_ref: { value: "linear issue FOC-9 § Acceptance criteria", source: "config" },
    };
    for (const [key, expected] of Object.entries(expectations)) {
      const entry = resolved[key];
      assert.ok(entry, `resolved carries ${key}`);
      assert.equal(entry.value, expected.value, `value of ${key}`);
      if (expected.source) assert.equal(entry.source, expected.source, `source of ${key}`);
    }
    // LA_ROOT is set, so la_root is the fixture dir (source spawn or git)
    assert.equal(resolved.la_root.value, fixture.laRoot);
    assert.ok(
      ["spawn", "git"].includes(resolved.la_root.source),
      `la_root source: ${resolved.la_root.source}`,
    );

    for (const entry of json.resolved) {
      assert.ok(
        typeof entry.evidence === "string" && entry.evidence.length > 0,
        `evidence for ${entry.key}`,
      );
    }

    assert.ok(missing.candidate, "candidate is missing");
    assert.equal(missing.candidate.askIfMissing, false);
    assert.equal(json.hold ?? null, null); // nothing askable is missing

    const { agentState } = await loadMods();
    const store = agentState.openAgentState(fixture.dbPath);
    try {
      for (const key of Object.keys(resolved)) {
        const row = store.db
          .prepare("SELECT tier FROM facts WHERE namespace = ? AND key = ?")
          .get(NS_CHILD, key);
        assert.ok(row, `stored row for ${key}`);
        assert.equal(row.tier, "base");
      }
    } finally {
      store.close();
    }
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("without the Linear fixture the ask-keys hold: exactly one hold, a second resolve adds none", async () => {
  const fixture = makeFixture();
  try {
    const env = envWithoutLinear(fixture.env);
    const args = ["resolve", "--role", "dev", "--namespace", NS_CHILD, "--cwd", fixture.repo, "--json"];

    const res = runCliSync(args, env);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`); // missing is a state, not an error
    const json = JSON.parse(res.stdout);
    const missing = missingMap(json);
    for (const key of ["issue_title", "milestone", "epic"]) {
      assert.ok(missing[key], `${key} is missing`);
      assert.equal(missing[key].askIfMissing, true);
    }
    assert.equal(json.hold.id, "hold-1");
    assert.equal(json.hold.created, true);

    const holds = readHoldsFile(fixture);
    assert.equal(holds.holds.length, 1);
    const hold = holds.holds[0];
    assert.equal(hold.origin, ORIGIN_CHILD);
    assert.equal(hold.state, "open");
    for (const key of ["issue_title", "milestone", "epic"]) {
      assert.ok(hold.question.includes(key), `question names ${key}`);
    }
    assert.equal(hold.options[0].costUsd, 0);

    const second = runCliSync(args, env);
    assert.equal(second.status, 0, `stderr: ${second.stderr}`);
    const secondJson = JSON.parse(second.stdout);
    assert.equal(secondJson.hold.id, "hold-1");
    assert.equal(secondJson.hold.created, false);
    assert.equal(readHoldsFile(fixture).holds.length, 1); // still exactly one
  } finally {
    cleanup(fixture);
  }
});

test("answering the hold stores user values, ignores unknown keys, and re-resolving is idempotent", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    const { supervisorLib, agentState } = await loadMods();
    const env = envWithoutLinear(fixture.env);
    const args = ["resolve", "--role", "dev", "--namespace", NS_CHILD, "--cwd", fixture.repo, "--json"];

    const first = runCliSync(args, env);
    assert.equal(first.status, 0, `stderr: ${first.stderr}`);
    assert.equal(JSON.parse(first.stdout).hold.id, "hold-1");

    supervisorLib.patchHold(RUN, "hold-1", {
      state: "answered",
      answer: { text: "milestone=M5\nepic=FOC-470\nbogus_key=zzz", answeredAt: NOW },
    });

    const second = runCliSync(args, env);
    assert.equal(second.status, 0, `stderr: ${second.stderr}`);
    const json = JSON.parse(second.stdout);
    const applied = Object.fromEntries((json.applied || []).map((entry) => [entry.key, entry]));
    assert.ok(applied.milestone, "milestone applied");
    assert.ok(applied.epic, "epic applied");
    assert.equal(applied.milestone.holdId, "hold-1");
    assert.equal(applied.epic.holdId, "hold-1");
    assert.deepEqual(json.ignored, [{ holdId: "hold-1", key: "bogus_key", reason: "unknown key" }]);
    // issue_title was already asked in hold-1, so no follow-up hold appears.
    assert.deepEqual(json.hold, { id: "hold-1", created: false, state: "answered" });
    assert.equal(readHoldsFile(fixture).holds.length, 1); // still exactly one

    const miss = runCliSync(["missing", "--role", "dev", "--namespace", NS_CHILD, "--json"], env);
    assert.equal(miss.status, 0, `stderr: ${miss.stderr}`);
    const missJson = JSON.parse(miss.stdout);
    assert.deepEqual(
      (missJson.missing || []).map((entry) => entry.key).sort(),
      ["candidate", "issue_title"],
    );
    const missByAsk = missingMap(missJson);
    assert.equal(missByAsk.issue_title.askIfMissing, true);
    assert.equal(missByAsk.candidate.askIfMissing, false);
    assert.equal(missJson.hold.id, "hold-1");
    assert.equal(missJson.hold.state, "answered");

    const store = agentState.openAgentState(fixture.dbPath);
    try {
      const facts = (key) =>
        store.db
          .prepare("SELECT value, source, evidence, version FROM facts WHERE namespace = ? AND key = ?")
          .get(NS_CHILD, key);
      for (const [key, value] of [["milestone", "M5"], ["epic", "FOC-470"]]) {
        const row = facts(key);
        assert.equal(row.value, value);
        assert.equal(row.source, "user");
        assert.equal(row.evidence, "hold hold-1");
      }
      const before = { milestone: facts("milestone").version, epic: facts("epic").version };

      const third = runCliSync(args, env);
      assert.equal(third.status, 0, `stderr: ${third.stderr}`);
      const thirdJson = JSON.parse(third.stdout);
      assert.ok(
        Array.isArray(thirdJson.applied) && thirdJson.applied.length === 0,
        `applied empty: ${JSON.stringify(thirdJson.applied)}`,
      );
      assert.equal(facts("milestone").version, before.milestone); // no version churn
      assert.equal(facts("epic").version, before.epic);
    } finally {
      store.close();
    }
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("a registry copy that gains a new askable key gets a follow-up hold naming only that key", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    const { supervisorLib, resolveMod } = await loadMods();
    const env = envWithoutLinear(fixture.env);
    const args = ["resolve", "--role", "dev", "--namespace", NS_CHILD, "--cwd", fixture.repo, "--json"];

    const first = runCliSync(args, env);
    assert.equal(first.status, 0, `stderr: ${first.stderr}`);
    assert.equal(JSON.parse(first.stdout).hold.id, "hold-1");

    supervisorLib.patchHold(RUN, "hold-1", {
      state: "answered",
      answer: { text: "milestone=M5\nepic=FOC-470", answeredAt: NOW },
    });

    // The registry copy gains one askable child key after hold-1 exists.
    const reg = JSON.parse(readFileSync(fixture.registryFile, "utf8"));
    reg.roles.child.extra_key = {
      description: "Askable key added after hold-1",
      resolvers: [],
      askIfMissing: true,
      refresh: "once",
    };
    writeFileSync(fixture.registryFile, JSON.stringify(reg, null, 2) + "\n");

    const second = runCliSync(args, env);
    assert.equal(second.status, 0, `stderr: ${second.stderr}`);
    const json = JSON.parse(second.stdout);
    assert.deepEqual(json.hold, { id: "hold-2", created: true });

    const holds = readHoldsFile(fixture);
    assert.equal(holds.holds.length, 2);
    const hold2 = holds.holds[1];
    assert.deepEqual(resolveMod.askedKeysOf(hold2), ["extra_key"]);
    assert.ok(!hold2.question.includes("issue_title"), "question names only the new key");
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("refresh: once keeps the user value over a later Linear fixture, always re-resolves branch", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    const { supervisorLib, agentState, registry } = await loadMods();
    const envNoLinear = envWithoutLinear(fixture.env);
    const args = ["resolve", "--role", "dev", "--namespace", NS_CHILD, "--cwd", fixture.repo, "--json"];

    // The registry contract behind the two behaviours under test.
    const baseReg = registry.loadRegistry(fixture.registryFile);
    const entryFor = (key) => new Map(registry.keysForRole(baseReg, "dev")).get(key);
    assert.equal(entryFor("branch").refresh, "always");
    assert.equal(entryFor("milestone").refresh, "once");

    const first = runCliSync(args, envNoLinear);
    assert.equal(first.status, 0, `stderr: ${first.stderr}`);
    assert.equal(JSON.parse(first.stdout).hold.id, "hold-1");

    supervisorLib.patchHold(RUN, "hold-1", {
      state: "answered",
      answer: { text: "milestone=M9\nepic=FOC-470", answeredAt: NOW },
    });

    const second = runCliSync(args, envNoLinear);
    assert.equal(second.status, 0, `stderr: ${second.stderr}`);

    const store = agentState.openAgentState(fixture.dbPath);
    try {
      const milestoneRow = () =>
        store.db
          .prepare("SELECT value, source, evidence FROM facts WHERE namespace = ? AND key = ?")
          .get(NS_CHILD, "milestone");
      let row = milestoneRow();
      assert.equal(row.value, "M9");
      assert.equal(row.source, "user");
      assert.equal(row.evidence, "hold hold-1");

      // The branch moves under the child's feet...
      execFileSync("git", ["checkout", "-q", "-b", "foc-9-y"], { cwd: fixture.repo, encoding: "utf8" });

      // ...and the next resolve (Linear fixture back in play) must NOT
      // overwrite the user value (refresh once) while the branch DOES move
      // (refresh always).
      const third = runCliSync(args, fixture.env);
      assert.equal(third.status, 0, `stderr: ${third.stderr}`);
      const thirdJson = JSON.parse(third.stdout);
      assert.equal(resolvedMap(thirdJson).milestone, undefined, "milestone not re-resolved");

      row = milestoneRow();
      assert.equal(row.value, "M9");
      assert.equal(row.source, "user");

      const branchEntry = resolvedMap(thirdJson).branch;
      assert.ok(branchEntry, "branch re-resolved");
      assert.equal(branchEntry.value, "foc-9-y");
      assert.equal(branchEntry.written, true);
    } finally {
      store.close();
    }
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("resolve --role supervisor reads STATE.md labels and Linear facts for the active issue", async () => {
  const fixture = makeFixture();
  try {
    const res = runCliSync(
      ["resolve", "--role", "supervisor", "--namespace", `supervisor:${RUN}`, "--cwd", fixture.repo, "--json"],
      fixture.env,
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const json = JSON.parse(res.stdout);
    const resolved = resolvedMap(json);

    assert.ok(resolved.active_issue, "active_issue resolved");
    assert.equal(resolved.active_issue.value, "FOC-9");
    assert.equal(resolved.active_issue.source, "state-md");
    assert.match(resolved.active_issue.evidence, /^docs\/STATE\.md:\d+$/);
    assert.equal(resolved.queue_head.value, "FOC-728 then FOC-729");
    assert.equal(resolved.known_reds.value, "cockpit-routes, task-sessions");
    assert.equal(resolved.active_milestone.value, "M5");
    assert.equal(resolved.active_milestone.source, "linear");
    assert.equal(resolved.active_epic.value, "FOC-470");
    assert.equal(resolved.active_epic.source, "linear");
    for (const key of ["landing_flow", "push_policy"]) {
      assert.ok(resolved[key], `${key} resolved`);
      assert.equal(resolved[key].source, "config");
    }
    assert.equal(resolved.cost_basis.value, "priced");
    assert.equal(resolved.cost_basis.source, "config");
    assert.deepEqual(json.missing || [], []);
    assert.equal(json.hold ?? null, null);
  } finally {
    cleanup(fixture);
  }
});

test("a secret-shaped resolver value counts as missing (VALUE_SECRET_SHAPED) and stores nothing", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    await loadMods();
    const secretRegistry = join(fixture.root, "agent-state-secret.json");
    const reg = JSON.parse(readFileSync(fixture.registryFile, "utf8"));
    reg.roles.all ??= {};
    reg.roles.all.repo = {
      description: "Repository basename",
      resolvers: [{ kind: "const", value: "-----BEGIN PRIVATE KEY-----" }],
      askIfMissing: false,
      refresh: "once",
    };
    writeFileSync(secretRegistry, JSON.stringify(reg, null, 2) + "\n");

    const res = runCliSync(
      ["resolve", "--role", "dev", "--namespace", NS_CHILD, "--cwd", fixture.repo, "--json"],
      { ...fixture.env, LA_AGENT_STATE_REGISTRY: secretRegistry },
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`); // missing is a state, not an error
    const json = JSON.parse(res.stdout);
    const missing = missingMap(json);
    assert.ok(missing.repo, "repo is missing");
    assert.equal(missing.repo.reason, "VALUE_SECRET_SHAPED");
    assert.equal(resolvedMap(json).repo, undefined);

    const { agentState } = await loadMods();
    const store = agentState.openAgentState(fixture.dbPath);
    try {
      const row = store.db
        .prepare("SELECT key FROM facts WHERE namespace = ? AND key = 'repo'")
        .get(NS_CHILD);
      assert.equal(row, undefined); // nothing stored for the refused value
    } finally {
      store.close();
    }
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("usage: resolve/missing refuse bad roles and namespaces; the store verbs still work", async () => {
  const fixture = makeFixture();
  try {
    const noRole = runCliSync(["resolve", "--namespace", NS_CHILD, "--json"], fixture.env);
    assert.equal(noRole.status, 2, `stderr: ${noRole.stderr}`);
    const bogusRole = runCliSync(
      ["resolve", "--role", "bogus", "--namespace", NS_CHILD, "--json"],
      fixture.env,
    );
    assert.equal(bogusRole.status, 2, `stderr: ${bogusRole.stderr}`);
    const noNamespace = runCliSync(["missing", "--role", "dev", "--json"], fixture.env);
    assert.equal(noNamespace.status, 2, `stderr: ${noNamespace.stderr}`);

    const set = runCliSync(
      ["set", "--namespace", "supervisor:smoke", "--key", "smoke_key", "--value", "v", "--reason", "r", "--json"],
      fixture.env,
    );
    assert.equal(set.status, 0, `stderr: ${set.stderr}`);
    const get = runCliSync(["get", "--namespace", "supervisor:smoke", "--key", "smoke_key", "--json"], fixture.env);
    assert.equal(get.status, 0, `stderr: ${get.stderr}`);
    assert.equal(JSON.parse(get.stdout).row.value, "v");
  } finally {
    cleanup(fixture);
  }
});

test("registry --json prints the validated key table with the registry path", async () => {
  const fixture = makeFixture();
  try {
    const res = runCliSync(["registry", "--json"], fixture.env);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const json = JSON.parse(res.stdout);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.roles.child), "roles.child is an array of entries");
    const issue = json.roles.child.find((entry) => entry.key === "issue");
    assert.ok(issue, "roles.child carries the issue entry");
    assert.ok(Array.isArray(issue.resolvers) && issue.resolvers.length > 0, "issue has resolvers");
    for (const resolver of issue.resolvers) {
      assert.equal(typeof resolver, "string", `resolver label is a string: ${JSON.stringify(resolver)}`);
    }
    assert.equal(basename(json.path), "agent-state.json");
  } finally {
    cleanup(fixture);
  }
});

test("registry validation names the offending arg/env/issueKey/template/key (FIX 6 a–f)", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    const { registry } = await loadMods();

    const writeVariant = (name, mutator) => {
      const reg = JSON.parse(readFileSync(fixture.registryFile, "utf8"));
      mutator(reg);
      const path = join(fixture.root, name);
      writeFileSync(path, JSON.stringify(reg, null, 2) + "\n");
      return path;
    };
    const invalid = (path, fragments) => {
      const err = errorCodeSync(() => registry.loadRegistry(path));
      assert.equal(err.code, "REGISTRY_INVALID");
      for (const fragment of fragments) {
        assert.ok(err.message.includes(fragment), `message has ${JSON.stringify(fragment)}: ${err.message}`);
      }
    };

    // (a) arg.name is an enum with the single value "role"
    invalid(
      writeVariant("registry-arg-name.json", (reg) => {
        reg.roles.child.issue.resolvers[0] = { kind: "arg", name: "task" };
      }),
      ["roles.child.issue.resolvers[0]", 'arg name must be "role"', '"task"'],
    );

    // (b) env.name must be a valid environment-variable name
    invalid(
      writeVariant("registry-env-name.json", (reg) => {
        reg.roles.all.la_root.resolvers[0].name = "bad-name";
      }),
      ["roles.all.la_root.resolvers[0]", 'env name "bad-name" must match'],
    );

    // (c) linear.issueKey must reference a declared key
    invalid(
      writeVariant("registry-issue-key.json", (reg) => {
        reg.roles.child.milestone.resolvers[0].issueKey = "isue";
      }),
      ["roles.child.milestone.resolvers[0]", 'issueKey "isue" is not a declared key'],
    );

    // (d) unknown sibling fields are rejected per kind
    invalid(
      writeVariant("registry-unknown-field.json", (reg) => {
        reg.roles.child.issue.resolvers[0].nam = "LA_TASK_ID";
      }),
      ['roles.child.issue.resolvers[0]: unknown field "nam" for kind "env"'],
    );

    // (e) template placeholders must be declared keys
    invalid(
      writeVariant("registry-template.json", (reg) => {
        reg.roles.child.acceptance_criteria_ref.resolvers[0].value =
          "linear issue {isue} § Acceptance criteria";
      }),
      ["roles.child.acceptance_criteria_ref.resolvers[0]", 'template placeholder "{isue}" is not a declared key'],
    );

    // (f) a key failing the key regex is reported with the key named
    invalid(
      writeVariant("registry-bad-key.json", (reg) => {
        reg.roles.child["Bad-Key"] = {
          description: "Key that fails the key regex",
          resolvers: [],
          askIfMissing: false,
          refresh: "once",
        };
      }),
      ['roles.child: key "Bad-Key" must match ^[a-z][a-z0-9_]{0,63}$'],
    );
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("hold answers parse last-wins, write each key once, and carry ignored reasons", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    const { supervisorLib, agentState } = await loadMods();
    const env = envWithoutLinear(fixture.env);
    const args = ["resolve", "--role", "dev", "--namespace", NS_CHILD, "--cwd", fixture.repo, "--json"];

    const first = runCliSync(args, env);
    assert.equal(first.status, 0, `stderr: ${first.stderr}`);
    assert.equal(JSON.parse(first.stdout).hold.id, "hold-1");

    supervisorLib.patchHold(RUN, "hold-1", {
      state: "answered",
      answer: { text: "milestone = M 5\r\nmilestone=M6\r\nepic=\r\nnoequals\r\nbogus_key=zzz", answeredAt: NOW },
    });

    const second = runCliSync(args, env);
    assert.equal(second.status, 0, `stderr: ${second.stderr}`);
    const json = JSON.parse(second.stdout);
    const applied = Object.fromEntries((json.applied || []).map((entry) => [entry.key, entry]));
    assert.ok(applied.milestone, "milestone applied");
    assert.equal(applied.milestone.holdId, "hold-1");
    assert.equal(applied.epic, undefined, "epic not applied (empty value)");

    // "no =" lines are reported while parsing; empty/unknown while writing.
    assert.deepEqual(json.ignored, [
      { holdId: "hold-1", key: "noequals", reason: "no =" },
      { holdId: "hold-1", key: "epic", reason: "empty" },
      { holdId: "hold-1", key: "bogus_key", reason: "unknown key" },
    ]);

    const store = agentState.openAgentState(fixture.dbPath);
    try {
      const row = (key) =>
        store.db
          .prepare("SELECT value, version, source, evidence FROM facts WHERE namespace = ? AND key = ?")
          .get(NS_CHILD, key);
      const milestone = row("milestone");
      assert.equal(milestone.value, "M6"); // last-wins over "M 5"
      assert.equal(milestone.version, 1); // written once
      assert.equal(milestone.source, "user");
      assert.equal(milestone.evidence, "hold hold-1");
      assert.equal(row("epic"), undefined); // empty value is never stored

      const again = runCliSync(args, env);
      assert.equal(again.status, 0, `stderr: ${again.stderr}`);
      assert.equal((JSON.parse(again.stdout).applied || []).length, 0, "second resolve applies nothing");
      assert.equal(row("milestone").version, 1, "no version churn");
    } finally {
      store.close();
    }
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("refresh: always keeps the stored value when every resolver fails (branch, git repo gone)", async () => {
  const fixture = makeFixture();
  try {
    const args = ["resolve", "--role", "dev", "--namespace", NS_CHILD, "--cwd", fixture.repo, "--json"];
    const first = runCliSync(args, fixture.env);
    assert.equal(first.status, 0, `stderr: ${first.stderr}`);

    // Both branch resolvers now fail: the cwd stops being a git repo and the
    // child record loses its spawn-time branch.
    const childrenPath = join(fixture.stateHome, RUN, "children.json");
    const children = JSON.parse(readFileSync(childrenPath, "utf8"));
    delete children.children.c1.branch;
    writeFileSync(childrenPath, JSON.stringify(children, null, 2) + "\n");
    const noGit = mkdtempSync(join(tmpdir(), "agent-state-nogit-"));

    const second = runCliSync(
      ["resolve", "--role", "dev", "--namespace", NS_CHILD, "--cwd", noGit, "--json"],
      fixture.env,
    );
    assert.equal(second.status, 0, `stderr: ${second.stderr}`);
    const json = JSON.parse(second.stdout);
    const branch = resolvedMap(json).branch;
    assert.ok(branch, "branch kept in resolved");
    assert.equal(branch.value, "foc-9-x");
    assert.equal(branch.source, "git");
    assert.equal(branch.evidence, "git rev-parse --abbrev-ref HEAD");
    assert.equal(branch.written, false);
    assert.equal(branch.kept, true);
    assert.equal(missingMap(json).branch, undefined, "branch not listed in missing");
    rmSync(noGit, { recursive: true, force: true });
  } finally {
    cleanup(fixture);
  }
});

test("an unresolved dependency names the key (depends on) and the hold question asks for the root cause", async () => {
  const fixture = makeFixture();
  const saved = applySeams(fixture.env);
  try {
    const { resolveMod } = await loadMods();
    // c1 loses taskId and the env loses LA_TASK_ID: the issue key itself is
    // unresolved, so every Linear/template consumer depends on it.
    const env = { ...fixture.env };
    delete env.LA_TASK_ID;
    const childrenPath = join(fixture.stateHome, RUN, "children.json");
    const children = JSON.parse(readFileSync(childrenPath, "utf8"));
    delete children.children.c1.taskId;
    writeFileSync(childrenPath, JSON.stringify(children, null, 2) + "\n");

    const res = runCliSync(
      ["resolve", "--role", "dev", "--namespace", NS_CHILD, "--cwd", fixture.repo, "--json"],
      env,
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const json = JSON.parse(res.stdout);
    const missing = missingMap(json);
    assert.ok(missing.issue, "issue missing");
    assert.equal(missing.issue.reason, "unresolved");
    for (const key of ["issue_title", "milestone", "epic", "acceptance_criteria_ref"]) {
      assert.ok(missing[key], `${key} missing`);
      assert.equal(missing[key].reason, "depends on issue");
    }

    const holds = readHoldsFile(fixture);
    assert.equal(holds.holds.length, 1);
    const asked = resolveMod.askedKeysOf(holds.holds[0]);
    // The askable keys plus the dependency root cause — even though `issue`
    // itself never asks.
    for (const key of ["issue_title", "milestone", "epic", "issue"]) {
      assert.ok(asked.includes(key), `hold question names ${key}`);
    }
  } finally {
    restoreSeams(saved);
    cleanup(fixture);
  }
});

test("verb delegation skips string-option values: -n <ns> resolve delegates, --namespace x resolve stays local", async () => {
  const fixture = makeFixture();
  try {
    // The namespace value must not be mistaken for the verb.
    const res = runCliSync(
      ["-n", "session:x1", "resolve", "--role", "dev", "--json"],
      fixture.env,
    );
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const json = JSON.parse(res.stdout);
    assert.equal(json.verb, "resolve");

    // An invalid namespace still fails as usage through the store CLI's own
    // validation (exit 2, no delegation side effects).
    const bad = runCliSync(["--namespace", "x", "resolve"], fixture.env);
    assert.equal(bad.status, 2, `stderr: ${bad.stderr}`);
  } finally {
    cleanup(fixture);
  }
});