#!/usr/bin/env node
// scripts/mcp/test/fake-upstream.mjs — a scriptable fake `codegraph serve
// --mcp` for the boundary tests. It speaks the same newline-delimited
// JSON-RPC surface (initialize / tools/list / tools/call / ping / echo,
// server-initiated roots/list) so scripts/mcp/server-codegraph.mjs can be
// driven end-to-end over real pipes without the real index.
//
// Behavior is selected by env so one binary covers every scenario:
//   FAKE_UPSTREAM_MODE      clean (default) | stale-first | stale-always |
//                           worktree | degraded | error | toolerror |
//                           hang | die | chatter
//   FAKE_UPSTREAM_DELAY_MS  answer tools/call after this delay (late-answer
//                           and timeout scenarios)
//   FAKE_UPSTREAM_ROOTS=1   after answering initialize, send a server→client
//                           roots/list request (mid-call passthrough tests)
//
// The staleness markers it emits are composed from split parts — the same
// discipline as server-codegraph.mjs itself: a contiguous marker literal in
// this file would make a codegraph query ABOUT this fixture trip the
// boundary's classifier (the source excerpt would contain the marker), and
// a fail-closed UNKNOWN for a clean tree is a false positive we can avoid.
// Tests import MARKERS from here instead of embedding literals, for the same
// reason.

import { createInterface } from "node:readline";
import { GATED_TOOLS, EXEMPT_TOOLS } from "../server-codegraph.mjs";

export const MARKERS = {
  staleBanner:
    "⚠️ Some files referenced below were edited since the last" +
    " index sync — their codegraph entries may be stale:",
  degraded:
    "⚠️ CodeGraph auto-sync is" + " DISABLED — live file watching stopped (#876)",
  worktree:
    "⚠ CodeGraph results below come from a different git" +
    " worktree (C:\\elsewhere\\repo), not where you're working (C:\\here\\repo) — they may reflect another branch, " +
    'and symbols changed only here are missing. Run "codegraph init -i" here for a worktree-local index.',
  driftSuffix:
    "· ⚠ changed since last" + " index sync — source below is current; the symbol list may be outdated",
  driftFooter: "> ⚠ Changed on disk after the last" + " index sync:",
};

const MODE = process.env.FAKE_UPSTREAM_MODE ?? "clean";
const DELAY_MS = Math.max(0, parseInt(process.env.FAKE_UPSTREAM_DELAY_MS ?? "0", 10) || 0);
const DO_ROOTS = process.env.FAKE_UPSTREAM_ROOTS === "1";

const received = []; // rolling record of every line this fake saw
const staleSeen = new Map(); // tools/call id -> attempts already answered

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function toolList() {
  return [...GATED_TOOLS, ...EXEMPT_TOOLS].sort().map((name) => ({
    name,
    description: `fake ${name}`,
    inputSchema: {
      type: "object",
      properties: { projectPath: { type: "string", description: "fake projectPath" } },
    },
  }));
}

function handleToolCall(id, params) {
  if (MODE === "die") {
    // Die with the call in flight — the boundary must type the refusal and
    // exit nonzero, not hang or half-answer.
    process.exit(7);
  }
  if (MODE === "hang") return; // never answer

  const attempts = (staleSeen.get(id) ?? 0) + 1;
  staleSeen.set(id, attempts);

  const clean = JSON.stringify({
    tool: params?.name,
    arguments: params?.arguments ?? {},
    upstream: {
      pid: process.pid,
      toolsEnv: process.env.CODEGRAPH_MCP_TOOLS ?? null,
      argv: process.argv.slice(2),
    },
  });

  let text = clean;
  let isError = false;
  if (MODE === "stale-first" && attempts === 1) {
    text = [MARKERS.staleBanner, `src/example.mjs ${MARKERS.driftSuffix}`, MARKERS.driftFooter, clean].join("\n\n");
  } else if (MODE === "stale-always") {
    text = [MARKERS.staleBanner, `src/example.mjs ${MARKERS.driftSuffix}`, clean].join("\n\n");
  } else if (MODE === "worktree") {
    text = `${MARKERS.worktree}\n\n${clean}`;
  } else if (MODE === "degraded") {
    text = `${MARKERS.degraded}\n\n${clean}`;
  } else if (MODE === "error") {
    out({ jsonrpc: "2.0", id, error: { code: -32602, message: "fake invalid params", data: { mode: MODE } } });
    return;
  } else if (MODE === "toolerror") {
    text = "fake tool failure — isError without staleness markers";
    isError = true;
  }

  const respond = () => out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } });
  if (MODE === "chatter") {
    // Valid answer first, then a non-JSON line: the boundary must drop the
    // chatter so its own stdout stays clean JSON-RPC.
    respond();
    process.stdout.write("this line is not json\n");
    return;
  }
  if (DELAY_MS > 0) setTimeout(respond, DELAY_MS);
  else respond();
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  received.push(text.slice(0, 400));
  if (received.length > 50) received.shift();
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
  if (typeof msg.method !== "string") return; // a client response (roots/list) — recorded above
  switch (msg.method) {
    case "initialize":
      out({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fake-upstream", version: "0.0.1" },
        },
      });
      if (DO_ROOTS) out({ jsonrpc: "2.0", id: "cg-srv-1", method: "roots/list", params: {} });
      return;
    case "tools/list":
      out({ jsonrpc: "2.0", id: msg.id, result: { tools: toolList() } });
      return;
    case "ping":
      out({ jsonrpc: "2.0", id: msg.id, result: { pong: true, received } });
      return;
    case "echo":
      out({ jsonrpc: "2.0", id: msg.id, result: msg.params ?? {} });
      return;
    case "tools/call":
      handleToolCall(msg.id, msg.params);
      return;
    default:
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `fake: unknown method ${msg.method}` } });
  }
});

console.error(`[fake-upstream] on stdio — mode=${MODE} delay=${DELAY_MS}ms roots=${DO_ROOTS}`);