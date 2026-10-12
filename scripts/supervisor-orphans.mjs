// scripts/supervisor-orphans.mjs — FOC-799: orphaned children after a container restart.
//
// A child turn runs under a detached watcher in the supervisor container. If the
// container is killed mid-turn, the watcher and the child die with it, nothing
// records the end, and the registry (<stateRoot>/<runId>/children.json) keeps the
// child at status "running" forever. Worse, after the restart pids start over in
// a new PID namespace, so the recorded pid may even belong to an unrelated
// process — probing it would be worse than not probing it.
//
// The rule this script enforces: a turn that started BEFORE the current
// container's PID 1 started cannot be alive in this container. Such children are
// marked exactly the way supervisor-watch.mjs marks a crash (status "crashed",
// exitCode/signal null, endedAt set, the last turn closed) plus an orphanedBy
// field naming the cause.
//
// Runs at container start; it must never block the start, so the CLI exits 0
// even when individual runs could not be read (WARN lines instead).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LIVE_STATUSES, readRegistry, supervisorStateHome, updateChild } from "./supervisor-lib.mjs";

export const ORPHAN_ERROR =
  "orphaned: the supervisor container restarted while this turn was running — its process is gone";

/**
 * When did this container's PID 1 start, in epoch ms?
 *
 * /proc/stat carries the kernel boot time (`btime <secs>`) and /proc/1/stat's
 * field 22 the PID 1 start time in clock ticks since boot, so the sum — ticks
 * converted through CLK_TCK (getconf, default 100) — is PID 1's absolute start.
 * `clkTck` is injectable for tests; `readFile` likewise, so the /proc shapes are
 * testable off Linux.
 *
 * Returns null whenever the answer cannot be PROVEN (no /proc on Windows/macOS,
 * unreadable or malformed files) — a caller that cannot tell when the container
 * started must not guess, so null means "do nothing", never "mark everything".
 */
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

function defaultClkTck() {
  try {
    const conf = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
    const n = Number((conf.stdout || "").trim());
    if (conf.status === 0 && Number.isFinite(n) && n > 0) return n;
  } catch {
    /* getconf missing — fall through to the default */
  }
  return 100;
}

/**
 * Mark every live child whose turn predates the container as crashed.
 *
 * Scans every directory under `stateRoot` that holds a children.json. One bad
 * run (corrupt registry, unreadable dir) is collected as an `errors` entry and
 * never aborts the scan — the other runs' orphans must not hide behind it.
 * Children whose startedAt is missing or unparseable are LEFT ALONE and
 * reported as `unknown`: the rule judges by start time, so a child without a
 * provable start time cannot be condemned by it.
 *
 * Writes go through supervisor-lib's updateChild, so locking/atomic-write
 * discipline is the watcher's own. Returns
 * { marked: [{runId, childId, turn, startedAt}], unknown, errors, runsScanned }.
 */
export function markOrphans({ stateRoot, containerStart, now = new Date() }) {
  const marked = [];
  const unknown = [];
  const errors = [];
  let runsScanned = 0;

  let entries;
  try {
    entries = readdirSync(stateRoot, { withFileTypes: true });
  } catch (err) {
    errors.push({ runId: null, error: `state root ${stateRoot} could not be read: ${err.message}` });
    return { marked, unknown, errors, runsScanned };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    if (!existsSync(join(stateRoot, runId, "children.json"))) continue;
    runsScanned++;

    let registry;
    try {
      registry = readRegistry(runId);
    } catch (err) {
      errors.push({ runId, error: err.message });
      continue;
    }

    for (const [childId, child] of Object.entries(registry.children || {})) {
      if (!LIVE_STATUSES.includes(child.status)) continue;
      const turn = child.turns?.at(-1);
      const startedAt = turn?.startedAt || child.startedAt;
      const startedMs = Date.parse(startedAt);
      if (!Number.isFinite(startedMs)) {
        unknown.push({ runId, childId, startedAt: startedAt ?? null });
        continue;
      }
      if (startedMs >= containerStart) continue;

      const endedAt = now.toISOString();
      const turns = (child.turns || []).map((t, i) =>
        i === (child.turns || []).length - 1
          ? { ...t, endedAt, exitCode: null, endedBy: "container-restart" }
          : t,
      );
      updateChild(runId, childId, {
        status: "crashed",
        exitCode: null,
        signal: null,
        endedAt,
        error: ORPHAN_ERROR,
        orphanedBy: "container-restart",
        turns,
      });
      marked.push({ runId, childId, turn: (child.turns || []).length ? (child.turns || []).length - 1 : 0, startedAt });
    }
  }

  return { marked, unknown, errors, runsScanned };
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes("--container")) {
    console.error("usage: node scripts/supervisor-orphans.mjs --container");
    process.exit(2);
  }
  const containerStart = containerStartMs();
  if (containerStart === null) {
    console.log("orphans: not in a Linux container — nothing to do");
    process.exit(0);
  }
  const { marked, unknown, errors, runsScanned } = markOrphans({
    stateRoot: supervisorStateHome(),
    containerStart,
  });
  for (const m of marked) {
    console.log(`orphan ${m.runId}/${m.childId} turn ${m.turn} started ${m.startedAt} → crashed`);
  }
  for (const u of unknown) {
    console.log(`WARN ${u.runId}/${u.childId}: startedAt missing or unparseable (${JSON.stringify(u.startedAt)}) — left untouched`);
  }
  for (const e of errors) {
    console.log(`WARN ${e.runId ?? "(state root)"}: ${e.error}`);
  }
  console.log(`orphans: ${marked.length} marked in ${runsScanned} run(s)`);
  process.exit(0); // runs at container start — errors are WARN, never a blocked start
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
