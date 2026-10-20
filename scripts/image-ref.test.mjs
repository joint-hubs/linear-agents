// scripts/image-ref.test.mjs — FOC-777: the pinned-image contract stays wired:
// VERSION pins a semver, compose reads FENIX_IMAGE_REF, the launcher pulls by
// default and builds with --source, the uid logic lives in one script used by
// both Dockerfiles.
//
// Run: node scripts/image-ref.test.mjs

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
const fail = (msg) => { throw new Error(msg); };
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ── 1. VERSION ────────────────────────────────────────────────────────────────
console.log("\nVERSION pin");

test("VERSION is one semver line", () => {
  const text = read("VERSION");
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length !== 1) fail(`expected exactly one non-empty line, got ${lines.length}`);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(lines[0].trim())) fail(`not a semver line: ${JSON.stringify(lines[0])}`);
});

// ── 2. compose ────────────────────────────────────────────────────────────────
console.log("\ncompose image pin");

test("compose.yaml x-fenix image comes from FENIX_IMAGE_REF with the source build as the default", () => {
  const text = read("compose.yaml");
  if (!text.includes("image: ${FENIX_IMAGE_REF:-fenix:dev}")) fail("missing image: ${FENIX_IMAGE_REF:-fenix:dev}");
  if (!/build:/.test(text)) fail("missing build: block");
  if (!text.includes("dockerfile: Dockerfile")) fail("missing dockerfile: Dockerfile in the build block");
});

// ── 3. launcher ───────────────────────────────────────────────────────────────
console.log("\nlauncher pull/build");

test("fenix launcher: pull by default, --source and FENIX_SOURCE build from the clone, no direct compose build in up/update", () => {
  const text = read("fenix");
  for (const needle of [
    'IMAGE_REPO="ghcr.io/joint-hubs/fenix"',
    "image_ref()",
    "ensure_image()",
    "needs_uid_layer()",
    "--source",
    "FENIX_SOURCE",
    "docker/Dockerfile.uid",
  ]) {
    if (!text.includes(needle)) fail(`missing: ${needle}`);
  }
  if (/^\s*docker compose up -d --build\s*$/m.test(text)) fail("bare 'docker compose up -d --build' line is back in the launcher");
  if (/^\s*docker compose build --pull\s*$/m.test(text)) fail("bare 'docker compose build --pull' line is back in the launcher");
});

// ── 4. uid logic ──────────────────────────────────────────────────────────────
console.log("\nuid logic in one script");

test("the uid logic lives only in docker/set-uid.sh, run by both Dockerfiles", () => {
  const dockerfile = read("Dockerfile");
  if (!dockerfile.includes("COPY docker/set-uid.sh /usr/local/sbin/fenix-set-uid")) fail("Dockerfile does not COPY docker/set-uid.sh");
  if (!dockerfile.includes("RUN sh /usr/local/sbin/fenix-set-uid")) fail("Dockerfile does not RUN fenix-set-uid");
  // Comments still name usermod/groupadd when explaining WHY passwd is
  // installed and how groupadd behaves (FOC-802/803 rationale) — the contract
  // is that no uid logic COMMAND remains, so check non-comment text only.
  const dockerfileCode = dockerfile
    .split("\n")
    .map((l) => l.replace(/#.*/, ""))
    .join("\n");
  for (const banned of ["usermod", "useradd", "groupmod", "groupadd"]) {
    if (dockerfileCode.includes(banned)) fail(`Dockerfile contains ${banned} outside a comment — uid logic must live in docker/set-uid.sh`);
  }
  const uidDockerfile = read("docker/Dockerfile.uid");
  if (!/^ARG BASE=.*$/m.test(uidDockerfile)) fail("docker/Dockerfile.uid is missing the ARG BASE= line");
  if (!/^FROM \$\{BASE\}/m.test(uidDockerfile)) fail("docker/Dockerfile.uid does not start FROM ${BASE}");
  if (!uidDockerfile.includes("fenix-set-uid")) fail("docker/Dockerfile.uid does not run fenix-set-uid");
  if (!/^\s*USER node\s*$/m.test(uidDockerfile.slice(uidDockerfile.lastIndexOf("USER node")))) fail("docker/Dockerfile.uid does not end with USER node");
  const setUid = read("docker/set-uid.sh");
  if (!setUid.includes("usermod -o -u")) fail("docker/set-uid.sh is missing 'usermod -o -u'");
  if (!setUid.includes("fenix-child")) fail("docker/set-uid.sh is missing 'fenix-child'");
});

// ── summary ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`\nOK: ${passed} checks passed`);
