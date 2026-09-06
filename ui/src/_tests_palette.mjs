// Palette regression test (FOC-227). Spawns the frozen palette validator
// (scripts/validate-palette.mjs) as a subprocess — the validator is the spec:
// its constants, floors and color model are frozen, so this test only pins
// the exit code. Self-contained Node ESM script — NO test framework, NO deps.
// Same harness pattern as src/_test_utils.mjs. Invoke via: `npm --prefix ui run test`.
//
// NOTE: `npm --prefix ui run test` executes with cwd=ui/, so the validator
// path is resolved relative to THIS FILE (repo root is two levels up), never
// against process.cwd().

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VALIDATOR = join(REPO_ROOT, 'scripts', 'validate-palette.mjs');

function runValidator(args) {
  const res = spawnSync(process.execPath, [VALIDATOR, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: res.status, output: `${res.stdout || ''}${res.stderr || ''}`.trim() };
}

// --- Minimal test harness (same shape as _test_utils.mjs) ------------------

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`√ ${name}`);
  } catch (err) {
    fail++;
    console.log(`× ${name} — ${err && err.message ? err.message : err}`);
  }
}

await test('validate-palette default run (theme.css --sq-*) exits 0', () => {
  const { status, output } = runValidator([]);
  assert.equal(status, 0, `validator exited ${status} (expected 0)\n${output}`);
});

// --- Summary ---------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
