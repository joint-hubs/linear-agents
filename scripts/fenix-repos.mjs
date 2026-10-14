// scripts/fenix-repos.mjs — FOC-786 slice D: the repository inventory behind
// Settings → Repositories.
//
// - lists the shared clones (name, origin, HEAD, branch, dirty, CodeGraph
//   index state, worktree count, mapped Linear project),
// - validates clone URLs with the same naming the entrypoint's `repo-add`
//   uses (https://github.com/<owner>/<name>(.git), git@github.com:<owner>/
//   <name>(.git), or `owner/name` shorthand; `file://` and absolute local
//   paths only when allowLocal is passed — tests and acceptance),
// - runs background `git clone --progress` jobs, at most two at a time: the
//   command is spawned as an argv array (never a shell, never a token in
//   argv — git reaches GitHub through the container's credential helper),
//   stderr progress lines land in `job.progress`, and a failed clone removes
//   the partial directory,
// - unmaps a repo from the Linear projects file (fenix-projects) without
//   touching the repo's files.
//
// The container's clones live at `$GITHUB_ROOT` (`/data/workspaces`), with
// worktrees at `$GITHUB_ROOT/la-wt` — `la-wt` is skipped when listing.

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dataHome, projectsConfigPath, worktreeRoot } from "./fenix-paths.mjs";
import { addProject, listProjects, removeByRepo, repoRefName } from "./fenix-projects.mjs";

const execFileP = promisify(execFile);

const NAME_CHARS = "[A-Za-z0-9._-]";
/** Same ceiling as the entrypoint's fork-worker pool: two at a time. */
export const MAX_CONCURRENT_CLONES = 2;

/**
 * The shared-clones root: `GITHUB_ROOT` (the container's `/data/workspaces`),
 * else the fenix-paths data home's `workspaces` folder.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function reposRoot(env = process.env) {
  if (env.GITHUB_ROOT) return path.resolve(env.GITHUB_ROOT);
  return path.join(dataHome(env), "workspaces");
}

/**
 * Git's stderr tail — the "fatal: ..." line. Trimmed for UI display.
 *
 * @param {unknown} err
 * @returns {string}
 */
function gitError(err) {
  const raw = err && typeof err === "object" ? String(err.stderr || err.message || "") : String(err);
  const line = raw.trim().split("\n").pop() || "";
  return line.slice(0, 300) || "git failed";
}

/**
 * Run `git <args>` in `cwd`, stdout only; throws with git's stderr on failure.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function gitOut(cwd, args) {
  const res = await execFileP("git", args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  return res.stdout;
}

/**
 * Removes `user:pass@` / `user@` credentials from a URL so remotes can be
 * shown in the UI without leaking tokens. scp-like remotes (`git@host:p`)
 * have no userinfo part and are returned unchanged.
 *
 * @param {string|null} url
 * @returns {string|null}
 */
export function stripCredentials(url) {
  if (typeof url !== "string" || !url) return url ?? null;
  try {
    const u = new URL(url);
    if (u.username === "" && u.password === "") return url;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Repo directory name for a URL — the last path segment without `.git`
 * (byte-identical to the entrypoint's `repo_name="$(basename "$repo_url" .git)"`).
 *
 * @param {string|null} url
 * @returns {string|null}
 */
export function repoNameFromUrl(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  const trimmed = url.trim().replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop()?.replace(/\.git$/i, "") || null;
  return name;
}

/**
 * Validates and normalizes a clone URL.
 *
 * Accepted (mirrors the entrypoint's `repo-add`):
 *   - `https://github.com/<owner>/<name>` (optional `.git`, optional trailing `/`)
 *   - `git@github.com:<owner>/<name>` (optional `.git`)
 *   - `<owner>/<name>` shorthand → `https://github.com/<owner>/<name>.git`
 *   - `file://` URLs and absolute local paths — only when `allowLocal` is set
 *     (tests + acceptance clone from local bare repos, never the network)
 *
 * Refused: every other scheme (http://, ssh://, git://, gitlab.com, ...),
 * URLs that start with `-` (would look like a git flag), and URLs carrying
 * embedded credentials — those would land in the git argv, and git reaches
 * GitHub through the container's credential helper instead.
 *
 * @param {string} url
 * @param {{ allowLocal?: boolean }} [opts]
 * @returns {{ ok: true, url: string, name: string } | { ok: false, reason: string }}
 */
export function validateRepoUrl(url, { allowLocal = false } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof url !== "string" || !url.trim()) return fail("no URL given");
  const u = url.trim();
  if (u.startsWith("-")) return fail("URL must not start with '-' (it would look like a git flag)");

  // file:// and absolute local paths — only when explicitly allowed.
  if (/^file:\/\//i.test(u)) {
    if (!allowLocal) return fail("file:// URLs are only allowed with FENIX_REPOS_ALLOW_LOCAL=1 (tests and acceptance)");
    let p;
    try {
      p = fileURLToPath(u);
    } catch {
      return fail(`not a valid file:// URL: ${u}`);
    }
    const name = repoNameFromUrl(p);
    if (!name || name === "." || name === "..") return fail(`cannot derive a repo name from ${u}`);
    return { ok: true, url: p, name };
  }
  if (/^[A-Za-z]:[\\/]/.test(u) || /^([\\/])\1/.test(u) || u.startsWith("/")) {
    if (!allowLocal) return fail("local paths are only allowed with FENIX_REPOS_ALLOW_LOCAL=1 (tests and acceptance)");
    const name = repoNameFromUrl(u);
    if (!name || name === "." || name === "..") return fail(`cannot derive a repo name from ${u}`);
    return { ok: true, url: path.resolve(u), name };
  }

  // scp-like SSH: git@github.com:owner/name(.git)
  const scp = new RegExp(`^git@github\\.com:([A-Za-z0-9-]+)/(${NAME_CHARS}+?)(\\.git)?$`, "i").exec(u);
  if (scp) return { ok: true, url: u, name: scp[2] };

  // https://github.com/owner/name(.git)
  if (/^https:\/\//i.test(u)) {
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      return fail(`not a valid https URL: ${u}`);
    }
    if (parsed.protocol !== "https:") return fail("only https:// URLs are accepted");
    if (parsed.hostname.toLowerCase() !== "github.com") {
      return fail("only https://github.com/<owner>/<name> is accepted");
    }
    if (parsed.username || parsed.password) {
      return fail("URL must not carry embedded credentials — git uses the container's credential helper");
    }
    const m = new RegExp(`^/([A-Za-z0-9-]+)/(${NAME_CHARS}+?)(\\.git)?/?$`).exec(parsed.pathname);
    if (!m) return fail("expected https://github.com/<owner>/<name>(.git)");
    return { ok: true, url: u, name: m[2] };
  }

  // owner/name shorthand → https://github.com/owner/name.git (entrypoint rule).
  const shorthand = new RegExp(`^([A-Za-z0-9-]+)/(${NAME_CHARS}+?)(\\.git)?$`).exec(u);
  if (shorthand) {
    return { ok: true, url: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`, name: shorthand[2] };
  }

  return fail(
    "expected https://github.com/<owner>/<name>, git@github.com:<owner>/<name>, or owner/name — " +
    "or file:// / an absolute path with FENIX_REPOS_ALLOW_LOCAL=1"
  );
}

/**
 * One row per shared clone, sorted by name — the shape the Repositories UI
 * consumes. Errors per repo become `{ name, error }` rows; one broken repo
 * never throws for the whole listing.
 *
 * - `origin`: remote URL with credentials stripped
 * - `branch`/`head`: current checked-out branch and short sha (null on unborn HEAD)
 * - `dirty`: `git status --porcelain` non-empty (staged, unstaged or untracked)
 * - `worktrees`: extra `git worktree add`-created worktrees (main excluded)
 * - `index`: `.codegraph/` presence → "ready" | "missing"
 * - `project`: mapped Linear project from the projects file, else null
 *
 * Skipped: non-directories, dirs without a `.git` directory (a worktree's
 * `.git` is a file — the main clone owns the row), and `la-wt` (the worktree
 * home, which the container mounts inside the clones root).
 *
 * @param {{ root?: string, projectsFile?: string|null }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function listRepos({ root, projectsFile } = {}) {
  const base = path.resolve(root || reposRoot());
  let projects = [];
  if (projectsFile !== null) {
    try {
      projects = listProjects(projectsFile || projectsConfigPath());
    } catch {
      projects = [];
    }
  }

  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }

  // The worktree home (LA_WORKTREE_HOME, else <base>/../la-wt — the name
  // comes from fenix-paths) is never listed: the container mounts it inside
  // the clones root, and its basename under the root is skipped by name too.
  const worktreeHome = path.resolve(path.dirname(worktreeRoot(base)));
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const dir = path.join(base, name);
    if (path.resolve(dir) === worktreeHome || name === path.basename(worktreeHome)) continue;
    let gitStat;
    try {
      gitStat = fs.statSync(path.join(dir, ".git"));
    } catch {
      continue; // no .git → not a clone
    }
    if (!gitStat.isDirectory()) continue; // worktree/submodule .git is a file — its main clone owns the row

    const row = { name, path: dir };
    try {
      let branch;
      try {
        branch = (await gitOut(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      } catch {
        // unborn HEAD (fresh clone, no commits yet) — rev-parse refuses, symbolic-ref still answers.
        branch = (await gitOut(dir, ["symbolic-ref", "--short", "HEAD"])).trim();
      }
      row.branch = branch;
      try {
        row.head = (await gitOut(dir, ["rev-parse", "--short", "HEAD"])).trim() || null;
      } catch {
        row.head = null;
      }
      row.dirty = (await gitOut(dir, ["status", "--porcelain"])).trim().length > 0;
    } catch (err) {
      rows.push({ name, error: gitError(err) });
      continue;
    }
    try {
      row.origin = stripCredentials((await gitOut(dir, ["remote", "get-url", "origin"])).trim()) || null;
    } catch {
      row.origin = null;
    }
    let worktrees = 1;
    try {
      worktrees = (await gitOut(dir, ["worktree", "list", "--porcelain"]))
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length;
    } catch {
      worktrees = 1;
    }
    row.worktrees = Math.max(worktrees - 1, 0);
    try {
      row.index = fs.existsSync(path.join(dir, ".codegraph")) ? "ready" : "missing";
    } catch {
      row.index = "missing";
    }
    const mapped = projects.find((p) => repoRefName(p?.repo) === name);
    row.project = mapped ? mapped.linearProject : null;
    rows.push(row);
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Background clone jobs
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const cloneJobs = new Map();

export function getCloneJob(id) {
  return cloneJobs.get(id);
}

export function listCloneJobs() {
  return [...cloneJobs.values()];
}

/** Test seam — clears the in-memory job table. */
export function resetCloneJobs() {
  cloneJobs.clear();
}

/**
 * Kicks off `git clone --progress -- <url> <root>/<name>` as a background job.
 * Returns `{ jobId }`, or `{ error }` when the URL is invalid, the target
 * directory already exists ("already cloned"), or two clones are already
 * running (the concurrency ceiling).
 *
 * The child is spawned as an argv array — no shell, so the URL (never
 * carrying a token) cannot be interpreted. `GIT_TERMINAL_PROMPT=0` keeps a
 * credential-less https URL from hanging on a prompt: git either reaches the
 * credential helper or fails cleanly. Progress lines from stderr land in
 * `job.progress`; on a nonzero exit the partial clone directory is removed
 * and the job is marked `{ status: "error", error: <stderr tail> }`.
 *
 * `spawnGit` is a test seam (defaults to child_process.spawn) so tests can
 * simulate slow/failing clones without waiting on real git.
 *
 * @param {{
 *   url: string,
 *   project?: string,
 *   root?: string,
 *   allowLocal?: boolean,
 *   projectsFile?: string,
 *   spawnGit?: typeof spawn,
 * }} opts
 * @returns {{ jobId?: string, error?: string }}
 */
export function startClone({ url, project, root, allowLocal = false, projectsFile, spawnGit = spawn } = {}) {
  const check = validateRepoUrl(url, { allowLocal });
  if (!check.ok) return { error: check.reason };

  const target = path.resolve(root || reposRoot());
  const dest = path.join(target, check.name);
  if (fs.existsSync(dest)) return { error: `already cloned: ${check.name} already exists in ${target}` };
  if (listCloneJobs().filter((job) => job.status === "cloning").length >= MAX_CONCURRENT_CLONES) {
    return { error: `clone limit reached — at most ${MAX_CONCURRENT_CLONES} concurrent clones` };
  }
  fs.mkdirSync(target, { recursive: true });

  const job = {
    id: randomUUID(),
    url: check.url,
    name: check.name,
    status: "cloning",
    progress: "",
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
  };
  cloneJobs.set(job.id, job);

  const finish = (outcome) => {
    if (job.status !== "cloning") return;
    job.endedAt = new Date().toISOString();
    if (!outcome.ok) {
      job.status = "error";
      job.error = outcome.error || "git clone failed";
      try {
        fs.rmSync(dest, { recursive: true, force: true });
      } catch {
        /* nothing left to clean */
      }
      return;
    }
    job.status = "done";
    if (project) {
      // Same mapping the entrypoint's repo-add writes: the repo path is the
      // literal ${GITHUB_ROOT} template, expanded later by consumers of the
      // projects file.
      try {
        addProject(projectsFile || process.env.LA_PROJECTS_FILE || projectsConfigPath(), {
          linearProject: project,
          workspace: "joi",
          repo: `\${GITHUB_ROOT}/${job.name}`,
          deploy: { type: "none" },
        });
      } catch (err) {
        job.error = `cloned ok, but project mapping failed: ${String(err?.message || err)}`;
      }
    }
  };

  let child;
  try {
    child = spawnGit("git", ["clone", "--progress", "--", check.url, dest], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (err) {
    finish({ ok: false, error: String(err?.message || err) });
    return { jobId: job.id };
  }
  child.stderr?.on?.("data", (chunk) => {
    // git sends progress updates separated by \r — keep the latest line.
    const last = String(chunk).split(/\r\n|\r|\n/).filter(Boolean).pop();
    if (last) job.progress = last.trim();
  });
  child.on("error", (err) => finish({ ok: false, error: String(err?.message || err) }));
  child.on("close", (code) => {
    finish(code === 0 ? { ok: true } : { ok: false, error: job.progress || `git clone exited with code ${code}` });
  });

  return { jobId: job.id };
}

/**
 * Removes every project mapping pointing at `name`'s repo (matching by
 * repoRefName: `${GITHUB_ROOT}/name`, a full path, or a bare `name` ref) and
 * rewrites the projects file only if something was removed. The repo's own
 * directory is never touched — unmapping is a bookkeeping change.
 *
 * @param {string} name
 * @param {{ projectsFile?: string }} [opts]
 * @returns {{ removed: string[] }} the linearProjects that pointed at the repo
 */
export function unmapRepo(name, { projectsFile } = {}) {
  const file = projectsFile || process.env.LA_PROJECTS_FILE || projectsConfigPath();
  return { removed: removeByRepo(file, name) };
}
