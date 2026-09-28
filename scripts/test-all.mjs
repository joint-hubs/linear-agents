#!/usr/bin/env node
// scripts/test-all.mjs — the suite entry point for humans and supervisor-merge.
// Since FOC-614 this is a thin delegate: scripts/test-run.mjs is the single
// owner of test execution (lanes, coverage check, isolation audit, timing,
// wall-clock budget). argv is forwarded unchanged, so every documented
// invocation keeps working: node scripts/test-all.mjs [pattern].
//
// Run: node scripts/test-all.mjs [pattern]

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(__dirname, 'test-run.mjs');

const result = spawnSync(process.execPath, [RUNNER, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);