// scripts/test-all.test.mjs — the runner's one env contract.
//
// test-all.mjs spawns every suite file with LA_SUPERVISOR* stripped from the
// child environment (FOC-295): the runner usually runs inside a supervised
// child, and supervisor-cleanup's FOC-167 identity guard refuses there. The
// guard is untouched — only what the runner passes to its own subprocesses.
//
// The proof is a poisoned spawn: the runner is started with the four variables
// supervisor-spawn.mjs sets on children, and the zz-suite-env-scrub probe (the
// only file the filter matches) asserts none of them arrived. Remove the scrub
// and this goes red — supervised or not.
//
// Run: node scripts/test-all.test.mjs

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "test-all.mjs");
const PROBE = "zz-suite-env-scrub";

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
const fail = (msg) => { throw new Error(msg); };

test("LA_SUPERVISOR* set on the runner does not reach the suite files it spawns", () => {
  const poisoned = {
    ...process.env,
    LA_SUPERVISOR: "1",
    LA_SUPERVISOR_CHILD: "dev-1",
    LA_SUPERVISOR_RUN: "2026-01-01T00-00-00-test",
    LA_SUPERVISOR_REPO: "C:/not/a/real/repo",
  };
  const result = spawnSync(process.execPath, [RUNNER, PROBE], {
    cwd: HERE,
    encoding: "utf8",
    env: poisoned,
  });
  if (result.status !== 0) {
    fail(`runner exit ${result.status}:\n${result.stdout || ""}${result.stderr || ""}`);
  }
  if (!result.stdout.includes(`${PROBE}.test.mjs`)) fail(`probe did not run:\n${result.stdout}`);
  if (!result.stdout.includes("1/1 passed")) fail(`probe did not pass:\n${result.stdout}`);
});

console.log(`\n${passed}/1 passed.`);
if (failures.length > 0) {
  console.error(`${failures.length} test(s) failed.`);
  process.exit(1);
}
