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
 *   comment-replace <id|identifier> --dedup-tag <tag> (--body <text> | --body-file <path>) [--dry-run]
 *   update-description <id|identifier> (--body <text> | --body-file <path>) [--dry-run]
 *   estimate <id|identifier> --estimate <XS|S|M|L|XL> [--dry-run]
 *   priority <id|identifier> --priority <P0|P1|P2|P3> [--dry-run]
 *   due-date <id|identifier> --date <YYYY-MM-DD> [--clear] [--dry-run]
 *   create-child <parentId|parentIdentifier> --title <text> (--body <text> | --body-file <path>)
 *                [--type feat|bug|spike|tech] [--estimate <XS|S|M|L|XL>] [--label <l> ...]
 *                [--project <id|name>] [--milestone <id|name>] [--no-milestone] [--dry-run]
 *     Creates a NEW issue as a real Linear sub-issue (parentId) of an EXISTING
 *     issue — e.g. adding a follow-up under an epic like JOI-73. Distinct from
 *     linear-push.mjs, which always creates a brand-new top-level parent.
 *
 *     Project + milestone are INHERITED from the parent chain (FOC-716): the
 *     first ancestor that carries a project supplies both, so a child always
 *     lands where its epic lives. Flags override; without any project the call
 *     fails closed (exit 1) instead of creating an orphan. Success prints one
 *     extra JSON line echoing the project and milestone that were written.
 *
 * Dependencies: Node 18+ (global fetch). No npm install required.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadEnv, graphql, resolveTeam, resolveIssue } from "./linear-client.mjs";
import { assertEgressClean } from "./egress-screen.mjs";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** T-shirt → Linear numeric estimate (mirrors linear-push.mjs ESTIMATE_MAP + XS). */
const ESTIMATE_MAP = { XS: 1, S: 2, M: 3, L: 5, XL: 8 };

/**
 * P0..P3 → Linear's numeric priority (FOC-606). Linear encodes priority as
 * 0 = no priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low (source:
 * `agents/orchestrator/skills/refine/SKILL.md`, verified against the live
 * schema: `IssueUpdateInput.priority` exists, SCALAR). p0 is the most urgent,
 * so p3 — the level FOC-606 itself carries — is Low. The names are the
 * friendly ones exactly as `estimate` takes XS..XL rather than raw numbers,
 * which is the symmetry FOC-606's AC 3 asks for.
 */
const PRIORITY_MAP = { P0: 1, P1: 2, P2: 3, P3: 4 };

/** feat/fix/... -> type:<name> label suffix (mirrors linear-push.mjs TYPE_ALIAS). */
const TYPE_ALIAS = { feat: "feature", feature: "feature", fix: "bug", bug: "bug", spike: "spike", tech: "tech", refactor: "tech" };

const ISSUE_CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier url title project { id name } projectMilestone { id name } }
    }
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract team key from an issue identifier (e.g., "FEN-12" → "FEN"). */
function extractTeamKey(identifier) {
  const m = identifier.match(/^([A-Za-z]+)-\d+$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Dry-run detection (mirrors linear-query.mjs)
// ---------------------------------------------------------------------------

/**
 * Scan process.env for the first var matching /^([A-Z]+)_DRY_RUN=1$/.
 * When found, load the fixture from .state/mock/<squad>-task.json.
 * @returns {{ dryRun: boolean, squad?: string, fixture?: object }}
 */
function dryRunContext() {
  for (const [key, val] of Object.entries(process.env)) {
    if (val === "1" && key.endsWith("_DRY_RUN")) {
      const squad = key.slice(0, -"_DRY_RUN".length).toLowerCase();
      const fixturePath = join(root, ".state", "mock", `${squad}-task.json`);
      if (!existsSync(fixturePath)) {
        console.error(`[dry-run:${squad}] fixture .state/mock/${squad}-task.json missing`);
        process.exit(1);
      }
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
      return { dryRun: true, squad, fixture };
    }
  }
  return { dryRun: false };
}

/**
 * Resolve an issue from a dry-run fixture by identifier or id.
 * Exits 1 if not found.
 */
function resolveIssueFromFixture(fixture, identifier) {
  const issue = fixture.issue;
  if (issue && (issue.identifier === identifier || issue.id === identifier)) {
    return issue;
  }
  const fromArray = (fixture.issues || []).find(
    (i) => i.identifier === identifier || i.id === identifier,
  );
  if (fromArray) return fromArray;
  console.error(`[dry-run] issue ${identifier} not in fixture (fixture has ${fixture.issue?.identifier || "none"})`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Labels config (dry-run validation)
// ---------------------------------------------------------------------------

/**
 * Read labels.json and build valid label names + group key set.
 * @returns {{ valid: Set<string>, groupKeys: Set<string> }}
 */
function loadLabelsConfig() {
  const labelsPath = join(root, "config", "linear", "labels.json");
  const config = JSON.parse(readFileSync(labelsPath, "utf8"));
  const valid = new Set();
  const groupKeys = new Set();
  for (const [groupKey, groupDef] of Object.entries(config.groups)) {
    groupKeys.add(groupKey);
    for (const label of groupDef.labels) {
      valid.add(`${groupKey}:${label}`);
    }
  }
  for (const flag of config.flags) {
    valid.add(flag);
  }
  return { valid, groupKeys };
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
    } else if (a === "--priority" && i + 1 < argv.length) {
      args.priority = argv[++i];
    } else if (a === "--issue" && i + 1 < argv.length) {
      // FOC-606 only — see main(). Kept out of the shared identifier guard so
      // no other verb changes shape.
      args.issue = argv[++i];
    } else if (a === "--date" && i + 1 < argv.length) {
      args.date = argv[++i];
    } else if (a === "--clear") {
      args.clear = true;
    } else if (a === "--title" && i + 1 < argv.length) {
      args.title = argv[++i];
    } else if (a === "--type" && i + 1 < argv.length) {
      args.type = argv[++i];
    } else if (a === "--label" && i + 1 < argv.length) {
      if (!args.label) args.label = [];
      args.label.push(argv[++i]);
    } else if (a === "--project" && i + 1 < argv.length) {
      args.project = argv[++i];
    } else if (a === "--milestone" && i + 1 < argv.length) {
      args.milestone = argv[++i];
    } else if (a === "--no-milestone") {
      args.noMilestone = true;
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
  console.error("  node scripts/linear-ops.mjs comment-replace <id|identifier> --dedup-tag <tag> (--body <text> | --body-file <path>) [--dry-run]");
  console.error("  node scripts/linear-ops.mjs update-description <id|identifier> (--body <text> | --body-file <path>) [--dry-run]");
  console.error("  node scripts/linear-ops.mjs estimate <id|identifier> --estimate <XS|S|M|L|XL> [--dry-run]");
  console.error("  node scripts/linear-ops.mjs priority <id|identifier> --priority <P0|P1|P2|P3> [--dry-run]   (issue may also be given as --issue <id>)");
  console.error("  node scripts/linear-ops.mjs due-date <id|identifier> --date <YYYY-MM-DD> [--clear] [--dry-run]");
  console.error("  node scripts/linear-ops.mjs create-child <parentId|parentIdentifier> --title <text> (--body <text> | --body-file <path>) [--type feat|bug|spike|tech] [--estimate <XS|S|M|L|XL>] [--label <l> ...] [--project <id|name>] [--milestone <id|name>] [--no-milestone] [--dry-run]");
}

// ---------------------------------------------------------------------------
// Subcommand: transition
// ---------------------------------------------------------------------------

async function handleTransition(identifier, args, dryRunCtx) {
  // --- Dry-run: fully offline ---
  if (dryRunCtx.dryRun) {
    const issue = resolveIssueFromFixture(dryRunCtx.fixture, identifier);
    if (!args.status) {
      console.error("Error: --status <name> is required for transition");
      process.exit(2);
    }
    console.log(`[dry-run:${dryRunCtx.squad}] would transition ${issue.identifier} -> ${args.status}`);
    return;
  }

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

async function handleLabel(identifier, args, dryRunCtx) {
  // --- Dry-run: fully offline ---
  if (dryRunCtx.dryRun) {
    const issue = resolveIssueFromFixture(dryRunCtx.fixture, identifier);
    if (!args.add && !args.remove) {
      console.error("Error: --add or --remove is required for label");
      printUsage();
      process.exit(2);
    }
    const currentNames = (issue.labels?.nodes || []).map((l) => l.name).sort();
    const { valid, groupKeys } = loadLabelsConfig();

    // Validate --add names
    for (const name of args.add || []) {
      if (!valid.has(name)) {
        console.error(`Error: unknown label '${name}' (not in config/linear/labels.json)`);
        process.exit(1);
      }
      if (groupKeys.has(name)) {
        console.error(`Cannot add group label '${name}' (only leaf labels attach to issues)`);
        process.exit(1);
      }
    }

    // Validate --remove names
    for (const name of args.remove || []) {
      if (!valid.has(name)) {
        console.error(`Error: unknown label '${name}' (not in config/linear/labels.json)`);
        process.exit(1);
      }
      if (groupKeys.has(name)) {
        console.error(`Cannot remove group label '${name}' (group labels are never attached to issues)`);
        process.exit(1);
      }
    }

    // Compute planned set (by name)
    const planned = new Set(currentNames);
    for (const name of args.remove || []) planned.delete(name);
    for (const name of args.add || []) planned.add(name);
    const plannedNames = [...planned].sort();

    console.log(`[dry-run] would set labels: current=[${currentNames.join(", ")}] planned=[${plannedNames.join(", ")}]`);
    return;
  }

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

async function handleComment(identifier, args, dryRunCtx) {
  // --- Dry-run: fully offline ---
  if (dryRunCtx.dryRun) {
    const issue = resolveIssueFromFixture(dryRunCtx.fixture, identifier);

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

    // Egress screen (FOC-450): a dry-run echo lands in logs — screen it too.
    assertEgressClean(body, "comment body (--dry-run)");

    if (args.dedupTag) {
      const marker = `<!-- run:${args.dedupTag} -->`;
      body = `${marker}\n${body}`;
    }

    console.log(`[dry-run:${dryRunCtx.squad}] ${issue.identifier}: would post comment:`);
    console.log(body);
    return;
  }

  // Resolve body FIRST (before the network) so the egress screen can block
  // before any call — the dedup check below queries the API, and the mutation
  // would carry the body.
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

  // Egress screen (FOC-450): fail closed before any network call.
  assertEgressClean(body, "comment body");

  const { issue } = await resolveIssueWithTeam(identifier);

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
// Shared body resolution for comment-replace / update-description
// ---------------------------------------------------------------------------

/** Resolve --body / --body-file into a string, exiting on bad usage. */
function readBodyArg(args, cmdName) {
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
    console.error(`Error: --body <text> or --body-file <path> is required for ${cmdName}`);
    process.exit(2);
  }
  // Egress screen (FOC-450): one chokepoint covers comment-replace,
  // update-description and create-child bodies — all resolve through here.
  assertEgressClean(body, `${cmdName} body`);
  return body;
}

// ---------------------------------------------------------------------------
// Subcommand: comment-replace — update-in-place by dedup marker (create if absent)
// ---------------------------------------------------------------------------

async function handleCommentReplace(identifier, args, dryRunCtx) {
  if (!args.dedupTag) {
    console.error("Error: --dedup-tag <tag> is required for comment-replace");
    process.exit(2);
  }

  const marker = `<!-- run:${args.dedupTag} -->`;
  const body = `${marker}\n${readBodyArg(args, "comment-replace")}`;

  if (dryRunCtx.dryRun) {
    const issue = resolveIssueFromFixture(dryRunCtx.fixture, identifier);
    console.log(`[dry-run:${dryRunCtx.squad}] ${issue.identifier}: would replace comment (tag=${args.dedupTag}):`);
    console.log(body);
    return;
  }

  const { issue } = await resolveIssueWithTeam(identifier);

  if (args.dryRun) {
    console.log(`[dry-run] ${issue.identifier}: would replace comment (tag=${args.dedupTag}):`);
    console.log(body);
    return;
  }

  const commentData = await graphql(
    `query($id:String!){
      issue(id:$id){ comments(first:250){ nodes{ id body createdAt } } }
    }`,
    { id: issue.id },
  );
  const comments = commentData.issue?.comments?.nodes || [];
  if (comments.length === 250) {
    console.error(`[comment-replace] comment list capped at 250; marker older than that may be missed`);
  }

  const existing = comments.find((c) => c.body && c.body.trimStart().startsWith(marker));

  if (existing) {
    const result = await graphql(
      `mutation($id:String!,$input:CommentUpdateInput!){
        commentUpdate(id:$id,input:$input){ success comment{ id } }
      }`,
      { id: existing.id, input: { body } },
    );
    if (result.commentUpdate.success) {
      console.log(`${issue.identifier}: comment replaced (tag=${args.dedupTag}, id=${existing.id})`);
    } else {
      console.error(`Error: comment replace failed for ${issue.identifier}`);
      process.exit(1);
    }
  } else {
    const result = await graphql(
      `mutation($input:CommentCreateInput!){
        commentCreate(input:$input){ success comment{ id } }
      }`,
      { input: { issueId: issue.id, body } },
    );
    if (result.commentCreate.success) {
      console.log(`${issue.identifier}: comment posted (new, tag=${args.dedupTag}, id=${result.commentCreate.comment.id})`);
    } else {
      console.error(`Error: comment creation failed for ${issue.identifier}`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand: update-description — replace the issue description
// ---------------------------------------------------------------------------

async function handleUpdateDescription(identifier, args, dryRunCtx) {
  const body = readBodyArg(args, "update-description");

  if (dryRunCtx.dryRun) {
    const issue = resolveIssueFromFixture(dryRunCtx.fixture, identifier);
    console.log(`[dry-run:${dryRunCtx.squad}] ${issue.identifier}: would update description (${body.length} chars)`);
    return;
  }

  const { issue } = await resolveIssueWithTeam(identifier);

  if (args.dryRun) {
    console.log(`[dry-run] ${issue.identifier}: would update description (${body.length} chars):`);
    console.log(body);
    return;
  }

  const result = await graphql(
    `mutation($id:String!,$input:IssueUpdateInput!){
      issueUpdate(id:$id,input:$input){ success issue{ id identifier } }
    }`,
    { id: issue.id, input: { description: body } },
  );

  if (result.issueUpdate.success) {
    console.log(`${issue.identifier}: description updated (${body.length} chars)`);
  } else {
    console.error(`Error: description update failed for ${issue.identifier}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: estimate
// ---------------------------------------------------------------------------

async function handleEstimate(identifier, args, dryRunCtx) {
  // --- Dry-run: fully offline ---
  if (dryRunCtx.dryRun) {
    const issue = resolveIssueFromFixture(dryRunCtx.fixture, identifier);
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
    console.log(`[dry-run:${dryRunCtx.squad}] would set estimate ${upper} (${value}) on ${issue.identifier}`);
    return;
  }

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
// Subcommand: priority  (FOC-606)
// ---------------------------------------------------------------------------

/**
 * Set the Linear priority field. Mirrors `estimate` exactly — same flag style,
 * same failure mode, same output envelope — plus one extra JSON line echoing
 * the value that was actually WRITTEN (read back from the update result, not
 * from the request), which FOC-606's AC 1 asks for and which is the same
 * non-destructive addition `create-child` already makes after its human line.
 *
 * EXIT CODE — the issue disagrees with itself. AC 2 says an unknown value is
 * "refused with exit 1"; the fix proposal says "exactly as `estimate` refuses
 * an unknown `--estimate`" and AC 3 says "same failure mode". `estimate` exits
 * 2 for a usage error and so does every other usage error in this file, so
 * `priority` exits 2 as well: one consistent convention across the verb beats
 * one literal number in an AC that contradicts another AC. AC 2's other half —
 * no write happens, and the error names the accepted values — is honoured.
 * Flipping this to exit 1 is a one-line change.
 *
 * The issue may be named positionally (as every verb here does) or as
 * `--issue <id>`, which is how FOC-606's fix proposal spells it. Only this
 * verb accepts the flag.
 */
async function handlePriority(identifier, args, dryRunCtx) {
  // Validate FIRST, before anything else: an unknown value is refused with no
  // write — and with no read either. `estimate` resolves the issue before it
  // validates; `priority` deliberately does not, because fail-closed here is
  // narrower and safer and costs nothing a caller can observe. It also means
  // the refusal is testable without a network round trip.
  if (!args.priority) {
    console.error("Error: --priority <P0|P1|P2|P3> is required for priority");
    process.exit(2);
  }

  const upper = String(args.priority).toUpperCase();
  const value = PRIORITY_MAP[upper];
  if (value === undefined) {
    console.error(`Error: invalid priority "${args.priority}". Valid: ${Object.keys(PRIORITY_MAP).join(", ")}`);
    process.exit(2);
  }

  // --- Dry-run: fully offline ---
  if (dryRunCtx.dryRun) {
    const issue = resolveIssueFromFixture(dryRunCtx.fixture, identifier);
    console.log(`[dry-run:${dryRunCtx.squad}] would set priority ${upper} (${value}) on ${issue.identifier}`);
    return;
  }

  const { issue } = await resolveIssueWithTeam(identifier);

  if (args.dryRun) {
    console.log(`[dry-run] ${issue.identifier}: priority → ${upper} (${value})`);
    return;
  }

  const result = await graphql(
    `mutation($id:String!,$input:IssueUpdateInput!){
      issueUpdate(id:$id,input:$input){ success issue{ id identifier priority } }
    }`,
    { id: issue.id, input: { priority: value } },
  );

  if (result.issueUpdate.success) {
    const updated = result.issueUpdate.issue;
    console.log(`${issue.identifier}: priority → ${upper} (${updated.priority})`);
    // AC 1: machine-readable echo of what was WRITTEN, read back from the
    // update result — not of what was requested.
    console.log(JSON.stringify({
      identifier: issue.identifier,
      requested: upper,
      written: updated.priority,
    }));
  } else {
    console.error(`Error: priority update failed for ${issue.identifier}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: due-date — set or clear the issue dueDate
// ---------------------------------------------------------------------------

const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handleDueDate(identifier, args, dryRunCtx) {
  const hasDate = typeof args.date === "string" && args.date.length > 0;
  if (!hasDate && !args.clear) {
    console.error("Error: --date <YYYY-MM-DD> is required for due-date (or --clear to remove it)");
    process.exit(2);
  }
  if (hasDate && args.clear) {
    console.error("Error: --date and --clear are mutually exclusive");
    process.exit(2);
  }
  if (hasDate && !DUE_DATE_RE.test(args.date)) {
    console.error(`Error: invalid date "${args.date}" — expected YYYY-MM-DD`);
    process.exit(2);
  }
  const input = args.clear ? { dueDate: null } : { dueDate: args.date };
  const shown = args.clear ? "(cleared)" : args.date;

  if (dryRunCtx.dryRun) {
    const issue = resolveIssueFromFixture(dryRunCtx.fixture, identifier);
    console.log(`[dry-run:${dryRunCtx.squad}] would set dueDate ${shown} on ${issue.identifier}`);
    return;
  }

  const { issue } = await resolveIssueWithTeam(identifier);

  if (args.dryRun) {
    console.log(`[dry-run] ${issue.identifier}: dueDate → ${shown}`);
    return;
  }

  const result = await graphql(
    `mutation($id:String!,$input:IssueUpdateInput!){
      issueUpdate(id:$id,input:$input){ success issue{ id identifier dueDate } }
    }`,
    { id: issue.id, input },
  );

  if (result.issueUpdate.success) {
    const updated = result.issueUpdate.issue;
    console.log(`${issue.identifier}: dueDate → ${updated.dueDate ?? "(cleared)"}`);
  } else {
    console.error(`Error: dueDate update failed for ${issue.identifier}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Placement (project + milestone) — FOC-716
// ---------------------------------------------------------------------------

/** A raw UUID, so a flag can be an id or a name without a second flag. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * FOC-716: "walks up the parent chain to the epic (max depth 4)".
 * Counted in NODES, parent included — the smaller cap is the safer error: a
 * missed ancestor fails closed (exit 1, no write), a wrong distant one writes
 * misplaced data silently.
 */
const MAX_PARENT_CHAIN_NODES = 4;

const ISSUE_CHAIN_NODE_QUERY = `
  query($id:String!){
    issue(id:$id){
      id identifier
      parent { id identifier }
      project { id name }
      projectMilestone { id name }
    }
  }
`;

/**
 * Collect the inherited project + milestone from a parent chain, FOC-716.
 *
 * A child inherits from its parent; when the parent carries no project the walk
 * continues up to the epic and takes the first node that has one. The milestone
 * travels WITH that project: a projectMilestone belongs to exactly one project,
 * so pairing them is the only combination that can be written without producing
 * either an orphan or a cross-project mismatch.
 *
 * Exported and pure so `scripts/linear-ops.test.mjs` can pin it against a
 * recorded response instead of the live API.
 *
 * @param {{id?:string, identifier?:string,
 *          project?:{id:string, name?:string}|null,
 *          projectMilestone?:{id:string, name?:string}|null}[]} chain
 *        Parent chain, nearest ancestor first (parent at index 0).
 * @returns {{project:{id:string,name:string}|null,
 *            milestone:{id:string,name:string}|null,
 *            from:string|null}} `from` names the node the values came from.
 */
export function collectInheritance(chain) {
  for (const node of chain || []) {
    if (node?.project?.id) {
      return {
        project: { id: node.project.id, name: node.project.name ?? null },
        milestone: node.projectMilestone?.id
          ? { id: node.projectMilestone.id, name: node.projectMilestone.name ?? null }
          : null,
        from: node.identifier || node.id || null,
      };
    }
  }
  return { project: null, milestone: null, from: null };
}

/**
 * Apply the explicit flags on top of what the chain supplied, FOC-716.
 *
 * Precedence: `--project` / `--milestone` override inheritance, `--no-milestone`
 * clears it (maintenance children under an epic that has no milestone). An
 * explicit `--project` drops an inherited milestone rather than pairing two
 * values that belong to different projects — `droppedMilestone` reports it so
 * the caller can say so out loud instead of losing it silently.
 *
 * Exported and pure; the id/name resolution stays in the handler.
 *
 * @param {{project:{id:string,name:string}|null, milestone:{id:string,name:string}|null}} inherited
 * @param {{project?:{id:string,name:string}|null, milestone?:{id:string,name:string}|null,
 *          noMilestone?:boolean}} [flags] already-resolved override values.
 * @returns {{project:{id:string,name:string}|null,
 *            milestone:{id:string,name:string}|null,
 *            droppedMilestone:{id:string,name:string}|null}}
 */
export function applyPlacementOverrides(inherited, flags = {}) {
  let project = inherited?.project ?? null;
  let milestone = inherited?.milestone ?? null;
  let droppedMilestone = null;

  if (flags.project) {
    if (milestone) {
      droppedMilestone = milestone;
      milestone = null;
    }
    project = flags.project;
  }
  if (flags.noMilestone) {
    if (milestone) droppedMilestone = milestone;
    milestone = null;
  }
  if (flags.milestone) milestone = flags.milestone;

  return { project, milestone, droppedMilestone };
}

/**
 * Walk the parent chain, nearest ancestor first, capped at `maxNodes`.
 *
 * `fetchNode` is injected so `scripts/linear-ops.test.mjs` can pin the depth cap
 * and the cycle guard offline. The `seen` set is defensive: a parent cycle must
 * not hang the CLI.
 *
 * @param {string} startId
 * @param {(id:string) => Promise<object|null>} fetchNode
 * @param {number} [maxNodes]
 * @returns {Promise<object[]>} chain nodes, nearest first.
 */
export async function walkParentChain(startId, fetchNode, maxNodes = MAX_PARENT_CHAIN_NODES) {
  const chain = [];
  const seen = new Set();
  let currentId = startId;
  while (currentId && chain.length < maxNodes && !seen.has(currentId)) {
    seen.add(currentId);
    const node = await fetchNode(currentId);
    if (!node) break;
    chain.push(node);
    currentId = node.parent?.id || null;
  }
  return chain;
}

/** Live fetcher for walkParentChain. */
async function fetchParentChain(startId) {
  return walkParentChain(startId, async (id) => {
    const data = await graphql(ISSUE_CHAIN_NODE_QUERY, { id });
    return data?.issue || null;
  });
}

/** Resolve `--project` to {id,name}, by UUID or by case-insensitive team name. */
async function resolveProjectFlag(teamId, value) {
  const data = await graphql(
    `query($teamId:String!){ team(id:$teamId){ projects(first:100){ nodes{ id name } } } }`,
    { teamId },
  );
  const projects = data.team?.projects?.nodes || [];
  const byId = UUID_RE.test(value);
  const hit = byId
    ? projects.find((p) => p.id === value)
    : projects.find((p) => (p.name || "").trim().toLowerCase() === value.trim().toLowerCase());
  if (!hit) {
    const available = projects.map((p) => `"${p.name}"`).join(", ");
    console.error(
      `Error: project ${byId ? "id" : "name"} "${value}" not found in team. Available: ${available || "(none)"}`,
    );
    process.exit(1);
  }
  return { id: hit.id, name: hit.name ?? null };
}

/** Resolve `--milestone` to {id,name} inside `project`, by UUID or by name. */
async function resolveMilestoneFlag(project, value) {
  const data = await graphql(
    `query($id:String!){ project(id:$id){ projectMilestones(first:100){ nodes{ id name } } } }`,
    { id: project.id },
  );
  const nodes = data.project?.projectMilestones?.nodes || [];
  const byId = UUID_RE.test(value);
  const hit = byId
    ? nodes.find((m) => m.id === value)
    : nodes.find((m) => (m.name || "").trim().toLowerCase() === value.trim().toLowerCase());
  if (!hit) {
    const available = nodes.map((m) => `"${m.name}"`).join(", ");
    console.error(
      `Error: milestone ${byId ? "id" : "name"} "${value}" not found in project "${project.name}". Available: ${available || "(none)"}`,
    );
    process.exit(1);
  }
  return { id: hit.id, name: hit.name ?? null };
}

// ---------------------------------------------------------------------------
// Subcommand: create-child — real Linear sub-issue under an EXISTING issue
// ---------------------------------------------------------------------------

async function handleCreateChild(identifier, args, dryRunCtx) {
  if (dryRunCtx.dryRun) {
    console.error(`[dry-run:${dryRunCtx.squad}] create-child has no fixture path — run without a *_DRY_RUN env to preview with --dry-run`);
    process.exit(2);
  }

  if (!args.title) {
    console.error("Error: --title <text> is required for create-child");
    process.exit(2);
  }
  if (args.milestone && args.noMilestone) {
    console.error("Error: --milestone and --no-milestone are mutually exclusive");
    process.exit(2);
  }
  // Egress screen (FOC-450): the title is outbound text too.
  assertEgressClean(args.title, "create-child title");
  const body = readBodyArg(args, "create-child");

  const { issue: parent, teamId } = await resolveIssueWithTeam(identifier);

  // Placement (FOC-716): inherit project + milestone from the parent chain,
  // then let the flags override. Fail closed BEFORE any write.
  const inherited = collectInheritance(await fetchParentChain(parent.id));
  const flagProject = args.project ? await resolveProjectFlag(teamId, args.project) : null;
  const placement = applyPlacementOverrides(inherited, {
    project: flagProject,
    noMilestone: args.noMilestone,
    milestone: null, // resolved below — it needs the FINAL project to look in
  });
  if (args.milestone) {
    if (!placement.project) {
      console.error("Error: --milestone needs a project — pass --project, or inherit one from the parent chain");
      process.exit(2);
    }
    placement.milestone = await resolveMilestoneFlag(placement.project, args.milestone);
    placement.droppedMilestone = null;
  }
  if (!placement.project) {
    console.error(
      `Error: no project for the new child — none on the parent chain of ${parent.identifier} ` +
        `(walked ${MAX_PARENT_CHAIN_NODES} nodes) and no --project. Refusing to create an orphan (FOC-716).`,
    );
    process.exit(1);
  }
  if (placement.droppedMilestone) {
    console.error(
      `Note: inherited milestone "${placement.droppedMilestone.name}" was dropped — a projectMilestone ` +
        `belongs to one project, and this child is being placed in "${placement.project.name}". ` +
        `Pass --milestone to set one.`,
    );
  }

  // Team labels — same G:C (group:child) resolution as `label` (handleLabel).
  const teamData = await graphql(
    `query($teamId:String!){
      team(id:$teamId){
        states(first:50){ nodes{ id name type } }
        labels(first:200){ nodes{ id name isGroup parent{ id name } } }
      }
    }`,
    { teamId },
  );
  const allLabels = teamData.team?.labels?.nodes || [];
  const labelByName = new Map(allLabels.map((l) => [l.name, l]));
  const groupById = new Map();
  for (const lbl of allLabels) if (lbl.isGroup) groupById.set(lbl.id, lbl.name);
  const childByNameInGroup = new Map();
  for (const lbl of allLabels) {
    if (!lbl.isGroup && lbl.parent?.id) {
      const parentName = groupById.get(lbl.parent.id) || lbl.parent.name;
      if (parentName) childByNameInGroup.set(`${parentName}::${lbl.name}`, lbl);
    }
  }
  function resolveLabelId(name) {
    const exact = labelByName.get(name);
    if (exact) return exact;
    const colonIdx = name.indexOf(":");
    if (colonIdx > 0) {
      const found = childByNameInGroup.get(`${name.slice(0, colonIdx)}::${name.slice(colonIdx + 1)}`);
      if (found) return found;
    }
    throw new Error(`Label not found in team: ${name}`);
  }

  const labelNames = [...(args.label || [])];
  if (args.type) {
    const normalized = TYPE_ALIAS[args.type] || args.type;
    labelNames.push(`type:${normalized}`);
  }
  const labelIds = [];
  for (const name of labelNames) {
    const lbl = resolveLabelId(name);
    if (lbl.isGroup) {
      console.error(`Cannot add group label '${name}' (only leaf labels attach to issues)`);
      process.exit(1);
    }
    labelIds.push(lbl.id);
  }

  const states = teamData.team?.states?.nodes || [];
  const defaultState =
    states.find((s) => s.name === "Backlog") ||
    states.find((s) => s.type === "backlog") ||
    states.find((s) => s.name === "Todo") ||
    states.find((s) => s.type === "unstarted") ||
    states[0];
  if (!defaultState) {
    console.error("No workflow states found for team");
    process.exit(1);
  }

  let estimateValue;
  if (args.estimate) {
    const upper = args.estimate.toUpperCase();
    estimateValue = ESTIMATE_MAP[upper];
    if (estimateValue === undefined) {
      console.error(`Error: invalid estimate "${args.estimate}". Valid: ${Object.keys(ESTIMATE_MAP).join(", ")}`);
      process.exit(2);
    }
  }

  const input = {
    teamId,
    parentId: parent.id,
    title: args.title,
    description: body,
    stateId: defaultState.id,
    projectId: placement.project.id,
    ...(placement.milestone ? { projectMilestoneId: placement.milestone.id } : {}),
    ...(labelIds.length > 0 ? { labelIds } : {}),
    ...(estimateValue !== undefined ? { estimate: estimateValue } : {}),
  };

  if (args.dryRun) {
    console.log(`[dry-run] would create child of ${parent.identifier} ("${parent.title}")`);
    console.log(`  title: ${args.title}`);
    console.log(`  stateId: ${defaultState.id} ("${defaultState.name}")`);
    console.log(`  labels: ${labelNames.join(", ") || "(none)"}`);
    console.log(`  estimate: ${args.estimate || "(none)"}`);
    console.log(`  project: ${placement.project.name} (${placement.project.id})`);
    console.log(`  milestone: ${placement.milestone ? `${placement.milestone.name} (${placement.milestone.id})` : "(none)"}`);
    console.log(`  inherited from: ${inherited.from || "(none)"}`);
    return;
  }

  const result = await graphql(ISSUE_CREATE_MUTATION, { input });
  if (result.issueCreate.success) {
    const issue = result.issueCreate.issue;
    console.log(`✅ ${issue.identifier} (child of ${parent.identifier}) ${issue.url}`);
    // FOC-716: machine-readable echo of what was WRITTEN, read back from the
    // create result — not of what was intended.
    console.log(JSON.stringify({
      identifier: issue.identifier,
      url: issue.url,
      parent: parent.identifier,
      project: issue.project ? { id: issue.project.id, name: issue.project.name } : null,
      milestone: issue.projectMilestone
        ? { id: issue.projectMilestone.id, name: issue.projectMilestone.name }
        : null,
    }));
  } else {
    console.error("Error: issue creation failed");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  loadEnv();

  const dryRunCtx = dryRunContext();

  const args = parseArgs(process.argv);
  const cmd = args._[0];
  // FOC-606: `priority` accepts the issue positionally (like every verb here,
  // `estimate` included) or as `--issue <id>`, which is how its fix proposal
  // spells it. Contained to this one verb — the shared guard below and every
  // other verb's shape are untouched.
  const identifier = args._[1] || (cmd === "priority" ? args.issue : undefined);

  // Env DRY_RUN forces no-write regardless of --dry-run flag (mechanical safety)
  if (dryRunCtx.dryRun) {
    args.dryRun = true;
    console.error(`[dry-run:${dryRunCtx.squad}] using fixture .state/mock/${dryRunCtx.squad}-task.json (env forces offline + no-write)`);
  }

  if (!cmd || !identifier) {
    printUsage();
    process.exit(2);
  }

  switch (cmd) {
    case "transition":
      await handleTransition(identifier, args, dryRunCtx);
      break;
    case "label":
      await handleLabel(identifier, args, dryRunCtx);
      break;
    case "comment":
      await handleComment(identifier, args, dryRunCtx);
      break;
    case "comment-replace":
      await handleCommentReplace(identifier, args, dryRunCtx);
      break;
    case "update-description":
      await handleUpdateDescription(identifier, args, dryRunCtx);
      break;
    case "estimate":
      await handleEstimate(identifier, args, dryRunCtx);
      break;
    case "priority":
      await handlePriority(identifier, args, dryRunCtx);
      break;
    case "due-date":
      await handleDueDate(identifier, args, dryRunCtx);
      break;
    case "create-child":
      await handleCreateChild(identifier, args, dryRunCtx);
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
