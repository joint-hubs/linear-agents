// scripts/mcp/server-fenix-linear.mjs — the fenix-linear MCP host (FOC-943).
//
// Lets the Supervisor write to Linear (transition / comment / comment-replace)
// through the MCP protocol instead of a shell command. A thin wrapper over the
// existing scripts/linear-ops.mjs CLI, so the FOC-450 egress screen and the
// FOC-848 ownership gate apply unchanged: bodies are screened here before the
// CLI runs, and every refusal from the CLI (ownership-*, egress-blocked,
// usage error) is mapped onto a typed error envelope.
//
// The handler is exported programmatically on purpose: tests exercise the real
// message path with an injected runner, never spawning the real CLI. Only the
// stdio entry touches process streams, and everything it logs goes to stderr —
// stdout is protocol, never log.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpHandler, serveStdio } from "./jsonrpc.mjs";
import { assertEgressClean, EGRESS_BLOCKED } from "../egress-screen.mjs";

export const SERVER_INFO = { name: "fenix-linear", version: "0.1.0" };

const ISSUE_SCHEMA = {
  type: "string",
  description: "Linear issue identifier, e.g. FOC-123.",
  pattern: "^[A-Z][A-Z0-9]*-[0-9]+$",
};
const BODY_SCHEMA = {
  type: "string",
  description: "Comment body (markdown). Screened for secrets before the CLI runs.",
  minLength: 1,
  maxLength: 60000,
};
const DEDUP_TAG_SCHEMA = {
  type: "string",
  description: "Dedup tag for idempotent posting, e.g. foc-943-w1.",
  pattern: "^[A-Za-z0-9._:-]{1,80}$",
};

export const TOOLS = [
  {
    name: "transition",
    description:
      "Move a Linear issue to a status (e.g. 'In Review'); goes through linear-ops with the egress screen and the ownership gate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue", "status"],
      properties: {
        issue: ISSUE_SCHEMA,
        status: { type: "string", description: "Target status name, e.g. 'In Review'." },
      },
    },
  },
  {
    name: "comment",
    description:
      "Post a comment on a Linear issue; goes through linear-ops with the egress screen and the ownership gate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue", "body"],
      properties: {
        issue: ISSUE_SCHEMA,
        body: BODY_SCHEMA,
        dedup_tag: DEDUP_TAG_SCHEMA,
      },
    },
  },
  {
    name: "comment_replace",
    description:
      "Replace the latest comment carrying a dedup tag on a Linear issue; goes through linear-ops with the egress screen and the ownership gate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue", "dedup_tag", "body"],
      properties: {
        issue: ISSUE_SCHEMA,
        dedup_tag: DEDUP_TAG_SCHEMA,
        body: BODY_SCHEMA,
      },
    },
  },
  {
    name: "attach_link",
    description:
      "Attach an external URL (PR, doc, etc.) to a Linear issue; goes through linear-ops with the egress screen and the ownership gate.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue", "url", "title"],
      properties: {
        issue: ISSUE_SCHEMA,
        url: { type: "string", description: "URL to attach (https:// or http://). Screened for secrets.", minLength: 1, maxLength: 2048 },
        title: { type: "string", description: "Human-readable title for the link.", minLength: 1, maxLength: 256 },
      },
    },
  },
];

const ISSUE_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const DEDUP_TAG_RE = /^[A-Za-z0-9._:-]{1,80}$/;

/** Hand-rolled validation (the schema is documentation; the gate is here). Returns null or a reason. */
function validateArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const allowed = name === "transition"
    ? ["issue", "status"]
    : name === "comment"
      ? ["issue", "body", "dedup_tag"]
      : name === "attach_link"
        ? ["issue", "url", "title"]
        : ["issue", "dedup_tag", "body"];
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) return `unknown property: ${key}`;
  }
  // required: everything the tool declares except the optional dedup_tag on comment
  const required = name === "transition"
    ? ["issue", "status"]
    : name === "comment"
      ? ["issue", "body"]
      : name === "attach_link"
        ? ["issue", "url", "title"]
        : ["issue", "dedup_tag", "body"];
  for (const key of required) {
    const value = args[key];
    if (typeof value !== "string" || value.length === 0) return `${key} is required`;
  }
  if (!ISSUE_RE.test(args.issue)) return "issue must match [A-Z][A-Z0-9]*-<n> (e.g. FOC-123)";
  if (args.dedup_tag !== undefined) {
    if (typeof args.dedup_tag !== "string" || !DEDUP_TAG_RE.test(args.dedup_tag)) return "dedup_tag must match [A-Za-z0-9._:-]{1,80}";
  }
  if (args.body !== undefined) {
    if (typeof args.body !== "string") return "body must be a string";
    if (args.body.length < 1 || args.body.length > 60000) return "body must be 1..60000 characters";
  }
  if (name === "attach_link") {
    if (typeof args.url !== "string" || !/^https?:\/\//.test(args.url)) return "url must start with https:// or http://";
    if (args.url.length > 2048) return "url must be at most 2048 characters";
    if (typeof args.title !== "string" || args.title.length < 1 || args.title.length > 256) return "title must be 1..256 characters";
  }
  return null;
}

/**
 * Map a linear-ops run onto the tool envelope. Ownership refusals surface as
 * their own code (ownership-foreign etc.), the CLI's own egress refusal as
 * egress_blocked, a runner timeout as linear_timeout, usage errors as
 * invalid_input, everything else as linear_ops_failed.
 */
function mapResult(tool, issue, { exitCode, stdout, stderr, timedOut }) {
  if (exitCode === 0) {
    return { ok: true, tool, issue, output: stdout.trim().slice(-4000) };
  }
  if (timedOut) {
    // The runner killed the CLI (exit 124, the GNU timeout code) — a hung
    // linear-ops is not a missing or failed one.
    return { ok: false, tool, error: { code: "linear_timeout", message: "the linear-ops runner timed out", exitCode } };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // not JSON — fall through to the generic mappings
  }
  if (parsed && parsed.ok === false && typeof parsed.code === "string" && parsed.code.startsWith("ownership-")) {
    return { ok: false, tool, error: { code: parsed.code, message: String(parsed.error ?? "") } };
  }
  if (stderr.includes("[egress-blocked]")) {
    return { ok: false, tool, error: { code: "egress_blocked", message: (stderr || stdout).slice(-2000) } };
  }
  if (exitCode === 2) {
    return { ok: false, tool, error: { code: "invalid_input", message: (stderr || stdout).slice(-2000) } };
  }
  return { ok: false, tool, error: { code: "linear_ops_failed", message: (stderr || stdout).slice(-2000), exitCode } };
}

/** Write the body to a temp file, run the CLI, always clean the temp dir up. */
async function runBodyTool(runOps, tool, args) {
  try {
    assertEgressClean(args.body, `fenix-linear ${tool} body`);
  } catch (err) {
    if (err && err.code === EGRESS_BLOCKED) {
      return { ok: false, tool, error: { code: "egress_blocked", message: err.message } };
    }
    throw err;
  }
  const dir = mkdtempSync(join(tmpdir(), "fenix-linear-"));
  try {
    const bodyPath = join(dir, "body.md");
    writeFileSync(bodyPath, args.body, "utf8");
    const argv = tool === "comment"
      ? ["comment", args.issue, "--body-file", bodyPath, ...(args.dedup_tag ? ["--dedup-tag", args.dedup_tag] : [])]
      : ["comment-replace", args.issue, "--dedup-tag", args.dedup_tag, "--body-file", bodyPath];
    return mapResult(tool, args.issue, await runOps(argv));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function dispatch(runOps, name, args) {
  if (name === "transition") {
    return mapResult(name, args.issue, await runOps(["transition", args.issue, "--status", args.status]));
  }
  if (name === "attach_link") {
    // Egress screen both values before the runner (same discipline as body).
    try {
      assertEgressClean(args.title, `fenix-linear attach_link title`);
      assertEgressClean(args.url, `fenix-linear attach_link URL`);
    } catch (err) {
      if (err && err.code === EGRESS_BLOCKED) {
        return { ok: false, tool: name, error: { code: "egress_blocked", message: err.message } };
      }
      throw err;
    }
    return mapResult(name, args.issue, await runOps(["attach-link", args.issue, "--url", args.url, "--title", args.title]));
  }
  return runBodyTool(runOps, name, args);
}

/**
 * The default runner: the real linear-ops CLI, no shell, never rejects.
 * A spawn failure (binary missing) maps to exitCode 127; a timeout kill
 * (err.killed / err.signal / ETIMEDOUT) maps to exitCode 124 with timedOut —
 * the GNU timeout code, never the 127 spawn-failure path.
 */
function defaultRunOps(argv) {
  const linearOps = fileURLToPath(new URL("../linear-ops.mjs", import.meta.url));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [linearOps, ...argv],
      { env: process.env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err.killed || err.signal || err.code === "ETIMEDOUT")) {
          return resolve({ exitCode: 124, timedOut: true, stdout: stdout ?? "", stderr: stderr ?? err.message });
        }
        const exitCode = typeof err?.exitCode === "number" ? err.exitCode : err ? 127 : 0;
        resolve({ exitCode, stdout: stdout ?? "", stderr: stderr ?? String(err && !err.exitCode ? err.message : "") });
      },
    );
  });
}

// Programmatic factory — tests inject runOps; the stdio entry uses the default.
export function createFenixLinearServer({ runOps } = {}) {
  const run = runOps || defaultRunOps;
  async function callTool(name, args) {
    // Never throw: every failure crosses the protocol boundary as a typed envelope.
    try {
      const invalid = validateArgs(name, args);
      if (invalid) return { ok: false, tool: name, error: { code: "invalid_input", message: invalid } };
      return await dispatch(run, name, args);
    } catch (err) {
      return { ok: false, tool: name, error: { code: "linear_ops_failed", message: String(err?.message ?? err).slice(-2000) } };
    }
  }
  const handler = createMcpHandler({ serverInfo: SERVER_INFO, tools: TOOLS, callTool });
  return { ...handler, serverInfo: SERVER_INFO, tools: TOOLS };
}

// ── stdio entry ──────────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("server-fenix-linear.mjs")) {
  const server = createFenixLinearServer();
  console.error(`[mcp] ${SERVER_INFO.name} on stdio — linear-ops wrapper (egress screen + ownership gate)`);
  await serveStdio(server.handleLine);
}
