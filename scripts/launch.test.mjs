#!/usr/bin/env node
// scripts/launch.test.mjs — unit tests for the pure launch logic (L1b, JOI-69).
//
// Self-contained: `node scripts/launch.test.mjs` — no test framework, no HTTP
// server, no spawn. Uses node:assert. Exits 0 on pass, 1 on fail. Backs the
// dev hand-off "unit" claim with a committed, reproducible artifact (D-Q2,
// review round 1: the 50/50 unit claim was previously not backed by a file).
//
// Covers: validateLaunch (AC2), kickoffPrompt (HOW-TO §4), isLocalOrigin +
// isAllowedOrigin (AC3 + D-S1 CSRF defense), buildLaunchBat (wrapper shape +
// injection resistance). spawnLauncher is exercised separately via a marker
// .bat in ad-hoc verification (it has IO side effects — not a pure fn).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  SQUAD_ALLOWLIST,
  TASK_ID_RE,
  KICKOFF_TEMPLATES,
  validateLaunch,
  kickoffPrompt,
  isLocalOrigin,
  isAllowedOrigin,
  buildLaunchBat,
} from './launch.mjs';

const ok = 'JOI-51';
let pass = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

// --- validateLaunch: valid + defaults ---
test('valid {taskId,squad,target} → ok', () => {
  const v = validateLaunch({ taskId: ok, squad: 'dev', target: 'local' });
  assert.deepEqual(v, { ok: true, taskId: ok, squad: 'dev', target: 'local', dryRun: false });
});

test('squad is case-insensitive', () => {
  assert.equal(validateLaunch({ taskId: ok, squad: 'DEV' }).squad, 'dev');
  assert.equal(validateLaunch({ taskId: ok, squad: 'Review' }).squad, 'review');
});

test('target defaults to "local" when omitted', () => {
  assert.equal(validateLaunch({ taskId: ok, squad: 'dev' }).target, 'local');
});

test('dryRun=true is honored', () => {
  assert.equal(validateLaunch({ taskId: ok, squad: 'dev', dryRun: true }).dryRun, true);
  assert.equal(validateLaunch({ taskId: ok, squad: 'dev', dryRun: 1 }).dryRun, false); // strict boolean
});

test('target "vm" passes validation (501 handled by caller)', () => {
  assert.equal(validateLaunch({ taskId: ok, squad: 'dev', target: 'VM' }).target, 'vm');
});

// --- validateLaunch: AC2 rejections (400, never throws) ---
// Note: validateLaunch trims taskId/squad, so trailing-whitespace variants of
// a valid value are ACCEPTED (whitespace-only, no metachars → safe). Internal
// spaces / metachars fail the regex.
for (const bad of ['', 'joi-51', 'joI-51', 'joi51', 'JOI-', '-51', 'JOI 51', 'JOI-1 & dir', 'JOI-1;rm', 'evil!', 'fen']) {
  test(`bad taskId "${bad}" → 400`, () => {
    const v = validateLaunch({ taskId: bad, squad: 'dev' });
    assert.equal(v.ok, false);
    assert.equal(v.status, 400);
  });
}

test('off-allowlist squad → 400', () => {
  for (const bad of ['pwn', 'shell', 'admin', 'dev2', '']) {
    assert.equal(validateLaunch({ taskId: ok, squad: bad }).status, 400);
  }
});

test('bad target → 400', () => {
  for (const bad of ['mars', 'remote', 'prod', 'LOCALS']) {
    assert.equal(validateLaunch({ taskId: ok, squad: 'dev', target: bad }).status, 400);
  }
});

test('missing/empty body → 400 (taskId missing)', () => {
  assert.equal(validateLaunch({}).status, 400);
  assert.equal(validateLaunch(null).status, 400);
  assert.equal(validateLaunch(undefined).status, 400);
});

test('extra "mode" field ignored (D-Q1: deferred, not propagated)', () => {
  const v = validateLaunch({ taskId: ok, squad: 'dev', mode: 'auto' });
  assert.equal(v.ok, true);
  assert.equal('mode' in v, false);
});

// --- kickoffPrompt ---
test('kickoffPrompt substitutes {taskId} and collapses to one line', () => {
  const p = kickoffPrompt('dev', ok);
  assert.ok(!p.includes('{taskId}'), '{taskId} must be substituted');
  assert.ok(p.includes(ok));
  assert.ok(!p.includes('\n'), 'must be single-line');
});

test('kickoffPrompt per squad uses HOW-TO §4 template', () => {
  for (const s of SQUAD_ALLOWLIST) {
    const p = kickoffPrompt(s, ok);
    assert.ok(p.length > 0, `${s} prompt must be non-empty`);
    // cadence is a weekly digest (not task-specific) — has no {taskId}.
    // The other 4 squads are task-scoped and must mention the taskId.
    if (s !== 'cadence') {
      assert.ok(p.includes(ok), `${s} prompt must mention taskId`);
    }
  }
});

test('kickoffPrompt for unknown squad → empty string (no throw)', () => {
  assert.equal(kickoffPrompt('nope', ok), '');
});

// --- isLocalOrigin (AC3) ---
for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
  test(`isLocalOrigin("${addr}") → true`, () => assert.equal(isLocalOrigin(addr), true));
}
for (const addr of ['8.8.8.8', '192.168.1.1', '10.0.0.1', null, undefined, '']) {
  test(`isLocalOrigin("${addr}") → false`, () => assert.equal(isLocalOrigin(addr), false));
}

// --- isAllowedOrigin (D-S1 CSRF defense) ---
test('isAllowedOrigin: absent Origin → true (curl / smoke / server-to-server)', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(null), true);
  assert.equal(isAllowedOrigin(''), true);
});

test('isAllowedOrigin: loopback Origin → true (dashboard)', () => {
  for (const o of [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1',
    'http://localhost',
    'http://LOCALHOST:5173', // case-insensitive host
  ]) {
    assert.equal(isAllowedOrigin(o), true, `${o} should be allowed`);
  }
});

test('isAllowedOrigin: cross-site Origin → false (CSRF block)', () => {
  for (const o of [
    'https://evil.com',
    'http://evil.com',
    'http://127.0.0.1.evil.com',
    'http://localhost.evil.com',
    'http://192.168.1.5:7331',
    'https://localhost:5173', // https not allowed (server is http loopback)
    'http://127.0.0.1:7331:5173',
  ]) {
    assert.equal(isAllowedOrigin(o), false, `${o} should be blocked`);
  }
});

// --- buildLaunchBat ---
test('buildLaunchBat sets LA_TASK_ID + calls bin/<squad>.bat with prompt', () => {
  const rootDir = 'C:/repo';
  const bat = buildLaunchBat('dev', ok, kickoffPrompt('dev', ok), rootDir);
  const launcher = join(rootDir, 'bin', 'dev.bat'); // platform-correct separators
  assert.ok(bat.includes('set "LA_TASK_ID=JOI-51"'));
  assert.ok(bat.includes(`call "${launcher}"`));
  assert.ok(bat.includes(kickoffPrompt('dev', ok)));
  assert.ok(bat.endsWith('\r\n'), 'CRLF line endings');
});

test('buildLaunchBat is injection-resistant (taskId is regex-validated upstream)', () => {
  // taskId reaching buildLaunchBat already passed TASK_ID_RE, so no metachars.
  // Verify the safeKick path: a kickoff with a literal " is swapped to '.
  const bat = buildLaunchBat('dev', ok, 'has "quote" inside', 'C:/repo');
  assert.ok(!bat.includes('"quote" inside'), 'inner double-quote must be neutralized');
});

console.log(`\n${pass} passed${process.exitCode ? `, ${process.exitCode ? 'see failures above' : ''}` : ''}`);
if (process.exitCode) process.exit(process.exitCode);
