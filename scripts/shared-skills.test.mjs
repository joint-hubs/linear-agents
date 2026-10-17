#!/usr/bin/env node
// scripts/shared-skills.test.mjs — the vendored skills' drift catch.
//
// Pure unit tests over temp roots: no git, no network — with ONE read-only
// case against the real repo tree, pinning the tracked Supervisor copies to
// the shared source of truth so they never drift. One CLI spawn covers the
// usage-error path (argument parsing lives behind the isMain guard).

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkSharedSkills, syncSharedSkills, DEFAULT_ROOT } from "./shared-skills.mjs";

let passed = 0;
const failures = [];
const cleanup = [];

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

function base(name) {
  const dir = join(tmpdir(), `la-shared-skills-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
}

// A temp root shaped like the repo's agents/ dir: one shared skill and its
// tracked Supervisor copy, with per-test overrides applied on top.
function fixtureRoot(dir, { shared = "vendored\n", copy = "vendored\n", extra = false, missingCopy = false, secondSkill = true } = {}) {
  const sharedDir = join(dir, "_shared", "skills", "grilling");
  const copyDir = join(dir, "supervisor", "skills", "grilling");
  mkdirSync(sharedDir, { recursive: true });
  if (!missingCopy) mkdirSync(copyDir, { recursive: true });
  writeFileSync(join(sharedDir, "SKILL.md"), shared);
  writeFileSync(join(sharedDir, "LICENSE"), "mit\n");
  if (!missingCopy) {
    writeFileSync(join(copyDir, "SKILL.md"), copy);
    writeFileSync(join(copyDir, "LICENSE"), "mit\n");
  }
  if (extra) writeFileSync(join(copyDir, "NOTES.md"), "only here\n");
  if (secondSkill) {
    mkdirSync(join(dir, "_shared", "skills", "grill-me"), { recursive: true });
    writeFileSync(join(dir, "_shared", "skills", "grill-me", "SKILL.md"), "grill-me\n");
    mkdirSync(join(dir, "supervisor", "skills", "grill-me"), { recursive: true });
    writeFileSync(join(dir, "supervisor", "skills", "grill-me", "SKILL.md"), "grill-me\n");
  }
  return { sharedDir, copyDir };
}

console.log("\ncheck over a temp root");

test("in-sync copies pass with empty lists", () => {
  const dir = base("ok");
  fixtureRoot(dir);
  const report = checkSharedSkills(dir);
  if (!report.ok) fail(`reported drift: ${JSON.stringify(report)}`);
  if (report.skills.length !== 2) fail(`expected 2 skills, got ${JSON.stringify(report.skills.map((s) => s.name))}`);
});

test("missing, differs and extra are each reported and fail the check", () => {
  const dir = base("drift");
  fixtureRoot(dir, { shared: "changed\n", extra: true });
  // One more skill whose Supervisor copy is missing entirely.
  mkdirSync(join(dir, "_shared", "skills", "absent"), { recursive: true });
  writeFileSync(join(dir, "_shared", "skills", "absent", "SKILL.md"), "x\n");

  const report = checkSharedSkills(dir);
  if (report.ok) fail("drift was not reported");

  const grilling = report.skills.find((s) => s.name === "grilling");
  if (!grilling) fail(`grilling missing from the report: ${JSON.stringify(report.skills)}`);
  if (JSON.stringify(grilling.differs) !== JSON.stringify(["SKILL.md"])) fail(`differs: ${JSON.stringify(grilling)}`);
  if (JSON.stringify(grilling.extra) !== JSON.stringify(["NOTES.md"])) fail(`extra: ${JSON.stringify(grilling)}`);
  if (grilling.missing.length) fail(`unexpected missing: ${JSON.stringify(grilling.missing)}`);

  const absent = report.skills.find((s) => s.name === "absent");
  if (JSON.stringify(absent.missing) !== JSON.stringify(["SKILL.md"])) fail(`missing: ${JSON.stringify(absent)}`);
});

console.log("\nsync over a temp root");

test("sync fixes missing and differs, overwrites nothing it should keep, never deletes", () => {
  const dir = base("sync");
  fixtureRoot(dir, { shared: "changed\n", extra: true });

  const written = syncSharedSkills(dir);
  if (!written.includes("grilling/SKILL.md")) fail(`sync did not write the changed file: ${JSON.stringify(written)}`);
  if (written.includes("grilling/NOTES.md")) fail("sync wrote an extra-only file");

  if (readFileSync(join(dir, "supervisor", "skills", "grilling", "SKILL.md"), "utf8") !== "changed\n") fail("the differs file was not overwritten from _shared");
  if (readFileSync(join(dir, "supervisor", "skills", "grilling", "NOTES.md"), "utf8") !== "only here\n") fail("sync deleted an extra file");
  // The extra file keeps `check` red by design — but missing/differs must be gone.
  const grilling = checkSharedSkills(dir).skills.find((s) => s.name === "grilling");
  if (grilling.differs.length || grilling.missing.length) fail(`sync left drift: ${JSON.stringify(grilling)}`);

  // A wholly missing skill dir is created by sync.
  const created = base("sync-create");
  fixtureRoot(created, { missingCopy: true });
  syncSharedSkills(created);
  if (readFileSync(join(created, "supervisor", "skills", "grilling", "SKILL.md"), "utf8") !== "vendored\n") {
    fail("sync did not create a missing skill dir");
  }
});

test("sync on a root without _shared is a no-op", () => {
  const dir = base("no-shared");
  const written = syncSharedSkills(dir);
  if (written.length) fail(`a root without _shared wrote files: ${JSON.stringify(written)}`);
});

console.log("\nthe CLI");

const SCRIPT = fileURLToPath(new URL("./shared-skills.mjs", import.meta.url));
function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

test('runCli(["check", "--root"]) — a valued flag without its value is a usage error', () => {
  const res = runCli(["check", "--root"]);
  if (res.status !== 2) fail(`exit status ${res.status}, expected 2 (stderr: ${res.stderr})`);
  if (!/usage:/.test(res.stderr)) fail(`no usage on stderr: ${JSON.stringify(res.stderr)}`);
});

console.log("\nthe real repo tree");

test("the tracked Supervisor copies match _shared (the drift catch)", () => {
  const report = checkSharedSkills(DEFAULT_ROOT);
  if (!report.ok) {
    const lines = report.skills
      .flatMap((s) => ["missing", "differs", "extra"].flatMap((k) => s[k].map((f) => `${k} ${s.name}/${f}`)))
      .join("; ");
    fail(`the repo's vendored copies drifted: ${lines} — run node scripts/shared-skills.mjs sync`);
  }
  // The vendored pair this tree tracks must be present — the set may grow
  // (codegraph-expert is already there), so only their presence is pinned.
  const names = report.skills.map((s) => s.name);
  for (const wanted of ["grilling", "grill-me"]) {
    if (!names.includes(wanted)) fail(`the vendored skill ${wanted} is missing from _shared: ${JSON.stringify(names)}`);
  }
});

// ── summary ──────────────────────────────────────────────────────────────────
for (const dir of cleanup) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(" | ")}`);
  process.exitCode = 1;
}
