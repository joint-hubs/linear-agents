// scripts/supervisor-orphans.mjs — FOC-799: orphaned children after a container
// restart; owner-aware since FOC-905.
//
// A child turn runs under a detached watcher in the supervisor container. If the
// container is killed mid-turn, the watcher and the child die with it, nothing
// records the end, and the registry (<stateRoot>/<runId>/children.json) keeps the
// child at status "running" forever. Worse, after the restart pids start over in
// a new PID namespace, so the recorded pid may even belong to an unrelated
// process — probing it would be worse than not probing it.
//
// The rule this script enforces, per RUN (FOC-905): first relate the run's
// owner.json to this container (run-owner.mjs ownerRelation), then
//
//   mine       a turn that started BEFORE the current container's PID 1 started
//              cannot be alive in this container → mark; when the owner's
//              task-session row is terminal (stopped/completed/failed) the run
//              is finished work → mark regardless of the turn time
//   restarted  the owner's container instance is older than this one — it is
//              gone → mark regardless of the turn time
//   unknown    no owner.json (legacy runs) or an unprovable relation → the old
//              time rule
//   foreign    a different hostname wrote this run → LIST ONLY, never mark;
//              `--all --yes` overrides and applies the old time rule
//
// Marking is exactly the way supervisor-watch.mjs marks a crash (status
// "crashed", exitCode/signal null, endedAt set, the last turn closed) plus an
// orphanedBy field naming the cause.
//
// Runs at container start; it must never block the start, so the CLI exits 0
// even when individual runs could not be read (WARN lines instead). `--all`
// without `--yes` is the one non-zero exit (2): the override is two flags on
// purpose, and the foreign list is printed before refusing.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LIVE_STATUSES, readRegistry, supervisorStateHome, updateChild } from "./supervisor-lib.mjs";
import { readSessionRows, taskSessionsDbPath } from "./task-sessions.mjs";
import { containerStartMs, currentOwner, ownerRelation, readRunOwner } from "./run-owner.mjs";

// FOC-905: containerStartMs moved to run-owner.mjs (builtin-only, so
// supervisor-lib can import it); re-exported so existing tests and callers
// keep their import path.
export { containerStartMs };

export const ORPHAN_ERROR =
  "orphaned: the supervisor container restarted while this turn was running — its process is gone";

/**
 * Mark the orphaned children of every run THIS container owns.
 *
 * Scans every directory under `stateRoot` that holds a children.json. One bad
 * run (corrupt registry, unreadable dir) is collected as an `errors` entry and
 * never aborts the scan — the other runs' orphans must not hide behind it.
 * Children whose startedAt is missing or unparseable are LEFT ALONE and
 * reported as `unknown`: the time rule judges by start time, so a child without
 * a provable start time cannot be condemned by it. (The two owner rules that do
 * not consult time — a terminal owner session, a restarted owner container —
 * are stronger evidence than the timestamp and mark such children too.)
 *
 * `current` (default currentOwner()) is this container's identity; `sessions`
 * (default null) are the task-sessions rows for the terminal-owner check;
 * `all` sweeps foreign runs with the old time rule instead of listing them.
 *
 * Writes go through supervisor-lib's updateChild, so locking/atomic-write
 * discipline is the watcher's own. Returns
 * { marked: [{runId, childId, turn, startedAt, relation}], unknown, errors,
 *   skipped: [{runId, relation, reason}], runsScanned }.
 */
export function markOrphans({ stateRoot, containerStart, now = new Date(), current = currentOwner(), sessions = null, all = false }) {
  const marked = [];
  const unknown = [];
  const errors = [];
  const skipped = [];
  let runsScanned = 0;

  let entries;
  try {
    entries = readdirSync(stateRoot, { withFileTypes: true });
  } catch (err) {
    errors.push({ runId: null, error: `state root ${stateRoot} could not be read: ${err.message}` });
    return { marked, unknown, errors, skipped, runsScanned };
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

    // The owner relation is judged only for runs with something to judge — a
    // run whose children are all terminal has nothing an orphan scan could
    // touch, so it is neither marked nor reported as skipped.
    const liveChildren = Object.entries(registry.children || {}).filter(([, c]) =>
      LIVE_STATUSES.includes(c.status),
    );
    if (liveChildren.length === 0) continue;

    const owner = readRunOwner(join(stateRoot, runId));
    const session =
      owner?.sessionId && Array.isArray(sessions)
        ? sessions.find((s) => s.sessionId === owner.sessionId) ?? null
        : null;
    const { relation, terminal } = ownerRelation(owner, current, { session });

    if (relation === "foreign" && !all) {
      skipped.push({ runId, relation, reason: "owned by another host/container" });
      continue;
    }

    // A terminal owner session proves the run's work is over, and a restarted
    // owner container is gone — both mark without consulting the turn start.
    const unconditional = (relation === "mine" && terminal) || relation === "restarted";

    for (const [childId, child] of liveChildren) {
      const turn = child.turns?.at(-1);
      const startedAt = turn?.startedAt || child.startedAt;
      if (!unconditional) {
        const startedMs = Date.parse(startedAt);
        if (!Number.isFinite(startedMs)) {
          unknown.push({ runId, childId, startedAt: startedAt ?? null });
          continue;
        }
        // A null containerStart means the time rule cannot judge — it must not
        // guess, so nothing is marked by time alone (same contract as
        // containerStartMs itself).
        if (containerStart === null || containerStart === undefined || startedMs >= containerStart) continue;
      }

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
      marked.push({
        runId,
        childId,
        turn: (child.turns || []).length ? (child.turns || []).length - 1 : 0,
        startedAt: startedAt ?? null,
        relation,
      });
    }
  }

  return { marked, unknown, errors, skipped, runsScanned };
}

/**
 * The CLI body, injectable for tests (containerStart, stateRoot) — on Windows
 * hosts the /proc probe returns null, so tests pass the value they need.
 * Returns the process exit code: 0 always (the container start is never
 * blocked), 2 for `--all` without `--yes` and for a missing `--container`.
 */
export function runOrphansCli({ argv = process.argv.slice(2), containerStart, stateRoot } = {}) {
  if (!argv.includes("--container")) {
    console.error("usage: node scripts/supervisor-orphans.mjs --container [--json] [--all] [--yes]");
    return 2;
  }
  const all = argv.includes("--all");
  const yes = argv.includes("--yes");
  const json = argv.includes("--json");
  const start = containerStart !== undefined ? containerStart : containerStartMs();
  if (start === null) {
    console.log("orphans: not in a Linux container — nothing to do");
    return 0;
  }
  // An injected start (tests, off-Linux hosts without /proc) simulates a
  // container, so the current identity carries it too — the relation logic
  // ("mine" = same container start) must see the same value the time rule does.
  const current = containerStart !== undefined ? { ...currentOwner(), containerStartMs: start } : undefined;
  const { marked, unknown, errors, skipped, runsScanned } = markOrphans({
    stateRoot: stateRoot ?? supervisorStateHome(),
    containerStart: start,
    ...(current ? { current } : {}),
    // The owner's task-session rows: a terminal session marks its run
    // regardless of turn times. A missing or unreadable store reads as [] —
    // the scan then falls back to the time rule, never blocks on the store.
    sessions: readSessionRows(taskSessionsDbPath()),
    all: all && yes,
  });

  if (json) {
    console.log(
      JSON.stringify(
        {
          containerStart: start,
          marked: marked.map(({ runId, childId, relation }) => ({ runId, childId, relation })),
          skipped,
          unknown: unknown.length,
        },
        null,
        2,
      ),
    );
    return all && !yes ? 2 : 0;
  }

  for (const m of marked) {
    console.log(`orphan ${m.runId}/${m.childId} turn ${m.turn} started ${m.startedAt} → crashed [${m.relation}]`);
  }
  for (const s of skipped) {
    console.log(`skip ${s.runId}: ${s.reason} (foreign) — left untouched (override: --all --yes)`);
  }
  for (const u of unknown) {
    console.log(`WARN ${u.runId}/${u.childId}: startedAt missing or unparseable (${JSON.stringify(u.startedAt)}) — left untouched`);
  }
  for (const e of errors) {
    console.log(`WARN ${e.runId ?? "(state root)"}: ${e.error}`);
  }
  console.log(`orphans: ${marked.length} marked, ${skipped.length} skipped in ${runsScanned} run(s)`);
  if (all && !yes) {
    console.error(`refusing to sweep ${skipped.length} foreign run(s) without --yes — listed above`);
    return 2;
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(runOrphansCli());
}
