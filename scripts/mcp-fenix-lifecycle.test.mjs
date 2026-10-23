// scripts/mcp-fenix-lifecycle.test.mjs — FOC-1007: the fenix-lifecycle MCP host.
//
// The contract the Supervisor depends on: exactly one tool (cleanup_remove), an
// argv-shaped supervisor-cleanup invocation (never a shell string), arguments
// validated before the runner is ever called, and the script's own refusals
// (a key not turned, the tree moved) surfaced as typed envelopes. The unit
// tests inject the runner; one end-to-end case runs the REAL
// supervisor-cleanup.mjs against a run with no cleanup approval and asserts it
// refuses — the key checks live in the script, the MCP tool is only a channel.
//
// Run: node scripts/mcp-fenix-lifecycle.test.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFenixLifecycleServer } from "./mcp/server-fenix-lifecycle.mjs";

// Hermetic by construction: never write telemetry or touch a real run.
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

const RUN = "2026-10-22T09-00-00-000-supervisor-ab12";

function fakeRunner(result) {
  const calls = [];
  const runCleanup = async (argv) => {
    calls.push(argv);
    return typeof result === "function" ? result(argv) : result;
  };
  return { runCleanup, calls };
}

const call = (server, name, args, id = 1) => server.handleMessage({
  jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
});
const envelopeOf = (response) => JSON.parse(response.result.content[0].text);

console.log("\nfenix-lifecycle: tool surface");

await test("tools/list returns exactly cleanup_remove", async () => {
  const server = createFenixLifecycleServer({});
  const response = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = response.result.tools.map((t) => t.name);
  if (JSON.stringify(names) !== JSON.stringify(["cleanup_remove"])) fail("tools: " + JSON.stringify(names));
  const schema = response.result.tools[0].inputSchema;
  if (JSON.stringify(schema.required) !== JSON.stringify(["run", "child"])) fail("required: " + JSON.stringify(schema.required));
});

console.log("\nfenix-lifecycle: cleanup_remove");

await test("argv is exactly remove --run --child (+ --repo), nothing else", async () => {
  const fake = fakeRunner({ exitCode: 0, stdout: JSON.stringify({ ok: true, removed: "/data/workspaces/la-wt/r/dev-1" }), stderr: "" });
  const server = createFenixLifecycleServer({ runCleanup: fake.runCleanup });
  const bare = envelopeOf(await call(server, "cleanup_remove", { run: RUN, child: "dev-1" }));
  if (JSON.stringify(fake.calls[0]) !== JSON.stringify(["remove", "--run", RUN, "--child", "dev-1"])) fail("argv: " + JSON.stringify(fake.calls[0]));
  if (bare.ok !== true || bare.tool !== "cleanup_remove") fail("envelope: " + JSON.stringify(bare));
  if (bare.result?.removed !== "/data/workspaces/la-wt/r/dev-1") fail("the script's record is not passed through: " + JSON.stringify(bare));
  await call(server, "cleanup_remove", { run: RUN, child: "test-2", repo: "/data/workspaces/linear-agents" });
  if (JSON.stringify(fake.calls[1]) !== JSON.stringify(["remove", "--run", RUN, "--child", "test-2", "--repo", "/data/workspaces/linear-agents"])) {
    fail("argv with repo: " + JSON.stringify(fake.calls[1]));
  }
});

await test("a refusal from the script (a key not turned) is a typed refused envelope with its reason", async () => {
  const fake = fakeRunner({
    exitCode: 1,
    stdout: JSON.stringify({ ok: false, error: "no cleanup-approval gate has been answered yes for dev-1", hint: "run propose first" }),
    stderr: "",
  });
  const server = createFenixLifecycleServer({ runCleanup: fake.runCleanup });
  const response = await call(server, "cleanup_remove", { run: RUN, child: "dev-1" });
  if (response.result.isError !== true) fail("a refusal must be isError");
  const envelope = envelopeOf(response);
  if (envelope.ok !== false || envelope.error.code !== "refused") fail("envelope: " + JSON.stringify(envelope));
  if (!/no cleanup-approval gate/.test(envelope.error.message)) fail("reason lost: " + JSON.stringify(envelope));
  if (envelope.error.hint !== "run propose first") fail("hint lost: " + JSON.stringify(envelope));
});

await test("timeout, missing script and a plain crash map to their own codes", async () => {
  const cases = [
    [{ exitCode: 124, timedOut: true, stdout: "", stderr: "" }, "cleanup_timeout"],
    [{ exitCode: 127, stdout: "", stderr: "spawn ENOENT" }, "cleanup_missing"],
    [{ exitCode: 3, stdout: "not json", stderr: "boom" }, "cleanup_failed"],
  ];
  for (const [result, code] of cases) {
    const server = createFenixLifecycleServer({ runCleanup: fakeRunner(result).runCleanup });
    const envelope = envelopeOf(await call(server, "cleanup_remove", { run: RUN, child: "dev-1" }));
    if (envelope.ok !== false || envelope.error.code !== code) fail(code + ": " + JSON.stringify(envelope));
  }
});

await test("a runner that throws becomes internal_error, never a protocol throw", async () => {
  const server = createFenixLifecycleServer({ runCleanup: async () => { throw new Error("kaboom"); } });
  const envelope = envelopeOf(await call(server, "cleanup_remove", { run: RUN, child: "dev-1" }));
  if (envelope.error.code !== "internal_error" || !/kaboom/.test(envelope.error.message)) fail(JSON.stringify(envelope));
});

console.log("\nfenix-lifecycle: validation happens before the runner");

await test("bad arguments are invalid_input and the runner is never called", async () => {
  const fake = fakeRunner({ exitCode: 0, stdout: "{}", stderr: "" });
  const server = createFenixLifecycleServer({ runCleanup: fake.runCleanup });
  const bad = [
    {},
    { run: RUN },
    { child: "dev-1" },
    { run: "not-a-run", child: "dev-1" },
    { run: `${RUN}/../x`, child: "dev-1" },
    { run: RUN, child: "dev-1; rm -rf /" },
    { run: RUN, child: "../dev-1" },
    { run: RUN, child: "dev-1", repo: "relative/path" },
    { run: RUN, child: "dev-1", repo: "/data/workspaces/../etc" },
    { run: RUN, child: "dev-1", repo: "" },
    { run: RUN, child: "dev-1", force: true },
    { run: RUN, child: "dev-1", "dry-run": true },
    { run: 7, child: "dev-1" },
  ];
  for (const args of bad) {
    const envelope = envelopeOf(await call(server, "cleanup_remove", args));
    if (envelope.ok !== false || envelope.error.code !== "invalid_input") fail(JSON.stringify(args) + " → " + JSON.stringify(envelope));
  }
  if (fake.calls.length !== 0) fail("the runner was called for invalid input: " + JSON.stringify(fake.calls));
});

await test("an unknown tool is a JSON-RPC error — there is no prune, no list, no force", async () => {
  const server = createFenixLifecycleServer({});
  for (const name of ["cleanup_prune", "cleanup_propose", "cleanup_force", "git_worktree_remove"]) {
    const response = await call(server, name, {}, 2);
    if (!response.error || response.error.code !== -32602) fail(name + ": " + JSON.stringify(response).slice(0, 120));
  }
});

console.log("\nfenix-lifecycle: the real script is the gate");

await test("end to end: the real supervisor-cleanup refuses a child nobody approved (the channel opens nothing)", async () => {
  // A run dir with a registered child that never passed TEST and has no
  // cleanup gate; Linear is made unreachable (no key) so the test never leaves
  // the machine — the script treats an unreadable issue as UNKNOWN, not as
  // approved. Whatever the exact reason, the envelope must be a refusal and the
  // worktree must still be there afterwards.
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "fenix-lifecycle-state-"));
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "fenix-lifecycle-tree-"));
  const run = "2026-10-22T09-00-00-000-supervisor-cd34";
  const prevHome = process.env.LA_SUPERVISOR_STATE_HOME;
  const prevKeys = { LINEAR_API_KEY: process.env.LINEAR_API_KEY, LINEAR_API_KEY_PISI: process.env.LINEAR_API_KEY_PISI };
  try {
    delete process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY_PISI;
    fs.mkdirSync(path.join(stateHome, run, "children"), { recursive: true });
    fs.mkdirSync(path.join(stateHome, run, "gates"), { recursive: true });
    fs.writeFileSync(path.join(tree, "keep.txt"), "uncommitted work that must survive\n");
    fs.writeFileSync(
      path.join(stateHome, run, "children.json"),
      JSON.stringify({ version: 1, children: { "dev-1": { childId: "dev-1", squad: "dev", taskId: "FOC-999", status: "exited", worktree: tree, turns: [] } } }),
    );
    process.env.LA_SUPERVISOR_STATE_HOME = stateHome;
    const server = createFenixLifecycleServer({});
    const response = await call(server, "cleanup_remove", { run, child: "dev-1" });
    const envelope = envelopeOf(response);
    if (response.result.isError !== true || envelope.ok !== false) fail("expected a refusal, got " + JSON.stringify(envelope).slice(0, 300));
    if (!fs.existsSync(path.join(tree, "keep.txt"))) fail("the worktree was touched by a refused call");
  } finally {
    if (prevHome === undefined) delete process.env.LA_SUPERVISOR_STATE_HOME;
    else process.env.LA_SUPERVISOR_STATE_HOME = prevHome;
    for (const [k, v] of Object.entries(prevKeys)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

// The stdio entry must answer tools/list over a real pipe — the wiring the
// Supervisor's claude process uses.
await test("stdio entry: initialize + tools/list over a real process", async () => {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    "",
  ].join("\n");
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./mcp/server-fenix-lifecycle.mjs", import.meta.url))], {
    input, encoding: "utf8", timeout: 20000,
  });
  const lines = r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const list = lines.find((m) => m.id === 2);
  if (!list || JSON.stringify(list.result.tools.map((t) => t.name)) !== JSON.stringify(["cleanup_remove"])) {
    fail("stdout: " + r.stdout.slice(0, 300) + " stderr: " + r.stderr.slice(0, 200));
  }
  if (lines.find((m) => m.id === 1)?.result?.serverInfo?.name !== "fenix-lifecycle") fail("serverInfo missing");
});

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}
