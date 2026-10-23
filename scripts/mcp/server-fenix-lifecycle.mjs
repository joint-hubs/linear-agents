// scripts/mcp/server-fenix-lifecycle.mjs — the fenix-lifecycle MCP host (FOC-1007).
//
// The Supervisor's lifecycle writes need a deterministic channel. In auto mode
// Claude Code ignores broad interpreter allow rules such as `Bash(node:*)`, so
// every `node …` the Supervisor runs lands at the auto-mode classifier — which
// refused the sanctioned `supervisor-cleanup.mjs remove` of an APPROVED worktree
// ("Irreversible Local Destruction") on the FOC-789 run. FOC-943 solved the same
// problem for Linear and GitHub with exact-name MCP tools and exact allow rules;
// this server does it for the worktree cleanup.
//
// It is a channel, not a new authority. The tool runs the existing
// scripts/supervisor-cleanup.mjs `remove` unchanged, and THAT script still
// re-checks both keys — the TEST node produced Done, and the human answered the
// cleanup-approval gate — and pins the tree state he was shown. A refusal comes
// back as a typed envelope; nothing here can turn a key. Only the checkout goes:
// the branch and its commits stay reachable.
//
// The handler is exported programmatically on purpose: tests exercise the real
// message path with an injected runner, never spawning the script. Only the
// stdio entry touches process streams, and everything it logs goes to stderr —
// stdout is protocol, never log.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpHandler, serveStdio } from "./jsonrpc.mjs";
import { RUN_ID_RE } from "../utils.mjs";

export const SERVER_INFO = { name: "fenix-lifecycle", version: "0.1.0" };

const CHILD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const TOOLS = [
  {
    name: "cleanup_remove",
    description:
      "Remove a finished child's git worktree (supervisor-cleanup.mjs remove). Refused unless both keys are turned: TEST approved the issue (Done) and the human answered the cleanup-approval gate yes; the script re-checks both and the tree state he was shown. Only the checkout goes — the branch and its commits stay reachable.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["run", "child"],
      properties: {
        run: {
          type: "string",
          description: "The Supervisor run id, e.g. 2026-10-06T15-09-19-713-supervisor-26c7.",
          pattern: RUN_ID_RE.source,
        },
        child: { type: "string", description: "The child id whose worktree is reclaimed, e.g. dev-1.", pattern: CHILD_RE.source },
        repo: {
          type: "string",
          description: "Absolute path of the main checkout the worktree belongs to (the script's --repo), e.g. /data/workspaces/<repo>.",
          minLength: 1,
          maxLength: 1024,
        },
      },
    },
  },
];

const ALLOWED_ARGS = { cleanup_remove: new Set(["run", "child", "repo"]) };

const invalid = (tool, message) => ({ ok: false, tool, error: { code: "invalid_input", message } });
const last = (text, max) => {
  const s = String(text ?? "");
  return s.length <= max ? s : s.slice(-max);
};

/** Hand-rolled validation (the schema is documentation; the gate is here). Returns an envelope or null. */
function validate(name, args) {
  if (!ALLOWED_ARGS[name]) return invalid(name, "unknown tool");
  if (!args || typeof args !== "object" || Array.isArray(args)) return invalid(name, "arguments must be an object");
  for (const key of Object.keys(args)) {
    if (!ALLOWED_ARGS[name].has(key)) return invalid(name, `unknown property: ${key}`);
  }
  if (typeof args.run !== "string" || !RUN_ID_RE.test(args.run)) {
    return invalid(name, "run must be a Supervisor run id (e.g. 2026-10-06T15-09-19-713-supervisor-26c7)");
  }
  if (typeof args.child !== "string" || !CHILD_RE.test(args.child)) {
    return invalid(name, "child must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} (e.g. dev-1)");
  }
  if (args.repo !== undefined) {
    if (typeof args.repo !== "string" || args.repo.length === 0 || args.repo.length > 1024) return invalid(name, "repo must be a non-empty path");
    if (!path.isAbsolute(args.repo)) return invalid(name, "repo must be an absolute path");
    if (args.repo.split(/[\\/]/).includes("..")) return invalid(name, 'repo must not contain ".."');
  }
  return null;
}

/**
 * Map a supervisor-cleanup run onto the tool envelope. The script prints JSON on
 * stdout: `{ ok: false, error, … }` with exit 1 for a refusal (a key not turned,
 * the tree moved since the approval, unreadable Linear), the removal record with
 * exit 0 otherwise.
 */
function mapResult(tool, { exitCode, stdout, stderr, timedOut }) {
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // not JSON — fall through to the generic mappings
  }
  if (exitCode === 0) {
    return parsed && typeof parsed === "object"
      ? { ok: true, tool, result: parsed }
      : { ok: true, tool, output: last(String(stdout).trim(), 4000) };
  }
  if (timedOut) {
    return { ok: false, tool, error: { code: "cleanup_timeout", message: "the supervisor-cleanup runner timed out", exitCode } };
  }
  if (exitCode === 127) {
    return { ok: false, tool, error: { code: "cleanup_missing", message: "supervisor-cleanup could not be started (exit 127)" } };
  }
  if (parsed && parsed.ok === false && typeof parsed.error === "string") {
    const { ok: _ok, error, ...rest } = parsed;
    return { ok: false, tool, error: { code: "refused", message: last(error, 2000), exitCode, ...rest } };
  }
  return { ok: false, tool, error: { code: "cleanup_failed", message: last(stderr || stdout, 2000), exitCode } };
}

/**
 * The default runner: the real supervisor-cleanup CLI, argv only (no shell),
 * never rejects. A spawn failure maps to exit 127; a timeout kill to exit 124
 * with timedOut (the GNU timeout code) — a hung cleanup is not a missing one.
 */
function defaultRunCleanup(argv) {
  const script = fileURLToPath(new URL("../supervisor-cleanup.mjs", import.meta.url));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...argv],
      { env: process.env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err.killed || err.signal || err.code === "ETIMEDOUT")) {
          return resolve({ exitCode: 124, timedOut: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? err.message) });
        }
        const exitCode = typeof err?.code === "number" ? err.code : err ? 127 : 0;
        resolve({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err ? err.message : "")) });
      },
    );
  });
}

// Programmatic factory — tests inject runCleanup; the stdio entry uses the default.
export function createFenixLifecycleServer({ runCleanup } = {}) {
  const run = runCleanup || defaultRunCleanup;
  async function callTool(name, args) {
    // Never throw: every failure crosses the protocol boundary as a typed envelope.
    try {
      const bad = validate(name, args);
      if (bad) return bad;
      const argv = ["remove", "--run", args.run, "--child", args.child];
      if (args.repo !== undefined) argv.push("--repo", args.repo);
      return mapResult(name, await run(argv));
    } catch (err) {
      return { ok: false, tool: name, error: { code: "internal_error", message: last(err?.message ?? err, 2000) } };
    }
  }
  const handler = createMcpHandler({ serverInfo: SERVER_INFO, tools: TOOLS, callTool });
  return { ...handler, serverInfo: SERVER_INFO, tools: TOOLS };
}

// ── stdio entry ──────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("server-fenix-lifecycle.mjs")) {
  const server = createFenixLifecycleServer();
  console.error(`[mcp] ${SERVER_INFO.name} on stdio — supervisor-cleanup wrapper (both keys re-checked by the script)`);
  await serveStdio(server.handleLine);
}
