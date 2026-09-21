// scripts/mcp-protocol.test.mjs — FOC-401: the hand-rolled MCP surface
// (JSON-RPC 2.0 over newline-delimited stdio, initialize / tools/list /
// tools/call) exercised through the programmatic handler — no process spawn,
// no network. Both built servers are driven.
//
// Run: node scripts/mcp-protocol.test.mjs

import { PassThrough } from "node:stream";
import { createMcpHandler, serveStdio, PROTOCOL_VERSION } from "./mcp/jsonrpc.mjs";
import { createExtractionServer, SERVER_INFO as EXTRACTION_INFO } from "./mcp/server-extraction.mjs";
import { createPromptRefinementServer, SERVER_INFO as REFINEMENT_INFO } from "./mcp/server-prompt-refinement.mjs";

// Hermetic by construction: close the LA_RUN_ID telemetry gate before any
// decision call (see mcp-extraction.test.mjs).
delete process.env.LA_RUN_ID;

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
      console.log("  FAIL " + name + "\n       " + err.message);
    });
}

const fail = (msg) => { throw new Error(msg); };

console.log("\nprotocol: initialize handshake (both servers)");

for (const [factory, info] of [[createExtractionServer, EXTRACTION_INFO], [createPromptRefinementServer, REFINEMENT_INFO]]) {
  await test(`${info.name} answers initialize with its serverInfo`, async () => {
    const server = factory({});
    const response = await server.handleMessage({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    if (response.result.protocolVersion !== PROTOCOL_VERSION) fail("protocolVersion: " + response.result.protocolVersion);
    if (response.result.serverInfo.name !== info.name) fail("serverInfo mismatch");
    if (typeof response.result.serverInfo.version !== "string") fail("version missing");
  });
}

await test("notifications/initialized produces no response", async () => {
  const server = createExtractionServer({});
  const response = await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  if (response !== null) fail("a notification must not be responded to");
});

await test("ping answers with an empty result", async () => {
  const server = createExtractionServer({});
  const response = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "ping" });
  if (JSON.stringify(response.result) !== "{}") fail("ping: " + JSON.stringify(response.result));
});

console.log("\nprotocol: tools/list");

await test("each server lists exactly its own tool with an input schema", async () => {
  for (const [factory, toolName] of [[createExtractionServer, "extract_features"], [createPromptRefinementServer, "refine_prompt"]]) {
    const server = factory({});
    const response = await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = response.result.tools;
    if (tools.length !== 1) fail("expected 1 tool, got " + tools.length);
    if (tools[0].name !== toolName) fail("tool: " + tools[0].name);
    if (!tools[0].inputSchema || tools[0].inputSchema.type !== "object") fail("inputSchema missing");
    if (typeof tools[0].description !== "string") fail("description missing");
  }
});

console.log("\nprotocol: tools/call + fail-closed across the boundary");

await test("an ok:false envelope becomes isError:true, error-free call stays isError:false", async () => {
  const server = createExtractionServer({});
  const ok = await server.handleMessage({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "extract_features", arguments: { text: "kif" } },
  });
  const bad = await server.handleMessage({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "extract_features", arguments: { text: "" } },
  });
  if (ok.result.isError !== false) fail("ok call flagged as error");
  if (bad.result.isError !== true) fail("fail-closed call not flagged");
  const badEnvelope = JSON.parse(bad.result.content[0].text);
  if (badEnvelope.ok !== false || badEnvelope.error.code !== "invalid_input") fail("typed error lost: " + JSON.stringify(badEnvelope));
});

console.log("\nprotocol: JSON-RPC error handling");

await test("malformed JSON line → parse error (-32700, null id)", async () => {
  const server = createExtractionServer({});
  const line = await server.handleLine("{not json");
  const response = JSON.parse(line);
  if (response.error.code !== -32700) fail("code: " + response.error.code);
  if (response.id !== null) fail("parse errors answer with a null id");
});

await test("unknown method → -32601", async () => {
  const server = createExtractionServer({});
  const response = await server.handleMessage({ jsonrpc: "2.0", id: 6, method: "sampling/createMessage" });
  if (response.error?.code !== -32601) fail("code: " + response.error?.code);
});

await test("wrong jsonrpc version → -32600", async () => {
  const server = createExtractionServer({});
  const response = await server.handleMessage({ jsonrpc: "1.0", id: 7, method: "ping" });
  if (response.error?.code !== -32600) fail("code: " + response.error?.code);
});

await test("empty and whitespace lines produce no response", async () => {
  const server = createExtractionServer({});
  if ((await server.handleLine("")) !== null) fail("empty line answered");
  if ((await server.handleLine("   ")) !== null) fail("whitespace line answered");
});

await test("unknown NOTIFICATION stays silent, unknown request is answered", async () => {
  const server = createExtractionServer({});
  if ((await server.handleMessage({ jsonrpc: "2.0", method: "no/such" })) !== null) fail("unknown notification answered");
  const response = await server.handleMessage({ jsonrpc: "2.0", id: 8, method: "no/such" });
  if (response.error?.code !== -32601) fail("unknown request not answered");
});

console.log("\nprotocol: newline-delimited stdio framing");

await test("handleLine serializes one response line per request line", async () => {
  const server = createExtractionServer({});
  const line = await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} }));
  const parsed = JSON.parse(line);
  if (parsed.id !== 9 || !parsed.result) fail("framing broken: " + String(line).slice(0, 80));
  if (line.includes("\n")) fail("a response must be a single line");
});

await test("serveStdio writes responses to the output stream, nothing for notifications", async () => {
  const server = createExtractionServer({});
  const input = new PassThrough();
  input.end([
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    "",
  ].join("\n"));
  let written = "";
  const output = new PassThrough();
  output.on("data", (chunk) => { written += chunk.toString(); });
  await serveStdio(server.handleLine, { input, output });
  const lines = written.split("\n").filter(Boolean);
  if (lines.length !== 1) fail("expected exactly one response line, got " + lines.length);
  if (JSON.parse(lines[0]).result.tools.length !== 1) fail("tools/list result lost in transport");
});

await test("a raw handler (createMcpHandler) drives a generic tool server", async () => {
  let called = null;
  const handler = createMcpHandler({
    serverInfo: { name: "generic", version: "0.0.1" },
    tools: [{ name: "echo", description: "test", inputSchema: { type: "object" } }],
    callTool: async (name, args) => { called = { name, args }; return { ok: true, decision: { echoed: args } }; },
  });
  const response = await handler.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { hi: 1 } },
  });
  if (called.name !== "echo" || called.args.hi !== 1) fail("callTool args not delivered");
  if (JSON.parse(response.result.content[0].text).decision.echoed.hi !== 1) fail("decision not round-tripped");
});

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}
