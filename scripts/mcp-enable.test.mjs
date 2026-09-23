// scripts/mcp-enable.test.mjs — the helpers supervisor-spawn.mjs relies on for
// worktree approval, and the --project-root mode of the CLI (plan 2026-09-23 §4
// "headless access").
//
//   node scripts/mcp-enable.test.mjs
//
// All hermetic: every config file is a temp file, every target a temp dir.
// The ROOT mode (approve every server for the main checkout) is deliberately
// NOT exercised — it writes the real agents/<squad>/.claude.json files, which
// is a per-machine action verified with --verify, not a unit test.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { approveGuardedCodegraphForProject, approveServersForProject, enableServersInProjectSettings, guardedCodegraphServersOf } from "./mcp-enable.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const MODULE = join(__dir, "mcp-enable.mjs");

let passed = 0;
const failures = [];
const cleanup = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const fail = (msg) => { throw new Error(msg); };

function tempDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), tag));
  cleanup.push(dir);
  return dir;
}

// A target root with the repo-owned guarded .mcp.json (or a raw/foreign variant).
function targetWith({ entry }) {
  const root = tempDir("la-mcp-target-");
  if (entry !== null) {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { codegraph: entry } }));
  }
  return root;
}

const GUARDED_ENTRY = { command: "node", args: ["scripts/mcp/server-codegraph.mjs"] };
const RAW_UPSTREAM_ENTRY = { command: "codegraph", args: ["serve", "--mcp"] };

// A config file with an unrelated project and a global key — everything the
// approval must preserve.
function seedConfig(configPath, extraProjects = {}) {
  mkdirSync(dirname(configPath), { recursive: true });
  const seed = {
    helper: { keep: "me" },
    projects: {
      "C:/Users/elsewhere/other": { enabledMcpjsonServers: ["linear"], hasTrustDialogAccepted: true },
      ...extraProjects,
    },
  };
  writeFileSync(configPath, JSON.stringify(seed, null, 2) + "\n");
  return seed;
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// ── guardedCodegraphServersOf ─────────────────────────────────────────────────
console.log("\nguardedCodegraphServersOf — what counts as ours to approve");

test("the repo-owned guarded entry → ['codegraph']", () => {
  const root = targetWith({ entry: GUARDED_ENTRY });
  const r = guardedCodegraphServersOf(root);
  if (JSON.stringify(r) !== JSON.stringify(["codegraph"])) fail(`got ${JSON.stringify(r)}`);
});

test("the raw upstream `serve` entry → [] — never bless the unguarded boundary", () => {
  // What `codegraph install` leaves behind: same server name, no boundary.
  const root = targetWith({ entry: RAW_UPSTREAM_ENTRY });
  if (guardedCodegraphServersOf(root).length) fail("the raw upstream entry was treated as guarded");
});

test("a foreign repo (no .mcp.json) or a corrupt one → []", () => {
  const foreign = targetWith({ entry: null });
  if (guardedCodegraphServersOf(foreign).length) fail("a repo without .mcp.json was treated as guarded");
  const corrupt = targetWith({ entry: GUARDED_ENTRY });
  writeFileSync(join(corrupt, ".mcp.json"), "{ not json");
  if (guardedCodegraphServersOf(corrupt).length) fail("a corrupt .mcp.json was treated as guarded");
});

// ── approveServersForProject ──────────────────────────────────────────────────
console.log("\napproveServersForProject — one write, everything else preserved");

test("refuses with no servers and writes nothing", () => {
  const dir = tempDir("la-mcp-cfg-");
  const configPath = join(dir, ".claude.json");
  seedConfig(configPath);
  const before = readFileSync(configPath, "utf8");
  const r = approveServersForProject({ configPath, projectRoot: dir, servers: [] });
  if (r.ok !== false || r.written !== false) fail(`no-server call wrote anyway: ${JSON.stringify(r)}`);
  if (readFileSync(configPath, "utf8") !== before) fail("the config changed");
});

test("refuses when the config file does not exist yet — no orphan file created", () => {
  const dir = tempDir("la-mcp-cfg-");
  const configPath = join(dir, ".claude.json");
  const r = approveServersForProject({ configPath, projectRoot: dir, servers: ["codegraph"] });
  if (r.ok !== false || existsSync(configPath)) fail(`missing config was created: ${JSON.stringify(r)}`);
  if (!String(r.reason).includes("no .claude.json")) fail(`unhelpful reason: ${r.reason}`);
});

test("refuses on unparseable runtime JSON instead of rewriting it", () => {
  // .claude.json is live state Claude Code owns; overwriting a broken one
  // would drop that squad's whole history.
  const dir = tempDir("la-mcp-cfg-");
  const configPath = join(dir, ".claude.json");
  writeFileSync(configPath, "{ not json");
  const r = approveServersForProject({ configPath, projectRoot: dir, servers: ["codegraph"] });
  if (r.ok !== false || r.written !== false) fail(`overwrote a broken config: ${JSON.stringify(r)}`);
  if (readFileSync(configPath, "utf8") !== "{ not json") fail("the broken config changed");
});

test("approves into a fresh forward-slash key, preserves the unrelated project and globals", () => {
  const dir = tempDir("la-mcp-cfg-");
  const configPath = join(dir, ".claude.json");
  const seed = seedConfig(configPath);
  const r = approveServersForProject({ configPath, projectRoot: dir, servers: ["codegraph"] });
  if (r.ok !== true || r.written !== true) fail(`not written: ${JSON.stringify(r)}`);
  if (r.projectKey !== resolve(dir).replace(/\\/g, "/")) fail(`unexpected key: ${r.projectKey}`);
  const cfg = readJson(configPath);
  const entry = cfg.projects[r.projectKey];
  if (JSON.stringify(entry.enabledMcpjsonServers) !== JSON.stringify(["codegraph"])) {
    fail(`wrong servers: ${JSON.stringify(entry.enabledMcpjsonServers)}`);
  }
  if (entry.hasTrustDialogAccepted !== true) fail("trust not accepted");
  if (JSON.stringify(cfg.projects["C:/Users/elsewhere/other"]) !== JSON.stringify(seed.projects["C:/Users/elsewhere/other"])) {
    fail("the unrelated project entry changed");
  }
  if (JSON.stringify(cfg.helper) !== JSON.stringify(seed.helper)) fail("global keys not preserved");
});

test("a backslash-spelled existing key is MIGRATED to the CLI-canonical key — it is dead to the CLI", () => {
  // MEASURED on CLI 2.1.280: the CLI reads projects[<fwd-slash realpath key>]
  // only — a backslash-spelled key stays invisible and the server remains
  // ⏸ Pending approval despite the seeded fields. So reusing such a key
  // would silently defeat the approval: the entry must move to the canonical
  // spelling, carrying its fields with it.
  const dir = tempDir("la-mcp-cfg-");
  const configPath = join(dir, ".claude.json");
  const backslashKey = resolve(dir);
  seedConfig(configPath, {
    [backslashKey]: { disabledMcpjsonServers: ["codegraph"], history: [{ display: "keep me" }] },
  });
  const r = approveServersForProject({ configPath, projectRoot: dir, servers: ["codegraph"] });
  const canonical = realpathSync(dir).replace(/\\/g, "/");
  if (r.projectKey !== canonical) fail(`projectKey not canonical: ${r.projectKey} vs ${canonical}`);
  const cfg = readJson(configPath);
  if (cfg.projects[backslashKey]) fail(`the dead-spelled key survived: ${JSON.stringify(Object.keys(cfg.projects))}`);
  const entry = cfg.projects[canonical];
  if (JSON.stringify(entry.history) !== JSON.stringify([{ display: "keep me" }])) fail("carried fields were lost");
  if (JSON.stringify(entry.enabledMcpjsonServers) !== JSON.stringify(["codegraph"])) fail("approval missing");
});

test("a case-variant existing key is migrated too — the CLI key is case-sensitive", () => {
  // Also measured: a lowercased key is invisible; nothing lowercases the key
  // the CLI computes. One visible entry must remain.
  const dir = tempDir("la-mcp-cfg-");
  const configPath = join(dir, ".claude.json");
  const lowerKey = realpathSync(dir).replace(/\\/g, "/").toLowerCase();
  seedConfig(configPath, { [lowerKey]: { hasTrustDialogAccepted: false, onboarding: { done: true } } });
  const r = approveServersForProject({ configPath, projectRoot: dir, servers: ["codegraph"] });
  const cfg = readJson(configPath);
  if (cfg.projects[lowerKey]) fail("the case-variant key survived");
  const entry = cfg.projects[r.projectKey];
  if (entry.onboarding?.done !== true) fail("carried fields were lost");
  if (entry.hasTrustDialogAccepted !== true) fail("approval missing");
});

test("a canonical existing key is reused in place, never forked", () => {
  const dir = tempDir("la-mcp-cfg-");
  const configPath = join(dir, ".claude.json");
  const canonical = realpathSync(dir).replace(/\\/g, "/");
  seedConfig(configPath, { [canonical]: { history: ["x"] } });
  const r = approveServersForProject({ configPath, projectRoot: dir, servers: ["codegraph"] });
  if (r.projectKey !== canonical) fail(`key drifted: ${r.projectKey}`);
  const matching = Object.keys(readJson(configPath).projects).filter((k) => k.toLowerCase() === canonical.toLowerCase());
  if (matching.length !== 1) fail(`forked keys: ${JSON.stringify(matching)}`);
});

test("clears the server from disabledMcpjsonServers — approval wins, no hidden state", () => {
  const dir = tempDir("la-mcp-cfg-");
  const configPath = join(dir, ".claude.json");
  const seed = seedConfig(configPath, { [resolve(dir).replace(/\\/g, "/")]: { disabledMcpjsonServers: ["codegraph", "linear"] } });
  approveServersForProject({ configPath, projectRoot: dir, servers: ["codegraph"] });
  const entry = readJson(configPath).projects[resolve(dir).replace(/\\/g, "/")];
  if (JSON.stringify(entry.disabledMcpjsonServers) !== JSON.stringify(["linear"])) {
    fail(`disabled list wrong: ${JSON.stringify(entry.disabledMcpjsonServers)}`);
  }
  if (JSON.stringify(readJson(configPath).helper) !== JSON.stringify(seed.helper)) fail("globals changed");
});

test("force:false skips the write when nothing would change — byte-identical", () => {
  // supervisor-spawn calls this per launch; churning a file Claude Code
  // rewrites on its own is how concurrent writes lose history.
  const dir = tempDir("la-mcp-cfg-");
  const configPath = join(dir, ".claude.json");
  seedConfig(configPath);
  const first = approveServersForProject({ configPath, projectRoot: dir, servers: ["codegraph"] });
  if (first.written !== true) fail("first call did not write");
  const after = readFileSync(configPath, "utf8");
  const second = approveServersForProject({ configPath, projectRoot: dir, servers: ["codegraph"] });
  if (second.ok !== true || second.written !== false) fail(`second call rewrote: ${JSON.stringify(second)}`);
  if (readFileSync(configPath, "utf8") !== after) fail("the no-op call was not byte-identical");
});

test("force:true rewrites even when unchanged — the ROOT mode's restore semantics", () => {
  const dir = tempDir("la-mcp-cfg-");
  const configPath = join(dir, ".claude.json");
  seedConfig(configPath);
  approveServersForProject({ configPath, projectRoot: dir, servers: ["codegraph"] });
  const after = readFileSync(configPath, "utf8");
  const r = approveServersForProject({ configPath, projectRoot: dir, servers: ["codegraph"], force: true });
  if (r.written !== true) fail("force did not rewrite");
  if (readFileSync(configPath, "utf8") !== after) fail("the forced rewrite was not identical content");
});

// ── enableServersInProjectSettings ─────────────────────────────────────────────
console.log("\nenableServersInProjectSettings — the 2.1.280 enabled half");

test("creates <target>/.claude/settings.local.json fresh for a bare target", () => {
  // MEASURED on CLI 2.1.280: this file is the enabled list the CLI reads —
  // trust in .claude.json alone leaves the server ⏸ Pending.
  const target = tempDir("la-mcp-target-");
  const r = enableServersInProjectSettings({ projectRoot: target, servers: ["codegraph"] });
  if (r.ok !== true || r.written !== true) fail(`not written: ${JSON.stringify(r)}`);
  const s = readJson(join(target, ".claude", "settings.local.json"));
  if (JSON.stringify(s.enabledMcpjsonServers) !== JSON.stringify(["codegraph"])) fail(`wrong file: ${JSON.stringify(s)}`);
});

test("merges into an existing settings.local.json, preserving every other key", () => {
  const target = tempDir("la-mcp-target-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(
    join(target, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { allow: ["Bash(git *)"] }, enabledMcpjsonServers: ["linear"] }) + "\n",
  );
  const r = enableServersInProjectSettings({ projectRoot: target, servers: ["codegraph"] });
  if (r.written !== true) fail(`no write: ${JSON.stringify(r)}`);
  const s = readJson(join(target, ".claude", "settings.local.json"));
  if (JSON.stringify(s.enabledMcpjsonServers) !== JSON.stringify(["linear", "codegraph"])) {
    fail(`wrong list: ${JSON.stringify(s.enabledMcpjsonServers)}`);
  }
  if (JSON.stringify(s.permissions) !== JSON.stringify({ allow: ["Bash(git *)"] })) fail("the operator's own keys were lost");
});

test("a corrupt settings.local.json is refused, not clobbered", () => {
  const target = tempDir("la-mcp-target-");
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(join(target, ".claude", "settings.local.json"), "{ not json");
  const r = enableServersInProjectSettings({ projectRoot: target, servers: ["codegraph"] });
  if (r.ok !== false || r.written !== false) fail(`clobbered: ${JSON.stringify(r)}`);
  if (readFileSync(join(target, ".claude", "settings.local.json"), "utf8") !== "{ not json") fail("the corrupt file changed");
});

test("no-op when the servers are already enabled — byte-identical, written:false", () => {
  // Per-spawn callers rely on this not churning the file.
  const target = tempDir("la-mcp-target-");
  enableServersInProjectSettings({ projectRoot: target, servers: ["codegraph"] });
  const after = readFileSync(join(target, ".claude", "settings.local.json"), "utf8");
  const r = enableServersInProjectSettings({ projectRoot: target, servers: ["codegraph"] });
  if (r.ok !== true || r.written !== false) fail(`rewrote anyway: ${JSON.stringify(r)}`);
  if (readFileSync(join(target, ".claude", "settings.local.json"), "utf8") !== after) fail("not byte-identical");
});

// ── approveGuardedCodegraphForProject ────────────────────────────────────────
console.log("\napproveGuardedCodegraphForProject — the spawn-time entry point");

test("a target without the guarded boundary gets NO write, and the reason says why", () => {
  const target = targetWith({ entry: RAW_UPSTREAM_ENTRY }); // or none at all
  const configDir = tempDir("la-mcp-cfg-");
  const configPath = join(configDir, ".claude.json");
  seedConfig(configPath);
  const before = readFileSync(configPath, "utf8");
  const r = approveGuardedCodegraphForProject({ squad: "dev", projectRoot: target, configDir });
  if (r.ok !== false || r.written !== false) fail(`unguarded target approved: ${JSON.stringify(r)}`);
  if (!String(r.reason).includes("guarded codegraph MCP")) fail(`unhelpful reason: ${r.reason}`);
  if (readFileSync(configPath, "utf8") !== before) fail("the config changed despite refusing");
  if (existsSync(join(target, ".claude"))) fail("an unguarded target got a .claude dir anyway");
});

test("a guarded target + configDir → codegraph in the config AND in the target's settings.local.json", () => {
  const target = targetWith({ entry: GUARDED_ENTRY });
  const configDir = tempDir("la-mcp-cfg-");
  const configPath = join(configDir, ".claude.json");
  seedConfig(configPath);
  const r = approveGuardedCodegraphForProject({ squad: "dev", projectRoot: target, configDir });
  if (r.ok !== true || r.written !== true) fail(`not written: ${JSON.stringify(r)}`);
  const entry = readJson(configPath).projects[r.projectKey];
  if (JSON.stringify(entry.enabledMcpjsonServers) !== JSON.stringify(["codegraph"])) {
    fail(`more than codegraph approved: ${JSON.stringify(entry.enabledMcpjsonServers)}`);
  }
  const s = readJson(join(target, ".claude", "settings.local.json"));
  if (JSON.stringify(s.enabledMcpjsonServers) !== JSON.stringify(["codegraph"])) {
    fail(`the 2.1.280 half is missing from the target: ${JSON.stringify(s)}`);
  }
});

test("a corrupt settings.local.json at the target fails the approval with the reason", () => {
  const target = targetWith({ entry: GUARDED_ENTRY });
  mkdirSync(join(target, ".claude"), { recursive: true });
  writeFileSync(join(target, ".claude", "settings.local.json"), "{ not json");
  const configDir = tempDir("la-mcp-cfg-");
  seedConfig(join(configDir, ".claude.json"));
  const r = approveGuardedCodegraphForProject({ squad: "dev", projectRoot: target, configDir });
  if (r.ok !== false) fail(`a corrupt settings file was waved through: ${JSON.stringify(r)}`);
  if (!String(r.reason).includes("not readable JSON")) fail(`unhelpful reason: ${r.reason}`);
  if (readFileSync(join(target, ".claude", "settings.local.json"), "utf8") !== "{ not json") fail("the corrupt file changed");
});

// ── import safety ─────────────────────────────────────────────────────────────
console.log("\nimport safety");

test("importing the module does not run the CLI", () => {
  // supervisor-spawn.mjs imports these helpers at spawn time; the CLI body
  // (usage(), process.exit) must stay behind the argv guard.
  const r = spawnSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(pathToFileURL(MODULE).href)}).then(() => console.log("imported"))`],
    { encoding: "utf8" },
  );
  if (r.status !== 0) fail(`import failed: ${r.stderr}`);
  if ((r.stdout ?? "").trim() !== "imported") fail(`the CLI ran on import:\n${r.stdout}${r.stderr}`);
});

// ── the CLI, --project-root mode only ─────────────────────────────────────────
console.log("\nCLI — --project-root (the ROOT mode writes real configs, not tested)");

const runCli = (...args) => spawnSync(process.execPath, [MODULE, ...args], { encoding: "utf8" });

test("guarded target: writes codegraph for --squad's config AND the target's settings.local.json, preserves keys, exit 0", () => {
  const target = targetWith({ entry: GUARDED_ENTRY });
  const base = tempDir("la-mcp-cli-");
  const configPath = join(base, "dev", ".claude.json");
  seedConfig(configPath);
  const r = runCli("--project-root", target, "--squad", "dev", "--config-dir", base);
  if (r.status !== 0) fail(`exit ${r.status}:\n${r.stdout}${r.stderr}`);
  if (!/written: codegraph/.test(r.stdout)) fail(`no written line:\n${r.stdout}`);
  const cfg = readJson(configPath);
  const wtKey = Object.keys(cfg.projects).find((k) => k.toLowerCase().replace(/\\/g, "/") === resolve(target).toLowerCase().replace(/\\/g, "/"));
  if (!wtKey) fail(`no key for the target: ${JSON.stringify(Object.keys(cfg.projects))}`);
  if (JSON.stringify(cfg.projects[wtKey].enabledMcpjsonServers) !== JSON.stringify(["codegraph"])) fail("wrong servers enabled");
  const s = readJson(join(target, ".claude", "settings.local.json"));
  if (JSON.stringify(s.enabledMcpjsonServers) !== JSON.stringify(["codegraph"])) fail(`the 2.1.280 half is missing: ${JSON.stringify(s)}`);
  if (JSON.stringify(cfg.helper) !== JSON.stringify({ keep: "me" })) fail("globals not preserved");
  if (existsSync(join(base, "review"))) fail("--squad dev wrote another squad's config dir too");
});

test("second run: already approved, byte-identical, still exit 0", () => {
  const target = targetWith({ entry: GUARDED_ENTRY });
  const base = tempDir("la-mcp-cli-");
  const configPath = join(base, "dev", ".claude.json");
  seedConfig(configPath);
  runCli("--project-root", target, "--squad", "dev", "--config-dir", base);
  const after = readFileSync(configPath, "utf8");
  const settingsAfter = readFileSync(join(target, ".claude", "settings.local.json"), "utf8");
  const r = runCli("--project-root", target, "--squad", "dev", "--config-dir", base);
  if (r.status !== 0) fail(`exit ${r.status}:\n${r.stdout}${r.stderr}`);
  if (!/already approved/.test(r.stdout)) fail(`no already-approved line:\n${r.stdout}`);
  if (readFileSync(configPath, "utf8") !== after) fail("the no-op CLI run rewrote the config");
  if (readFileSync(join(target, ".claude", "settings.local.json"), "utf8") !== settingsAfter) {
    fail("the no-op CLI run rewrote the target's settings.local.json");
  }
});

test("unguarded target: REFUSED, exit 1, config untouched, no .claude dir created", () => {
  const target = tempDir("la-mcp-cli-"); // no .mcp.json at all
  const base = tempDir("la-mcp-cli-");
  const configPath = join(base, "dev", ".claude.json");
  seedConfig(configPath);
  const before = readFileSync(configPath, "utf8");
  const r = runCli("--project-root", target, "--squad", "dev", "--config-dir", base);
  if (r.status !== 1) fail(`expected exit 1, got ${r.status}:\n${r.stdout}${r.stderr}`);
  if (!/REFUSED/.test(r.stderr + r.stdout)) fail("no REFUSED line");
  if (readFileSync(configPath, "utf8") !== before) fail("the config changed despite refusing");
  if (existsSync(join(target, ".claude"))) fail("an unguarded target got a .claude dir anyway");
});

test("--config-dir without --project-root is usage, exit 2", () => {
  const r = runCli("--config-dir", tempDir("la-mcp-cli-"));
  if (r.status !== 2) fail(`expected exit 2, got ${r.status}`);
  if (!/Usage:/.test(r.stderr)) fail("no usage text");
});

test("--project-root without a value is usage, exit 2", () => {
  const r = runCli("--project-root", "--squad");
  if (r.status !== 2) fail(`expected exit 2, got ${r.status}`);
});

// ── summary ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort — temp dirs can hold locks briefly on win32 */
  }
}

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  for (const name of failures) console.log(`  ✗ ${name}`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);