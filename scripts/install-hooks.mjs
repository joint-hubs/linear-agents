#!/usr/bin/env node
// scripts/install-hooks.mjs — install this repo's git hooks.
//
// `.git/hooks/` is not versioned, so a fresh clone has none. Run this once
// after cloning:
//   node scripts/install-hooks.mjs
//
// Currently installs: post-commit → background GitNexus re-index.
//
// The post-commit file is SHARED. graphify installs its own block between
// `# graphify-hook-start` / `# graphify-hook-end`, so this script appends a
// separately marked block and rewrites only its own — running it twice is safe,
// and it never touches graphify's.

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

const START = "# gitnexus-hook-start";
const END = "# gitnexus-hook-end";

const BLOCK = `${START}
# Background GitNexus re-index. A full analyze takes ~56s on this repo, so it
# must never run inline: the hook fires and returns, the rebuild detaches.
# gitnexus-refresh.mjs holds a lock, so overlapping commits skip rather than
# stack up (interrupting analyze can corrupt the KuzuDB store).
#
# Skipped during rebase/merge/cherry-pick for the same reason graphify skips:
# a background job there can leave the working tree dirty and block --continue.
GIT_DIR=\${GIT_DIR:-$(git rev-parse --git-dir 2>/dev/null)}
[ -d "$GIT_DIR/rebase-merge" ] && exit 0
[ -d "$GIT_DIR/rebase-apply" ] && exit 0
[ -f "$GIT_DIR/MERGE_HEAD" ] && exit 0
[ -f "$GIT_DIR/CHERRY_PICK_HEAD" ] && exit 0

_LA_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$_LA_ROOT" ] && [ -f "$_LA_ROOT/scripts/gitnexus-refresh.mjs" ]; then
    node "$_LA_ROOT/scripts/gitnexus-refresh.mjs" --background >/dev/null 2>&1 || true
fi
${END}
`;

function gitDir() {
  try {
    return execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: ROOT, encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function main() {
  const gd = gitDir();
  if (!gd) {
    console.error("[install-hooks] not a git repository");
    process.exit(1);
  }
  const hooksDir = join(ROOT, gd, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const target = join(hooksDir, "post-commit");

  let content = existsSync(target) ? readFileSync(target, "utf8") : "#!/bin/sh\n";
  if (!content.startsWith("#!")) content = "#!/bin/sh\n" + content;

  const hadBlock = content.includes(START);
  if (hadBlock) {
    // Replace only our own block; leave everything else (graphify's) untouched.
    const from = content.indexOf(START);
    const to = content.indexOf(END);
    if (to > from) {
      content = content.slice(0, from) + BLOCK.trim() + content.slice(to + END.length);
    }
  } else {
    if (!content.endsWith("\n")) content += "\n";
    content += "\n" + BLOCK;
  }

  writeFileSync(target, content, "utf8");
  try { chmodSync(target, 0o755); } catch { /* Windows: no-op */ }

  const other = content.includes("graphify-hook-start") ? " (graphify block preserved)" : "";
  console.log(`[install-hooks] post-commit ${hadBlock ? "updated" : "installed"}${other}`);
  console.log("  → after each commit, GitNexus re-indexes in the background");
  console.log("  → check with: node scripts/gitnexus-refresh.mjs --status");
}

main();
