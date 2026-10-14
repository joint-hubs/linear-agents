// scripts/fenix-retention.mjs — read-only retention + disk-usage snapshot for
// the Settings › Retention view (FOC-786).
//
// Why: the view shows the cleanup policy in force (Claude Code's
// cleanupPeriodDays per squad), how much disk the transcripts / telemetry /
// workspaces / run-state trees use, and free disk, with a "managed by FOC-780"
// note. Changing the policy is FOC-780 — this library never deletes or edits
// anything: it only reads settings files and walks trees to sum sizes.
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
import { dataHome, squadConfigRoot, stateRoot, telemetryHome } from "./fenix-paths.mjs";

const KEEP_ALL_MIN_DAYS = 3650;
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
