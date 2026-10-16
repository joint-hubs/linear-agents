// scripts/supervisor-migrate-scratch.mjs — migrate legacy scratch into per-run
// scratch dirs (FOC-903), and sweep stale fixture run dirs (FOC-602).
//
// Before FOC-903 the review-round counter lived in the single global
// `<repo>/.state/review-rounds.json`, review round files in
// `<repo>/.state/reviews/<taskId>-round<N>.md`, and `fixtureRun()` test dirs
// piled up in the REAL `.state/supervisor/`. After FOC-903 a supervised run
// owns `<runDir>/review-rounds.json` and `<runDir>/scratch/reviews/`; readers
// take the union (per-run wins), so legacy leftovers keep being read — but the
// migration moves them where the contract now points, one task at a time:
//
//   1. Every task in the legacy counter and every legacy round file is
//      attributed to the NEWEST run dir (state home, run-id shape) that names
//      the task — via `triage.json.issue`, else any `children.json` child
//      taskId. Unattributable entries STAY in the legacy locations and are
//      listed.
//   2. Counter entries merge into `<runDir>/review-rounds.json` (never lower
//      an existing counter); round files move into `<runDir>/scratch/reviews/`
//      (a colliding target is never overwritten).
//   3. The redirect map `<stateHome>/scratch-redirects.json` records what went
//      where (kept one release, per the plan).
//   4. `--sweep-fixtures` lists (dry run) or removes (`--apply`) state-home
//      dirs whose name matches the fixture-run-id shapes
//      (`test-<pid>-<ts>-<n>`, `test-<testfile>-<pid>-<ts>-<n>`,
//      `test-triage-*`) and that hold NO `verdicts/` dir with files — a dir
//      with verdicts is real evidence and is only listed as kept.
//
// DRY RUN IS THE DEFAULT — nothing is written or removed without `--apply`.
//
// Usage:
//   node scripts/supervisor-migrate-scratch.mjs [--apply] [--state-home <dir>]
//        [--sweep-fixtures] [--json]
//
// ESM, zero runtime deps (Node 18+).

import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { atomicWriteJSON, RUN_ID_RE, supervisorStateHome } from "./utils.mjs";

// The legacy inputs sit next to the state home: `<repo>/.state/supervisor` →
// `<repo>/.state` — and a temp fixture `--state-home` works the same way.
const legacyRootOf = (stateHome) => dirname(stateHome);

// Fixture run-id shapes (FOC-602): the pre-FOC-903 `test-<pid>-<ts>-<n>` and the
// `test-<testfile>-<pid>-<ts>-<n>` shape, plus the `test-triage-*` dirs the
// triage tests left behind. The testfile stem is `[A-Za-z0-9_-]+` — test file
// names carry uppercase and underscores. Anchored — a real run id can never match.
const FIXTURE_DIR_RE = /^(?:test-(?:\d+|[A-Za-z0-9_-]+-\d+)-\d+-\d+|test-triage-.+)$/;

/** taskId the run claims, or null: triage.json.issue (string or {identifier|id}), else any children.json child. */
function taskIdsOfRun(rDir) {
  const ids = new Set();
  const add = (v) => {
    if (typeof v === "string" && v) ids.add(v);
  };
  try {
    const triage = JSON.parse(readFileSync(join(rDir, "triage.json"), "utf8"));
    const issue = triage?.issue;
    if (typeof issue === "string") add(issue);
    else if (issue && typeof issue === "object") add(issue.identifier ?? issue.id);
  } catch {
    // no triage.json / corrupt — the registry fallback still applies
  }
  try {
    const parsed = JSON.parse(readFileSync(join(rDir, "children.json"), "utf8"));
    const kids = parsed && typeof parsed === "object" && parsed.children && typeof parsed.children === "object"
      ? Object.values(parsed.children)
      : Array.isArray(parsed) ? parsed : [];
    for (const c of kids) add(c?.taskId);
  } catch {
    // no registry — triage already had its chance
  }
  return ids;
}

/** Run dirs under stateHome matching the run-id shape, NEWEST first. */
function runDirsNewestFirst(stateHome) {
  if (!existsSync(stateHome)) return [];
  return readdirSync(stateHome, { withFileTypes: true })
    .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** Read a per-run counter file — absent or corrupt reads as {}. */
function readCounter(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** A finite, non-negative counter value, else null (unmigratable). */
function counterValue(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Read the redirect map (absent or corrupt reads as an empty one). */
function readRedirectMap(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Run the migration. Exported for the test suite; the CLI is a thin wrapper.
 * Pure planning in dry-run mode — `apply: false` touches nothing.
 *
 * @returns report `{ ok, dryRun, stateHome, rounds: { moved, kept },
 *   reviews: { moved, kept }, fixtures: { removed|wouldRemove, kept },
 *   redirectMap }` — moved/kept are arrays naming what went where.
 */
export function migrateScratch({ stateHome = supervisorStateHome(), apply = false, sweepFixtures = false, now = new Date().toISOString() } = {}) {
  const legacyRoot = legacyRootOf(stateHome);
  const legacyRoundsPath = join(legacyRoot, "review-rounds.json");
  const legacyReviewsDir = join(legacyRoot, "reviews");
  const redirectsPath = join(stateHome, "scratch-redirects.json");

  const runs = runDirsNewestFirst(stateHome);
  // taskId -> newest run dir naming it (runs are newest first, first claim wins)
  const owner = new Map();
  for (const runId of runs) {
    for (const taskId of taskIdsOfRun(join(stateHome, runId))) {
      if (!owner.has(taskId)) owner.set(taskId, runId);
    }
  }

  // ── 1. counter entries ─────────────────────────────────────────────────────
  const legacyCounter = readCounter(legacyRoundsPath);
  const roundsMoved = [];
  const roundsKept = [];
  const roundsRedirects = [];
  const perRunCounters = new Map(); // runId -> store to merge
  for (const [taskId, value] of Object.entries(legacyCounter)) {
    const runId = owner.get(taskId);
    const round = counterValue(value);
    if (!runId || round == null) {
      roundsKept.push({ taskId, reason: runId ? "non-numeric-counter" : "no-attributable-run" });
      continue;
    }
    if (!perRunCounters.has(runId)) perRunCounters.set(runId, readCounter(join(stateHome, runId, "review-rounds.json")));
    const store = perRunCounters.get(runId);
    const existing = counterValue(store[taskId]) ?? 0;
    store[taskId] = Math.max(existing, round); // never lower a counter
    roundsMoved.push({ taskId, round, runId });
    roundsRedirects.push({ taskId, runId });
  }

  // ── 2. round files ─────────────────────────────────────────────────────────
  const reviewsMoved = [];
  const reviewsKept = [];
  const reviewsRedirects = [];
  const legacyReviewFiles = existsSync(legacyReviewsDir)
    ? readdirSync(legacyReviewsDir).filter((f) => /^(.+)-round(\d+)\.md$/.test(f))
    : [];
  for (const file of legacyReviewFiles) {
    const taskId = file.match(/^(.+)-round(\d+)\.md$/)[1];
    const runId = owner.get(taskId);
    if (!runId) {
      reviewsKept.push({ file, reason: "no-attributable-run" });
      continue;
    }
    const targetDir = join(stateHome, runId, "scratch", "reviews");
    const target = join(targetDir, file);
    if (existsSync(target)) {
      reviewsKept.push({ file, reason: `target-exists:${runId}` });
      continue;
    }
    reviewsMoved.push({ file, runId });
    reviewsRedirects.push({ file, runId });
    if (apply) {
      mkdirSync(targetDir, { recursive: true });
      renameSync(join(legacyReviewsDir, file), target);
    }
  }

  if (apply) {
    for (const [runId, store] of perRunCounters) {
      mkdirSync(join(stateHome, runId), { recursive: true });
      atomicWriteJSON(join(stateHome, runId, "review-rounds.json"), store);
    }
    // Rewrite the legacy counter only when something moved out of it OR the file
    // already exists — a sweep-only `--apply` over a state home with no legacy
    // counter must not conjure one (FOC-903 review).
    if (roundsMoved.length || existsSync(legacyRoundsPath)) {
      const remaining = { ...legacyCounter };
      for (const { taskId } of roundsMoved) delete remaining[taskId];
      atomicWriteJSON(legacyRoundsPath, remaining);
    }
    // The redirect map: the report, kept one release — merge with whatever a
    // previous migration already recorded.
    const previous = readRedirectMap(redirectsPath);
    const merged = {
      migratedAt: now,
      rounds: [...(Array.isArray(previous.rounds) ? previous.rounds : []), ...roundsRedirects],
      reviews: [...(Array.isArray(previous.reviews) ? previous.reviews : []), ...reviewsRedirects],
    };
    mkdirSync(stateHome, { recursive: true });
    atomicWriteJSON(redirectsPath, merged);
  }
  const redirectMap = apply
    ? readRedirectMap(redirectsPath)
    : { migratedAt: now, rounds: roundsRedirects, reviews: reviewsRedirects };

  // ── 3. fixture sweep (FOC-602) ─────────────────────────────────────────────
  const removed = []; // apply: removed; dry run: wouldRemove
  const kept = [];
  if (sweepFixtures) {
    for (const entry of existsSync(stateHome) ? readdirSync(stateHome, { withFileTypes: true }) : []) {
      if (!entry.isDirectory() || !FIXTURE_DIR_RE.test(entry.name)) continue;
      const dir = join(stateHome, entry.name);
      const verdictsDir = join(dir, "verdicts");
      const hasVerdicts = (() => {
        try {
          return statSync(verdictsDir).isDirectory() && readdirSync(verdictsDir).length > 0;
        } catch {
          return false;
        }
      })();
      if (hasVerdicts) {
        kept.push({ dir: entry.name, reason: "verdicts present" });
        continue;
      }
      removed.push(entry.name);
      if (apply) rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    ok: true,
    dryRun: !apply,
    stateHome,
    rounds: { moved: roundsMoved, kept: roundsKept },
    reviews: { moved: reviewsMoved, kept: reviewsKept },
    fixtures: sweepFixtures
      ? { ...(apply ? { removed } : { wouldRemove: removed }), kept }
      : { ...(apply ? { removed: [] } : { wouldRemove: [] }), kept: [] },
    redirectMap,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--sweep-fixtures") opts.sweepFixtures = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--state-home") {
      if (i + 1 >= argv.length) throw new Error("--state-home requires a directory");
      opts.stateHome = argv[++i];
    } else throw new Error(`unknown option '${a}'`);
  }
  const report = migrateScratch(opts);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`supervisor-migrate-scratch: ${report.dryRun ? "DRY RUN — nothing written" : "applied"}`);
  console.log(`  state home: ${report.stateHome}`);
  for (const [label, section] of [["rounds", report.rounds], ["reviews", report.reviews]]) {
    if (!section.moved.length && !section.kept.length) continue;
    console.log(`  ${label}: ${section.moved.length} moved, ${section.kept.length} kept`);
    for (const m of section.moved) console.log(`    move  ${label === "rounds" ? m.taskId : m.file} -> ${m.runId}`);
    for (const k of section.kept) console.log(`    keep  ${label === "rounds" ? k.taskId : k.file} (${k.reason})`);
  }
  if (opts.sweepFixtures) {
    const f = report.fixtures;
    const gone = f.removed ?? f.wouldRemove;
    console.log(`  fixtures: ${(f.removed ?? f.wouldRemove).length} ${report.dryRun ? "would be removed" : "removed"}, ${f.kept.length} kept`);
    for (const name of gone) console.log(`    ${report.dryRun ? "would remove" : "removed"}  ${name}`);
    for (const k of f.kept) console.log(`    kept (verdicts present)  ${k.dir}`);
  }
  console.log("  sweep stale fixtures: --sweep-fixtures (add --apply to delete)");
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`supervisor-migrate-scratch: ${err.message}`);
    process.exit(1);
  }
}
