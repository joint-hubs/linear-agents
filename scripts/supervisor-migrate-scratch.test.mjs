// scripts/supervisor-migrate-scratch.test.mjs — the FOC-903 migration at its
// CLI boundary: dry run writes nothing, --apply moves attributable entries and
// never lowers a counter, unattributable entries stay, the redirect map is
// written, and --sweep-fixtures removes only fixture-id dirs WITHOUT verdicts.
//
// Every case runs against its own temp --state-home; the real repo .state/ is
// never touched.
//
// Run: node scripts/supervisor-migrate-scratch.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT, harness, cleanupLater } from "./supervisor-test-fixtures.mjs";

const { test, summary } = harness();

const CLI = join(ROOT, "scripts", "supervisor-migrate-scratch.mjs");

const RUN1 = "2026-09-01T10-00-00-000-supervisor-ab12"; // older run
const RUN2 = "2026-09-02T10-00-00-000-supervisor-cd34"; // newer run

/** Build one complete migration fixture: two runs, a legacy counter, legacy round files, two sweepable fixture dirs and one with verdicts. */
function buildFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "migrate-scratch-"));
  cleanupLater(tmp);
  const stateHome = join(tmp, "supervisor");
  const run = (runId) => join(stateHome, runId);
  // Older run: triage names FOC-101, the registry names FOC-103; its counter
  // already says FOC-101 = 5 so the legacy 2 must never lower it.
  mkdirSync(join(run(RUN1), "scratch"), { recursive: true });
  writeFileSync(join(run(RUN1), "triage.json"), JSON.stringify({ issue: "FOC-101" }));
  writeFileSync(join(run(RUN1), "children.json"), JSON.stringify({ children: [{ taskId: "FOC-103", squad: "dev" }] }));
  writeFileSync(join(run(RUN1), "review-rounds.json"), JSON.stringify({ "FOC-101": 5 }));
  // Newer run: only the registry knows FOC-102.
  mkdirSync(run(RUN2), { recursive: true });
  writeFileSync(join(run(RUN2), "children.json"), JSON.stringify({ children: [{ taskId: "FOC-102" }] }));
  // Legacy inputs (stateHome's parent — the production shape).
  writeFileSync(
    join(tmp, "review-rounds.json"),
    JSON.stringify({ "FOC-101": 2, "FOC-102": 1, "FOC-103": 4, "FOC-999": 3, "BAD": "x" }),
  );
  mkdirSync(join(tmp, "reviews"), { recursive: true });
  for (const f of ["FOC-101-round1.md", "FOC-102-round2.md", "FOC-103-round1.md", "FOC-999-round1.md"]) {
    writeFileSync(join(tmp, "reviews", f), `# round file ${f}\n`);
  }
  // Sweep targets: three stale fixture dirs (removable — one with an
  // uppercase/underscore test-file stem) and one holding verdicts (kept).
  mkdirSync(join(stateHome, "test-123-456-789"), { recursive: true });
  mkdirSync(join(stateHome, "test-triage-abc"), { recursive: true });
  mkdirSync(join(stateHome, "test-State_Isolation-111-222-333"), { recursive: true });
  const verdicted = join(stateHome, "test-supervisor-migrate-scratch-999-888-777");
  mkdirSync(join(verdicted, "verdicts"), { recursive: true });
  writeFileSync(join(verdicted, "verdicts", "FOC-101-r1.json"), "{}");
  return { tmp, stateHome };
}

const runCli = (stateHome, ...flags) =>
  spawnSync(process.execPath, [CLI, "--state-home", stateHome, ...flags], { encoding: "utf8", cwd: ROOT });

const json = (r) => JSON.parse(r.stdout);

console.log("\ndry run (default)");

test("dry run reports the plan and writes nothing", () => {
  const { tmp, stateHome } = buildFixture();
  const r = runCli(stateHome, "--json");
  assert.equal(r.status, 0, r.stderr);
  const report = json(r);
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  // counter: 4 attributable (FOC-101/102/103 + never-lowered FOC-101), 2 kept
  assert.deepEqual(
    report.rounds.moved.map((m) => `${m.taskId}@${m.runId}`),
    [`FOC-101@${RUN1}`, `FOC-102@${RUN2}`, `FOC-103@${RUN1}`],
  );
  assert.deepEqual(report.rounds.kept.map((k) => k.taskId).sort(), ["BAD", "FOC-999"]);
  assert.deepEqual(report.reviews.moved.map((m) => m.file).sort(), [
    "FOC-101-round1.md", "FOC-102-round2.md", "FOC-103-round1.md",
  ]);
  assert.deepEqual(report.reviews.kept.map((k) => k.file), ["FOC-999-round1.md"]);
  // nothing written
  assert.equal(JSON.parse(readFileSync(join(tmp, "review-rounds.json"), "utf8"))["FOC-101"], 2, "legacy counter untouched");
  assert.equal(existsSync(join(stateHome, "scratch-redirects.json")), false, "no redirect map");
  assert.equal(existsSync(join(stateHome, RUN2, "review-rounds.json")), false, "no per-run counter written");
  assert.equal(existsSync(join(stateHome, RUN1, "scratch", "reviews", "FOC-101-round1.md")), false, "no round file moved");
});

test("dry run --sweep-fixtures lists, never deletes", () => {
  const { stateHome } = buildFixture();
  const report = json(runCli(stateHome, "--json", "--sweep-fixtures"));
  assert.deepEqual(report.fixtures.wouldRemove.sort(), [
    "test-123-456-789", "test-State_Isolation-111-222-333", "test-triage-abc",
  ]);
  assert.deepEqual(report.fixtures.kept, [{ dir: "test-supervisor-migrate-scratch-999-888-777", reason: "verdicts present" }]);
  assert.equal(existsSync(join(stateHome, "test-123-456-789")), true);
});

console.log("\napply");

test("apply moves attributable entries, never lowers a counter, writes the redirect map", () => {
  const { tmp, stateHome } = buildFixture();
  const r = runCli(stateHome, "--apply", "--json");
  assert.equal(r.status, 0, r.stderr);
  const report = json(r);
  assert.equal(report.dryRun, false);
  assert.equal(report.rounds.moved.length, 3);
  assert.equal(report.reviews.moved.length, 3);

  // Per-run counters: FOC-101 stayed 5 (never lowered), FOC-103 arrived, FOC-102 in the newer run.
  assert.deepEqual(JSON.parse(readFileSync(join(stateHome, RUN1, "review-rounds.json"), "utf8")), { "FOC-101": 5, "FOC-103": 4 });
  assert.deepEqual(JSON.parse(readFileSync(join(stateHome, RUN2, "review-rounds.json"), "utf8")), { "FOC-102": 1 });

  // Legacy counter keeps only the unattributable entries.
  assert.deepEqual(JSON.parse(readFileSync(join(tmp, "review-rounds.json"), "utf8")), { "FOC-999": 3, "BAD": "x" });

  // Round files moved into per-run scratch; the unattributable one stayed.
  assert.equal(existsSync(join(stateHome, RUN1, "scratch", "reviews", "FOC-101-round1.md")), true);
  assert.equal(existsSync(join(stateHome, RUN1, "scratch", "reviews", "FOC-103-round1.md")), true);
  assert.equal(existsSync(join(stateHome, RUN2, "scratch", "reviews", "FOC-102-round2.md")), true);
  assert.equal(existsSync(join(tmp, "reviews", "FOC-999-round1.md")), true);
  assert.equal(existsSync(join(tmp, "reviews", "FOC-101-round1.md")), false);

  // Redirect map written with both sections.
  const map = JSON.parse(readFileSync(join(stateHome, "scratch-redirects.json"), "utf8"));
  assert.deepEqual(
    map.rounds.map((e) => `${e.taskId}@${e.runId}`).sort(),
    [`FOC-101@${RUN1}`, `FOC-102@${RUN2}`, `FOC-103@${RUN1}`],
  );
  assert.equal(map.reviews.length, 3);
  assert.equal(typeof map.migratedAt, "string");
});

test("apply is idempotent — a second run moves nothing new", () => {
  const { stateHome } = buildFixture();
  assert.equal(runCli(stateHome, "--apply", "--json").status, 0);
  const report = json(runCli(stateHome, "--apply", "--json"));
  assert.deepEqual(report.rounds.moved, []);
  assert.deepEqual(report.reviews.moved, []);
});

test("apply --sweep-fixtures removes fixture dirs without verdicts, keeps the verdicted one", () => {
  const { stateHome } = buildFixture();
  const report = json(runCli(stateHome, "--apply", "--json", "--sweep-fixtures"));
  assert.deepEqual(report.fixtures.removed.sort(), [
    "test-123-456-789", "test-State_Isolation-111-222-333", "test-triage-abc",
  ]);
  assert.deepEqual(report.fixtures.kept, [{ dir: "test-supervisor-migrate-scratch-999-888-777", reason: "verdicts present" }]);
  assert.equal(existsSync(join(stateHome, "test-123-456-789")), false);
  assert.equal(existsSync(join(stateHome, "test-triage-abc")), false);
  assert.equal(existsSync(join(stateHome, "test-State_Isolation-111-222-333")), false);
  assert.equal(existsSync(join(stateHome, "test-supervisor-migrate-scratch-999-888-777", "verdicts", "FOC-101-r1.json")), true);
});

test("apply --sweep-fixtures on a state home with no legacy counter file creates none", () => {
  const { tmp, stateHome } = buildFixture();
  rmSync(join(tmp, "review-rounds.json"));
  const r = runCli(stateHome, "--apply", "--json", "--sweep-fixtures");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(tmp, "review-rounds.json")), false, "no legacy counter file conjured");
});

test("human output says DRY RUN by default and names nothing destructive", () => {
  const { stateHome } = buildFixture();
  const r = runCli(stateHome);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY RUN/);
});

console.log("\nbad input");

test("a missing state home reports ok with empty sections", () => {
  const tmp = mkdtempSync(join(tmpdir(), "migrate-scratch-empty-"));
  cleanupLater(tmp);
  const report = json(runCli(join(tmp, "nope"), "--json", "--sweep-fixtures"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.rounds.moved, []);
  assert.deepEqual(report.fixtures.wouldRemove, []);
});

summary();
