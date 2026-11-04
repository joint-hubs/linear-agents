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

// FOC-1238: the gate tarred the LIVE tree of a linked worktree, so a host
// writer racing the run could be caught mid-rewrite (FOC-1159 run 1: 216/218,
// two test names torn). The archive branch must come first — a tarball handed
// over by the host is exactly HEAD and immune to the race.
test("docker/test-in-container.sh extracts the host-archived candidate before touching /src (FOC-1238)", () => {
  const sh = readFileSync(join(HERE, "..", "docker", "test-in-container.sh"), "utf8");
  if (!sh.includes("FENIX_TEST_ARCHIVE")) fail("test-in-container.sh has no FENIX_TEST_ARCHIVE branch - the gate still snapshots the live tree");
  // Anchor on the CODE branch, not the bare variable name: the header comment
  // names FENIX_TEST_ARCHIVE too and sits above both branches, so an indexOf on
  // the name passes even with the branch moved after the probe (REVIEW round 1).
  const archive = sh.indexOf('tar -xf "$FENIX_TEST_ARCHIVE"');
  if (archive === -1) fail("the archive branch lost its extraction step");
  const probe = sh.indexOf("rev-parse");
  if (probe === -1 || probe < archive) {
    fail("the FENIX_TEST_ARCHIVE branch must come before the /src git probes - a host-archived candidate must win");
  }
  for (const token of ['git -C "$WORK" init -q', 'git -C "$WORK" add -A', 'git -C "$WORK" commit -qm']) {
    if (!sh.includes(token)) fail(`the archive branch lost a step: ${token}`);
  }
});

// The wrapper is the path TEST actually runs: it must produce the archive on
// the host and mount it read-only, and the racy direct form must be gone.
test("fenix test archives HEAD on the host and mounts it read-only (FOC-1238)", () => {
  const src = readFileSync(join(HERE, "..", "fenix"), "utf8");
  for (const token of ['git -C "$src" archive --format=tar', '-v "$archive:/src.tar:ro"', "FENIX_TEST_ARCHIVE=/src.tar"]) {
    if (!src.includes(token)) fail(`cmd_test does not hand the container the archived candidate: ${token}`);
  }
  if (/exec docker run --rm -v "\$src:\/src:ro" fenix:dev/.test(src)) {
    fail("the racy direct form is still in cmd_test - every gate run must carry the archive mount");
  }
});

// FOC-1074: the prove-isolation proof is a SECOND step of the container gate,
// driven by env — its own CI step sets FENIX_TEST_PROVE_ISOLATION=1 and that
// container then runs ONLY the one proof run (every parallel-lane file at
// once). Locally the env is never set, so the default gate is unchanged.
test("docker/test-in-container.sh runs the prove-isolation proof only behind FENIX_TEST_PROVE_ISOLATION (FOC-1074)", () => {
  const sh = readFileSync(join(HERE, "..", "docker", "test-in-container.sh"), "utf8");
  const gate = sh.indexOf('if [ -n "${FENIX_TEST_PROVE_ISOLATION:-}" ]; then');
  if (gate === -1) fail("test-in-container.sh has no FENIX_TEST_PROVE_ISOLATION branch - the proof lane can never be requested");
  const proof = sh.indexOf("test-all.mjs --prove-isolation");
  if (proof === -1 || proof < gate) fail("the proof run must sit inside the FENIX_TEST_PROVE_ISOLATION branch");
  // The proof container runs ONLY the proof: the default gate (lint,
  // state-index, the plain suite) must stay below the gate, in the branch
  // a local run without the env takes.
  for (const [what, token] of [["lint", "node scripts/lint.mjs"], ["state-index", "node scripts/state-index.mjs --check"], ["the plain suite", 'node scripts/test-all.mjs "$@"']]) {
    const at = sh.indexOf(token);
    if (at === -1) fail(`the default gate lost its ${what} step`);
    if (at < gate) fail(`the ${what} step must stay in the default branch - without the env a local run is unchanged`);
  }
});

// The proof has its own workflow step (FOC-1074): one --cpus=2 fenix:dev
// container per CI build. A step `env:` block sets the variable in the RUNNER
// shell — the container never sees it; the docker run line itself must carry
// the -e passthrough or CI silently runs the plain gate twice.
test("the linux workflow gives the prove-isolation proof its own --cpus=2 step (FOC-1074)", () => {
  const yml = readFileSync(join(HERE, "..", ".github", "workflows", "linux.yml"), "utf8");
  const line = yml.split("\n").find((l) => l.includes("docker run --rm --cpus=2"));
  if (!line) fail("the proof step lost its bounded container (docker run --rm --cpus=2)");
  if (!line.includes("-e FENIX_TEST_PROVE_ISOLATION=1")) {
    fail("the --cpus=2 docker run must pass FENIX_TEST_PROVE_ISOLATION into the container with -e — a step env: block stays in the runner shell and the proof never runs");
  }
});

console.log(`\n${passed}/7 passed.`);
if (failures.length > 0) {
  console.error(`${failures.length} test(s) failed.`);
  process.exit(1);
}
