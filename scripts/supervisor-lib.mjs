// scripts/supervisor-lib.mjs — shared state for the Supervisor's child processes.
//
// Three scripts touch the same run directory (spawn, watch, stop), so the paths,
// the registry schema and the worktree rules live here rather than being
// re-derived three times and drifting.
//
// Layout under .state/supervisor/<runId>/:
//   children.json        the registry (§2.5)
//   children/<id>.jsonl  the raw stream-json tee for one child (§2.7)
//   gates/<gateId>.json  gate records (supervisor-gate.mjs, FOC-122)
//   triage.json          the recorded verdict (FOC-123, read here, never written)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteJSON } from "./utils.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// One live child per run. This is a POLICY guard, not a technical limit — since
// every child now gets its own worktree (ADR-0009, amended 2026-08-25), two
// children can no longer corrupt each other's checkout, so nothing in the
// runtime stops them.
//
// What is still missing is the machinery that makes concurrent work *trustworthy*:
// the merge node that re-verifies combined behaviour (FOC-160) and the
// backpressure that stops DEV producing candidates REVIEW cannot absorb
// (FOC-161). Without those, parallelism yields more unverified work, not more
// throughput. FOC-161 is the task that deletes this constant and replaces it
// with a real semaphore.
export const MAX_LIVE_CHILDREN_PER_RUN = 1;

// The stream-json `system/init` event carries the session_id that IS the child's
// durable identity — without it there is no --resume, so a child we cannot
// identify is worse than no child at all. Fail rather than register a ghost.
export const INIT_TIMEOUT_MS = 30_000;

export const runDir = (runId) => join(ROOT, ".state", "supervisor", runId);
export const registryPath = (runId) => join(runDir(runId), "children.json");
export const triagePath = (runId) => join(runDir(runId), "triage.json");
export const gatesDir = (runId) => join(runDir(runId), "gates");
export const gatePath = (runId, gateId) => join(gatesDir(runId), `${gateId}.json`);
export const teeRelPath = (childId) => join("children", `${childId}.jsonl`);
export const teeAbsPath = (runId, childId) => join(runDir(runId), teeRelPath(childId));

export function ensureRunDir(runId) {
  mkdirSync(join(runDir(runId), "children"), { recursive: true });
  mkdirSync(gatesDir(runId), { recursive: true });
}

export function emptyRegistry(runId) {
  return { runId, children: {}, reviewLoopCount: {} };
}

export function readRegistry(runId) {
  const path = registryPath(runId);
  if (!existsSync(path)) return emptyRegistry(runId);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { ...emptyRegistry(runId), ...parsed };
  } catch (err) {
    // A corrupt registry must not be silently replaced with an empty one — that
    // would orphan every running child and lose the pids needed to stop them.
    throw new Error(`${path} is not readable JSON: ${err.message}`);
  }
}

export function writeRegistry(runId, registry) {
  ensureRunDir(runId);
  atomicWriteJSON(registryPath(runId), registry);
}

// Read-modify-write. Single-writer by phase: supervisor-spawn writes the initial
// entry BEFORE launching the watcher, and after that only the watcher writes
// that child's state. That discipline — not locking — is what keeps this safe
// today; FOC-161 lifts MAX_LIVE_CHILDREN_PER_RUN and will need real locking.
export function updateChild(runId, childId, patch) {
  const registry = readRegistry(runId);
  const current = registry.children[childId] || {};
  registry.children[childId] = { ...current, ...patch };
  writeRegistry(runId, registry);
  return registry.children[childId];
}

// Does this child have an unanswered question outstanding? The watcher asks at
// turn end to tell `exited` (finished the work) apart from `waiting_gate`
// (stopped to ask) — §2.5. Deliberately tolerant of a malformed file: a gate
// nobody can parse must not make a waiting child look finished, so anything
// unreadable counts as pending.
export function hasPendingGate(runId, childId) {
  const dir = gatesDir(runId);
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .some((f) => {
      try {
        const gate = JSON.parse(readFileSync(join(dir, f), "utf8"));
        return gate.childId === childId && gate.status === "pending";
      } catch {
        return true;
      }
    });
}

export const LIVE_STATUSES = ["starting", "running"];

// "The turn has ended" — no process is running, nothing will write this child's
// state again until someone starts a new turn. `waiting_gate` belongs here even
// though the WORK is unfinished: liveness is about the process, not the task.
// Getting that wrong is not cosmetic — a `waiting_gate` child counted as live
// would be reported as stalled once its tee went quiet (it always does; it is
// waiting on a human), and `status --wait` would block instead of sending the
// Supervisor to Mateusz for the answer.
export const TERMINAL_STATUSES = ["exited", "crashed", "stopped", "waiting_gate"];

export function liveChildren(registry) {
  return Object.values(registry.children || {}).filter((c) => LIVE_STATUSES.includes(c.status));
}

// ── git / worktree ───────────────────────────────────────────────────────────

export function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

export function resolveGitRoot(cwd) {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

// Worktrees live as siblings of the repo (../la-wt/<branch>) rather than inside
// it: a worktree nested under the repo shows up in the parent's own status and
// in every glob the agents run, which is exactly the confusion worktrees exist
// to remove.
export function worktreeRoot(gitRoot) {
  return join(gitRoot, "..", "la-wt");
}

// Always resolved. `git worktree list` prints forward slashes on win32 while
// path.join produces backslashes, so create and reuse used to hand back the same
// directory spelled two different ways — and the registry recorded whichever the
// caller happened to hit. Anything that compares worktree paths (FOC-160's merge
// node compares touched paths across candidates) would have broken on that.
export function worktreePathFor(gitRoot, branch) {
  return resolve(worktreeRoot(gitRoot), branch);
}

export function listWorktrees(gitRoot) {
  const out = git(["worktree", "list", "--porcelain"], gitRoot);
  const entries = [];
  let current = {};
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.branch = null;
    }
  }
  if (current.path) entries.push(current);
  return entries;
}

/**
 * Give this child an isolated checkout. Creates ../la-wt/<branch> off the
 * current HEAD when it does not exist, reuses it when it does.
 *
 * Reuse must NEVER run `git checkout` in the main tree — switching a branch
 * under a live run is one of the two failures this whole change exists to
 * prevent (docs/ROADMAP.md §NOW.1).
 *
 * @returns {{ worktree: string, branch: string, baseRevision: string, created: boolean }}
 */
export function ensureWorktree(gitRoot, branch) {
  const existing = listWorktrees(gitRoot).find((w) => w.branch === branch);
  if (existing) {
    const path = resolve(existing.path);
    return { worktree: path, branch, baseRevision: git(["rev-parse", "HEAD"], path), created: false };
  }

  const target = worktreePathFor(gitRoot, branch);
  mkdirSync(worktreeRoot(gitRoot), { recursive: true });

  const head = git(["rev-parse", "HEAD"], gitRoot);
  const branchExists = (() => {
    try {
      git(["rev-parse", "--verify", `refs/heads/${branch}`], gitRoot);
      return true;
    } catch {
      return false;
    }
  })();

  // `git worktree add <path> <branch>` checks out an existing branch;
  // `-b` creates it. Passing -b for an existing branch fails, and omitting it
  // for a missing one checks out a detached HEAD named after nothing.
  const args = branchExists
    ? ["worktree", "add", target, branch]
    : ["worktree", "add", "-b", branch, target, head];
  git(args, gitRoot);

  const path = resolve(target);
  return { worktree: path, branch, baseRevision: git(["rev-parse", "HEAD"], path), created: true };
}

// Reported after a kill so Mateusz can see what the child left behind. Never
// acted on: cleanup is his call, and an auto-reset would destroy the only copy
// of work a crashed child had not committed.
export function dirtyTreeReport(cwd) {
  try {
    const out = git(["status", "--porcelain"], cwd);
    return out ? out.split(/\r?\n/).filter(Boolean) : [];
  } catch (err) {
    return [`<git status failed: ${err.message}>`];
  }
}

// ── killing a child ──────────────────────────────────────────────────────────

export function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // alive, just not ours to signal
  }
}

/**
 * Kill a child process and everything it spawned.
 *
 * On win32 this is ALWAYS a tree kill (`taskkill /T`). A claude child routinely
 * spawns cmd.exe for build and test commands; signalling only the top pid
 * leaves those nested shells running, holding file locks in a worktree nobody
 * owns any more.
 *
 * @param {"graceful"|"force"} mode
 */
export function killTree(pid, mode = "graceful") {
  if (!pid) return false;
  try {
    if (process.platform === "win32") {
      const args = ["/PID", String(pid), "/T"];
      if (mode === "force") args.push("/F");
      execFileSync("taskkill", args, { stdio: "ignore" });
    } else {
      process.kill(-pid, mode === "force" ? "SIGKILL" : "SIGTERM");
    }
    return true;
  } catch {
    // Already gone, or the tree died with the parent — either way there is
    // nothing left to kill, which is the outcome the caller wanted.
    return false;
  }
}

// ── claude binary ────────────────────────────────────────────────────────────

// LA_CLAUDE_BIN is a TEST SEAM. The suite points it at scripts/mock-claude.mjs
// so spawn/watch/stop can be exercised without a real model call or an API key.
// Production leaves it unset and gets `claude` from PATH.
export function claudeCommand(args) {
  const bin = process.env.LA_CLAUDE_BIN;
  if (!bin) return { command: "claude", args };
  if (bin.endsWith(".mjs") || bin.endsWith(".js")) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  return { command: bin, args };
}

// Only these flags accumulate. Everything else takes the LAST value, so a
// wrapper that appends an override (`--task A ... --task B`) gets B rather than
// the array ["A","B"] — which silently became the string "A,B" downstream and
// failed identifier validation with a nonsense message.
const REPEATABLE = new Set(["allowed-path"]);

export function parseArgs(argv, repeatable = REPEATABLE) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      if (repeatable.has(key)) {
        out[key] = [...asArray(out[key]), next];
      } else {
        out[key] = next;
      }
      i++;
    }
  }
  return out;
}

export const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function failJson(message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
}
