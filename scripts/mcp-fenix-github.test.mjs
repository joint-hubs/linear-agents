// scripts/mcp-fenix-github.test.mjs — FOC-943 W2 + FOC-977: the fenix-github
// MCP host.
//
// Covers the contract the Supervisor depends on: exactly three PR tools (no
// merge), argv-shaped gh-screened invocation with the body through a temp
// file that is cleaned up, the in-process egress screen firing before the
// runner is ever called, and the typed exit-code mapping. FOC-977 adds the
// repo_dir contract: every PR call names the checkout the PR belongs to —
// absolute, no "..", a real git work tree, under FENIX_WORKSPACES/GITHUB_ROOT
// when a root env is set — and the runner receives it as { cwd }. The unit
// tests inject the gh runner (they never spawn gh); one end-to-end case runs
// the real gh-screened.mjs against a fake gh binary through the LA_GH_COMMAND
// seam and asserts gh's cwd is the repo_dir's realpath. Still no network.
//
// Run: node scripts/mcp-fenix-github.test.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFenixGithubServer } from "./mcp/server-fenix-github.mjs";

// Hermetic by construction: a test run must never write telemetry (same gate
// as mcp-extraction.test.mjs). The repo_dir root envs are cleared too — the
// tests below run in local-dev mode (no allowed roots) unless a case pins one.
delete process.env.LA_RUN_ID;
delete process.env.FENIX_WORKSPACES;
delete process.env.GITHUB_ROOT;

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

// A real git repo in a temp dir: git init only — no commits, no remotes.
function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fenix-gh-test-repo-"));
  const git = spawnSync("git", ["init", dir], { encoding: "utf8" });
  if (git.status !== 0) throw new Error("git init failed: " + String(git.stderr || git.stdout));
  return dir;
}

// A runner that records argv and its { cwd } option, and never spawns anything.
function fakeRunner(result) {
  const calls = [];
  const runGh = async (argv, opts = {}) => {
    calls.push({ argv, opts });
    return typeof result === "function" ? result(argv, opts) : result;
  };
  return { runGh, calls };
}

const call = (server, name, args, id = 1) => server.handleMessage({
  jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args },
});
const envelopeOf = (response) => JSON.parse(response.result.content[0].text);

// One shared repo for the unit tests (each call re-validates it); removed
// before the summary so a failing run leaves nothing behind either.
const repo = makeTempGitRepo();
const repoReal = fs.realpathSync(repo);

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

await test("argv shape, temp file content, cleanup, url extraction, cwd = repo_dir realpath", async () => {
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
  const response = await call(server, "pr_create", { title: "T", body, base: "main", draft: true, repo_dir: repo });
  if (fake.calls.length !== 1) fail("runner calls: " + fake.calls.length);
  const { argv, opts } = fake.calls[0];
  if (argv[0] !== "pr" || argv[1] !== "create") fail("prefix: " + JSON.stringify(argv.slice(0, 2)));
  if (argv[2] !== "--title" || argv[3] !== "T") fail("title: " + JSON.stringify(argv.slice(2, 4)));
  if (argv[4] !== "--body-file") fail("body-file flag missing: " + JSON.stringify(argv));
  if (seenBody !== body) fail("temp file content mismatch: " + JSON.stringify(seenBody));
  if (!argv.includes("--base") || argv[argv.indexOf("--base") + 1] !== "main") fail("base not passed: " + JSON.stringify(argv));
  if (!argv.includes("--draft")) fail("draft not passed: " + JSON.stringify(argv));
  if (opts.cwd !== repoReal) fail("cwd: " + JSON.stringify(opts) + " expected " + repoReal);
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
  const response = await call(server, "pr_create", { title: "T", body: "leak attempt\n" + canary, repo_dir: repo });
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
  const response = await call(server, "pr_create", { title: "T", body: "clean body", head: canary, repo_dir: repo });
  if (fake.calls.length !== 0) fail("runner was called despite the egress screen on head");
  const envelope = envelopeOf(response);
  if (envelope.ok !== false || envelope.error.code !== "egress_blocked") fail("envelope: " + JSON.stringify(envelope));
});

console.log("\nfenix-github: repo_dir validation (FOC-977)");

await test("missing repo_dir → invalid_input, runner never called", async () => {
  const fake = fakeRunner({ exitCode: 0, stdout: "", stderr: "" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_create", { title: "T", body: "B" }));
  if (envelope.ok !== false || envelope.error.code !== "invalid_input") fail("envelope: " + JSON.stringify(envelope));
  if (fake.calls.length !== 0) fail("runner called without a validated repo_dir");
});

await test("relative repo_dir → invalid_input", async () => {
  const fake = fakeRunner({ exitCode: 0, stdout: "", stderr: "" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_create", { title: "T", body: "B", repo_dir: "some/relative/path" }));
  if (envelope.ok !== false || envelope.error.code !== "invalid_input") fail("envelope: " + JSON.stringify(envelope));
  if (fake.calls.length !== 0) fail("runner called with a relative repo_dir");
});

await test('repo_dir with a ".." segment → invalid_input', async () => {
  const fake = fakeRunner({ exitCode: 0, stdout: "", stderr: "" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const escapePath = os.tmpdir() + path.sep + ".." + path.sep + "fenix-gh-escape";
  const envelope = envelopeOf(await call(server, "pr_create", { title: "T", body: "B", repo_dir: escapePath }));
  if (envelope.ok !== false || envelope.error.code !== "invalid_input") fail("envelope: " + JSON.stringify(envelope));
  if (fake.calls.length !== 0) fail("runner called with a .. repo_dir");
});

await test("non-git dir → invalid_input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fenix-gh-test-nogit-"));
  try {
    const fake = fakeRunner({ exitCode: 0, stdout: "", stderr: "" });
    const server = createFenixGithubServer({ runGh: fake.runGh });
    const envelope = envelopeOf(await call(server, "pr_create", { title: "T", body: "B", repo_dir: dir }));
    if (envelope.ok !== false || envelope.error.code !== "invalid_input") fail("envelope: " + JSON.stringify(envelope));
    if (fake.calls.length !== 0) fail("runner called outside a git work tree");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("repo_dir outside the FENIX_WORKSPACES root → invalid_input", async () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "fenix-gh-test-root-"));
  const prev = process.env.FENIX_WORKSPACES;
  process.env.FENIX_WORKSPACES = rootA;
  try {
    const fake = fakeRunner({ exitCode: 0, stdout: "", stderr: "" });
    const server = createFenixGithubServer({ runGh: fake.runGh });
    const envelope = envelopeOf(await call(server, "pr_create", { title: "T", body: "B", repo_dir: repo }));
    if (envelope.ok !== false || envelope.error.code !== "invalid_input") fail("envelope: " + JSON.stringify(envelope));
    if (fake.calls.length !== 0) fail("runner called outside the allowed root");
  } finally {
    if (prev === undefined) delete process.env.FENIX_WORKSPACES;
    else process.env.FENIX_WORKSPACES = prev;
    fs.rmSync(rootA, { recursive: true, force: true });
  }
});

console.log("\nfenix-github: validation");

await test("pr_edit with neither title nor body → invalid_input", async () => {
  const fake = fakeRunner({ exitCode: 0, stdout: "", stderr: "" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_edit", { number: 7, repo_dir: repo }));
  if (envelope.ok !== false || envelope.error.code !== "invalid_input") fail("envelope: " + JSON.stringify(envelope));
  if (fake.calls.length !== 0) fail("runner called on invalid input");
});

await test('base "--fill" → invalid_input (flag injection refused)', async () => {
  const fake = fakeRunner({ exitCode: 0, stdout: "", stderr: "" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_create", { title: "T", body: "B", base: "--fill", repo_dir: repo }));
  if (envelope.ok !== false || envelope.error.code !== "invalid_input") fail("envelope: " + JSON.stringify(envelope));
  if (fake.calls.length !== 0) fail("runner called with a flag-shaped branch");
});

console.log("\nfenix-github: exit-code mapping");

await test("runner exit 2 → refused", async () => {
  const fake = fakeRunner({ exitCode: 2, stdout: "", stderr: "usage: gh pr edit" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_edit", { number: 7, title: "New title", repo_dir: repo }));
  if (envelope.ok !== false || envelope.error.code !== "refused") fail("envelope: " + JSON.stringify(envelope));
});

await test("runner timeout (exitCode 124, timedOut) → gh_timeout, not gh_missing", async () => {
  const fake = fakeRunner({ exitCode: 124, timedOut: true, stdout: "", stderr: "" });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_comment", { number: 7, body: "b", repo_dir: repo }));
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
  const envelope = envelopeOf(await call(server, "pr_comment", { number: 7, body: "b", repo_dir: repo }));
  if (envelope.ok !== false || envelope.error.code !== "gh_failed") fail("envelope: " + JSON.stringify(envelope));
});

await test("runner-side egress verdict stays detected on a stderr line start", async () => {
  const fake = fakeRunner({
    exitCode: 1,
    stdout: "",
    stderr: "Error: [egress-blocked] secret-shaped hit in pr body\n",
  });
  const server = createFenixGithubServer({ runGh: fake.runGh });
  const envelope = envelopeOf(await call(server, "pr_comment", { number: 7, body: "b", repo_dir: repo }));
  if (envelope.ok !== false || envelope.error.code !== "egress_blocked") fail("envelope: " + JSON.stringify(envelope));
});

console.log("\nfenix-github: end-to-end through the real gh-screened runner");

await test("E2E: pr_create with the default runner (LA_GH_COMMAND → fake gh) runs inside repo_dir", async () => {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fenix-gh-test-fakegh-"));
  const cwdFile = path.join(fakeDir, "cwd.txt");
  const fakeGhPath = path.join(fakeDir, "fake-gh.mjs");
  // The fake gh records its cwd and prints a PR URL — the same stdout shape
  // the real gh produces on `pr create`. It ignores gh's argv entirely.
  fs.writeFileSync(fakeGhPath, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'const here = path.dirname(fileURLToPath(import.meta.url));',
    'fs.writeFileSync(path.join(here, "cwd.txt"), process.cwd(), "utf8");',
    'console.log("https://github.com/joint-hubs/linear-agents/pull/1");',
    "",
  ].join("\n"), "utf8");
  const prevSeam = process.env.LA_GH_COMMAND;
  process.env.LA_GH_COMMAND = JSON.stringify([process.execPath, fakeGhPath]);
  try {
    // NO injected runner: the real default runner spawns the real
    // gh-screened.mjs, which spawns the fake gh through the seam.
    const server = createFenixGithubServer({});
    const response = await call(server, "pr_create", { title: "E2E title", body: "E2E body", repo_dir: repo });
    if (response.result.isError === true) fail("isError on a valid E2E call: " + response.result.content[0].text);
    const envelope = envelopeOf(response);
    if (envelope.ok !== true) fail("envelope: " + JSON.stringify(envelope));
    if (envelope.url !== "https://github.com/joint-hubs/linear-agents/pull/1") fail("url: " + envelope.url);
    if (!fs.existsSync(cwdFile)) fail("fake gh never recorded its cwd");
    const recorded = fs.readFileSync(cwdFile, "utf8");
    if (fs.realpathSync(recorded) !== repoReal) fail("recorded cwd: " + recorded + " expected " + repoReal);
  } finally {
    if (prevSeam === undefined) delete process.env.LA_GH_COMMAND;
    else process.env.LA_GH_COMMAND = prevSeam;
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

console.log("\nfenix-github: unknown tool");

await test("tools/call for pr_merge → JSON-RPC error, not a result", async () => {
  const server = createFenixGithubServer({});
  const response = await call(server, "pr_merge", {}, 2);
  if (!response.error) fail("expected a JSON-RPC error, got: " + JSON.stringify(response).slice(0, 120));
  if (response.error.code !== -32602) fail("code: " + response.error.code);
});

fs.rmSync(repo, { recursive: true, force: true });

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}
