// squad-config — read/write LLM model + tool configuration per squad.
//
// ESM, zero runtime deps (Node 18+).
//
// Exports:
//   readSquadConfig(root?)   → { squads, pricing, providers }
//   readToolCatalog(root?)   → { tools, riskLevels }
//   validateSlug(slug, provider?) → { ok, warning }
//   validateTools(tools, cat) → { ok, unknown, warnings }
//   validateProvidersPatch(patch, current) → { ok, errors, warnings }
//   writeSquadConfig(patch, root?, {dryRun}) → { changed, warnings, refused }
//
// FOC-771: the .bat launchers are two-line wrappers around
// scripts/squad-start.mjs and carry no ANTHROPIC_MODEL lines, so the lead is
// read and written through the SAME sources the launcher resolves at start
// (scripts/child-model.mjs childModelFor): the settings overlay's
// routing.<squad>.lead first, then config/models.json routing.<squad>
// (lead ?? default ?? worker, through the `ids` aliases), then the active
// provider's defaultModel. The provider is the ONE active provider
// (resolveProvider) — a per-squad LA_PROVIDER line no longer exists. A lead
// write goes through fenix-settings.writeSettings (validated, atomic) and is
// REFUSED for an id without a pricing row (supervisor-lib hasPriceRow, FOC-165:
// the cost must be a priced number, code "model-unpriced").

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJSON } from "./utils.mjs";
import { squadConfigRoot, settingsPath } from "./fenix-paths.mjs";
import { readSettings, writeSettings } from "./fenix-settings.mjs";
import { childModelFor } from "./child-model.mjs";
import { resolveProvider } from "./provider-resolve.mjs";
import { hasPriceRow } from "./supervisor-lib.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function repoRoot(custom) {
  if (custom) return custom;
  return join(__dirname, "..");
}

// Squad dirs for a root: the default repo root routes through squadConfigRoot()
// so reads and writes land where squads actually live (LA_SQUAD_HOME); an
// explicit custom root keeps its own agents/ below it.
function agentsRootFor(r) {
  return r === repoRoot() ? squadConfigRoot() : join(r, "agents");
}

/** Detect line ending of a file: "\r\n" or "\n". */
function detectEOL(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Atomic text write preserving original EOL. */
function atomicWriteText(filePath, content, eol) {
  const tmp =
    filePath + "." + randomBytes(4).readUInt32BE(0).toString(36);
  // Ensure content ends with the correct EOL
  const normalized = content.endsWith(eol) ? content : content + eol;
  writeFileSync(tmp, normalized, "utf8");
  renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Read: the lead model from the routing sources, the provider from resolveProvider
// ---------------------------------------------------------------------------

// The Supervisor's model when nothing else decides it — the same built-in
// fallback the Node entry point uses (SUPERVISOR_MODEL env > the settings
// overlay's routing.supervisor.lead > this).
const SUPERVISOR_FALLBACK_MODEL = "x-ai/grok-4.7";

// fenix-settings' routing-key rule (provider side). A squad name that cannot
// live in settings.json cannot have its lead written there — refuse up front
// instead of letting writeSettings throw mid-write.
const OVERLAY_SQUAD_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Parse config/models.json once for routing + ids + providers + pricing. */
function readModelsConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, "config", "models.json"), "utf8"));
  } catch {
    return {};
  }
}

// The settings overlay for a root: LA_SETTINGS_FILE is the documented seam and
// wins for any root (tests and the container pin their file through it); the
// default repo root keeps fenix-paths.settingsPath()'s full precedence
// (LA_PROJECTS_FILE, repo .fenix/config); a custom library root gets its own
// .fenix/config next to the fixture, never the real install's overlay.
function settingsPathFor(root, env = process.env) {
  if (env.LA_SETTINGS_FILE) return env.LA_SETTINGS_FILE;
  if (root === repoRoot()) return settingsPath(env);
  return join(root, ".fenix", "config", "settings.json");
}

/** Read the overlay. A broken file degrades to empty instead of killing the
 *  whole dashboard read — but loudly, on stderr, the readToolCatalog way. */
function readOverlay(path) {
  try {
    return readSettings({ path });
  } catch (err) {
    console.error(`readSquadConfig: ${err.message} — ignoring the overlay for this read`);
    return {};
  }
}

/**
 * Everything the lead/provider resolution needs for one root, computed once.
 * The provider comes through resolveProvider — the same resolution the entry
 * point performs at start — but as a READ it degrades to the openrouter
 * default when the active provider is unknown or the overlay is broken: the
 * launcher side stays fail-closed (resolveProvider throws there); a dashboard
 * read becoming unreadable over a misconfigured provider would hide every
 * other field on the screen.
 */
function resolutionContext(root) {
  const modelsConfig = readModelsConfig(root);
  const settingsFile = settingsPathFor(root);
  const overlay = readOverlay(settingsFile);
  let provider = "openrouter";
  let defaultModel = null;
  try {
    const resolved = resolveProvider(undefined, {
      configPath: join(root, "config", "models.json"),
      envPath: join(root, ".env"),
      settingsPath: settingsFile,
    });
    provider = resolved.provider;
    defaultModel = resolved.defaultModel;
  } catch (err) {
    console.error(
      `readSquadConfig: provider resolution failed (${String(err?.message ?? err).split("\n")[0]}) — reading leads against the openrouter default`,
    );
  }
  // childModelFor only reads providerEntry.defaultModel; resolveProvider
  // already resolved it (including the settings-only "custom" provider, which
  // has no models.json entry at all).
  const providerEntry = defaultModel ? { defaultModel } : null;
  return { modelsConfig, overlay, settingsFile, provider, providerEntry };
}

function relativeLabel(root, filePath) {
  const rel = relative(root, filePath);
  return rel.startsWith("..") ? filePath : rel;
}

function leadSourceOf(source) {
  // childModelFor calls the provider's fallback "provider-default"; the
  // dashboard vocabulary here is "default" (settings / routing names match
  // its sources verbatim).
  return source === "provider-default" ? "default" : source;
}

/**
 * The lead one squad runs on — the same resolution scripts/squad-start.mjs
 * and supervisor-spawn's childModelFor perform at start, so the dashboard
 * can no longer name a model the launcher would not pick. First hit wins:
 *   supervisor: SUPERVISOR_MODEL env → the settings overlay's
 *               routing.supervisor.lead → the built-in fallback
 *               (xiaomi/mimo-v2.6-pro). The routing table's
 *               routing.supervisor.default is the CHILDREN's alias
 *               (supervisor-spawn resolves through it) and was never the
 *               frontman's model — it is deliberately not consulted here.
 *   others:     overlay routing.<squad>.lead → routing.<squad>
 *               (lead ?? default ?? worker) → the provider's defaultModel
 *
 * The NATIVE branch of the old launchers had no dashboard representation and
 * needs none here: NATIVE mode is a launcher flag, its opus ids live in
 * config/native-models.json (data), not in a squad's lead field.
 */
function resolveSquadLead(squad, { overlay, modelsConfig, provider, providerEntry }) {
  if (squad === "supervisor") {
    const envModel =
      typeof process.env.SUPERVISOR_MODEL === "string" ? process.env.SUPERVISOR_MODEL.trim() : "";
    if (envModel) return { lead: envModel, source: "env:SUPERVISOR_MODEL" };
    const overlayLead = overlay?.routing?.supervisor?.lead;
    if (typeof overlayLead === "string" && overlayLead.trim()) {
      return { lead: overlayLead.trim(), source: "settings:routing.supervisor" };
    }
    // No env, no overlay lead — the built-in fallback is the answer.
    return { lead: SUPERVISOR_FALLBACK_MODEL, source: "fallback" };
  }
  const resolved = childModelFor({ squad, settings: overlay, modelsConfig, provider, providerEntry });
  if (!resolved.model) return { lead: null, source: null };
  return { lead: resolved.model, source: leadSourceOf(resolved.source) };
}

/** Files a lead edit is allowed to land in, labelled the way the resolver
 *  reads them. Empty when nothing on disk decides the lead (env / fallback). */
function leadFilesFor(squad, source, settingsFile, root) {
  if (typeof source === "string" && source.startsWith("settings:")) {
    return [relativeLabel(root, settingsFile)];
  }
  if (source === "default" || (typeof source === "string" && source.startsWith("routing:"))) {
    return ["config/models.json"];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Read: subagent models from agents/<squad>/agents/*.md
// ---------------------------------------------------------------------------

const FRONTMATTER_MODEL_RE = /^model:\s*(.+)$/;
const FRONTMATTER_TOOLS_RE = /^tools:\s*(.+)$/;

/** Read a single agent's model from its .md file. Returns null if not found. */
function readAgentModel(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const m = lines[i].match(FRONTMATTER_MODEL_RE);
    if (m) return m[1].trim();
  }
  return null;
}

/** Read a single agent's tools from its .md file. Returns array (empty if not found). */
function readAgentTools(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const m = lines[i].match(FRONTMATTER_TOOLS_RE);
    if (m) {
      return m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(t => Boolean(t) && t !== "[]");
    }
  }
  return [];
}

function readAgentConfigs(squadDir) {
  const agentsDir = join(squadDir, "agents");
  if (!existsSync(agentsDir)) return {};

  const result = {};
  let entries;
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return {};
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const role = entry.name.replace(/\.md$/, "");
    const filePath = join(agentsDir, entry.name);
    const content = readFileSync(filePath, "utf8");

    // Parse frontmatter (between first two --- lines)
    const lines = content.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") {
      result[role] = { model: null, tools: [] };
      continue;
    }
    let model = null;
    let tools = [];
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") break;
      const mm = lines[i].match(FRONTMATTER_MODEL_RE);
      if (mm) {
        model = mm[1].trim();
      }
      const tm = lines[i].match(FRONTMATTER_TOOLS_RE);
      if (tm) {
        tools = tm[1]
          .split(",")
          .map((s) => s.trim())
          .filter(t => Boolean(t) && t !== "[]");
      }
    }
    result[role] = { model, tools };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Read: pricing from config/models.json
// ---------------------------------------------------------------------------

function readPricing(root) {
  const modelsPath = join(root, "config", "models.json");
  if (!existsSync(modelsPath)) return {};
  const raw = readFileSync(modelsPath, "utf8");
  const data = JSON.parse(raw);
  const pricing = data?.pricing ?? {};
  // Pricing is scoped per provider: { provider: { modelId: price } }.
  // Strip metadata keys (_doc, _note, etc.) at both the provider and model
  // level — the UI must only see real pricing entries.
  const filtered = {};
  for (const [providerKey, providerPricing] of Object.entries(pricing)) {
    if (providerKey.startsWith("_")) continue;
    const models = {};
    if (providerPricing && typeof providerPricing === "object") {
      for (const [modelId, price] of Object.entries(providerPricing)) {
        if (!modelId.startsWith("_")) models[modelId] = price;
      }
    }
    filtered[providerKey] = models;
  }
  return filtered;
}

function readProviders(root) {
  const modelsPath = join(root, "config", "models.json");
  if (!existsSync(modelsPath)) return {};
  const raw = readFileSync(modelsPath, "utf8");
  const data = JSON.parse(raw);
  const providers = data?.providers ?? {};
  // Strip metadata keys — provider names never start with "_", but be defensive.
  const filtered = {};
  for (const [name, profile] of Object.entries(providers)) {
    if (!name.startsWith("_")) filtered[name] = profile;
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// Public: readSquadConfig
// ---------------------------------------------------------------------------

/**
 * The squads, derived from `config/models.json` routing rather than listed here.
 *
 * This was a hardcoded array, and it is why the Supervisor was invisible in the
 * dashboard for as long as it existed: `agents/supervisor/` and
 * `routing.supervisor` were added and the eight copies of this list were not
 * (FOC-170). Deriving it means the next squad appears by existing.
 *
 * `routing` is the right source: a squad with no model routing cannot run, and
 * one that can run should be visible. Underscore keys are metadata, repo-wide
 * convention.
 */
const BASE_SQUADS = ["cadence", "dev", "plan", "review", "test"];

function squadNames(root) {
  // UNION, never replacement. Deriving the list purely from routing looked
  // cleaner and was wrong: a config with partial routing would silently NARROW
  // the dashboard, which is the same disappearing act this function exists to
  // stop, just relocated. Caught by squad-config-read.test.mjs, whose fixture
  // routes only `dev` — under the derive-only version, plan vanished.
  //
  // So the base list is a floor that cannot shrink, and routing can only add to
  // it. A models.json that cannot be read costs the new squads, not all of them.
  const names = new Set(BASE_SQUADS);
  try {
    const models = JSON.parse(readFileSync(join(root, "config", "models.json"), "utf8"));
    for (const k of Object.keys(models.routing ?? {})) {
      if (!k.startsWith("_")) names.add(k);
    }
  } catch {
    /* the floor stands */
  }
  return [...names].sort();
}

export function readSquadConfig(root) {
  const r = root ? root : repoRoot();
  const squads = {};
  const ctx = resolutionContext(r);

  for (const squad of squadNames(r)) {
    const lead = resolveSquadLead(squad, ctx);
    const squadDir = join(agentsRootFor(r), squad);
    const agents = readAgentConfigs(squadDir);

    squads[squad] = {
      lead: lead.lead,
      leadSource: lead.source,
      leadFiles: leadFilesFor(squad, lead.source, ctx.settingsFile, r),
      provider: ctx.provider,
      agents,
    };
  }

  const pricing = readPricing(r);
  const providers = readProviders(r);

  return { squads, pricing, providers };
}

// ---------------------------------------------------------------------------
// Public: readToolCatalog
// ---------------------------------------------------------------------------

export function readToolCatalog(root) {
  const r = root ? root : repoRoot();
  const toolsPath = join(r, "config", "tools.json");
  try {
    if (!existsSync(toolsPath)) {
      console.error("readToolCatalog: config/tools.json not found");
      return { tools: {}, riskLevels: {} };
    }
    const raw = readFileSync(toolsPath, "utf8");
    const data = JSON.parse(raw);
    const tools = {};
    for (const [k, v] of Object.entries(data.tools || {})) {
      if (!k.startsWith("_")) tools[k] = v;
    }
    const riskLevels = {};
    for (const [k, v] of Object.entries(data.riskLevels || {})) {
      if (!k.startsWith("_")) riskLevels[k] = v;
    }
    return { tools, riskLevels };
  } catch (err) {
    console.error("readToolCatalog: failed to parse config/tools.json:", err.message);
    return { tools: {}, riskLevels: {} };
  }
}

// ---------------------------------------------------------------------------
// Public: validateTools
// ---------------------------------------------------------------------------

export function validateTools(tools, catalog) {
  const warnings = [];
  const unknown = [];

  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string" || t.trim() === "")) {
    return { ok: false, unknown: [], warnings: ["Lista narzędzi musi być tablicą stringów."] };
  }

  const catalogNames = new Set(Object.keys(catalog.tools || {}));

  for (const t of tools) {
    if (!catalogNames.has(t)) {
      unknown.push(t);
      warnings.push(`Narzędzie "${t}" nie występuje w katalogu config/tools.json — katalog może być niepełny.`);
    }
  }

  if (tools.includes("Task")) {
    warnings.push(
      "Narzędzie Task pozwala na zagnieżdżoną delegację — zmienia to architekturę hierarchii agentów z płaskiej (lead → subagent) na wielopoziomową."
    );
  }

  return { ok: true, unknown, warnings };
}

// ---------------------------------------------------------------------------
// Public: validateSlug (provider-aware)
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9_.-]+\/[A-Za-z0-9._:-]+$/;
// Loose model-ID shape for custom providers: .bat/frontmatter-safe, no
// spaces/quotes/percent (those would break `set` and the frontmatter line).
const CUSTOM_MODEL_RE = /^[A-Za-z0-9._:/-]+$/;
const DEFAULT_PROVIDER = 'openrouter';

export function validateSlug(slug, provider = DEFAULT_PROVIDER) {
  if (!slug || typeof slug !== "string" || slug.trim() === "") {
    return { ok: false, warning: "Slug nie może być pusty." };
  }
  if (provider !== DEFAULT_PROVIDER) {
    if (!CUSTOM_MODEL_RE.test(slug)) {
      return {
        ok: false,
        warning:
          `Model "${slug}" ma niedozwolone znaki dla providera "${provider}" ` +
          "(dozwolone: litery, cyfry, . _ : / -; bez spacji, cudzysłowów i %).",
      };
    }
    return { ok: true, warning: null };
  }
  if (!SLUG_RE.test(slug)) {
    return {
      ok: true,
      warning:
        "Slug nie wygląda jak 'provider/model' — sprawdź nazwę na OpenRouter.",
    };
  }
  return { ok: true, warning: null };
}

// ---------------------------------------------------------------------------
// Write: subagent model to agents/<squad>/agents/<role>.md
// ---------------------------------------------------------------------------

function writeAgentModel(filePath, newModel) {
  const content = readFileSync(filePath, "utf8");
  const eol = detectEOL(content);
  const lines = content.split(/\r?\n/);

  if (lines[0]?.trim() !== "---") {
    return { changed: false, before: null, after: null };
  }

  let changed = false;
  let before = null;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const m = lines[i].match(FRONTMATTER_MODEL_RE);
    if (m) {
      before = m[1].trim();
      if (before !== newModel) {
        lines[i] = lines[i].replace(
          /^(model:\s*).+$/,
          `$1${newModel}`
        );
        changed = true;
      }
      break;
    }
  }

  if (changed) {
    const newContent = lines.join(eol);
    atomicWriteText(filePath, newContent, eol);
  }

  return { changed, before, after: changed ? newModel : before };
}

// ---------------------------------------------------------------------------
// Write: subagent tools to agents/<squad>/agents/<role>.md
// ---------------------------------------------------------------------------

function writeAgentTools(filePath, newTools) {
  const content = readFileSync(filePath, "utf8");
  const eol = detectEOL(content);
  const lines = content.split(/\r?\n/);

  if (lines[0]?.trim() !== "---") {
    return { changed: false, before: null, after: null };
  }

  const toolsLine = newTools.length ? newTools.join(", ") : "[]";
  let changed = false;
  let before = null;
  let toolsLineIdx = -1;
  let modelLineIdx = -1;
  let frontmatterEnd = -1;

  // Find frontmatter boundaries and existing lines
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      frontmatterEnd = i;
      break;
    }
    if (FRONTMATTER_TOOLS_RE.test(lines[i])) {
      toolsLineIdx = i;
    }
    if (FRONTMATTER_MODEL_RE.test(lines[i])) {
      modelLineIdx = i;
    }
  }

  if (toolsLineIdx >= 0) {
    // Replace existing tools line
    const m = lines[toolsLineIdx].match(FRONTMATTER_TOOLS_RE);
    before = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(t => Boolean(t) && t !== "[]");
    const beforeStr = before.join(", ");
    // An empty target must not rewrite a line that already holds no tools —
    // "tools:" and "tools: []" both read as none (readAgentTools returns []),
    // so rewriting them would report changed:true on every idempotent repeat.
    if (beforeStr !== toolsLine && !(toolsLine === "[]" && before.length === 0)) {
      lines[toolsLineIdx] = `tools: ${toolsLine}`;
      changed = true;
    }
  } else if (modelLineIdx >= 0) {
    // Insert after model: line
    before = [];
    lines.splice(modelLineIdx + 1, 0, `tools: ${toolsLine}`);
    changed = true;
  } else if (frontmatterEnd >= 0) {
    // No model line either — insert before closing ---
    before = [];
    lines.splice(frontmatterEnd, 0, `tools: ${toolsLine}`);
    changed = true;
  } else {
    return { changed: false, before: null, after: null };
  }

  if (changed) {
    const newContent = lines.join(eol);
    atomicWriteText(filePath, newContent, eol);
  }

  return { changed, before, after: changed ? newTools : before };
}

// ---------------------------------------------------------------------------
// Write: merge pricing into config/models.json
// ---------------------------------------------------------------------------

function writePricing(root, pricingPatch) {
  const modelsPath = join(root, "config", "models.json");
  if (!existsSync(modelsPath)) {
    return [];
  }

  const raw = readFileSync(modelsPath, "utf8");
  const data = JSON.parse(raw);

  if (!data.pricing) data.pricing = {};

  const changed = [];
  for (const [providerKey, providerPatch] of Object.entries(pricingPatch)) {
    // Silently skip metadata keys — they are not pricing entries
    if (providerKey.startsWith("_")) continue;
    if (!data.pricing[providerKey] || typeof data.pricing[providerKey] !== "object") {
      data.pricing[providerKey] = {};
    }
    for (const [slug, price] of Object.entries(providerPatch)) {
      // Silently skip metadata keys at the model level too
      if (slug.startsWith("_")) continue;
      const before = data.pricing[providerKey][slug]
        ? JSON.stringify(data.pricing[providerKey][slug])
        : null;
      const after = JSON.stringify(price);
      if (before !== after) {
        data.pricing[providerKey][slug] = price;
        changed.push({ slug, before, after });
      }
    }
  }

  if (changed.length > 0) {
    atomicWriteJSON(modelsPath, data);
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Provider validation (CRUD)
// ---------------------------------------------------------------------------

const PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const AUTH_ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const BASE_URL_RE = /^https?:\/\/\S+$/i;
const AUTH_STYLES = new Set(['token', 'apikey']);

function validateProviderProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') {
    return { ok: false, errors: ['Provider musi być obiektem.'] };
  }
  if (typeof profile.baseUrl !== 'string' || !BASE_URL_RE.test(profile.baseUrl)) {
    errors.push('baseUrl musi być poprawnym URL http(s).');
  }
  if (typeof profile.authEnv !== 'string' || !AUTH_ENV_RE.test(profile.authEnv)) {
    errors.push(
      'authEnv musi być nazwą zmiennej środowiskowej (wielkie litery, cyfry, podkreślenia, np. MY_API_KEY).',
    );
  }
  if (profile.authStyle !== undefined && !AUTH_STYLES.has(profile.authStyle)) {
    errors.push('authStyle musi być "token" lub "apikey".');
  }
  if (
    profile.models !== undefined &&
    (!Array.isArray(profile.models) || profile.models.some((m) => typeof m !== 'string' || !CUSTOM_MODEL_RE.test(m)))
  ) {
    errors.push(
      'models musi być tablicą identyfikatorów modeli (litery, cyfry, . _ : / -; bez spacji, cudzysłowów i %).',
    );
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a provider patch (add/edit/remove) against the current state.
 *
 * @param {object} patch     - { providers: { name: profile|null, ... } }
 * @param {object} current   - { providers: {...}, squads: {...} } from readSquadConfig
 * @returns {{ ok, errors, warnings }}
 */
export function validateProvidersPatch(patch, current) {
  const errors = [];
  const warnings = [];
  const providers = patch?.providers;
  if (!providers || typeof providers !== 'object') return { ok: true, errors: [], warnings: [] };

  const currentProviders = current?.providers || {};
  const currentSquads = current?.squads || {};

  for (const [name, profile] of Object.entries(providers)) {
    if (name.startsWith('_')) continue;

    if (profile === null) {
      // Removal
      if (name === DEFAULT_PROVIDER) {
        errors.push('Provider "openrouter" jest domyślny i nie może zostać usunięty.');
        continue;
      }
      if (!currentProviders[name]) {
        errors.push(`Provider "${name}" nie istnieje — nie można go usunąć.`);
        continue;
      }
      // Block deletion when any squad references this provider.
      const referencing = [];
      for (const [squad, s] of Object.entries(currentSquads)) {
        if ((s?.provider || DEFAULT_PROVIDER) === name) referencing.push(squad);
      }
      if (referencing.length > 0) {
        errors.push(
          `Nie można usunąć providera "${name}" — używają go składy: ${referencing.join(', ')}.`,
        );
        continue;
      }
      continue;
    }

    // Add / edit
    if (!PROVIDER_NAME_RE.test(name)) {
      errors.push(`Nazwa providera "${name}" jest niepoprawna (dozwolone: [a-z][a-z0-9_-]*).`);
      continue;
    }
    const pv = validateProviderProfile(profile);
    if (!pv.ok) {
      errors.push(...pv.errors.map((e) => `Provider "${name}": ${e}`));
      continue;
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Write: merge providers into config/models.json
// ---------------------------------------------------------------------------

/**
 * Normalize a provider profile to only the whitelisted fields — secret VALUES
 * must never be accepted or stored; only env-var names are kept.
 *
 * `existing` is the profile already on disk. Whitelisted fields the caller did
 * not send are carried over from it rather than dropped: the dashboard's
 * provider form only knows baseUrl/authEnv/authStyle/models, so without this a
 * save from the UI would silently erase `tiers` and every launcher would come
 * up with its model aliases unset. Carrying a value forward is safe because it
 * comes from the file, never from the request.
 */
function normalizeProviderProfile(profile, existing = {}) {
  const out = {};
  if (typeof profile.baseUrl === 'string') out.baseUrl = profile.baseUrl;
  if (typeof profile.authEnv === 'string') out.authEnv = profile.authEnv;
  out.authStyle = AUTH_STYLES.has(profile.authStyle) ? profile.authStyle : 'token';
  if (Array.isArray(profile.models)) out.models = profile.models;

  // Per-provider model tiers (opus/sonnet/haiku/smallFast) consumed by
  // scripts/provider-resolve.mjs. String values only — no nested objects.
  const tiers = profile.tiers !== undefined ? profile.tiers : existing.tiers;
  if (tiers && typeof tiers === 'object' && !Array.isArray(tiers)) {
    const clean = {};
    for (const [k, v] of Object.entries(tiers)) {
      if (typeof v === 'string' && v) clean[k] = v;
    }
    if (Object.keys(clean).length > 0) out.tiers = clean;
  }
  return out;
}

function writeProviders(root, providersPatch) {
  const modelsPath = join(root, "config", "models.json");
  if (!existsSync(modelsPath)) return [];
  const raw = readFileSync(modelsPath, "utf8");
  const data = JSON.parse(raw);
  if (!data.providers) data.providers = {};
  if (!data.pricing) data.pricing = {};

  const changed = [];
  for (const [name, profile] of Object.entries(providersPatch)) {
    if (name.startsWith('_')) continue;

    if (profile === null) {
      // Removal — also removes the provider's pricing scope.
      if (data.providers[name] === undefined && data.pricing[name] === undefined) continue;
      const before = JSON.stringify(data.providers[name] ?? null);
      delete data.providers[name];
      delete data.pricing[name];
      changed.push({ provider: name, before, after: null });
      continue;
    }

    // Add / edit — only whitelisted fields survive.
    const normalized = normalizeProviderProfile(profile, data.providers[name] || {});
    const before = data.providers[name] ? JSON.stringify(data.providers[name]) : null;
    const after = JSON.stringify(normalized);
    if (before !== after) {
      data.providers[name] = normalized;
      changed.push({ provider: name, before, after });
    }
  }

  if (changed.length > 0) {
    atomicWriteJSON(modelsPath, data);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Public: writeSquadConfig
// ---------------------------------------------------------------------------

export function writeSquadConfig(patch, root, { dryRun = false } = {}) {
  const r = root ? root : repoRoot();
  const changed = [];
  const warnings = [];
  const refused = [];
  const ctx = resolutionContext(r);
  const settingsLabel = relativeLabel(r, ctx.settingsFile);

  // 1. Lead models — through the settings overlay (routing.<squad>.lead),
  //    the key the dashboard's Provider & routing screen edits too, so both
  //    surfaces own one writer: fenix-settings.writeSettings.
  if (patch.squads) {
    const routingPatch = {}; // squad -> lead value that actually changes something
    const leadChanges = []; // { squad, before, after } in patch order
    const providerAssignments = {}; // squad -> provider value from this patch

    for (const [squad, squadPatch] of Object.entries(patch.squads)) {
      if (squadPatch.lead !== undefined) {
        if (!OVERLAY_SQUAD_NAME_RE.test(squad)) {
          warnings.push(
            `squads.${squad}.lead: "${squad}" nie jest poprawną nazwą składu dla settings.json — odmówiono zapisu.`,
          );
          refused.push({ squad, field: "lead", value: squadPatch.lead, code: "invalid-squad-name" });
        } else {
          // The launcher side refuses an unpriced model (supervisor-gate's
          // hold options, FOC-165) — the dashboard must not write one either,
          // or the next run bills at zero. Refusal, not warning-only: the
          // lead stays untouched and `refused` names the code.
          const priced = hasPriceRow(squadPatch.lead, r);
          if (priced.error || !priced.priced) {
            const detail =
              priced.error ||
              `config/models.json nie ma wiersza cenowego dla "${squadPatch.lead}"`;
            warnings.push(
              `squads.${squad}.lead: odmówiono zapisu — ${detail}. Dodaj cenę w Cenniku (model-unpriced).`,
            );
            refused.push({ squad, field: "lead", value: squadPatch.lead, code: "model-unpriced" });
          } else {
            // Writing the value that already resolves is a deliberate no-op:
            // it must not pin the table's (or the provider's) answer into the
            // overlay, where it would silently outrank future models.json edits.
            const current = resolveSquadLead(squad, ctx);
            if (current.lead === squadPatch.lead) {
              // no-op
            } else {
              routingPatch[squad] = { lead: squadPatch.lead };
              leadChanges.push({ squad, before: current.lead, after: squadPatch.lead });
            }
          }
        }
      }

      // 1b. Provider (per squad) — there are no per-squad providers anymore:
      //     resolveProvider resolves ONE active provider (env > overlay
      //     provider.active > openrouter) and every launcher runs on it. A
      //     uniform assignment across the patch writes provider.active; a
      //     divergent one is refused rather than silently picking a winner.
      if (squadPatch.provider !== undefined) {
        providerAssignments[squad] = squadPatch.provider || DEFAULT_PROVIDER;
      }

      // 2. Agent config (model + tools)
      if (squadPatch.agents) {
        for (const [role, value] of Object.entries(squadPatch.agents)) {
          const agentFile = join(
            agentsRootFor(r),
            squad,
            "agents",
            `${role}.md`
          );
          if (!existsSync(agentFile)) {
            warnings.push(
              `Rola "${role}" w składzie "${squad}" nie istnieje (${agentFile}) — pominięto.`
            );
            continue;
          }

          // Backward compat: string = model-only patch
          if (typeof value === "string") {
            if (dryRun) {
              const before = readAgentModel(agentFile);
              if (before !== value) {
                changed.push({
                  file: agentFile,
                  field: "model",
                  before,
                  after: value,
                });
              }
            } else {
              const result = writeAgentModel(agentFile, value);
              if (result.changed) {
                changed.push({
                  file: agentFile,
                  field: "model",
                  before: result.before,
                  after: result.after,
                });
              }
            }
            continue;
          }

          // Object patch: { model?, tools? }
          if (typeof value === "object" && value !== null) {
            // Model
            if (value.model !== undefined) {
              if (dryRun) {
                const before = readAgentModel(agentFile);
                if (before !== value.model) {
                  changed.push({
                    file: agentFile,
                    field: "model",
                    before,
                    after: value.model,
                  });
                }
              } else {
                const result = writeAgentModel(agentFile, value.model);
                if (result.changed) {
                  changed.push({
                    file: agentFile,
                    field: "model",
                    before: result.before,
                    after: result.after,
                  });
                }
              }
            }

            // Tools
            if (value.tools !== undefined) {
              if (dryRun) {
                const before = readAgentTools(agentFile);
                const beforeStr = before.join(", ");
                const afterStr = value.tools.join(", ");
                if (beforeStr !== afterStr) {
                  changed.push({
                    file: agentFile,
                    field: "tools",
                    before,
                    after: value.tools,
                  });
                }
              } else {
                const result = writeAgentTools(agentFile, value.tools);
                if (result.changed) {
                  changed.push({
                    file: agentFile,
                    field: "tools",
                    before: result.before,
                    after: result.after,
                  });
                }
              }
            }
          }
        }
      }
    }

    // One atomic settings write for the whole batch of lead changes — a
    // multi-squad save either lands whole in the overlay or not at all.
    if (leadChanges.length > 0) {
      let leadWriteOk = dryRun; // dry-run previews the change without writing
      if (!dryRun) {
        try {
          writeSettings({ routing: routingPatch }, { path: ctx.settingsFile });
          leadWriteOk = true;
        } catch (err) {
          // writeSettings validates the MERGED file before it writes anything,
          // so a refusal here leaves the overlay untouched — name why it said no.
          const detail = String(err?.message ?? err).split("\n")[0];
          warnings.push(
            `squads.*.lead: odmówiono zapisu settings.json — ${detail}`,
          );
          for (const c of leadChanges) {
            refused.push({ squad: c.squad, field: "lead", value: c.after, code: "settings-invalid" });
          }
        }
      }
      if (leadWriteOk) {
        for (const c of leadChanges) {
          changed.push({
            file: settingsLabel,
            field: "lead",
            before: c.before,
            after: c.after,
          });
        }
      }
    }

    if (Object.keys(providerAssignments).length > 0) {
      const values = new Set(Object.values(providerAssignments));
      if (values.size > 1) {
        warnings.push(
          `squads.*.provider: wszystkie składy uruchamiają się teraz na jednym providerze (provider.active w Settings) — zapis różnych wartości (${[...values].join(", ")}) odmówiono.`,
        );
        for (const [squad, value] of Object.entries(providerAssignments)) {
          refused.push({ squad, field: "provider", value, code: "divergent-provider" });
        }
      } else {
        const target = [...values][0];
        const known = ctx.modelsConfig?.providers || {};
        if (!known[target] && target !== DEFAULT_PROVIDER) {
          warnings.push(
            `squads.*.provider: provider "${target}" nie istnieje w config/models.json — odmówiono zapisu.`,
          );
          for (const [squad, value] of Object.entries(providerAssignments)) {
            refused.push({ squad, field: "provider", value, code: "unknown-provider" });
          }
        } else if (ctx.provider !== target) {
          // "openrouter" means provider.active = null (the built-in default) —
          // an explicit "openrouter" entry is not created.
          const activePatch = target === DEFAULT_PROVIDER ? { active: null } : { active: target };
          let wrote = dryRun; // dry-run previews the change without writing
          if (!dryRun) {
            try {
              writeSettings({ provider: activePatch }, { path: ctx.settingsFile });
              wrote = true;
            } catch (err) {
              const detail = String(err?.message ?? err).split("\n")[0];
              warnings.push(
                `squads.*.provider: odmówiono zapisu settings.json — ${detail}`,
              );
              for (const [squad, value] of Object.entries(providerAssignments)) {
                refused.push({ squad, field: "provider", value, code: "settings-invalid" });
              }
            }
          }
          if (wrote) {
            changed.push({
              file: settingsLabel,
              field: "provider",
              before: ctx.provider,
              after: target,
            });
          }
        }
      }
    }
  }

  // 3. Pricing
  if (patch.pricing) {
    if (dryRun) {
      const currentPricing = readPricing(r);
      for (const [providerKey, providerPatch] of Object.entries(patch.pricing)) {
        // Silently skip metadata keys
        if (providerKey.startsWith("_")) continue;
        for (const [slug, price] of Object.entries(providerPatch || {})) {
          // Silently skip metadata keys at the model level too
          if (slug.startsWith("_")) continue;
          const before = currentPricing[providerKey]?.[slug]
            ? JSON.stringify(currentPricing[providerKey][slug])
            : null;
          const after = JSON.stringify(price);
          if (before !== after) {
            changed.push({
              file: join(r, "config", "models.json"),
              before,
              after,
            });
          }
        }
      }
    } else {
      const pricingChanges = writePricing(r, patch.pricing);
      for (const pc of pricingChanges) {
        changed.push({
          file: join(r, "config", "models.json"),
          before: pc.before,
          after: pc.after,
        });
      }
    }
  }

  // 4. Providers (add/edit/remove)
  if (patch.providers) {
    if (dryRun) {
      const currentProviders = readProviders(r);
      for (const [name, profile] of Object.entries(patch.providers)) {
        if (name.startsWith("_")) continue;
        const before = currentProviders[name]
          ? JSON.stringify(currentProviders[name])
          : null;
        // Normalize so dryRun previews the exact shape that would be written.
        const after = profile === null ? null : JSON.stringify(normalizeProviderProfile(profile));
        if (before !== after) {
          changed.push({
            file: join(r, "config", "models.json"),
            provider: name,
            before,
            after,
          });
        }
      }
    } else {
      const providerChanges = writeProviders(r, patch.providers);
      for (const pc of providerChanges) {
        changed.push({
          file: join(r, "config", "models.json"),
          provider: pc.provider,
          before: pc.before,
          after: pc.after,
        });
      }
    }
  }

  return { changed, warnings, refused };
}
