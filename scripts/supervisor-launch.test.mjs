// Tests for supervisor-launch.mjs — the Supervisor's own launch wrapper.
//
// One Supervisor keeps ONE canonical config dir (its CLAUDE_CONFIG_DIR, with
// the session history it resumes from). Each process launch:
//   · snapshots the tool profile + squad sources into a fresh launch-owned
//     outputDir (per-process, immutable);
//   · copies settings.json / snapshot.json / agents/ from that snapshot into
//     the canonical dir — refreshing settings on the next launch;
//   · prunes launch-copied role markdown the fresh snapshot no longer carries
//     (a removed source role), fail-closed on anything it cannot prove;
//   · never touches the canonical projects/ history and never copies auth or
//     history out of the shared squad dir;
//   · installs runtime hooks exactly once, even across relaunches.
//
// All tests operate on fixtures in a temp directory, NEVER on real repo files.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = pathToFileURL(join(__dirname, "supervisor-launch.mjs")).href;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

const THOUGHTMAP = {
  enabled: true,
  baseUrl: "http://thoughtmap-app:8585",
  ollamaBaseUrl: "http://thoughtmap-ollama:11434",
  embeddingModel: "qwen3-embedding:8b",
  clustersPath: "/fenix-integrations/thoughtmap/clusters.json",
};

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "supervisor-launch-test-"));
  const squadDir = join(root, "squad-home", "supervisor");
  mkdirSync(squadDir, { recursive: true });
  mkdirSync(join(squadDir, "agents"), { recursive: true });
  writeFileSync(join(squadDir, "CLAUDE.md"), "# Supervisor squad.\n", "utf8");
  writeFileSync(
    join(squadDir, "settings.json"),
    JSON.stringify({ model: "z-ai/glm-5.2" }, null, 2) + "\n",
    "utf8"
  );
  writeFileSync(
    join(squadDir, "agents", "lead.md"),
    "---\nname: lead\nmodel: z-ai/glm-5.2\ntools: Read, Bash\n---\nLead body.\n",
    "utf8"
  );
  writeRegistry(root, { ...THOUGHTMAP, enabled: false });
  return root;
}

function writeRegistry(root, thoughtmap, extra = {}) {
  writeFileSync(
    join(root, "tool-profiles.json"),
    JSON.stringify({ version: 1, revision: 1, mcp: { thoughtmap }, ...extra }, null, 2) + "\n",
    "utf8"
  );
}

function launchEnv(root, { sessionId = null } = {}) {
  const env = {
    CLAUDE_CONFIG_DIR: join(root, "canonical"),
    LA_SQUAD_HOME: join(root, "squad-home"),
    LA_TOOL_PROFILES_FILE: join(root, "tool-profiles.json"),
  };
  if (sessionId) {
    env.FENIX_SUPERVISOR_SESSION_ID = sessionId;
    env.LA_TASK_KEY = "task-1";
    env.LA_TASK_ID = "FOC-123";
    env.LA_SUPERVISOR_RUN = "run-1";
  }
  return env;
}

/** The value following a CLI flag, or null. */
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

/** The launch-profile.json metadata written next to the canonical dir. */
function launchProfile(root) {
  return JSON.parse(readFileSync(join(root, "launch-profile.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  const { prepareSupervisorLaunch, resolveSupervisorPermissionMode, supervisorClaudeArgv } = await import(MODULE_PATH);

  // ---- Test 1: refuses without CLAUDE_CONFIG_DIR ----
  {
    let error = null;
    try {
      prepareSupervisorLaunch({});
    } catch (err) {
      error = err;
    }
    assert(error !== null, "no CLAUDE_CONFIG_DIR: launch refused");
    assert(/CLAUDE_CONFIG_DIR/.test(error?.message ?? ""), "no CLAUDE_CONFIG_DIR: error names the variable");
  }

  // ---- Test 2: legacy launch — snapshot args, initial profile ----
  {
    const root = buildFixture();
    const env = launchEnv(root);
    const launch = prepareSupervisorLaunch(env);
    assertEq(launch.profile.squad, "supervisor", "legacy: squad is supervisor");
    assertEq(launch.profile.role, "lead", "legacy: role is lead");
    assertEq(launch.profileInitial, true, "legacy: first launch is the initial profile");
    assertEq(launch.changes.length, 0, "legacy: no changes on the initial profile");
    assertEq(launch.profile.tools, null, "legacy: no registry override → tools null");

    const meta = launchProfile(root);
    assert(typeof meta.outputDir === "string", "legacy: launch-profile.json names the outputDir");
    const mcpConfigPath = argValue(launch.cliArgs, "--mcp-config");
    assertEq(mcpConfigPath, join(meta.outputDir, "mcp.json"), "legacy: --mcp-config points into the launch-owned dir");
    assert(existsSync(mcpConfigPath), "legacy: mcp.json exists in the outputDir");
    assert(existsSync(join(meta.outputDir, "snapshot.json")), "legacy: snapshot.json exists in the outputDir");

    assertEq(argValue(launch.cliArgs, "--tools"), null, "legacy: no --tools arg (tools null)");
    assertEq(
      argValue(launch.cliArgs, "--disallowedTools"),
      null,
      "legacy: no --disallowedTools — a global deny would also block tools granted to native workers"
    );
    const legacyMcp = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    // The registry-controlled thoughtmap server stays off in the legacy flow
    // (FOC-943: the Supervisor's fenix-linear / fenix-github adapters are
    // always-on and NOT registry-controlled — they are the only servers here).
    assertEq(
      Object.keys(legacyMcp.mcpServers ?? {}).sort().join(","),
      "fenix-github,fenix-lifecycle,fenix-linear",
      "legacy: a disabled registry server is exposed to no one (only the always-on Fenix adapters ride the snapshot)",
    );
    assert(
      !JSON.stringify(legacyMcp).includes("THOUGHTMAP_ALLOWED_TOOLS"),
      "legacy: no server-side subset without a server"
    );
    assertEq(
      launch.env.THOUGHTMAP_API_URL,
      undefined,
      "legacy: no thoughtmap env when the server is disabled"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 3: the snapshot lands in the canonical dir ----
  {
    const root = buildFixture();
    const env = launchEnv(root);
    const launch = prepareSupervisorLaunch(env);
    const canonical = env.CLAUDE_CONFIG_DIR;
    const settings = JSON.parse(readFileSync(join(canonical, "settings.json"), "utf8"));
    assertEq(settings.model, "z-ai/glm-5.2", "canonical: settings.json copied from the squad source");
    assert(existsSync(join(canonical, "snapshot.json")), "canonical: snapshot.json copied");
    assert(
      existsSync(join(canonical, "agents", "lead.md")),
      "canonical: stamped agents copied"
    );
    assert(
      readFileSync(join(canonical, "agents", "lead.md"), "utf8").includes("tools: Read, Bash"),
      "canonical: agent frontmatter intact"
    );
    assertEq(launch.env.CLAUDE_CONFIG_DIR, canonical, "returned env keeps the canonical CLAUDE_CONFIG_DIR");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 4: canonical history is preserved, never copied into the snapshot ----
  {
    const root = buildFixture();
    const env = launchEnv(root);
    mkdirSync(join(env.CLAUDE_CONFIG_DIR, "projects", "sess"), { recursive: true });
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, "projects", "sess", "abc.jsonl"), '{"turn":1}\n', "utf8");
    const launch = prepareSupervisorLaunch(env);
    const history = readFileSync(
      join(env.CLAUDE_CONFIG_DIR, "projects", "sess", "abc.jsonl"),
      "utf8"
    );
    assertEq(history, '{"turn":1}\n', "history: canonical projects/ untouched by the launch");
    assertEq(launch.history.copied.length, 0, "history: no history copied into the fresh launch");
    const meta = launchProfile(root);
    assert(
      !existsSync(join(meta.outputDir, "projects")),
      "history: the launch-owned dir holds no projects copy"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 5: auth state and shared history are never copied ----
  {
    const root = buildFixture();
    const squadDir = join(root, "squad-home", "supervisor");
    writeFileSync(join(squadDir, ".credentials.json"), '{"token":"x"}', "utf8");
    mkdirSync(join(squadDir, "projects"), { recursive: true });
    writeFileSync(join(squadDir, "projects", "other-child.jsonl"), "{}\n", "utf8");
    const env = launchEnv(root);
    const launch = prepareSupervisorLaunch(env);
    const meta = launchProfile(root);
    assert(
      !existsSync(join(env.CLAUDE_CONFIG_DIR, ".credentials.json")),
      "no auth: canonical dir has no .credentials.json"
    );
    assert(!existsSync(join(meta.outputDir, ".credentials.json")), "no auth: launch dir has no .credentials.json");
    assert(!existsSync(join(env.CLAUDE_CONFIG_DIR, "projects")), "no history: canonical dir gained no projects/");
    assert(!existsSync(join(meta.outputDir, "projects")), "no history: launch dir has no projects/");
    assert(
      !launch.copied.some((p) => p.endsWith(".credentials.json") || p.includes("projects")),
      "no auth/history: the copied list excludes both"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 6: telemetry context → env identity + runtime hooks ----
  {
    const root = buildFixture();
    const env = launchEnv(root, { sessionId: "sup-session-1" });
    const launch = prepareSupervisorLaunch(env);
    assertEq(launch.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1", "telemetry: enabled");
    assert(
      launch.env.OTEL_RESOURCE_ATTRIBUTES.includes("fenix.task_key=task-1"),
      "telemetry: task key in resource attributes"
    );
    assert(
      launch.env.OTEL_RESOURCE_ATTRIBUTES.includes("fenix.actor_id=sup-session-1%3Asupervisor"),
      "telemetry: actor id (URI-encoded) in resource attributes"
    );
    assertEq(launch.env.FENIX_SUPERVISOR_SESSION_ID, "sup-session-1", "telemetry: session id rides as env");
    assert(
      typeof launch.env.FENIX_ATTEMPT_ID === "string" && launch.env.FENIX_ATTEMPT_ID.startsWith("launch:"),
      "telemetry: a fresh attempt id per launch"
    );

    const settings = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
    for (const event of ["SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "Stop"]) {
      const entries = settings.hooks?.[event] ?? [];
      assertEq(entries.length, 1, `hooks: ${event} installed exactly once`);
      assert(
        entries[0]?.hooks?.[0]?.command.includes("runtime-hook.mjs"),
        `hooks: ${event} runs the runtime hook`
      );
    }
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 7: hooks stay exactly once across relaunches ----
  {
    const root = buildFixture();
    const env = launchEnv(root, { sessionId: "sup-session-1" });
    prepareSupervisorLaunch({ ...env });
    prepareSupervisorLaunch({ ...env });
    const settings = JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
    for (const event of ["SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "Stop"]) {
      const entries = settings.hooks?.[event] ?? [];
      assertEq(entries.length, 1, `hooks relaunch: ${event} still exactly once`);
    }
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 8: the next launch refreshes the canonical settings ----
  {
    const root = buildFixture();
    prepareSupervisorLaunch(launchEnv(root));
    const squadDir = join(root, "squad-home", "supervisor");
    writeFileSync(
      join(squadDir, "settings.json"),
      JSON.stringify({ model: "other/model-2", refreshed: "v2" }, null, 2) + "\n",
      "utf8"
    );
    prepareSupervisorLaunch(launchEnv(root, { sessionId: "sup-session-1" }));
    const settings = JSON.parse(readFileSync(join(root, "canonical", "settings.json"), "utf8"));
    assertEq(settings.model, "other/model-2", "refresh: canonical settings follow the squad source");
    assertEq(settings.refreshed, "v2", "refresh: new source keys arrive");
    assertEq(
      (settings.hooks?.SessionStart ?? []).length,
      1,
      "refresh: hooks merged onto the fresh settings exactly once"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 9: each process gets its own snapshot; a registry change diffs ----
  {
    const root = buildFixture();
    const first = prepareSupervisorLaunch(launchEnv(root));
    assertEq(first.profileInitial, true, "snapshot: first launch is initial");
    const outputDir1 = launchProfile(root).outputDir;

    writeRegistry(root, THOUGHTMAP, {
      leadTools: { supervisor: ["Read", "mcp__thoughtmap__search_thoughts"] },
    });
    const second = prepareSupervisorLaunch(launchEnv(root));
    assertEq(second.profileInitial, false, "snapshot: relaunch diffs against the prior snapshot");
    const toolsChange = second.changes.find((c) => c.path === "profile.tools");
    assert(toolsChange !== undefined, "snapshot: the tools change is reported");
    assertEq(
      JSON.stringify(toolsChange?.after),
      JSON.stringify(["Read", "mcp__thoughtmap__search_thoughts"]),
      "snapshot: change row carries the new selection"
    );

    const outputDir2 = launchProfile(root).outputDir;
    assert(outputDir2 !== outputDir1, "snapshot: a fresh launch-owned dir per process");
    const snap = JSON.parse(readFileSync(join(outputDir2, "snapshot.json"), "utf8"));
    assertEq(snap.squad, "supervisor", "snapshot: squad recorded");
    assertEq(snap.role, "lead", "snapshot: role recorded");
    assertEq(
      JSON.stringify(snap.tools),
      JSON.stringify(["Read", "mcp__thoughtmap__search_thoughts"]),
      "snapshot: tools recorded"
    );
    assertEq(typeof snap.generatedAt, "string", "snapshot: generatedAt recorded");

    assertEq(argValue(second.cliArgs, "--tools"), "Read", "args: builtins selected via --tools");
    assertEq(
      argValue(second.cliArgs, "--disallowedTools"),
      null,
      "args: no --disallowedTools — the subset is enforced server-side, never as a global deny"
    );
    const mcp = JSON.parse(readFileSync(join(outputDir2, "mcp.json"), "utf8"));
    const tm = mcp.mcpServers?.thoughtmap;
    assert(tm !== undefined, "mcp: the thoughtmap server is exposed to the lead");
    assertEq(
      JSON.stringify(JSON.parse(tm?.env?.THOUGHTMAP_ALLOWED_TOOLS ?? "[]")),
      JSON.stringify(["search_thoughts"]),
      "mcp: the server-side subset exposes only the selected thoughtmap tool"
    );
    assertEq(second.env.THOUGHTMAP_API_URL, "http://thoughtmap-app:8585", "args: thoughtmap env travels to the lead");
    assertEq(argValue(second.cliArgs, "--mcp-config"), join(outputDir2, "mcp.json"), "args: --mcp-config is this process's snapshot");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 10: snapshot.json shape on the initial legacy launch ----
  {
    const root = buildFixture();
    prepareSupervisorLaunch(launchEnv(root));
    const snap = JSON.parse(readFileSync(join(launchProfile(root).outputDir, "snapshot.json"), "utf8"));
    assertEq(snap.tools, null, "shape: tools null without a registry override");
    assertEq(snap.nativeTools, null, "shape: lead has no native frontmatter tools");
    assert(Array.isArray(snap.cliArgs), "shape: cliArgs is an array");
    assertEq(typeof snap.revision, "number", "shape: registry revision recorded");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 10b (FOC-943): the declared permission mode — resolver ----
  {
    assertEq(
      JSON.stringify(resolveSupervisorPermissionMode({})),
      JSON.stringify({ mode: "auto", source: "default" }),
      "permission mode: unset → auto (default)"
    );
    assertEq(
      JSON.stringify(resolveSupervisorPermissionMode({ FENIX_SUPERVISOR_PERMISSION_MODE: "plan" })),
      JSON.stringify({ mode: "plan", source: "env" }),
      "permission mode: env override honoured"
    );
    for (const value of ["bypassPermissions", "garbage"]) {
      let error = null;
      try {
        resolveSupervisorPermissionMode({ FENIX_SUPERVISOR_PERMISSION_MODE: value });
      } catch (err) {
        error = err;
      }
      assert(error !== null, `permission mode: "${value}" is refused`);
      assert(
        /auto\|default\|acceptEdits\|plan/.test(error?.message ?? ""),
        `permission mode: the "${value}" refusal names the allowed values`
      );
    }
  }

  // ---- Test 10c (FOC-943): the declared permission mode — the claude argv ----
  {
    const root = buildFixture();
    const env = launchEnv(root);
    const launch = prepareSupervisorLaunch(env);
    assertEq(
      argValue(supervisorClaudeArgv([], launch.cliArgs, resolveSupervisorPermissionMode(env).mode), "--permission-mode"),
      "auto",
      "argv: --permission-mode auto appended by default"
    );
    assertEq(
      argValue(supervisorClaudeArgv([], launch.cliArgs, resolveSupervisorPermissionMode({ FENIX_SUPERVISOR_PERMISSION_MODE: "plan" }).mode), "--permission-mode"),
      "plan",
      "argv: the env override reaches the argv"
    );
    assertEq(
      supervisorClaudeArgv(["--permission-mode", "acceptEdits"], launch.cliArgs, "auto").filter((a) => a === "--permission-mode").length,
      1,
      "argv: an existing --permission-mode is never duplicated"
    );
    assertEq(
      argValue(supervisorClaudeArgv([], launch.cliArgs, "plan"), "--permission-mode"),
      "plan",
      "argv: the mode lands after the launch's cliArgs"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 10d (FOC-943 W6): the caller's --permission-mode in both forms ----
  {
    // `--permission-mode=<v>` counts as present too — never a duplicate flag.
    assertEq(
      supervisorClaudeArgv(["--permission-mode=default"], [], "auto").filter((a) => a === "--permission-mode" || a.startsWith("--permission-mode=")).length,
      1,
      "argv: an existing --permission-mode=default is never duplicated"
    );
    assertEq(
      supervisorClaudeArgv(["--permission-mode=default"], [], "auto").indexOf("--permission-mode=default"),
      0,
      "argv: the = form is kept verbatim (the caller's value wins)"
    );
    // A caller-declared bypassPermissions is refused in either spelling.
    for (const argvOnce of [["--permission-mode", "bypassPermissions"], ["--permission-mode=bypassPermissions"]]) {
      let error = null;
      try {
        supervisorClaudeArgv(argvOnce, [], "auto");
      } catch (err) {
        error = err;
      }
      assert(error !== null, `argv: ${JSON.stringify(argvOnce)} is refused`);
      assert(
        /auto\|default\|acceptEdits\|plan/.test(error?.message ?? ""),
        "argv: the refusal names the allowed values"
      );
    }
    // The appended flag stays a claude flag: before a bare `--` separator.
    const withSeparator = supervisorClaudeArgv(["--version"], ["--mcp-config", "/x/mcp.json", "--", "extra"], "auto");
    assertEq(
      withSeparator.indexOf("--"),
      withSeparator.indexOf("--permission-mode") + 2,
      "argv: the appended flag sits right before the -- separator"
    );
    assertEq(
      withSeparator[withSeparator.indexOf("--permission-mode") + 1],
      "auto",
      "argv: the declared mode rides with the appended flag"
    );
    // A --permission-mode past the separator is positional data, not a flag:
    // the launcher still appends its own declared mode and never validates it.
    const pastSeparator = supervisorClaudeArgv(["--", "--permission-mode", "bypassPermissions"], [], "auto");
    assertEq(
      pastSeparator.indexOf("--"),
      2,
      "argv: the launcher's flag was inserted before the -- separator"
    );
    assertEq(
      pastSeparator[1],
      "auto",
      "argv: the declared mode rides with the launcher's flag"
    );
    assertEq(
      pastSeparator[4],
      "bypassPermissions",
      "argv: a --permission-mode past -- is not scanned and left untouched"
    );
  }

  // ---- Test 11: a removed source role is pruned from the canonical agents dir ----
  {
    const root = buildFixture();
    const squadAgents = join(root, "squad-home", "supervisor", "agents");
    writeFileSync(
      join(squadAgents, "extra.md"),
      "---\nname: extra\nmodel: z-ai/glm-5.2\n---\nExtra body.\n",
      "utf8"
    );
    prepareSupervisorLaunch(launchEnv(root));
    const canonicalAgents = join(root, "canonical", "agents");
    assert(existsSync(join(canonicalAgents, "extra.md")), "prune: the copied role is available after launch 1");
    rmSync(join(squadAgents, "extra.md"));
    const second = prepareSupervisorLaunch(launchEnv(root));
    assert(!existsSync(join(canonicalAgents, "extra.md")), "prune: the removed role is gone after relaunch");
    assert(existsSync(join(canonicalAgents, "lead.md")), "prune: the live role stays");
    assert(
      Array.isArray(second.prunedAgents) && second.prunedAgents.includes("extra.md"),
      "prune: the removal is reported in prunedAgents"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 12: the prune fails closed — uncertain files stay ----
  {
    const root = buildFixture();
    const squadAgents = join(root, "squad-home", "supervisor", "agents");
    writeFileSync(
      join(squadAgents, "extra.md"),
      "---\nname: extra\nmodel: z-ai/glm-5.2\n---\nExtra body.\n",
      "utf8"
    );
    prepareSupervisorLaunch(launchEnv(root));
    const canonicalAgents = join(root, "canonical", "agents");
    // An edited-in-place file can no longer be proven launch-copied → it stays.
    writeFileSync(
      join(canonicalAgents, "extra.md"),
      "---\nname: extra\n---\nEdited in place.\n",
      "utf8"
    );
    // A non-role file is never a prune candidate.
    writeFileSync(join(canonicalAgents, "notes.txt"), "keep me\n", "utf8");
    rmSync(join(squadAgents, "extra.md"));
    prepareSupervisorLaunch(launchEnv(root));
    assert(existsSync(join(canonicalAgents, "extra.md")), "prune fail-closed: an edited file stays");
    assert(existsSync(join(canonicalAgents, "notes.txt")), "prune fail-closed: non-md files stay");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 13: no previous snapshot metadata → nothing is pruned ----
  {
    const root = buildFixture();
    const squadAgents = join(root, "squad-home", "supervisor", "agents");
    writeFileSync(
      join(squadAgents, "extra.md"),
      "---\nname: extra\nmodel: z-ai/glm-5.2\n---\nExtra body.\n",
      "utf8"
    );
    prepareSupervisorLaunch(launchEnv(root));
    const canonicalAgents = join(root, "canonical", "agents");
    rmSync(join(squadAgents, "extra.md"));
    rmSync(join(root, "launch-profile.json"), { force: true });
    prepareSupervisorLaunch(launchEnv(root));
    assert(
      existsSync(join(canonicalAgents, "extra.md")),
      "prune fail-closed: without launch-profile.json nothing is removed"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 14: a managed session's kickoff carries its task binding ----
  // The walk observation (2026-10-14): a bound session answered "jak tam
  // status" with generic frontman intake — it had no way to know its ticket
  // without tools. The binding lives in the prompt the session reads.
  {
    const root = buildFixture();
    const env = launchEnv(root, { sessionId: "sup-session-1" });
    prepareSupervisorLaunch(env);
    const claude = readFileSync(join(root, "canonical", "CLAUDE.md"), "utf8");
    assert(claude.includes("## Task binding"), "binding: the section is in the session prompt");
    assert(claude.includes("task-1"), "binding: the task key is named");
    assert(claude.includes("FOC-123"), "binding: the Linear id is named");
    assert(claude.includes("## Runtime workflow completion"), "binding: the workflow section still lands");
    assert(
      claude.indexOf("## Task binding") < claude.indexOf("## Runtime workflow completion"),
      "binding: precedes the workflow section"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 15: no task key → the managed launch refuses, nothing fabricated ----
  // The identity is all-or-nothing upstream (runtimeTelemetryEnv), so a
  // binding can never be invented from a half-valid context: there is no
  // session at all without its ticket.
  {
    const root = buildFixture();
    const env = launchEnv(root, { sessionId: "sup-session-1" });
    delete env.LA_TASK_KEY;
    let error = null;
    try {
      prepareSupervisorLaunch(env);
    } catch (err) {
      error = err;
    }
    assert(error !== null, "binding: a managed launch without a task key is refused");
    assert(
      /taskKey/.test(error?.message ?? ""),
      "binding: the refusal names the task key"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 16: legacy launch — no binding, no workflow section ----
  {
    const root = buildFixture();
    prepareSupervisorLaunch(launchEnv(root));
    const claude = readFileSync(join(root, "canonical", "CLAUDE.md"), "utf8");
    assert(!claude.includes("## Task binding"), "legacy: no task binding");
    assert(!claude.includes("## Runtime workflow completion"), "legacy: no workflow section");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 17: a relaunch keeps the binding exactly once ----
  {
    const root = buildFixture();
    const env = launchEnv(root, { sessionId: "sup-session-1" });
    prepareSupervisorLaunch({ ...env });
    prepareSupervisorLaunch({ ...env });
    const claude = readFileSync(join(root, "canonical", "CLAUDE.md"), "utf8");
    const count = claude.split("## Task binding").length - 1;
    assertEq(count, 1, "binding relaunch: exactly one Task binding section");
    assertEq(
      claude.split("## Runtime workflow completion").length - 1,
      1,
      "binding relaunch: exactly one workflow section"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 18: an unshaped Linear id never reaches the prompt ----
  {
    const root = buildFixture();
    const env = launchEnv(root, { sessionId: "sup-session-1" });
    env.LA_TASK_ID = "not a safe identifier\n## Injected";
    prepareSupervisorLaunch(env);
    const claude = readFileSync(join(root, "canonical", "CLAUDE.md"), "utf8");
    assert(claude.includes("## Task binding"), "binding guard: the section still lands");
    assert(claude.includes("task-1"), "binding guard: the validated task key is named");
    assert(
      !claude.includes("## Injected"),
      "binding guard: the unshaped Linear id is dropped, never injected"
    );
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("supervisor-launch tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
