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
import { readFileSync } from "node:fs";
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

// FOC-990: a child running the suite inside the Fenix container inherits the
// runtime path/state env (the image points it at /data). The runner strips the
// shared list so it is as hermetic as docker/test-in-container.sh.
test("the runtime path/state env (test-runtime-env.json) does not reach the suite files either", () => {
  const { unset } = JSON.parse(readFileSync(join(HERE, "test-runtime-env.json"), "utf8"));
  if (!unset.includes("LA_STATE_ROOT") || !unset.includes("LA_DATA_HOME")) fail(`list lost a core entry: ${unset}`);
  const poisoned = { ...process.env };
  for (const key of unset) poisoned[key] = "/data/poisoned";
  const result = spawnSync(process.execPath, [RUNNER, PROBE], { cwd: HERE, encoding: "utf8", env: poisoned });
  if (result.status !== 0) {
    fail(`runner exit ${result.status}:\n${result.stdout || ""}${result.stderr || ""}`);
  }
  if (!result.stdout.includes("1/1 passed")) fail(`probe did not pass:\n${result.stdout}`);
});

test("docker/test-in-container.sh reads the shared list instead of carrying its own copy", () => {
  const sh = readFileSync(join(HERE, "..", "docker", "test-in-container.sh"), "utf8");
  if (!sh.includes("test-runtime-env.json")) fail("test-in-container.sh does not read scripts/test-runtime-env.json");
  if (/^\s*unset\s+LA_/m.test(sh)) fail("test-in-container.sh unsets LA_* by name again - the two lists will drift");
});

console.log(`\n${passed}/3 passed.`);
if (failures.length > 0) {
  console.error(`${failures.length} test(s) failed.`);
  process.exit(1);
}
