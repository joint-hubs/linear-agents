// scripts/supervisor-stop.mjs — kill one child's current turn, then report.
//
//   node scripts/supervisor-stop.mjs --child <childId> [--run <runId>] [--grace-ms 5000]
//
// Graceful first, force after the grace period. On win32 the kill is ALWAYS a
// process-tree kill, because a claude child spawns cmd.exe for builds and tests
// and those nested shells would otherwise survive, holding locks in a worktree
// nobody owns any more.
//
// What this deliberately does NOT do: clean up. After the kill it runs
// `git status --porcelain` in the child's worktree and reports what was left
// behind. It never resets, never checks out, never removes the worktree — a
// stopped child's uncommitted work is often the only copy, and destroying it to
// tidy up is not a decision a script gets to make.

import {
  asArray,
  dirtyTreeReport,
  failJson,
  killTree,
  parseArgs,
  processAlive,
  readRegistry,
  updateChild,
} from "./supervisor-lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = parseArgs(process.argv.slice(2));
const childId = args.child;
const runId = args.run || process.env.LA_SUPERVISOR_RUN;
const graceMs = Number(args["grace-ms"] ?? 5000);

if (!childId) failJson("--child <childId> is required");
if (!runId) failJson("--run <runId> is required (or set LA_SUPERVISOR_RUN)");

const registry = readRegistry(runId);
const entry = registry.children[childId];
if (!entry) {
  failJson(`no child "${childId}" in run ${runId}`, {
    known: Object.keys(registry.children),
  });
}

const turnIndex = Math.max(0, (entry.turns?.length ?? 1) - 1);
const pid = entry.turns?.[turnIndex]?.pid ?? entry.pid ?? null;

// Mark stopped BEFORE the kill lands. The watcher reads this on exit and keeps
// it, so an operator-requested stop is never mis-recorded as a crash — those are
// different events and conflating them makes every deliberate stop look like a
// failure in the weekly digest.
updateChild(runId, childId, { status: "stopped", stoppedAt: new Date().toISOString() });

let killed = false;
let forced = false;

if (pid && processAlive(pid)) {
  killed = killTree(pid, "graceful");

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && processAlive(pid)) {
    await sleep(200);
  }

  if (processAlive(pid)) {
    forced = true;
    killTree(pid, "force");
    // Give the OS a moment to reap before reporting, otherwise `alive` below is
    // a coin flip on a loaded machine.
    await sleep(300);
  }
}

const cwd = entry.worktree || process.cwd();
const dirty = dirtyTreeReport(cwd);

console.log(
  JSON.stringify(
    {
      ok: true,
      childId,
      pid,
      killed,
      forced,
      stillAlive: processAlive(pid),
      status: "stopped",
      worktree: cwd,
      branch: entry.branch ?? null,
      dirty,
      // Stated every time so it is never a surprise that the tree was left as-is.
      cleanup:
        dirty.length > 0
          ? `${dirty.length} path(s) left modified in ${cwd} — not reset, your call`
          : "worktree clean",
      allowedPaths: asArray(entry.allowedPaths),
    },
    null,
    2,
  ),
);
