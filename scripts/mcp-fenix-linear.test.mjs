// scripts/mcp-fenix-linear.test.mjs — FOC-943: the fenix-linear MCP server.
//
// Covers the wrapper contract end to end: tool listing, the argv handed to the
// linear-ops runner, the egress screen firing before the runner is ever
// called, ownership-refusal mapping, and hand-rolled input validation. The
// runner is injected — these tests never spawn the real CLI, never touch the
// network.
//
// Run: node scripts/mcp-fenix-linear.test.mjs

import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";
import { createFenixLinearServer, SERVER_INFO } from "./mcp/server-fenix-linear.mjs";

// Hermetic by construction: the launcher env carries LA_RUN_ID, and a test run
// must never write telemetry. Same discipline as mcp-extraction.test.mjs.
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

/** A runner that records argv and answers from a table keyed by the tool name. */
function fakeRunner(handlers) {
  const calls = [];
  return {
    calls,
    run: async (argv) => {
      calls.push(argv);
      const handler = handlers[calls.length - 1] ?? handlers.default;
      return handler ? handler(argv) : { exitCode: 0, stdout: "ok", stderr: "" };
    },
  };
}

const call = (server, name, args, id = 1) =>
  server.handleMessage({
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name, arguments: args },
  });

const envelopeOf = (response) => JSON.parse(response.result.content[0].text);

console.log("\nfenix-linear: initialize + tools/list");

await test("initialize reports the fenix-linear server info", async () => {
  const server = createFenixLinearServer({});
  const response = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  if (response.result.serverInfo.name !== "fenix-linear") fail("name: " + response.result.serverInfo.name);
  if (response.result.serverInfo.version !== SERVER_INFO.version) fail("version mismatch");
});

await test("tools/list returns exactly transition, comment, comment_replace", async () => {
  const server = createFenixLinearServer({});
  const response = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const names = response.result.tools.map((t) => t.name);
  if (JSON.stringify(names) !== JSON.stringify(["transition", "comment", "comment_replace"])) {
    fail("tools: " + JSON.stringify(names));
  }
  for (const tool of response.result.tools) {
    if (tool.inputSchema.additionalProperties !== false) fail(tool.name + ": schema not closed");
    if (typeof tool.description !== "string" || !tool.description.includes("linear-ops")) fail(tool.name + ": description missing the wrapper contract");
  }
});

console.log("\nfenix-linear: transition");

await test("transition passes exactly [transition, issue, --status, status] to the runner", async () => {
  const fake = fakeRunner({ default: () => ({ exitCode: 0, stdout: "moved to In Review\n", stderr: "" }) });
  const server = createFenixLinearServer({ runOps: fake.run });
  const response = await call(server, "transition", { issue: "FOC-1", status: "In Review" });
  if (fake.calls.length !== 1) fail("runner calls: " + fake.calls.length);
  if (JSON.stringify(fake.calls[0]) !== JSON.stringify(["transition", "FOC-1", "--status", "In Review"])) {
    fail("argv: " + JSON.stringify(fake.calls[0]));
  }
  if (response.result.isError !== false) fail("isError on a valid call");
  const envelope = envelopeOf(response);
  if (envelope.ok !== true) fail("envelope: " + JSON.stringify(envelope));
  if (envelope.tool !== "transition" || envelope.issue !== "FOC-1") fail("meta: " + JSON.stringify(envelope));
  if (envelope.output !== "moved to In Review") fail("output not trimmed: " + JSON.stringify(envelope.output));
});

await test("status is required and validated", async () => {
  const fake = fakeRunner({});
  const server = createFenixLinearServer({ runOps: fake.run });
  const envelope = envelopeOf(await call(server, "transition", { issue: "FOC-1" }));
  if (envelope.error?.code !== "invalid_input") fail("missing status accepted");
  if (fake.calls.length !== 0) fail("runner called on invalid input");
  const envelope2 = envelopeOf(await call(server, "transition", { issue: "FOC-1", status: 42 }));
  if (envelope2.error?.code !== "invalid_input") fail("non-string status accepted");
});

console.log("\nfenix-linear: egress screen");

await test("a secret-shaped body → egress_blocked, runner never called, canary absent from the response", async () => {
  // Built at runtime so this file itself never carries a full secret literal.
  const canary = "ghp_".concat("9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c", "3fXX");
  const fake = fakeRunner({ default: () => fail("runner must not run behind an egress refusal") });
  const server = createFenixLinearServer({ runOps: fake.run });
  const response = await call(server, "comment", { issue: "FOC-1", body: "token " + canary });
  if (response.result.isError !== true) fail("egress refusal must be isError:true");
  const text = response.result.content[0].text;
  const envelope = JSON.parse(text);
  if (envelope.error?.code !== "egress_blocked") fail("code: " + envelope.error?.code);
  if (fake.calls.length !== 0) fail("runner called despite the screen");
  if (text.includes(canary)) fail("the canary leaked into the response");
});

console.log("\nfenix-linear: comment");

await test("comment writes the body to --body-file and removes the temp dir after the call", async () => {
  let bodyFileAtCallTime = null;
  let bodyContentAtCallTime = null;
  const fake = fakeRunner({
    default: (argv) => {
      const flag = argv.indexOf("--body-file");
      if (flag === -1) fail("no --body-file in argv: " + JSON.stringify(argv));
      bodyFileAtCallTime = argv[flag + 1];
      bodyContentAtCallTime = readFileSync(bodyFileAtCallTime, "utf8");
      return { exitCode: 0, stdout: "comment posted\n", stderr: "" };
    },
  });
  const server = createFenixLinearServer({ runOps: fake.run });
  const response = await call(server, "comment", { issue: "FOC-2", body: "line one\nline two" });
  if (response.result.isError !== false) fail("isError on a clean body");
  const envelope = envelopeOf(response);
  if (envelope.ok !== true || envelope.output !== "comment posted") fail("envelope: " + JSON.stringify(envelope));
  if (bodyContentAtCallTime !== "line one\nline two") fail("body file content mismatch at call time");
  const dir = dirname(bodyFileAtCallTime);
  if (!isAbsolute(dir) || !dir.startsWith(join(tmpdir(), "fenix-linear-"))) {
    fail("body file outside the expected tmpdir pattern: " + bodyFileAtCallTime);
  }
  if (existsSync(dir)) fail("temp dir not removed: " + dir);
});

await test("comment forwards an optional --dedup-tag", async () => {
  const fake = fakeRunner({ default: () => ({ exitCode: 0, stdout: "ok", stderr: "" }) });
  const server = createFenixLinearServer({ runOps: fake.run });
  await call(server, "comment", { issue: "FOC-2", body: "hello", dedup_tag: "foc-943-w1" });
  const argv = fake.calls[0];
  if (!argv.includes("--dedup-tag") || !argv.includes("foc-943-w1")) fail("argv: " + JSON.stringify(argv));
  if (argv.includes("--owner-override") || argv.includes("--dry-run")) fail("forbidden flag forwarded");
});

await test("body length outside 1..60000 → invalid_input, runner not called", async () => {
  const fake = fakeRunner({});
  const server = createFenixLinearServer({ runOps: fake.run });
  const envelope = envelopeOf(await call(server, "comment", { issue: "FOC-2", body: "" }));
  if (envelope.error?.code !== "invalid_input") fail("empty body accepted");
  const envelope2 = envelopeOf(await call(server, "comment", { issue: "FOC-2", body: "x".repeat(60001) }));
  if (envelope2.error?.code !== "invalid_input") fail("overlong body accepted");
  if (fake.calls.length !== 0) fail("runner called on invalid input");
});

console.log("\nfenix-linear: comment_replace");

await test("comment_replace passes dedup-tag before --body-file", async () => {
  const fake = fakeRunner({ default: () => ({ exitCode: 0, stdout: "replaced\n", stderr: "" }) });
  const server = createFenixLinearServer({ runOps: fake.run });
  const response = await call(server, "comment_replace", { issue: "FOC-3", dedup_tag: "w1-report", body: "updated" });
  if (response.result.isError !== false) fail("isError on a valid call");
  const argv = fake.calls[0];
  if (JSON.stringify(argv) !== JSON.stringify(["comment-replace", "FOC-3", "--dedup-tag", "w1-report", "--body-file", argv[5]])) {
    fail("argv: " + JSON.stringify(argv));
  }
});

await test("comment_replace without dedup_tag → invalid_input, runner not called", async () => {
  const fake = fakeRunner({});
  const server = createFenixLinearServer({ runOps: fake.run });
  const envelope = envelopeOf(await call(server, "comment_replace", { issue: "FOC-3", body: "updated" }));
  if (envelope.ok !== false) fail("expected ok:false");
  if (envelope.error.code !== "invalid_input") fail("code: " + envelope.error.code);
  if (envelope.tool !== "comment_replace") fail("tool: " + envelope.tool);
  if (fake.calls.length !== 0) fail("runner called on invalid input");
});

console.log("\nfenix-linear: input validation");

await test("invalid issue 'foc-1' → invalid_input, runner not called", async () => {
  const fake = fakeRunner({});
  const server = createFenixLinearServer({ runOps: fake.run });
  const envelope = envelopeOf(await call(server, "transition", { issue: "foc-1", status: "In Review" }));
  if (envelope.ok !== false) fail("expected ok:false");
  if (envelope.error.code !== "invalid_input") fail("code: " + envelope.error.code);
  if (envelope.error.message.includes("issue") === false) fail("message should name the violated field, got: " + envelope.error.message);
  if (envelope.error.message.includes("foc-1")) fail("error message leaks the input value");
  if (fake.calls.length !== 0) fail("runner called on invalid input");
});

await test("unknown properties rejected; dedup_tag pattern enforced", async () => {
  const fake = fakeRunner({});
  const server = createFenixLinearServer({ runOps: fake.run });
  const envelope = envelopeOf(await call(server, "comment", { issue: "FOC-2", body: "hi", sneaky: true }));
  if (envelope.error?.code !== "invalid_input") fail("unknown property accepted");
  const envelope2 = envelopeOf(await call(server, "comment", { issue: "FOC-2", body: "hi", dedup_tag: "bad tag!" }));
  if (envelope2.error?.code !== "invalid_input") fail("bad dedup_tag accepted");
  if (fake.calls.length !== 0) fail("runner called on invalid input");
});

console.log("\nfenix-linear: runner result mapping");

await test("exit 1 with ownership-foreign JSON on stdout → code ownership-foreign", async () => {
  const fake = fakeRunner({
    default: () => ({
      exitCode: 1,
      stdout: JSON.stringify({ ok: false, error: "foreign ticket", code: "ownership-foreign" }),
      stderr: "",
    }),
  });
  const server = createFenixLinearServer({ runOps: fake.run });
  const envelope = envelopeOf(await call(server, "transition", { issue: "FOC-4", status: "Done" }));
  if (envelope.ok !== false) fail("expected ok:false");
  if (envelope.error.code !== "ownership-foreign") fail("code: " + envelope.error.code);
  if (envelope.error.message !== "foreign ticket") fail("message: " + envelope.error.message);
});

await test("stderr [egress-blocked] from the CLI → code egress_blocked", async () => {
  const fake = fakeRunner({
    default: () => ({ exitCode: 1, stdout: "", stderr: "[egress-blocked] secret-shaped hit in comment body" }),
  });
  const server = createFenixLinearServer({ runOps: fake.run });
  const envelope = envelopeOf(await call(server, "comment", { issue: "FOC-2", body: "clean" }));
  if (envelope.error?.code !== "egress_blocked") fail("code: " + envelope.error?.code);
});

await test("exit 2 → code invalid_input", async () => {
  const fake = fakeRunner({
    default: () => ({ exitCode: 2, stdout: "", stderr: "usage: transition <id> --status <name>" }),
  });
  const server = createFenixLinearServer({ runOps: fake.run });
  const envelope = envelopeOf(await call(server, "transition", { issue: "FOC-4", status: "Done" }));
  if (envelope.error?.code !== "invalid_input") fail("code: " + envelope.error?.code);
});

await test("non-zero exit without a recognised shape → linear_ops_failed with exitCode", async () => {
  const fake = fakeRunner({
    default: () => ({ exitCode: 1, stdout: "not json", stderr: "boom" }),
  });
  const server = createFenixLinearServer({ runOps: fake.run });
  const envelope = envelopeOf(await call(server, "transition", { issue: "FOC-4", status: "Done" }));
  if (envelope.error?.code !== "linear_ops_failed") fail("code: " + envelope.error?.code);
  if (envelope.error.exitCode !== 1) fail("exitCode not carried");
});

await test("runner timeout (exitCode 124, timedOut) → linear_timeout, not linear_ops_failed", async () => {
  const fake = fakeRunner({
    default: () => ({ exitCode: 124, timedOut: true, stdout: "", stderr: "killed" }),
  });
  const server = createFenixLinearServer({ runOps: fake.run });
  const envelope = envelopeOf(await call(server, "transition", { issue: "FOC-4", status: "Done" }));
  if (envelope.ok !== false) fail("expected ok:false");
  if (envelope.error.code !== "linear_timeout") fail("code: " + envelope.error.code);
  if (envelope.error.exitCode !== 124) fail("exitCode not carried: " + JSON.stringify(envelope.error));
});

await test("stdout over 4000 chars is trimmed to the last 4000", async () => {
  const long = "x".repeat(5000) + "tail";
  const fake = fakeRunner({ default: () => ({ exitCode: 0, stdout: long + "\n", stderr: "" }) });
  const server = createFenixLinearServer({ runOps: fake.run });
  const envelope = envelopeOf(await call(server, "transition", { issue: "FOC-4", status: "Done" }));
  if (envelope.output !== long.slice(-4000)) fail("output not the last 4000 chars: len " + (envelope.output ?? "").length);
});

console.log("\nfenix-linear: protocol hardening");

await test("a throwing runner never throws out of tools/call", async () => {
  const server = createFenixLinearServer({ runOps: async () => { throw new Error("exploded"); } });
  const response = await call(server, "transition", { issue: "FOC-5", status: "Done" });
  if (response.result.isError !== true) fail("isError on a crashed runner");
  const envelope = envelopeOf(response);
  if (envelope.ok !== false || envelope.error.code !== "linear_ops_failed") fail("envelope: " + JSON.stringify(envelope));
});

await test("unknown tool → JSON-RPC error -32602", async () => {
  const server = createFenixLinearServer({});
  const response = await server.handleMessage({
    jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope", arguments: {} },
  });
  if (response.error?.code !== -32602) fail("code: " + response.error?.code);
});

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}
