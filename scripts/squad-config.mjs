// squad-config — read/write LLM model configuration per squad.
//
// ESM, zero runtime deps (Node 18+).
//
// Exports:
//   readSquadConfig(root?)  → { squads, pricing }
//   validateSlug(slug)      → { ok, warning }
//   writeSquadConfig(patch, root?) → { changed, warnings }

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

function readAgentModels(squadDir) {
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
      result[role] = null;
      continue;
    }
    let inFrontmatter = false;
    let model = null;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") break;
      const m = lines[i].match(FRONTMATTER_MODEL_RE);
      if (m) {
        model = m[1].trim();
        break;
      }
    }
    result[role] = model;
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
    const agents = readAgentModels(squadDir);

    squads[squad] = { lead, leadFiles, agents };
  }

  const pricing = readPricing(r);

  return { squads, pricing };
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

      // 2. Agent models
      if (squadPatch.agents) {
        for (const [role, model] of Object.entries(squadPatch.agents)) {
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
          if (dryRun) {
            // Compute what WOULD change without writing
            const before = readAgentModel(agentFile);
            if (before !== model) {
              changed.push({
                file: agentFile,
                before,
                after: model,
              });
            }
          } else {
            const result = writeAgentModel(agentFile, model);
            if (result.changed) {
              changed.push({
                file: agentFile,
                before: result.before,
                after: result.after,
              });
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
