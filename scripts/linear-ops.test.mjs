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

import {
  collectInheritance,
  applyPlacementOverrides,
  walkParentChain,
} from "./linear-ops.mjs";

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

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
