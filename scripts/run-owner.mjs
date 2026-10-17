// scripts/run-owner.mjs — run ownership (FOC-905).
//
// Every run dir carries an owner.json, written once when the run dir is
// created and never overwritten: the identity of the supervisor process (and,
// through containerStartMs, of the container instance) that created the run.
// The orphan scan reads it to decide, per run, whether THIS container may
// mark the run's live children as crashed — a run written by another host or
// container sharing the same state home is listed, never swept (N containers
// over one /data is unsupported but must not be destructive).
//
// This module imports ONLY node builtins, so supervisor-lib.mjs (which writes
// the owner on run-dir creation) can import it without a cycle. The two
// helpers it cannot import without dragging in heavier modules are mirrored
// here on purpose: supervisorStateRoot duplicates supervisor-lib's
// supervisorStateHome derivation, and the terminal session statuses duplicate
// task-sessions.mjs's TERMINAL_STATUSES. If either drifts, fix both sides.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Moved here from supervisor-orphans.mjs (FOC-905) so both the owner identity
// and the container-start probe live in one builtin-only module;
// supervisor-orphans.mjs re-exports it so its tests and callers keep working.
//
// When did this container's PID 1 start, in epoch ms?
//
// /proc/stat carries the kernel boot time (`btime <secs>`) and /proc/1/stat's
// field 22 the PID 1 start time in clock ticks since boot, so the sum — ticks
// converted through CLK_TCK (getconf, default 100) — is PID 1's absolute start.
// `clkTck` is injectable for tests; `readFile` likewise, so the /proc shapes are
// testable off Linux.
//
// Returns null whenever the answer cannot be PROVEN (no /proc on Windows/macOS,
// unreadable or malformed files) — a caller that cannot tell when the container
// started must not guess, so null means "do nothing", never "mark everything".
export function containerStartMs({ readFile = readFileSync, clkTck } = {}) {
  try {
    const ticks = clkTck ?? defaultClkTck();
    if (!(ticks > 0)) return null;
    const boot = readFile("/proc/stat", "utf8");
    const btimeLine = boot.split("\n").find((line) => line.startsWith("btime "));
    if (!btimeLine) return null;
    const btime = Number(btimeLine.slice("btime ".length).trim());
    if (!Number.isFinite(btime)) return null;
    const one = readFile("/proc/1/stat", "utf8");
    // Field 2 (comm) is parenthesised and may contain spaces and parentheses of
    // its own, so everything after the LAST ")" is fields 3..n. Token 0 there is
    // field 3 (state), which puts field 22 (starttime) at index 19.
    const fields = one.slice(one.lastIndexOf(")") + 1).trim().split(/\s+/);
    const starttime = Number(fields[19]);
    if (!Number.isFinite(starttime)) return null;
    return (btime + starttime / ticks) * 1000;
  } catch {
    return null; // no /proc (Windows, macOS), or a file nobody could parse
  }
}

// The probe is memoized at module level: CLK_TCK is constant for the machine's
// lifetime, and currentOwner() runs on every ensureRunDir, so spawning getconf
// each call is pure waste. The "unavailable" result (the 100 fallback) is
// cached too — a host without getconf pays for the failed spawn only once.
let clkTckCache; // undefined = not probed yet
let _probeClkTck = () => {
  try {
    const conf = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
    const n = Number((conf.stdout || "").trim());
    if (conf.status === 0 && Number.isFinite(n) && n > 0) return n;
  } catch {
    /* getconf missing — fall through to the default */
  }
  return 100;
};

function defaultClkTck() {
  if (clkTckCache === undefined) clkTckCache = _probeClkTck();
  return clkTckCache;
}

/** Test-only seams: swap the probe (to count spawns) and forget the memo. The `clkTck` option stays the primary injection point. */
export function _setClkTckProbe(fn) {
  _probeClkTck = fn;
}
export function _resetClkTckCache() {
  clkTckCache = undefined;
}

// Mirror of task-sessions.mjs's TERMINAL_STATUSES (see the header: a builtin-
// only module cannot import it). A run whose owner session reached one of
// these is finished work — the orphan scan marks it regardless of turn times.
const TERMINAL_SESSION_STATUSES = ["stopped", "completed", "failed"];

/**
 * The identity of THIS supervisor process, as it is recorded into a run's
 * owner.json. `sessionId` is the managed task session (scoped mode, FOC-901)
 * or null in legacy mode; `containerStartMs` is null whenever the container
 * start cannot be proven (hosts, macOS) — an owner without a provable start
 * is related by hostname alone.
 */
export function currentOwner(env = process.env) {
  return {
    sessionId: env?.FENIX_SUPERVISOR_SESSION_ID || null,
    hostname: hostname(),
    containerStartMs: containerStartMs(),
    pid: process.pid,
    recordedAt: new Date().toISOString(),
  };
}

export const ownerPath = (runDir) => join(runDir, "owner.json");

/** The run's owner record, or null — missing, corrupt or a non-object reads as "no owner". Never throws. */
export function readRunOwner(runDir) {
  let raw;
  try {
    raw = readFileSync(ownerPath(runDir), "utf8");
  } catch {
    return null;
  }
  try {
    const owner = JSON.parse(raw);
    return owner && typeof owner === "object" && !Array.isArray(owner) ? owner : null;
  } catch {
    return null;
  }
}

/**
 * Write owner.json only if it is not there yet. The `wx` flag makes the
 * create exclusive at the OS level, so a second writer (a racing ensureRunDir)
 * never overwrites the first owner. Returns true when this call wrote it.
 */
export function writeRunOwnerIfMissing(runDir, owner) {
  const path = ownerPath(runDir);
  if (existsSync(path)) return false;
  try {
    writeFileSync(path, JSON.stringify(owner, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false; // someone wrote it first — their owner stands
    throw err;
  }
}

/**
 * How does `owner` (a run's owner.json record, or null) relate to `current`
 * (this process's identity, currentOwner())?
 *
 *   mine       same hostname and the same container start (or both starts
 *              unprovable and the same hostname) — this container owns the run
 *   restarted  same hostname, but the owner's container start is OLDER —
 *              that container instance is gone, its live children are orphans
 *   foreign    a different hostname — another host or container wrote this run
 *   unknown    no owner record (legacy runs), or the starts do not line up
 *              (an owner start newer than this container's — clock skew) —
 *              the relation cannot be proven
 *
 * `session`, when given, is the task-sessions row for owner.sessionId;
 * `terminal` is true when its status is a terminal one (stopped/completed/
 * failed) — the scan marks a terminal-owner run regardless of turn times.
 */
export function ownerRelation(owner, current, { session = null } = {}) {
  const terminal = Boolean(session && TERMINAL_SESSION_STATUSES.includes(session.status));
  if (!owner || typeof owner !== "object") return { relation: "unknown", terminal };
  if (owner.hostname !== current.hostname) return { relation: "foreign", terminal };
  const owned = owner.containerStartMs ?? null;
  const active = current.containerStartMs ?? null;
  if (owned === null && active === null) return { relation: "mine", terminal };
  if (owned !== null && active !== null) {
    if (owned < active) return { relation: "restarted", terminal };
    if (owned === active) return { relation: "mine", terminal };
  }
  return { relation: "unknown", terminal };
}

// The state root is a SEAM, exactly like supervisor-lib's supervisorStateHome
// (which this mirrors): LA_SUPERVISOR_STATE_HOME redirects the whole tree,
// unset means the historical repo-anchored location. Duplicated here because
// this module must stay node-builtin-only (supervisor-lib imports it).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const supervisorStateRoot = (env = process.env) =>
  env?.LA_SUPERVISOR_STATE_HOME || join(REPO_ROOT, ".state", "supervisor");

/**
 * The ownership records of every run under `stateRoot`: a run is a directory
 * carrying owner.json (owned) or children.json (a legacy run the scan can
 * still see). Directories with neither are not runs. A missing or unreadable
 * state root yields [] — the caller reports "nothing there", never an error.
 */
export function listRunOwners(stateRoot) {
  let entries;
  try {
    entries = readdirSync(stateRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = join(stateRoot, entry.name);
    const owner = readRunOwner(runDir);
    if (owner || existsSync(join(runDir, "children.json"))) {
      runs.push({ runId: entry.name, owner });
    }
  }
  return runs;
}
