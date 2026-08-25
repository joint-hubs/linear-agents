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
//   writeSquadConfig(patch, root?, {dryRun}) → { changed, warnings }
//
// Provider representation in squad .bat files (PRD docs/ui/provider-config.md):
// the `set "LA_PROVIDER=<name>"` line sits immediately BEFORE the
// `call "%~dp0_lib.bat"` line. `openrouter` is the default provider and is
// represented by the ABSENCE of the line (line removed), so squads that never
// opted into a custom provider stay byte-identical to their original files.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJSON } from "./utils.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function repoRoot(custom) {
  if (custom) return custom;
  return join(__dirname, "..");
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
// Read: lead model from .bat file
// ---------------------------------------------------------------------------

const LEAD_LINE_RE = /^\s*set\s+"ANTHROPIC_MODEL=(.+)"\s*$/i;

/**
 * Extract the lead model from a .bat file.
 * For plan.bat (which has a NATIVE branch), returns the OpenRouter model
 * (the one in the `else` branch, containing a "/").
 */
function readLeadFromBat(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  // Check if this file has a NATIVE/else split
  const hasNativeBranch =
    lines.some((l) => /^\s*if\s+defined\s+NATIVE\s/i.test(l)) &&
    lines.some((l) => /^\s*\)\s*else\s*\(\s*$/i.test(l));

  if (hasNativeBranch) {
    // Find the ANTHROPIC_MODEL line in the else branch (contains "/")
    let inElse = false;
    for (const line of lines) {
      if (/^\s*\)\s*else\s*\(\s*$/i.test(line)) {
        inElse = true;
        continue;
      }
      if (inElse && /^\s*\)\s*$/i.test(line.trim())) {
        inElse = false;
        continue;
      }
      if (inElse) {
        const m = line.match(LEAD_LINE_RE);
        if (m) return m[1].trim();
      }
    }
    return null;
  }

  // Simple .bat: first ANTHROPIC_MODEL line
  for (const line of lines) {
    const m = line.match(LEAD_LINE_RE);
    if (m) return m[1].trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read: provider from .bat file
// ---------------------------------------------------------------------------

const PROVIDER_LINE_RE = /^\s*set\s+"LA_PROVIDER=([^"]*)"\s*$/i;
const LIB_CALL_RE = /^\s*call\s+"%~dp0_lib\.bat"/i;

/**
 * Extract the provider name from a .bat file's `set "LA_PROVIDER=..."` line.
 * Absence of the line (or an empty value) = the default 'openrouter'.
 */
function readProviderFromBat(filePath) {
  if (!existsSync(filePath)) return 'openrouter';
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(PROVIDER_LINE_RE);
    if (m) return m[1].trim() || 'openrouter';
  }
  return 'openrouter';
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
        .filter(Boolean);
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
          .filter(Boolean);
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

const SQUADS = ["plan", "dev", "review", "test", "cadence"];

export function readSquadConfig(root) {
  const r = root ? root : repoRoot();
  const squads = {};

  for (const squad of SQUADS) {
    const leadFiles = [];
    const mainBat = join(r, "bin", `${squad}.bat`);
    const dryBat = join(r, "bin", `${squad}-dry.bat`);

    if (existsSync(mainBat)) leadFiles.push(`bin/${squad}.bat`);
    if (existsSync(dryBat)) leadFiles.push(`bin/${squad}-dry.bat`);

    const lead = readLeadFromBat(mainBat);
    const provider = readProviderFromBat(mainBat);

    const squadDir = join(r, "agents", squad);
    const agents = readAgentConfigs(squadDir);

    squads[squad] = { lead, provider, leadFiles, agents };
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

  if (!Array.isArray(tools) || tools.length === 0 || tools.some((t) => typeof t !== "string" || t.trim() === "")) {
    return { ok: false, unknown: [], warnings: ["Lista narzędzi musi być niepustą tablicą stringów."] };
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
// Write: lead model to .bat file
// ---------------------------------------------------------------------------

function writeLeadToBat(filePath, newModel) {
  const content = readFileSync(filePath, "utf8");
  const eol = detectEOL(content);
  const lines = content.split(/\r?\n/);

  // Check if this file has a NATIVE/else split
  const hasNativeBranch =
    lines.some((l) => /^\s*if\s+defined\s+NATIVE\s/i.test(l)) &&
    lines.some((l) => /^\s*\)\s*else\s*\(\s*$/i.test(l));

  let changed = false;
  let before = null;

  if (hasNativeBranch) {
    // Only modify the else branch (the one with "/")
    let inElse = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*\)\s*else\s*\(\s*$/i.test(lines[i])) {
        inElse = true;
        continue;
      }
      if (inElse && /^\s*\)\s*$/i.test(lines[i].trim())) {
        inElse = false;
        continue;
      }
      if (inElse) {
        const m = lines[i].match(LEAD_LINE_RE);
        if (m) {
          before = m[1].trim();
          if (before !== newModel) {
            lines[i] = lines[i].replace(
              /(set\s+"ANTHROPIC_MODEL=).+(")/i,
              `$1${newModel}$2`
            );
            changed = true;
          }
          break;
        }
      }
    }
  } else {
    // Simple .bat: first ANTHROPIC_MODEL line
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(LEAD_LINE_RE);
      if (m) {
        before = m[1].trim();
        if (before !== newModel) {
          lines[i] = lines[i].replace(
            /(set\s+"ANTHROPIC_MODEL=).+(")/i,
            `$1${newModel}$2`
          );
          changed = true;
        }
        break;
      }
    }
  }

  if (changed) {
    const newContent = lines.join(eol);
    atomicWriteText(filePath, newContent, eol);
  }

  return { changed, before, after: changed ? newModel : before };
}

// ---------------------------------------------------------------------------
// Write: provider to .bat file
// ---------------------------------------------------------------------------

/**
 * Insert/update/remove the `set "LA_PROVIDER=..."` line in a squad .bat file.
 *
 * Representation (see module docstring): 'openrouter' = line removed (absence
 * of the line); any other provider = the line sits immediately before the
 * `call "%~dp0_lib.bat"` line.
 */
function writeProviderToBat(filePath, provider) {
  const content = readFileSync(filePath, "utf8");
  const eol = detectEOL(content);
  const lines = content.split(/\r?\n/);

  let providerLineIdx = -1;
  let libCallIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (PROVIDER_LINE_RE.test(lines[i])) providerLineIdx = i;
    if (LIB_CALL_RE.test(lines[i]) && libCallIdx < 0) libCallIdx = i;
  }

  const before = readProviderFromBat(filePath);

  if (provider === DEFAULT_PROVIDER) {
    // Default = no line. Remove an existing one so untouched squads stay
    // byte-identical to their original files.
    if (providerLineIdx >= 0) {
      lines.splice(providerLineIdx, 1);
      const newContent = lines.join(eol);
      atomicWriteText(filePath, newContent, eol);
      return { changed: true, before, after: DEFAULT_PROVIDER };
    }
    return { changed: false, before: DEFAULT_PROVIDER, after: DEFAULT_PROVIDER };
  }

  const providerLine = `set "LA_PROVIDER=${provider}"`;

  if (providerLineIdx >= 0) {
    const existing = lines[providerLineIdx].match(PROVIDER_LINE_RE);
    if (existing && existing[1].trim() === provider) {
      return { changed: false, before, after: provider };
    }
    lines[providerLineIdx] = providerLine;
    const newContent = lines.join(eol);
    atomicWriteText(filePath, newContent, eol);
    return { changed: true, before, after: provider };
  }

  // No existing line — insert immediately before the _lib.bat call.
  if (libCallIdx < 0) {
    return { changed: false, before: null, after: null, skipped: true };
  }
  lines.splice(libCallIdx, 0, providerLine);
  const newContent = lines.join(eol);
  atomicWriteText(filePath, newContent, eol);
  return { changed: true, before, after: provider };
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

  const toolsLine = newTools.join(", ");
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
      .filter(Boolean);
    const beforeStr = before.join(", ");
    if (beforeStr !== toolsLine) {
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
 */
function normalizeProviderProfile(profile) {
  const out = {};
  if (typeof profile.baseUrl === 'string') out.baseUrl = profile.baseUrl;
  if (typeof profile.authEnv === 'string') out.authEnv = profile.authEnv;
  out.authStyle = AUTH_STYLES.has(profile.authStyle) ? profile.authStyle : 'token';
  if (Array.isArray(profile.models)) out.models = profile.models;
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
    const normalized = normalizeProviderProfile(profile);
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

  // 1. Lead models
  if (patch.squads) {
    for (const [squad, squadPatch] of Object.entries(patch.squads)) {
      if (squadPatch.lead !== undefined) {
        const mainBat = join(r, "bin", `${squad}.bat`);
        const dryBat = join(r, "bin", `${squad}-dry.bat`);

        for (const batPath of [mainBat, dryBat]) {
          if (!existsSync(batPath)) {
            warnings.push(
              `Plik ${batPath} nie istnieje — pominięto aktualizację leada.`
            );
            continue;
          }
          if (dryRun) {
            // Compute what WOULD change without writing
            const before = readLeadFromBat(batPath);
            if (before !== squadPatch.lead) {
              changed.push({
                file: batPath,
                before,
                after: squadPatch.lead,
              });
            }
          } else {
            const result = writeLeadToBat(batPath, squadPatch.lead);
            if (result.changed) {
              changed.push({
                file: batPath,
                before: result.before,
                after: result.after,
              });
            }
          }
        }
      }

      // 1b. Provider (per squad) — LA_PROVIDER line in both bats
      if (squadPatch.provider !== undefined) {
        const mainBat = join(r, "bin", `${squad}.bat`);
        const dryBat = join(r, "bin", `${squad}-dry.bat`);

        for (const batPath of [mainBat, dryBat]) {
          if (!existsSync(batPath)) {
            warnings.push(
              `Plik ${batPath} nie istnieje — pominięto aktualizację providera.`
            );
            continue;
          }
          if (dryRun) {
            const before = readProviderFromBat(batPath);
            if (before !== squadPatch.provider) {
              changed.push({
                file: batPath,
                field: "provider",
                before,
                after: squadPatch.provider,
              });
            }
          } else {
            const result = writeProviderToBat(batPath, squadPatch.provider);
            if (result.skipped) {
              warnings.push(
                `Plik ${batPath} nie ma linii 'call "%~dp0_lib.bat"' — pominięto providera.`
              );
            } else if (result.changed) {
              changed.push({
                file: batPath,
                field: "provider",
                before: result.before,
                after: result.after,
              });
            }
          }
        }
      }

      // 2. Agent config (model + tools)
      if (squadPatch.agents) {
        for (const [role, value] of Object.entries(squadPatch.agents)) {
          const agentFile = join(
            r,
            "agents",
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

  return { changed, warnings };
}
