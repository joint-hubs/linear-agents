// squad-config — read/write LLM model + tool configuration per squad.
//
// ESM, zero runtime deps (Node 18+).
//
// Exports:
//   readSquadConfig(root?)   → { squads, pricing }
//   readToolCatalog(root?)   → { tools, riskLevels }
//   validateSlug(slug)       → { ok, warning }
//   validateTools(tools, cat) → { ok, unknown, warnings }
//   writeSquadConfig(patch, root?, {dryRun}) → { changed, warnings }

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

/** Atomic JSON write: temp file → rename. */
function atomicWriteJSON(filePath, data) {
  const tmp =
    filePath + "." + randomBytes(4).readUInt32BE(0).toString(36);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, filePath);
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
  // Strip metadata keys (_doc, _note, etc.) — the UI must only see real pricing entries
  const filtered = {};
  for (const [k, v] of Object.entries(pricing)) {
    if (!k.startsWith("_")) filtered[k] = v;
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

    const squadDir = join(r, "agents", squad);
    const agents = readAgentConfigs(squadDir);

    squads[squad] = { lead, leadFiles, agents };
  }

  const pricing = readPricing(r);

  return { squads, pricing };
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
// Public: validateSlug
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9_.-]+\/[A-Za-z0-9._:-]+$/;

export function validateSlug(slug) {
  if (!slug || typeof slug !== "string" || slug.trim() === "") {
    return { ok: false, warning: "Slug nie może być pusty." };
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
  for (const [slug, price] of Object.entries(pricingPatch)) {
    // Silently skip metadata keys — they are not pricing entries
    if (slug.startsWith("_")) continue;
    const before = data.pricing[slug]
      ? JSON.stringify(data.pricing[slug])
      : null;
    const after = JSON.stringify(price);
    if (before !== after) {
      data.pricing[slug] = price;
      changed.push({ slug, before, after });
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
      for (const [slug, price] of Object.entries(patch.pricing)) {
        // Silently skip metadata keys
        if (slug.startsWith("_")) continue;
        const before = currentPricing[slug]
          ? JSON.stringify(currentPricing[slug])
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

  return { changed, warnings };
}
