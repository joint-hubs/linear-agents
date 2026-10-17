#!/usr/bin/env node
// scripts/linear-ops.test.mjs — FOC-716: placement inheritance for create-child.
//
// `create-child` used to write neither `projectId` nor `projectMilestoneId`, so
// 44 Fenix children landed with no planning context and Linear's milestone
// progress was wrong. These tests pin the two pure pieces of the fix — the
// parent-chain walk and the flag precedence — against RECORDED response shapes
// (`.state/reviews/2026-09-23-fenix-linear-snapshot.json`), never the live API.
//
// Run: node scripts/linear-ops.test.mjs

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import {
  collectInheritance,
  applyPlacementOverrides,
  walkParentChain,
} from "./linear-ops.mjs";

const OPS = path.join(path.dirname(fileURLToPath(import.meta.url)), "linear-ops.mjs");

// ---------------------------------------------------------------------------
// Task-ownership fixtures (FOC-848) — every CLI run below pins
// LA_TASK_OWNERSHIP_CONFIG to a temp file, so a developer's restricted
// .fenix/config/settings.json can never leak into these runs.
// ---------------------------------------------------------------------------

const TMP_OWNERSHIP = mkdtempSync(path.join(tmpdir(), "linear-ops-own-"));
const OWNERSHIP_PATH = path.join(TMP_OWNERSHIP, "ownership.json");

// The restricted config the gate tests run against: Fenix → orchestrator, JW →
// supervisor, everything unlisted held ("ask"). The acting owner is pinned per
// run (supervisor by default), never read from the ambient env.
const OWNERSHIP_CFG = {
  version: 1,
  owners: {
    orchestrator: { linearProjects: ["Fenix — wydanie 1.0 i kontrola kosztów"] },
    supervisor: { linearProjects: ["proj-jw-id"] },
  },
  unlisted: "ask",
};
writeFileSync(OWNERSHIP_PATH, JSON.stringify(OWNERSHIP_CFG, null, 2), "utf8");

// A temp copy of the SHIPPED config (owners:{} → unrestricted) for the tests
// that must keep today's behaviour byte for byte.
const SHIPPED_PATH = path.join(TMP_OWNERSHIP, "shipped-ownership.json");
copyFileSync(path.join(path.dirname(OPS), "..", "config", "task-ownership.json"), SHIPPED_PATH);

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Fixtures — shapes copied from the recorded response, ids shortened but the
// nesting is the live one: Issue { project, projectMilestone, parent }.
// ---------------------------------------------------------------------------

const EPIC = {
  id: "epic-1",
  identifier: "FOC-714",
  parent: null,
  project: { id: "proj-fenix", name: "FENIX" },
  projectMilestone: { id: "ms-m7", name: "M7 Release discipline and living docs" },
};
const EPIC_CHILD = {
  id: "child-1",
  identifier: "FOC-716",
  parent: { id: "epic-1", identifier: "FOC-714" },
  project: null,
  projectMilestone: null,
};
const GRANDCHILD_PARENT = {
  id: "grandchild-1",
  identifier: "FOC-999",
  parent: { id: "child-1", identifier: "FOC-716" },
  project: null,
  projectMilestone: null,
};

// ---------------------------------------------------------------------------
// collectInheritance — the pair comes from the first ancestor with a project
// ---------------------------------------------------------------------------

console.log("collectInheritance");

{
  const got = collectInheritance([EPIC_CHILD, EPIC]);
  check(
    "grandchild gets the EPIC's project and milestone",
    got.project?.id === "proj-fenix" && got.milestone?.id === "ms-m7" && got.from === "FOC-714",
    JSON.stringify(got),
  );
}

{
  const got = collectInheritance([EPIC]);
  check(
    "parent with a project supplies its own pair, walk stops",
    got.project?.id === "proj-fenix" && got.milestone?.id === "ms-m7" && got.from === "FOC-714",
    JSON.stringify(got),
  );
}

{
  const orphanMilestone = {
    id: "x",
    identifier: "FOC-888",
    parent: { id: "epic-1", identifier: "FOC-714" },
    project: null,
    projectMilestone: { id: "ms-m5", name: "M5" },
  };
  const got = collectInheritance([orphanMilestone, EPIC]);
  check(
    "an ancestor with a milestone but no project is skipped (no cross-project pair)",
    got.project?.id === "proj-fenix" && got.milestone?.id === "ms-m7",
    JSON.stringify(got),
  );
}

{
  const noMilestone = { ...EPIC, projectMilestone: null };
  const got = collectInheritance([noMilestone]);
  check(
    "project without a milestone yields milestone:null, not a phantom",
    got.project?.id === "proj-fenix" && got.milestone === null,
    JSON.stringify(got),
  );
}

{
  const got = collectInheritance([]);
  check("empty chain yields nulls and from:null", got.project === null && got.milestone === null && got.from === null, JSON.stringify(got));
}

{
  const got = collectInheritance([GRANDCHILD_PARENT, EPIC_CHILD, EPIC]);
  check(
    "three-deep chain reaches the epic",
    got.project?.id === "proj-fenix" && got.from === "FOC-714",
    JSON.stringify(got),
  );
}

// ---------------------------------------------------------------------------
// walkParentChain — depth cap and cycle guard (fetchNode injected)
// ---------------------------------------------------------------------------

console.log("walkParentChain");

{
  // A 10-deep chain of childless-shaped nodes; only the cap limits the walk.
  const deep = async (nid) => {
    const n = Number(nid.slice(1));
    if (n > 10) return null;
    return { id: nid, identifier: `X-${n}`, parent: { id: `n${n + 1}` }, project: null, projectMilestone: null };
  };
  const chain = await walkParentChain("n1", deep);
  check("depth cap stops at 4 nodes (FOC-716: max depth 4)", chain.length === 4, `got ${chain.length}`);
  check("walk is nearest-ancestor-first", chain[0].identifier === "X-1" && chain[3].identifier === "X-4", chain.map((c) => c.identifier).join(","));
}

{
  // n1 -> n2 -> n1 … a cycle must terminate, not hang.
  const cyclic = async (nid) => ({
    id: nid,
    identifier: nid,
    parent: { id: nid === "n1" ? "n2" : "n1" },
    project: null,
    projectMilestone: null,
  });
  const chain = await walkParentChain("n1", cyclic);
  check("a parent cycle terminates without hanging", chain.length === 2, `got ${chain.length}`);
}

{
  const chain = await walkParentChain("n1", async () => null);
  check("a missing node ends the walk with an empty chain", chain.length === 0, `got ${chain.length}`);
}

// ---------------------------------------------------------------------------
// applyPlacementOverrides — flag precedence
// ---------------------------------------------------------------------------

console.log("applyPlacementOverrides");

const INHERITED = { project: { id: "proj-a", name: "A" }, milestone: { id: "ms-1", name: "M1" }, from: "FOC-1" };

{
  const got = applyPlacementOverrides(INHERITED, {});
  check("no flags → inheritance untouched", eq(got, { project: INHERITED.project, milestone: INHERITED.milestone, droppedMilestone: null }), JSON.stringify(got));
}

{
  const got = applyPlacementOverrides(INHERITED, { project: { id: "proj-b", name: "B" } });
  check(
    "--project drops the inherited milestone (one project per milestone) and reports it",
    got.project?.id === "proj-b" && got.milestone === null && got.droppedMilestone?.id === "ms-1",
    JSON.stringify(got),
  );
}

{
  const got = applyPlacementOverrides(INHERITED, { noMilestone: true });
  check(
    "--no-milestone keeps the project and clears the milestone",
    got.project?.id === "proj-a" && got.milestone === null && got.droppedMilestone?.id === "ms-1",
    JSON.stringify(got),
  );
}

{
  const got = applyPlacementOverrides(INHERITED, {
    project: { id: "proj-b", name: "B" },
    milestone: { id: "ms-9", name: "M9" },
  });
  check(
    "explicit --milestone wins after a --project override",
    got.project?.id === "proj-b" && got.milestone?.id === "ms-9",
    JSON.stringify(got),
  );
}

{
  const got = applyPlacementOverrides({ project: null, milestone: null, from: null }, {});
  check(
    "nothing anywhere → project:null (the fail-closed trigger)",
    got.project === null && got.milestone === null,
    JSON.stringify(got),
  );
}

{
  const got = applyPlacementOverrides(INHERITED, { noMilestone: true, milestone: { id: "ms-2", name: "M2" } });
  check(
    "an explicit --milestone overrides --no-milestone",
    got.milestone?.id === "ms-2",
    JSON.stringify(got),
  );
}

// ---------------------------------------------------------------------------
// handlePriority — FOC-606. The refusals run through the real CLI: `priority`
// validates before it resolves, so these exit before any network access and
// write nothing. The success path is NOT covered here — it needs a live Linear
// write and is exercised by the verb's own dry-run and by TEST.
// ---------------------------------------------------------------------------

console.log("priority verb (FOC-606)");

{
  const run = (argv) => spawnSync(process.execPath, [OPS, "priority", ...argv], {
    encoding: "utf8",
    env: { ...process.env, LA_TASK_OWNERSHIP_CONFIG: SHIPPED_PATH, LA_TASK_OWNER: "supervisor" },
  });

  const unknown = run(["FOC-1", "--priority", "P9"]);
  check("unknown --priority is refused before any write (exit 2)", unknown.status === 2, `exit ${unknown.status}`);
  check("the refusal names the accepted values", /Valid: P0, P1, P2, P3/.test(unknown.stderr), unknown.stderr.trim());
  check("nothing was written — stdout is empty", unknown.stdout.trim() === "", JSON.stringify(unknown.stdout));

  const missing = run(["FOC-1"]);
  check("missing --priority is refused (exit 2)", missing.status === 2, `exit ${missing.status}`);
  check("the missing-flag message names the flag shape", /--priority <P0\|P1\|P2\|P3> is required/.test(missing.stderr), missing.stderr.trim());

  const noIssue = run(["--priority", "P3"]);
  check("no issue identifier is refused (exit 2)", noIssue.status === 2, `exit ${noIssue.status}`);
  check("the no-identifier refusal prints usage", /Usage:/.test(noIssue.stderr), noIssue.stderr.trim());

  // `--issue` is the alias FOC-606's fix proposal spells. Hitting the
  // "Valid:" text proves the alias reached handlePriority and not the shared
  // usage guard, which is what makes the alias real rather than declared.
  const alias = run(["--issue", "FOC-1", "--priority", "nope"]);
  check("--issue reaches the priority verb", alias.status === 2 && /Valid: P0, P1, P2, P3/.test(alias.stderr), `exit ${alias.status}: ${alias.stderr.trim()}`);

  const lower = run(["FOC-1", "--priority", "p9"]);
  check("--priority is case-insensitive (still refused here, same message)", /Valid: P0, P1, P2, P3/.test(lower.stderr), lower.stderr.trim());
}

// ---------------------------------------------------------------------------
// Ownership gate (FOC-848) — the CLI runs against an in-child fetch stub, no
// network. The stub is written to a temp .mjs child by every run: it answers
// Linear's GraphQL with canned payloads (recorded response shapes, per FOC-716
// above) and logs every operation it saw to a JSON file on exit, which is how
// "the mock saw NO mutation" is proven rather than assumed.
// ---------------------------------------------------------------------------

console.log("ownership gate (FOC-848)");

const mockChildScript = String.raw`// Generated by scripts/linear-ops.test.mjs — never committed by hand.
import { writeFileSync } from "node:fs";

const CANNED = __CANNED_JSON__;
const LOG_PATH = __LOG_PATH__;

const calls = [];
globalThis.fetch = async (_url, opts) => {
  const body = JSON.parse(opts.body);
  const text = body.query || "";
  const kind = /^\s*mutation/.test(text) ? "mutation" : "query";
  calls.push({ kind });
  let data = {};
  if (kind === "mutation") {
    if (/issueUpdate/.test(text)) data = { issueUpdate: { success: true, issue: { id: CANNED.id, identifier: CANNED.identifier, state: { name: "Done" } } } };
    else if (/commentCreate/.test(text)) data = { commentCreate: { success: true, comment: { id: "comment-1" } } };
  } else if (/searchIssues/.test(text)) {
    data = { searchIssues: { nodes: [CANNED] } };
  } else if (/teams\s*\{/.test(text)) {
    data = { teams: { nodes: [{ id: "team-1", name: "FEN", key: "FEN" }] } };
  } else if (/states\(first/.test(text)) {
    data = { team: { states: { nodes: [{ id: "st-done", name: "Done", type: "completed" }] } } };
  } else if (/comments\(first/.test(text)) {
    data = { issue: { comments: { nodes: [] } } };
  } else if (/issue\(id:/.test(text)) {
    data = { issue: CANNED };
  }
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ data }) };
};

// process.exit mid-verb must not lose the log: 'exit' listeners run sync.
process.on("exit", () => {
  writeFileSync(LOG_PATH, JSON.stringify(calls), "utf8");
});

// The argv rewrite is what flips linear-ops.mjs's main() guard: real CLI
// invocation, stubbed transport.
process.argv = [process.execPath, __OPS_PATH__, ...process.argv.slice(2)];
await import(__OPS_URL__);
`;

let mockN = 0;
function spawnMocked(argv, { issue, env: extraEnv = {} } = {}) {
  mockN++;
  const logPath = path.join(TMP_OWNERSHIP, `calls-${mockN}.json`);
  const child = path.join(TMP_OWNERSHIP, "mock-fetch-child.mjs");
  writeFileSync(
    child,
    mockChildScript
      .replace("__CANNED_JSON__", JSON.stringify(issue))
      .replace("__LOG_PATH__", JSON.stringify(logPath))
      .replaceAll("__OPS_PATH__", JSON.stringify(OPS))
      .replace("__OPS_URL__", JSON.stringify(pathToFileURL(OPS).href)),
    "utf8",
  );
  let calls;
  const run = spawnSync(process.execPath, [child, ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      LINEAR_API_KEY: "mock-key",
      LA_TASK_OWNERSHIP_CONFIG: OWNERSHIP_PATH,
      LA_TASK_OWNER: "supervisor",
      ...extraEnv,
    },
  });
  try {
    calls = JSON.parse(readFileSync(logPath, "utf8"));
  } catch {
    calls = [];
  }
  return { run, calls };
}

const mutationsIn = (calls) => calls.filter((c) => c.kind === "mutation").length;
const jsonOut = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};
// The override result rides stdout NEXT TO the verb's normal human line, so
// the JSON has to be found per line, not parsed off the whole stdout.
const jsonLineOut = (r) =>
  (r.stdout || "")
    .split(/(?:\r?\n)+/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find(Boolean);

const FENIX_PROJECT = { id: "proj-fenix-id", name: "Fenix — wydanie 1.0 i kontrola kosztów" };
const fenixIssue = (project) => ({
  id: "issue-fenix-1",
  identifier: "FEN-1",
  title: "ownership probe",
  url: "https://linear.app/x/issue/FEN-1",
  state: { id: "s1", name: "In Progress", type: "started" },
  project,
});

// A foreign ticket: refused, and the mock saw NO mutation — both verbs.
{
  const { run, calls } = spawnMocked(["transition", "FEN-1", "--status", "Done"], {
    issue: fenixIssue(FENIX_PROJECT),
  });
  check("foreign transition exits 1", run.status === 1, `exit ${run.status}: ${run.stdout} ${run.stderr}`);
  check("the refusal carries code ownership-foreign", (jsonOut(run) || {}).code === "ownership-foreign", run.stdout.trim());
  check("the refusal names the verb", (jsonOut(run) || {}).verb === "transition", run.stdout.trim());
  check("the refusal names the owning actor", /owned by orchestrator/.test(run.stdout), run.stdout.trim());
  check("foreign transition sent NO mutation", mutationsIn(calls) === 0, `${mutationsIn(calls)} mutations`);
}
{
  const { run, calls } = spawnMocked(["comment", "FEN-1", "--body", "ownership probe"], {
    issue: fenixIssue(FENIX_PROJECT),
  });
  check("foreign comment exits 1", run.status === 1, `exit ${run.status}: ${run.stdout} ${run.stderr}`);
  check("comment refusal carries code ownership-foreign", (jsonOut(run) || {}).code === "ownership-foreign", run.stdout.trim());
  check("foreign comment sent NO mutation", mutationsIn(calls) === 0, `${mutationsIn(calls)} mutations`);
}

// --owner-override: the write goes through, visibly, in both channels.
{
  const { run, calls } = spawnMocked(["transition", "FEN-1", "--status", "Done", "--owner-override"], {
    issue: fenixIssue(FENIX_PROJECT),
  });
  check("override exits 0", run.status === 0, `exit ${run.status}: ${run.stdout} ${run.stderr}`);
  check("override prints ownershipOverride: true in the JSON", jsonLineOut(run)?.ownershipOverride === true, run.stdout.trim());
  check("override is announced on stderr", /\[linear-ops\] ownership override by supervisor on FEN-1/.test(run.stderr), run.stderr.trim());
  check("override sent the mutation", mutationsIn(calls) === 1, `${mutationsIn(calls)} mutations`);
}

// An owned ticket (JW under supervisor) behaves exactly as before the gate.
{
  const { run, calls } = spawnMocked(["transition", "FEN-1", "--status", "Done"], {
    issue: fenixIssue({ id: "proj-jw-id", name: "JW" }),
  });
  check("owned ticket exits 0", run.status === 0, `exit ${run.status}: ${run.stdout} ${run.stderr}`);
  check("owned ticket carries no ownership output", !/ownership/i.test(run.stdout), run.stdout.trim());
  check("owned ticket sent the mutation", mutationsIn(calls) === 1, `${mutationsIn(calls)} mutations`);
}

// An unlisted project under the "ask" policy is held.
{
  const { run, calls } = spawnMocked(["transition", "FEN-1", "--status", "Done"], {
    issue: fenixIssue({ id: "proj-wskm-id", name: "WSKM" }),
  });
  check("unlisted project exits 1", run.status === 1, `exit ${run.status}: ${run.stdout} ${run.stderr}`);
  check("the refusal carries code ownership-unlisted", (jsonOut(run) || {}).code === "ownership-unlisted", run.stdout.trim());
  check("unlisted sent NO mutation", mutationsIn(calls) === 0, `${mutationsIn(calls)} mutations`);
}

// Fail-closed plumbing: a broken config or a malformed acting owner is the
// single ownership-config code, never a silent fallback to the shipped default.
{
  const { run, calls } = spawnMocked(["transition", "FEN-1", "--status", "Done"], {
    issue: fenixIssue(FENIX_PROJECT),
    env: { LA_TASK_OWNERSHIP_CONFIG: path.join(TMP_OWNERSHIP, "does-not-exist.json") },
  });
  check("unreadable config exits 1 with ownership-config", run.status === 1 && (jsonOut(run) || {}).code === "ownership-config", `${run.status}: ${run.stdout}`);
  check("broken config sent NO mutation", mutationsIn(calls) === 0, `${mutationsIn(calls)} mutations`);
}
{
  const { run } = spawnMocked(["transition", "FEN-1", "--status", "Done"], {
    issue: fenixIssue(FENIX_PROJECT),
    env: { LA_TASK_OWNER: "Orchestrator!" },
  });
  check("malformed LA_TASK_OWNER fails closed with ownership-config", run.status === 1 && (jsonOut(run) || {}).code === "ownership-config", `${run.status}: ${run.stdout}`);
}

// Unrestricted install: the gate is invisible — no ownership JSON, write flows.
{
  const { run, calls } = spawnMocked(["transition", "FEN-1", "--status", "Done"], {
    issue: fenixIssue(FENIX_PROJECT),
    env: { LA_TASK_OWNERSHIP_CONFIG: SHIPPED_PATH },
  });
  check("unrestricted install passes unchanged", run.status === 0, `${run.status}: ${run.stdout} ${run.stderr}`);
  check("unrestricted install has no ownership output", !/ownership/i.test(run.stdout), run.stdout.trim());
  check("unrestricted install sent the mutation", mutationsIn(calls) === 1, `${mutationsIn(calls)} mutations`);
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
