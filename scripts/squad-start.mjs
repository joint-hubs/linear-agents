#!/usr/bin/env node
// squad-start.mjs — the single Node entry point for the squad launchers (FOC-771).
//
// Cross-platform replacement for bin/_lib.bat + the per-squad .bat launchers:
//   node scripts/squad-start.mjs <plan|dev|review|test|cadence|supervisor> [source]
//        [--dry-run] [--native] [--task <id>] [--source <path>] [--print-plan]
//        [-- <claude args…>]
//   node scripts/squad-start.mjs --agent <area> <role> [source] [-- <claude args…>]
//
// [source] (JOI-69): the old launchers set SOURCE_PATH=%~1 and re-passed it to
// claude as the first argument (`claude %*`) — when the dashboard's POST
// /api/launch invokes bin\dev.bat, %1 is the server-built kickoff prompt, not a
// path. The same positional (or --source, its flag form; both → exit 2) is
// recorded as the manifest sourcePath AND prepended to claude's args. The
// *-dry.bat kickoffs were fixed and hard-set SOURCE_PATH empty, so --dry-run
// ignores the source entirely. agent.bat forwarded its %3 (the source) right
// after --append-system-prompt.
// planLaunch() is pure: it computes the full child env, the claude args and the
// ordered step list exactly as bin/_lib.bat + the launcher did — cost-guard
// check, .env merge (window-level LINEAR_TEAM_KEY/LINEAR_WORKSPACE win), atlas
// render gated on the FOC-772 integrations switch (off/invalid → an atlas-off
// step that mirrors the bat's message and deletes a stale output), the provisioning
// marker, NATIVE clearing every ANTHROPIC_* (ids from config/native-models.json)
// vs provider-resolve fail-closed, CLAUDE_CODE_SUBAGENT_MODEL cleared,
// API_TIMEOUT_MS, the run-manifest sequence, and the supervisor extras
// (LA_SUPERVISOR_REPO, supervisor-current-run.mjs record).
//
// runLaunch() executes the steps in _lib.bat order: cost-guard first (exit 1 on
// refusal), provider failure exits 1 BEFORE any manifest write, gen-id →
// start [--headless] → claude (async spawn, stdio inherited; SIGINT/SIGTERM are
// forwarded to the child, which spawnSync could never do) → end ALWAYS
// (finally, and on SIGINT/SIGTERM). The exit code is claude's, or the last post
// step's when the squad has post steps (parity with *-dry.bat).
//
// Usage errors exit 2. `--print-plan` prints the plan as JSON (secret-looking
// env values masked) and exits 0 without running anything.

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnvFile, resolveProvider, formatSetLines } from "./provider-resolve.mjs";
import { readSettings } from "./fenix-settings.mjs";
import { settingsPath, squadConfigDir } from "./fenix-paths.mjs";
import { readIntegrationsSafe } from "./fenix-integrations.mjs";
import { childModelFor } from "./child-model.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SQUADS = ["plan", "dev", "review", "test", "cadence", "supervisor"];
const SUPERVISOR_FALLBACK_MODEL = "x-ai/grok-4.7";
const AGENT_DEFAULT_MODEL = "z-ai/glm-5.2"; // agent.bat's `set "M=..."` fallback
// The anthropic tiers agent.bat hardcodes (verbatim).
const AGENT_TIERS = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.8",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-sonnet-4.6",
};
const API_TIMEOUT_MS = "3000000";

// provider-resolve prints cmd-style `set "VAR=value"` lines for _lib.bat; the
// spawn path (child-model.mjs) consumes the same lines so the two surfaces
// cannot drift. Same regex, same greedy-to-last-quote value.
const SET_LINE_RE = /^set "([A-Za-z_][A-Za-z0-9_]*)=(.*)"$/;
const SECRET_KEY_RE = /KEY|TOKEN|SECRET/;

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The .env merge rule, exactly like _lib.bat: every .env value overrides the
 *  inherited environment, EXCEPT LINEAR_TEAM_KEY / LINEAR_WORKSPACE where the
 *  window-level value wins when defined (e.g. `set LINEAR_TEAM_KEY=JOI&& …`). */
export function mergeEnv(root, env) {
  const envFile = parseEnvFile(join(root, ".env"));
  const merged = { ...env, ...envFile };
  for (const key of ["LINEAR_TEAM_KEY", "LINEAR_WORKSPACE"]) {
    if (env[key] !== undefined) merged[key] = env[key];
  }
  return merged;
}

/** Parse `set "VAR=value"` lines into an env object (child-model.mjs style). */
export function parseSetLines(lines) {
  const env = {};
  for (const line of lines) {
    const match = SET_LINE_RE.exec(line);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

/** Resolve the provider and flatten its set lines into an env object.
 *  Fail-closed: returns { error } when the provider is unknown or its key is
 *  missing — the launcher must refuse before any manifest write. */
function providerEnv(root, env) {
  let resolved;
  try {
    resolved = resolveProvider(undefined, {
      configPath: join(root, "config", "models.json"),
      envPath: join(root, ".env"),
      env,
    });
  } catch (err) {
    return { error: String(err?.message ?? err).split("\n")[0] };
  }
  if (!resolved.present) {
    return {
      error: `Provider "${resolved.provider}" requires ${resolved.authEnv} (missing in environment or .env)`,
      provider: resolved.provider,
    };
  }
  return { resolved, env: parseSetLines(formatSetLines(resolved)) };
}

/** Load the NATIVE (Anthropic subscription) model ids per squad.
 *  config/native-models.json: `squads.plan` and `squads.supervisor` are ported
 *  verbatim from the NATIVE branches of bin/plan.bat and bin/supervisor.bat;
 *  squads without their own branch (dev/review/test/cadence/agent) use
 *  `default` (= plan's ids — their .bat files never had a NATIVE branch). */
function nativeEnv(root, squad) {
  const config = readJsonIfExists(join(root, "config", "native-models.json")) || {};
  return config.squads?.[squad] || config.default || {};
}

/** The role binding text agent.bat builds for --append-system-prompt (verbatim). */
function agentSystemPrompt(area, role) {
  return `Tryb pojedynczego sub-agenta: dzialaj WYLACZNIE jako rola '${role}' obszaru '${area}'. Patrz agents/${area}/agents/${role}.md oraz docs/prd/.`;
}

/** The <area>.<role> model id from config/models.map (single source of truth,
 *  generated by gen-model-map.mjs). Match is case-insensitive like agent.bat's
 *  `if /i "%%A"=="%AREA%.%ROLE%"`; unknown keys fall back to agent.bat's M. */
function agentModelFromMap(root, area, role) {
  let model = AGENT_DEFAULT_MODEL;
  const key = `${area}.${role}`.toLowerCase();
  try {
    for (let line of readFileSync(join(root, "config", "models.map"), "utf8").split(/\r?\n/)) {
      line = line.trim();
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      if (line.slice(0, eq).trim().toLowerCase() === key) model = line.slice(eq + 1).trim();
    }
  } catch {
    // missing map — agent.bat's default applies
  }
  return model;
}

/**
 * Pure launch plan — computes everything _lib.bat + the launcher would set,
 * with NO side effects.
 *
 * @param {object} params
 * @param {string|null} [params.squad] - one of SQUADS (null in --agent mode)
 * @param {{area: string, role: string}|null} [params.agent] - the --agent case
 * @param {boolean} [params.dryRun] - --dry-run (headless kickoff run)
 * @param {boolean} [params.native] - --native (Anthropic subscription)
 * @param {string|null} [params.task] - --task <id> → LA_TASK_ID
 * @param {string|null} [params.source] - --source <path> or the positional →
 *   manifest source, forwarded to claude as its first arg (see header, JOI-69)
 * @param {object} params.env - the inherited (window-level) environment
 * @param {string} params.cwd - the directory the launcher runs in
 * @param {string} params.root - the repo root (config/, scripts/, agents/, .env)
 * @param {boolean} params.tty - whether the provisioning prompt may be asked
 * @param {string[]} [params.claudeArgs] - args after `--`
 * @param {object|null} [params.integrations] - pre-read FOC-772 integrations
 *   switch (readIntegrationsSafe's result: { atlas, …, source, error? });
 *   tests inject it to keep planLaunch pure. Default: read fresh through the
 *   MERGED env (LA_SETTINGS_FILE from .env honoured, as for routing).
 * @returns {{ squad, mode, env, configDir, model, claudeArgs, manifest, steps,
 *   echo, native, provider?, providerError? }}
 */
export function planLaunch({
  squad = null,
  agent = null,
  dryRun = false,
  native = false,
  task = null,
  source = null,
  env = process.env,
  cwd = process.cwd(),
  root = REPO_ROOT,
  tty = false,
  claudeArgs = [],
  integrations = null,
}) {
  const isAgent = Boolean(agent);
  const label = isAgent ? agent.area : squad;
  if (isAgent) {
    if (!agent.area || !agent.role) {
      throw new UsageError("--agent requires <area> <role>");
    }
  } else if (!SQUADS.includes(squad)) {
    throw new UsageError(`unknown squad "${squad}" (valid: ${SQUADS.join(", ")})`);
  }
  if (isAgent && !existsSync(join(root, "agents", agent.area))) {
    throw new UsageError(`unknown area "${agent.area}" (no agents/${agent.area} directory)`);
  }
  if (dryRun && !isAgent) {
    const kickoffs = readJsonIfExists(join(root, "config", "dry-run-kickoffs.json")) || {};
    if (!kickoffs[squad]) {
      throw new UsageError(`--dry-run is not defined for squad "${squad}" (no kickoff in config/dry-run-kickoffs.json)`);
    }
  }

  // 1. .env merge (window-level LINEAR_TEAM_KEY / LINEAR_WORKSPACE win).
  const childEnv = mergeEnv(root, env);
  // _lib.bat exported ROOT and LA_ROOT to the launcher's shell window; the
  // consumers that survive the Node entry point read them from the child ENV:
  // agents/*/settings.json (telemetry-hook MCP `node "$LA_ROOT/scripts/…"`),
  // every agents/*/CLAUDE.md command and supervisor-spawn.mjs. Same shape the
  // bat exported — a native path (backslashes on win32, forward on POSIX).
  childEnv.LA_ROOT = root;
  childEnv.ROOT = root;
  if (task) childEnv.LA_TASK_ID = task;
  // Old launchers: `if defined NATIVE` — the --native flag OR NATIVE=1 in the
  // merged environment (window-level or .env) selects the native branch.
  const isNative = native || Boolean(childEnv.NATIVE);
  if (isNative) childEnv.NATIVE = "1";

  // 2. Steps in _lib.bat order.
  const steps = [];
  const isSupervisor = !isAgent && squad === "supervisor";
  // _lib.bat skips the cost-guard for the supervisor: the frontman is the
  // intervention channel and its children are guarded by assertWithinBudget.
  if (!isSupervisor) {
    steps.push({ kind: "cost-guard", script: join(root, "scripts", "cost-guard.mjs"), args: ["check"] });
  }
  const atlasTemplate = join(root, "config", "atlas-mcp.json.template");
  const atlasOutput = join(root, "config", "atlas-mcp.json");
  if (existsSync(atlasTemplate)) {
    // FOC-772: the integrations switch gates the render. bin/_lib.bat ran
    // `fenix-integrations.mjs enabled atlas` — exit 1 = off, exit 2 = the check
    // itself failed (a corrupt overlay); both mean Atlas off, never abort the
    // launcher, and a stale rendered config is deleted. The safe read
    // distinguishes the two (source "invalid"), so the executor can mirror the
    // bat's exact info/WARN lines. The overlay path resolves through the MERGED
    // env (LA_SETTINGS_FILE from .env honoured, as for routing) —
    // readIntegrationsSafe's env param alone does not drive the settings path.
    // A file readSettings cannot even parse throws before the safe read's own
    // catch, so it fails closed here to the same "check failed" signal.
    let integrationsRead = integrations;
    if (!integrationsRead) {
      try {
        integrationsRead = readIntegrationsSafe({
          settings: readSettings({ path: settingsPath(childEnv) }),
          env: childEnv,
        });
      } catch (err) {
        integrationsRead = {
          atlas: false,
          pisi: false,
          memory: false,
          nebul: false,
          source: "invalid",
          error: String(err?.message ?? err),
        };
      }
    }
    if (integrationsRead.atlas) {
      if (!existsSync(atlasOutput)) {
        steps.push({ kind: "atlas-render", templatePath: atlasTemplate, outputPath: atlasOutput });
      }
    } else {
      steps.push({
        kind: "atlas-off",
        outputPath: atlasOutput,
        reason: integrationsRead.source === "invalid" ? "check-failed" : "off",
      });
    }
  }
  // New-workspace provisioning: marker .state/teams/<KEY>.provisioned (as
  // _lib.bat: rooted at the launch root). Ask only on a TTY; non-TTY gets one
  // line and skips.
  const teamKey = childEnv.LINEAR_TEAM_KEY;
  if (teamKey) {
    const markerPath = join(root, ".state", "teams", `${teamKey}.provisioned`);
    if (!existsSync(markerPath)) {
      steps.push({
        kind: "provision-check",
        teamKey,
        markerPath,
        checkScript: join(root, "scripts", "bootstrap-linear.mjs"),
        checkArgs: ["--check", "--team-key", teamKey],
        provisionScript: join(root, "scripts", "bootstrap-linear.mjs"),
        provisionArgs: [],
        interactive: Boolean(tty),
      });
    }
  }

  // 3. Provider env / NATIVE clearing.
  let provider = null;
  let providerError = null;
  let routingError = null;
  if (isNative) {
    // Native subscription: clear every inherited/leaked ANTHROPIC_* (from .env
    // or the parent env), then apply the squad's native ids.
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith("ANTHROPIC_")) delete childEnv[key];
    }
    Object.assign(childEnv, nativeEnv(root, isAgent ? "plan" : squad));
  } else {
    const resolved = providerEnv(root, childEnv);
    if (resolved.error) {
      providerError = resolved.error;
      provider = resolved.provider ?? null;
    } else {
      provider = resolved.resolved.provider;
      Object.assign(childEnv, resolved.env);
    }
  }

  // 4. Model selection.
  let model = null;
  if (isAgent) {
    // agent.bat: model from config/models.map <area>.<role>, hardcoded
    // anthropic tiers, role bound with --append-system-prompt.
    model = agentModelFromMap(root, agent.area, agent.role);
    Object.assign(childEnv, AGENT_TIERS);
    childEnv.ANTHROPIC_MODEL = model;
    // agent.bat: claude --append-system-prompt "…" %3 %4 %5 … — %3 (the source)
    // led the remaining args, and %1/%2 (area/role) were never forwarded.
    claudeArgs = ["--append-system-prompt", agentSystemPrompt(agent.area, agent.role), ...(source ? [source] : []), ...claudeArgs];
  } else if (squad === "supervisor") {
    if (isNative) {
      model = childEnv.SUPERVISOR_MODEL || "claude-opus-5";
      childEnv.SUPERVISOR_MODEL = model;
    } else {
      // The frontman's chain (supervisor.bat): SUPERVISOR_MODEL env > the
      // settings overlay's routing.supervisor.lead > the built-in fallback.
      // The routing table's routing.supervisor.default is the CHILDREN's alias
      // (supervisor-spawn resolves through it) and was never the frontman's
      // model — it is deliberately not consulted here.
      let overlayLead = null;
      if (!childEnv.SUPERVISOR_MODEL) {
        const read = readOverlay(childEnv)?.routing?.supervisor?.lead;
        if (typeof read === "string" && read.trim()) overlayLead = read.trim();
      }
      model = childEnv.SUPERVISOR_MODEL || overlayLead || SUPERVISOR_FALLBACK_MODEL;
    }
    childEnv.ANTHROPIC_MODEL = model;
  } else if (isNative) {
    // NATIVE squad: the ids from config/native-models.json were applied above
    // (plan.bat sets ANTHROPIC_MODEL inside its NATIVE branch, not via routing).
    model = childEnv.ANTHROPIC_MODEL;
  } else {
    // Squads route like the spawned children do: the routing table + the
    // settings overlay (childModelFor), not a hardcoded .bat line.
    const routed = childModelFor({
      squad,
      settings: readOverlay(childEnv),
      modelsConfig: readJsonIfExists(join(root, "config", "models.json")),
      provider,
      providerEntry: providerEntryFor(root, provider),
    });
    if (routed.model) {
      model = routed.model;
      childEnv.ANTHROPIC_MODEL = model;
    } else {
      // No falling back to the supervisor's model: an un-routed squad is a
      // config error and refuses before any manifest write (runLaunch).
      routingError = `no routing lead for ${squad} — check config/models.json routing.${squad} or the settings overlay`;
    }
  }

  // 5. Common env tail (clear inherited subagent override; long MCP timeouts).
  delete childEnv.CLAUDE_CODE_SUBAGENT_MODEL;
  childEnv.API_TIMEOUT_MS = API_TIMEOUT_MS;
  const configDir = squadConfigDir(label, env);

  // 6. Dry-run: the squad's dry-run env var, the fixed kickoff args and the
  // post steps (parity with *-dry.bat; dev/review/test/cadence verify with
  // check.mjs, plan ingests+verifies via mock-linear).
  let postSteps = [];
  if (dryRun && !isAgent) {
    childEnv[`${squad.toUpperCase()}_DRY_RUN`] = "1";
    const kickoffs = readJsonIfExists(join(root, "config", "dry-run-kickoffs.json")) || {};
    claudeArgs = ["-p", kickoffs[squad], "--permission-mode", "default", "--max-turns", "40"];
    postSteps =
      squad === "plan"
        ? [
            { kind: "post", label: "mock-linear-ingest", script: join(root, "scripts", "mock-linear.mjs"), args: ["--ingest"] },
            { kind: "post", label: "mock-linear-verify", script: join(root, "scripts", "mock-linear.mjs"), args: ["--verify"] },
          ]
        : [{ kind: "post", label: "check", script: join(root, "scripts", "check.mjs"), args: [] }];
  }
  // The interactive/supervisor bats ran `claude %*`, re-passing the source
  // positional (the JOI-69 kickoff prompt) as claude's FIRST argument. The dry
  // kickoffs were fixed, so --dry-run never forwards it (claudeArgs above).
  if (!isAgent && !dryRun && source) claudeArgs = [source, ...claudeArgs];

  // 7. Run manifest sequence. The interactive bats recorded SOURCE_PATH=%~1;
  // the *-dry.bat ones hard-set it empty (the fixed kickoff carries the
  // context), so --dry-run ignores the positional/--source entirely.
  const runManifestScript = join(root, "scripts", "run-manifest.mjs");
  const sourcePath = dryRun && !isAgent ? task ?? "" : source ?? task ?? "";
  const headless = Boolean(dryRun);
  steps.push({ kind: "manifest-gen", script: runManifestScript, args: ["gen-id", label] });
  steps.push({
    kind: "manifest-start",
    script: runManifestScript,
    args: ["start", "RUN_ID", label, sourcePath, ...(headless ? ["--headless"] : [])],
  });
  if (isSupervisor) {
    // FOC-807: record the current run so the dashboard reads the same truth.
    // Fails soft (supervisor.bat: `|| echo could not record…`).
    steps.push({
      kind: "record-current-run",
      script: join(root, "scripts", "supervisor-current-run.mjs"),
      args: ["record", "RUN_ID", "--model", model],
      soft: true,
    });
  }
  steps.push({ kind: "claude", args: claudeArgs });
  steps.push(...postSteps);

  // 8. Supervisor extras (FOC-172): the repo the Supervisor works ON is the
  // directory it was launched from, captured before anything can cd.
  if (isSupervisor) childEnv.LA_SUPERVISOR_REPO = cwd;

  // Status echo lines (stderr — the bats echo to the console too).
  const echo = [
    `[${label}] CLAUDE_CONFIG_DIR=${configDir}`,
    `[${label}] main=${model ?? "(unrouted)"} small_fast=${childEnv.ANTHROPIC_SMALL_FAST_MODEL || "(unset)"}${dryRun ? " DRY_RUN=1" : ""}`,
  ];
  if (isAgent) echo.unshift(`[agent] ${agent.area}/${agent.role}  model=${model}`);

  return {
    squad: label,
    mode: isAgent ? "agent" : dryRun ? "dry-run" : "interactive",
    env: childEnv,
    configDir,
    model,
    claudeArgs,
    manifest: { squad: label, sourcePath, headless },
    steps,
    echo,
    native: isNative,
    ...(provider ? { provider } : {}),
    ...(providerError ? { providerError } : {}),
    ...(routingError ? { routingError } : {}),
  };
}

function providerEntryFor(root, provider) {
  const config = readJsonIfExists(join(root, "config", "models.json"));
  return config?.providers?.[provider] ?? null;
}

/** The routing overlay, fail-closed to empty. A corrupt settings.json must not
 *  kill every launcher (the entry point only READS routing here), but the
 *  degradation is loud — ONE stderr line, the way squad-config.mjs degrades on
 *  read. Read through the MERGED env so LA_SETTINGS_FILE set in .env is
 *  honoured for routing as it already is for the provider. */
function readOverlay(env) {
  try {
    return readSettings({ path: settingsPath(env) });
  } catch (err) {
    console.error(`[warn] settings invalid — routing overlay ignored: ${String(err?.message ?? err).split("\n")[0]}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// runLaunch — execute the plan in _lib.bat order
// ---------------------------------------------------------------------------

/** Per-argument cmd.exe quoting (the FOC-779 pattern): wrap in double quotes,
 *  escape inner `"` as `\"` (CommandLineToArgvW semantics, so the child sees
 *  the original argument); the /s rule adds one more pair around the whole
 *  line, which cmd /s /c strips before executing. */
const quoteForCmd = (a) => `"${String(a).replace(/"/g, '\\"')}"`;

/** Resolve `name` against PATH to an absolute file (a bare .cmd spawned by
 *  name runs with %~dp0 = the child's CWD, which breaks shim self-resolution —
 *  an absolute path pins it to the launcher's real directory). */
function findOnPath(name) {
  for (const dir of (process.env.PATH || "").split(";")) {
    if (!dir) continue;
    const clean = dir.startsWith('"') && dir.endsWith('"') ? dir.slice(1, -1) : dir;
    try {
      if (statSync(join(clean, name)).isFile()) return join(clean, name);
    } catch {
      // keep searching
    }
  }
  return null;
}

/** A .cmd shim (npm-style `claude.cmd`) cannot be started by spawnSync/spawn
 *  without a shell on Node ≥ 18.20 (EINVAL): launch it through
 *  `cmd.exe /d /s /c`. The whole line is quoted once more per the FOC-779
 *  pattern, and passed VERBATIM — cmd.exe's parser counts raw quotes, and
 *  node's own quoting would inject backslash-escapes cmd misreads (verified:
 *  args with spaces die on node-quoting and on an unquoted line alike). */
function cmdExeLine(launcher, args) {
  const line = [launcher, ...args].map(quoteForCmd).join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    spawnOptions: { windowsVerbatimArguments: true },
  };
}

/** The claude binary: LA_CLAUDE_BIN is the suite's test seam (same contract as
 *  supervisor-lib.claudeCommand); production resolves PATH. On win32 a .cmd
 *  shim goes through cmd.exe — both via LA_CLAUDE_BIN and found on PATH after
 *  claude.exe. Off win32, or with nothing found, the bare "claude" spawn
 *  reports the honest failure. */
export function claudeCommand(args) {
  const bin = process.env.LA_CLAUDE_BIN;  if (bin) {
    if (bin.endsWith(".mjs") || bin.endsWith(".js")) {
      return { command: process.execPath, args: [bin, ...args] };
    }
    if (process.platform === "win32" && /\.cmd$/i.test(bin)) {
      const launcher = /[\\/]/.test(bin) ? bin : findOnPath(bin) ?? bin;
      return cmdExeLine(launcher, args);
    }
    return { command: bin, args };
  }
  if (process.platform === "win32") {
    const exe = findOnPath("claude.exe");
    if (exe) return { command: exe, args };
    const cmd = findOnPath("claude.cmd");
    if (cmd) return cmdExeLine(cmd, args);
  }
  return { command: "claude", args };
}

/** Render config/atlas-mcp.json from the template (the inline node -e in
 *  _lib.bat). Placeholders {{VAR}} resolve from env; backslashes in
 *  substituted values are JSON-escaped so Windows paths paste safely.
 *  Throws on invalid JSON — runLaunch warns and continues (as the bat does). */
function renderAtlasMcp({ templatePath, outputPath, env }) {
  const template = readFileSync(templatePath, "utf8");
  const rendered = template.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (m, name) => {
    const value = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : m;
    return typeof value === "string" ? value.replace(/\\/g, "\\\\") : value;
  });
  try {
    JSON.parse(rendered);
  } catch (err) {
    throw new Error(`atlas-mcp.json template render produced invalid JSON: ${err.message}`);
  }
  writeFileSync(outputPath, rendered);
  return true;
}

// runLaunch is synchronous, so the y/N prompt reads the answer in a short
// blocking child over inherited stdin (asked only on a real TTY).
const DEFAULT_PROMPT = (question) => {
  const child = spawnSync(
    process.execPath,
    ["-e", "process.stderr.write(process.argv[1]);let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d));", question],
    { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" },
  );
  return String(child.stdout || "").trim();
};

/**
 * Execute a launch plan.
 *
 * @param {object} plan - planLaunch()'s result
 * @param {object} [io]
 * @param {Function} [io.spawn] - injectable spawnSync (tests record argv/env)
 * @param {Function} [io.spawnAsync] - injectable async spawn for the claude
 *   step (tests return a fake child emitter); defaults to node's spawn
 * @param {Function} [io.prompt] - injectable y/N prompt, returns the answer
 * @param {Function} [io.log] - stderr sink for the status echo lines
 * @param {Function} [io.exit] - injectable process.exit (the signal handler's
 *   last act; tests inject a recorder)
 * @returns {Promise<number>} the exit code: claude's, or the last post step's
 */
export async function runLaunch(plan, {
  spawn = spawnSync,
  spawnAsync = nodeSpawn,
  prompt = DEFAULT_PROMPT,
  log = (line) => process.stderr.write(`${line}\n`),
  exit = (code) => process.exit(code),
} = {}) {
  const env = { ...plan.env };
  let runId = null;
  let ended = false;
  let claudeCode = null;
  let postCode = null;
  let claudeChild = null;
  let signalExit = null;

  // Fail-closed parity with _lib.bat: a provider that cannot resolve (unknown
  // name, missing key) refuses BEFORE any manifest write — and so does a squad
  // with no routing lead (falling back to the supervisor's model would launch
  // the wrong squad on the wrong bill).
  if (plan.providerError) {
    log(`[!] ${plan.providerError}`);
    return 1;
  }
  if (plan.routingError) {
    log(`[!] ${plan.routingError}`);
    return 1;
  }

  const execNode = (step) => spawn(process.execPath, [step.script, ...step.args.map((a) => (a === "RUN_ID" ? runId : a))], { encoding: "utf8", env });

  // `end` runs ALWAYS once the run id exists — normal exit, failure, throw
  // and SIGINT/SIGTERM (the bats rely on cmd's endlocal; a Node entry point
  // must install the handlers itself).
  const endRun = (code) => {
    if (ended || !runId) return;
    ended = true;
    spawn(process.execPath, [join(REPO_ROOT, "scripts", "run-manifest.mjs"), "end", runId, String(code)], { encoding: "utf8", env });
  };
  // spawnSync defers signal handlers, so the old bat semantics died here: the
  // handler recorded `end` but claude never saw the signal. The claude step is
  // an async spawn now — forward the signal to the child, await its exit, THEN
  // end the run with the code (128+n on a signal death) and exit.
  let signalSettled = null;
  const onSignal = (signal) => {
    if (signalExit !== null) return; // a second signal must not double-end
    signalSettled = (async () => {
      const conventional = signal === "SIGINT" ? 130 : 143;
      signalExit = conventional;
      if (claudeChild && claudeChild.exitCode == null) {
        // Attach the exit listener BEFORE killing — a fake/quick child may
        // emit synchronously, and a listener attached afterwards never fires.
        const exited = once(claudeChild, "exit");
        try {
          claudeChild.kill(signal);
        } catch {
          // a child that refuses the signal still gets its manifest end below
        }
        const [code, sig] = await exited;
        signalExit = sig ? conventional : (code ?? 1);
      }
      endRun(signalExit);
      exit(signalExit);
    })();
  };

  try {
    for (const step of plan.steps) {
      switch (step.kind) {
        case "cost-guard": {
          // Over-budget kill-switch: refuse before anything else runs.
          const result = execNode(step);
          if (result.status !== 0) return 1;
          break;
        }
        case "atlas-render": {
          try {
            renderAtlasMcp({ ...step, env });
          } catch (err) {
            log(`[!] ${err.message} (check ATLAS_VENV_PYTHON and ATLAS_ROOT in .env)`);
          }
          break;
        }
        case "atlas-off": {
          // FOC-772 parity with _lib.bat: Atlas off (or the check failed) —
          // the bat's exact line, then a stale rendered config is removed.
          // Never fatal: a deletion failure is logged and the run continues.
          if (step.reason === "check-failed") {
            log("[WARN] Atlas integration check failed - treating Atlas as off.");
          } else {
            log("[info] Atlas integration off - config/atlas-mcp.json not rendered");
          }
          try {
            if (existsSync(step.outputPath)) unlinkSync(step.outputPath);
          } catch (err) {
            log(`[!] could not delete ${step.outputPath}: ${err?.message ?? err}`);
          }
          break;
        }
        case "provision-check": {
          if (!step.interactive) {
            log(`[WARN] Team key ${step.teamKey} has no provisioning marker and stdin is not a TTY — skipping provisioning (linear-push may fail on missing labels)`);
            break;
          }
          log(`[INFO] Team key ${step.teamKey} has no provisioning marker. Checking labels...`);
          const check = spawn(process.execPath, [step.checkScript, ...step.checkArgs], { encoding: "utf8", env });
          if (check.status !== 0) {
            const answer = prompt(`Provision labels/states for team ${step.teamKey}? [y/N]: `);
            if (String(answer).trim().toLowerCase() === "y") {
              spawn(process.execPath, [step.provisionScript, ...step.provisionArgs], { encoding: "utf8", env });
            } else {
              log(`[WARN] Skipping provisioning. linear-push may fail on missing labels.`);
            }
          }
          break;
        }
        case "manifest-gen": {
          const result = execNode(step);
          if (result.status !== 0 || !String(result.stdout || "").trim()) {
            log(`[!] run-manifest gen-id failed (exit ${result.status})`);
            return 1;
          }
          runId = String(result.stdout).trim().split(/\r?\n/)[0];
          env.LA_RUN_ID = runId;
          // Children inherit this so they can find the run directory (supervisor).
          if (plan.squad === "supervisor" && !env.LA_SUPERVISOR_RUN) env.LA_SUPERVISOR_RUN = runId;
          break;
        }
        case "manifest-start": {
          execNode(step);
          break;
        }
        case "record-current-run": {
          const result = execNode(step);
          // FOC-901: exit 3 = MANAGED_SESSIONS_ACTIVE — an unscoped start
          // refuses while managed sessions are live. Surface the refusal and
          // stop before claude spawns; any other failure stays warn-and-soft.
          if (result.status === 3) {
            if (result.stderr) log(String(result.stderr).trimEnd());
            log("[supervisor] refused: managed sessions are active — see the message above, or set FENIX_SUPERVISOR_LEGACY=1 to adopt anyway");
            return 2;
          }
          if (result.status !== 0) {
            log("[supervisor] could not record the current run for the dashboard (supervisor-current-run.mjs record)");
          }
          break;
        }
        case "claude": {
          for (const line of plan.echo) log(line);
          if (plan.squad === "supervisor") {
            log(`[supervisor] run=${runId} issue=${plan.manifest.sourcePath || "(none)"}`);
          }
          process.on("SIGINT", onSignal);
          process.on("SIGTERM", onSignal);
          let child = null;
          try {
            const { command, args, spawnOptions } = claudeCommand(step.args);
            child = spawnAsync(command, args, { stdio: "inherit", env, ...spawnOptions });
          } catch (err) {
            log(`[!] could not start claude: ${err?.message ?? err}`);
            claudeCode = 1;
            break;
          }
          claudeChild = child;
          const outcome = await new Promise((resolve) => {
            child.once("error", (err) => resolve({ error: err }));
            child.once("exit", (code, sig) => resolve({ code, signal: sig }));
          });
          claudeChild = null;
          if (outcome.error) {
            log(`[!] could not start claude: ${outcome.error.message}`);
            claudeCode = 1;
          } else {
            // A signal death has no code — report the conventional 128+n.
            claudeCode = outcome.code ?? (outcome.signal === "SIGINT" ? 130 : outcome.signal ? 143 : 1);
            if (plan.native && claudeCode !== 0) {
              log(`[!] Native (Anthropic subscription) run failed. Re-run with OpenRouter: node scripts/squad-start.mjs ${plan.squad}`);
            }
          }
          if (signalExit !== null) {
            // A handled signal owns the exit from here: no post steps, no
            // second `end`. The handler already ended the run and exited (or,
            // with an injected exit, its code is the run's code).
            await signalSettled;
            return signalExit;
          }
          break;
        }
        case "post": {
          // The *-dry.bat post steps: their exit code becomes the run's code.
          const result = execNode(step);
          postCode = result.status ?? 1;
          break;
        }
        default:
          log(`[!] unknown launch step "${step.kind}"`);
          return 1;
      }
    }
    return postCode ?? claudeCode ?? 0;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    endRun(postCode ?? claudeCode ?? 1);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export class UsageError extends Error {}

const USAGE = [
  "Usage: node scripts/squad-start.mjs <squad> [source] [options] [-- <claude args…>]",
  "  squads: plan | dev | review | test | cadence | supervisor",
  "  [source]          the kickoff prompt or path: recorded as the manifest",
  "                    source and passed to claude as its first argument",
  "                    (JOI-69); --source is the flag form, both → exit 2;",
  "                    ignored in --dry-run (the fixed kickoff wins)",
  "  --dry-run         headless kickoff run per config/dry-run-kickoffs.json",
  "  --native          Anthropic subscription (clears ANTHROPIC_*, applies config/native-models.json)",
  "  --task <id>       record LA_TASK_ID and use it as the manifest source",
  "  --source <path>   manifest source path (same as [source]; both → exit 2)",
  "  --print-plan      print the computed plan as JSON and exit 0",
  "",
  "  node scripts/squad-start.mjs --agent <area> <role> [source] [-- <claude args…>]",
  "    plan:    discovery | spec | spec-review | decomposer | push",
  "    dev:     recon | implementer | refactorer | debugger",
  "    review:  first-pass | security | deep",
  "    test:    deployer | scenario-gen | runner | root-cause",
  "    cadence: collector | retro | digest",
].join("\n");

/** Mask secret-looking env values for --print-plan. */
export function printablePlan(plan) {
  const maskedEnv = {};
  for (const [key, value] of Object.entries(plan.env)) {
    maskedEnv[key] = SECRET_KEY_RE.test(key) && value ? "<set>" : value;
  }
  return { ...plan, env: maskedEnv };
}

export function parseCliArgs(argv) {
  const options = { squad: null, agent: null, dryRun: false, native: false, task: null, source: null, printPlan: false, claudeArgs: [] };
  let positional = [];
  let agentPosStart = null; // positionals before --agent can only be strays
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.claudeArgs = argv.slice(i + 1);
      break;
    }
    switch (arg) {
      case "--dry-run": options.dryRun = true; break;
      case "--native": options.native = true; break;
      case "--print-plan": options.printPlan = true; break;
      case "--task":
      case "--source": {
        const value = argv[++i];
        if (value === undefined) throw new UsageError(`${arg} requires a value`);
        options[arg.slice(2)] = value;
        break;
      }
      case "--agent": {
        const area = argv[++i];
        const role = argv[++i];
        if (!area || !role) throw new UsageError("--agent requires <area> <role>");
        options.agent = { area, role };
        agentPosStart = positional.length;
        break;
      }
      default:
        if (arg.startsWith("--")) throw new UsageError(`unknown option "${arg}"`);
        positional.push(arg);
    }
  }
  // The source positional (JOI-69): one optional positional after <squad> — or
  // after --agent <area> <role> — is the source, same as --source; both → exit 2.
  // Agent mode takes MORE positionals: the first is the source (agent.bat %3),
  // the rest are forwarded to claude after it (agent.bat %4–%9).
  const takeSource = (value, where) => {
    if (options.source) throw new UsageError(`--source and the positional source are mutually exclusive (${where})`);
    options.source = value;
  };
  if (options.agent) {
    const before = positional.slice(0, agentPosStart);
    const after = positional.slice(agentPosStart);
    if (before.length) throw new UsageError(`unexpected argument "${before[0]}" before --agent`);
    if (after.length > 0) {
      takeSource(after[0], "--agent mode");
      // Positional extras keep their argv order ahead of the `--` passthrough,
      // matching agent.bat's %3 %4 %5 … sequence.
      options.claudeArgs = [...after.slice(1), ...options.claudeArgs];
    }
  } else {
    if (positional.length > 2) throw new UsageError(`unexpected argument "${positional[2]}"`);
    options.squad = positional[0] ?? null;
    if (!options.squad) throw new UsageError("missing <squad>");
    if (positional.length === 2) takeSource(positional[1], "squad mode");
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`[!] ${err.message}\n${USAGE}`);
      return 2;
    }
    throw err;
  }

  let plan;
  try {
    plan = planLaunch({
      squad: options.squad,
      agent: options.agent,
      dryRun: options.dryRun,
      native: options.native,
      task: options.task,
      source: options.source,
      env: process.env,
      cwd: process.cwd(),
      root: REPO_ROOT,
      tty: Boolean(process.stdin.isTTY),
      claudeArgs: options.claudeArgs,
    });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`[!] ${err.message}\n${USAGE}`);
      return 2;
    }
    console.error(`[!] ${err?.message ?? err}`);
    return 1;
  }

  if (options.printPlan) {
    console.log(JSON.stringify(printablePlan(plan), null, 2));
    return 0;
  }
  if (plan.providerError) {
    console.error(`[!] ${plan.providerError}`);
    return 1;
  }
  return runLaunch(plan);
}

// Run the CLI only when invoked directly, never on import (tests import the
// exported helpers without touching the real provider config). runLaunch is
// async now (the claude step must forward signals), so main returns a promise.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[!] ${err?.message ?? err}`);
      process.exit(1);
    },
  );
}
