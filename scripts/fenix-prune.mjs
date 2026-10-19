// scripts/fenix-prune.mjs — FOC-808: cache-volume and child-tmp hygiene.
//
// The fenix-cache volume (/home/node/.cache, FOC-808 compose) collects package
// caches (npm, pip, uv, playwright) forever — nothing prunes them — and
// /tmp/fenix-child accumulates a directory per spawned child. This CLI sizes
// both, deletes the oldest cache entries by atime down to a cap, and removes
// the child tmp dirs whose child is not live in any Supervisor registry.
//
// Never touches /data: the roots are guarded (a /data cacheRoot or
// childTmpRoot is refused) and only the two roots' contents are ever removed —
// cache deletion is depth-2 only (the tool dirs themselves stay, npm/pip/uv
// rebuild their own subtrees), child-tmp deletion is one level deep.
//
// The docker build cache is a HOST-side concern: the docker socket is not
// mounted into the container, so its size is not visible from here — the
// report says so and points at `fenix prune --builder`.
//
// Roots are overridable for tests: LA_CACHE_ROOT, LA_CHILD_TMP_ROOT
// (LA_SUPERVISOR_STATE_HOME redirects the registry scan the way it redirects
// supervisor-lib). The cap default comes from the settings overlay's
// retention.cacheMaxGb (validated there, integer >= 1), else 5.
//
// Usage: node scripts/fenix-prune.mjs [report|prune] [--max-gb N] [--dry-run] [--json]
//   report (default) — sizes only
//   prune — applies the cap (also implied by --max-gb or --dry-run)
//   --dry-run — print what would go, write nothing
// Exit codes: 0 ok, 1 prune refused, 2 usage error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSettings } from "./fenix-settings.mjs";
import { pidAlive } from "./supervisor-current-run.mjs";
import { LIVE_STATUSES } from "./supervisor-lib.mjs";

// The cap's default — exported so fenix-doctor.mjs (which cannot edit
// fenix-retention.mjs to add it to resolveRetention) falls back to the same 5.
export const CACHE_MAX_GB_DEFAULT = 5;
const GB = 1024 ** 3;
// Same hard entry cap as fenix-retention.mjs — a walk past it gives a lower
// bound rather than hanging forever.
const MAX_ENTRIES = 2_000_000;
const DATA_HOME = "/data";
const CACHE_ROOT_DEFAULT = "/home/node/.cache";
const CHILD_TMP_ROOT_DEFAULT = "/tmp/fenix-child";
const STATE_HOME_DEFAULT = "/data/state/supervisor";

// ── guards ──────────────────────────────────────────────────────────────────

// prune never touches /data — refused loudly, not silently skipped. A root
// that exists is resolved with realpathSync first, so a symlinked root
// pointing into /data is refused too; a missing root stays "no data".
// `dataHome`/`fsImpl` are injectable for tests.
export function assertNotData(rawRoot, label, { dataHome = DATA_HOME, fsImpl = fs } = {}) {
  const raw = String(rawRoot);
  const underOrEqual = (p, home) => p === home || p.startsWith(home + "/") || p.startsWith(home + path.sep);
  if (underOrEqual(raw, dataHome)) throw new Error(`${label} must not be under ${DATA_HOME} — prune never touches /data`);
  let resolved;
  try {
    resolved = fsImpl.realpathSync(raw);
  } catch {
    return; // missing/unresolvable root — nothing on disk to hit
  }
  if (underOrEqual(path.normalize(resolved), path.normalize(dataHome))) {
    throw new Error(`${label} must not be under ${DATA_HOME} — prune never touches /data`);
  }
}

// ── size walking (sync, capped) ─────────────────────────────────────────────

function statSafe(fsImpl, p) {
  try {
    return fsImpl.statSync(p);
  } catch {
    return null;
  }
}

// Total bytes + entry count under root (never follows symlinks; unreadable
// entries are skipped, counted). Used for both the report's per-tool sizes and
// the depth-2 leaf sizes a prune deletes.
function walkBytes(fsImpl, root, acc = { bytes: 0, entries: 0 }) {
  if (acc.entries > MAX_ENTRIES) return acc;
  let dirents;
  try {
    dirents = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch {
    return acc; // unreadable root: counted as empty, report stays honest
  }
  for (const d of dirents) {
    if (acc.entries > MAX_ENTRIES) return acc;
    const p = path.join(root, d.name);
    if (d.isSymbolicLink()) continue;
    const st = statSafe(fsImpl, p);
    if (!st) continue;
    acc.entries += 1;
    if (d.isDirectory()) {
      acc.bytes += st.size; // the dir entry itself
      walkBytes(fsImpl, p, acc);
    } else {
      acc.bytes += st.size;
    }
  }
  return acc;
}

// Sizes of `/home/node/.cache/*` — one row per tool dir (npm, pip, uv, …).
export function cacheToolSizes(cacheRoot, fsImpl = fs) {
  let dirents;
  try {
    dirents = fsImpl.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return []; // missing/unreadable root: report shows nothing instead of 0 B
  }
  const tools = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const sub = path.join(cacheRoot, d.name);
    tools.push({ name: d.name, path: sub, ...walkBytes(fsImpl, sub, { bytes: 0, entries: 0 }) });
  }
  return tools.sort((a, b) => b.bytes - a.bytes);
}

// Depth-2 leaves under the cache root — the units a prune deletes. A directory
// leaf counts its whole subtree, a file leaf its own size.
export function cacheLeafEntries(cacheRoot, fsImpl = fs) {
  let subs;
  try {
    subs = fsImpl.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const leaves = [];
  for (const sub of subs) {
    if (!sub.isDirectory()) continue;
    const subPath = path.join(cacheRoot, sub.name);
    let dirents;
    try {
      dirents = fsImpl.readdirSync(subPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      const p = path.join(subPath, d.name);
      const st = statSafe(fsImpl, p);
      if (!st) continue;
      if (d.isDirectory()) {
        const acc = walkBytes(fsImpl, p, { bytes: 0, entries: 0 });
        leaves.push({ path: p, bytes: st.size + acc.bytes, atimeMs: st.atimeMs, isDir: true });
      } else {
        leaves.push({ path: p, bytes: st.size, atimeMs: st.atimeMs, isDir: false });
      }
    }
  }
  return leaves;
}

// ── prune ───────────────────────────────────────────────────────────────────

// Delete oldest-by-atime depth-2 leaves until the cache total is under cap.
// "Oldest" is atime, which under relatime/noatime mounts is coarse — at best
// the last write, at worst anything since the mount — but that is good enough
// for LRU eviction of package caches (they are re-downloadable anyway).
// Returns the plan even in dry-run (nothing written).
export function pruneCache({ cacheRoot, capBytes, dryRun = false, fsImpl = fs }) {
  assertNotData(cacheRoot, "cache root");
  const before = cacheToolSizes(cacheRoot, fsImpl).reduce((sum, t) => sum + t.bytes, 0);
  const leaves = cacheLeafEntries(cacheRoot, fsImpl).sort((a, b) => a.atimeMs - b.atimeMs);
  const removed = [];
  let total = before;
  for (const leaf of leaves) {
    if (total <= capBytes) break;
    if (!dryRun) {
      try {
        fsImpl.rmSync(leaf.path, { recursive: leaf.isDir, force: true });
      } catch (err) {
        removed.push({ path: leaf.path, bytes: leaf.bytes, atimeMs: leaf.atimeMs, error: String(err?.message || err) });
        continue;
      }
    }
    total -= leaf.bytes;
    removed.push(leaf);
  }
  // Failed leaves are NOT counted as freed: freedBytes is defined as
  // beforeBytes − afterBytes, and a leaf whose rmSync failed is still on disk,
  // so its bytes must remain in `total`.
  return {
    beforeBytes: before,
    removed,
    freedBytes: removed.reduce((s, r) => (r.error ? s : s + r.bytes), 0),
    afterBytes: Math.max(total, 0),
    capBytes,
  };
}

// Per-child sizes under /tmp/fenix-child (report side; the sweep does removal).
export function childTmpSizes(childTmpRoot, fsImpl = fs) {
  let dirents;
  try {
    dirents = fsImpl.readdirSync(childTmpRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const children = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const sub = path.join(childTmpRoot, d.name);
    children.push({ childId: d.name, path: sub, ...walkBytes(fsImpl, sub, { bytes: 0, entries: 0 }) });
  }
  return children;
}

// ── child tmp sweep ─────────────────────────────────────────────────────────

// Child ids whose registry row says they are still starting/running (and whose
// pid answers, when one is recorded). Scans every run dir with a children.json
// under stateRoot — the same shape supervisor-orphans.mjs reads. Corrupt or
// unreadable registries are skipped with a note, never treated as "all dead":
// that would delete a live child's dir.
export function liveChildIds(stateRoot, fsImpl = fs, isAlive = pidAlive) {
  const live = new Set();
  const errors = [];
  let dirents;
  try {
    dirents = fsImpl.readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return { live, errors }; // no state home yet: nothing is known live
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const regPath = path.join(stateRoot, d.name, "children.json");
    if (!fsImpl.existsSync(regPath)) continue;
    let registry;
    try {
      registry = JSON.parse(fsImpl.readFileSync(regPath, "utf8"));
    } catch (err) {
      errors.push(`${d.name}: children.json unreadable (${String(err?.message || err)})`);
      continue;
    }
    for (const [childId, child] of Object.entries(registry.children || {})) {
      const pidOk = child?.pid ? isAlive(child.pid) : true;
      if (LIVE_STATUSES.includes(child?.status) && pidOk) live.add(childId);
    }
  }
  return { live, errors };
}

// Remove /tmp/fenix-child/<childId> dirs whose child is not live. dryRun keeps
// everything and returns the same shape.
export function sweepChildTmp({ childTmpRoot, stateRoot, dryRun = false, fsImpl = fs, isAlive = pidAlive }) {
  assertNotData(childTmpRoot, "child tmp root");
  const { live, errors } = liveChildIds(stateRoot, fsImpl, isAlive);
  const removed = [];
  const kept = [];
  let dirents;
  try {
    dirents = fsImpl.readdirSync(childTmpRoot, { withFileTypes: true });
  } catch {
    return { removed, kept, errors };
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (live.has(d.name)) {
      kept.push(d.name);
      continue;
    }
    if (!dryRun) {
      try {
        fsImpl.rmSync(path.join(childTmpRoot, d.name), { recursive: true, force: true });
      } catch (err) {
        errors.push(`${d.name}: rm failed (${String(err?.message || err)})`);
        continue;
      }
    }
    removed.push(d.name);
  }
  return { removed, kept, errors };
}

// ── report / entry point ────────────────────────────────────────────────────

function humanBytes(n) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Number(n) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export const CACHE_ROOTS = {
  cache: () => process.env.LA_CACHE_ROOT || CACHE_ROOT_DEFAULT,
  childTmp: () => process.env.LA_CHILD_TMP_ROOT || CHILD_TMP_ROOT_DEFAULT,
  state: () => process.env.LA_SUPERVISOR_STATE_HOME || STATE_HOME_DEFAULT,
};

// The cap: explicit --max-gb wins, then the overlay's retention.cacheMaxGb,
// then 5 GB. A settings failure falls back silently — prune must still answer.
export function resolveCapBytes(maxGbArg) {
  if (maxGbArg !== undefined) {
    if (!Number.isInteger(maxGbArg) || maxGbArg < 1) {
      throw new UsageError(`--max-gb must be an integer >= 1 (got ${maxGbArg})`);
    }
    return maxGbArg * GB;
  }
  try {
    const v = readSettings()?.retention?.cacheMaxGb;
    if (Number.isInteger(v) && v >= 1) return v * GB;
  } catch {
    // settings unreadable/invalid — the default stands
  }
  return CACHE_MAX_GB_DEFAULT * GB;
}

class UsageError extends Error {}

function printReport(result) {
  const { cache, childTmp, builder } = result;
  console.log(`cache — cap ${humanBytes(cache.capBytes)} (retention.cacheMaxGb):`);
  if (!cache.tools.length) console.log("  (no tool dirs)");
  for (const t of cache.tools) console.log(`  ${t.name.padEnd(20)} ${humanBytes(t.bytes)}`);
  console.log(`  ${"total".padEnd(20)} ${humanBytes(cache.totalBytes)}`);
  console.log("child tmp:");
  if (!childTmp.children.length) console.log("  (no child dirs)");
  for (const c of childTmp.children) {
    console.log(`  ${c.childId.padEnd(20)} ${humanBytes(c.bytes)}${c.live ? " (live — kept)" : ""}`);
  }
  if (result.prune) {
    console.log(`prune — removed ${result.prune.removed.length} cache entr${result.prune.removed.length === 1 ? "y" : "ies"} (${humanBytes(result.prune.freedBytes)}), kept ${childTmp.kept.length} live child dir(s), removed ${childTmp.removed.length} dead`);
    for (const r of result.prune.removed.slice(0, 10)) console.log(`  - ${r.path} (${humanBytes(r.bytes)})${r.error ? ` — FAILED: ${r.error}` : ""}`);
    if (result.prune.removed.length > 10) console.log(`  … and ${result.prune.removed.length - 10} more`);
  }
  console.log(builder.note);
}

async function main(argv) {
  const positional = [];
  let maxGb;
  let dryRun = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-gb") maxGb = Number.parseInt(argv[++i], 10);
    else if (a.startsWith("--max-gb=")) maxGb = Number.parseInt(a.slice(9), 10);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--json") json = true;
    else if (a === "--builder") {
      // host-side: root `fenix` runs `docker builder prune` after us (no
      // docker socket in the container). Accepted here so the args pass
      // through unchanged, and never acted on inside the container.
    } else if (a.startsWith("--")) throw new UsageError(`unknown flag: ${a}`);
    else positional.push(a);
  }
  const verb = positional[0] ?? "report";
  if (verb !== "report" && verb !== "prune") throw new UsageError(`unknown verb: ${verb}`);
  // Prune mode: explicit verb, or implied by --max-gb / --dry-run.
  const pruneMode = verb === "prune" || maxGb !== undefined || dryRun;

  const cacheRoot = CACHE_ROOTS.cache();
  const childTmpRoot = CACHE_ROOTS.childTmp();
  const stateRoot = CACHE_ROOTS.state();
  assertNotData(cacheRoot, "cache root");
  assertNotData(childTmpRoot, "child tmp root");

  const capBytes = resolveCapBytes(maxGb);
  const tools = cacheToolSizes(cacheRoot);
  const totalBytes = tools.reduce((s, t) => s + t.bytes, 0);

  const { live, errors: registryErrors } = liveChildIds(stateRoot);
  const childDirs = [];
  let dirents;
  try {
    dirents = fs.readdirSync(childTmpRoot, { withFileTypes: true });
  } catch {
    dirents = [];
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const acc = walkBytes(fs, path.join(childTmpRoot, d.name), { bytes: 0, entries: 0 });
    childDirs.push({ childId: d.name, bytes: acc.bytes, live: live.has(d.name) });
  }
  const childTotal = childDirs.reduce((s, c) => s + c.bytes, 0);

  let pruneResult;
  let tmpSweep;
  if (pruneMode) {
    pruneResult = pruneCache({ cacheRoot, capBytes, dryRun });
    tmpSweep = sweepChildTmp({ childTmpRoot, stateRoot, dryRun });
  }

  const result = {
    mode: pruneMode ? "prune" : "report",
    dryRun,
    cache: { root: cacheRoot, capBytes, totalBytes, tools },
    childTmp: { root: childTmpRoot, children: childDirs, totalBytes: childTotal, ...(tmpSweep ? { kept: tmpSweep.kept, removed: tmpSweep.removed } : {}) },
    ...(pruneResult ? { prune: pruneResult } : {}),
    registryErrors,
    builder: {
      note: "docker build cache is host-side — the socket is not mounted into the container; run `fenix prune --builder` on the host to prune it",
    },
  };

  if (json) console.log(JSON.stringify(result, null, 2));
  else printReport(result);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    const usage = err instanceof UsageError;
    console.error(usage ? `usage error: ${err.message}` : String(err?.stack || err));
    process.exit(usage ? 2 : 1);
  }
}
