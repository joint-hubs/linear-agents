#!/usr/bin/env node
// scripts/test-all.mjs — run every scripts/*.test.mjs in order.
// Each test file is self-contained and exits non-zero on failure. We
// just collect exit codes and surface a summary.
//
// Usage: node scripts/test-all.mjs [pattern]
//   pattern (optional): substring to filter test files (e.g. "telemetry")

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';

const allFiles = readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !f.startsWith('_')) // skip helpers (e.g. _test_utils.mjs lives in ui/src, not here, but be defensive)
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!allFiles.length) {
  console.error(`No test files matched${filter ? ` filter "${filter}"` : ''}.`);
  process.exit(1);
}

console.log(`Running ${allFiles.length} test file(s)${filter ? ` (filter: "${filter}")` : ''}...\n`);

let failed = 0;
let passed = 0;
const t0 = Date.now();

for (const f of allFiles) {
  const path = join(__dirname, f);
  const t1 = Date.now();
  const result = spawnSync(process.execPath, [path], { stdio: 'inherit' });
  const dt = Date.now() - t1;
  if (result.status === 0) {
    passed++;
    console.log(`  ✓ ${f} (${dt}ms)`);
  } else {
    failed++;
    console.error(`  ✗ ${f} (${dt}ms, exit ${result.status})`);
  }
}

const total = Date.now() - t0;
console.log(`\n${passed}/${allFiles.length} passed in ${total}ms.`);

if (failed > 0) {
  console.error(`\n${failed} test file(s) failed.`);
  process.exit(1);
}
