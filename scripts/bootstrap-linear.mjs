// Idempotently provision a Linear team from repo config: label groups + labels,
// workflow states, issue templates. Zero-dep (Node 18+ global fetch + Linear GraphQL API).
//
// Usage:
//   LINEAR_API_KEY=lin_api_... LINEAR_TEAM_KEY=JOI node scripts/bootstrap-linear.mjs
//   LINEAR_API_KEY=lin_api_... LINEAR_TEAM_KEY=JOI node scripts/bootstrap-linear.mjs --dry-run
//
// Reads .env for LINEAR_API_KEY, LINEAR_TEAM_KEY, LINEAR_WORKSPACE.
// Config: config/linear/labels.json, config/linear/states.json, config/linear/templates/*.md

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// ---------------------------------------------------------------------------
// Helpers
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

/** Load a JSON config file from config/linear/. */
function loadJSON(name) {
  return JSON.parse(readFileSync(join(root, "config", "linear", name), "utf8"));
}

/** Read a template markdown file from config/linear/templates/. */
function readTemplate(name) {
  return readFileSync(join(root, "config", "linear", "templates", name), "utf8");
}

/** Tagged template helper for GraphQL strings (just for readability). */
function gql(strings) {
  return strings[0];
}

// ---------------------------------------------------------------------------
// Linear GraphQL client
// ---------------------------------------------------------------------------

const ENDPOINT = "https://api.linear.app/graphql";

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
    const msgs = body.errors.map((e) => e.message).join("; ");
    throw new Error(`GraphQL error: ${msgs}`);
  }

  return body.data;
}

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------

const COLORS = {
  type:    { feature: "4A90D9", bug: "D0021B", spike: "F5A623", tech: "7ED321" },
  needs:   { answer: "F5A623", approval: "F8E71C", decision: "D0021B", access: "9B9B9B" },
  risk:    { high: "D0021B" },
  ai:      { planned: "B8E986", coded: "7ED321", reviewed: "4A90D9" },
  flag:    "9B9B9B",
  group:   { type: "4A90D9", needs: "F5A623", risk: "D0021B", ai: "7ED321" },
  state:   { todo: "C0C0C0", inprogress: "4A90D9", inreview: "F5A623", done: "7ED321", canceled: "9B9B9B" },
};

// ---------------------------------------------------------------------------
// Team resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a team by its key (slug).
 * @param {string} key  Linear API key.
 * @param {string} teamKey  Team slug/key to find.
 * @returns {{ id: string, name: string, key: string }}
 */
async function resolveTeam(key, teamKey) {
  const data = await graphql(
    gql`
      query {
        teams {
          nodes {
            id
            name
            key
          }
        }
      }
    `,
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

// ---------------------------------------------------------------------------
// Existing resources queries
// ---------------------------------------------------------------------------

async function fetchExistingLabelGroups(teamId, key) {
  // Current schema: Team has NO `labelGroups` field. A label GROUP is just an
  // IssueLabel with isGroup:true; its children are IssueLabels whose parent is
  // the group. We fetch all labels and keep only the groups (each carrying its
  // children) so downstream provisioning can match by name.
  const data = await graphql(
    gql`
      query ($teamId: String!) {
        team(id: $teamId) {
          labels(first: 100) {
            nodes {
              id
              name
              isGroup
              parent {
                id
              }
              children {
                nodes {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `,
    { teamId },
    key,
  );
  const labels = data.team?.labels?.nodes || [];
  return labels.filter((l) => l.isGroup === true);
}

async function fetchExistingLabels(teamId, key) {
  // Current schema: label→group link is via `parent` (an IssueLabel with
  // isGroup:true), not `labelGroup`. Standalone flags have a null parent.
  const data = await graphql(
    gql`
      query ($teamId: String!) {
        team(id: $teamId) {
          labels(first: 100) {
            nodes {
              id
              name
              isGroup
              parent {
                id
              }
            }
          }
        }
      }
    `,
    { teamId },
    key,
  );
  return data.team?.labels?.nodes || [];
}

async function fetchExistingStates(teamId, key) {
  const data = await graphql(
    gql`
      query ($teamId: String!) {
        team(id: $teamId) {
          states(first: 100) {
            nodes {
              id
              name
              type
            }
          }
        }
      }
    `,
    { teamId },
    key,
  );
  return data.team?.states?.nodes || [];
}

async function fetchExistingTemplates(teamId, key) {
  // Current schema: Team.templates (was issueTemplates). Kept for the live
  // fetch step; templates provisioning itself is DEFERRED (see provisionTemplates).
  const data = await graphql(
    gql`
      query ($teamId: String!) {
        team(id: $teamId) {
          templates(first: 100) {
            nodes {
              id
              name
            }
          }
        }
      }
    `,
    { teamId },
    key,
  );
  return data.team?.templates?.nodes || [];
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function createLabelGroup(teamId, name, color, key) {
  // Current schema: there is no labelGroupCreate. A group is an IssueLabel with
  // isGroup:true, created via issueLabelCreate.
  return graphql(
    gql`
      mutation ($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel {
            id
            name
          }
        }
      }
    `,
    { input: { teamId, name, color, isGroup: true } },
    key,
  );
}

async function createLabel(teamId, name, description, color, parentId, key) {
  // Current schema: child labels are IssueLabels whose parent is the group
  // IssueLabel (parentId). Standalone flags pass parentId=null.
  const input = { teamId, name };
  if (description) input.description = description;
  if (color) input.color = color;
  if (parentId) input.parentId = parentId;
  return graphql(
    gql`
      mutation ($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel {
            id
            name
          }
        }
      }
    `,
    { input },
    key,
  );
}

async function createWorkflowState(teamId, name, type, color, position, key) {
  const input = { teamId, name, type };
  if (color) input.color = color;
  if (position != null) input.position = position;
  return graphql(
    gql`
      mutation ($input: WorkflowStateCreateInput!) {
        workflowStateCreate(input: $input) {
          success
          workflowState {
            id
            name
          }
        }
      }
    `,
    { input },
    key,
  );
}

async function createIssueTemplate(teamId, name, description, templateData, sortOrder, key) {
  // Current schema: templateCreate (was issueTemplateCreate), input
  // TemplateCreateInput. type is NON_NULL and templateData is NON_NULL JSON.
  // NOTE: currently UNUSED — templates provisioning is deferred until the
  // templateData JSON shape is confirmed (see provisionTemplates).
  const input = { type: "issue", name, templateData };
  if (teamId) input.teamId = teamId;
  if (description) input.description = description;
  if (sortOrder != null) input.sortOrder = sortOrder;
  return graphql(
    gql`
      mutation ($input: TemplateCreateInput!) {
        templateCreate(input: $input) {
          success
          template {
            id
            name
          }
        }
      }
    `,
    { input },
    key,
  );
}

// ---------------------------------------------------------------------------
// Provisioning functions
// ---------------------------------------------------------------------------

/**
 * Provision label groups and their child labels.
 * Returns { created: number, skipped: number }
 */
async function provisionLabelGroups(teamId, groups, descriptions, existingGroups, existingLabels, key, dryRun) {
  let created = 0;
  let skipped = 0;

  for (const [groupName, groupCfg] of Object.entries(groups)) {
    const existingGroup = existingGroups.find((g) => g.name === groupName);
    const groupColor = COLORS.group[groupName] || "9B9B9B";

    if (existingGroup) {
      if (dryRun) {
        console.log(`  ⏭️  label group "${groupName}" exists (id: ${existingGroup.id})`);
      }
      skipped++;

      // Check child labels within the existing group (children are IssueLabels
      // whose parent is this group IssueLabel).
      const existingGroupLabels = existingGroup.children?.nodes || [];
      for (const labelName of groupCfg.labels) {
        const existingLabel = existingGroupLabels.find((l) => l.name === labelName);
        if (existingLabel) {
          if (dryRun) console.log(`    ⏭️  label "${groupName}:${labelName}" exists`);
          skipped++;
        } else {
          if (dryRun) {
            console.log(`    ➕ create label "${groupName}:${labelName}"`);
          } else {
            const descKey = `${groupName}:${labelName}`;
            const desc = descriptions[descKey] || "";
            const color = COLORS[groupName]?.[labelName] || groupColor;
            await createLabel(teamId, labelName, desc, color, existingGroup.id, process.env.LINEAR_API_KEY);
            console.log(`  ✅ created label "${groupName}:${labelName}"`);
            created++;
          }
        }
      }
    } else {
      if (dryRun) {
        console.log(`  ➕ create label group "${groupName}" (color: #${groupColor})`);
        for (const labelName of groupCfg.labels) {
          const descKey = `${groupName}:${labelName}`;
          const desc = descriptions[descKey] || "";
          console.log(`    ➕ create label "${groupName}:${labelName}"${desc ? ` — ${desc}` : ""}`);
        }
        created += 1 + groupCfg.labels.length;
      } else {
        // Create the group first (an IssueLabel with isGroup:true)
        const groupResult = await createLabelGroup(teamId, groupName, groupColor, process.env.LINEAR_API_KEY);
        if (!groupResult?.issueLabelCreate?.success) {
          console.error(`  ❌ failed to create label group "${groupName}"`);
          continue;
        }
        const newGroupId = groupResult.issueLabelCreate.issueLabel.id;
        console.log(`  ✅ created label group "${groupName}"`);

        // Then create each label in the group
        for (const labelName of groupCfg.labels) {
          const descKey = `${groupName}:${labelName}`;
          const desc = descriptions[descKey] || "";
          const color = COLORS[groupName]?.[labelName] || groupColor;
          await createLabel(teamId, labelName, desc, color, newGroupId, process.env.LINEAR_API_KEY);
          console.log(`  ✅ created label "${groupName}:${labelName}"`);
          created++;
        }
        created++; // for the group itself
      }
    }
  }

  return { created, skipped };
}

/**
 * Provision standalone flag labels (not in any group).
 * Returns { created: number, skipped: number }
 */
async function provisionFlags(teamId, flags, descriptions, existingLabels, key, dryRun) {
  let created = 0;
  let skipped = 0;

  for (const flagName of flags) {
    // Check if a standalone label (no parent group) with this name exists
    const existing = existingLabels.find(
      (l) => l.name === flagName && !l.parent && !l.isGroup,
    );

    if (existing) {
      if (dryRun) console.log(`  ⏭️  flag "${flagName}" exists`);
      skipped++;
    } else {
      if (dryRun) {
        const desc = descriptions[flagName] || "";
        console.log(`  ➕ create flag "${flagName}"${desc ? ` — ${desc}` : ""}`);
        created++;
      } else {
        const desc = descriptions[flagName] || "";
        await createLabel(teamId, flagName, desc, COLORS.flag, null, key);
        console.log(`  ✅ created flag "${flagName}"`);
        created++;
      }
    }
  }

  return { created, skipped };
}

/**
 * Provision workflow states. Only creates states that don't already exist.
 * Standard states (Todo, In Progress, In Review, Done, Canceled) are typically
 * pre-created on every Linear team — we check and skip them.
 * Returns { created: number, skipped: number }
 */
async function provisionStates(teamId, states, existingStates, key, dryRun) {
  let created = 0;
  let skipped = 0;

  for (const [i, state] of states.entries()) {
    const existing = existingStates.find(
      (s) => s.name.toLowerCase() === state.name.toLowerCase(),
    );

    if (existing) {
      if (dryRun) console.log(`  ⏭️  state "${state.name}" exists (type: ${state.type})`);
      skipped++;
    } else {
      const stateColor = COLORS.state[state.name.toLowerCase().replace(/\s+/g, "")] || "9B9B9B";
      if (dryRun) {
        console.log(`  ➕ create state "${state.name}" (type: ${state.type}, color: #${stateColor}, position: ${i})`);
        created++;
      } else {
        await createWorkflowState(teamId, state.name, state.type, stateColor, i, key);
        console.log(`  ✅ created state "${state.name}"`);
        created++;
      }
    }
  }

  return { created, skipped };
}

/**
 * Provision issue templates from config/linear/templates/*.md.
 *
 * DEFERRED: TemplateCreateInput.templateData is a NON_NULL JSON scalar, but its
 * expected shape is not derivable from introspection alone (the workspace has
 * zero existing templates to copy from). Writing a guessed templateData would
 * create broken templates in Linear. Labels + states are provisioned now;
 * templates will be wired up once the templateData schema is confirmed.
 *
 * Returns { created: 0, skipped: 0, manual: [], deferred: true }
 */
async function provisionTemplates(teamId, templates, existingTemplates, key, dryRun) {
  console.log(`  ⏭️  templates: deferred (templateData format TBD — labels+states provisioned)`);
  return { created: 0, skipped: 0, manual: [], deferred: true };
}

// ---------------------------------------------------------------------------
// Dry-run printer
// ---------------------------------------------------------------------------

function printDryRun(team, workspace, labelsCfg, statesCfg, templates) {
  const out = (s) => process.stdout.write(s + "\n");

  out("");
  out("=== Linear Bootstrap — Dry Run ===");
  out("");
  out("Target:");
  out(`  Workspace: ${workspace || "(not set — for logging only)"}`);
  out(`  Team:      ${team.name} (${team.key}, id: ${team.id})`);
  const keyDisplay = process.env.LINEAR_API_KEY
    ? `${process.env.LINEAR_API_KEY.slice(0, 8)}...${process.env.LINEAR_API_KEY.slice(-4)}`
    : "(not set — set LINEAR_API_KEY in .env)";
  out(`  API key:   ${keyDisplay}`);
  out("");

  // Label groups
  out("Label groups:");
  for (const [groupName, groupCfg] of Object.entries(labelsCfg.groups)) {
    const color = COLORS.group[groupName] || "9B9B9B";
    out(`  ➕ label group "${groupName}" (color: #${color}, exclusive: ${groupCfg.exclusive})`);
    for (const labelName of groupCfg.labels) {
      const descKey = `${groupName}:${labelName}`;
      const desc = labelsCfg.descriptions?.[descKey] || "";
      const lcolor = COLORS[groupName]?.[labelName] || color;
      out(`    ➕ label "${labelName}" (color: #${lcolor})${desc ? ` — ${desc}` : ""}`);
    }
  }
  out("");

  // Flags
  out("Flags (standalone labels):");
  for (const flagName of labelsCfg.flags) {
    const desc = labelsCfg.descriptions?.[flagName] || "";
    out(`  ➕ flag "${flagName}" (color: #${COLORS.flag})${desc ? ` — ${desc}` : ""}`);
  }
  out("");

  // Workflow states
  out("Workflow states:");
  for (const [i, state] of statesCfg.workflowStates.entries()) {
    const stateColor = COLORS.state[state.name.toLowerCase().replace(/\s+/g, "")] || "9B9B9B";
    out(`  ${state.name} → type: ${state.type}, color: #${stateColor}, position: ${i}`);
  }
  out("");

  // Issue templates
  out("Issue templates:");
  out("  ⏭️  templates: deferred (templateData format TBD — labels+states provisioned)");
  out("");

  out("GraphQL operations:");
  const groupCount = Object.keys(labelsCfg.groups).length;
  const labelCount = Object.values(labelsCfg.groups).reduce((s, g) => s + g.labels.length, 0);
  const flagCount = labelsCfg.flags.length;
  const stateCount = statesCfg.workflowStates.length;
  out(`  Queries:    4 (teams, labels(groups+children), states, templates)`);
  out(`  Mutations:  ${groupCount + labelCount + flagCount + stateCount} total (templates deferred)`);
  out(`    issueLabelCreate:     ${groupCount + labelCount + flagCount}  (label groups + child labels + flags)`);
  out(`    workflowStateCreate: ${stateCount}`);
  out(`    templateCreate:      0 (deferred — templateData format TBD)`);
  out("");

  out("Idempotency: each create is preceded by an existence check (by name + isGroup).");
  out("Existing items are skipped (⏭️).");
  out("");
  out("Dry-run complete. Remove --dry-run to execute.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();

  const dryRun = process.argv.includes("--dry-run");
  const KEY = process.env.LINEAR_API_KEY;
  const teamKey = process.env.LINEAR_TEAM_KEY;
  const workspace = process.env.LINEAR_WORKSPACE || "";

  // Load config
  const labelsCfg = loadJSON("labels.json");
  const statesCfg = loadJSON("states.json");

  // Load templates
  const templateFiles = [
    { file: "feature.md", name: "Feature", description: "New feature or improvement", order: 1 },
    { file: "bug.md", name: "Bug", description: "Defect or regression", order: 2 },
    { file: "spike.md", name: "Spike", description: "Research, decision, or ADR", order: 3 },
    { file: "tech.md", name: "Tech", description: "Tech-debt, refactor, or infrastructure", order: 4 },
  ];
  const templates = templateFiles.map((t) => ({
    ...t,
    body: readTemplate(t.file),
  }));

  // --dry-run: print plan and exit (no API calls, no key required)
  if (dryRun) {
    const displayKey = KEY ? `${KEY.slice(0, 8)}...${KEY.slice(-4)}` : "(not set — set LINEAR_API_KEY in .env)";
    const displayTeam = teamKey || "(not set — set LINEAR_TEAM_KEY in .env)";
    const fakeTeam = { name: displayTeam, key: displayTeam, id: "(resolved at runtime)" };
    printDryRun(fakeTeam, workspace, labelsCfg, statesCfg, templates);
    return;
  }

  if (!KEY) {
    console.error("Missing LINEAR_API_KEY — set in .env or environment");
    process.exit(1);
  }

  if (!teamKey) {
    console.error("Missing LINEAR_TEAM_KEY — set in .env or environment (e.g. JOI, PISI)");
    process.exit(1);
  }

  // Resolve team
  let team;
  try {
    team = await resolveTeam(KEY, teamKey);
  } catch (err) {
    if (err.message.includes("401") || err.message.includes("403") || err.message.includes("Authentication")) {
      console.error(`❌ Auth failure: ${err.message}`);
      process.exit(2);
    }
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  console.log(`🔍 Resolved team: ${team.name} (${team.key})${workspace ? ` in workspace "${workspace}"` : ""}`);

  // -----------------------------------------------------------------------
  // Real execution
  // -----------------------------------------------------------------------
  console.log("");

  // Fetch existing resources
  console.log("📡 Fetching existing resources...");
  const [existingGroups, existingLabels, existingStates, existingTemplates] = await Promise.all([
    fetchExistingLabelGroups(team.id, KEY),
    fetchExistingLabels(team.id, KEY),
    fetchExistingStates(team.id, KEY),
    fetchExistingTemplates(team.id, KEY),
  ]);
  console.log(`   Found ${existingGroups.length} label groups, ${existingLabels.length} labels, ${existingStates.length} states, ${existingTemplates.length} templates`);
  console.log("");

  // 1. Label groups + labels
  console.log("🏷️  Label groups:");
  const lgResult = await provisionLabelGroups(
    team.id, labelsCfg.groups, labelsCfg.descriptions || {},
    existingGroups, existingLabels, KEY, false,
  );
  console.log("");

  // 2. Flags
  console.log("🚩 Flags:");
  const flResult = await provisionFlags(
    team.id, labelsCfg.flags, labelsCfg.descriptions || {},
    existingLabels, KEY, false,
  );
  console.log("");

  // 3. Workflow states
  console.log("🔷 Workflow states:");
  const stResult = await provisionStates(
    team.id, statesCfg.workflowStates, existingStates, KEY, false,
  );
  console.log("");

  // 4. Issue templates
  console.log("📋 Issue templates:");
  const tplResult = await provisionTemplates(
    team.id, templates, existingTemplates, KEY, false,
  );
  console.log("");

  // Summary
  console.log("═══════════════════════════════════════");
  console.log("Summary:");
  console.log(`  Label groups:  ${lgResult.created} created, ${lgResult.skipped} skipped`);
  console.log(`  Flags:         ${flResult.created} created, ${flResult.skipped} skipped`);
  console.log(`  States:        ${stResult.created} created, ${stResult.skipped} skipped`);
  if (tplResult.deferred) {
    console.log(`  Templates:     deferred (templateData format TBD)`);
  } else {
    console.log(`  Templates:     ${tplResult.created} created, ${tplResult.skipped} skipped`);
    if (tplResult.manual.length) {
      console.log(`  ⚠️  Manual: ${tplResult.manual.join(", ")} (create via Linear UI)`);
    }
  }
  console.log("✅ Bootstrap complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
