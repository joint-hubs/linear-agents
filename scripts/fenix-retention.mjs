// scripts/fenix-retention.mjs — retention policy + disk-usage snapshot for the
// Settings › Retention view (FOC-786 read path, FOC-780 apply/prune path).
//
// Why: the view shows the cleanup policy in force (Claude Code's
// cleanupPeriodDays per squad), how much disk the transcripts / telemetry /
// workspaces / run-state trees use, and free disk. FOC-780 adds the writer
// side: the overlay's `retention` key decides the policy, `applyRetention`
// writes `cleanupPeriodDays` into every squad settings.json, `pruneRuns`
// deletes Fenix's own run directories past the limit — never by default
// (keepDays null keeps everything, logs are training data) and never a run
// the Supervisor may still be inside: the current-run pointer names it, the
// registry was touched recently, or a listed child is still alive.
//
// Where it reads:
//   <squadHome>/<squad>/settings.json      cleanupPeriodDays (missing -> null)
//   <squadHome>/<squad>/projects/**        transcript bytes (Claude Code keeps
//                                          transcripts under each squad config
//                                          dir's projects/)
//   telemetryHome / workspacesRoot / stateRoot   byte totals
//
// Walks are async (fs.promises.opendir), never follow symlinks, ignore
// per-entry errors (counted in `unreadable`), yield to the event loop every
// ~500 entries, and stop at a hard entry cap per root (env
// FENIX_RETENTION_MAX_ENTRIES, default 2,000,000) — past the cap the root's
// byte total is a lower bound and the root is flagged in `partial`.
// Free disk comes from fs.promises.statfs where the Node version has it
// (>= 18.15); otherwise `disk` is null.

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dataHome,
  runsDir as defaultRunsDir,
  squadConfigRoot,
  stateRoot,
  SUPERVISOR_SESSION_ID_PATTERN,
  supervisorCurrentRunPath,
  telemetryHome,
} from "./fenix-paths.mjs";
import { readSettings, validateSettings } from "./fenix-settings.mjs";
import { readCurrentRun } from "./supervisor-current-run.mjs";
// The state home and the current-run pointer MUST resolve the way the
// Supervisor itself does, so the helper comes from supervisor-lib, not from a
// stateRoot()-derived lookalike (the two disagree when LA_STATE_ROOT is set
// without LA_SUPERVISOR_STATE_HOME — the container's arrangement).
import { supervisorStateHome } from "./supervisor-lib.mjs";
import { atomicWriteJSON } from "./utils.mjs";

const KEEP_ALL_MIN_DAYS = 3650;
// The cleanupPeriodDays every squad settings.json gets when the overlay keeps
// everything — 100 years, effectively "never" (FOC-780 decision 2026-10-11).
const KEEP_EVERYTHING_DAYS = 36500;
const DEFAULT_MIN_FREE_GIB = 5;
const DAY_MS = 86_400_000;
// Same liveness definition as supervisor-lib.mjs liveChildren — the process
// side of "this run may still write its own logs".
const LIVE_STATUSES = ["starting", "running"];
const DEFAULT_MAX_ENTRIES = 2_000_000;
const YIELD_EVERY_ENTRIES = 500;
const MANAGED_BY = "FOC-780";

// Classify the per-squad cleanupPeriodDays values (null = unset, ignored):
// keep-all when every value >= 3650, days when all are equal and smaller,
// mixed otherwise, unknown when there is no value at all.
function classifyPolicy(values) {
  const set = values.filter((v) => v !== null);
  if (set.length === 0) return "unknown";
  if (set.every((v) => v >= KEEP_ALL_MIN_DAYS)) return "keep-all";
  if (set[0] < KEEP_ALL_MIN_DAYS && set.every((v) => v === set[0])) return "days";
  return "mixed";
}

// cleanupPeriodDays from one squad's settings.json — null when the file is
// missing, unparseable, or the value is not a non-negative number.
async function readCleanupDays(path) {
  let raw;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const v = parsed?.cleanupPeriodDays;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function newBudget(maxEntries) {
  return { entries: 0, sinceYield: 0, partial: false, max: maxEntries };
}

// One usage root: { bytes, unreadable } summed over a walk of the tree. The
// shared `budget` carries the entry count and the partial flag so several
// walks (the per-squad projects dirs) draw on one per-root entry cap.
// A missing root (ENOENT) is an empty total, not an unreadable one.
async function walkBytes(root, budget, lstatImpl) {
  const out = { bytes: 0, unreadable: 0 };
  let st;
  try {
    st = await lstatImpl(root);
  } catch (err) {
    if (err?.code !== "ENOENT") out.unreadable += 1;
    return out;
  }
  if (st.isSymbolicLink()) return out; // never follow, not even the root
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop();
    let dh;
    try {
      dh = await fs.opendir(dir);
    } catch (err) {
      if (err?.code !== "ENOENT") out.unreadable += 1;
      continue;
    }
    try {
      for (;;) {
        let ent;
        try {
          ent = await dh.read();
        } catch {
          out.unreadable += 1;
          break;
        }
        if (ent === null) break;
        budget.entries += 1;
        if (budget.entries > budget.max) {
          budget.partial = true;
          return out;
        }
        const full = join(dir, ent.name);
        let est;
        try {
          est = await lstatImpl(full);
        } catch {
          out.unreadable += 1;
          continue;
        }
        if (est.isSymbolicLink()) continue; // never follow a link
        if (est.isDirectory()) queue.push(full);
        else out.bytes += Number(est.size);
        budget.sinceYield += 1;
        if (budget.sinceYield >= YIELD_EVERY_ENTRIES) {
          budget.sinceYield = 0;
          await new Promise((wakeup) => setImmediate(wakeup));
        }
      }
    } finally {
      try {
        await dh.close();
      } catch {}
    }
    if (budget.partial) return out;
  }
  return out;
}

function parseMaxEntries() {
  const raw = process.env.FENIX_RETENTION_MAX_ENTRIES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_ENTRIES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_ENTRIES;
}

// workspacesRoot default: GITHUB_ROOT (the projects root) or <dataHome>/workspaces.
function defaultWorkspacesRoot() {
  const gh = process.env.GITHUB_ROOT;
  return gh ? resolve(gh) : join(dataHome(), "workspaces");
}

// Free disk: the first usage root statfs can read (workspaces, then telemetry,
// state, squad home — in the container they share one volume). All roots live
// on the same volume in a real deployment, so any of them answers; null when
// statfs is not available (Node < 18.15) or no path can be statted.
async function freeDisk(candidates) {
  if (typeof fs.statfs !== "function") return null;
  for (const path of candidates) {
    try {
      const s = await fs.statfs(path);
      const blockSize = Number(s.bsize);
      return {
        freeBytes: Number(s.bfree) * blockSize,
        totalBytes: Number(s.blocks) * blockSize,
      };
    } catch {
      continue; // missing or unstattable — try the next root
    }
  }
  return null;
}

export async function readRetention(opts = {}) {
  const squadHome = opts.squadHome ?? squadConfigRoot();
  const telemetryRoot = opts.telemetryHome ?? telemetryHome();
  const workspacesRoot = opts.workspacesRoot ?? defaultWorkspacesRoot();
  const stateRootDir = opts.stateRoot ?? stateRoot();
  const maxEntries = parseMaxEntries();
  const lstatImpl = opts.lstatImpl ?? ((p) => fs.lstat(p));

  // Squads: real directories under squadHome (symlinked ones skipped).
  let squads = [];
  try {
    squads = (await fs.readdir(squadHome, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    squads = [];
  }
  const cleanupPeriodDays = {};
  for (const squad of squads) {
    cleanupPeriodDays[squad] = await readCleanupDays(join(squadHome, squad, "settings.json"));
  }

  // Byte totals — each root gets its own entry budget.
  const partial = [];
  const unreadable = { transcripts: 0, telemetry: 0, workspaces: 0, state: 0 };
  const bytes = {};

  const transcriptBudget = newBudget(maxEntries);
  let transcriptBytes = 0;
  for (const squad of squads) {
    const walked = await walkBytes(join(squadHome, squad, "projects"), transcriptBudget, lstatImpl);
    transcriptBytes += walked.bytes;
    unreadable.transcripts += walked.unreadable;
    if (transcriptBudget.partial) break;
  }
  bytes.transcripts = transcriptBytes;
  if (transcriptBudget.partial) partial.push("transcripts");

  for (const [name, root] of [
    ["telemetry", telemetryRoot],
    ["workspaces", workspacesRoot],
    ["state", stateRootDir],
  ]) {
    const budget = newBudget(maxEntries);
    const walked = await walkBytes(root, budget, lstatImpl);
    bytes[name] = walked.bytes;
    unreadable[name] = walked.unreadable;
    if (budget.partial) partial.push(name);
  }

  return {
    policy: classifyPolicy(Object.values(cleanupPeriodDays)),
    cleanupPeriodDays,
    usage: {
      transcriptsBytes: bytes.transcripts,
      telemetryBytes: bytes.telemetry,
      workspacesBytes: bytes.workspaces,
      stateBytes: bytes.state,
    },
    disk: await freeDisk([workspacesRoot, telemetryRoot, stateRootDir, squadHome]),
    computedAt: new Date(opts.now ?? Date.now()).toISOString(),
    managedBy: MANAGED_BY,
    partial,
    unreadable,
  };
}

// One snapshot per option-set in flight; the last result is served with its
// own computedAt until the TTL expires.
const cache = new Map();

function cacheKey(opts) {
  return JSON.stringify([
    opts.squadHome ?? null,
    opts.telemetryHome ?? null,
    opts.workspacesRoot ?? null,
    opts.stateRoot ?? null,
  ]);
}

export function cachedRetention(opts = {}, { ttlMs = 60000 } = {}) {
  const key = cacheKey(opts);
  const hit = cache.get(key);
  if (hit?.result && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.result);
  if (hit?.pending) return hit.pending;
  const pending = readRetention(opts).then((result) => {
    cache.set(key, { result, at: Date.now() });
    return result;
  });
  cache.set(key, { pending });
  // On failure drop the entry so the next call retries.
  pending.catch(() => {
    const current = cache.get(key);
    if (current?.pending === pending) cache.delete(key);
  });
  return pending;
}

// The prunable estimate (pruneRuns dry-run), cached one entry per settings
// fingerprint — keepDays plus the roots and the current-run pointer set the
// estimate depends on — in the same style as cachedRetention. `pruneImpl` is
// the test seam (a counting spy proves the route's GET serves one walk for any
// number of GETs). A pinned `now` is not cacheable: the caller asks for a
// deterministic answer, so it gets a fresh walk every time.
const pruneCache = new Map();

async function pruneCacheKey(opts) {
  const { keepDays } = resolveRetention(opts.settings ?? readSettings());
  const current = [...(await currentRunIdSet(opts.currentRunPaths))].sort();
  return JSON.stringify([keepDays, opts.runsDir ?? null, opts.supervisorHome ?? null, current]);
}

export async function cachedPrunable(opts = {}, { ttlMs = 60000, pruneImpl = pruneRuns } = {}) {
  if (opts.now !== undefined) return pruneImpl(opts);
  const key = await pruneCacheKey(opts);
  const hit = pruneCache.get(key);
  if (hit?.result && Date.now() - hit.at < ttlMs) return hit.result;
  if (hit?.pending) return hit.pending;
  const pending = Promise.resolve(pruneImpl(opts)).then((result) => {
    pruneCache.set(key, { result, at: Date.now() });
    return result;
  });
  pruneCache.set(key, { pending });
  // On failure drop the entry so the next call retries.
  pending.catch(() => {
    const current = pruneCache.get(key);
    if (current?.pending === pending) pruneCache.delete(key);
  });
  return pending;
}

// ---------------------------------------------------------------------------
// Apply / prune (FOC-780). The overlay's `retention` key is the single policy;
// these functions are its only writers. keepDays null (the default) means keep
// everything: apply then pins cleanupPeriodDays 36500 everywhere, prune
// refuses outright — logs are training data, deletion is opt-in.
// ---------------------------------------------------------------------------

// cleanupPeriodDays from a parsed settings object, normalised to a number or
// null — same coercion readCleanupDays applies, so "already applied" is judged
// on the value, not on the spelling ("36500" vs 36500).
function normaliseCleanupDays(value) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The overlay's retention policy as concrete numbers. */
export function resolveRetention(settings = readSettings()) {
  const retention = isPlainSettings(settings) ? settings.retention : undefined;
  if (retention !== undefined && retention !== null) {
    const { ok, errors } = validateSettings({ retention });
    if (!ok) throw new Error(`retention settings are invalid:\n- ${errors.join("\n- ")}`);
  }
  const keepDays = retention?.keepDays ?? null;
  const minFreeGiB = retention?.minFreeGiB ?? DEFAULT_MIN_FREE_GIB;
  return { keepDays, cleanupPeriodDays: keepDays ?? KEEP_EVERYTHING_DAYS, minFreeGiB };
}

function isPlainSettings(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Mirror of agent-records.mjs's validRunId (not exported there) — a run
// directory's name must be run-id shaped, so noise under the roots is
// surfaced, never considered for deletion.
const ANY_RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
function validRunId(name) {
  return typeof name === "string" && ANY_RUN_ID_RE.test(name) && name !== "." && name !== "..";
}

// The registry (children.json) freshness used as a liveness proxy: a registry
// written within the last day means the session lived recently even when every
// child it lists has already exited.
const RECENT_ACTIVITY_WINDOW_MS = DAY_MS;

/**
 * The run ids named by the Supervisor's current-run pointers: the legacy
 * global one (<dataHome>/supervisor/current-run.json) plus one per managed
 * session under <dataHome>/supervisor/sessions/<id>/ (only pattern-valid ids
 * compose a path — the same guard supervisorSessionHome applies). Every
 * pointer is read with supervisor-current-run's readCurrentRun, the same
 * helper the Supervisor resolves its run with. Missing/garbled pointers read
 * as "no pointer"; the set is what pruneRuns never deletes.
 */
async function currentRunIdSet(currentRunPaths, env = process.env, platform = process.platform) {
  const paths = [...(currentRunPaths ?? [supervisorCurrentRunPath(env, platform)])];
  if (!currentRunPaths) {
    try {
      const sessions = join(dataHome(env, platform), "supervisor", "sessions");
      for (const ent of await fs.readdir(sessions, { withFileTypes: true })) {
        if (ent.isDirectory() && SUPERVISOR_SESSION_ID_PATTERN.test(ent.name)) {
          paths.push(join(sessions, ent.name, "current-run.json"));
        }
      }
    } catch {
      // no sessions directory — the global pointer is all there is
    }
  }
  const ids = new Set();
  for (const path of paths) {
    const record = readCurrentRun({ path });
    if (record) ids.add(record.runId);
  }
  return ids;
}

/** Real (non-symlink) subdirectories of a directory, sorted. */
async function listSubdirectories(root) {
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Write the resolved cleanupPeriodDays into every squad settings.json under
 * squadHome — only where the value differs, atomically, preserving the file's
 * own key order (the key is set in place). A squad without a settings.json
 * gets one. Unreadable/invalid files are reported under `skipped`, never
 * thrown. Dry-run computes the same report and writes nothing.
 */
export async function applyRetention({ dryRun = false, squadHome, settings } = {}) {
  squadHome ??= squadConfigRoot();
  const resolved = resolveRetention(settings ?? readSettings());
  const changed = [];
  const unchanged = [];
  const skipped = [];
  for (const squad of await listSubdirectories(squadHome)) {
    const path = join(squadHome, squad, "settings.json");
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(path, "utf8"));
    } catch (err) {
      if (err?.code !== "ENOENT") {
        skipped.push({ squad, reason: err instanceof SyntaxError ? "invalid json" : "unreadable" });
        continue;
      }
      parsed = {}; // no settings yet — the file is created below
    }
    if (!isPlainSettings(parsed)) {
      skipped.push({ squad, reason: "not an object" });
      continue;
    }
    const from = normaliseCleanupDays(parsed.cleanupPeriodDays);
    if (from === resolved.cleanupPeriodDays) {
      unchanged.push(squad);
      continue;
    }
    if (!dryRun) {
      parsed.cleanupPeriodDays = resolved.cleanupPeriodDays; // in place: key order kept
      atomicWriteJSON(path, parsed);
    }
    changed.push({ squad, from, to: resolved.cleanupPeriodDays });
  }
  return { cleanupPeriodDays: resolved.cleanupPeriodDays, changed, unchanged, skipped };
}

// Newest mtime and byte total of a run directory tree, symlinks never
// followed. unreadable > 0 means part of the tree could not be statted — the
// caller cannot then prove the run has no live child, so it skips instead.
// Entries draw on the caller's `budget` (same cap as walkBytes); when the cap
// is hit the walk stops early and budget.partial goes true — the caller cannot
// then prove the run is stale either, so it skips with a `cap` reason.
async function runDirStats(dir, budget) {
  const out = { newestMs: 0, bytes: 0, unreadable: 0 };
  let rootStat;
  try {
    rootStat = await fs.lstat(dir);
  } catch {
    out.unreadable += 1;
    return out;
  }
  out.newestMs = Number(rootStat.mtimeMs);
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.pop();
    let dirents;
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch {
      out.unreadable += 1;
      continue;
    }
    for (const ent of dirents) {
      budget.entries += 1;
      if (budget.entries > budget.max) {
        budget.partial = true;
        return out;
      }
      const full = join(current, ent.name);
      let st;
      try {
        st = await fs.lstat(full);
      } catch {
        out.unreadable += 1;
        continue;
      }
      const mtimeMs = Number(st.mtimeMs);
      if (mtimeMs > out.newestMs) out.newestMs = mtimeMs;
      if (st.isDirectory()) queue.push(full);
      else if (!st.isSymbolicLink()) out.bytes += Number(st.size);
    }
  }
  return out;
}

// Mirror of the cleanup's registry check: a run whose children.json lists a
// child with a live status or a pid that answers a signal is still alive.
// Returns null when the run is safe to prune, or a skip reason.
async function liveChildReason(runDir) {
  const path = join(runDir, "children.json");
  let raw;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    return err?.code === "ENOENT" ? null : "unreadable-registry";
  }
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch {
    // A registry we cannot read is not a registry we can prove dead.
    return "unreadable-registry";
  }
  const children = Object.values(isPlainSettings(registry) ? (registry.children ?? {}) : {});
  for (const child of children) {
    if (child && typeof child === "object") {
      if (LIVE_STATUSES.includes(child.status)) return "live-child";
      if (child.pid) {
        try {
          process.kill(Number(child.pid), 0);
          return "live-child"; // alive, ours to signal
        } catch (err) {
          if (err?.code === "EPERM") return "live-child"; // alive, not ours
          // ESRCH — dead; keep looking at the other children
        }
      }
    }
  }
  return null;
}

/**
 * Delete run directories older than keepDays, from both run roots: the
 * run-state tree (<stateRoot>/runs) and the Supervisor state home (resolved
 * with supervisor-lib's own helper — LA_SUPERVISOR_STATE_HOME or
 * <repoRoot>/.state/supervisor). A run is pruned when its newest mtime is
 * older than the cutoff and it has no live child; everything else is reported
 * under `skipped` with a reason:
 *   current-run        the Supervisor's current-run pointer names it — never
 *                      deleted, regardless of age
 *   recent-activity    children.json was written less than 24 h ago — the
 *                      session lived recently even if every child has exited
 *   not-a-run          the directory name is not a run id
 *   cap                the entry cap was hit before the run's tree was fully
 *                      scanned — the walk cannot prove the run is stale
 *   live-child / unreadable-registry / unreadable   as before
 * Per-run deletions are isolated: an fs error (EBUSY, EPERM, …) lands in
 * `failed: [{ runId, error }]` and the walk continues — `failed` non-empty
 * means exit 1 at the CLI. keepDays null refuses without touching disk.
 * Dry-run reports the same lists and deletes nothing.
 */
export async function pruneRuns({
  dryRun = false,
  now = Date.now(),
  settings,
  runsDir,
  supervisorHome,
  currentRunPaths,
  rmImpl,
} = {}) {
  const { keepDays } = resolveRetention(settings ?? readSettings());
  if (keepDays === null) return { refused: "retention keeps everything", pruned: [] };
  const cutoff = now - keepDays * DAY_MS;
  const roots = [runsDir ?? defaultRunsDir(), supervisorHome ?? resolve(supervisorStateHome())];
  const rm = rmImpl ?? ((path) => fs.rm(path, { recursive: true, force: true }));
  const budget = newBudget(parseMaxEntries());
  const currentRuns = await currentRunIdSet(currentRunPaths);
  const pruned = [];
  const skipped = [];
  const failed = [];
  let bytes = 0;
  for (const root of roots) {
    for (const runId of await listSubdirectories(root)) {
      if (!validRunId(runId)) {
        skipped.push({ runId, reason: "not-a-run" });
        continue;
      }
      if (currentRuns.has(runId)) {
        skipped.push({ runId, reason: "current-run" });
        continue;
      }
      const runDir = join(root, runId);
      // The cheapest liveness veto, checked before any tree walk: a registry
      // touched inside the window is a session that lived recently.
      try {
        const registry = await fs.lstat(join(runDir, "children.json"));
        if (now - Number(registry.mtimeMs) < RECENT_ACTIVITY_WINDOW_MS) {
          skipped.push({ runId, reason: "recent-activity" });
          continue;
        }
      } catch {
        // missing — nothing to veto; unreadable — liveChildReason reports it
      }
      const reason = await liveChildReason(runDir);
      if (reason) {
        skipped.push({ runId, reason });
        continue;
      }
      const stats = await runDirStats(runDir, budget);
      if (budget.partial) {
        skipped.push({ runId, reason: "cap" });
        continue;
      }
      if (stats.unreadable > 0) {
        skipped.push({ runId, reason: "unreadable" });
        continue;
      }
      if (stats.newestMs >= cutoff) continue; // fresh enough — not reported
      if (!dryRun) {
        try {
          await rm(runDir);
        } catch (err) {
          failed.push({ runId, error: err?.code || err?.message || String(err) });
          continue;
        }
      }
      pruned.push({ runId, bytes: stats.bytes, newestAt: new Date(stats.newestMs).toISOString() });
      bytes += stats.bytes;
    }
  }
  return { keepDays, cutoff: new Date(cutoff).toISOString(), pruned, skipped, failed, bytes, partial: budget.partial };
}

// ---------------------------------------------------------------------------
// CLI — `show`, `apply [--dry-run]`, `prune [--dry-run]` (the `fenix retention`
// launcher command forwards here). JSON to stdout; exit 1 when a prune is
// refused (keepDays null) or any deletion failed (`failed` non-empty), 2 on
// usage. All reads respect the path seams
// (LA_SETTINGS_FILE, LA_SQUAD_HOME, LA_STATE_ROOT, LA_SUPERVISOR_STATE_HOME).
// ---------------------------------------------------------------------------

function usage() {
  console.error("Usage: node scripts/fenix-retention.mjs show");
  console.error("       node scripts/fenix-retention.mjs apply [--dry-run]");
  console.error("       node scripts/fenix-retention.mjs prune [--dry-run]");
  process.exit(2);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");
  if (rest.some((arg) => arg !== "--dry-run")) usage();
  if (cmd === "show") {
    console.log(JSON.stringify({ retention: await readRetention(), resolved: resolveRetention() }, null, 2));
    return;
  }
  if (cmd === "apply") {
    console.log(JSON.stringify(await applyRetention({ dryRun }), null, 2));
    return;
  }
  if (cmd === "prune") {
    const result = await pruneRuns({ dryRun });
    console.log(JSON.stringify(result, null, 2));
    if (result.refused || (result.failed?.length ?? 0) > 0) process.exit(1);
    return;
  }
  usage();
}

// Guard: only run main() when called directly (not when imported as module)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
