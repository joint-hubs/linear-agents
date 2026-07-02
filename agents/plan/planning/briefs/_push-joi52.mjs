#!/usr/bin/env node
// One-off idempotent push: 8 subtasks as CHILDREN of JOI-52 (team JOI).
// - state Todo, label dor-ok (auto-create), estimate embedded in description
//   (team estimation = notUsed), real "blocked by" relations.
// - idempotency: match existing children by "_External-ID: <extId>_" footer.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const LA_ROOT = join(__dir, "..", "..", "..", "..");

function loadEnv() {
  try {
    const t = readFileSync(join(LA_ROOT, ".env"), "utf8");
    for (const l of t.split("\n")) {
      const s = l.trim();
      if (!s || s.startsWith("#")) continue;
      const e = s.indexOf("=");
      if (e < 0) continue;
      const k = s.slice(0, e).trim();
      if (!process.env[k]) process.env[k] = s.slice(e + 1).trim();
    }
  } catch {}
}
loadEnv();

const KEY = process.env.LINEAR_API_KEY;
const ENDPOINT = "https://api.linear.app/graphql";
const DRY = process.argv.includes("--dry-run");

const TEAM_ID = "8f25d296-e923-456a-a3b4-51a1f8a88896"; // JOI
const PARENT_ID = "39556e14-4e47-4d37-ab1a-542b891bc4b9"; // JOI-52
const PROJECT_ID = "c52220ca-2a68-45fa-84e3-467f2ae129bc"; // personal
const TODO_STATE = "387843ef-0b53-4c4e-8685-fcb3db7d1c10";

async function gql(query, variables) {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: KEY },
    body: JSON.stringify({ query, variables }),
  });
  const b = await r.json();
  if (b.errors?.length) throw new Error(JSON.stringify(b.errors[0]));
  return b.data;
}

function extFooter(extId) {
  return `_External-ID: ${extId}_`;
}

function buildDesc(st) {
  const p = [];
  p.push(`> Parent: JOI-52 "Home Finances" — kontekst i PRD: \`home/docs/PRD-panel-analityczny.md\``);
  p.push(`> Estimate: **${st.estimate}** (t-shirt) · slice: \`${st.slice}\``);
  p.push("");
  if (st.ac?.length) {
    p.push("## Acceptance Criteria");
    for (const ac of st.ac) {
      p.push(`- **Given** ${ac.given}`);
      p.push(`  **When** ${ac.when}`);
      p.push(`  **Then** ${ac.then}`);
    }
    p.push("");
  }
  if (st.dod?.length) {
    p.push("## Definition of Done");
    for (const d of st.dod) p.push(`- ${d}`);
    p.push("");
  }
  if (st.blockedBy?.length) {
    p.push(`> Blocked by: ${st.blockedBy.join(", ")}`);
    p.push("");
  }
  p.push("---");
  p.push(extFooter(st.externalId));
  return p.join("\n");
}

async function ensureLabel(name) {
  const d = await gql(
    `query($id:String!){ team(id:$id){ labels(first:200){ nodes{ id name } } } }`,
    { id: TEAM_ID },
  );
  const found = (d.team?.labels?.nodes || []).find((l) => l.name === name);
  if (found) return found.id;
  if (DRY) {
    console.log(`  [dry] would create label "${name}"`);
    return null;
  }
  const c = await gql(
    `mutation($input:IssueLabelCreateInput!){ issueLabelCreate(input:$input){ success issueLabel{ id name } } }`,
    { input: { teamId: TEAM_ID, name } },
  );
  const id = c.issueLabelCreate?.issueLabel?.id;
  console.log(`  ✅ created label "${name}" (${id})`);
  return id;
}

async function fetchChildren() {
  const d = await gql(
    `query($id:String!){ issue(id:$id){ children(first:100){ nodes{ id identifier title description } } } }`,
    { id: PARENT_ID },
  );
  return d.issue?.children?.nodes || [];
}

function findExisting(children, extId) {
  const marker = extFooter(extId);
  return children.find((c) => (c.description || "").includes(marker)) || null;
}

async function main() {
  if (!KEY) { console.error("LINEAR_API_KEY not set"); process.exit(2); }
  const brief = JSON.parse(readFileSync(join(__dir, ".draft.plan-joi-52.json"), "utf8"));
  const subtasks = brief.subtasks;

  console.log(`Mode: ${DRY ? "DRY-RUN" : "LIVE"} — ${subtasks.length} subtasks → children of JOI-52`);

  const dorOk = await ensureLabel("dor-ok");
  const aiPlanned = await ensureLabel("ai:planned");
  const labelIds = [dorOk, aiPlanned].filter(Boolean);

  let children = await fetchChildren();
  const idByExt = {}; // externalId -> issue id

  // Pass 1: create/skip issues
  for (const st of subtasks) {
    const existing = findExisting(children, st.externalId);
    if (existing) {
      idByExt[st.externalId] = existing.id;
      console.log(`  ⏭️  skip ${st.externalId} -> ${existing.identifier} (exists)`);
      continue;
    }
    if (DRY) {
      console.log(`  [dry] would create "${st.title}" (${st.externalId}) est=${st.estimate} blockedBy=[${(st.blockedBy||[]).join(",")}]`);
      idByExt[st.externalId] = `DRY:${st.externalId}`;
      continue;
    }
    const input = {
      teamId: TEAM_ID,
      parentId: PARENT_ID,
      projectId: PROJECT_ID,
      stateId: TODO_STATE,
      title: st.title,
      description: buildDesc(st),
      labelIds,
    };
    const d = await gql(
      `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier url } } }`,
      { input },
    );
    const iss = d.issueCreate?.issue;
    idByExt[st.externalId] = iss.id;
    console.log(`  ✅ ${st.externalId} -> ${iss.identifier} ${iss.url}`);
  }

  // Refresh children for relation idempotency
  if (!DRY) children = await fetchChildren();

  // Pass 2: blocked-by relations. "S1 blocks S2" => issueId=S1, relatedIssueId=S2, type=blocks
  // Existing relations check
  async function existingRelations(issueId) {
    const d = await gql(
      `query($id:String!){ issue(id:$id){ relations(first:50){ nodes{ type relatedIssue{ id } } } } }`,
      { id: issueId },
    );
    return d.issue?.relations?.nodes || [];
  }

  for (const st of subtasks) {
    for (const dep of st.blockedBy || []) {
      const blockerId = idByExt[dep];
      const selfId = idByExt[st.externalId];
      if (!blockerId || !selfId) { console.log(`  ⚠️  missing id for relation ${dep} -> ${st.externalId}`); continue; }
      if (DRY) {
        console.log(`  [dry] would relate: ${dep} blocks ${st.externalId}`);
        continue;
      }
      const rels = await existingRelations(blockerId);
      const dup = rels.some((r) => r.type === "blocks" && r.relatedIssue?.id === selfId);
      if (dup) { console.log(`  ⏭️  relation exists: ${dep} blocks ${st.externalId}`); continue; }
      await gql(
        `mutation($input:IssueRelationCreateInput!){ issueRelationCreate(input:$input){ success } }`,
        { input: { issueId: blockerId, relatedIssueId: selfId, type: "blocks" } },
      );
      console.log(`  🔗 ${dep} blocks ${st.externalId}`);
    }
  }

  console.log(DRY ? "\n=== DRY-RUN complete ===" : "\n✅ Push complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
