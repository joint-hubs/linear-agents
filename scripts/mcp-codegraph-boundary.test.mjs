// scripts/mcp-codegraph-boundary.test.mjs — the fail-closed MCP boundary
// (scripts/mcp/server-codegraph.mjs) over the plan 2026-09-23 §4 contract.
//
//   node scripts/mcp-codegraph-boundary.test.mjs
//
// Three layers, all hermetic (no real codegraph, no repo index, no network):
//
//   unit   — createBoundary driven directly with an in-memory upstream seam
//            and an inline fake runtime: the full message path (gating,
//            injection, retry, classification, typed refusals, passthrough)
//            without a process.
//   config — .mcp.json wiring (node + project-relative adapter, the 8-verb
//            env, the codegraph-install rewrite hazard note) and the gated
//            surface constants.
//   spawn  — the real adapter binary over real pipes against
//            scripts/mcp/test/fake-upstream.mjs via CODEGRAPH_MCP_RUNTIME:
//            argv/`--path` composition, env passthrough, gate invocation with
//            the contract arguments, stdout cleanliness, child cleanup, exit
//            mirroring.
//
// Staleness markers are referenced from fake-upstream.mjs's composed MARKERS,
// never written here as contiguous literals: a marker literal in a test file
// would make a codegraph query ABOUT this test trip the boundary's classifier
// on a clean tree (the source excerpt would contain the marker).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GATED_TOOLS,
  EXEMPT_TOOLS,
  toolPolicy,
  classifyToolResult,
  unknownEnvelope,
  readBoundaryConfig,
  createBoundary,
} from "./mcp/server-codegraph.mjs";
import { MARKERS } from "./mcp/test/fake-upstream.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(join(__dir, ".."));
const ADAPTER = join(__dir, "mcp", "server-codegraph.mjs");
const RUNTIME_FAKE = join(__dir, "mcp", "test", "runtime-fake.mjs");

const UNIT_ROOT = "C:/guarded/root";
const UNIT_CONFIG = {
  gateTimeoutMs: 30_000,
  callTimeoutMs: 5_000,
  requestTimeoutMs: 2_000,
  staleRetries: 1,
  staleRetryDelayMs: 10,
};

let passed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  PASS " + name);
    })
    .catch((err) => {
      failures.push(name);
      console.log("  FAIL " + name + "\n       " + (err?.stack ?? err?.message ?? err));
    });
}

const fail = (msg) => { throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, what, timeoutMs = 4_000) {
  const start = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - start > timeoutMs) fail(`timeout waiting for ${what}`);
    await sleep(15);
  }
}

// ── unit harness ─────────────────────────────────────────────────────────────

function makeRuntime({ root = UNIT_ROOT, readyMode = "ok", readyReason = "pending never settles" } = {}) {
  const calls = { resolve: [], gate: [] };
  const canon = (p) => String(p).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return {
    calls,
    resolveProjectRoot({ projectRoot, cwd } = {}) {
      calls.resolve.push({ projectRoot, cwd });
      if (projectRoot !== undefined && projectRoot !== null) {
        return canon(projectRoot) === canon(root) ? root : projectRoot;
      }
      return root;
    },
    ensureCodegraphReady(opts) {
      calls.gate.push(opts);
      if (readyMode === "throw") throw new Error("the readiness guard exploded");
      if (readyMode === "ok") {
        return { ok: true, root, reason: "fresh", synced: false, initialized: true, version: "1.6.0-test" };
      }
      return { ok: false, root, reason: readyReason, synced: false, initialized: true, version: "1.6.0-test" };
    },
    resolveCodegraphCommand() {
      return { command: "unused-in-unit", args: [] };
    },
  };
}

function makeDrive({ runtime = makeRuntime(), root = UNIT_ROOT, rootDetail = null, config = UNIT_CONFIG, onUpstreamDied = null } = {}) {
  const clientLines = [];
  const upstreamSent = [];
  const logs = [];
  const seam = {
    send: (line) => { upstreamSent.push(line); return true; },
    kill: () => {},
  };
  const boundary = createBoundary({
    runtime,
    root,
    rootDetail,
    upstream: seam,
    writeClient: (line) => clientLines.push(line),
    log: (...a) => logs.push(a.map(String).join(" ")),
    config,
    onUpstreamDied,
  });
  const parse = (l) => { try { return JSON.parse(l); } catch { return { __unparseable: l }; } };
  return {
    boundary, runtime, clientLines, upstreamSent, logs,
    send: (msg) => boundary.handleClientLine(JSON.stringify(msg)),
    sendRaw: (line) => boundary.handleClientLine(line),
    upstreamSay: (obj) => boundary.handleUpstreamLine(JSON.stringify(obj)),
    clients: () => clientLines.map(parse),
    // waitClient: pred runs against PARSED CLIENT LINES (a response selector).
    waitClient: (pred, what, ms = 4_000) => waitFor(() => clientLines.map(parse).find(pred), what, ms),
    // wait: a plain condition poll (upstreamSent / gate counters / pendingCount).
    wait: (pred, what, ms = 4_000) => waitFor(pred, what, ms),
  };
}

const toolCall = (id, name, args, projectPath) => ({
  jsonrpc: "2.0", id, method: "tools/call",
  params: { name, arguments: { symbol: "someSymbol", ...(args ?? {}), ...(projectPath !== undefined ? { projectPath } : {}) } },
});
const upResult = (id, text, isError = false) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } });
const okText = (id) => `{"answer":"clean","id":${JSON.stringify(String(id))}}`;

// ── config: .mcp.json wiring ────────────────────────────────────────────────

console.log("\nconfig: .mcp.json wiring");

await test(".mcp.json routes codegraph through the boundary adapter (node + project-relative)", async () => {
  const cfg = JSON.parse(readFileSync(join(REPO, ".mcp.json"), "utf8"));
  const cg = cfg.mcpServers?.codegraph;
  if (!cg) fail("no codegraph entry in .mcp.json");
  if (cg.type !== "stdio") fail("type: " + cg.type);
  if (cg.command !== "node") fail("command must be node, got " + cg.command);
  if (JSON.stringify(cg.args) !== JSON.stringify(["scripts/mcp/server-codegraph.mjs"])) {
    fail("args must be the project-relative adapter: " + JSON.stringify(cg.args));
  }
  if (!existsSync(join(REPO, "scripts", "mcp", "server-codegraph.mjs"))) fail("adapter file missing on disk");
  // The boundary inherits the upstream allowlist env — losing it would silently
  // shrink the tool surface to `explore` only.
  if (cg.env?.CODEGRAPH_MCP_TOOLS !== "explore,node,search,callers,callees,impact,files,status") {
    fail("CODEGRAPH_MCP_TOOLS env lost: " + JSON.stringify(cg.env));
  }
  if (!String(cg._env ?? "").includes("codegraph install")) {
    fail("the codegraph-install rewrite hazard note must survive in _env");
  }
});

await test(".mcp.json leaves the fenix servers untouched", async () => {
  const cfg = JSON.parse(readFileSync(join(REPO, ".mcp.json"), "utf8"));
  const names = Object.keys(cfg.mcpServers).filter((n) => n.startsWith("fenix-"));
  if (names.length !== 2) fail("expected 2 fenix servers, got " + names.length);
  for (const n of names) {
    const s = cfg.mcpServers[n];
    if (s.command !== "node" || !Array.isArray(s.args) || !s.args[0]?.startsWith("scripts/mcp/")) {
      fail(`${n} was disturbed: ` + JSON.stringify(s));
    }
  }
});

await test("gated surface = 8 verbs minus status; status is exempt; unknown codegraph_* refused by policy", async () => {
  const verbs = ["explore", "node", "search", "callers", "callees", "impact", "files", "status"].map((v) => "codegraph_" + v);
  for (const v of verbs) {
    if (v === "codegraph_status") {
      if (GATED_TOOLS.has(v)) fail("status must be exempt (the guard's own instrument)");
      if (!EXEMPT_TOOLS.includes(v)) fail("status missing from EXEMPT_TOOLS");
    } else if (!GATED_TOOLS.has(v)) fail(v + " missing from GATED_TOOLS");
  }
  if (GATED_TOOLS.size !== 7) fail("GATED_TOOLS size: " + GATED_TOOLS.size);
  if (toolPolicy("codegraph_status") !== "exempt") fail("status policy: " + toolPolicy("codegraph_status"));
  if (toolPolicy("codegraph_callers") !== "gated") fail("known verb policy");
  // A future codegraph verb (the CLI already has `affected`; MCP may grow one)
  // must be refused, not forwarded ungated.
  if (toolPolicy("codegraph_affected") !== "unsupported") fail("future codegraph_* tool must be 'unsupported'");
  if (toolPolicy("codegraph_anything_new") !== "unsupported") fail("unknown codegraph_* tool must be 'unsupported'");
  if (toolPolicy("some_other_tool") !== "passthrough") fail("non-codegraph tools stay passthrough (not the boundary's surface)");
  if (toolPolicy(undefined) !== "passthrough") fail("nameless tools/call stays passthrough (upstream's protocol error)");
});

await test("readBoundaryConfig: defaults, overrides, and garbage→defaults with clamps", async () => {
  const def = readBoundaryConfig({});
  if (def.gateTimeoutMs !== 30_000 || def.callTimeoutMs !== 120_000 || def.requestTimeoutMs !== 30_000) fail("defaults: " + JSON.stringify(def));
  if (def.staleRetries !== 1 || def.staleRetryDelayMs !== 2_500) fail("retry defaults: " + JSON.stringify(def));
  const custom = readBoundaryConfig({
    CODEGRAPH_MCP_GATE_TIMEOUT_MS: "1000", CODEGRAPH_MCP_CALL_TIMEOUT_MS: "2000",
    CODEGRAPH_MCP_REQUEST_TIMEOUT_MS: "3000", CODEGRAPH_MCP_STALE_RETRIES: "9", CODEGRAPH_MCP_STALE_RETRY_DELAY_MS: "0",
  });
  if (custom.gateTimeoutMs !== 1000 || custom.callTimeoutMs !== 2000 || custom.requestTimeoutMs !== 3000) fail("overrides: " + JSON.stringify(custom));
  if (custom.staleRetries !== 5) fail("staleRetries must clamp to 5, got " + custom.staleRetries);
  const junk = readBoundaryConfig({ CODEGRAPH_MCP_CALL_TIMEOUT_MS: "soon", CODEGRAPH_MCP_STALE_RETRIES: "-3" });
  if (junk.callTimeoutMs !== 120_000 || junk.staleRetries !== 1) fail("garbage must fall back to defaults: " + JSON.stringify(junk));
});

// ── unit: classification + envelope shape ───────────────────────────────────

console.log("\nunit: classification and UNKNOWN envelope");

await test("classifyToolResult: banner head, drift bodies, worktree, degraded, clean", async () => {
  const withHead = (head, body) => ({ content: [{ type: "text", text: head + "\n\n" + body }] });
  if (!classifyToolResult(withHead(MARKERS.staleBanner, "x")).stale) fail("stale banner not detected");
  if (!classifyToolResult(withHead(MARKERS.degraded, "x")).degraded) fail("degraded banner not detected");
  if (classifyToolResult(withHead(MARKERS.degraded, "x")).stale) fail("degraded-only must NOT count as stale");
  const wt = classifyToolResult(withHead(MARKERS.worktree, "x"));
  if (!wt.wrongCheckout || wt.stale) fail("worktree notice must be wrongCheckout, not stale");
  // Drift markers arrive mid-body (per-file suffix / summary footer), not as heads.
  if (!classifyToolResult({ content: [{ type: "text", text: "src/a.mjs " + MARKERS.driftSuffix }] }).stale) fail("drift suffix not detected");
  if (!classifyToolResult({ content: [{ type: "text", text: "callers of X\n" + MARKERS.driftFooter + "\n  - b.mjs" }] }).stale) fail("drift footer not detected");
  // Case-insensitive drift (upstream's footer capitalizes "Changed").
  if (!classifyToolResult({ content: [{ type: "text", text: MARKERS.driftFooter.toUpperCase() }] }).stale) fail("case-insensitive drift missed");
  const clean = classifyToolResult({ content: [{ type: "text", text: "callers of X\n  - a.mjs:10" }] });
  if (clean.stale || clean.wrongCheckout || clean.degraded) fail("clean result misclassified: " + JSON.stringify(clean));
  if (classifyToolResult({}).stale) fail("empty result must classify clean");
});

await test("classifyToolResult: padded/ANSI-wrapped heads still trip (heads are position-anchored)", async () => {
  // Upstream may color or pad a banner; the heads are anchored positionally, so
  // classification must survive cosmetics. Wrappers are composed, never literal,
  // so this test cannot echo marker text into a query about the fixture itself.
  const wrap = (head) => ({
    content: [{ type: "text", text: "\n\n  \x1b[2m\x1b[1m" + head + "\x1b[0m\n" }],
  });
  if (!classifyToolResult(wrap(MARKERS.staleBanner)).stale) fail("ANSI+padding: stale banner missed");
  if (!classifyToolResult(wrap(MARKERS.degraded)).degraded) fail("ANSI+padding: degraded banner missed");
  const wt = classifyToolResult(wrap(MARKERS.worktree));
  if (!wt.wrongCheckout || wt.stale) fail("ANSI+padding: worktree must stay wrongCheckout, not stale");
  // OSC (title-set) sequences before the head must be stripped too.
  const osc = (head) => ({ content: [{ type: "text", text: "\x1b]0;codegraph\x07" + head + "\n" }] });
  if (!classifyToolResult(osc(MARKERS.staleBanner)).stale) fail("OSC-prefixed stale banner missed");
  // ANSI-wrapped drift footer mid-body.
  const wrappedFooter = { content: [{ type: "text", text: "callers of X\n\x1b[33m" + MARKERS.driftFooter + "\x1b[0m\n  - b.mjs" }] };
  if (!classifyToolResult(wrappedFooter).stale) fail("ANSI-wrapped drift footer missed");
});

await test("unknownEnvelope: isError, typed JSON header, fix, sanctioned fallback, no symbol leak", async () => {
  const env = unknownEnvelope("not-ready", "index freshness could not be proven: pending changes", "sync it");
  if (env.isError !== true) fail("UNKNOWN must be isError");
  const head = JSON.parse(env.content[0].text.split("\n")[0]);
  if (head.boundary !== "codegraph-mcp" || head.status !== "UNKNOWN" || head.type !== "not-ready") fail("header: " + env.content[0].text.split("\n")[0]);
  if (!env.content[0].text.includes("Sanctioned fallback")) fail("the direct-file fallback must be sanctioned");
  if (!env.content[0].text.includes("sync it")) fail("the fix must be carried");
});

// ── unit: passthrough (everything the boundary must NOT touch) ──────────────

console.log("\nunit: passthrough");

await test("initialize and tools/list are forwarded verbatim, responses verbatim back", async () => {
  const d = makeDrive();
  const initLine = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  d.sendRaw(initLine);
  if (d.upstreamSent[0] !== initLine) fail("initialize not forwarded byte-verbatim: " + d.upstreamSent[0]);
  d.upstreamSay({ jsonrpc: "2.0", id: 0, result: { serverInfo: { name: "real-codegraph" } } });
  const back = await d.waitClient((m) => m.id === 0, "initialize response");
  if (back.result.serverInfo.name !== "real-codegraph") fail("initialize response mangled");
  d.send({ jsonrpc: "2.0", id: "ls", method: "tools/list" });
  d.upstreamSay({ jsonrpc: "2.0", id: "ls", result: { tools: [{ name: "codegraph_explore" }] } });
  const ls = await d.waitClient((m) => m.id === "ls", "tools/list response");
  if (ls.result.tools[0].name !== "codegraph_explore") fail("tools/list response mangled");
});

await test("notifications are forwarded and never answered", async () => {
  const d = makeDrive();
  d.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await sleep(60);
  if (d.upstreamSent.length !== 1) fail("notification not forwarded");
  if (d.clientLines.length !== 0) fail("a notification must not produce a client line: " + d.clientLines.join("|"));
});

await test("client responses to server-initiated requests pass through untouched", async () => {
  const d = makeDrive();
  const respLine = JSON.stringify({ jsonrpc: "2.0", id: "cg-srv-1", result: { roots: [{ uri: "file:///C:/guarded/root", name: "root" }] } });
  d.sendRaw(respLine);
  await sleep(30);
  if (d.upstreamSent[0] !== respLine) fail("client response not forwarded verbatim");
});

await test("upstream server→client requests and notifications reach the client verbatim", async () => {
  const d = makeDrive();
  const reqLine = JSON.stringify({ jsonrpc: "2.0", id: "cg-srv-2", method: "roots/list", params: {} });
  d.boundary.handleUpstreamLine(reqLine);
  const got = await d.waitClient((m) => m.method === "roots/list", "roots/list forwarded");
  if (JSON.stringify(got) !== reqLine) fail("server request mangled: " + JSON.stringify(got));
  d.boundary.handleUpstreamLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }));
  await d.waitClient((m) => m.method === "notifications/cancelled", "upstream notification forwarded");
});

await test("a malformed client line answers -32700 with null id and the stream stays usable", async () => {
  const d = makeDrive();
  d.sendRaw("{not json");
  const err = await d.waitClient((m) => m.error?.code === -32700, "parse error");
  if (err.id !== null) fail("parse error must answer with null id");
  d.send({ jsonrpc: "2.0", id: 55, method: "ping" });
  d.upstreamSay({ jsonrpc: "2.0", id: 55, result: {} });
  const pong = await d.waitClient((m) => m.id === 55, "post-error request");
  if (!pong.result) fail("stream unusable after a malformed line");
});

await test("a non-JSON upstream stdout line is dropped — client stdout stays clean", async () => {
  const d = makeDrive();
  d.boundary.handleUpstreamLine("definitely not json");
  await sleep(50);
  if (d.clientLines.length !== 0) fail("non-JSON upstream line leaked to the client");
  if (!d.logs.some((l) => l.includes("dropped"))) fail("the drop must be logged");
});

// ── unit: the gate ───────────────────────────────────────────────────────────

console.log("\nunit: freshness gate");

await test("a gated call runs the gate with the contract arguments, then injects projectPath = the proven root", async () => {
  const d = makeDrive();
  d.send(toolCall(11, "codegraph_callers"));
  await d.wait(() => d.upstreamSent.length > 0, "gated call forwarded");
  const gate = d.runtime.calls.gate[0];
  if (gate.projectRoot !== UNIT_ROOT || gate.initialize !== false || gate.timeoutMs !== UNIT_CONFIG.gateTimeoutMs) {
    fail("gate arguments: " + JSON.stringify(gate));
  }
  const sent = JSON.parse(d.upstreamSent[0]);
  if (sent.params.arguments.projectPath !== UNIT_ROOT) fail("projectPath not injected as the proven root: " + JSON.stringify(sent.params.arguments));
  d.upstreamSay(upResult(11, okText(11)));
  const got = await d.waitClient((m) => m.id === 11, "clean gated response");
  if (JSON.parse(got.result.content[0].text).answer !== "clean") fail("clean response mangled");
});

await test("a gated call without an arguments object still gets the injection", async () => {
  const d = makeDrive();
  d.send({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "codegraph_search" } });
  await d.wait(() => d.upstreamSent.length > 0, "gated call forwarded");
  const sent = JSON.parse(d.upstreamSent[0]);
  if (sent.params.arguments.projectPath !== UNIT_ROOT) fail("injection missing without arguments: " + JSON.stringify(sent.params));
  d.upstreamSay(upResult(12, okText(12)));
  await d.waitClient((m) => m.id === 12, "response");
});

await test("a caller projectPath spelling of the SAME root is accepted and normalized", async () => {
  const d = makeDrive();
  d.send(toolCall(13, "codegraph_explore", null, "C:\\guarded\\root\\"));
  await d.wait(() => d.upstreamSent.length > 0, "forwarded");
  const sent = JSON.parse(d.upstreamSent[0]);
  if (sent.params.arguments.projectPath !== UNIT_ROOT) fail("same-root projectPath not normalized onto the guarded root: " + sent.params.arguments.projectPath);
  d.upstreamSay(upResult(13, okText(13)));
  await d.waitClient((m) => m.id === 13, "response");
});

await test("a projectPath from ANOTHER project is refused as project-mismatch and never forwarded", async () => {
  const d = makeDrive();
  d.send(toolCall(14, "codegraph_explore", null, "C:/other/project"));
  const got = await d.waitClient((m) => m.id === 14, "refusal");
  if (d.upstreamSent.length !== 0) fail("a mismatched projectPath must not reach upstream");
  const head = JSON.parse(got.result.content[0].text.split("\n")[0]);
  if (head.status !== "UNKNOWN" || head.type !== "project-mismatch") fail("typed wrong: " + head.type);
  if (got.result.isError !== true) fail("refusal must be isError");
  // The boundary stays alive for the next caller.
  d.send({ jsonrpc: "2.0", id: 15, method: "ping" });
  d.upstreamSay({ jsonrpc: "2.0", id: 15, result: {} });
  await d.waitClient((m) => m.id === 15, "boundary alive after refusal");
});

await test("gate !ok → typed not-ready carrying the guard's reason; nothing forwarded", async () => {
  const d = makeDrive({ runtime: makeRuntime({ readyMode: "notready" }) });
  d.send(toolCall(16, "codegraph_impact"));
  const got = await d.waitClient((m) => m.id === 16, "not-ready refusal");
  if (d.upstreamSent.length !== 0) fail("an unproven call must not be forwarded");
  const head = JSON.parse(got.result.content[0].text.split("\n")[0]);
  if (head.type !== "not-ready") fail("typed wrong: " + head.type);
  if (!got.result.content[0].text.includes("pending never settles")) fail("the guard's reason must be carried");
});

await test("a throwing gate → guard-error UNKNOWN (the guard's crash is not a verdict)", async () => {
  const d = makeDrive({ runtime: makeRuntime({ readyMode: "throw" }) });
  d.send(toolCall(17, "codegraph_files"));
  const got = await d.waitClient((m) => m.id === 17, "guard-error refusal");
  const head = JSON.parse(got.result.content[0].text.split("\n")[0]);
  if (head.type !== "guard-error") fail("typed wrong: " + head.type);
  if (d.upstreamSent.length !== 0) fail("nothing may be forwarded when the guard crashes");
});

await test("no runtime → guard-unavailable; no root → root-unresolved (both fail closed)", async () => {
  const d1 = makeDrive({ runtime: null });
  d1.send(toolCall(18, "codegraph_node"));
  const g1 = await d1.waitClient((m) => m.id === 18, "guard-unavailable");
  if (JSON.parse(g1.result.content[0].text.split("\n")[0]).type !== "guard-unavailable") fail("no-runtime typed wrong");
  if (d1.upstreamSent.length !== 0) fail("no runtime → no gated forwarding");

  const d2 = makeDrive({ root: null, rootDetail: "resolveProjectRoot threw at startup: no git worktree" });
  d2.send(toolCall(19, "codegraph_node"));
  const g2 = await d2.waitClient((m) => m.id === 19, "root-unresolved");
  const text = g2.result.content[0].text;
  if (JSON.parse(text.split("\n")[0]).type !== "root-unresolved") fail("no-root typed wrong");
  if (!text.includes("no git worktree")) fail("root-unresolved must carry the startup detail");
});

await test("codegraph_status bypasses the gate; a non-codegraph tool passes through", async () => {
  const d = makeDrive();
  d.send(toolCall(20, "codegraph_status"));
  d.send(toolCall(33, "some_other_tool"));
  await d.wait(() => d.upstreamSent.length === 2, "both forwarded");
  if (d.runtime.calls.gate.length !== 0) fail("the gate must not run for status/non-codegraph tools");
  d.upstreamSay(upResult(20, okText(20)));
  d.upstreamSay(upResult(33, okText(33)));
  await d.waitClient((m) => m.id === 20, "status response");
  await d.waitClient((m) => m.id === 33, "non-codegraph tool response");
});

await test("an unknown codegraph_* tool is refused typed and NEVER forwarded (no ungated index surface)", async () => {
  const d = makeDrive();
  d.send(toolCall(21, "codegraph_future_tool"));
  const got = await d.waitClient((m) => m.id === 21, "refusal");
  if (d.upstreamSent.length !== 0) fail("an unknown codegraph_* tool must not reach upstream");
  if (d.runtime.calls.gate.length !== 0) fail("the refusal is structural — the gate must not run");
  const head = JSON.parse(got.result.content[0].text.split("\n")[0]);
  if (head.status !== "UNKNOWN" || head.type !== "unsupported-guarded-tool") fail("typed wrong: " + head.type);
  if (got.result.isError !== true) fail("refusal must be isError");
  if (!got.result.content[0].text.includes("codegraph_future_tool")) fail("the refusal must name the refused tool");
  // The boundary stays alive for the next caller.
  d.send({ jsonrpc: "2.0", id: 34, method: "ping" });
  d.upstreamSay({ jsonrpc: "2.0", id: 34, result: {} });
  await d.waitClient((m) => m.id === 34, "boundary alive after refusal");
});

// ── unit: stale handling ─────────────────────────────────────────────────────

console.log("\nunit: stale answers and bounded retry");

await test("a stale-marked answer triggers re-gate + re-send; the clean retry is forwarded with the ORIGINAL id", async () => {
  const d = makeDrive();
  d.send(toolCall(22, "codegraph_explore"));
  await d.wait(() => d.upstreamSent.length === 1, "first send");
  d.upstreamSay(upResult(22, MARKERS.staleBanner + "\n\n" + "stale body"));
  await d.wait(() => d.upstreamSent.length === 2, "retry send");
  await d.wait(() => d.runtime.calls.gate.length === 2, "re-gate");
  d.upstreamSay(upResult(22, okText(22)));
  const got = await d.waitClient((m) => m.id === 22, "clean retry response");
  if (JSON.parse(got.result.content[0].text).answer !== "clean") fail("retry response mangled");
  if (JSON.parse(d.upstreamSent[1]).id !== 22) fail("retry must reuse the client's id");
  if (!d.logs.some((l) => l.includes("stale response"))) fail("the stale hit must be logged");
});

await test("drift markers deep in the body (no banner head) also trigger the retry", async () => {
  const d = makeDrive();
  d.send(toolCall(23, "codegraph_node"));
  await d.wait(() => d.upstreamSent.length === 1, "first send");
  d.upstreamSay(upResult(23, "node info\nsrc/x.mjs " + MARKERS.driftSuffix));
  await d.wait(() => d.upstreamSent.length === 2, "retry send");
  d.upstreamSay(upResult(23, okText(23)));
  await d.waitClient((m) => m.id === 23, "clean response");
});

await test("persistently stale → stale-after-retry UNKNOWN; the stale body NEVER reaches the client", async () => {
  const d = makeDrive();
  d.send(toolCall(24, "codegraph_search"));
  await d.wait(() => d.upstreamSent.length === 1, "first send");
  d.upstreamSay(upResult(24, MARKERS.staleBanner + "\n\nstale body 1"));
  await d.wait(() => d.upstreamSent.length === 2, "retry send");
  d.upstreamSay(upResult(24, MARKERS.staleBanner + "\n\nstale body 2"));
  const got = await d.waitClient((m) => m.id === 24, "final refusal");
  const head = JSON.parse(got.result.content[0].text.split("\n")[0]);
  if (head.type !== "stale-after-retry") fail("typed wrong: " + head.type);
  if (got.result.content[0].text.includes("stale body")) fail("stale content leaked to the client");
  if (d.upstreamSent.length !== 1 + UNIT_CONFIG.staleRetries) fail("retry count wrong: " + d.upstreamSent.length);
});

await test("a wrong-worktree notice is refused WITHOUT a retry (structural, not a race)", async () => {
  const d = makeDrive();
  d.send(toolCall(25, "codegraph_callers"));
  await d.wait(() => d.upstreamSent.length === 1, "first send");
  d.upstreamSay(upResult(25, MARKERS.worktree + "\n\nborrowed answer"));
  const got = await d.waitClient((m) => m.id === 25, "wrong-checkout refusal");
  await sleep(80);
  if (d.upstreamSent.length !== 1) fail("wrong-checkout must not be retried");
  const head = JSON.parse(got.result.content[0].text.split("\n")[0]);
  if (head.type !== "wrong-checkout") fail("typed wrong: " + head.type);
});

await test("a degraded-only banner is passed through as information (the gate already proved freshness)", async () => {
  const d = makeDrive();
  d.send(toolCall(26, "codegraph_files"));
  await d.wait(() => d.upstreamSent.length === 1, "first send");
  d.upstreamSay(upResult(26, MARKERS.degraded + "\n\n" + okText(26)));
  const got = await d.waitClient((m) => m.id === 26, "degraded passthrough");
  if (got.result.isError) fail("degraded-only must not be refused");
  if (!got.result.content[0].text.includes("DISABLED")) fail("degraded banner must be carried verbatim");
  if (d.runtime.calls.gate.length !== 1) fail("degraded-only must not re-run the gate");
});

await test("upstream's own errors pass verbatim: protocol error, and isError result without markers", async () => {
  const d = makeDrive();
  d.send(toolCall(27, "codegraph_callers"));
  await d.wait(() => d.upstreamSent.length === 1, "sent");
  d.upstreamSay({ jsonrpc: "2.0", id: 27, error: { code: -32602, message: "unknown symbol", data: { x: 1 } } });
  const e = await d.waitClient((m) => m.id === 27, "protocol error passthrough");
  if (e.error.code !== -32602 || e.error.message !== "unknown symbol") fail("protocol error mangled: " + JSON.stringify(e));

  d.send(toolCall(28, "codegraph_callers"));
  await d.wait(() => d.upstreamSent.length === 2, "second sent");
  d.upstreamSay(upResult(28, "NotIndexedError: project is not indexed — use Read/Grep/Glob", true));
  const t = await d.waitClient((m) => m.id === 28, "isError passthrough");
  if (t.result.isError !== true) fail("upstream isError flag lost");
  if (t.result.content[0].text !== "NotIndexedError: project is not indexed — use Read/Grep/Glob") fail("isError text mangled");
});

// ── unit: timeouts, death, concurrency ──────────────────────────────────────

console.log("\nunit: timeouts, upstream death, concurrency");

await test("a gated call that never answers becomes upstream-timeout UNKNOWN; the late answer is dropped", async () => {
  const d = makeDrive({ config: { ...UNIT_CONFIG, callTimeoutMs: 60, requestTimeoutMs: 60 } });
  d.send(toolCall(29, "codegraph_explore"));
  const got = await d.waitClient((m) => m.id === 29, "timeout refusal", 3_000);
  const head = JSON.parse(got.result.content[0].text.split("\n")[0]);
  if (head.type !== "upstream-timeout") fail("typed wrong: " + head.type);
  d.upstreamSay(upResult(29, okText(29))); // late — must be dropped, not forwarded
  await sleep(120);
  const dupes = d.clients().filter((m) => m.id === 29);
  if (dupes.length !== 1) fail("late answer after timeout leaked: " + dupes.length + " lines for id 29");
  if (!d.logs.some((l) => l.includes("unmatched upstream response"))) fail("the late drop must be logged");
});

await test("a plain request that times out gets a -32603 with typed data", async () => {
  const d = makeDrive({ config: { ...UNIT_CONFIG, requestTimeoutMs: 60 } });
  d.send({ jsonrpc: "2.0", id: 30, method: "tools/list" });
  const got = await d.waitClient((m) => m.id === 30, "plain timeout", 3_000);
  if (got.error?.code !== -32603) fail("expected -32603, got " + JSON.stringify(got.error));
  if (got.error?.data?.type !== "upstream-timeout") fail("typed data missing: " + JSON.stringify(got.error));
});

await test("upstream exit mid-call: gated → typed upstream-exited, plain → -32603, died fired once", async () => {
  let died = 0;
  const d = makeDrive({ onUpstreamDied: () => { died++; } });
  d.send(toolCall(31, "codegraph_search"));
  d.send({ jsonrpc: "2.0", id: 32, method: "tools/list" });
  // Both must be registered before the exit event, or the death races a
  // registration microtask and one call gets a timeout instead of the typed
  // death refusal.
  await d.wait(() => d.boundary.pendingCount === 2, "both in flight");
  d.boundary.handleUpstreamExit(1, null);
  const g = await d.waitClient((m) => m.id === 31, "gated death refusal");
  const p = await d.waitClient((m) => m.id === 32, "plain death error");
  if (JSON.parse(g.result.content[0].text.split("\n")[0]).type !== "upstream-exited") fail("gated death typed wrong");
  if (p.error?.code !== -32603 || p.error?.data?.type !== "upstream-unavailable") fail("plain death typed wrong: " + JSON.stringify(p.error));
  if (died !== 1) fail("onUpstreamDied fired " + died + " times");
  d.boundary.handleUpstreamExit(1, null); // late second event — must not re-fire
  await sleep(40);
  if (died !== 1) fail("duplicate exit event re-fired onUpstreamDied");
  if (d.boundary.pendingCount !== 0) fail("pendings must be flushed");
});

await test("concurrent gated calls route out-of-order responses to the right ids", async () => {
  const d = makeDrive();
  d.send(toolCall(40, "codegraph_callers"));
  d.send(toolCall(41, "codegraph_callees"));
  await d.wait(() => d.upstreamSent.length === 2, "both sent");
  if (d.boundary.pendingCount !== 2) fail("both must be in flight");
  d.upstreamSay(upResult(41, okText(41))); // answer the second first
  d.upstreamSay(upResult(40, okText(40)));
  const m40 = await d.waitClient((m) => m.id === 40, "id 40 routed");
  const m41 = await d.waitClient((m) => m.id === 41, "id 41 routed");
  if (JSON.parse(m40.result.content[0].text).id !== "40" || JSON.parse(m41.result.content[0].text).id !== "41") fail("cross-routed responses");
});

// ── spawn: the real binary over real pipes ─────────────────────────────────

console.log("\nspawn: real adapter process (fake upstream + injected runtime)");

class AdapterProc {
  constructor(root, envOverrides = {}, args = []) {
    this.root = root;
    this.lines = [];
    this.stderr = [];
    this.waiters = new Map();
    this.sawNonJson = false;
    this.proc = spawn(process.execPath, [ADAPTER, ...args], {
      cwd: root,
      env: { ...process.env, ...envOverrides },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (l) => {
      this.lines.push(l);
      try {
        const m = JSON.parse(l);
        if (m && m.id !== undefined && this.waiters.has(m.id)) {
          const w = this.waiters.get(m.id);
          this.waiters.delete(m.id);
          w(m);
        }
      } catch {
        this.sawNonJson = true;
      }
    });
    const erl = createInterface({ input: this.proc.stderr });
    // Writing stdin after the adapter died must not crash the test runner.
    this.proc.stdin.on("error", () => {});
    erl.on("line", (l) => this.stderr.push(l));
    this.exited = new Promise((res) => this.proc.on("exit", (code, signal) => res({ code, signal })));
  }
  send(obj) { this.proc.stdin.write(JSON.stringify(obj) + "\n"); }
  call(obj, timeoutMs = 10_000) {
    const p = new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiters.delete(obj.id); rej(new Error("client timeout for id " + JSON.stringify(obj.id))); }, timeoutMs);
      this.waiters.set(obj.id, (m) => { clearTimeout(t); res(m); });
    });
    this.send(obj);
    return p;
  }
  end() { this.proc.stdin.end(); }
}

function spawnEnv(root, extra = {}) {
  return {
    CODEGRAPH_MCP_RUNTIME: RUNTIME_FAKE,
    FAKE_RUNTIME_ROOT: root,
    CODEGRAPH_MCP_TOOLS: "explore,node,search,callers,callees,impact,files,status",
    ...extra,
  };
}

// Fixture dirs are real so the spawn cwd / --path exist; mkdtemp also proves
// the adapter never needs the repo's own index.
const tmpDirs = [];
function makeTmpDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `cg-boundary-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const dir of tmpDirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function readGateLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

await test("spawn: handshake, 8-tool list, projectPath injection, --path argv, env passthrough", async () => {
  const root = makeTmpDir("wiring");
  const ap = new AdapterProc(root, spawnEnv(root));
  try {
    const init = await ap.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    if (!init.result?.serverInfo) fail("handshake failed: " + JSON.stringify(init));
    const ls = await ap.call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = ls.result.tools.map((t) => t.name).sort();
    const expected = ["codegraph_callers", "codegraph_callees", "codegraph_explore", "codegraph_files", "codegraph_impact", "codegraph_node", "codegraph_search", "codegraph_status"].sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) fail("tools/list surface wrong: " + names.join(","));
    const call = await ap.call(toolCall(3, "codegraph_callers"));
    if (call.result.isError) fail("clean call refused: " + call.result.content[0].text);
    const payload = JSON.parse(call.result.content[0].text);
    if (payload.arguments.projectPath !== root) fail("projectPath not injected as the guarded root: " + payload.arguments.projectPath);
    const argv = payload.upstream.argv;
    if (JSON.stringify(argv.slice(0, 2)) !== JSON.stringify(["serve", "--mcp"])) fail("serve --mcp not appended: " + JSON.stringify(argv));
    if (argv[2] !== "--path" || argv[3] !== root) fail("--path <root> missing: " + JSON.stringify(argv));
    if (payload.upstream.toolsEnv !== "explore,node,search,callers,callees,impact,files,status") fail("CODEGRAPH_MCP_TOOLS not passed through: " + payload.upstream.toolsEnv);
    if (ap.sawNonJson) fail("adapter stdout contained a non-JSON line");
  } finally {
    ap.end();
    await ap.exited;
  }
});

await test("spawn: the gate runs through the injected runtime with the contract arguments", async () => {
  const root = makeTmpDir("gate");
  const logPath = join(root, "gate.log");
  const ap = new AdapterProc(root, spawnEnv(root, { FAKE_RUNTIME_LOG: logPath }));
  try {
    await ap.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await ap.call(toolCall(2, "codegraph_explore"));
    const gateCalls = readGateLog(logPath).filter((l) => l.fn === "ensureCodegraphReady");
    if (gateCalls.length !== 1) fail("expected exactly one gate call, got " + gateCalls.length);
    if (gateCalls[0].projectRoot !== root) fail("gate projectRoot: " + gateCalls[0].projectRoot);
    if (gateCalls[0].initialize !== false) fail("query path must gate with initialize:false");
    if (!Number.isFinite(gateCalls[0].timeoutMs) || gateCalls[0].timeoutMs <= 0) fail("gate timeoutMs: " + gateCalls[0].timeoutMs);
  } finally {
    ap.end();
    await ap.exited;
  }
});

await test("spawn: stale-first upstream → boundary retries, client sees only the clean answer", async () => {
  const root = makeTmpDir("stale");
  const logPath = join(root, "gate.log");
  const ap = new AdapterProc(root, spawnEnv(root, {
    FAKE_UPSTREAM_MODE: "stale-first",
    FAKE_RUNTIME_LOG: logPath,
    CODEGRAPH_MCP_STALE_RETRY_DELAY_MS: "10",
  }));
  try {
    await ap.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const call = await ap.call(toolCall(2, "codegraph_explore"));
    if (call.result.isError) fail("retry should end clean: " + call.result.content[0].text);
    const gateCalls = readGateLog(logPath).filter((l) => l.fn === "ensureCodegraphReady");
    if (gateCalls.length !== 2) fail("expected gate on first attempt + re-gate on retry, got " + gateCalls.length);
    const id2lines = ap.lines.filter((l) => { try { return JSON.parse(l).id === 2; } catch { return false; } });
    if (id2lines.length !== 1) fail("client saw " + id2lines.length + " lines for id 2 — the stale body leaked");
    const staleLeak = ap.lines.some((l) => l.includes("edited since the last") && l.includes("index sync"));
    if (staleLeak) fail("stale banner text reached the client stdout");
  } finally {
    ap.end();
    await ap.exited;
  }
});

await test("spawn: a caller projectPath from another project is refused without reaching upstream", async () => {
  const root = makeTmpDir("mismatch");
  const ap = new AdapterProc(root, spawnEnv(root));
  try {
    await ap.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const refused = await ap.call(toolCall(2, "codegraph_callers", null, join(root, "elsewhere")));
    if (!refused.result?.isError) fail("expected a typed refusal, got " + JSON.stringify(refused).slice(0, 120));
    const head = JSON.parse(refused.result.content[0].text.split("\n")[0]);
    if (head.type !== "project-mismatch") fail("typed wrong: " + head.type);
    const ping = await ap.call({ jsonrpc: "2.0", id: 3, method: "ping" });
    const seen = ping.result.received.map((l) => { try { return JSON.parse(l).method ?? "response"; } catch { return "garbage"; } });
    if (seen.includes("tools/call")) fail("the mismatched tools/call reached upstream anyway");
  } finally {
    ap.end();
    await ap.exited;
  }
});

await test("spawn: not-ready runtime → typed UNKNOWN with the guard's reason", async () => {
  const root = makeTmpDir("notready");
  const ap = new AdapterProc(root, spawnEnv(root, { FAKE_RUNTIME_READY: "notready", FAKE_RUNTIME_REASON: "fixture: 3 pending changes" }));
  try {
    await ap.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const refused = await ap.call(toolCall(2, "codegraph_search"));
    const head = JSON.parse(refused.result.content[0].text.split("\n")[0]);
    if (head.status !== "UNKNOWN" || head.type !== "not-ready") fail("typed wrong: " + head.type);
    if (!refused.result.content[0].text.includes("fixture: 3 pending changes")) fail("guard reason not carried");
  } finally {
    ap.end();
    await ap.exited;
  }
});

await test("spawn: upstream dies mid-call → typed UNKNOWN flushed, adapter exits nonzero", async () => {
  const root = makeTmpDir("die");
  const ap = new AdapterProc(root, spawnEnv(root, { FAKE_UPSTREAM_MODE: "die" }));
  try {
    await ap.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const callP = ap.call(toolCall(2, "codegraph_callers"), 6_000);
    const got = await callP;
    const head = JSON.parse(got.result.content[0].text.split("\n")[0]);
    if (head.type !== "upstream-exited") fail("typed wrong: " + head.type);
    const exit = await ap.exited;
    if (exit.code === 0) fail("adapter must exit nonzero when upstream dies, got " + exit.code);
  } finally {
    try { ap.end(); } catch { /* may already be dead */ }
  }
});

await test("spawn: upstream stdout chatter is dropped — adapter stdout stays pure JSON-RPC", async () => {
  const root = makeTmpDir("chatter");
  const ap = new AdapterProc(root, spawnEnv(root, { FAKE_UPSTREAM_MODE: "chatter" }));
  try {
    await ap.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const call = await ap.call(toolCall(2, "codegraph_files"));
    if (call.result.isError) fail("clean call refused: " + call.result.content[0].text);
    if (ap.sawNonJson) fail("upstream chatter leaked to the adapter's stdout");
  } finally {
    ap.end();
    await ap.exited;
  }
});

await test("spawn: a slow upstream answer becomes upstream-timeout; the late answer is dropped, adapter lives on", async () => {
  const root = makeTmpDir("slow");
  const ap = new AdapterProc(root, spawnEnv(root, {
    FAKE_UPSTREAM_DELAY_MS: "2500",
    CODEGRAPH_MCP_CALL_TIMEOUT_MS: "700",
    CODEGRAPH_MCP_REQUEST_TIMEOUT_MS: "700",
  }));
  try {
    await ap.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const t0 = Date.now();
    const refused = await ap.call(toolCall(2, "codegraph_node"), 6_000);
    const elapsed = Date.now() - t0;
    const head = JSON.parse(refused.result.content[0].text.split("\n")[0]);
    if (head.type !== "upstream-timeout") fail("typed wrong: " + head.type);
    if (elapsed > 2_200) fail("timeout refused too late: " + elapsed + "ms");
    await sleep(2_600 - Math.min(elapsed, 2_600) + 300); // let the late answer land
    const id2lines = ap.lines.filter((l) => { try { return JSON.parse(l).id === 2; } catch { return false; } });
    if (id2lines.length !== 1) fail("late answer leaked to the client: " + id2lines.length + " lines for id 2");
    const ping = await ap.call({ jsonrpc: "2.0", id: 3, method: "ping" }, 8_000); // ping is instant — only tools/call honors FAKE_UPSTREAM_DELAY_MS
    if (!ping.result?.pong) fail("adapter dead after a single timeout: " + JSON.stringify(ping).slice(0, 120));
  } finally {
    ap.end();
    await ap.exited;
  }
});

await test("spawn: stdin close → clean exit 0 and the upstream child is reaped", async () => {
  const root = makeTmpDir("cleanup");
  const ap = new AdapterProc(root, spawnEnv(root));
  await ap.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const call = await ap.call(toolCall(2, "codegraph_explore"));
  const fakePid = JSON.parse(call.result.content[0].text).upstream.pid;
  ap.end();
  const exit = await ap.exited;
  if (exit.code !== 0) fail("clean shutdown must exit 0, got " + exit.code + "/" + exit.signal);
  // The upstream is the adapter's own child; the detached DAEMON (a different
  // process upstream may own) is intentionally out of scope here.
  let alive = true;
  for (let i = 0; i < 60 && alive; i++) {
    try { process.kill(fakePid, 0); await sleep(50); } catch { alive = false; }
  }
  if (alive) fail("upstream child (pid " + fakePid + ") survived the adapter exit");
});

await test("spawn: server→client roots/list round-trips through real pipes mid-session", async () => {
  const root = makeTmpDir("roots");
  const ap = new AdapterProc(root, spawnEnv(root, { FAKE_UPSTREAM_ROOTS: "1" }));
  try {
    await ap.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const rootsReq = await waitFor(() => {
      for (const l of ap.lines) { try { const m = JSON.parse(l); if (m.method === "roots/list") return m; } catch { /* skip */ } }
      return null;
    }, "roots/list forwarded to client");
    if (rootsReq.id !== "cg-srv-1") fail("server request id mangled: " + rootsReq.id);
    ap.send({ jsonrpc: "2.0", id: rootsReq.id, result: { roots: [{ uri: "file://" + root, name: "fixture" }] } });
    const ping = await ap.call({ jsonrpc: "2.0", id: 2, method: "ping" });
    const sawResponse = ping.result.received.some((l) => l.includes('"cg-srv-1"'));
    if (!sawResponse) fail("the client's roots/list response never reached upstream");
  } finally {
    ap.end();
    await ap.exited;
  }
});

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}