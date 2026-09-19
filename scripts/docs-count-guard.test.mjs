#!/usr/bin/env node
// scripts/docs-count-guard.test.mjs — FOC-354: guard that docs test count == actual *.test.mjs count
//
// Drift catch: the "N files" literal in docs/supervisor-e2e-checklist.md
// drifted 3x after wave #29-#32 (tests added, docs not updated). This guard
// fails with a diff ("docs say 67, found 68") so CI catches it instead of
// Mateusz finding it by hand.
//
// Run: node scripts/docs-count-guard.test.mjs

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Count actual test files — same filter as test-all.mjs
const actualCount = readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !f.startsWith("_"))
  .length;

// Parse the docs count from the two places that reference test-all.mjs:
//   line 3:  "test-all.mjs`, N files)"
//   line 206: "test-all.mjs` → N/N files"
const docsPath = join(ROOT, "docs", "supervisor-e2e-checklist.md");
const docsText = readFileSync(docsPath, "utf8");

let failed = false;
let docsCount = null;

// "N files" — the total count on line 3
const filesMatch = docsText.match(/test-all\.mjs`,\s*(\d+)\s+files/);
if (filesMatch) {
  docsCount = parseInt(filesMatch[1], 10);
  if (docsCount !== actualCount) {
    console.error(`DRIFT: docs say ${docsCount} files but found ${actualCount} test files`);
    failed = true;
  }
} else {
  console.error("WARN: could not find 'test-all.mjs, N files' pattern in docs");
}

// "N/N files" — the pass count on line 206
const slashMatch = docsText.match(/test-all\.mjs`\s*→\s*(\d+)\/(\d+)\s+files/);
if (slashMatch) {
  const [passCount, totalCount] = [parseInt(slashMatch[1], 10), parseInt(slashMatch[2], 10)];
  if (totalCount !== actualCount) {
    console.error(`DRIFT: docs say ${totalCount}/${totalCount} but found ${actualCount} test files`);
    failed = true;
  }
  if (passCount !== totalCount) {
    console.error(`DRIFT: docs say ${passCount}/${totalCount} — pass count != total`);
    failed = true;
  }
} else {
  console.error("WARN: could not find 'test-all.mjs → N/N files' pattern in docs");
}

if (failed) {
  console.error(`\nFix: update docs/supervisor-e2e-checklist.md to say ${actualCount} files`);
  process.exit(1);
}

console.log(`OK: docs count (${actualCount}) matches actual test file count (${actualCount})`);
