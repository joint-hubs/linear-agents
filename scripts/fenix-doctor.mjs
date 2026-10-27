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
// FOC-1068: fenix-manifest.mjs is the one helper the manifest pass needs and
// stays static. Every other helper loads behind try/catch (see loadHelper) so a
// deleted module surfaces as a FAIL line from checkFenixCode — not as
// ERR_MODULE_NOT_FOUND taking the whole doctor down before any check runs.
import { DEFAULT_MANIFEST_PATH, compareToManifest, readManifest } from './fenix-manifest.mjs';

const GIB = 1024 ** 3;
// FOC-780: the disk check's warn threshold comes from the overlay's
// retention.minFreeGiB; this is the fallback when it is unset or unreadable.
const MIN_FREE_GIB_DEFAULT = 5;
const TOOL_FIX = 'rebuild the image: fenix update';
const VOLUME_FIX = 'check the fenix-data volume';
const UID_FIX = 'rebuild the image for your user: ./fenix up (sets FENIX_UID/FENIX_GID from id -u/-g)';
// FOC-803: rebuilding the image re-owns the bind mounts but NOT the named
// data volume — it keeps the uid it was first created with, so a rebuild for
// a new uid leaves /data unwritable. The recovery is a one-time chown.
const VOLUME_REOWN_FIX =
  'the data volume belongs to another uid — re-own it once: docker run --rm -u 0 -v fenix_fenix-data:/data --entrypoint chown fenix:dev -R $(id -u):$(id -g) /data';

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

// FOC-1068: helpers the checks need beyond the manifest. Each one is loaded
// through import() behind its own try/catch, so a single deleted module degrades
// its check instead of killing the doctor on load. The load happens at module
// init (top-level await) because several checks below are sync and tests call
// them directly; the manifest pass does not touch any of these and is always
// able to answer.
async function loadHelper(specifier) {
  try {
    return { specifier, mod: await import(specifier), error: null };
  } catch (error) {
    return { specifier, mod: null, error };
  }
}

const [
  pathsH,
  curRunH,
  taskSessionsH,
  settingsH,
  integrationsH,
  retentionH,
  pruneH,
  runOwnersH,
  hostClientH,
  supervisorLibH,
  supervisorLaunchH,
] = await Promise.all([
  loadHelper('./fenix-paths.mjs'),
  loadHelper('./supervisor-current-run.mjs'),
  loadHelper('./task-sessions.mjs'),
  loadHelper('./fenix-settings.mjs'),
  loadHelper('./fenix-integrations.mjs'),
  loadHelper('./fenix-retention.mjs'),
  loadHelper('./fenix-prune.mjs'),
  loadHelper('./run-owner.mjs'),
  loadHelper('./supervisor-host-client.mjs'),
  loadHelper('./supervisor-lib.mjs'),
  loadHelper('./supervisor-launch.mjs'),
]);

/** The first of the given helpers that did not load, else null. */
function firstUnloaded(...hs) {
  return hs.find((h) => !h.mod) ?? null;
}

/** A check line for a check that cannot run because a helper module is gone. */
function helperFail(name, h) {
  return {
    name,
    status: 'fail',
    detail: `helper ${h.specifier} did not load (${String(h.error?.message ?? h.error).split('\n')[0]})`,
    fix: TOOL_FIX,
  };
}

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

// FOC-1000: the gh the squads call. Debian's package (2.23) runs `gh pr edit`
// against the sunset Projects (classic) GraphQL API and fails on every PR; the
// image installs gh from GitHub's own apt repo instead and checks this same
// floor at build time (Dockerfile ARG GH_MIN_VERSION — a test pins the two
// together). 2.89.0 is the release verified to edit PRs.
export const GH_MIN_VERSION = '2.89.0';

/** true / false for a `gh version X.Y.Z …` line against the floor, null when the line is not one. */
export function ghBelowFloor(firstLine, floor = GH_MIN_VERSION) {
  const m = /^gh version (\d+)\.(\d+)\.(\d+)/.exec(String(firstLine ?? ''));
  if (!m) return null;
  const have = [m[1], m[2], m[3]].map(Number);
  const want = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] < want[i];
  }
  return false;
}

// A gh below the floor is a FAIL in the container (the image decides it: the
// Debian fallback slipped in) and a WARN on a dev machine; the version itself
// is already in the line, so this adds no check of its own.
export function applyGhFloor(check, env) {
  if (check.name !== 'gh' || check.status !== 'ok' || ghBelowFloor(check.detail) !== true) return check;
  return {
    ...check,
    status: env.FENIX_IN_CONTAINER === '1' ? 'fail' : 'warn',
    detail: `${check.detail} — below the supported ${GH_MIN_VERSION} (gh pr edit breaks on the sunset Projects (classic) API)`,
    fix: env.FENIX_IN_CONTAINER === '1' ? TOOL_FIX : `upgrade gh to >= ${GH_MIN_VERSION} (cli.github.com/packages)`,
  };
}

function checkKeys(env) {
  return ['OPENROUTER_API_KEY', 'LINEAR_API_KEY', 'GITHUB_TOKEN'].map((key) =>
    env[key]
      ? { name: key, status: 'ok', detail: 'present' }
      : { name: key, status: 'fail', detail: 'missing', fix: 'fenix keys' },
  );
}

function checkDirs(env, fsImpl) {
  // A failing writable-dir check for a path under /data is the FOC-803 volume
  // uid case in the container, not a generic volume problem — name the re-own.
  const dirFix = (dir) =>
    env.FENIX_IN_CONTAINER === '1' && (dir === '/data' || dir.startsWith('/data/')) ? VOLUME_REOWN_FIX : VOLUME_FIX;
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
        return { name: `dir ${envName}`, status: 'fail', detail: `${dir} (${err.message})`, fix: dirFix(dir) };
      }
    }
    if (fsImpl.existsSync(dir)) {
      try {
        fsImpl.accessSync(dir, fsImpl.constants.W_OK);
        return { name: `dir ${envName}`, status: 'ok', detail: dir };
      } catch (err) {
        return { name: `dir ${envName}`, status: 'fail', detail: `${dir} (${err.message})`, fix: dirFix(dir) };
      }
    }
    return { name: `dir ${envName}`, status: 'warn', detail: `${dir} (missing — created on first start inside the container)` };
  });
}

/**
 * The disk check's warn threshold: the overlay's retention.minFreeGiB, the
 * 5 GiB default when the key is absent. A settings read or validation failure
 * falls back to 5 and is reported to the caller (it lands in the check's
 * detail) instead of thrown — the disk check must still answer (FOC-780).
 */
function resolveRetentionSafe(settings) {
  try {
    const missing = firstUnloaded(retentionH, settingsH);
    if (missing) throw missing.error;
    const resolved = retentionH.mod.resolveRetention(settings ?? settingsH.mod.readSettings());
    return { minFreeGiB: resolved.minFreeGiB, settingsError: null };
  } catch (err) {
    return { minFreeGiB: MIN_FREE_GIB_DEFAULT, settingsError: String(err?.message || err).split('\n')[0] };
  }
}

// FOC-808: the caches check's cap — the overlay's retention.cacheMaxGb when it
// is a valid integer, else the prune CLI's default (single source:
// fenix-prune.mjs). A settings failure falls back to the default with the
// error attached, like the disk check.
function resolveCacheMaxGbSafe(settings) {
  try {
    const missing = firstUnloaded(pruneH, settingsH);
    if (missing) throw missing.error;
    const DEFAULT = pruneH.mod.CACHE_MAX_GB_DEFAULT;
    const obj = settings ?? settingsH.mod.readSettings();
    const raw = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj.retention?.cacheMaxGb : undefined;
    if (Number.isInteger(raw) && raw >= 1) return { cacheMaxGb: raw, settingsError: null };
    return { cacheMaxGb: DEFAULT, settingsError: null };
  } catch (err) {
    return { cacheMaxGb: null, settingsError: String(err?.message || err).split('\n')[0] };
  }
}

function checkDisk(env, fsImpl, { minFreeGiB, settingsError }) {
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
  const fallbackNote = settingsError
    ? ` — retention settings unreadable (${settingsError}); warn threshold falls back to ${minFreeGiB} GiB`
    : '';
  if (freeGiB < 1) return { name: 'disk', status: 'fail', detail: `${detail} (< 1 GiB)${fallbackNote}`, fix: VOLUME_FIX };
  if (freeGiB < minFreeGiB) return { name: 'disk', status: 'warn', detail: `${detail} (< ${minFreeGiB} GiB)${fallbackNote}`, fix: VOLUME_FIX };
  return { name: 'disk', status: 'ok', detail: `${detail} (warn < ${minFreeGiB} GiB)${fallbackNote}` };
}

// 1099511627776 -> "1.0 TiB", 230 MiB -> "230.0 MiB", 512 -> "512 B".
function humanBytes(n) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Number(n) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * The logs-usage line: one snapshot of how much disk the transcripts /
 * telemetry / workspaces / run-state trees take plus the free space, so the
 * numbers are visible without the dashboard. The snapshot comes through
 * cachedRetention (60 s TTL, shared with the settings route) to keep the
 * doctor cheap. A partial walk, unreadable entries or a failed snapshot are
 * said so on the line and warn — they degrade the number, not the box.
 */
async function checkLogsUsage(retentionReader) {
  let snap;
  try {
    snap = await retentionReader();
  } catch (err) {
    return { name: 'logs usage', status: 'warn', detail: `retention snapshot failed: ${String(err?.message || err).split('\n')[0]}` };
  }
  if (!snap || typeof snap.usage !== 'object' || snap.usage === null) {
    return { name: 'logs usage', status: 'warn', detail: 'retention snapshot unavailable' };
  }
  const usage = snap.usage;
  const parts = [
    `transcripts ${humanBytes(usage.transcriptsBytes)}`,
    `telemetry ${humanBytes(usage.telemetryBytes)}`,
    `workspaces ${humanBytes(usage.workspacesBytes)}`,
    `state ${humanBytes(usage.stateBytes)}`,
    `free ${snap.disk ? humanBytes(snap.disk.freeBytes) : 'unknown'}`,
  ];
  const notes = [];
  if (Array.isArray(snap.partial) && snap.partial.length) notes.push(`partial walk: ${snap.partial.join(', ')}`);
  const unreadable = Object.values(snap.unreadable || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
  if (unreadable > 0) notes.push(`${unreadable} unreadable ${unreadable === 1 ? 'entry' : 'entries'}`);
  return {
    name: 'logs usage',
    status: notes.length ? 'warn' : 'ok',
    detail: `${parts.join(' · ')}${notes.length ? ` — ${notes.join('; ')}` : ''}`,
  };
}

/**
 * FOC-808: the cache volume and the per-child tmp root. Warns over the cap
 * (the overlay's retention.cacheMaxGb, default 5) with the prune CLI as the
 * fix. sizesReader is injectable for tests — it returns the fenix-prune
 * report shape ({ tools, totalBytes, childTmpBytes }) for the given roots.
 */
export async function checkCaches({ env = process.env, fsImpl = fs, cacheMaxGb, sizesReader } = {}) {
  const name = 'caches';
  const capGb = cacheMaxGb ?? pruneH.mod?.CACHE_MAX_GB_DEFAULT;
  if (!Number.isFinite(capGb)) {
    return helperFail(name, pruneH);
  }
  const cacheRoot = env.LA_CACHE_ROOT || '/home/node/.cache';
  const childTmpRoot = env.LA_CHILD_TMP_ROOT || '/tmp/fenix-child';
  const capBytes = capGb * 1024 ** 3;
  let sizes;
  try {
    sizes = sizesReader
      ? sizesReader()
      : (() => {
          const missing = firstUnloaded(pruneH);
          if (missing) throw missing.error;
          const tools = pruneH.mod.cacheToolSizes(cacheRoot, fsImpl);
          return {
            tools,
            totalBytes: tools.reduce((sum, t) => sum + t.bytes, 0),
            childTmpBytes: pruneH.mod.childTmpSizes(childTmpRoot, fsImpl).reduce((sum, c) => sum + c.bytes, 0),
          };
        })();
  } catch (err) {
    return { name, status: 'warn', detail: `cache sizes unavailable: ${String(err?.message || err).split('\n')[0]}` };
  }
  const detail = `cache ${sizes.totalBytes ? humanBytes(sizes.totalBytes) : 'none'} · child tmp ${sizes.childTmpBytes ? humanBytes(sizes.childTmpBytes) : 'none'} · cap ${capGb} GB (retention.cacheMaxGb)`;
  if (sizes.totalBytes > capBytes) {
    return { name, status: 'warn', detail, fix: `fenix prune --max-gb ${capGb}` };
  }
  return { name, status: 'ok', detail };
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

// The Cockpit (FOC-783) drives the Supervisor through two hooks in the squad
// settings the container actually uses. A settings.json kept from a pre-783
// image (the dpkg rule keeps edited files) lacks them — the dashboard then
// cannot see or talk to the session. Warn, never fail: the Supervisor itself
// works without the hooks.
function checkCockpitHooks(env, fsImpl) {
  const name = 'cockpit hooks';
  if (!pathsH.mod) return helperFail(name, pathsH);
  const settingsPath = path.join(pathsH.mod.squadConfigDir('supervisor', env), 'settings.json');
  const hooks = ['supervisor-session-hook.mjs', 'supervisor-edits-hook.mjs'];
  let src;
  try {
    src = fsImpl.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    return { name, status: 'warn', detail: `${settingsPath} not readable (${err.message})`, fix: VOLUME_FIX };
  }
  const missing = hooks.filter((hook) => !src.includes(hook));
  if (missing.length) {
    return {
      name: 'cockpit hooks',
      status: 'warn',
      detail: `agents/supervisor/settings.json was edited locally and lacks the Cockpit hooks (${missing.join(', ')}) — merge them from settings.json.fenix-new (the image's version, parked next to it)`,
      fix: 'merge the twin, then delete it',
    };
  }
  return { name: 'cockpit hooks', status: 'ok', detail: 'session + edits hooks present' };
}

// FOC-901: one line about the managed task sessions. The store read is a
// small injectable seam (readSessions) so tests can fake it; existence uses
// the injected fsImpl. Best-effort liveness for the unscoped neighbour: the
// global session.json carries no pid today, so a present file whose state is
// not "ended" counts as live unless it names a pid that is provably dead.
export function checkTaskSessions({ env = process.env, fsImpl = fs, readSessions } = {}) {
  const name = 'task sessions';
  const missing = firstUnloaded(taskSessionsH, settingsH, curRunH, pathsH);
  if (missing) return helperFail(name, missing);
  const read = readSessions ?? taskSessionsH.mod.readActiveSessions;
  const dbPath = taskSessionsH.mod.taskSessionsDbPath(env);
  // The overlay is read quiet: the doctor prints its own lines, so a stray
  // stderr write mid-run would land between them — an invalid overlay is
  // surfaced in this check's detail instead.
  const settings = settingsH.mod.readTaskSessionsSettings(env, { quiet: true });
  const cap = settings.maxActive ?? taskSessionsH.mod.DEFAULT_MAX_ACTIVE ?? 1;
  const overlayNote = settings.error ? ` — settings overlay ignored (${settings.error})` : "";
  // FOC-902: the autonomous-pickup note rides on every detail branch — the
  // doctor line answers both "how full is the cap" and "is pickup on" in one
  // place. A settings.error (overlay ignored) reads autoPickup as null → off.
  const autoNote = settings.autoPickup?.enabled
    ? `; auto-pickup: on (every ${settings.autoPickup.pollSeconds}s, states ${settings.autoPickup.states.join(",")})`
    : "; auto-pickup: off";
  let exists = false;
  try {
    exists = fsImpl.existsSync(dbPath);
  } catch {}
  if (!exists) return { name: 'task sessions', status: 'ok', detail: 'no managed sessions yet' + autoNote };

  const { sessions, unknown } = read(dbPath);
  if (unknown) {
    const hotWal = /wal-recovery-needed/.test(unknown);
    return {
      name: 'task sessions',
      status: 'warn',
      detail: `the task-sessions store could not be read (${unknown})` + autoNote,
      fix: hotWal
        ? 'a session host died with a hot WAL — start the host once or set FENIX_SUPERVISOR_LEGACY=1'
        : `check ${dbPath}`,
    };
  }
  // Partition by pid liveness like the resolve guard: a provably dead session
  // is stale — it does not count against the cap and cannot block anything.
  const live = sessions.filter((s) => curRunH.mod.pidAlive(s.pid));
  const stale = sessions.filter((s) => !curRunH.mod.pidAlive(s.pid));
  const ids = live.map((s) => s.sessionId).join(', ');
  const counts = stale.length > 0
    ? `${live.length} live / cap ${cap} (${stale.length} stale: ${stale.map((s) => s.sessionId).join(', ')})`
    : `${live.length} active / cap ${cap} (ids: ${ids || 'none'})`;

  let unscoped = null;
  let sessionFile = null;
  try {
    sessionFile = path.join(pathsH.mod.dataHome(env), 'supervisor', 'session.json');
  } catch {
    sessionFile = null;
  }
  if (sessionFile && live.length > 0 && fsImpl.existsSync(sessionFile)) {
    let record = null;
    try {
      record = JSON.parse(fsImpl.readFileSync(sessionFile, 'utf8'));
    } catch {}
    if (record && record.state !== 'ended' && curRunH.mod.pidAlive(record?.pid)) unscoped = record;
  }

  const capReached = live.length >= cap;
  if (!capReached && !unscoped) {
    return { name: 'task sessions', status: 'ok', detail: counts + overlayNote + autoNote };
  }
  // Both warns land on ONE line when they apply together — never two lines
  // for the same check.
  const parts = [];
  const fixes = [];
  if (capReached) {
    parts.push('cap reached, the next ticket waits');
    fixes.push('raise the cap: fenix settings set taskSessions.maxActive <n>');
  }
  if (unscoped) {
    parts.push(`an unscoped Supervisor runs next to them (session.json${unscoped.updatedAt ? ` updated ${unscoped.updatedAt}` : ''}) — stop it or start it scoped`);
    fixes.push('start scoped: FENIX_SUPERVISOR_SESSION_ID=<id> LA_TASK_KEY=<key> fenix supervisor-run');
  }
  return {
    name: 'task sessions',
    status: 'warn',
    detail: `${counts} — ${parts.join('; ')}` + overlayNote + autoNote,
    fix: fixes.join('; '),
  };
}

// FOC-918: one line when the Supervisor sits on a permission prompt (an
// `ask` rule or the auto-mode classifier) — an unattended run stops there
// until a person answers, and nothing times out. The Supervisor host is the
// source of truth (it reads the pane, like the dashboard); without a host
// (native mode) the hook's session.json stands in, with the caveat that an
// Esc-cancelled turn leaves it saying needs-input until the next turn. The
// record carries no pid, so liveness is not something it can prove.
export async function checkSupervisorPrompt({ env = process.env, fsImpl = fs, now = Date.now, parkedAfterMs, readHostState = defaultHostState } = {}) {
  const name = 'supervisor prompt';
  const silenceMs = parkedAfterMs ?? supervisorLibH.mod?.stallSilenceMs();
  if (!Number.isFinite(silenceMs)) return helperFail(name, supervisorLibH);
  if (readHostState === defaultHostState && !hostClientH.mod) return helperFail(name, hostClientH);
  const host = await readHostState(env);
  if (host && host.unreachable) return { name, status: 'warn', detail: 'the Supervisor host did not answer GET /state — cannot tell whether a prompt waits', fix: 'fenix doctor again once the stack is up (fenix up)' };
  let state = null;
  let since = null;
  let source = 'host';
  if (host) {
    state = typeof host.state === 'string' ? host.state : null;
    since = typeof host.needsInputSince === 'string' ? host.needsInputSince : null;
  } else {
    source = 'session.json';
    let sessionFile = null;
    try { sessionFile = pathsH.mod ? path.join(pathsH.mod.dataHome(env), 'supervisor', 'session.json') : null; } catch { sessionFile = null; }
    if (!sessionFile || !fsImpl.existsSync(sessionFile)) return { name, status: 'ok', detail: 'no Supervisor session record' };
    let record = null;
    try { record = JSON.parse(fsImpl.readFileSync(sessionFile, 'utf8')); } catch { record = null; }
    if (!record || typeof record !== 'object') return { name, status: 'ok', detail: 'session.json unreadable' };
    state = typeof record.state === 'string' ? record.state : null;
    since = typeof record.updatedAt === 'string' ? record.updatedAt : null;
  }
  if (state !== 'needs-input') return { name, status: 'ok', detail: 'nothing waiting' };
  const sinceMs = since === null ? NaN : Date.parse(since);
  if (!Number.isFinite(sinceMs)) {
    return { name, status: 'warn', detail: `the Supervisor waits on a prompt (${source}) but the since-timestamp is unreadable`, fix: 'look at the dashboard Needs-you list or fenix attach' };
  }
  const ageMs = Math.max(0, now() - sinceMs);
  const minutes = Math.round(ageMs / 60000);
  const caveat = source === 'session.json' ? ' (from session.json — stale after an Esc-cancelled turn; the dashboard reads the pane)' : '';
  if (ageMs >= silenceMs) {
    return {
      name,
      status: 'warn',
      detail: `the Supervisor has waited on a permission prompt since ${since} (${minutes} min) — an unattended run stops here${caveat}`,
      fix: 'answer it: the Needs-you card on the dashboard, the Terminal tab, or fenix attach',
    };
  }
  return { name, status: 'ok', detail: `waiting on a prompt for ${minutes} min (under the ${Math.round(silenceMs / 60000)}-min threshold)${caveat}` };
}

// FOC-943: one line about the Supervisor's DECLARED permission mode — the
// launcher passes --permission-mode on the claude argv, so the session's mode
// is never whatever Claude Code persisted from a dialog answer. A bad env
// value is a warn (the launch itself fails loudly; the doctor must still
// answer), never a silent pass.
export function checkPermissionMode({ env = process.env } = {}) {
  const name = 'permission mode';
  if (!supervisorLaunchH.mod) return helperFail(name, supervisorLaunchH);
  try {
    const { mode, source } = supervisorLaunchH.mod.resolveSupervisorPermissionMode(env);
    return {
      name,
      status: 'ok',
      detail: source === 'env'
        ? `${mode} (declared via FENIX_SUPERVISOR_PERMISSION_MODE; not read from the running session)`
        : 'auto (declared launch default for the container Supervisor; not read from the running session)',
    };
  } catch (err) {
    return {
      name,
      status: 'warn',
      detail: String(err?.message || err).split('\n')[0],
      fix: 'set FENIX_SUPERVISOR_PERMISSION_MODE to auto|default|acceptEdits|plan or unset it',
    };
  }
}

// The host's GET /state, or null when no host is configured (native mode);
// { unreachable: true } when the host is configured but does not answer 200.
async function defaultHostState(env) {
  if (!hostClientH.mod) return { unreachable: true };
  if (!hostClientH.mod.hostBase(env)) return null;
  const res = await hostClientH.mod.hostRequest('GET', '/state', null, { timeoutMs: hostClientH.mod.FAST_TIMEOUT_MS, env });
  if (res && res.status === 200 && res.body && typeof res.body === 'object') return res.body;
  return { unreachable: true };
}

// FOC-905: one line about who owns the runs in this state home. The read is a
// small injectable seam (readOwners) so tests can fake it — like
// checkTaskSessions's readSessions — and the default walks the run dirs of
// supervisorStateRoot(env) through listRunOwners. Foreign runs (another
// host/container wrote them into the same state home) are a warn, never a
// fail: they are unsupported but must not be destructive, and the scan never
// sweeps them without the explicit override.
export function checkRunOwners({ env = process.env, readOwners } = {}) {
  const name = 'run owners';
  const missing = firstUnloaded(runOwnersH);
  if (missing) return helperFail(name, missing);
  const stateRoot = runOwnersH.mod.supervisorStateRoot(env);
  const entries = (readOwners ?? (() => runOwnersH.mod.listRunOwners(stateRoot)))(stateRoot);
  if (entries.length === 0) return { name: 'run owners', status: 'ok', detail: 'no supervisor runs yet' };
  const current = runOwnersH.mod.currentOwner(env);
  const counts = { mine: 0, restarted: 0, foreign: 0, unknown: 0 };
  const foreignHostnames = new Set();
  for (const { owner } of entries) {
    const { relation } = runOwnersH.mod.ownerRelation(owner, current);
    counts[relation]++;
    if (relation === 'foreign' && owner?.hostname) foreignHostnames.add(owner.hostname);
  }
  if (counts.foreign > 0) {
    return {
      name: 'run owners',
      status: 'warn',
      detail:
        `${counts.foreign} run(s) owned by another host/container (${[...foreignHostnames].sort().join(', ')}) ` +
        'share this state home — N containers over one /data is unsupported; they are never swept automatically ' +
        '(supervisor-orphans --all --yes)',
      fix: 'sweep them anyway: node scripts/supervisor-orphans.mjs --container --all --yes',
    };
  }
  return {
    name: 'run owners',
    status: 'ok',
    detail: `${entries.length} runs: mine ${counts.mine}, restarted ${counts.restarted}, legacy ${counts.unknown}`,
  };
}

// FOC-803: the image must be built for the host user's uid/gid. When it was
// not, the bind-mounted host files keep their host ownership and stay
// unreadable/unwritable inside the container: the Compose secrets (written
// 0600 by `fenix keys` on the host) and the project-map directory mounted at
// /fenix-config. Both checks run only in the container; paths are injectable
// so tests can point them at temp files. Exported for those tests.
const DEFAULT_SECRETS_DIR = '/run/secrets';

/**
 * FOC-988: is the code in the container the code in the image? The build bakes
 * a manifest of SHA-256 sums (scripts/fenix-manifest.mjs) outside the writable
 * tree; this re-hashes the live tree. A file that differs or is gone is a FAIL —
 * the Supervisor patched Fenix four times on the FOC-789 run and told nobody; a
 * file the image does not have is a WARN. Container only (natively the checkout
 * is meant to change); null elsewhere.
 */
export function checkFenixCode({ env = process.env, fsImpl = fs, manifestPath, root } = {}) {
  if (env.FENIX_IN_CONTAINER !== '1') return null;
  const name = 'fenix code';
  const manifest = readManifest(manifestPath || env.LA_FENIX_MANIFEST || DEFAULT_MANIFEST_PATH, fsImpl);
  if (manifest === null) {
    return { name, status: 'warn', detail: 'no manifest in this image (built before FOC-988) — drift cannot be checked', fix: TOOL_FIX };
  }
  if (manifest.error) {
    return { name, status: 'fail', detail: manifest.error, fix: TOOL_FIX };
  }
  const drift = compareToManifest(manifest, path.resolve(root || env.LA_ROOT || '/opt/fenix'), fsImpl);
  const changed = [...drift.modified.map((f) => `${f} (modified)`), ...drift.missing.map((f) => `${f} (missing)`)];
  const list = (items) => `${items.slice(0, 5).join(', ')}${items.length > 5 ? `, … +${items.length - 5}` : ''}`;
  if (changed.length) {
    return {
      name,
      status: 'fail',
      detail: `${changed.length} file(s) differ from the image: ${list(changed)} — Fenix's own code was changed at runtime; the Supervisor must raise a hold, never patch it`,
      fix: 'fenix update restores the image; read the Supervisor transcript for what it changed and why',
    };
  }
  if (drift.added.length) {
    return { name, status: 'warn', detail: `${drift.added.length} file(s) not in the image: ${list(drift.added)}`, fix: 'check what created them; fenix update restores the image' };
  }
  return { name, status: 'ok', detail: `${Object.keys(manifest.files).length} files match the image manifest` };
}

/** Every file under secretsDir that exists must be readable by this process. */
export function checkSecretsReadable(env, fsImpl, secretsDir = DEFAULT_SECRETS_DIR) {
  let names;
  try {
    names = fsImpl.readdirSync(secretsDir);
  } catch (err) {
    // No secrets at all yet — checkKeys already reports the missing keys.
    return { name: 'secrets readable', status: 'warn', detail: `${secretsDir} not listable (${err.message})`, fix: 'fenix keys' };
  }
  const unreadable = names.filter((name) => {
    try {
      fsImpl.accessSync(path.join(secretsDir, name), fsImpl.constants.R_OK);
      return false;
    } catch {
      return true;
    }
  });
  if (unreadable.length) {
    return {
      name: 'secrets readable',
      status: 'fail',
      detail: `${unreadable.length} of ${names.length} file(s) under ${secretsDir} not readable: ${unreadable.join(', ')}`,
      fix: UID_FIX,
    };
  }
  return { name: 'secrets readable', status: 'ok', detail: `${names.length} file(s) readable under ${secretsDir}` };
}

/** LA_PROJECTS_FILE's directory exists but must also be writable. */
export function checkProjectsDir(env, fsImpl, projectsFile) {
  const file = projectsFile || env.LA_PROJECTS_FILE || '/fenix-config/projects.json';
  const dir = path.dirname(file);
  try {
    fsImpl.statSync(dir);
  } catch (err) {
    // The host dir is created by `fenix up`; a missing one is a setup state,
    // not the uid mismatch this check exists for.
    return { name: 'config writable', status: 'warn', detail: `${dir} missing (${err.message})`, fix: 'fenix up' };
  }
  try {
    fsImpl.accessSync(dir, fsImpl.constants.W_OK);
    return { name: 'config writable', status: 'ok', detail: dir };
  } catch (err) {
    return { name: 'config writable', status: 'fail', detail: `${dir} not writable (${err.message})`, fix: UID_FIX };
  }
}

// FOC-772: the optional integrations are off by default, so absence is the
// healthy state. An ENABLED integration whose prerequisite is missing is a
// misconfiguration the doctor names — warn, never fail: every integration
// degrades gracefully when its prerequisite is absent. Settings come in
// through the runChecks seam so tests need no real overlay.
function checkIntegrations(env, settings) {
  const name = 'integrations';
  if (!integrationsH.mod) return helperFail(name, integrationsH);
  let integrations;
  try {
    integrations = integrationsH.mod.readIntegrations({ settings, env });
  } catch (err) {
    return {
      name,
      status: 'warn',
      detail: `settings invalid (${String(err.message).split('\n')[0]})`,
      fix: 'fix settings.json, then re-run fenix doctor',
    };
  }
  const enabled = integrationsH.mod.INTEGRATIONS.filter((name) => integrations[name]);
  if (!enabled.length) return { name, status: 'ok', detail: 'none enabled' };

  let anyMissing = false;
  const parts = enabled.map((name) => {
    const { ok, missing, required } = integrationsH.mod.prerequisites(name, env);
    if (ok) return required.length ? `${name} (${required.join(', ')})` : name;
    anyMissing = true;
    return `${name} enabled but missing ${missing.join(', ')}`;
  });
  return {
    name,
    status: anyMissing ? 'warn' : 'ok',
    detail: parts.join('; '),
    ...(anyMissing ? { fix: 'set the missing variables in .env, or run fenix keys for API keys' } : {}),
  };
}

/**
 * Run every check in order. Dependencies are injectable so future tests can
 * pass fakes: spawn (spawnSync-shaped), fsImpl (mkdirSync/accessSync/
 * constants/statfsSync), fetchImpl (fetch-shaped), env, withApi, settings
 * (the overlay object — the integrations check and the disk check's warn
 * threshold; default: the real one), FOC-780: `retention` is the async
 * logs-usage snapshot reader (default: cachedRetention), secretsDir,
 * projectsFile.
 * @returns {Promise<Array<{ name, status: 'ok'|'warn'|'fail', detail, fix? }>>}
 */
export async function runChecks({ env = process.env, withApi = false, spawn = spawnSync, fsImpl = fs, fetchImpl = fetch, settings, secretsDir, projectsFile, retention } = {}) {
  // FOC-1068: the manifest pass first. It is the check that names a deleted
  // module and it needs no helper beyond fenix-manifest.mjs, so it must be able
  // to answer even when a helper below did not load. Its output position is
  // unchanged (a test pins it): it is computed early, not printed early.
  const code = checkFenixCode({ env, fsImpl });
  const policy = resolveRetentionSafe(settings);
  const cachePolicy = resolveCacheMaxGbSafe(settings);
  const retentionReader =
    retention ??
    (retentionH.mod ? () => retentionH.mod.cachedRetention() : () => Promise.reject(retentionH.error));
  const checks = [
    checkNode(),
    ...REQUIRED_TOOLS.map(([name, args]) => applyGhFloor(checkTool(spawn, name, args, 'fail'), env)),
    ...OPTIONAL_TOOLS.map(([name, args]) => checkTool(spawn, name, args, 'warn')),
    ...checkKeys(env),
    checkIntegrations(env, settings),
    ...checkDirs(env, fsImpl),
    checkDisk(env, fsImpl, policy),
    await checkLogsUsage(retentionReader),
    await checkCaches({ env, fsImpl, cacheMaxGb: cachePolicy.cacheMaxGb ?? undefined }),
    checkCockpitHooks(env, fsImpl),
    checkTaskSessions({ env, fsImpl }),
    await checkSupervisorPrompt({ env, fsImpl }),
    checkPermissionMode({ env }),
    checkRunOwners({ env }),
  ];
  // FOC-803 uid checks: only meaningful in the container, where the process
  // runs as the image's user against host-owned bind mounts.
  if (env.FENIX_IN_CONTAINER === '1') {
    // FOC-988 first: the two uid checks stay the last two lines of the container
    // block (a test pins their position).
    if (code) checks.push(code);
    checks.push(checkSecretsReadable(env, fsImpl, secretsDir), checkProjectsDir(env, fsImpl, projectsFile));
  }
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
