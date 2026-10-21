// scripts/mcp/server-fenix-github.mjs — MCP host that lets the Supervisor
// create/edit/comment pull requests without a shell command (FOC-943 W2).
// A thin wrapper over the existing scripts/gh-screened.mjs CLI: the FOC-450
// egress screen applies unchanged, and there is deliberately no merge tool —
// merging stays impossible through this surface.
//
// Flow per call: hand-validated arguments → repo_dir check (FOC-977: the PR
// tools take the absolute path of the checkout the PR belongs to — gh must
// start there, or it dies with "fatal: not a git repository" in the server's
// cwd) → in-process egress screen on the title/body (assertEgressClean, before
// anything leaves the process) → body through a temp file (--body-file, no
// shell) → gh-screened subprocess with cwd = repo_dir → typed envelope out.
// Fail-closed end to end: callTool never throws, a block is a typed
// egress_blocked envelope and the runner is never invoked.

import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertEgressClean } from "../egress-screen.mjs";
import { createMcpHandler, serveStdio } from "./jsonrpc.mjs";

export const SERVER_INFO = { name: "fenix-github", version: "0.1.0" };

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const PULL_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const BODY_TMP_PREFIX = "fenix-github-";

// FOC-977: repo_dir is the absolute path of the checkout the PR belongs to
// (e.g. /data/workspaces/<repo> or the child's worktree) — gh starts there.
const REPO_DIR_SCHEMA = {
  type: "string",
  description:
    "Absolute path of the git checkout the PR belongs to (e.g. /data/workspaces/<repo> or the child's worktree); gh runs with it as its cwd.",
};

export const TOOLS = [
  {
    name: "pr_create",
    description:
      "Create a pull request from a title and body, through the FOC-450 egress screen; merging is not available.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "body", "repo_dir"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 256 },
        body: { type: "string", minLength: 1, maxLength: 60000 },
        base: { type: "string", pattern: "^[A-Za-z0-9._/-]{1,200}$" },
        head: { type: "string", pattern: "^[A-Za-z0-9._/-]{1,200}$" },
        draft: { type: "boolean" },
        repo_dir: REPO_DIR_SCHEMA,
      },
    },
  },
  {
    name: "pr_edit",
    description:
      "Edit the title and/or body of an existing pull request, through the FOC-450 egress screen; merging is not available.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["number", "repo_dir"],
      properties: {
        number: { type: "integer", minimum: 1 },
        title: { type: "string", minLength: 1, maxLength: 256 },
        body: { type: "string", minLength: 1, maxLength: 60000 },
        repo_dir: REPO_DIR_SCHEMA,
      },
    },
  },
  {
    name: "pr_comment",
    description:
      "Add a comment to an existing pull request, through the FOC-450 egress screen; merging is not available.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["number", "body", "repo_dir"],
      properties: {
        number: { type: "integer", minimum: 1 },
        body: { type: "string", minLength: 1, maxLength: 60000 },
        repo_dir: REPO_DIR_SCHEMA,
      },
    },
  },
];

const ALLOWED_ARGS = {
  pr_create: new Set(["title", "body", "base", "head", "draft", "repo_dir"]),
  pr_edit: new Set(["number", "title", "body", "repo_dir"]),
  pr_comment: new Set(["number", "body", "repo_dir"]),
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(tool, message) {
  return { ok: false, tool, error: { code: "invalid_input", message } };
}

// Branch names only: no leading "-", no whitespace, no shell metacharacters —
// they become argv elements, but the tight pattern keeps gh flag injection
// out by construction.
function checkBranch(tool, key, value) {
  if (typeof value !== "string" || !BRANCH_RE.test(value) || value.startsWith("-")) {
    return invalid(tool, `${key} must be a branch name of 1..200 characters (letters, digits, . _ / -) and must not start with "-"`);
  }
  return null;
}

function checkText(tool, key, value, max) {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    return invalid(tool, `${key} must be a string of 1..${max} characters`);
  }
  return null;
}

function checkNumber(tool, value) {
  if (!Number.isInteger(value) || value < 1) {
    return invalid(tool, "number must be an integer >= 1");
  }
  return null;
}

// FOC-977: repo_dir validation. gh must start inside the checkout the PR
// belongs to, so the path is checked before anything runs: absolute (no ".."
// segments), an existing git work tree (real `git rev-parse` — repo_dir may be
// a subdirectory of the checkout and a linked worktree carries a .git FILE),
// and — only when an allowed-root env is set (FENIX_WORKSPACES/GITHUB_ROOT) —
// under one of those roots. With no root env set (local dev) any git work
// tree is accepted. Returns { real } on success or { invalid } on rejection.
const REPO_ROOT_ENVS = ["FENIX_WORKSPACES", "GITHUB_ROOT"];

function allowedRoots() {
  const roots = [];
  for (const envName of REPO_ROOT_ENVS) {
    const value = process.env[envName];
    if (!value) continue;
    try {
      roots.push(fs.realpathSync(value));
    } catch {
      // a root env pointing at a missing dir constrains nothing
    }
  }
  return roots;
}

function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function checkRepoDir(tool, value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { invalid: invalid(tool, "repo_dir is required: the absolute path of the checkout the PR belongs to (e.g. /data/workspaces/<repo> or the child's worktree)") };
  }
  if (!path.isAbsolute(value)) {
    return { invalid: invalid(tool, "repo_dir must be an absolute path") };
  }
  if (value.split(/[\\/]/).includes("..")) {
    return { invalid: invalid(tool, 'repo_dir must not contain ".."') };
  }
  let real;
  try {
    real = fs.realpathSync(value);
  } catch {
    return { invalid: invalid(tool, "repo_dir does not exist") };
  }
  const roots = allowedRoots();
  if (roots.length > 0 && !roots.some((root) => isWithin(root, real))) {
    return { invalid: invalid(tool, "repo_dir is outside the allowed roots (FENIX_WORKSPACES/GITHUB_ROOT)") };
  }
  const git = spawnSync("git", ["-C", real, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  if (git.status !== 0 || String(git.stdout ?? "").trim() !== "true") {
    return { invalid: invalid(tool, "repo_dir is not inside a git work tree") };
  }
  return { real };
}

function screenOrBlock(tool, parts) {
  // In-process and FIRST: a blocked value never reaches the runner, the temp
  // file, or the gh subprocess. The assert's message never contains the value.
  try {
    assertEgressClean(parts.filter(Boolean).join("\n"), `fenix-github ${tool}`);
    return null;
  } catch (err) {
    return { ok: false, tool, error: { code: "egress_blocked", message: String(err?.message ?? err) } };
  }
}

// Default runner: gh-screened as a child process, argv only (no shell), run
// with cwd = the validated repo_dir (FOC-977). Never rejects — a spawn failure
// surfaces as exit 127 (gh_missing), a timeout as exit 124 with timedOut
// (gh_timeout): a hung gh is not a missing gh.
function defaultRunGh(argv, { cwd } = {}) {
  const ghScreened = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gh-screened.mjs");
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [ghScreened, ...argv],
      { cwd, env: process.env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
        // A timeout kills the child: err.killed carries the signal, ETIMEDOUT
        // is the spawn-level shape. Both map to 124 — the GNU timeout code —
        // never to the 127 spawn-failure path below.
        if (err.killed || err.signal || err.code === "ETIMEDOUT") {
          return resolve({ exitCode: 124, timedOut: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? err.message) });
        }
        const exitCode = typeof err.code === "number" ? err.code : 127;
        resolve({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? err.message) });
      },
    );
  });
}

function last(text, max) {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(-max);
}

// The runner-side egress verdict is only ever a LINE at the start of gh-
// screened's stderr ("Error: [egress-blocked] …", "[egress-blocked] …" or
// "Blocked (first hit): <shape>"). Matching anchored at line start, stderr
// only — the word "egress-blocked" mid-line in gh's stdout (a PR title or
// body quoting the marker) is content, not a verdict.
const RUNNER_EGRESS_BLOCKED = /^(?:Error: )?\[egress-blocked\]|^Blocked \(first hit\):/m;

function mapResult(tool, res) {
  const stdout = String(res.stdout ?? "");
  const stderr = String(res.stderr ?? "");
  if (RUNNER_EGRESS_BLOCKED.test(stderr)) {
    // The runner's own screen fired; forward the verdict, not its stderr.
    return { ok: false, tool, error: { code: "egress_blocked", message: "the FOC-450 egress screen blocked this gh call" } };
  }
  if (res.exitCode === 0) {
    const envelope = { ok: true, tool, output: last(stdout.trim(), 4000) };
    const url = stdout.match(PULL_URL_RE);
    if (url) envelope.url = url[0];
    return envelope;
  }
  if (res.exitCode === 2) {
    return { ok: false, tool, error: { code: "refused", message: last(stderr || stdout, 2000), exitCode: res.exitCode } };
  }
  if (res.timedOut) {
    return { ok: false, tool, error: { code: "gh_timeout", message: "the gh-screened runner timed out", exitCode: res.exitCode } };
  }
  if (res.exitCode === 127) {
    return { ok: false, tool, error: { code: "gh_missing", message: "gh-screened runner could not be started (exit 127)" } };
  }
  return { ok: false, tool, error: { code: "gh_failed", message: last(stderr || stdout, 2000), exitCode: res.exitCode } };
}

export function createFenixGithubServer({ runGh } = {}) {
  const runner = runGh || defaultRunGh;

  // Body goes through a temp file inside a throwaway dir, removed in finally
  // whether the run succeeded, failed, or was mapped to an error envelope.
  // The --body-file flag sits right after the prefix (title/pr number); the
  // suffix carries the optional flags (--base/--head/--draft/--title edit).
  async function runWithBody(tool, argvPrefix, body, argvSuffix = [], cwd) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), BODY_TMP_PREFIX));
    try {
      const argv = [...argvPrefix];
      if (body !== undefined) {
        const bodyFile = path.join(dir, "body.md");
        fs.writeFileSync(bodyFile, body, "utf8");
        argv.push("--body-file", bodyFile);
      }
      argv.push(...argvSuffix);
      return mapResult(tool, await runner(argv, { cwd }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function callTool(name, args) {
    try {
      if (!ALLOWED_ARGS[name]) {
        return invalid(name, "unknown tool");
      }
      if (!isPlainObject(args)) {
        return invalid(name, "arguments must be an object");
      }
      for (const key of Object.keys(args)) {
        if (!ALLOWED_ARGS[name].has(key)) return invalid(name, `unknown argument: ${key}`);
      }

      // FOC-977: the PR tools must name the checkout they belong to — gh
      // starts there. Validated (and resolved to its realpath) before anything
      // else runs; a rejection is a typed invalid_input envelope.
      const repo = await checkRepoDir(name, args.repo_dir);
      if (repo.invalid) return repo.invalid;
      const cwd = repo.real;

      if (name === "pr_create") {
        let bad = checkText(name, "title", args.title, 256) || checkText(name, "body", args.body, 60000);
        if (bad) return bad;
        if (args.base !== undefined && (bad = checkBranch(name, "base", args.base))) return bad;
        if (args.head !== undefined && (bad = checkBranch(name, "head", args.head))) return bad;
        if (args.draft !== undefined && typeof args.draft !== "boolean") {
          return invalid(name, "draft must be a boolean");
        }
        bad = screenOrBlock(name, [args.title, args.body, args.base, args.head]);
        if (bad) return bad;
        const argvSuffix = [];
        if (args.base !== undefined) argvSuffix.push("--base", args.base);
        if (args.head !== undefined) argvSuffix.push("--head", args.head);
        if (args.draft) argvSuffix.push("--draft");
        return await runWithBody(name, ["pr", "create", "--title", args.title], args.body, argvSuffix, cwd);
      }

      if (name === "pr_edit") {
        const badNumber = checkNumber(name, args.number);
        if (badNumber) return badNumber;
        if (args.title === undefined && args.body === undefined) {
          return invalid(name, "at least one of title or body is required");
        }
        let bad = null;
        if (args.title !== undefined) bad = checkText(name, "title", args.title, 256);
        if (!bad && args.body !== undefined) bad = checkText(name, "body", args.body, 60000);
        if (bad) return bad;
        bad = screenOrBlock(name, [args.title, args.body]);
        if (bad) return bad;
        const argvSuffix = [];
        if (args.title !== undefined) argvSuffix.push("--title", args.title);
        return await runWithBody(name, ["pr", "edit", String(args.number)], args.body, argvSuffix, cwd);
      }

      // pr_comment
      if (checkNumber(name, args.number)) return checkNumber(name, args.number);
      const bad = checkText(name, "body", args.body, 60000) || screenOrBlock(name, [args.body]);
      if (bad) return bad;
      return await runWithBody(name, ["pr", "comment", String(args.number)], args.body, [], cwd);
    } catch (err) {
      // Fail-closed: a crash in validation or the runner is a typed envelope,
      // never a throw across the protocol boundary.
      return { ok: false, tool: name, error: { code: "internal_error", message: last(err?.message ?? err, 2000) } };
    }
  }

  const handler = createMcpHandler({ serverInfo: SERVER_INFO, tools: TOOLS, callTool });
  return { ...handler, serverInfo: SERVER_INFO, tools: TOOLS };
}

// ── stdio entry ──────────────────────────────────────────────────────────────
// stdout is protocol, never log; the one-line mode notice goes to stderr.

if (process.argv[1] && process.argv[1].endsWith("server-fenix-github.mjs")) {
  const server = createFenixGithubServer({});
  console.error(`[mcp] ${SERVER_INFO.name} on stdio`);
  await serveStdio(server.handleLine);
}
