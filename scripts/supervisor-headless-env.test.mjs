// scripts/supervisor-headless-env.test.mjs — FOC-1066: the Supervisor pane's
// claude must start headless-clean, so the `supervisor-run` entrypoint branch
// exports DISABLE_AUTOUPDATER=1 for it. The image's npm prefix is read-only by
// design (the CLI is pinned by the Dockerfile), so the auto-updater can only
// print its "no write permission" status-line banner — which blocks unattended
// runs. Scoped like operator-warning-suppression.test.mjs: the assertion reads
// docker/entrypoint.sh and pins the export INSIDE the `supervisor-run` case,
// with a negative check that no other branch (and no global export) picked it
// up.
//
// Run: node scripts/supervisor-headless-env.test.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const fail = (msg) => {
  throw new Error(msg);
};

const text = readFileSync(join(ROOT, "docker", "entrypoint.sh"), "utf8");

// The `supervisor-run` case runs from its label to the next case label
// (`repo-add`). Both markers are indented four spaces at the top level of the
// case statement — an exact, stable frame for the slice.
const START = "    supervisor-run)";
const END = "    repo-add)";
const start = text.indexOf(START);
const end = text.indexOf(END);
if (start === -1 || end === -1 || end < start) {
  fail(`cannot locate the supervisor-run case in docker/entrypoint.sh (${START} / ${END})`);
}
const supervisorRun = text.slice(start, end);

console.log("\nsupervisor headless env (docker/entrypoint.sh)");

test("the supervisor-run branch exports DISABLE_AUTOUPDATER=1", () => {
  if (!/^        export DISABLE_AUTOUPDATER=1$/m.test(supervisorRun)) {
    fail("docker/entrypoint.sh: the supervisor-run branch does not export DISABLE_AUTOUPDATER=1");
  }
});

test("the export stays scoped to the supervisor-run branch", () => {
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (/DISABLE_AUTOUPDATER/.test(before)) {
    fail("docker/entrypoint.sh: DISABLE_AUTOUPDATER appears before the supervisor-run case (global or another branch)");
  }
  if (/DISABLE_AUTOUPDATER/.test(after)) {
    fail("docker/entrypoint.sh: DISABLE_AUTOUPDATER appears after the supervisor-run case (another branch)");
  }
});

test("the export carries the FOC-1066 rationale comment", () => {
  if (!supervisorRun.includes("FOC-1066")) {
    fail("docker/entrypoint.sh: the DISABLE_AUTOUPDATER export has no FOC-1066 comment above it");
  }
});

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`\nOK: ${passed} checks passed`);
