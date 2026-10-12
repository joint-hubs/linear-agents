// scripts/fenix-doctor.mjs — Fenix environment self-check (FOC-775).
// Runs inside the Fenix container (also works on a dev machine) and prints one
// line per check: OK / WARN / FAIL. Exit code 0 when nothing FAILED (warnings
// are acceptable), 1 otherwise. --json prints { ok, checks: [...] } instead;
// --with-api adds the telemetry-API health probe.
// API keys (OPENROUTER_API_KEY, LINEAR_API_KEY, GITHUB_TOKEN) are reported
// ONLY as present/absent — never their value, length or any part of it.
// Usage: node scripts/fenix-doctor.mjs [--json] [--with-api]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GIB = 1024 ** 3;
const TOOL_FIX = 'rebuild the image: fenix update';
const VOLUME_FIX = 'check the fenix-data volume';

// Tools the agent runtime needs (missing → FAIL) vs optional analysis/scan
// tooling (missing → WARN: security scan or analysis degrade, not a dead box).
const REQUIRED_TOOLS = [
  ['git', ['--version']],
  ['claude', ['--version']],
  ['codegraph', ['--version']],
  ['gh', ['--version']], // squads call gh (FOC-776)
];
const OPTIONAL_TOOLS = [
  ['semgrep', ['--version']],
  ['python3', ['--version']],
  ['uv', ['--version']],
];

// Mutable state directories: env name → default inside the container volume.
const DIRS = [
  ['LA_TELEMETRY_HOME', '/data/telemetry'],
  ['LA_SUPERVISOR_STATE_HOME', '/data/state/supervisor'],
  ['FENIX_WORKSPACES', '/data/workspaces'],
];

/** One check → one printable line. */
export function formatLine(check) {
  const label = check.status.toUpperCase().padEnd(4);
  const fix = check.fix ? ` — fix: ${check.fix}` : '';
  return `${label} ${check.name} — ${check.detail}${fix}`;
}

/** checks → { ok, failures, warnings } — ok is false only on FAILs. */
export function summarize(checks) {
  const failures = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  return { ok: failures === 0, failures, warnings };
}

function checkNode() {
  const major = parseInt(process.versions.node, 10);
  if (major >= 22) {
    return { name: 'node', status: 'ok', detail: `v${process.versions.node}` };
  }
  return { name: 'node', status: 'fail', detail: `v${process.versions.node} (need >= 22)`, fix: TOOL_FIX };
}

// spawnSync wrapper: OK carries the tool's first stdout line; anything else
// (ENOENT, non-zero, timeout) carries a short reason and the rebuild hint.
function checkTool(spawn, name, args, status) {
  const r = spawn(name, args, { encoding: 'utf8', timeout: 20000, shell: false });
  const firstLine = String(r.stdout || '').split('\n')[0].trim();
  if (r.status === 0 && firstLine) {
    return { name, status: 'ok', detail: firstLine };
  }
  const detail = r.error ? String(r.error.message).split('\n')[0] : `exit code ${r.status}`;
  return { name, status, detail, fix: TOOL_FIX };
}

function checkKeys(env) {
  return ['OPENROUTER_API_KEY', 'LINEAR_API_KEY', 'GITHUB_TOKEN'].map((key) =>
    env[key]
      ? { name: key, status: 'ok', detail: 'present' }
      : { name: key, status: 'fail', detail: 'missing', fix: 'fenix keys' },
  );
}

function checkDirs(env, fsImpl) {
  return DIRS.map(([envName, fallback]) => {
    const dir = env[envName] || fallback;
    // Doctor must not create directories on a dev machine — only the container
    // entrypoint (FENIX_IN_CONTAINER=1) provisions them.
    if (env.FENIX_IN_CONTAINER === '1') {
      try {
        fsImpl.mkdirSync(dir, { recursive: true });
        fsImpl.accessSync(dir, fsImpl.constants.W_OK);
        return { name: `dir ${envName}`, status: 'ok', detail: dir };
      } catch (err) {
        return { name: `dir ${envName}`, status: 'fail', detail: `${dir} (${err.message})`, fix: VOLUME_FIX };
      }
    }
    if (fsImpl.existsSync(dir)) {
      try {
        fsImpl.accessSync(dir, fsImpl.constants.W_OK);
        return { name: `dir ${envName}`, status: 'ok', detail: dir };
      } catch (err) {
        return { name: `dir ${envName}`, status: 'fail', detail: `${dir} (${err.message})`, fix: VOLUME_FIX };
      }
    }
    return { name: `dir ${envName}`, status: 'warn', detail: `${dir} (missing — created on first start inside the container)` };
  });
}

function checkDisk(env, fsImpl) {
  // Free space of the volume holding the telemetry store — its parent, or
  // cwd when that path does not exist yet (fresh dev checkout).
  let target = path.dirname(env.LA_TELEMETRY_HOME || '/data/telemetry');
  let st;
  try {
    st = fsImpl.statfsSync(target);
  } catch {
    target = process.cwd();
    try {
      st = fsImpl.statfsSync(target);
    } catch (err) {
      return { name: 'disk', status: 'fail', detail: `statfs failed: ${err.message}`, fix: VOLUME_FIX };
    }
  }
  const freeGiB = (st.bavail * st.bsize) / GIB;
  const detail = `${freeGiB.toFixed(1)} GiB free`;
  if (freeGiB < 1) return { name: 'disk', status: 'fail', detail: `${detail} (< 1 GiB)`, fix: VOLUME_FIX };
  if (freeGiB < 5) return { name: 'disk', status: 'warn', detail: `${detail} (< 5 GiB)`, fix: VOLUME_FIX };
  return { name: 'disk', status: 'ok', detail };
}

async function checkApi(fetchImpl, env) {
  const port = parseInt(env.TELEMETRY_PORT, 10) || 7331;
  const url = `http://127.0.0.1:${port}/api/telemetry/health`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return { name: 'api', status: 'ok', detail: `HTTP ${res.status} (${url})` };
    return { name: 'api', status: 'fail', detail: `HTTP ${res.status} (${url})`, fix: 'fenix logs fenix-api' };
  } catch (err) {
    return { name: 'api', status: 'fail', detail: `${err.message} (${url})`, fix: 'fenix logs fenix-api' };
  }
}

/**
 * Run every check in order. Dependencies are injectable so future tests can
 * pass fakes: spawn (spawnSync-shaped), fsImpl (mkdirSync/accessSync/
 * constants/statfsSync), fetchImpl (fetch-shaped), env, withApi.
 * @returns {Promise<Array<{ name, status: 'ok'|'warn'|'fail', detail, fix? }>>}
 */
export async function runChecks({ env = process.env, withApi = false, spawn = spawnSync, fsImpl = fs, fetchImpl = fetch } = {}) {
  const checks = [
    checkNode(),
    ...REQUIRED_TOOLS.map(([name, args]) => checkTool(spawn, name, args, 'fail')),
    ...OPTIONAL_TOOLS.map(([name, args]) => checkTool(spawn, name, args, 'warn')),
    ...checkKeys(env),
    ...checkDirs(env, fsImpl),
    checkDisk(env, fsImpl),
  ];
  if (withApi) checks.push(await checkApi(fetchImpl, env));
  return checks;
}

// ---------------------------------------------------------------------------
// Main — only when executed directly (not when imported for the helpers).
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const withApi = process.argv.includes('--with-api');
  const checks = await runChecks({ withApi });
  const { ok } = summarize(checks);
  if (process.argv.includes('--json')) {
    // fix is optional in the JSON shape — omit it when absent.
    console.log(JSON.stringify({ ok, checks: checks.map(({ fix, ...rest }) => (fix ? { ...rest, fix } : rest)) }, null, 2));
  } else {
    for (const check of checks) console.log(formatLine(check));
  }
  process.exitCode = ok ? 0 : 1;
}
