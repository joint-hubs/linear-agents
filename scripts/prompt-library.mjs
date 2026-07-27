// scripts/prompt-library.mjs
// Backend biblioteki promptów — drzewo intencji, dokumenty ról i leadów.
//
// ESM, zero runtime deps (Node 22 built-ins only).
//
// Exports:
//   buildPromptTree(root)  -> { intents, squads }
//   readRoleDoc(squad, role, root) -> { squad, role, model, tools:[], body }
//   readLeadDoc(squad, root) -> { squad, body }

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KICKOFF_TEMPLATES } from "./launch.mjs";
import { readSquadConfig } from "./squad-config.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = join(__dir, "..");

const SQUADS = ["plan", "dev", "review", "test", "cadence"];

const INTENTS = [
  { id: "plan", label: "Zaplanować nowy feature", squad: "plan" },
  { id: "dev", label: "Zakodować gotowe zadanie", squad: "dev" },
  { id: "review", label: "Zrecenzować kod", squad: "review" },
  { id: "test", label: "Przetestować i wdrożyć", squad: "test" },
  { id: "cadence", label: "Podsumować tydzień", squad: "cadence" },
  { id: "single", label: "Uruchomić pojedynczą rolę (debug)", squad: null },
];

// Entry conditions per squad (HOW-TO-RUN-AGENTS.md §3 + §4).
const ENTRY_CONDITIONS = {
  plan: "Approved feature na tablicy albo notatka w planning/inbox/",
  dev: "Zadanie w Todo z etykietą dor-ok",
  review: "Zadanie w In Review (zwykle z ai:coded)",
  test: "Zadanie z etykietą stage:testing (po approve z REVIEW)",
  cadence: "Uruchamiane cotygodniowo — nie wymaga zadania",
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ROLE_RE = /^[a-z0-9-]+$/;

function validateSquad(squad) {
  if (!SQUADS.includes(squad)) {
    return { error: `invalid squad: must be one of ${SQUADS.join(", ")}` };
  }
  return { ok: true };
}

function validateRole(role) {
  if (!role || typeof role !== "string" || !ROLE_RE.test(role)) {
    return { error: "invalid role: must match /^[a-z0-9-]+$/" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Returns { frontmatter: { key: value }, body: string }.
 * Frontmatter is between the first two `---` lines.
 */
function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: content };

  const fm = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx > 0) {
      const key = lines[i].slice(0, colonIdx).trim();
      const value = lines[i].slice(colonIdx + 1).trim();
      fm[key] = value;
    }
  }

  // Body starts after the closing ---
  const bodyStart = i + 1;
  const body = lines.slice(bodyStart).join("\n");

  return { frontmatter: fm, body };
}

// ---------------------------------------------------------------------------
// Role discovery
// ---------------------------------------------------------------------------

/**
 * Read all agent .md files from agents/<squad>/agents/ (skipping plugins/).
 * Returns an array of { role, model, tools }.
 */
function readSquadRoles(squadDir) {
  const agentsDir = join(squadDir, "agents");
  if (!existsSync(agentsDir)) return [];

  let entries;
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const roles = [];
  for (const entry of entries) {
    // Only .md files, skip directories (plugins/) and non-.md files
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const role = entry.name.replace(/\.md$/, "");
    // Validate role name (defense in depth — path traversal guard)
    if (!ROLE_RE.test(role)) continue;

    const filePath = join(agentsDir, entry.name);
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter } = parseFrontmatter(content);
    const model = frontmatter.model || null;
    const tools = frontmatter.tools
      ? frontmatter.tools.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    roles.push({ role, model, tools });
  }

  return roles;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full prompt tree for the UI.
 *
 * @param {string} [root]  Repo root path (defaults to ../ from this script).
 * @returns {{ intents: Array, squads: object }}
 */
export function buildPromptTree(root) {
  const r = root || defaultRoot;
  const config = readSquadConfig(r);

  const squads = {};

  for (const squad of SQUADS) {
    const squadDir = join(r, "agents", squad);
    const roles = readSquadRoles(squadDir);

    squads[squad] = {
      squad,
      kickoff: KICKOFF_TEMPLATES[squad] || [],
      entryCondition: ENTRY_CONDITIONS[squad] || null,
      lead: {
        model: (config.squads[squad] && config.squads[squad].lead) || null,
      },
      roles,
      agentCmd: `bin\\agent.bat ${squad} <rola>`,
    };
  }

  return { intents: INTENTS, squads };
}

/**
 * Read a single role's documentation (frontmatter + body).
 *
 * @param {string} squad  One of plan/dev/review/test/cadence.
 * @param {string} role   Role name matching /^[a-z0-9-]+$/.
 * @param {string} [root] Repo root path.
 * @returns {{ squad, role, model, tools: string[], body: string } | { error: string }}
 */
export function readRoleDoc(squad, role, root) {
  const r = root || defaultRoot;

  const squadCheck = validateSquad(squad);
  if (squadCheck.error) return { error: squadCheck.error };

  const roleCheck = validateRole(role);
  if (roleCheck.error) return { error: roleCheck.error };

  const filePath = join(r, "agents", squad, "agents", `${role}.md`);
  if (!existsSync(filePath)) {
    return { error: "not found" };
  }

  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return { error: "not found" };
  }

  const { frontmatter, body } = parseFrontmatter(content);
  const model = frontmatter.model || null;
  const tools = frontmatter.tools
    ? frontmatter.tools.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return { squad, role, model, tools, body };
}

/**
 * Read a squad lead's CLAUDE.md (full body, no frontmatter stripping).
 *
 * @param {string} squad  One of plan/dev/review/test/cadence.
 * @param {string} [root] Repo root path.
 * @returns {{ squad, body: string } | { error: string }}
 */
export function readLeadDoc(squad, root) {
  const r = root || defaultRoot;

  const squadCheck = validateSquad(squad);
  if (squadCheck.error) return { error: squadCheck.error };

  const filePath = join(r, "agents", squad, "CLAUDE.md");
  if (!existsSync(filePath)) {
    return { error: "not found" };
  }

  let body;
  try {
    body = readFileSync(filePath, "utf8");
  } catch {
    return { error: "not found" };
  }

  return { squad, body };
}
