// scripts/squad-start.test.mjs — the FOC-771 Node entry point (FOC-771).
//
// planLaunch is exercised pure over a mkdtemp fixture root (fake .env,
// config/models.json, config/native-models.json, config/dry-run-kickoffs.json,
// config/models.map, agents/<area> dirs); every subprocess in runLaunch goes
// through an injected spawn that records argv/env and returns scripted exit
// codes — the real claude binary is NEVER started, and no real repo path is
// written. CLI usage-error tests spawn the real script, which exits 2 before
// any side effect.
//
// Run: node scripts/test-run.mjs squad-start

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { claudeCommand, parseCliArgs, planLaunch, printablePlan, runLaunch } from "./squad-start.mjs";

const SCRIPTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const CLI = join(SCRIPTS_DIR, "squad-start.mjs");

// A developer shell may export LA_CLAUDE_BIN (a real claude path — the test
// seam). Tests must be hermetic: the fake-child spawnAsync records whatever
// claudeCommand resolves, and several assertions match the literal "claude".
// claudeCommand's own tests set and restore the variable explicitly.
delete process.env.LA_CLAUDE_BIN;

// The fixture provider key name is unique to this file, so a key that happens
// to exist in the developer's real environment can never leak into a fixture.
const FIXTURE_KEY = "SQUAD_START_FIXTURE_KEY";

const FIXTURE_MODELS = {
  providers: {
    testprov: {
      baseUrl: "https://fixture.example/api",
      authEnv: FIXTURE_KEY,
      authStyle: "token",
      defaultModel: "fixture/default-model",
      tiers: { opus: "fixture/opus", sonnet: "fixture/sonnet", haiku: "fixture/haiku", smallFast: "fixture/small" },
    },
  },
  ids: { glm53flash: "z-ai/glm-5.3-flash", glm: "z-ai/glm-5.2" },
  routing: {
    supervisor: { default: "glm" },
    plan: { worker: "glm53flash" },
    dev: { worker: "glm53flash" },
    review: { worker: "glm53flash" },
    test: { worker: "glm53flash" },
    cadence: { worker: "glm53flash" },
  },
};

const FIXTURE_NATIVE = {
  squads: {
    plan: { ANTHROPIC_MODEL: "claude-opus-4-8", ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001", ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5-20251001" },
    supervisor: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5-20251001", ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5-20251001" },
  },
  default: { ANTHROPIC_MODEL: "claude-opus-4-8", ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8" },
};

const FIXTURE_KICKOFFS = { plan: "kickoff plan", dev: "kickoff dev", review: "kickoff review", test: "kickoff test", cadence: "kickoff cadence" };

function makeRoot({ envFile = "", withAgentsDir = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "squad-start-"));
  const config = join(root, "config");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "models.json"), JSON.stringify(FIXTURE_MODELS));
  writeFileSync(join(config, "native-models.json"), JSON.stringify(FIXTURE_NATIVE));
  writeFileSync(join(config, "dry-run-kickoffs.json"), JSON.stringify(FIXTURE_KICKOFFS));
  writeFileSync(join(config, "models.map"), "dev.implementer=fixture/glm-52\n");
  if (envFile) writeFileSync(join(root, ".env"), envFile);
  if (withAgentsDir) mkdirSync(join(root, "agents", "dev"), { recursive: true });
  return root;
}

function baseEnv(root) {
  return {
    LA_PROVIDER: "testprov",
    LA_SQUAD_HOME: join(root, "agents"),
    LA_SETTINGS_FILE: join(root, "settings.json"),
    [FIXTURE_KEY]: "fixture-key",
  };
}

// A fake claude child for the async spawn: emits "exit" on the next microtask
// with the scripted code — the real claude binary is NEVER started.
const fakeChild = (status) => {
  const child = new EventEmitter();
  child.exitCode = null;
  queueMicrotask(() => {
    child.exitCode = status;
    child.emit("exit", status, null);
  });
  return child;
};

// claudeCommand resolves the host's claude (PATH's claude.exe on win32, or the
// test seam) — assertions label ANY claude resolution as "claude".
const isClaude = (command) => command === "claude" || /claude(\.exe|\.cmd)?$/i.test(String(command));
const seqOf = (calls) =>
  calls.map((c) =>
    c.command === process.execPath ? c.args[0].split(/[\\/]/).pop() : isClaude(c.command) ? "claude" : c.command,
  );

test("planLaunch dev — routing model, provider env applied, config dir, manifest shape", () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "dev", env: baseEnv(root), cwd: join(root, "cwd"), root, tty: false, claudeArgs: ["--model-flag"] });
    assert.equal(plan.mode, "interactive");
    assert.equal(plan.model, "z-ai/glm-5.3-flash"); // routing.dev.worker → ids.glm53flash
    assert.equal(plan.configDir, join(root, "agents", "dev"));
    assert.equal(plan.env.ANTHROPIC_BASE_URL, "https://fixture.example/api");
    assert.equal(plan.env.ANTHROPIC_AUTH_TOKEN, "fixture-key");
    assert.equal(plan.env.ANTHROPIC_API_KEY, ""); // inactive auth var cleared
    assert.equal(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "fixture/opus"); // provider tiers
    assert.equal(plan.env.LA_PROVIDER, "testprov");
    assert.equal(plan.env.API_TIMEOUT_MS, "3000000");
    assert.ok(!("CLAUDE_CODE_SUBAGENT_MODEL" in plan.env));
    assert.deepEqual(plan.claudeArgs, ["--model-flag"]);
    assert.deepEqual(plan.manifest, { squad: "dev", sourcePath: "", headless: false });
    assert.deepEqual(plan.steps.map((s) => s.kind), ["cost-guard", "manifest-gen", "manifest-start", "claude"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planLaunch dev --dry-run — dry-run env, fixed kickoff args, headless manifest, check.mjs post step", () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "dev", dryRun: true, env: baseEnv(root), cwd: join(root, "cwd"), root, claudeArgs: ["--ignored-in-dry"] });
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.env.DEV_DRY_RUN, "1");
    assert.equal(plan.manifest.headless, true);
    assert.deepEqual(plan.claudeArgs, ["-p", "kickoff dev", "--permission-mode", "default", "--max-turns", "40"]);
    const post = plan.steps.filter((s) => s.kind === "post");
    assert.equal(post.length, 1);
    assert.match(post[0].script, /check\.mjs$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planLaunch plan --native — every ANTHROPIC_* removed (env and .env leaks), plan.bat ids applied", () => {
  const root = makeRoot({ envFile: "ANTHROPIC_SMALL_FAST_MODEL=leaked-from-env\n" });
  try {
    const env = { ...baseEnv(root), ANTHROPIC_API_KEY: "leaked", ANTHROPIC_BASE_URL: "https://leak.example" };
    const plan = planLaunch({ squad: "plan", native: true, env, cwd: join(root, "cwd"), root });
    assert.equal(plan.env.ANTHROPIC_MODEL, "claude-opus-4-8");
    assert.equal(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-sonnet-4-6");
    assert.equal(plan.env.ANTHROPIC_SMALL_FAST_MODEL, "claude-haiku-4-5-20251001");
    assert.ok(!("ANTHROPIC_BASE_URL" in plan.env));
    assert.ok(!("ANTHROPIC_API_KEY" in plan.env));
    assert.equal(plan.env.NATIVE, "1");
    assert.ok(!("provider" in plan));
    assert.equal(plan.providerError, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planLaunch supervisor — LA_SUPERVISOR_REPO, fallback model, SUPERVISOR_MODEL override, no cost-guard, record step", () => {
  const root = makeRoot();
  try {
    const cwd = join(root, "target-repo");
    const plan = planLaunch({ squad: "supervisor", env: baseEnv(root), cwd, root });
    assert.equal(plan.env.LA_SUPERVISOR_REPO, cwd);
    // routing.supervisor.default=glm is the CHILDREN's alias — the frontman
    // runs on the built-in fallback when neither env nor the overlay decides.
    assert.equal(plan.model, "xiaomi/mimo-v2.6-pro");
    assert.ok(!plan.steps.some((s) => s.kind === "cost-guard")); // the frontman is the intervention channel
    const record = plan.steps.find((s) => s.kind === "record-current-run");
    assert.ok(record, "record-current-run step present");
    assert.deepEqual(record.args, ["record", "RUN_ID", "--model", "xiaomi/mimo-v2.6-pro"]);

    const overridden = planLaunch({ squad: "supervisor", env: { ...baseEnv(root), SUPERVISOR_MODEL: "fixture/super-model" }, cwd, root });
    assert.equal(overridden.model, "fixture/super-model");
    assert.equal(overridden.env.ANTHROPIC_MODEL, "fixture/super-model");

    // The settings overlay's routing.supervisor.lead outranks the fallback
    // (and the table's default is still ignored) — the frontman's chain.
    writeFileSync(join(root, "settings.json"), JSON.stringify({ routing: { supervisor: { lead: "fixture/overlay-lead" } } }));
    const overlayPlan = planLaunch({ squad: "supervisor", env: baseEnv(root), cwd, root });
    assert.equal(overlayPlan.model, "fixture/overlay-lead");

    // SUPERVISOR_MODEL beats even the overlay lead.
    const envOverOverlay = planLaunch({ squad: "supervisor", env: { ...baseEnv(root), SUPERVISOR_MODEL: "fixture/super-model" }, cwd, root });
    assert.equal(envOverOverlay.model, "fixture/super-model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("planLaunch --agent dev implement — models.map id, hardcoded anthropic tiers, role binding prompt", () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ agent: { area: "dev", role: "implementer" }, env: baseEnv(root), cwd: join(root, "cwd"), root, claudeArgs: ["extra-arg"] });
    assert.equal(plan.squad, "dev");
    assert.equal(plan.mode, "agent");
    assert.equal(plan.model, "fixture/glm-52");
    assert.equal(plan.env.ANTHROPIC_MODEL, "fixture/glm-52");
    assert.equal(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "anthropic/claude-opus-4.8");
    assert.equal(plan.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "anthropic/claude-sonnet-4.6");
    assert.equal(plan.claudeArgs[0], "--append-system-prompt");
    assert.match(plan.claudeArgs[1], /rola 'implementer' obszaru 'dev'/);
    assert.deepEqual(plan.claudeArgs.slice(2), ["extra-arg"]);
    assert.equal(plan.configDir, join(root, "agents", "dev"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(".env precedence — window-level LINEAR_TEAM_KEY/LINEAR_WORKSPACE win, every other .env value overrides", () => {
  const root = makeRoot({ envFile: "LINEAR_TEAM_KEY=ENVTEAM\nOTHER_VAR=fromenv\nSHARED=fromenv\n" });
  try {
    const env = { ...baseEnv(root), LINEAR_TEAM_KEY: "WINDOWTEAM", LINEAR_WORKSPACE: "WINSPACE", SHARED: "fromwindow" };
    const plan = planLaunch({ squad: "dev", env, cwd: join(root, "cwd"), root });
    assert.equal(plan.env.LINEAR_TEAM_KEY, "WINDOWTEAM");
    assert.equal(plan.env.LINEAR_WORKSPACE, "WINSPACE");
    assert.equal(plan.env.OTHER_VAR, "fromenv");
    assert.equal(plan.env.SHARED, "fromenv");
    assert.equal(plan.env[FIXTURE_KEY], "fixture-key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider failure — runLaunch exits 1 before any manifest write", async () => {
  const root = makeRoot();
  try {
    const env = { ...baseEnv(root) };
    delete env[FIXTURE_KEY]; // key missing → provider unresolvable
    const plan = planLaunch({ squad: "dev", env, cwd: join(root, "cwd"), root });
    assert.match(plan.providerError, /requires .* \(missing in environment or \.env\)/);

    const calls = [];
    const spawn = (command, args) => { calls.push({ command, args }); return { status: 0, stdout: "" }; };
    const code = await runLaunch(plan, { spawn, log: () => {} });
    assert.equal(code, 1);
    assert.ok(!calls.some((c) => (c.args ?? []).includes("gen-id")), "no manifest gen-id on provider failure");
    assert.ok(!calls.some((c) => (c.args ?? []).includes("start")), "no manifest start on provider failure");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runLaunch manifest sequence — gen-id → start → claude → end, end carries claude's exit 3", async () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "dev", env: baseEnv(root), cwd: join(root, "cwd"), root });
    const calls = [];
    const spawn = (command, args, opts) => {
      calls.push({ command, args, opts });
      if (args[1] === "gen-id") return { status: 0, stdout: "RUN-1\n" };
      return { status: 0, stdout: "" };
    };
    const spawnAsync = (command, args, opts) => {
      calls.push({ command, args, opts });
      return fakeChild(3);
    };
    const code = await runLaunch(plan, { spawn, spawnAsync, log: () => {} });
    assert.equal(code, 3);
    assert.deepEqual(seqOf(calls), ["cost-guard.mjs", "run-manifest.mjs", "run-manifest.mjs", "claude", "run-manifest.mjs"]);
    assert.deepEqual(calls[1].args, [calls[1].args[0], "gen-id", "dev"]);
    assert.deepEqual(calls[2].args.slice(1), ["start", "RUN-1", "dev", ""]); // interactive: no --headless
    assert.deepEqual(calls[4].args.slice(1), ["end", "RUN-1", "3"]);
    assert.equal(calls[3].opts.env.LA_RUN_ID, "RUN-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runLaunch dry run — start carries --headless and the post step's exit code wins (dev-dry.bat parity)", async () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "dev", dryRun: true, env: baseEnv(root), cwd: join(root, "cwd"), root });
    const calls = [];
    const spawn = (command, args, opts) => {
      calls.push({ command, args, opts });
      if (args[1] === "gen-id") return { status: 0, stdout: "RUN-D\n" };
      return { status: 0, stdout: "" }; // check.mjs (the post step) passed
    };
    const spawnAsync = (command, args, opts) => {
      calls.push({ command, args, opts });
      return fakeChild(3); // claude failed...
    };
    const code = await runLaunch(plan, { spawn, spawnAsync, log: () => {} });
    assert.equal(code, 0); // dev-dry.bat records the check.mjs exit code
    const start = calls.find((c) => c.args[1] === "start");
    assert.deepEqual(start.args.slice(1), ["start", "RUN-D", "dev", "", "--headless"]);
    const end = calls.find((c) => c.args[1] === "end");
    assert.deepEqual(end.args.slice(1), ["end", "RUN-D", "0"]);
    assert.equal(calls.find((c) => isClaude(c.command)).opts.env.DEV_DRY_RUN, "1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runLaunch — end is called when the claude spawn throws, exit 1", async () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "dev", env: baseEnv(root), cwd: join(root, "cwd"), root });
    const calls = [];
    const spawn = (command, args) => {
      calls.push({ command, args });
      if (args[1] === "gen-id") return { status: 0, stdout: "RUN-2\n" };
      return { status: 0, stdout: "" };
    };
    const spawnAsync = () => {
      throw new Error("boom");
    };
    const code = await runLaunch(plan, { spawn, spawnAsync, log: () => {} });
    assert.equal(code, 1);
    const end = calls.find((c) => c.args[1] === "end");
    assert.ok(end, "end recorded after the throw");
    assert.deepEqual(end.args.slice(1), ["end", "RUN-2", "1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runLaunch supervisor — LA_SUPERVISOR_RUN defaults to the run id, record step runs, source recorded", async () => {
  const root = makeRoot();
  try {
    const cwd = join(root, "target-repo");
    const plan = planLaunch({ squad: "supervisor", task: "FOC-771", env: baseEnv(root), cwd, root });
    assert.equal(plan.env.LA_TASK_ID, "FOC-771");
    assert.equal(plan.manifest.sourcePath, "FOC-771");

    const calls = [];
    const spawn = (command, args, opts) => {
      calls.push({ command, args, opts });
      if (args[1] === "gen-id") return { status: 0, stdout: "RUN-SUP\n" };
      return { status: 0, stdout: "" };
    };
    const spawnAsync = (command, args, opts) => {
      calls.push({ command, args, opts });
      return fakeChild(0);
    };
    const logs = [];
    const code = await runLaunch(plan, { spawn, spawnAsync, log: (line) => logs.push(line) });
    assert.equal(code, 0);
    const claude = calls.find((c) => isClaude(c.command));
    assert.equal(claude.opts.env.LA_SUPERVISOR_RUN, "RUN-SUP");
    assert.equal(claude.opts.env.LA_SUPERVISOR_REPO, cwd);
    const record = calls.find((c) => c.args[1] === "record");
    assert.ok(record, "supervisor-current-run record executed");
    assert.deepEqual(record.args.slice(1), ["record", "RUN-SUP", "--model", "xiaomi/mimo-v2.6-pro"]);
    assert.ok(logs.some((l) => l.includes("run=RUN-SUP issue=FOC-771")));
    assert.ok(logs.some((l) => l.includes(`CLAUDE_CONFIG_DIR=${join(root, "agents", "supervisor")}`)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runLaunch supervisor — record exit 3 (MANAGED_SESSIONS_ACTIVE) stops the launch with code 2, claude never spawned", async () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "supervisor", task: "FOC-901", env: baseEnv(root), cwd: join(root, "cwd"), root });
    const calls = [];
    const spawn = (command, args) => {
      calls.push({ command, args });
      if (args[1] === "gen-id") return { status: 0, stdout: "RUN-REF\n" };
      if (args[1] === "record") return { status: 3, stderr: "[refusal] 2 managed session(s) live; scoped command: fenix supervisor --task FOC-x" };
      return { status: 0, stdout: "" };
    };
    const spawnAsync = (command, args) => {
      calls.push({ command, args });
      return fakeChild(0);
    };
    const logs = [];
    const code = await runLaunch(plan, { spawn, spawnAsync, log: (line) => logs.push(line) });
    assert.equal(code, 2);
    assert.ok(!calls.some((c) => isClaude(c.command)), "claude never spawned");
    assert.ok(logs.some((l) => l.includes("[refusal] 2 managed session(s) live")), "the child's stderr is printed");
    assert.ok(logs.some((l) => l.includes("[supervisor] refused: managed sessions are active — see the message above, or set FENIX_SUPERVISOR_LEGACY=1 to adopt anyway")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runLaunch supervisor — record exit 1 stays warn-and-soft, the launch continues to claude", async () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "supervisor", task: "FOC-901", env: baseEnv(root), cwd: join(root, "cwd"), root });
    const calls = [];
    const spawn = (command, args) => {
      calls.push({ command, args });
      if (args[1] === "gen-id") return { status: 0, stdout: "RUN-WARN\n" };
      if (args[1] === "record") return { status: 1, stderr: "db busy" };
      return { status: 0, stdout: "" };
    };
    const spawnAsync = (command, args) => {
      calls.push({ command, args });
      return fakeChild(0);
    };
    const logs = [];
    const code = await runLaunch(plan, { spawn, spawnAsync, log: (line) => logs.push(line) });
    assert.equal(code, 0);
    assert.ok(calls.some((c) => isClaude(c.command)), "the launch continues to claude");
    assert.ok(logs.some((l) => l.includes("could not record the current run")), "the warning is logged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("printablePlan masks secret-looking env values", () => {
  const masked = printablePlan({ env: { LINEAR_API_KEY: "lin_api_x", GH_TOKEN: "t", MY_SECRET: "s", ANTHROPIC_AUTH_TOKEN: "tok", PLAIN: "value", EMPTY_KEY: "" } });
  assert.equal(masked.env.LINEAR_API_KEY, "<set>");
  assert.equal(masked.env.GH_TOKEN, "<set>");
  assert.equal(masked.env.MY_SECRET, "<set>");
  assert.equal(masked.env.ANTHROPIC_AUTH_TOKEN, "<set>");
  assert.equal(masked.env.PLAIN, "value");
  assert.equal(masked.env.EMPTY_KEY, "");
});

test("planLaunch --task sets LA_TASK_ID and the manifest source", () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "dev", task: "FOC-771", source: null, env: baseEnv(root), cwd: join(root, "cwd"), root });
    assert.equal(plan.env.LA_TASK_ID, "FOC-771");
    assert.equal(plan.manifest.sourcePath, "FOC-771");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI usage errors exit 2 (real script spawned; exits before any side effect)", () => {
  const cases = [
    [], // missing squad
    ["bogus-squad"],
    ["--agent", "dev"], // role missing
    ["supervisor", "--dry-run"], // no kickoff for the supervisor
    ["dev", "--task"], // value missing
    ["dev", "--bogus-flag"],
    ["dev", "a", "b", "c"], // second stray positional
    ["dev", "--source", "a.md", "positional"], // --source + positional source
    ["--agent", "dev", "implement", "--source", "a.md", "b.md"], // --source + the agent source
  ];
  for (const argv of cases) {
    const res = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8", timeout: 60000, windowsHide: true });
    assert.equal(res.status, 2, `argv ${JSON.stringify(argv)} → exit ${res.status}\nstderr: ${res.stderr}`);
  }
});

test("parseCliArgs splits flags and the `--` passthrough", () => {
  const options = parseCliArgs(["dev", "--dry-run", "--task", "T-9", "--", "--model", "m"]);
  assert.equal(options.squad, "dev");
  assert.equal(options.dryRun, true);
  assert.equal(options.task, "T-9");
  assert.deepEqual(options.claudeArgs, ["--model", "m"]);
  assert.throws(() => parseCliArgs(["dev", "--nope"]), /unknown option/);
});

test("parseCliArgs — the positional after <squad> is the source; --source is the flag form; both → exit 2", () => {
  const parsed = parseCliArgs(["dev", "kickoff text with spaces"]);
  assert.equal(parsed.squad, "dev");
  assert.equal(parsed.source, "kickoff text with spaces");
  assert.equal(parseCliArgs(["dev", "--source", "x.md"]).source, "x.md");
  assert.throws(() => parseCliArgs(["dev", "--source", "x.md", "positional"]), /mutually exclusive/);
  assert.throws(() => parseCliArgs(["supervisor", "--agent", "dev", "implement", "src"]), /before --agent/);
});

test("parseCliArgs — agent mode takes any number of positionals after <area> <role>: source first, rest forwarded", () => {
  // agent.bat %3–%9: the first is the source, the rest go to claude after it.
  const parsed = parseCliArgs(["--agent", "dev", "implement", "kickoff.md", "extra-one", "extra-two"]);
  assert.deepEqual(parsed.agent, { area: "dev", role: "implement" });
  assert.equal(parsed.source, "kickoff.md");
  assert.deepEqual(parsed.claudeArgs, ["extra-one", "extra-two"]);
  // Extras keep their argv order ahead of the `--` passthrough.
  const withDash = parseCliArgs(["--agent", "dev", "implement", "kickoff.md", "extra-one", "--", "--flag"]);
  assert.deepEqual(withDash.claudeArgs, ["extra-one", "--flag"]);
  // --source + positional source still collide.
  assert.throws(() => parseCliArgs(["--agent", "dev", "implement", "--source", "a.md", "b.md"]), /mutually exclusive/);
});

test("positional source (JOI-69) — recorded as sourcePath and forwarded to claude first (dev.bat claude %*)", async () => {
  const root = makeRoot();
  try {
    const parsed = parseCliArgs(["dev", "kickoff text with spaces"]);
    const plan = planLaunch({ squad: parsed.squad, source: parsed.source, env: baseEnv(root), cwd: join(root, "cwd"), root });
    assert.equal(plan.manifest.sourcePath, "kickoff text with spaces");
    assert.equal(plan.claudeArgs[0], "kickoff text with spaces");

    // --source is the flag form: recorded and forwarded the same way.
    const flagged = planLaunch({ squad: "dev", source: "x.md", env: baseEnv(root), cwd: join(root, "cwd"), root });
    assert.equal(flagged.manifest.sourcePath, "x.md");
    assert.deepEqual(flagged.claudeArgs, ["x.md"]);

    // The recorded spawn argv carries it on manifest start and as claude's first arg.
    const calls = [];
    const spawn = (command, args, opts) => {
      calls.push({ command, args, opts });
      if (args[1] === "gen-id") return { status: 0, stdout: "RUN-POS\n" };
      return { status: 0, stdout: "" };
    };
    const spawnAsync = (command, args, opts) => {
      calls.push({ command, args, opts });
      return fakeChild(0);
    };
    const code = await runLaunch(plan, { spawn, spawnAsync, log: () => {} });
    assert.equal(code, 0);
    const start = calls.find((c) => c.args[1] === "start");
    assert.deepEqual(start.args.slice(1), ["start", "RUN-POS", "dev", "kickoff text with spaces"]);
    assert.equal(calls.find((c) => isClaude(c.command)).args[0], "kickoff text with spaces");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dry-run ignores the source positional (old *-dry.bat: SOURCE_PATH hard-empty, fixed kickoff, no %* forward)", () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "dev", dryRun: true, source: "x", env: baseEnv(root), cwd: join(root, "cwd"), root });
    assert.equal(plan.manifest.sourcePath, "");
    assert.deepEqual(plan.claudeArgs, ["-p", "kickoff dev", "--permission-mode", "default", "--max-turns", "40"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--agent dev implement kickoff.md — the third positional is the source (agent.bat %3), forwarded after the role prompt", () => {
  const root = makeRoot();
  try {
    const parsed = parseCliArgs(["--agent", "dev", "implement", "kickoff.md"]);
    assert.deepEqual(parsed.agent, { area: "dev", role: "implement" });
    assert.equal(parsed.source, "kickoff.md");
    const plan = planLaunch({ agent: parsed.agent, source: parsed.source, env: baseEnv(root), cwd: join(root, "cwd"), root, claudeArgs: ["extra-arg"] });
    assert.equal(plan.manifest.sourcePath, "kickoff.md");
    assert.equal(plan.claudeArgs[0], "--append-system-prompt");
    assert.match(plan.claudeArgs[1], /rola 'implement' obszaru 'dev'/);
    // agent.bat: claude --append-system-prompt "…" %3 %4 … — the source leads the rest.
    assert.deepEqual(plan.claudeArgs.slice(2), ["kickoff.md", "extra-arg"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervisor positional — recorded and forwarded like supervisor.bat's claude %*", () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "supervisor", source: "kickoff for the run", env: baseEnv(root), cwd: join(root, "cwd"), root });
    assert.equal(plan.manifest.sourcePath, "kickoff for the run");
    assert.deepEqual(plan.claudeArgs, ["kickoff for the run"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real CLI --print-plan with a positional — the dashboard JOI-69 path, no claude started", () => {
  const res = spawnSync(process.execPath, [CLI, "dev", "--print-plan", "hello world"], { encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const printed = JSON.parse(res.stdout);
  assert.equal(printed.manifest.sourcePath, "hello world");
  assert.equal(printed.claudeArgs[0], "hello world");
});

// FOC-1105: the FOC-771 port echoed CLAUDE_CONFIG_DIR but never set it, and the
// only assertion matched the echo. These check the env the claude child gets.
test("CLAUDE_CONFIG_DIR is set in the child env for every squad (FOC-1105)", () => {
  const root = makeRoot();
  try {
    for (const squad of ["plan", "dev", "review", "test", "cadence", "supervisor"]) {
      const plan = planLaunch({ squad, env: baseEnv(root), cwd: join(root, "cwd"), root, tty: false });
      assert.equal(plan.env.CLAUDE_CONFIG_DIR, join(root, "agents", squad), `${squad}: child env`);
      assert.equal(plan.env.CLAUDE_CONFIG_DIR, plan.configDir, `${squad}: matches the echoed dir`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLAUDE_CONFIG_DIR — --agent uses the area dir; an inherited value never wins (FOC-1105)", () => {
  const root = makeRoot();
  try {
    const inherited = { ...baseEnv(root), CLAUDE_CONFIG_DIR: join(root, "operator-home", ".claude") };
    const agent = planLaunch({ agent: { area: "dev", role: "implementer" }, env: inherited, cwd: join(root, "cwd"), root });
    assert.equal(agent.env.CLAUDE_CONFIG_DIR, join(root, "agents", "dev"));
    const sup = planLaunch({ squad: "supervisor", env: inherited, cwd: join(root, "cwd"), root, tty: false });
    assert.equal(sup.env.CLAUDE_CONFIG_DIR, join(root, "agents", "supervisor"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runLaunch hands CLAUDE_CONFIG_DIR to the spawned claude, not just the log (FOC-1105)", async () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "dev", env: baseEnv(root), cwd: join(root, "cwd"), root, tty: false });
    const calls = [];
    const spawn = (command, args, opts) => {
      calls.push({ command, args, opts });
      return { status: 0, stdout: args[1] === "gen-id" ? "RUN-1105\n" : "", stderr: "" };
    };
    const spawnAsync = (command, args, opts) => {
      calls.push({ command, args, opts });
      return fakeChild(0);
    };
    const code = await runLaunch(plan, { spawn, spawnAsync, log: () => {} });
    assert.equal(code, 0);
    const claude = calls.find((c) => isClaude(c.command));
    assert.ok(claude, "claude spawned");
    assert.equal(claude.opts.env.CLAUDE_CONFIG_DIR, join(root, "agents", "dev"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LA_ROOT and ROOT are exported into the child env (telemetry-hook MCP, CLAUDE.md commands, supervisor-spawn)", () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "dev", env: baseEnv(root), cwd: join(root, "cwd"), root });
    assert.equal(plan.env.LA_ROOT, root);
    assert.equal(plan.env.ROOT, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// FOC-772: the integrations switch is ON here — the render path is unchanged
// when the overlay enables Atlas. The injected read is readIntegrationsSafe's
// exact result shape, so planLaunch stays pure.
const INTEGRATIONS_ON = { atlas: true, pisi: false, memory: false, nebul: false, source: "overlay" };

test("atlas-render — template present + json absent → written with placeholders expanded from env", async () => {
  const root = makeRoot();
  try {
    writeFileSync(
      join(root, "config", "atlas-mcp.json.template"),
      JSON.stringify({ cmd: "{{SQUAD_ATLAS_TEST_VAR}}", keep: "{{SQUAD_ATLAS_MISSING_X}}" }),
      "utf8",
    );
    const env = { ...baseEnv(root), SQUAD_ATLAS_TEST_VAR: "C:\\atlas\\venv\\python.exe" };
    const plan = planLaunch({ squad: "dev", env, cwd: join(root, "cwd"), root, integrations: INTEGRATIONS_ON });
    const step = plan.steps.find((s) => s.kind === "atlas-render");
    assert.ok(step, "atlas-render step planned");

    const calls = [];
    const spawn = (command, args, opts) => { calls.push({ command, args, opts }); return { status: 0, stdout: "RUN-A\n" }; };
    const spawnAsync = (command, args, opts) => { calls.push({ command, args, opts }); return fakeChild(0); };
    const code = await runLaunch(plan, { spawn, spawnAsync, log: () => {} });
    assert.equal(code, 0);
    const written = JSON.parse(readFileSync(join(root, "config", "atlas-mcp.json"), "utf8"));
    assert.deepEqual(written, { cmd: "C:\\atlas\\venv\\python.exe", keep: "{{SQUAD_ATLAS_MISSING_X}}" });
    assert.ok(calls.some((c) => isClaude(c.command)), "claude still ran after the render");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atlas-render — invalid template JSON warns and the run continues, no file written", async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "config", "atlas-mcp.json.template"), "{ not json {{SQUAD_ATLAS_TEST_VAR}} }", "utf8");
    const env = { ...baseEnv(root), SQUAD_ATLAS_TEST_VAR: "x" };
    const plan = planLaunch({ squad: "dev", env, cwd: join(root, "cwd"), root, integrations: INTEGRATIONS_ON });
    const calls = [];
    const spawn = (command, args, opts) => { calls.push({ command, args, opts }); return { status: 0, stdout: "RUN-B\n" }; };
    const spawnAsync = (command, args, opts) => { calls.push({ command, args, opts }); return fakeChild(0); };
    const logs = [];
    const code = await runLaunch(plan, { spawn, spawnAsync, log: (l) => logs.push(l) });
    assert.equal(code, 0);
    assert.ok(!existsSync(join(root, "config", "atlas-mcp.json")), "no output written from a broken template");
    assert.ok(logs.some((l) => l.includes("invalid JSON")), "the failure was logged");
    assert.ok(calls.some((c) => isClaude(c.command)), "the run continued past the render");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atlas-off (FOC-772) — no settings overlay: off by default, atlas-off planned, stale output deleted, no render", async () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "config", "atlas-mcp.json.template"), "{}", "utf8");
    // A stale rendered config from before the switch was flipped off.
    writeFileSync(join(root, "config", "atlas-mcp.json"), '{"stale":true}', "utf8");
    const plan = planLaunch({ squad: "dev", env: baseEnv(root), cwd: join(root, "cwd"), root });
    const step = plan.steps.find((s) => s.kind === "atlas-off");
    assert.ok(step, "atlas-off step planned");
    assert.equal(step.reason, "off");
    assert.equal(step.outputPath, join(root, "config", "atlas-mcp.json"));
    assert.ok(!plan.steps.some((s) => s.kind === "atlas-render"), "no render step when off");
    // --print-plan lists the step like the others.
    assert.ok(printablePlan(plan).steps.some((s) => s.kind === "atlas-off"), "atlas-off in the printed plan");

    const calls = [];
    const spawn = (command, args, opts) => { calls.push({ command, args, opts }); return { status: 0, stdout: "RUN-OFF\n" }; };
    const spawnAsync = (command, args, opts) => { calls.push({ command, args, opts }); return fakeChild(0); };
    const logs = [];
    const code = await runLaunch(plan, { spawn, spawnAsync, log: (l) => logs.push(l) });
    assert.equal(code, 0, "Atlas off is never fatal");
    assert.ok(logs.some((l) => l === "[info] Atlas integration off - config/atlas-mcp.json not rendered"), `logs: ${JSON.stringify(logs)}`);
    assert.ok(!existsSync(step.outputPath), "the stale output was deleted");
    assert.ok(!existsSync(join(root, "config", "atlas-mcp.json")), "nothing was rendered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atlas-off (FOC-772) — enabled overlay: the real safe read plans the render, no atlas-off step", () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "config", "atlas-mcp.json.template"), "{}", "utf8");
    // No injection here: the overlay file drives readIntegrationsSafe.
    writeFileSync(join(root, "settings.json"), JSON.stringify({ integrations: { atlas: true } }), "utf8");
    const plan = planLaunch({ squad: "dev", env: baseEnv(root), cwd: join(root, "cwd"), root });
    const step = plan.steps.find((s) => s.kind === "atlas-render");
    assert.ok(step, "atlas-render step planned when the overlay enables atlas");
    assert.ok(!plan.steps.some((s) => s.kind === "atlas-off"), "no atlas-off step when enabled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atlas-off (FOC-772) — corrupt overlay: check-failed reason, the WARN line, stale output deleted", async () => {
  const root = makeRoot();
  const originalError = console.error;
  const originalWarn = console.warn;
  const errors = [];
  const warns = [];
  console.error = (...args) => errors.push(args.join(" "));
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    writeFileSync(join(root, "config", "atlas-mcp.json.template"), "{}", "utf8");
    writeFileSync(join(root, "config", "atlas-mcp.json"), '{"stale":true}', "utf8");
    writeFileSync(join(root, "settings.json"), "{ not json", "utf8");
    const plan = planLaunch({ squad: "dev", env: baseEnv(root), cwd: join(root, "cwd"), root });
    const step = plan.steps.find((s) => s.kind === "atlas-off");
    assert.ok(step, "atlas-off step planned");
    assert.equal(step.reason, "check-failed", "a corrupt overlay is check-failed, not a plain off");
    assert.ok(!plan.steps.some((s) => s.kind === "atlas-render"), "no render on a failed check");

    const calls = [];
    const spawn = (command, args, opts) => { calls.push({ command, args, opts }); return { status: 0, stdout: "RUN-CHK\n" }; };
    const spawnAsync = (command, args, opts) => { calls.push({ command, args, opts }); return fakeChild(0); };
    const logs = [];
    const code = await runLaunch(plan, { spawn, spawnAsync, log: (l) => logs.push(l) });
    assert.equal(code, 0, "a failed check still launches");
    assert.ok(logs.some((l) => l === "[WARN] Atlas integration check failed - treating Atlas as off."), `logs: ${JSON.stringify(logs)}`);
    assert.ok(!existsSync(step.outputPath), "the stale output was deleted");
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt settings overlay — the plan is still produced from the routing table, ONE stderr warning", () => {
  const root = makeRoot();
  const originalError = console.error;
  const warnings = [];
  console.error = (...args) => warnings.push(args.join(" "));
  try {
    writeFileSync(join(root, "settings.json"), "{ not json", "utf8");
    const plan = planLaunch({ squad: "dev", env: baseEnv(root), cwd: join(root, "cwd"), root });
    assert.equal(plan.model, "z-ai/glm-5.3-flash"); // the routing table still decides
    assert.equal(plan.routingError, undefined);
    assert.equal(warnings.filter((w) => w.includes("[warn] settings invalid")).length, 1, `warnings: ${JSON.stringify(warnings)}`);
  } finally {
    console.error = originalError;
    rmSync(root, { recursive: true, force: true });
  }
});

test("LA_SETTINGS_FILE set only in .env is honoured for routing (read through the merged env)", () => {
  const root = makeRoot();
  try {
    const overlayPath = join(root, "overlay", "settings.json");
    mkdirSync(join(root, "overlay"), { recursive: true });
    writeFileSync(overlayPath, JSON.stringify({ routing: { dev: { lead: "fixture/overlay-model" } } }), "utf8");
    writeFileSync(join(root, ".env"), `LA_SETTINGS_FILE=${overlayPath}\n`, "utf8");
    const env = { ...baseEnv(root) };
    delete env.LA_SETTINGS_FILE; // only .env names the overlay
    const plan = planLaunch({ squad: "dev", env, cwd: join(root, "cwd"), root });
    assert.equal(plan.model, "fixture/overlay-model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NATIVE=1 from the merged env selects the native branch (--native flag still works)", () => {
  const root = makeRoot();
  const rootFromEnvFile = makeRoot({ envFile: "NATIVE=1\n" });
  try {
    // Window-level NATIVE=1.
    const plan = planLaunch({ squad: "dev", env: { ...baseEnv(root), NATIVE: "1" }, cwd: join(root, "cwd"), root });
    assert.equal(plan.native, true);
    assert.equal(plan.env.ANTHROPIC_MODEL, "claude-opus-4-8"); // config/native-models.json default ids
    assert.ok(!("ANTHROPIC_BASE_URL" in plan.env));

    // NATIVE=1 from .env alone.
    const planFromEnvFile = planLaunch({ squad: "dev", env: baseEnv(rootFromEnvFile), cwd: join(rootFromEnvFile, "cwd"), root: rootFromEnvFile });
    assert.equal(planFromEnvFile.native, true);
    assert.equal(planFromEnvFile.env.ANTHROPIC_MODEL, "claude-opus-4-8");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(rootFromEnvFile, { recursive: true, force: true });
  }
});

test("a squad with no routing lead refuses instead of inheriting the supervisor's model", async () => {
  const root = makeRoot();
  try {
    const models = JSON.parse(JSON.stringify(FIXTURE_MODELS));
    delete models.routing.dev;
    delete models.providers.testprov.defaultModel;
    writeFileSync(join(root, "config", "models.json"), JSON.stringify(models));

    const plan = planLaunch({ squad: "dev", env: baseEnv(root), cwd: join(root, "cwd"), root });
    assert.match(plan.routingError, /no routing lead for dev — check config\/models\.json routing\.dev or the settings overlay/);

    const calls = [];
    const spawn = (command, args, opts) => { calls.push({ command, args, opts }); return { status: 0, stdout: "" }; };
    const spawnAsync = (command, args, opts) => { calls.push({ command, args, opts }); return fakeChild(0); };
    const logs = [];
    const code = await runLaunch(plan, { spawn, spawnAsync, log: (l) => logs.push(l) });
    assert.equal(code, 1);
    assert.ok(!calls.some((c) => (c.args ?? []).includes("gen-id")), "no manifest write on a routing refusal");
    assert.ok(logs.some((l) => l.includes("no routing lead for dev")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGINT is forwarded to the claude child; end runs once with 130", async () => {
  const root = makeRoot();
  try {
    const plan = planLaunch({ squad: "dev", env: baseEnv(root), cwd: join(root, "cwd"), root });
    const calls = [];
    const spawn = (command, args, opts) => {
      calls.push({ command, args, opts });
      if (args[1] === "gen-id") return { status: 0, stdout: "RUN-SIG\n" };
      return { status: 0, stdout: "" };
    };
    // A claude that hangs until it is killed.
    const killed = [];
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = (signal) => {
      killed.push(signal);
      child.emit("exit", null, signal);
    };
    const spawnAsync = (command, args, opts) => {
      calls.push({ command, args, opts });
      return child;
    };
    const exits = [];
    const pending = runLaunch(plan, { spawn, spawnAsync, log: () => {}, exit: (code) => exits.push(code) });
    while (!calls.some((c) => isClaude(c.command))) await new Promise((resolve) => setImmediate(resolve));
    // Real signal delivery passes the signal name as the listener argument.
    process.emit("SIGINT", "SIGINT");
    const code = await pending;
    assert.deepEqual(killed, ["SIGINT"], "the signal was forwarded to the child");
    const ends = calls.filter((c) => c.args[1] === "end");
    assert.equal(ends.length, 1, "end runs exactly once");
    assert.deepEqual(ends[0].args.slice(1), ["end", "RUN-SIG", "130"]);
    assert.deepEqual(exits, [130]);
    assert.equal(code, 130);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claudeCommand — win32: claude.exe on PATH wins, claude.cmd is cmd.exe-wrapped (FOC-779 quoting)", { skip: process.platform !== "win32" && "win32 only" }, () => {
  const binDir = mkdtempSync(join(tmpdir(), "claude-bin-"));
  const originalPath = process.env.PATH;
  const originalBin = process.env.LA_CLAUDE_BIN;
  try {
    delete process.env.LA_CLAUDE_BIN;
    writeFileSync(join(binDir, "claude.cmd"), "@echo off\r\n");
    // ONLY the temp dir on PATH: the host's real claude.exe must not win.
    process.env.PATH = binDir;

    // Only a .cmd shim on PATH → cmd.exe /d /s /c with the resolved absolute
    // path; the /s rule wraps the whole line in one more quote pair.
    let resolved = claudeCommand(["--model", "m"]);
    assert.equal(resolved.command, process.env.ComSpec || "cmd.exe");
    assert.deepEqual(resolved.args.slice(0, 3), ["/d", "/s", "/c"]);
    const expectedLine = `"${[join(binDir, "claude.cmd"), "--model", "m"].map((a) => `"${a}"`).join(" ")}"`;
    assert.equal(resolved.args[3], expectedLine, `line: ${resolved.args[3]}`);
    assert.deepEqual(resolved.spawnOptions, { windowsVerbatimArguments: true });

    // claude.exe on PATH beats the .cmd shim — a direct, no-shell spawn.
    writeFileSync(join(binDir, "claude.exe"), "not really claude");
    resolved = claudeCommand(["--model", "m"]);
    assert.equal(resolved.command, join(binDir, "claude.exe"));
    assert.deepEqual(resolved.args, ["--model", "m"]);

    // LA_CLAUDE_BIN naming a .cmd goes through cmd.exe too; .mjs stays under node.
    writeFileSync(join(binDir, "shim.cmd"), "@echo off\r\n");
    writeFileSync(join(binDir, "shim.mjs"), "process.exit(0);\n");
    process.env.LA_CLAUDE_BIN = join(binDir, "shim.cmd");
    resolved = claudeCommand([]);
    assert.equal(resolved.command, process.env.ComSpec || "cmd.exe");
    assert.equal(resolved.args[3], `"${`"${join(binDir, "shim.cmd")}"`}"`);
    process.env.LA_CLAUDE_BIN = join(binDir, "shim.mjs");
    resolved = claudeCommand(["x"]);
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.args, [join(binDir, "shim.mjs"), "x"]);
  } finally {
    process.env.PATH = originalPath;
    if (originalBin === undefined) delete process.env.LA_CLAUDE_BIN;
    else process.env.LA_CLAUDE_BIN = originalBin;
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("claudeCommand — the cmd.exe line actually launches a .cmd shim and delivers quoted args", { skip: process.platform !== "win32" && "win32 only" }, () => {
  const binDir = mkdtempSync(join(tmpdir(), "claude-bin-"));
  const originalPath = process.env.PATH;
  const originalBin = process.env.LA_CLAUDE_BIN;
  try {
    delete process.env.LA_CLAUDE_BIN;
    // A fake shim (never the real claude) that echoes its argument line back.
    writeFileSync(join(binDir, "claude.cmd"), "@echo off\r\necho %*\r\n");
    // PATH holds the fake shim's dir plus the system dirs cmd.exe needs — the
    // host's real claude.exe (elsewhere on the real PATH) must not win.
    process.env.PATH = `${binDir};C:\\Windows\\System32;C:\\Windows`;
    const resolved = claudeCommand(["arg-one", "arg two"]);
    // Exactly what runLaunch passes: the resolved command/args plus its spawn
    // options (the verbatim flag is part of the working cmd.exe invocation).
    const res = spawnSync(resolved.command, resolved.args, {
      encoding: "utf8",
      windowsHide: true,
      ...resolved.spawnOptions,
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.ok((res.stdout || "").includes("arg-one"), `stdout: ${res.stdout}`);
    assert.ok((res.stdout || "").includes("arg two"), `stdout: ${res.stdout}`);
  } finally {
    process.env.PATH = originalPath;
    if (originalBin === undefined) delete process.env.LA_CLAUDE_BIN;
    else process.env.LA_CLAUDE_BIN = originalBin;
    rmSync(binDir, { recursive: true, force: true });
  }
});
