// scripts/tool-profiles.mjs — the versioned tool-profile registry (P2 backend
// slice). ONE user-owned schema, deliberately separate from the strict
// provider/routing Settings overlay (fenix-settings.mjs): this file decides
// which MCP servers and tool lists a squad lead or worker gets, not which
// model answers. Stored at <dataHome>/settings/tool-profiles.json
// (LA_TOOL_PROFILES_FILE wins) so it survives `fenix update` like the rest of
// the settings home.
//
// Public API (no import side effects, no CLI):
//   readToolProfiles({path?})          → validated config (defaults when absent)
//   writeToolProfiles(patch, opts)     → { config, changes } — deep merge, atomic
//                                        write, revision CAS against concurrent
//                                        writers
//   getToolCatalog({path?})            → builtin config/tools.json merged with
//                                        config/mcp-tools.json, plus server
//                                        enabled metadata (never a fake
//                                        "available")
//   resolveToolProfile({squad, role?, env?}, {path?}) → { revision, tools,
//                                        mcpServers, ... } for launch wiring
//   snapshotToolProfile({squad, role?, outputDir, env?}, {path?}) → writes ONLY
//                                        snapshot.json + mcp.json into a
//                                        launch-owned outputDir
//
// Ownership boundaries, kept deliberately:
//   - Worker role tools stay authoritative in the agents/<squad>/agents/<role>.md
//     frontmatter (squad-config.mjs) — this module NEVER writes frontmatter and
//     never duplicates the source of truth; roleOverrides are an explicit,
//     optional launch-time override layer on top.
//   - Only the Thoughtmap MCP server is registered today (config/mcp-tools.json);
//     anything else under mcp__<server>__ is refused so the registry cannot be
//     silently widened.
//   - No secrets: values shaped like credentials are refused outright, and no
//     field in this schema is ever a secret carrier (URLs must not embed
//     credentials, paths point at the approved mount only).

import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { dataHome } from "./fenix-paths.mjs";
import { readSquadConfig, readToolCatalog } from "./squad-config.mjs";
import { atomicWriteJSON } from "./utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), "..");

// ─── Schema constants ────────────────────────────────────────────────────────

const SQUAD_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/; // same shape as settings routing keys
const ROLE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/; // frontmatter role = file name
// Tool names as the Claude CLI sees them: built-ins ("Read"), permission-style
// entries ("Bash(git *)") and MCP namespace names ("mcp__thoughtmap__x").
const TOOL_NAME_RE = /^[A-Za-z0-9_.:@()*-]{1,128}$/;
const MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/; // ollama model tags, bounded
// Anything shaped like a real credential — the file is shared and diffed, so a
// pasted key must be caught before it lands on disk (same list as settings).
const SECRET_RE = /sk-or-|sk-ant-|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|lin_api_/;

const MCP_SERVER = "thoughtmap";
// The exact tool names config/mcp-tools.json registers. Resolve-time truth for
// what is grantable; the registry file itself may keep other unknown names
// preserved (marked unavailable, never granted).
const MCP_TOOL_NAMES = new Set([
  "mcp__thoughtmap__search_thoughts",
  "mcp__thoughtmap__list_clusters",
  "mcp__thoughtmap__get_cluster",
  "mcp__thoughtmap__cluster_distances",
  "mcp__thoughtmap__text_distance",
]);

// The Thoughtmap containers live on the thoughtmap_default docker network.
// The defaults name the containers, NOT localhost: inside the Fenix container
// localhost is Fenix itself, and pointing a tool at it is exactly the mistake
// this schema exists to prevent — so loopback hosts are refused outright.
const DEFAULT_THOUGHTMAP = Object.freeze({
  enabled: false,
  baseUrl: "http://thoughtmap-app:8585",
  ollamaBaseUrl: "http://thoughtmap-ollama:11434",
  embeddingModel: "qwen3-embedding:8b",
  clustersPath: "/fenix-integrations/thoughtmap/clusters.json",
});

// The one approved container mount for the read-only clusters artifact. A
// non-default clustersPath is accepted only when it sits inside the env root
// (FENIX_INTEGRATIONS_ROOT) — never an arbitrary host path.
const APPROVED_MOUNT = "/fenix-integrations";
const DEFAULT_CLUSTERS_PATH = DEFAULT_THOUGHTMAP.clustersPath;

const TOOL_LIST_MAX = 64;

// ─── Small helpers ───────────────────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Path of the user-owned registry. Env override first (tests, the container). */
export function toolProfilesPath(env = process.env) {
  if (env.LA_TOOL_PROFILES_FILE) return env.LA_TOOL_PROFILES_FILE;
  return join(dataHome(env), "settings", "tool-profiles.json");
}

export function emptyToolProfiles() {
  return {
    version: 1,
    revision: 0,
    mcp: { thoughtmap: { ...DEFAULT_THOUGHTMAP } },
    leadTools: {},
    globalTools: null,
    squadTools: {},
  };
}

// ─── Field validators ────────────────────────────────────────────────────────

/**
 * One tool-server base URL. http(s) only, no embedded credentials, no query
 * string (auth never travels in this schema), and never a loopback host —
 * inside the Fenix container that address is Fenix itself, not the thoughtmap
 * containers on the thoughtmap_default network.
 */
function checkBaseUrl(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 300) {
    errors.push(`${label}: must be a non-empty http(s) URL of at most 300 characters`);
    return;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${label}: must be an absolute http(s) URL`);
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    errors.push(`${label}: must be an absolute http(s) URL`);
    return;
  }
  if (url.username || url.password) {
    errors.push(`${label}: must not embed credentials (auth never travels in tool-profiles)`);
  }
  if (url.search || url.hash) {
    errors.push(`${label}: must not carry a query string or fragment`);
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "[::1]" || host === "::1" || host.startsWith("127.")) {
    errors.push(
      `${label}: must not point at localhost — inside the Fenix container that is Fenix ` +
        "itself, not the thoughtmap containers (thoughtmap_default network service names)",
    );
  }
}

/**
 * The clusters artifact path: the fixed approved container mount verbatim, or
 * an absolute path inside FENIX_INTEGRATIONS_ROOT (native override). Never an
 * arbitrary host path, never escaping the root via .. (resolve + containment).
 */
function checkClustersPath(value, label, errors, env = process.env) {
  if (typeof value !== "string" || value.trim() === "" || value.length > 500) {
    errors.push(`${label}: must be a non-empty path of at most 500 characters`);
    return;
  }
  if (value === DEFAULT_CLUSTERS_PATH) return; // the fixed approved mount
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    errors.push(`${label}: control characters are not allowed in a path`);
    return;
  }
  const root = env.FENIX_INTEGRATIONS_ROOT
    ? resolve(env.FENIX_INTEGRATIONS_ROOT)
    : null;
  if (!root) {
    errors.push(
      `${label}: only the fixed approved mount (${DEFAULT_CLUSTERS_PATH}) is accepted, ` +
        "or an absolute path inside FENIX_INTEGRATIONS_ROOT",
    );
    return;
  }
  const abs = resolve(value);
  if (!isAbsolute(value)) {
    errors.push(`${label}: must be an absolute path`);
    return;
  }
  if (abs !== root && !abs.startsWith(root + sep)) {
    errors.push(`${label}: must stay inside FENIX_INTEGRATIONS_ROOT (${root})`);
    return;
  }
  if (!abs.endsWith(".json")) {
    errors.push(`${label}: must point at a .json artifact`);
  }
}

/** One explicit tool list (leadTools value / roleOverrides leaf). */
function checkToolList(tools, label, config, errors) {
  if (tools === null) return; // null = inherit native availability
  if (!Array.isArray(tools)) {
    errors.push(`${label}: must be an array of tool names or null`);
    return;
  }
  if (tools.length > TOOL_LIST_MAX) {
    errors.push(`${label}: at most ${TOOL_LIST_MAX} tools`);
    return;
  }
  for (const tool of tools) {
    if (typeof tool !== "string" || !TOOL_NAME_RE.test(tool)) {
      errors.push(`${label}: tool names must match ${TOOL_NAME_RE}, got ${JSON.stringify(tool) ?? String(tool)}`);
      continue;
    }
    const m = /^mcp__([a-z0-9-]+)__(.+)$/.exec(tool);
    if (!m) continue; // built-in / permission-style names pass through
    if (m[1] !== MCP_SERVER) {
      errors.push(`${label}: MCP server "${m[1]}" is not registered (only ${MCP_SERVER})`);
      continue;
    }
    // Unknown thoughtmap tool names are PRESERVED here (resolve marks them
    // unavailable, never granted) — but enabling any mcp__thoughtmap__ tool
    // requires the server to be enabled in the SAME merged config.
    if (!config?.mcp?.thoughtmap?.enabled) {
      errors.push(`${label}: "${tool}" requires mcp.thoughtmap.enabled=true in the same change`);
    }
  }
}

/** Squad keys validated against the real squad set when it is readable. */
function knownSquads() {
  try {
    return Object.keys(readSquadConfig().squads);
  } catch {
    return null; // squad-config unreadable → regex-only validation stands
  }
}

function checkToolOverridesMap(map, label, config, errors) {
  if (!isPlainObject(map)) {
    errors.push(`${label}: must be an object`);
    return;
  }
  const squads = knownSquads();
  for (const [key, value] of Object.entries(map)) {
    if (label === "leadTools" || label === "squadTools") {
      if (!SQUAD_NAME_RE.test(key)) {
        errors.push(`${label}.${key}: squad name must match ${SQUAD_NAME_RE.source}`);
        continue;
      }
      if (squads && key !== "supervisor" && !squads.includes(key)) {
        errors.push(`${label}.${key}: not a configured squad (${squads.join(", ")})`);
        continue;
      }
      checkToolList(value, `${label}.${key}`, config, errors);
    } else {
      // roleOverrides: squad → { role: list|null }
      if (!SQUAD_NAME_RE.test(key)) {
        errors.push(`${label}.${key}: squad name must match ${SQUAD_NAME_RE.source}`);
        continue;
      }
      if (!isPlainObject(value)) {
        errors.push(`${label}.${key}: must be an object of role → tool list`);
        continue;
      }
      for (const [role, list] of Object.entries(value)) {
        if (!ROLE_NAME_RE.test(role)) {
          errors.push(`${label}.${key}.${role}: role name must match ${ROLE_NAME_RE.source}`);
          continue;
        }
        checkToolList(list, `${label}.${key}.${role}`, config, errors);
      }
    }
  }
}

function checkSecrets(node, where, errors) {
  if (typeof node === "string") {
    if (SECRET_RE.test(node)) errors.push(`${where}: tool-profiles must not contain secrets`);
    return;
  }
  if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node)) checkSecrets(value, `${where}.${key}`, errors);
  } else if (Array.isArray(node)) {
    // Tool lists are arrays — the credential scan must reach into them too.
    node.forEach((value, index) => checkSecrets(value, `${where}[${index}]`, errors));
  }
}

// ─── Schema validation ───────────────────────────────────────────────────────

const TOP_LEVEL_KEYS = ["version", "revision", "mcp", "globalTools", "squadTools", "leadTools"];
const THOUGHTMAP_KEYS = ["enabled", "baseUrl", "ollamaBaseUrl", "embeddingModel", "clustersPath"];

/**
 * Validate a whole registry object. Strict: unknown keys anywhere are refused,
 * secrets are refused, and the MCP-enable rule holds against the merged state.
 */
export function validateToolProfiles(obj, env = process.env) {
  const errors = [];
  if (!isPlainObject(obj)) return { ok: false, errors: ["tool-profiles: must be a JSON object"] };
  const secretErrors = [];
  checkSecrets(obj, "tool-profiles", secretErrors);
  if (secretErrors.length) return { ok: false, errors: ["tool-profiles must not contain secrets"] };

  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.includes(key)) errors.push(`${key}: unknown top-level key`);
  }
  if (obj.version !== undefined && obj.version !== 1) errors.push("version: only schema version 1 exists");
  if (obj.revision !== undefined && (!Number.isInteger(obj.revision) || obj.revision < 0)) {
    errors.push("revision: must be a non-negative integer");
  }

  if (obj.mcp !== undefined) {
    if (!isPlainObject(obj.mcp)) errors.push("mcp: must be an object");
    else {
      for (const key of Object.keys(obj.mcp)) {
        if (key !== MCP_SERVER) errors.push(`mcp.${key}: unknown MCP server (only ${MCP_SERVER} is registered)`);
      }
      const tm = obj.mcp[MCP_SERVER];
      if (tm !== undefined) {
        if (!isPlainObject(tm)) errors.push(`mcp.${MCP_SERVER}: must be an object`);
        else {
          for (const key of Object.keys(tm)) {
            if (!THOUGHTMAP_KEYS.includes(key)) errors.push(`mcp.${MCP_SERVER}.${key}: unknown key`);
          }
          if (tm.enabled !== undefined && typeof tm.enabled !== "boolean") {
            errors.push(`mcp.${MCP_SERVER}.enabled: must be a boolean`);
          }
          if (tm.baseUrl !== undefined) checkBaseUrl(tm.baseUrl, `mcp.${MCP_SERVER}.baseUrl`, errors);
          if (tm.ollamaBaseUrl !== undefined) checkBaseUrl(tm.ollamaBaseUrl, `mcp.${MCP_SERVER}.ollamaBaseUrl`, errors);
          if (tm.embeddingModel !== undefined) {
            if (typeof tm.embeddingModel !== "string" || !MODEL_RE.test(tm.embeddingModel)) {
              errors.push(`mcp.${MCP_SERVER}.embeddingModel: must match ${MODEL_RE.source} (1..64 chars)`);
            }
          }
          if (tm.clustersPath !== undefined) checkClustersPath(tm.clustersPath, `mcp.${MCP_SERVER}.clustersPath`, errors, env);
        }
      }
    }
  }

  if (obj.leadTools !== undefined) checkToolOverridesMap(obj.leadTools, "leadTools", obj, errors);
  if (obj.globalTools !== undefined) checkToolList(obj.globalTools, "globalTools", obj, errors);
  if (obj.squadTools !== undefined) checkToolOverridesMap(obj.squadTools, "squadTools", obj, errors);

  checkSecrets(obj, "tool-profiles", errors);
  return { ok: errors.length === 0, errors };
}

// ─── Merge + diff (settings semantics: null deletes, objects recurse) ────────

function mergeInto(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key];
    } else if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeInto(target[key], value);
    } else if (isPlainObject(value)) {
      target[key] = mergeInto({}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function diffInto(before, after, prefix, out) {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) diffInto(before[key], after[key], prefix ? `${prefix}.${key}` : key, out);
    return;
  }
  if (!isDeepStrictEqual(before, after)) {
    out.push({
      path: prefix,
      before: before === undefined ? null : before,
      after: after === undefined ? null : after,
    });
  }
}

// ─── Read / write ────────────────────────────────────────────────────────────

/**
 * The validated registry, or the defaults when the file does not exist yet.
 * An existing file that fails validation throws — a silently half-ignored
 * registry would grant tools nobody reviewed.
 */
export function readToolProfiles({ path = toolProfilesPath() } = {}) {
  if (!existsSync(path)) return emptyToolProfiles();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`tool-profiles.json is not valid JSON: ${path}`);
  }
  const { ok, errors } = validateToolProfiles(parsed);
  if (!ok) {
    throw new Error(`tool-profiles.json is invalid:\n- ${errors.join("\n- ")}`);
  }
  return parsed;
}

/**
 * Deep-merge a patch into the registry and atomically persist it. Revision is
 * managed here (never accepted from a patch): each real write bumps it, and
 * `expectedRevision` turns the write into compare-and-swap so two concurrent
 * writers (the API and a CLI) cannot clobber each other silently.
 *
 * Returns { config, changes } — changes as dotted-path before/after rows.
 */
function writeUnlockedToolProfiles(patch, { path = toolProfilesPath(), dryRun = false, expectedRevision } = {}) {
  if (!isPlainObject(patch)) throw new TypeError("writeToolProfiles: patch must be a plain object");
  if ("revision" in patch || "version" in patch) {
    throw new TypeError("writeToolProfiles: revision/version are managed automatically and cannot be patched");
  }

  const onDisk = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const before = isPlainObject(onDisk) ? onDisk : emptyToolProfiles();
  // mergeInto mutates its target — merge into a copy so `before` stays the
  // pristine on-disk state the change diff is computed against.
  const merged = mergeInto(JSON.parse(JSON.stringify(before)), patch);
  merged.version = 1;
  const diskRevision = isPlainObject(onDisk) && Number.isInteger(onDisk.revision) ? onDisk.revision : 0;
  merged.revision = diskRevision + 1;

  if (expectedRevision !== undefined && expectedRevision !== diskRevision) {
    throw new Error(
      `tool-profiles revision conflict: expected ${expectedRevision}, the file holds ${diskRevision} — re-read and retry`,
    );
  }

  const { ok, errors } = validateToolProfiles(merged);
  if (!ok) {
    throw new Error(`tool-profiles validation failed:\n- ${errors.join("\n- ")}`);
  }

  const changes = [];
  diffInto(isPlainObject(onDisk) ? onDisk : emptyToolProfiles(), merged, "", changes);

  if (dryRun) return { config: merged, changes };

  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJSON(path, merged);
  return { config: merged, changes };
}

// Serialize the read/CAS/write sequence across API and CLI processes.
export function writeToolProfiles(patch, options = {}) {
  const path = options.path ?? toolProfilesPath();
  mkdirSync(dirname(path), { recursive: true });
  const lock = path + '.lock';
  try { mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw Error('tool-profiles revision conflict: another writer owns the registry lock');
    throw error;
  }
  try { return writeUnlockedToolProfiles(patch, { ...options, path }); }
  finally { rmdirSync(lock); }
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

/** config/mcp-tools.json parsed, or empty shapes when absent/unreadable. */
function readMcpToolsCatalog() {
  const path = join(REPO_ROOT, "config", "mcp-tools.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const servers = {};
    for (const [name, entry] of Object.entries(parsed.servers || {})) {
      if (!name.startsWith("_")) servers[name] = entry;
    }
    const tools = {};
    for (const [name, entry] of Object.entries(parsed.tools || {})) {
      if (!name.startsWith("_")) tools[name] = entry;
    }
    return { servers, tools };
  } catch {
    return { servers: {}, tools: {} };
  }
}

/**
 * The merged tool catalog: builtin config/tools.json entries (Read, Bash, …)
 * plus the MCP catalog, namespaced mcp__<server>__<tool>. Server metadata
 * carries what the registry CONFIGURES (serverEnabled) — availability is never
 * faked here; only POST /api/tool-profiles/test verifies a live server.
 */
export function getToolCatalog({ path = toolProfilesPath() } = {}) {
  let builtin = { tools: {}, riskLevels: {} };
  try {
    builtin = readToolCatalog();
  } catch {
    /* degraded catalog, still serves the MCP half */
  }
  const mcp = readMcpToolsCatalog();
  let serverEnabled = false;
  try {
    serverEnabled = Boolean(readToolProfiles({ path }).mcp[MCP_SERVER].enabled);
  } catch {
    /* an unreadable registry reads as disabled — never as enabled */
  }
  const tools = {};
  for (const [name, entry] of Object.entries(builtin.tools)) {
    tools[name] = { ...entry, source: "builtin" };
  }
  for (const [name, entry] of Object.entries(mcp.tools)) {
    tools[name] = { ...entry, source: "mcp", serverEnabled, verified: null };
  }
  return { tools, riskLevels: builtin.riskLevels, servers: mcp.servers };
}

// ─── Resolve ─────────────────────────────────────────────────────────────────

/** The stdio launch config for the thoughtmap adapter — paths and URLs only, never secrets. */
export function thoughtmapStdioConfig(cfg, tools = null) {
  return {
    command: "python",
    args: [join(REPO_ROOT, "scripts", "mcp", "server-thoughtmap.py")],
    env: {
      ...(Array.isArray(tools) ? { THOUGHTMAP_ALLOWED_TOOLS: JSON.stringify(tools.filter(t=>t.startsWith("mcp__thoughtmap__")).map(t=>t.slice("mcp__thoughtmap__".length))) } : {}),
      THOUGHTMAP_API_URL: cfg.baseUrl,
      THOUGHTMAP_CLUSTERS: cfg.clustersPath,
      OLLAMA_BASE_URL: cfg.ollamaBaseUrl,
      OLLAMA_EMBEDDING_MODEL: cfg.embeddingModel,
    },
  };
}

/**
 * When does the resolved profile attach the thoughtmap MCP server?
 *   - server disabled            → never (a disabled server can never be enabled implicitly)
 *   - explicit list (non-empty)  → only when the list itself names a thoughtmap tool
 *   - explicit []                → never (explicit none)
 *   - null (inherit native)      → yes, when enabled: the enabled server adds
 *                                  itself to the native availability
 */
function serverIncluded(cfg, tools) {
  if (!cfg?.enabled) return false;
  if (tools === null) return false;
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return tools.some((t) => typeof t === "string" && t.startsWith(`mcp__${MCP_SERVER}__`));
}

/** The worker role's authoritative frontmatter tools, or null when unknown. */
function readNativeTools(squad, role) {
  try {
    const squads = readSquadConfig().squads;
    const tools = squads?.[squad]?.agents?.[role]?.tools;
    return Array.isArray(tools) ? [...tools] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective tool profile for one squad role.
 *
 *   tools: null            → inherit the current native availability
 *                            (worker: frontmatter; lead: whatever the CLI
 *                            grants by default — CLAUDE.md alone does NOT
 *                            restrict the main CLI session)
 *   tools: []              → explicit none
 *   tools: [names...]      → explicit list; unknown names are preserved but
 *                            reported in `unavailable` and never granted
 *
 * MCP tool names are mcp__thoughtmap__search_thoughts etc. (see
 * config/mcp-tools.json). A disabled server can never appear in mcpServers.
 */
export function resolveToolProfile({ squad, role = "lead", env = process.env } = {}, { path = toolProfilesPath(env) } = {}) {
  const config = readToolProfiles({ path });
  if (typeof squad !== "string" || !SQUAD_NAME_RE.test(squad)) {
    throw new TypeError(`resolveToolProfile: squad must match ${SQUAD_NAME_RE.source}`);
  }
  if (role !== "lead" && !ROLE_NAME_RE.test(role)) {
    throw new TypeError(`resolveToolProfile: role must be "lead" or match ${ROLE_NAME_RE.source}`);
  }

  const cfg = config.mcp?.[MCP_SERVER] ?? { ...DEFAULT_THOUGHTMAP };
  let explicit;
  let nativeTools = null;
  if (role === "lead") {
    explicit = config.leadTools?.[squad] ?? config.squadTools?.[squad] ?? config.globalTools ?? null;
  } else {
    nativeTools = readNativeTools(squad, role);
    explicit = nativeTools ?? config.squadTools?.[squad] ?? config.globalTools ?? null;
  }

  const tools = explicit !== null ? [...explicit] : null;
  const catalog = getToolCatalog({ path });
  const unavailable = Array.isArray(tools) ? tools.filter((t) => !catalog.tools[t]) : [];

  const mcpServers = {};
  if (serverIncluded(cfg, tools)) mcpServers[MCP_SERVER] = thoughtmapStdioConfig(cfg, tools);

  return {
    revision: config.revision,
    squad,
    role,
    tools,
    unavailable,
    nativeTools,
    mcpServers,
  };
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * The lead's CLI argument for actual tool availability. `--tools` RESTRICTS
 * the available tool list; `--allowedTools` only pre-approves permissions and
 * restricts nothing — verified against the local `claude --help` — so the
 * lead launch uses --tools and NEVER --allowedTools for restriction.
 */
function leadCliArgs(profile) {
  const args = [];
  if (Array.isArray(profile.tools)) {
    const builtin = profile.tools.filter(t => !t.startsWith('mcp__') && !profile.unavailable.includes(t));
    args.push('--tools', builtin.join(',')); // Empty string means NONE, not defaults.
  }
  // Each MCP process exposes only this role's selected tools. A global CLI
  // deny list would also deny tools explicitly granted to native workers.
  return args;
}

/**
 * Write ONLY the two safe config files (snapshot.json + mcp.json) into a
 * launch-owned outputDir and return { profile, mcpConfigPath, cliArgs, env }.
 * No secret value can appear: the schema refuses them, and the mcp env block
 * carries URLs / model name / clusters path only. Worker roles get cliArgs []
 * — their tool sets are governed by frontmatter at spawn time, not CLI flags.
 */
export function snapshotToolProfile(
  { squad, role = "lead", outputDir, env = process.env } = {},
  { path = toolProfilesPath(env) } = {},
) {
  if (typeof outputDir !== "string" || outputDir.trim() === "") {
    throw new TypeError("snapshotToolProfile: outputDir is required");
  }
  const dir = resolve(outputDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`snapshotToolProfile: outputDir must be an existing directory: ${dir}`);
  }

  const profile = resolveToolProfile({ squad, role, env }, { path });
  const cliArgs = profile.role === "lead" ? leadCliArgs(profile) : [];

  const snapshot = {
    squad: profile.squad,
    role: profile.role,
    revision: profile.revision,
    tools: profile.tools,
    unavailable: profile.unavailable,
    nativeTools: profile.nativeTools,
    mcpServers: profile.mcpServers,
    cliArgs,
    generatedAt: new Date().toISOString(),
  };
  const mcpConfigPath = join(dir, "mcp.json");
  atomicWriteJSON(join(dir, "snapshot.json"), snapshot);
  atomicWriteJSON(mcpConfigPath, { mcpServers: profile.mcpServers });

  const envOut = profile.mcpServers[MCP_SERVER] ? { ...profile.mcpServers[MCP_SERVER].env } : {};
  return { profile, mcpConfigPath, cliArgs, env: envOut };
}
