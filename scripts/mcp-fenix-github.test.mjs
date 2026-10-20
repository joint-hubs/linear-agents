// scripts/mcp-fenix-github.test.mjs — FOC-943 W2: the fenix-github MCP host.
//
// Covers the contract the Supervisor depends on: exactly three PR tools (no
// merge), argv-shaped gh-screened invocation with the body through a temp
// file that is cleaned up, the in-process egress screen firing before the
// runner is ever called, and the typed exit-code mapping. The gh runner is
// injected — these tests never spawn gh and never touch the network.
//
// Run: node scripts/mcp-fenix-github.test.mjs

import fs from "node:fs";
import { createFenixGithubServer } from "./mcp/server-fenix-github.mjs";

// Hermetic by construction: a test run must never write telemetry (same gate
// as mcp-extraction.test.mjs).
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

// A runner that records argv and never spawns anything.
function fakeRunner(result) {
  const calls = [];
  const runGh = async (argv) => {
    calls.push(argv);
    return typeof result === "function" ? result(argv) : result;
  };
  return { runGh, calls };
}

const call = (server, name, args, id = 1) => server.handleMessage({
  jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
});
const envelopeOf = (response) => JSON.parse(response.result.content[0].text);

console.log("\nfenix-github: tool surface");

await test("tools/list returns exactly pr_create, pr_edit, pr_comment", async () => {
  const server = createFenixGithubServer({});
  const response = await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = response.result.tools.map((t) => t.name);
  if (JSON.stringify(names) !== JSON.stringify(["pr_create", "pr_edit", "pr_comment"])) {
    fail("tools: " + JSON.stringify(names));
  }
});

console.log("\nfenix-github: pr_create");

await test("argv shape, temp file content, cleanup, url extraction", async () => {
  const body = "Body text\nwith two lines\n";
  let seenBody = null;
  let bodyPath = null;
  const fake = fakeRunner((argv) => {
    // Capture the temp file contents while it still exists (removed in the
    // server's finally before the envelope resolves).
    bodyPath = argv[5];
    seenBody = fs.readFileSync(bodyPath, "utf8");
    return { exitCode: 0, stdout: "https://github.com/joint-hubs/linear-agents/pull/7\n", stderr: "" };
  });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const response = await call(server, "pr_create", { title: "T", body, base: "main", draft: true });
  if (fake.calls.length !== 1) fail("runner calls: " + fake.calls.length);
  const argv = fake.calls[0];
  if (argv[0] !== "pr" || argv[1] !== "create") fail("prefix: " + JSON.stringify(argv.slice(0, 2)));
  if (argv[2] !== "--title" || argv[3] !== "T") fail("title: " + JSON.stringify(argv.slice(2, 4)));
  if (argv[4] !== "--body-file") fail("body-file flag missing: " + JSON.stringify(argv));
  if (seenBody !== body) fail("temp file content mismatch: " + JSON.stringify(seenBody));
  if (!argv.includes("--base") || argv[argv.indexOf("--base") + 1] !== "main") fail("base not passed: " + JSON.stringify(argv));
  if (!argv.includes("--draft")) fail("draft not passed: " + JSON.stringify(argv));
  if (fs.existsSync(bodyPath)) fail("temp file survived: " + bodyPath);
  if (fs.existsSync(bodyPath.replace(/[/\\][^/\\]+$/, ""))) fail("temp dir survived");
  if (response.result.isError === true) fail("isError on a valid call");
  const envelope = envelopeOf(response);
  if (envelope.ok !== true) fail("envelope: " + JSON.stringify(envelope));
  if (envelope.output !== "https://github.com/joint-hubs/linear-agents/pull/7") fail("output: " + envelope.output);
  if (envelope.url !== "https://github.com/joint-hubs/linear-agents/pull/7") fail("url: " + envelope.url);
});

await test("canary in the body → egress_blocked, runner never called, value absent from the response", async () => {
  const canary = "ghp_".concat("9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c", "3fXX");
  const fake = fakeRunner({ exitCode: 0, stdout: "should-not-happen", stderr: "" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const response = await call(server, "pr_create", { title: "T", body: "leak attempt\n" + canary });
  if (fake.calls.length !== 0) fail("runner was called despite the egress screen");
  if (response.result.isError !== true) fail("a block must be isError:true");
  const text = response.result.content[0].text;
  const envelope = JSON.parse(text);
  if (envelope.ok !== false || envelope.error.code !== "egress_blocked") fail("envelope: " + JSON.stringify(envelope));
  if (text.includes(canary)) fail("canary leaked into the response");
});

await test("secret-shaped head (built at runtime) → egress_blocked, runner never called", async () => {
  const canary = "ghp_".concat("9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c", "3fXX");
  const fake = fakeRunner({ exitCode: 0, stdout: "should-not-happen", stderr: "" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const response = await call(server, "pr_create", { title: "T", body: "clean body", head: canary });
  if (fake.calls.length !== 0) fail("runner was called despite the egress screen on head");
  const envelope = envelopeOf(response);
  if (envelope.ok !== false || envelope.error.code !== "egress_blocked") fail("envelope: " + JSON.stringify(envelope));
});

console.log("\nfenix-github: validation");

await test("pr_edit with neither title nor body → invalid_input", async () => {
  const fake = fakeRunner({ exitCode: 0, stdout: "", stderr: "" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_edit", { number: 7 }));
  if (envelope.ok !== false || envelope.error.code !== "invalid_input") fail("envelope: " + JSON.stringify(envelope));
  if (fake.calls.length !== 0) fail("runner called on invalid input");
});

await test("base \"--fill\" → invalid_input (flag injection refused)", async () => {
  const fake = fakeRunner({ exitCode: 0, stdout: "", stderr: "" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_create", { title: "T", body: "B", base: "--fill" }));
  if (envelope.ok !== false || envelope.error.code !== "invalid_input") fail("envelope: " + JSON.stringify(envelope));
  if (fake.calls.length !== 0) fail("runner called with a flag-shaped branch");
});

console.log("\nfenix-github: exit-code mapping");

await test("runner exit 2 → refused", async () => {
  const fake = fakeRunner({ exitCode: 2, stdout: "", stderr: "usage: gh pr edit" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_edit", { number: 7, title: "New title" }));
  if (envelope.ok !== false || envelope.error.code !== "refused") fail("envelope: " + JSON.stringify(envelope));
});

await test("runner timeout (exitCode 124, timedOut) → gh_timeout, not gh_missing", async () => {
  const fake = fakeRunner({ exitCode: 124, timedOut: true, stdout: "", stderr: "" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_comment", { number: 7, body: "b" }));
  if (envelope.ok !== false || envelope.error.code !== "gh_timeout") fail("envelope: " + JSON.stringify(envelope));
  if (envelope.error.exitCode !== 124) fail("exitCode: " + JSON.stringify(envelope.error));
});

await test("exit 1 with 'egress-blocked' mid-line in STDOUT only → gh_failed, not egress_blocked", async () => {
  const fake = fakeRunner({
    exitCode: 1,
    stdout: "remote: the PR body quoted the marker [egress-blocked] mid-line\n",
    stderr: "could not resolve to a pull request",
  });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_comment", { number: 7, body: "b" }));
  if (envelope.ok !== false || envelope.error.code !== "gh_failed") fail("envelope: " + JSON.stringify(envelope));
});

await test("runner-side egress verdict stays detected on a stderr line start", async () => {
  const fake = fakeRunner({
    exitCode: 1,
    stdout: "",
    stderr: "Error: [egress-blocked] secret-shaped hit in pr body\n",
  });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_comment", { number: 7, body: "b" }));
  if (envelope.ok !== false || envelope.error.code !== "egress_blocked") fail("envelope: " + JSON.stringify(envelope));
});

console.log("\nfenix-github: unknown tool");

await test("tools/call for pr_merge → JSON-RPC error, not a result", async () => {
  const server = createFenixGithubServer({});
  const response = await call(server, "pr_merge", {}, 2);
  if (!response.error) fail("expected a JSON-RPC error, got: " + JSON.stringify(response).slice(0, 120));
  if (response.error.code !== -32602) fail("code: " + response.error.code);
});

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}
