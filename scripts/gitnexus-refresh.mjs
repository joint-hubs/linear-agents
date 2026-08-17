#!/usr/bin/env node
// scripts/gitnexus-refresh.mjs — rebuild the GitNexus index without blocking anyone.
//
// A full analyze takes ~56s on this repo. That is far too long to sit inside a
// git hook (a minute per commit) or inside a code-intel query (the agent would
// give up first). So the rebuild is detached and the caller returns instantly.
//
// Usage:
//   node scripts/gitnexus-refresh.mjs            run in foreground (blocks, prints output)
//   node scripts/gitnexus-refresh.mjs --background   detach and return immediately
//   node scripts/gitnexus-refresh.mjs --status       is a rebuild running / is the index fresh
//
// Concurrency: a lock directory (mkdir is atomic on every platform) guarantees
// only one analyze runs at a time. GitNexus documents that interrupting analyze
// can corrupt its KuzuDB store, so a second commit during a rebuild SKIPS rather
// than queues or kills.

import { existsSync, mkdirSync, rmSync, readFileSync, openSync, statSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const GITNEXUS = join(ROOT, ".gitnexus");
const RUNNER = join(GITNEXUS, "run.cjs");
const LOCK = join(GITNEXUS, ".analyze.lock");
const LOG = join(GITNEXUS, "analyze.log");

// A lock older than this is treated as abandoned (crash, reboot, killed shell).
// Generous multiple of the ~56s a real run takes.
const STALE_LOCK_MS = 15 * 60 * 1000;

function headSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function indexedSha() {
  try {
    return JSON.parse(readFileSync(join(GITNEXUS, "gitnexus.json"), "utf8")).lastCommit || null;
  } catch {
    return null;
  }
}

/** Acquire the lock, clearing it first if it was abandoned. Returns false when busy. */
function acquireLock() {
  if (existsSync(LOCK)) {
    let age = 0;
    try { age = Date.now() - statSync(LOCK).mtimeMs; } catch { age = Infinity; }
    if (age < STALE_LOCK_MS) return false;
    try { rmSync(LOCK, { recursive: true, force: true }); } catch { return false; }
  }
  try {
    mkdirSync(LOCK);
    return true;
  } catch {
    return false; // lost the race to another process
  }
}

function releaseLock() {
  try { rmSync(LOCK, { recursive: true, force: true }); } catch { /* already gone */ }
}

function status() {
  const head = headSha();
  const idx = indexedSha();
  const running = existsSync(LOCK);
  const fresh = head && idx && (head === idx || head.startsWith(idx));
  console.log(`index:    ${idx ? idx.slice(0, 7) : "(none)"}`);
  console.log(`HEAD:     ${head ? head.slice(0, 7) : "(unknown)"}`);
  console.log(`state:    ${fresh ? "fresh" : "STALE"}${running ? " (rebuild in progress)" : ""}`);
  process.exit(fresh ? 0 : 1);
}

function runForeground() {
  if (!acquireLock()) {
    console.error("[gitnexus-refresh] another analyze is already running — skipping.");
    process.exit(0);
  }
  try {
    execFileSync("node", [RUNNER, "analyze"], { cwd: ROOT, stdio: "inherit" });
  } finally {
    releaseLock();
  }
}

/**
 * Detach a child that holds the lock for its whole life.
 *
 * `detached: true` + `unref()` is the portable way to survive the parent — a
 * bare `&` inside a Windows git hook does NOT reliably detach, which is why
 * graphify's own hook resorts to CREATE_BREAKAWAY_FROM_JOB.
 *
 * `windowsHide` is not optional alongside it. On Windows `detached: true` gives
 * the child its own console, so without it EVERY commit flashes a terminal
 * window: the hook fires on post-commit, i.e. during ordinary git work, and the
 * flash is indistinguishable from an agent launching. Reported 2026-08-17.
 */
function runBackground() {
  const head = headSha();
  const idx = indexedSha();
  if (head && idx && (head === idx || head.startsWith(idx))) {
    process.exit(0); // already current — nothing to do
  }
  if (!acquireLock()) process.exit(0); // a rebuild is already under way

  const out = openSync(LOG, "a");
  // The child releases the lock itself: the parent exits immediately, so it
  // cannot be the one to clean up.
  //
  // Retry with --force on failure. Observed 2026-08-09: an incremental analyze
  // died with "FTS index 'file_fts' is inconsistent ... Drop and recreate",
  // leaving the index stale while reporting success to nobody. A forced full
  // rebuild recovers it (41s vs 56s incremental, so the retry is not even a
  // penalty). Without this the index silently rots until someone reads the log.
  const child = spawn(
    process.execPath,
    ["-e", `
      const { execFileSync } = require("node:child_process");
      const { rmSync } = require("node:fs");
      const [, node, runner, cwd, lock] = process.argv;
      const run = (args) => execFileSync(node, [runner, "analyze", ...args], { cwd, stdio: "inherit" });
      try {
        run([]);
      } catch (e) {
        console.error("[gitnexus-refresh] incremental analyze failed:", e.message);
        console.error("[gitnexus-refresh] retrying with --force ...");
        try { run(["--force"]); }
        catch (e2) { console.error("[gitnexus-refresh] forced analyze ALSO failed:", e2.message); }
      } finally {
        try { rmSync(lock, { recursive: true, force: true }); } catch {}
      }
    `, process.execPath, RUNNER, ROOT, LOCK],
    { cwd: ROOT, detached: true, windowsHide: true, stdio: ["ignore", out, out] }
  );
  child.unref();
  process.exit(0);
}

function main() {
  if (!existsSync(RUNNER)) {
    console.error("[gitnexus-refresh] .gitnexus/run.cjs missing — run `npx gitnexus analyze` once first.");
    process.exit(3);
  }
  const arg = process.argv[2];
  if (arg === "--status") return status();
  if (arg === "--background") return runBackground();
  return runForeground();
}

main();
