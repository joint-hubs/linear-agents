#!/usr/bin/env node
// scripts/docs-count-guard.test.mjs — FOC-354/FOC-1145: guard that docs test count == actual *.test.mjs count
//
// Drift catch: the "N files" literal in docs/supervisor-e2e-checklist.md
// drifted 3x after wave #29-#32 (tests added, docs not updated). This guard
// fails with a diff ("docs say 67, found 68") so CI catches it instead of
// Mateusz finding it by hand.
//
// FOC-1145: the expected number is derived from scripts/test-lanes.json (the
// registered lane entries) and cross-checked against the actual *.test.mjs
// count — the guard fails if the two sources disagree with each other. All
// suite-size count idioms in the checklist are pinned, not just two spots:
//   `test-all.mjs\`, N files`        — setup section total
//   `test-all.mjs  # N test files`   — setup section command comment
//   `test-all.mjs\` → N/N files`     — verification section pass/total,
//                                      incl. the "P parallel + S serial" split
// plus a sweep over every remaining "N test files" literal in the file.
// The `*Measured ...: N files*` line is a git-diff --stat count (changed
// files), not a suite count — deliberately out of scope.
//
// Run: node scripts/docs-count-guard.test.mjs

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Source 1: expected count from the registered lanes (scripts/test-lanes.json)
let laneSplit = null;
try {
  const lanes = JSON.parse(readFileSync(join(__dirname, "test-lanes.json"), "utf8"));
  const parallel = Array.isArray(lanes.parallel) ? lanes.parallel.length : null;
  const serial = Array.isArray(lanes.serial) ? lanes.serial.length : null;
  if (parallel === null || serial === null) {
    console.error("ERROR: scripts/test-lanes.json does not carry parallel/serial arrays");
    process.exit(1);
  }
  laneSplit = { parallel, serial };
} catch (err) {
  console.error(`ERROR: could not parse scripts/test-lanes.json: ${err.message}`);
  process.exit(1);
}
const lanesTotal = laneSplit.parallel + laneSplit.serial;

// Source 2: actual test files — same filter as test-all.mjs
const actualCount = readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !f.startsWith("_"))
  .length;

let failed = false;
const fail = (msg) => {
  console.error(msg);
  failed = true;
};

// The two sources must agree with each other before the docs are judged.
if (lanesTotal !== actualCount) {
  fail(
    `DRIFT: test-lanes.json registers ${lanesTotal} files ` +
      `(${laneSplit.parallel} parallel + ${laneSplit.serial} serial) but found ${actualCount} *.test.mjs files`,
  );
}

// Parse the suite-size counts from docs/supervisor-e2e-checklist.md.
const docsPath = join(ROOT, "docs", "supervisor-e2e-checklist.md");
const docsText = readFileSync(docsPath, "utf8");
const lineAt = (index) => docsText.slice(0, index).split("\n").length;

// "N files" — the total count in the setup section
const filesMatch = docsText.match(/test-all\.mjs`,\s*(\d+)\s+files/);
if (filesMatch) {
  const docsCount = parseInt(filesMatch[1], 10);
  if (docsCount !== actualCount) {
    fail(`DRIFT: docs line ${lineAt(filesMatch.index)} says ${docsCount} files but found ${actualCount} test files`);
  }
} else {
  console.error("WARN: could not find 'test-all.mjs, N files' pattern in docs");
}

// "N test files" — the command comment in the setup section
const commentMatch = docsText.match(/test-all\.mjs\s*#\s*(\d+)\s+test\s+files/);
if (commentMatch) {
  const docsCount = parseInt(commentMatch[1], 10);
  if (docsCount !== actualCount) {
    fail(
      `DRIFT: docs line ${lineAt(commentMatch.index)} says ${docsCount} test files but found ${actualCount} test files`,
    );
  }
} else {
  console.error("WARN: could not find 'test-all.mjs # N test files' pattern in docs");
}

// "N/N files" — the pass count in the verification section
const slashMatch = docsText.match(/test-all\.mjs`\s*→\s*(\d+)\/(\d+)\s+files/);
if (slashMatch) {
  const [passCount, totalCount] = [parseInt(slashMatch[1], 10), parseInt(slashMatch[2], 10)];
  if (totalCount !== actualCount) {
    fail(`DRIFT: docs line ${lineAt(slashMatch.index)} says ${totalCount} total but found ${actualCount} test files`);
  }
  if (passCount !== totalCount) {
    fail(`DRIFT: docs line ${lineAt(slashMatch.index)} says ${passCount}/${totalCount} — pass count != total`);
  }

  // "P parallel + S serial" — the lane split named in the same line
  const splitMatch = docsText.match(/(\d+)\s+parallel\s+\+\s+(\d+)\s+serial/);
  if (splitMatch) {
    const [p, s] = [parseInt(splitMatch[1], 10), parseInt(splitMatch[2], 10)];
    if (p !== laneSplit.parallel || s !== laneSplit.serial) {
      fail(
        `DRIFT: docs line ${lineAt(splitMatch.index)} says ${p} parallel + ${s} serial but test-lanes.json ` +
          `registers ${laneSplit.parallel} + ${laneSplit.serial}`,
      );
    }
  } else {
    console.error("WARN: could not find 'N parallel + N serial' pattern in docs");
  }
} else {
  console.error("WARN: could not find 'test-all.mjs → N/N files' pattern in docs");
}

// Sweep: every remaining "N test files" literal in the checklist must equal
// the expected number, wherever it appears.
const sweepRe = /\b(\d+)\s+test\s+files/g;
let sweepHits = 0;
for (const m of docsText.matchAll(sweepRe)) {
  sweepHits++;
  const docsCount = parseInt(m[1], 10);
  if (docsCount !== actualCount) {
    fail(`DRIFT: docs line ${lineAt(m.index)} says ${docsCount} test files but found ${actualCount} test files`);
  }
}
if (sweepHits === 0) {
  console.error("WARN: no 'N test files' literal found in docs — sweep covered nothing");
}

if (failed) {
  console.error(
    `\nFix: update docs/supervisor-e2e-checklist.md to say ${actualCount} files ` +
      `(${laneSplit.parallel} parallel + ${laneSplit.serial} serial per scripts/test-lanes.json)`,
  );
  process.exit(1);
}

console.log(
  `OK: docs counts match ${actualCount} test files ` +
    `(${laneSplit.parallel} parallel + ${laneSplit.serial} serial per scripts/test-lanes.json)`,
);
