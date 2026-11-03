#!/usr/bin/env node
// scripts/state-root.mjs — the one resolveRoot both state tools share
// (FOC-1211 gave it to state-journal; FOC-1224 moved it here so
// state-index resolves through the same logic instead of its own copy).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * The root whose docs/ the state tools operate on, in order: an explicit
 * --root (handled by the CLI layer), the git repository of the current
 * working directory, LA_ROOT, this repo. cwd-first because a Supervisor
 * child runs inside its own worktree while LA_ROOT still points at the
 * operator's main checkout — LA_ROOT-first resolution misrouted the child's
 * journal into the main checkout's untracked docs/state/ (FOC-1155 r4 had to
 * re-record it by hand) and let state-index --write rewrite the MAIN
 * checkout's docs/STATE.md from a worktree run (FOC-1224).
 */
export function resolveRoot(env = process.env, cwd = process.cwd()) {
  try {
    const res = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
    const top = (res.stdout || "").trim();
    if (res.status === 0 && top) return resolve(top);
  } catch {
    // git missing or unusable — fall through to LA_ROOT below.
  }
  if (env.LA_ROOT) return resolve(env.LA_ROOT);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}
