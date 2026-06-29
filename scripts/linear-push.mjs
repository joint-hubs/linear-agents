#!/usr/bin/env node
/**
 * scripts/linear-push.mjs — Push a PLAN brief to Linear as epic + sub-issues.
 *
 * Replaces MCP-based linear push for headless MVP. MCP linear requires
 * interactive OAuth (browser popup) which is unavailable in headless/CI
 * contexts. This script uses the raw Linear GraphQL API with a personal
 * API key, matching the pattern established by bootstrap-linear.mjs.
 *
 * ADR context: per Mateusz approval "Rób wszystko przez API" — all Linear
 * operations go through the GraphQL API directly, not through MCP tools.
 *
 * Usage:
 *   node scripts/linear-push.mjs --brief <path>
 *   node scripts/linear-push.mjs --brief <path> --dry-run
 *
 * Dependencies: Node 18+ (global fetch), utils.mjs (idempotentCreate).
 * No npm install required.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { idempotentCreate } from "./utils.mjs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// ---------------------------------------------------------------------------
// Helpers (copied verbatim from bootstrap-linear.mjs)
// ---------------------------------------------------------------------------

/** Manual .env parser — zero deps, mirrors cost-report.mjs convention. */
function loadEnv() {
  try {
    const text = readFileSync(join(root, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    // .env missing — user may have set env vars directly
  }
}

const ENDPOINT = "https://api.linear.app/graphql";

/**
 * Normalize a slice value to "slice:<name>" format.
 * @param {string|null|undefined} value
 * @returns {string|null} "slice:<name>" or null if falsy.
 */
export function normalizeSlice(value) {
  if (!value) return null;
  if (value.startsWith("slice:")) return value;
  return "slice:" + value;
}

/**
 * Check if an error message indicates a validation error (nothing was created).
 * @param {string} msg
 * @returns {boolean}
 */
export function isValidationError(msg) {
  const s = String(msg);
  return s.includes("Validation Error") ||
         s.includes("INVALID_INPUT") ||
         s.includes("must be a UUID") ||
         s.includes("validationErrors");
}

/**
 * Execute a GraphQL query/mutation against the Linear API.
 * @param {string} query  The GraphQL operation string.
 * @param {object} vars   Variables object.
 * @param {string} key    Linear API key.
 * @returns {object}      The `data` portion of the response.
 * @throws {Error}        On network error, auth failure, or GraphQL errors.
 */
async function graphql(query, vars, key) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: key,
    },
    body: JSON.stringify({ query, variables: vars }),
  });

  const body = await res.json();

  if (!res.ok) {
    const msg = body?.error || body?.errors?.[0]?.message || `${res.status} ${res.statusText}`;
    throw new Error(`Linear API ${res.status}: ${msg}`);
  }

  if (body.errors?.length) {
    throw new Error("GraphQL error: " + JSON.stringify(body.errors[0]));
  }

  return body.data;
}

// ---------------------------------------------------------------------------
// Team resolution (copied from bootstrap-linear.mjs)
// ---------------------------------------------------------------------------

async function resolveTeam(key, teamKey) {
  const data = await graphql(
    `query {
      teams {
        nodes {
          id
          name
          key
        }
      }
    }`,
    {},
    key,
  );

  const teams = data.teams?.nodes || [];
  const team = teams.find((t) => t.key.toUpperCase() === teamKey.toUpperCase());
  if (!team) {
    const available = teams.map((t) => `${t.key} (${t.name})`).join(", ");
    throw new Error(
      `Team "${teamKey}" not found. Available teams: ${available || "(none — check API key permissions)"}`,
    );
  }
  return team;
}

/**
 * Resolve a project by name within a team.
 * @param {string} teamId       Team id.
 * @param {string} projectName  Project name to find (case-insensitive).
 * @param {string} key          Linear API key.
 * @returns {{ id: string, name: string }}
 */
async function resolveProject(teamId, projectName, key) {
  const data = await graphql(
    `query ($teamId: String!) {
      team(id: $teamId) {
        projects(first: 50) {
          nodes {
            id
            name
          }
        }
      }
    }`,
    { teamId },
    key,
  );

  const projects = data.team?.projects?.nodes || [];
  const project = projects.find((p) => p.name.trim().toLowerCase() === projectName.trim().toLowerCase());
  if (!project) {
    const available = projects.map((p) => `"${p.name}"`).join(", ");
    throw new Error(
      `Project "${projectName}" not found in team. Available projects: ${available || "(none)"}`,
    );
  }
  return project;
}

// ---------------------------------------------------------------------------
// Existing resources queries (copied from bootstrap-linear.mjs)
// ---------------------------------------------------------------------------

async function fetchExistingStates(teamId, key) {
  const data = await graphql(
    `query ($teamId: String!) {
      team(id: $teamId) {
        states(first: 100) {
          nodes {
            id
            name
            type
          }
        }
      }
    }`,
    { teamId },
    key,
  );
  return data.team?.states?.nodes || [];
}

async function fetchExistingLabels(teamId, key) {
  const data = await graphql(
    `query ($teamId: String!) {
      team(id: $teamId) {
        labels(first: 200) {
          nodes {
            id
            name
            isGroup
            parent {
              id
              name
            }
          }
        }
      }
    }`,
    { teamId },
    key,
  );
  return data.team?.labels?.nodes || [];
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const ISSUE_CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        url
        title
      }
    }
  }
`;

const LABEL_CREATE_MUTATION = `
  mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) {
      success
      issueLabel {
        id
        name
      }
    }
  }
`;

const VERIFY_ISSUE_QUERY = `
  query($id: String!) {
    issue(id: $id) {
      id
      title
    }
  }
`;

const RECONCILE_QUERY = `
  query($teamId: String!) {
    team(id: $teamId) {
      issues(first: 50, orderBy: updatedAt) {
        nodes {
          id
          identifier
          title
          createdAt
        }
      }
    }
  }
`;

/**
 * Try to find an issue that was created successfully despite a transient error.
 * Uses title-match within the last 5 minutes. Returns the issue id if exactly
 * one match is found, null otherwise.
 *
 * Limitation: title-collision across briefs could mis-reconcile; acceptable
 * for MVP since titles are long/unique.
 */
async function reconcileAfterTransient(input, key) {
  try {
    const data = await graphql(RECONCILE_QUERY, { teamId: input.teamId }, key);
    const issues = data.team?.issues?.nodes || [];
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const matches = issues.filter((n) => {
      const created = new Date(n.createdAt).getTime();
      return n.title === input.title && created >= fiveMinAgo;
    });

    if (matches.length === 1) {
      const m = matches[0];
      console.log(`  ⚠ transient create error — reconciled existing ${m.identifier} (${m.id}) for "${m.title}"`);
      return m.id;
    }

    if (matches.length === 0) {
      console.log("  ⚠ reconcile: no matching issue found in last 5 min");
    } else {
      console.log(`  ⚠ reconcile: ${matches.length} matching issues found — cannot safely reconcile`);
    }
  } catch (reconcileErr) {
    console.log(`  ⚠ reconcile query failed: ${reconcileErr.message}`);
  }

  return null;
}

/**
 * Create a Linear issue via GraphQL, with diagnostic input dump on failure,
 * automatic retry-without-estimate for teams that reject it, and reconcile
 * on transient errors to prevent duplicate creation.
 *
 * @param {object} input      IssueCreateInput object.
 * @param {string} key        Linear API key.
 * @param {string} [kind]     "parent" or "subtask" — used in success logging.
 * @param {string} [externalId] External ID for logging.
 * @returns {Promise<string>} The created (or reconciled) issue id.
 */
async function createIssue(input, key, kind, externalId) {
  try {
    const d = await graphql(ISSUE_CREATE_MUTATION, { input }, key);
    const issue = d.issueCreate.issue;
    console.log(`  ✅ [${kind || "issue"}] ${externalId || ""} ${issue.identifier} ${issue.url}`.trim());
    return issue.id;
  } catch (err) {
    // Dump the exact input for debugging (truncate description)
    const dump = { ...input };
    if (typeof dump.description === "string" && dump.description.length > 200) {
      dump.description = dump.description.slice(0, 200) + `...<${dump.description.length} more>`;
    }
    console.error("[input]", JSON.stringify(dump, null, 2));

    const errStr = String(err.message);

    // Validation error — nothing was created, hard fail
    if (isValidationError(errStr)) {
      throw err;
    }

    // Estimate retry: if error mentions estimate, retry without it
    if (input.estimate != null && errStr.toLowerCase().includes("estimate")) {
      console.log("  ⚠ estimate rejected by team — creating without estimate");
      const { estimate: _omit, ...rest } = input;
      try {
        const d = await graphql(ISSUE_CREATE_MUTATION, { input: rest }, key);
        const issue = d.issueCreate.issue;
        console.log(`  ✅ [${kind || "issue"}] ${externalId || ""} ${issue.identifier} ${issue.url}`.trim());
        return issue.id;
      } catch (retryErr) {
        // Retry also failed — try reconcile for non-validation errors
        if (!isValidationError(String(retryErr.message))) {
          const reconciled = await reconcileAfterTransient(input, key);
          if (reconciled) {
            console.log(`  ✅ [${kind || "issue"}] ${externalId || ""} ${reconciled} (reconciled)`.trim());
            return reconciled;
          }
        }
        throw retryErr;
      }
    }

    // Transient (non-validation) error — try reconcile
    const reconciled = await reconcileAfterTransient(input, key);
    if (reconciled) {
      console.log(`  ✅ [${kind || "issue"}] ${externalId || ""} ${reconciled} (reconciled)`.trim());
      return reconciled;
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Type alias map
// ---------------------------------------------------------------------------

const TYPE_ALIAS = {
  feat: "feature",
  feature: "feature",
  fix: "bug",
  bug: "bug",
  spike: "spike",
  tech: "tech",
  refactor: "tech",
};

// ---------------------------------------------------------------------------
// Estimate map
// ---------------------------------------------------------------------------

const ESTIMATE_MAP = { XS: 1, S: 2, M: 3, L: 5, XL: 8 };

// ---------------------------------------------------------------------------
// Description builder
// ---------------------------------------------------------------------------

function buildParentDescription(parent) {
  const desc = parent.description || "";
  return `${desc}\n\n---\n_externalId: ${parent.externalId}_`;
}

function buildSubtaskDescription(st) {
  const parts = [];

  // Acceptance Criteria
  if (st.ac && st.ac.length > 0) {
    parts.push("## Acceptance Criteria");
    for (const ac of st.ac) {
      parts.push(`**Given** ${ac.given}`);
      parts.push(`**When** ${ac.when}`);
      parts.push(`**Then** ${ac.then}`);
      parts.push(""); // empty line between scenarios
    }
  }

  // Definition of Done
  if (st.dod && st.dod.length > 0) {
    parts.push("## Definition of Done");
    for (const item of st.dod) {
      parts.push(`- ${item}`);
    }
  }

  // Blocked-by block
  if (st.blockedBy && st.blockedBy.length > 0) {
    parts.push("");
    parts.push(`> Blocked by: ${st.blockedBy.join(", ")}`);
  }

  // External ID footer
  parts.push("");
  parts.push("---");
  parts.push(`_External-ID: ${st.externalId}_`);

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Label resolution — module-level structures populated by main()
// ---------------------------------------------------------------------------

/** @type {Map<string, {id:string,name:string}>} groupById — labelId -> groupName */
let groupById = new Map();
/** @type {Map<string, {id:string,name:string}>} childByNameInGroup — "group::child" -> label */
let childByNameInGroup = new Map();
/** @type {Map<string, {id:string,name:string}>} byExact — name -> label (all labels) */
let byExact = new Map();

/**
 * Resolve a canonical label name (e.g. "ai:planned", "type:feature", "slice:config")
 * to a label node or null.
 * 1. Exact match by name (covers flat labels like slice:* and any prefixed provisioning).
 * 2. If canonical contains ":", split into [group, child] and look up in childByNameInGroup.
 * 3. Otherwise return null.
 */
function resolveLabelName(canonical) {
  if (byExact.has(canonical)) return byExact.get(canonical);
  const colonIdx = canonical.indexOf(":");
  if (colonIdx > 0) {
    const group = canonical.slice(0, colonIdx);
    const child = canonical.slice(colonIdx + 1);
    const key = `${group}::${child}`;
    if (childByNameInGroup.has(key)) return childByNameInGroup.get(key);
  }
  return null;
}

/**
 * Resolve label names to IDs, auto-creating slice:* labels.
 * Uses resolveLabelName (G:C group/child resolution) for lookups.
 * @param {string[]} labelNames  Array of canonical label names
 * @param {string} teamId
 * @param {string} key          Linear API key
 * @param {boolean} dryRun
 * @returns {Promise<string[]>} Array of resolved label IDs
 */
async function resolveLabels(labelNames, teamId, key, dryRun) {
  const ids = [];

  for (const name of labelNames) {
    if (!name) continue;

    // Try G:C resolution
    const resolved = resolveLabelName(name);
    if (resolved) {
      ids.push(resolved.id);
      continue;
    }

    // Auto-create slice:* labels (flat, no parent group)
    if (name.startsWith("slice:")) {
      if (dryRun) {
        console.log(`  [dry-run] would create label "${name}"`);
        continue;
      }
      try {
        const result = await graphql(
          LABEL_CREATE_MUTATION,
          { input: { teamId, name, isGroup: false } },
          key,
        );
        if (result?.issueLabelCreate?.success) {
          const newId = result.issueLabelCreate.issueLabel.id;
          // Cache it in byExact for subsequent lookups
          byExact.set(name, { id: newId, name });
          ids.push(newId);
          console.log(`  ✅ created label "${name}" (id: ${newId})`);
        } else {
          console.warn(`  ⚠️  failed to create label "${name}" — skipping`);
        }
      } catch (err) {
        console.warn(`  ⚠️  failed to create label "${name}": ${err.message} — skipping`);
      }
      continue;
    }

    // Type labels that don't exist — warn and skip
    if (name.startsWith("type:")) {
      console.warn(`  ⚠️  type label "${name}" not provisioned — skipping type label`);
      continue;
    }

    // Other missing labels — warn and skip
    console.warn(`  ⚠️  label "${name}" not found — skipping`);
  }

  return ids;
}

// ---------------------------------------------------------------------------
// CLI argument parser (minimal, no deps)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--brief" && i + 1 < argv.length) {
      args.brief = argv[++i];
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--team-key" && i + 1 < argv.length) {
      args.teamKey = argv[++i];
    } else if (a === "--project-id" && i + 1 < argv.length) {
      args.projectId = argv[++i];
    } else if (a === "--project-name" && i + 1 < argv.length) {
      args.projectName = argv[++i];
    }
  }
  return args;
}

function printUsage() {
  console.log("Usage:");
  console.log("  node scripts/linear-push.mjs --brief <path>              # LIVE push");
  console.log("  node scripts/linear-push.mjs --brief <path> --dry-run    # READ-ONLY preview");
  console.log("");
  console.log("Options:");
  console.log("  --brief <path>       Path to PLAN brief JSON (required)");
  console.log("  --dry-run            Preview only — no mutations, no writes");
  console.log("  --team-key <KEY>     Override LINEAR_TEAM_KEY (default: env)");
  console.log("  --project-id <UUID>   Full project UUID (36 chars, 8-4-4-4-12). Overrides --project-name.");
  console.log("  --project-name <name> Project name to resolve live (default: env LINEAR_PROJECT_NAME or \"Linear Agents\")");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();

  const args = parseArgs(process.argv);

  if (!args.brief) {
    printUsage();
    process.exit(2);
  }

  const dryRun = args.dryRun || false;
  const KEY = process.env.LINEAR_API_KEY;
  const teamKey = (args.teamKey || process.env.LINEAR_TEAM_KEY || "").trim();
  const projectName = args.projectName || process.env.LINEAR_PROJECT_NAME || "Linear Agents";

  // Validate --project-id if provided (must be full 36-char UUID)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawProjectId = args.projectId || process.env.LINEAR_PROJECT_ID || "";
  if (rawProjectId) {
    if (!UUID_RE.test(rawProjectId)) {
      console.error(
        `--project-id must be a full UUID (36 chars, 8-4-4-4-12), got ${rawProjectId.length} chars; use --project-name instead`,
      );
      process.exit(2);
    }
  }
  // projectId will be resolved live below (after team is known)

  if (!KEY) {
    console.error("LINEAR_API_KEY not set");
    process.exit(2);
  }

  // Load brief
  let brief;
  try {
    const raw = readFileSync(args.brief, "utf8");
    brief = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read/parse brief "${args.brief}": ${err.message}`);
    process.exit(1);
  }

  const { parent, subtasks } = brief;

  if (!parent || !parent.externalId) {
    console.error('Brief missing "parent.externalId"');
    process.exit(1);
  }

  // Resolve team
  let team;
  try {
    team = await resolveTeam(KEY, teamKey);
  } catch (err) {
    console.error(`❌ Team resolution failed: ${err.message}`);
    process.exit(1);
  }
  console.log(`🔍 Team: ${team.name} (${team.key}, id: ${team.id})`);

  // Resolve project (by full UUID or live by name)
  let projectId;
  let resolvedProjectName;
  if (rawProjectId) {
    projectId = rawProjectId;
    resolvedProjectName = "(by --project-id)";
  } else {
    try {
      const project = await resolveProject(team.id, projectName, KEY);
      projectId = project.id;
      resolvedProjectName = project.name;
    } catch (err) {
      console.error(`❌ Project resolution failed: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`🔍 Project: "${resolvedProjectName}" (id: ${projectId})`);

  // Resolve default state
  const states = await fetchExistingStates(team.id, KEY);
  const candidateStates = states.filter((s) => s.type === "unstarted" || s.type === "backlog");
  const defaultState = candidateStates.find((s) => s.name === "Backlog")
    || candidateStates.find((s) => s.name === "Todo")
    || candidateStates[0]
    || states[0];
  if (!defaultState) {
    console.error("No workflow states found for team");
    process.exit(1);
  }
  console.log(`🔍 Default state: "${defaultState.name}" (type: ${defaultState.type}, id: ${defaultState.id})`);

  // Pre-fetch labels and build G:C resolver structures (module-level)
  const allLabels = await fetchExistingLabels(team.id, KEY);

  groupById = new Map();
  childByNameInGroup = new Map();
  byExact = new Map();

  for (const lbl of allLabels) {
    byExact.set(lbl.name, lbl);
    if (lbl.isGroup) {
      groupById.set(lbl.id, lbl.name);
    }
  }
  for (const lbl of allLabels) {
    if (!lbl.isGroup && lbl.parent && lbl.parent.id) {
      const parentName = groupById.get(lbl.parent.id) || lbl.parent.name;
      if (parentName) {
        childByNameInGroup.set(`${parentName}::${lbl.name}`, lbl);
      }
    }
  }

  // Compact label inventory
  const groupNames = [...groupById.values()].sort();
  const sampleChildren = [];
  for (const [key, lbl] of childByNameInGroup) {
    const [g, c] = key.split("::");
    if (["ai", "type", "needs", "risk"].includes(g)) {
      sampleChildren.push(`${g}::${c}=${lbl.id}`);
    }
  }
  console.log(`🔍 Labels: ${allLabels.length} found — groups: [${groupNames.join(", ")}] — children-by-group: ${sampleChildren.join(", ")}`);

  // Dry-run: print plan and exit
  if (dryRun) {
    console.log("");
    console.log("=== DRY RUN — No mutations ===");
    console.log("");

    // Parent
    const parentLabels = parent.labels || [];
    console.log(`[parent] ${parent.title}`);
    console.log(`  externalId: ${parent.externalId}`);
    console.log(`  type: ${parent.type}`);
    console.log(`  projectId: ${projectId}`);
    console.log(`  stateId: ${defaultState.id} ("${defaultState.name}")`);
    console.log(`  labels: ${parentLabels.join(", ") || "(none)"}`);
    for (const lbl of parentLabels) {
      const resolved = resolveLabelName(lbl);
      if (resolved) {
        console.log(`    -> ${lbl}: resolved ${resolved.id}`);
      } else {
        console.log(`    -> ${lbl}: (not found — will skip)`);
      }
    }
    console.log("");

    // Subtasks
    for (const st of subtasks) {
      const typeNormalized = TYPE_ALIAS[st.type] || st.type;
      const typeLabel = `type:${typeNormalized}`;
      const sliceLabel = normalizeSlice(st.slice);
      const estimate = ESTIMATE_MAP[st.estimate];

      // Always include type label in requested set (will warn+skip if not provisioned)
      const labelNames = ["ai:planned", typeLabel];
      if (sliceLabel) {
        labelNames.push(sliceLabel);
      }

      console.log(`[subtask] ${st.title}`);
      console.log(`  externalId: ${st.externalId}`);
      console.log(`  type: ${st.type} -> normalized: ${typeNormalized}`);
      console.log(`  estimate: ${st.estimate} -> ${estimate ?? "(none)"}`);
      console.log(`  slice: ${sliceLabel || "(none)"}`);
      console.log(`  parentId: (will be parent issue id)`);
      console.log(`  stateId: ${defaultState.id} ("${defaultState.name}")`);
      console.log(`  blockedBy: ${(st.blockedBy || []).join(", ") || "(none)"}`);
      console.log(`  labels: ${labelNames.join(", ") || "(none)"}`);
      for (const lbl of labelNames) {
        const resolved = resolveLabelName(lbl);
        if (resolved) {
          console.log(`    -> ${lbl}: resolved ${resolved.id}`);
        } else if (lbl.startsWith("slice:")) {
          console.log(`    -> ${lbl}: (will auto-create)`);
        } else if (lbl.startsWith("type:")) {
          console.log(`    -> ${lbl}: (not found — will skip)`);
        } else {
          console.log(`    -> ${lbl}: (not found — will skip)`);
        }
      }
      console.log(`  ac: ${(st.ac || []).length} scenarios`);
      console.log(`  dod: ${(st.dod || []).length} items`);
      console.log("");
    }

    console.log("=== Dry-run complete. Remove --dry-run to execute. ===");
    return;
  }

  // -----------------------------------------------------------------------
  // LIVE EXECUTION
  // -----------------------------------------------------------------------

  let hasError = false;

  // 1. Create parent epic
  const parentLabelIds = await resolveLabels(
    parent.labels || [],
    team.id,
    KEY,
    dryRun,
  );

  console.log(`\n[parent] Creating "${parent.title}"...`);
  let parentIssueId;
  try {
    parentIssueId = await idempotentCreate({
      key: `linear:${parent.externalId}`,
      existsFn: async (cachedId) => {
        try {
          const d = await graphql(VERIFY_ISSUE_QUERY, { id: cachedId }, KEY);
          return Boolean(d && d.issue && d.issue.id);
        } catch {
          return false;
        }
      },
      createFn: async () => createIssue({
        teamId: team.id,
        title: parent.title,
        description: buildParentDescription(parent),
        projectId,
        stateId: defaultState.id,
        labelIds: parentLabelIds,
      }, KEY, "parent", parent.externalId),
      onSkip: (cachedId) => console.log(`  ⏭️ skip (idempotent) ${parent.externalId} -> ${cachedId}`),
    });
  } catch (err) {
    console.error(`  ❌ [parent] ${parent.externalId}: ${err.message}`);
    hasError = true;
    // Cannot continue without parent
    process.exit(1);
  }

  // 2. Create subtasks (sequential)
  for (const st of subtasks) {
    const typeNormalized = TYPE_ALIAS[st.type] || st.type;
    const typeLabel = `type:${typeNormalized}`;
    const sliceLabel = normalizeSlice(st.slice);
    const estimate = ESTIMATE_MAP[st.estimate];

    // Build label names — always include type label (will warn+skip if not provisioned)
    const labelNames = ["ai:planned", typeLabel];
    if (sliceLabel) {
      labelNames.push(sliceLabel);
    }

    const resolvedLabelIds = await resolveLabels(
      labelNames,
      team.id,
      KEY,
      dryRun,
    );

    const createInput = {
      teamId: team.id,
      title: st.title,
      description: buildSubtaskDescription(st),
      projectId,
      parentId: parentIssueId,
      stateId: defaultState.id,
      labelIds: resolvedLabelIds,
    };
    if (estimate != null) {
      createInput.estimate = estimate;
    }

    console.log(`\n[subtask] "${st.title}"...`);
    try {
      const subtaskId = await idempotentCreate({
        key: `linear:${st.externalId}`,
        existsFn: async (cachedId) => {
          try {
            const d = await graphql(VERIFY_ISSUE_QUERY, { id: cachedId }, KEY);
            return Boolean(d && d.issue && d.issue.id);
          } catch {
            return false;
          }
        },
        createFn: async () => createIssue(createInput, KEY, "subtask", st.externalId),
        onSkip: (cachedId) => console.log(`  ⏭️ skip (idempotent) ${st.externalId} -> ${cachedId}`),
      });
    } catch (err) {
      console.error(`  ❌ [subtask] ${st.externalId}: ${err.message}`);
      hasError = true;
    }
  }

  if (hasError) {
    console.error("\n⚠️  Some subtasks failed. Re-run with --brief to resume (idempotent).");
    process.exit(1);
  }

  console.log("\n✅ Push complete.");
}

// Guard: only run main() when called directly (not when imported as module)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
