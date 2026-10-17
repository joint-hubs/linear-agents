#!/usr/bin/env node
// scripts/shared-skills.mjs — keep the Supervisor's tracked vendored skills
// byte-identical to the shared source of truth.
//
// The vendored skills live once in `agents/_shared/skills/<name>/` and are
// copied verbatim into `agents/supervisor/skills/<name>/` — the Supervisor's
// CLAUDE_CONFIG_DIR, which the repo tracks (archify and diagram-design stay
// gitignored; only these vendored, in-repo-maintained copies are tracked).
// Two copies of the same bytes can drift when someone edits one side; this
// script is the drift catch and the fix:
//
//   node scripts/shared-skills.mjs check [--root <agentsDir>] [--json]
//     compare every file; report missing / differs / extra; exit 1 when
//     anything is reported.
//   node scripts/shared-skills.mjs sync [--root <agentsDir>]
//     copy _shared over the Supervisor copy — creates dirs, overwrites only
//     files that exist in _shared, NEVER deletes.
//
// `extra` (a file in the Supervisor copy that _shared lacks) is reported and
// blocks `check`, but `sync` never deletes it — deleting is a decision, not a
// side effect of a sync.

import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_ROOT = join(REPO_ROOT, "agents");

/** One skill name's comparison: three lists of repo-relative file names. */
export function compareSkill(sharedDir, copyDir) {
  const report = { missing: [], differs: [], extra: [] };
  const walk = (dir, into, base) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = base ? `${base}/${name}` : name;
      if (statSync(abs).isDirectory()) {
        walk(abs, into, rel);
      } else {
        into.push(rel);
      }
    }
  };
  const sharedFiles = [];
  walk(sharedDir, sharedFiles, "");
  for (const rel of sharedFiles) {
    const copyPath = join(copyDir, rel);
    if (!existsSync(copyPath)) {
      report.missing.push(rel);
    } else if (!readFileSync(join(sharedDir, rel)).equals(readFileSync(copyPath))) {
      report.differs.push(rel);
    }
  }
  const copyFiles = [];
  walk(copyDir, copyFiles, "");
  for (const rel of copyFiles) {
    if (!existsSync(join(sharedDir, rel))) report.extra.push(rel);
  }
  return report;
}

/** Compare every skill dir under <root>/_shared/skills against <root>/supervisor/skills. */
export function checkSharedSkills(root) {
  const sharedRoot = join(root, "_shared", "skills");
  const copyRoot = join(root, "supervisor", "skills");
  const skills = [];
  if (existsSync(sharedRoot)) {
    for (const name of readdirSync(sharedRoot).sort()) {
      if (!statSync(join(sharedRoot, name)).isDirectory()) continue;
      skills.push({ name, ...compareSkill(join(sharedRoot, name), join(copyRoot, name)) });
    }
  }
  const ok = skills.every((s) => !s.missing.length && !s.differs.length && !s.extra.length);
  return { ok, skills };
}

/** Copy _shared/skills/* over supervisor/skills/* — create, overwrite, never delete. */
export function syncSharedSkills(root) {
  const sharedRoot = join(root, "_shared", "skills");
  const copyRoot = join(root, "supervisor", "skills");
  const written = [];
  if (!existsSync(sharedRoot)) return written;
  const walk = (src, dest, base) => {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src).sort()) {
      const rel = base ? `${base}/${name}` : name;
      const srcPath = join(src, name);
      if (statSync(srcPath).isDirectory()) {
        walk(srcPath, join(dest, name), rel);
      } else {
        copyFileSync(srcPath, join(dest, name));
        written.push(rel);
      }
    }
  };
  walk(sharedRoot, copyRoot, "");
  return written;
}

function printReport(root, { ok, skills }) {
  let count = 0;
  for (const skill of skills) {
    for (const status of ["missing", "differs", "extra"]) {
      for (const file of skill[status]) {
        console.log(`${status} ${skill.name}/${file}`);
        count++;
      }
    }
  }
  console.log(count ? `${count} drifted file(s) under ${join(root, "supervisor", "skills")}` : `in sync (${skills.length} skill(s) under ${join(root, "supervisor", "skills")})`);
  return ok;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const usageLine = "usage: node scripts/shared-skills.mjs check [--root <agentsDir>] [--json] | sync [--root <agentsDir>]";
  // A valued flag given without its value (or with the next flag as one) is a
  // usage error, not a silent fall-through to the default root.
  let root = DEFAULT_ROOT;
  let badUsage = false;
  const rootAt = argv.indexOf("--root");
  if (rootAt !== -1) {
    const value = argv[rootAt + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`shared-skills: --root requires a directory value\n${usageLine}`);
      process.exitCode = 2;
      badUsage = true;
    } else {
      root = value;
    }
  }
  if (!badUsage) {
    if (command === "check") {
      const report = checkSharedSkills(root);
      if (argv.includes("--json")) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printReport(root, report);
      }
      if (!report.ok) process.exitCode = 1;
    } else if (command === "sync") {
      const written = syncSharedSkills(root);
      for (const rel of written) console.log(`wrote supervisor/skills/${rel}`);
      console.log(written.length ? `${written.length} file(s) synced from ${join(root, "_shared", "skills")}` : `nothing to sync (${join(root, "_shared", "skills")} missing or empty)`);
    } else {
      console.error(usageLine);
      process.exitCode = 2;
    }
  }
}
