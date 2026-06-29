#!/usr/bin/env node
/**
 * scripts/linear-ops.mjs — Headless write mutations on EXISTING Linear issues.
 *
 * Linear tools: this script + linear-query.mjs are the ONLY sanctioned Linear
 * access; never use mcp__linear__* headless.
 *
 * Subcommands:
 *   transition <id|identifier> --status <name> [--dry-run]
 *   label <id|identifier> --add <l> [--add <l> ...] --remove <l> [--remove <l> ...] [--dry-run]
 *   comment <id|identifier> (--body <text> | --body-file <path>) [--dedup-tag <tag>] [--dry-run]
 *   estimate <id|identifier> --estimate <XS|S|M|L|XL> [--dry-run]
 *
 * Dependencies: Node 18+ (global fetch). No npm install required.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadEnv, graphql, resolveTeam, resolveIssue } from "./linear-client.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** T-shirt → Linear numeric estimate (mirrors linear-push.mjs ESTIMATE_MAP + XS). */
const ESTIMATE_MAP = { XS: 1, S: 2, M: 3, L: 5, XL: 8 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract team key from an issue identifier (e.g., "FEN-12" → "FEN"). */
function extractTeamKey(identifier) {
  const m = identifier.match(/^([A-Za-z]+)-\d+$/);
  return m ? m[1] : null;
}

/**
 * Resolve an issue and its team.
 * Uses identifier prefix for team key; falls back to querying the issue
 * with team info for raw UUID identifiers.
 */
async function resolveIssueWithTeam(identifier) {
  const issue = await resolveIssue(identifier);
  const teamKey = extractTeamKey(identifier);
  if (teamKey) {
    const team = await resolveTeam(teamKey);
    return { issue, teamId: team.id, teamKey: team.key };
  }
  // Raw UUID — query issue with team info
  const data = await graphql(
    `query($id:String!){ issue(id:$id){ team{ id key } } }`,
    { id: issue.id },
  );
  return { issue, teamId: data.issue.team.id, teamKey: data.issue.team.key };
}

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  const rest = [];

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--status" && i + 1 < argv.length) {
      args.status = argv[++i];
    } else if (a === "--add" && i + 1 < argv.length) {
      if (!args.add) args.add = [];
      args.add.push(argv[++i]);
    } else if (a === "--remove" && i + 1 < argv.length) {
      if (!args.remove) args.remove = [];
      args.remove.push(argv[++i]);
    } else if (a === "--body" && i + 1 < argv.length) {
      args.body = argv[++i];
    } else if (a === "--body-file" && i + 1 < argv.length) {
      args.bodyFile = argv[++i];
    } else if (a === "--dedup-tag" && i + 1 < argv.length) {
      args.dedupTag = argv[++i];
    } else if (a === "--estimate" && i + 1 < argv.length) {
      args.estimate = argv[++i];
    } else if (a.startsWith("--")) {
      // Unknown flag — skip
    } else {
      rest.push(a);
    }
  }

  args._ = rest;
  return args;
}

function printUsage() {
  console.error("Usage:");
  console.error("  node scripts/linear-ops.mjs transition <id|identifier> --status <name> [--dry-run]");
  console.error("  node scripts/linear-ops.mjs label <id|identifier> --add <l> [--add <l> ...] --remove <l> [--remove <l> ...] [--dry-run]");
  console.error("  node scripts/linear-ops.mjs comment <id|identifier> (--body <text> | --body-file <path>) [--dedup-tag <tag>] [--dry-run]");
  console.error("  node scripts/linear-ops.mjs estimate <id|identifier> --estimate <XS|S|M|L|XL> [--dry-run]");
}

// ---------------------------------------------------------------------------
// Subcommand: transition
// ---------------------------------------------------------------------------

async function handleTransition(identifier, args) {
  const { issue, teamId } = await resolveIssueWithTeam(identifier);
  const oldState = issue.state?.name || "(unknown)";

  if (!args.status) {
    console.error("Error: --status <name> is required for transition");
    process.exit(2);
  }

  // Fetch team states
  const data = await graphql(
    `query($teamId:String!){
      team(id:$teamId){ states(first:100){ nodes{ id name type } } }
    }`,
    { teamId },
  );
  const states = data.team?.states?.nodes || [];
  const targetState = states.find(
    (s) => s.name.toLowerCase() === args.status.toLowerCase(),
  );
  if (!targetState) {
    const available = states.map((s) => s.name).join(", ");
    console.error(`Error: state "${args.status}" not found. Available: ${available}`);
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(`[dry-run] transition ${issue.identifier}: ${oldState} → ${args.status}`);
    console.log(`  issue:    ${issue.identifier} (${issue.id})`);
    console.log(`  newState: "${targetState.name}" (${targetState.id})`);
    return;
  }

  const result = await graphql(
    `mutation($id:String!,$input:IssueUpdateInput!){
      issueUpdate(id:$id,input:$input){ success issue{ id identifier state{name} } }
    }`,
    { id: issue.id, input: { stateId: targetState.id } },
  );

  const updated = result.issueUpdate.issue;
  console.log(`${issue.identifier}: ${oldState} → ${updated.state.name}`);
}

// ---------------------------------------------------------------------------
// Subcommand: label
// ---------------------------------------------------------------------------

async function handleLabel(identifier, args) {
  const { issue, teamId } = await resolveIssueWithTeam(identifier);

  // BUG 1.4: require at least one of --add or --remove
  if (!args.add && !args.remove) {
    console.error("Error: --add or --remove is required for label");
    printUsage();
    process.exit(2);
  }

  // Fetch current issue labels
  const issueData = await graphql(
    `query($id:String!){ issue(id:$id){ labels{ nodes{ id name } } } }`,
    { id: issue.id },
  );
  const currentLabels = issueData.issue?.labels?.nodes || [];
  const currentIds = new Set(currentLabels.map((l) => l.id));
  const currentNames = currentLabels.map((l) => l.name).sort();

  // Fetch team labels for name→id resolution
  const teamData = await graphql(
    `query($teamId:String!){
      team(id:$teamId){ labels(first:200){ nodes{ id name isGroup parent{ id name } } } }
    }`,
    { teamId },
  );
  const allLabels = teamData.team?.labels?.nodes || [];

  // BUG 1.1: Build BOTH flat labelByName AND childByNameInGroup (port from linear-push.mjs)
  const labelByName = new Map(allLabels.map((l) => [l.name, l]));
  const childByNameInGroup = new Map();
  const groupById = new Map();
  for (const lbl of allLabels) {
    if (lbl.isGroup) groupById.set(lbl.id, lbl.name);
  }
  for (const lbl of allLabels) {
    if (!lbl.isGroup && lbl.parent && lbl.parent.id) {
      const parentName = groupById.get(lbl.parent.id) || lbl.parent.name;
      if (parentName) {
        childByNameInGroup.set(`${parentName}::${lbl.name}`, lbl);
      }
    }
  }

  /**
   * Resolve a label name (possibly "group:child") to a label node.
   * 1. Exact match by name.
   * 2. If name contains ":", split on first ":" and look up in childByNameInGroup.
   * 3. Fallback: scan all group children for a leaf matching name exactly.
   * 4. Throw if unresolved.
   */
  function resolveLabelId(name) {
    let lbl = labelByName.get(name);
    if (lbl) return lbl;

    const colonIdx = name.indexOf(":");
    if (colonIdx > 0) {
      const group = name.slice(0, colonIdx);
      const child = name.slice(colonIdx + 1);
      lbl = childByNameInGroup.get(`${group}::${child}`);
      if (lbl) return lbl;
    }

    // Fallback: scan all group children for a leaf matching name
    for (const [, childLbl] of childByNameInGroup) {
      if (childLbl.name === name) return childLbl;
    }

    throw new Error(`Label not found in team FEN: ${name}`);
  }

  // Resolve --add names to IDs
  const addIds = new Set();
  for (const name of args.add || []) {
    const lbl = resolveLabelId(name);
    // BUG 1.2: reject group labels on --add
    if (lbl.isGroup) {
      console.error(`Cannot add group label '${name}' (only leaf labels attach to issues)`);
      process.exit(1);
    }
    addIds.add(lbl.id);
  }

  // Resolve --remove names to IDs
  const removeIds = new Set();
  for (const name of args.remove || []) {
    const lbl = resolveLabelId(name);
    // BUG 1.2: reject group labels on --remove
    if (lbl.isGroup) {
      console.error(`Cannot remove group label '${name}' (group labels are never attached to issues)`);
      process.exit(1);
    }
    removeIds.add(lbl.id);
  }

  // Compute new set: (current - removes) ∪ adds
  const newIds = new Set(currentIds);
  for (const id of removeIds) newIds.delete(id);
  for (const id of addIds) newIds.add(id);

  const newNames = [...newIds]
    .map((id) => allLabels.find((l) => l.id === id)?.name || id)
    .sort();

  if (args.dryRun) {
    // BUG 1.3: show resolved label IDs alongside names
    const currentWithIds = currentLabels
      .map((l) => `${l.name} (${l.id})`)
      .sort();
    const plannedWithIds = [...newIds]
      .map((id) => {
        const l = allLabels.find((l) => l.id === id);
        return l ? `${l.name} (${l.id})` : id;
      })
      .sort();
    console.log(`[dry-run] ${issue.identifier} labels:`);
    console.log(`  current: [${currentWithIds.join(", ")}]`);
    console.log(`  planned: [${plannedWithIds.join(", ")}]`);
    return;
  }

  // TOCTOU: read-modify-write on labelIds; do NOT run concurrent label ops
  // on the same issue (WIP=1 assumption).
  const result = await graphql(
    `mutation($id:String!,$input:IssueUpdateInput!){
      issueUpdate(id:$id,input:$input){ success issue{ id identifier } }
    }`,
    { id: issue.id, input: { labelIds: [...newIds] } },
  );

  if (result.issueUpdate.success) {
    console.log(`${issue.identifier} labels: [${currentNames.join(", ")}] → [${newNames.join(", ")}]`);
  } else {
    console.error(`Error: label update failed for ${issue.identifier}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: comment
// ---------------------------------------------------------------------------

async function handleComment(identifier, args) {
  const { issue } = await resolveIssueWithTeam(identifier);

  // Resolve body
  let body;
  if (args.body && args.bodyFile) {
    console.error("Error: provide --body OR --body-file, not both");
    process.exit(2);
  }
  if (args.body) {
    body = args.body;
  } else if (args.bodyFile) {
    try {
      body = readFileSync(args.bodyFile, "utf8");
    } catch (err) {
      console.error(`Error reading --body-file "${args.bodyFile}": ${err.message}`);
      process.exit(1);
    }
  } else {
    console.error("Error: --body <text> or --body-file <path> is required for comment");
    process.exit(2);
  }

  // Dedup check
  if (args.dedupTag) {
    const marker = `<!-- run:${args.dedupTag} -->`;

    // BUG 3.2: skip API call in --dry-run
    if (args.dryRun) {
      const wouldPost = `${marker}\n${body}`;
      console.log(`[dry-run] ${issue.identifier}: would post comment (dedup skipped in dry-run):`);
      console.log(wouldPost);
      return;
    }

    // BUG 3.1: fetch up to 250 comments
    const commentData = await graphql(
      `query($id:String!){
        issue(id:$id){ comments(first:250){ nodes{ id body createdAt } } }
      }`,
      { id: issue.id },
    );
    const comments = commentData.issue?.comments?.nodes || [];

    // BUG 3.1: warn if capped
    if (comments.length === 250) {
      console.error(`[dedup] comment list capped at 250; marker older than that may be missed`);
    }

    // BUG 3.3: use trimStart().startsWith instead of includes
    const alreadyPosted = comments.some((c) => c.body && c.body.trimStart().startsWith(marker));
    if (alreadyPosted) {
      console.log(`${issue.identifier}: comment deduped (tag=${args.dedupTag}, already posted)`);
      return;
    }
    // Prepend dedup marker
    body = `${marker}\n${body}`;
  }

  if (args.dryRun) {
    console.log(`[dry-run] ${issue.identifier}: would post comment:`);
    console.log(body);
    return;
  }

  const result = await graphql(
    `mutation($input:CommentCreateInput!){
      commentCreate(input:$input){ success comment{ id } }
    }`,
    { input: { issueId: issue.id, body } },
  );

  if (result.commentCreate.success) {
    console.log(`${issue.identifier}: comment posted (id=${result.commentCreate.comment.id})`);
  } else {
    console.error(`Error: comment creation failed for ${issue.identifier}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: estimate
// ---------------------------------------------------------------------------

async function handleEstimate(identifier, args) {
  const { issue } = await resolveIssueWithTeam(identifier);

  if (!args.estimate) {
    console.error("Error: --estimate <XS|S|M|L|XL> is required for estimate");
    process.exit(2);
  }

  const upper = args.estimate.toUpperCase();
  const value = ESTIMATE_MAP[upper];
  if (value === undefined) {
    console.error(`Error: invalid estimate "${args.estimate}". Valid: ${Object.keys(ESTIMATE_MAP).join(", ")}`);
    process.exit(2);
  }

  if (args.dryRun) {
    console.log(`[dry-run] ${issue.identifier}: estimate → ${upper} (${value})`);
    return;
  }

  const result = await graphql(
    `mutation($id:String!,$input:IssueUpdateInput!){
      issueUpdate(id:$id,input:$input){ success issue{ id identifier estimate } }
    }`,
    { id: issue.id, input: { estimate: value } },
  );

  if (result.issueUpdate.success) {
    const updated = result.issueUpdate.issue;
    console.log(`${issue.identifier}: estimate → ${updated.estimate}`);
  } else {
    console.error(`Error: estimate update failed for ${issue.identifier}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();

  const args = parseArgs(process.argv);
  const cmd = args._[0];
  const identifier = args._[1];

  if (!cmd || !identifier) {
    printUsage();
    process.exit(2);
  }

  switch (cmd) {
    case "transition":
      await handleTransition(identifier, args);
      break;
    case "label":
      await handleLabel(identifier, args);
      break;
    case "comment":
      await handleComment(identifier, args);
      break;
    case "estimate":
      await handleEstimate(identifier, args);
      break;
    default:
      console.error(`Error: unknown subcommand "${cmd}"`);
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
