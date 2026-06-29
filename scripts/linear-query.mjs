#!/usr/bin/env node
/**
 * scripts/linear-query.mjs — Headless read-only Linear queries.
 *
 * Linear tools: this script + linear-ops.mjs are the ONLY sanctioned Linear
 * access; never use mcp__linear__* headless.
 *
 * CLI subcommands for querying Linear issues, teams, and comments.
 * Human-readable by default, --json for machine consumption.
 *
 * Dry-run safety: if any env var matching *_DRY_RUN=1 is set, the script
 * reads from a fixture file instead of calling the Linear API.
 *
 * Usage:
 *   node scripts/linear-query.mjs team [TEAM_KEY]
 *   node scripts/linear-query.mjs issues [--status <name>] [--label <flag>] [--first N] [--json]
 *   node scripts/linear-query.mjs issue <id|identifier> [--json]
 *   node scripts/linear-query.mjs comments <id|identifier> [--json]
 *   node scripts/linear-query.mjs search "<term>" [--first N] [--json]
 *
 * Dependencies: Node 18+ (global fetch). No npm install required.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadEnv, graphql, resolveTeam, resolveIssue } from "./linear-client.mjs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// ---------------------------------------------------------------------------
// Dry-run detection
// ---------------------------------------------------------------------------

/**
 * Check for any *_DRY_RUN=1 env var and return the squad name.
 * @returns {{ active: boolean, squad: string|null, fixturePath: string|null }}
 */
function detectDryRun() {
  for (const [key, val] of Object.entries(process.env)) {
    if (val === "1" && key.endsWith("_DRY_RUN")) {
      const squad = key.slice(0, -"_DRY_RUN".length).toLowerCase();
      const fixturePath = join(root, ".state", "mock", `${squad}-task.json`);
      return { active: true, squad, fixturePath };
    }
  }
  return { active: false, squad: null, fixturePath: null };
}

/**
 * Load a dry-run fixture from disk. Exits 1 if missing.
 * @param {string} fixturePath
 * @returns {object}
 */
function loadFixture(fixturePath) {
  if (!existsSync(fixturePath)) {
    console.error(`[dry-run] fixture not found: ${fixturePath}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

// ---------------------------------------------------------------------------
// CLI argument parser (minimal, no deps)
// ---------------------------------------------------------------------------

function parseArgs(argv, startIndex) {
  const args = { _: [], first: 50, json: false };
  for (let i = startIndex; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      args.json = true;
    } else if (a === "--first" && i + 1 < argv.length) {
      args.first = parseInt(argv[++i], 10) || 50;
    } else if (a === "--status" && i + 1 < argv.length) {
      args.status = argv[++i];
    } else if (a === "--label" && i + 1 < argv.length) {
      args.label = argv[++i];
    } else if (a.startsWith("--")) {
      // skip unknown flags
    } else {
      args._.push(a);
    }
  }
  return args;
}

function printUsage() {
  console.error("Usage:");
  console.error("  node scripts/linear-query.mjs team [TEAM_KEY]");
  console.error("  node scripts/linear-query.mjs issues [--status <name>] [--label <flag>] [--first N] [--json]");
  console.error("  node scripts/linear-query.mjs issue <id|identifier> [--json]");
  console.error("  node scripts/linear-query.mjs comments <id|identifier> [--json]");
  console.error("  node scripts/linear-query.mjs search \"<term>\" [--first N] [--json]");
}

// ---------------------------------------------------------------------------
// Query fragments
// ---------------------------------------------------------------------------

const ISSUE_FRAGMENT = `
  id
  identifier
  title
  url
  state { id name type }
  priority
  estimate
  createdAt
  updatedAt
  startedAt
  assignee { id name displayName }
  labels { nodes { id name } }
  parent { id identifier title }
  children { nodes { id identifier title state { name } } }
`;

/**
 * Build the issues query string with dynamic filter and GraphQL variables.
 * Only includes variable declarations and filter clauses for flags that are set.
 * @param {string|null} stateName
 * @param {string|null} labelName
 * @returns {string}
 */
function buildIssuesQuery(stateName, labelName) {
  const varDecls = ["$teamId: String!", "$first: Int"];
  const filterParts = [];

  if (stateName) {
    varDecls.push("$stateName: String");
    filterParts.push("state: { name: { eq: $stateName } }");
  }
  if (labelName) {
    varDecls.push("$labelName: String");
    filterParts.push("labels: { name: { eq: $labelName } }");
  }

  const filter = filterParts.length > 0
    ? `filter: { ${filterParts.join(", ")} }`
    : "";

  return `
    query(${varDecls.join(", ")}) {
      team(id: $teamId) {
        issues(
          ${filter}
          first: $first
          orderBy: updatedAt
        ) {
          nodes { ${ISSUE_FRAGMENT} }
        }
      }
    }
  `;
}

const ISSUE_DETAIL_QUERY = `
  query($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      url
      description
      state { id name type }
      priority
      estimate
      createdAt
      updatedAt
      startedAt
      completedAt
      assignee { id name displayName }
      labels { nodes { id name } }
      parent { id identifier title }
      children { nodes { id identifier title state { name } } }
      comments(first: 50) {
        nodes { id body createdAt user { id name displayName } }
      }
      relations {
        nodes { id type relatedIssue { id identifier title } }
      }
    }
  }
`;

const COMMENTS_QUERY = `
  query($id: String!) {
    issue(id: $id) {
      comments(first: 50) {
        nodes { id body createdAt user { id name displayName } }
      }
    }
  }
`;

const SEARCH_QUERY = `
  query($term: String!, $first: Int) {
    searchIssues(term: $term, first: $first) {
      nodes {
        id
        identifier
        title
        url
        state { id name type }
        team { id key name }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function cmdTeam(args, dryRun) {
  const teamKey = args._[0] || process.env.LINEAR_TEAM_KEY;
  if (!teamKey) {
    console.error("Usage: node scripts/linear-query.mjs team [TEAM_KEY]");
    process.exit(2);
  }

  let team;
  if (dryRun.active) {
    const fixture = loadFixture(dryRun.fixturePath);
    if (teamKey && fixture.team?.key && fixture.team.key !== teamKey) {
      console.error(`[dry-run] WARNING: team fixture is for ${fixture.team.key}, requested ${teamKey}`);
    }
    team = fixture.team;
  } else {
    team = await resolveTeam(teamKey);
  }

  console.log(`id: ${team.id}`);
  console.log(`name: ${team.name}`);
  console.log(`key: ${team.key}`);
}

async function cmdIssues(args, dryRun) {
  const teamKey = process.env.LINEAR_TEAM_KEY;
  if (!teamKey) {
    console.error("LINEAR_TEAM_KEY not set (check .env)");
    process.exit(2);
  }

  const stateName = args.status || null;
  const labelFilter = args.label || null;
  const first = args.first;

  let nodes;

  if (dryRun.active) {
    const fixture = loadFixture(dryRun.fixturePath);
    nodes = (fixture.issues || []).slice();
    if (stateName) {
      nodes = nodes.filter((n) => n.state && n.state.name === stateName);
    }
    if (labelFilter) {
      nodes = nodes.filter(
        (n) => n.labels && n.labels.nodes && n.labels.nodes.some((l) => l.name === labelFilter),
      );
    }
  } else {
    const team = await resolveTeam(teamKey);
    const query = buildIssuesQuery(stateName, labelFilter);
    const vars = { teamId: team.id, first };
    if (stateName) vars.stateName = stateName;
    if (labelFilter) vars.labelName = labelFilter;
    const data = await graphql(query, vars);
    nodes = data.team?.issues?.nodes || [];
  }

  if (args.json) {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }

  for (const n of nodes) {
    const labels = (n.labels?.nodes || []).map((l) => l.name).join(",");
    const estimate = n.estimate != null ? n.estimate : "-";
    console.log(`${n.identifier} | ${n.state?.name || "?"} | estimate=${estimate} | labels=${labels || "-"} | ${n.title}`);
  }
}

async function cmdIssue(args, dryRun) {
  const identifier = args._[0];
  if (!identifier) {
    console.error("Usage: node scripts/linear-query.mjs issue <id|identifier>");
    process.exit(2);
  }

  let issue;

  if (dryRun.active) {
    const fixture = loadFixture(dryRun.fixturePath);
    if (fixture.issue && (fixture.issue.identifier === identifier || fixture.issue.id === identifier)) {
      issue = fixture.issue;
    } else {
      console.error(`[dry-run] issue ${identifier} not in fixture (fixture has ${fixture.issue?.identifier || "none"})`);
      process.exit(1);
    }
  } else {
    const basic = await resolveIssue(identifier);
    const data = await graphql(ISSUE_DETAIL_QUERY, { id: basic.id });
    issue = data?.issue;
    if (!issue) {
      console.error(`Issue not found: ${identifier}`);
      process.exit(1);
    }
  }

  if (args.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }

  const labels = (issue.labels?.nodes || []).map((l) => l.name).join(", ");
  const comments = issue.comments?.nodes || [];
  const children = issue.children?.nodes || [];
  const parent = issue.parent;

  console.log(`${issue.identifier}: ${issue.title}`);
  console.log(`State: ${issue.state?.name || "?"} (${issue.state?.type || "?"})`);
  console.log(`Labels: ${labels || "(none)"}`);
  console.log(`Comments: ${comments.length}`);
  console.log(`Children: ${children.length}`);
  if (parent) {
    console.log(`Parent: ${parent.identifier} — ${parent.title}`);
  }
  if (issue.description) {
    console.log(`\nDescription:\n${issue.description}`);
  }
}

async function cmdComments(args, dryRun) {
  const identifier = args._[0];
  if (!identifier) {
    console.error("Usage: node scripts/linear-query.mjs comments <id|identifier>");
    process.exit(2);
  }

  let commentNodes;

  if (dryRun.active) {
    const fixture = loadFixture(dryRun.fixturePath);
    if (identifier && fixture.issue?.identifier && fixture.issue.identifier !== identifier) {
      console.error(`[dry-run] WARNING: comments fixture is for ${fixture.issue.identifier}, requested ${identifier}`);
    }
    commentNodes = fixture.comments?.nodes || [];
  } else {
    const basic = await resolveIssue(identifier);
    const data = await graphql(COMMENTS_QUERY, { id: basic.id });
    commentNodes = data?.issue?.comments?.nodes || [];
  }

  if (args.json) {
    console.log(JSON.stringify(commentNodes, null, 2));
    return;
  }

  for (const c of commentNodes) {
    const user = c.user?.displayName || c.user?.name || "unknown";
    console.log(`[${user} ${c.createdAt}]`);
    console.log(c.body || "(no body)");
    console.log("---");
  }
}

async function cmdSearch(args, dryRun) {
  const term = args._[0];
  if (!term) {
    console.error("Usage: node scripts/linear-query.mjs search \"<term>\"");
    process.exit(2);
  }

  const first = args.first;

  if (dryRun.active) {
    console.error("[dry-run] search not meaningful offline — returning empty");
    if (args.json) {
      console.log("[]");
    }
    return;
  }

  const data = await graphql(SEARCH_QUERY, { term, first });
  const nodes = data?.searchIssues?.nodes || [];

  if (args.json) {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }

  for (const n of nodes) {
    console.log(`${n.identifier} | ${n.team?.key || "?"} | ${n.state?.name || "?"} | ${n.title}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();

  const cmd = process.argv[2];
  if (!cmd || cmd.startsWith("--")) {
    printUsage();
    process.exit(2);
  }

  const dryRun = detectDryRun();
  if (dryRun.active) {
    console.error(`[dry-run:${dryRun.squad}] using fixture ${dryRun.fixturePath}`);
  }

  const args = parseArgs(process.argv, 3);

  switch (cmd) {
    case "team":
      await cmdTeam(args, dryRun);
      break;
    case "issues":
      await cmdIssues(args, dryRun);
      break;
    case "issue":
      await cmdIssue(args, dryRun);
      break;
    case "comments":
      await cmdComments(args, dryRun);
      break;
    case "search":
      await cmdSearch(args, dryRun);
      break;
    default:
      console.error(`Unknown subcommand: ${cmd}`);
      printUsage();
      process.exit(2);
  }
}

// Guard: only run main() when called directly (not when imported as module)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
