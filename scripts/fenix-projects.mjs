// scripts/fenix-projects.mjs — FOC-776: the user-owned Linear project →
// workspace/repo/deploy map, separate from config/projects.json (which is the
// curated fleet default). Same entry shape:
//
//   { "projects": [ { "linearProject": "...", "workspace": "joi",
//                     "repo": "${GITHUB_ROOT}/<name>", "deploy": {"type":"none"} } ] }
//
// The file lives at env LA_PROJECTS_FILE (required — exit 2 when unset):
//
//   node scripts/fenix-projects.mjs add --linear-project <name> --repo <pathTemplate> [--workspace <ws>]
//   node scripts/fenix-projects.mjs list
//
// add upserts by linearProject (case-sensitive) and writes atomically; list
// prints one tab-separated line per entry.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Atomic JSON write: tmp file + rename, same shape as scripts/utils.mjs. */
function atomicWriteJSON(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function readProjectsFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return { projects: [] };
    throw new Error(`projects: cannot parse ${file} (${err.message}) — fix or remove it by hand, not overwritten`);
  }
}

/**
 * Upsert an entry by linearProject (case-sensitive).
 *
 * @param {string} file  - Path to the map file (created with
 *                         {"projects":[]} when missing).
 * @param {object} entry - Full entry object; replaces an existing entry with
 *                         the same linearProject.
 * @returns {"added"|"updated"}
 * @throws {Error} When the existing file is present but unparseable.
 */
export function addProject(file, entry) {
  const data = readProjectsFile(file);
  if (!Array.isArray(data.projects)) data.projects = [];
  const idx = data.projects.findIndex((p) => p?.linearProject === entry.linearProject);
  const verb = idx === -1 ? "added" : "updated";
  if (idx === -1) data.projects.push(entry);
  else data.projects[idx] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJSON(file, data);
  return verb;
}

/**
 * List the entries in the map file. A missing file counts as no entries.
 *
 * @param {string} file
 * @returns {Array<{ linearProject: string, workspace: string, repo: string, ... }>}
 * @throws {Error} When the existing file is present but unparseable.
 */
export function listProjects(file) {
  const data = readProjectsFile(file);
  return Array.isArray(data.projects) ? data.projects : [];
}

// ---------------------------------------------------------------------------
// Main — only when executed directly (not when imported for the helpers).
// ---------------------------------------------------------------------------
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const file = process.env.LA_PROJECTS_FILE;
  if (!file) {
    console.error("projects: LA_PROJECTS_FILE is not set — point it at the user projects map");
    process.exit(2);
  }
  const [command, ...rest] = process.argv.slice(2);
  const arg = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i !== -1 && rest[i + 1] ? rest[i + 1] : undefined;
  };
  if (command === "add") {
    const linearProject = arg("linear-project");
    const repo = arg("repo");
    if (!linearProject || !repo) {
      console.error("usage: node scripts/fenix-projects.mjs add --linear-project <name> --repo <pathTemplate> [--workspace <ws>]");
      process.exit(1);
    }
    const entry = { linearProject, workspace: arg("workspace") || "joi", repo, deploy: { type: "none" } };
    const verb = addProject(file, entry);
    console.log(`projects: ${verb} ${linearProject} → ${repo}`);
  } else if (command === "list") {
    const projects = listProjects(file);
    if (projects.length === 0) console.log(`projects: none (${file})`);
    for (const p of projects) console.log(`${p.linearProject}\t${p.workspace}\t${p.repo}`);
  } else {
    console.error("usage: node scripts/fenix-projects.mjs <add|list> [args]");
    process.exit(1);
  }
}
