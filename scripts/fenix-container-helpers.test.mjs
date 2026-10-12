// scripts/fenix-container-helpers.test.mjs — FOC-776: container entrypoint
// helpers (fenix-claude-prefs, fenix-git-identity, fenix-projects).
//
// Same self-contained harness idiom as scripts/utils.test.mjs. Only mkdtemp
// temp dirs are touched and nothing here reaches the network — fetch and the
// git wrapper are injected fakes; console.log is captured so the tests can
// also prove the GitHub token never appears in any printed or returned
// string. Every temp dir is cleaned at the end.
//
// Run: node scripts/fenix-container-helpers.test.mjs

import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyClaudePrefs } from "./fenix-claude-prefs.mjs";
import { ensureGitIdentity } from "./fenix-git-identity.mjs";
import { addProject, listProjects } from "./fenix-projects.mjs";

let passed = 0;
const failures = [];

// async so the fetch-shaped helpers can be awaited. Every call below is
// awaited at top level — pending promises do not keep the event loop alive,
// so unawaited async tests would let Node exit mid-suite.
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + err.message);
  }
}

const fail = (msg) => { throw new Error(msg); };
const eq = (a, b, label) => { if (a !== b) fail(`${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const ok = (cond, label) => { if (!cond) fail(label); };

// Tracked temp dirs — swept at the end, nothing left behind anywhere.
const dirs = [];
const tmpDir = (tag) => {
  const d = mkdtempSync(join(tmpdir(), tag));
  dirs.push(d);
  return d;
};

// Capture console.log/error lines for the duration of fn(), then restore.
async function withLogs(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = (msg) => lines.push(String(msg));
  console.error = (msg) => lines.push(String(msg));
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return lines;
}

const jsonOf = (file) => JSON.parse(readFileSync(file, "utf8"));

console.log("\ncontainer helpers: fenix-claude-prefs");

await test("creates .claude.json when missing and sets onboarding + trust flags", async () => {
  const dir = tmpDir("fenix-prefs-missing-");
  const configDir = join(dir, "claude");
  const trustPath = join(dir, "ws");
  const lines = await withLogs(() => applyClaudePrefs({ configDir, trustPath }));
  eq(lines[0], `claude prefs: onboarding done, trusted ${trustPath}`, "one-line summary printed");
  const file = join(configDir, ".claude.json");
  ok(existsSync(file), "config file created");
  const prefs = jsonOf(file);
  eq(prefs.hasCompletedOnboarding, true, "hasCompletedOnboarding");
  eq(prefs.hasSeenAutoDefaultNudge, true, "hasSeenAutoDefaultNudge");
  eq(prefs.hasSeenAutoDefaultNotice, true, "hasSeenAutoDefaultNotice");
  ok(!("permissions" in prefs), "no permissions key written");
  ok(!("defaultMode" in prefs), "no defaultMode key written");
  eq(prefs.projects[trustPath].hasTrustDialogAccepted, true, "hasTrustDialogAccepted");
  eq(prefs.projects[trustPath].hasCompletedProjectOnboarding, true, "hasCompletedProjectOnboarding");
});

await test("preserves unrelated keys and other projects, is idempotent on re-run", async () => {
  const dir = tmpDir("fenix-prefs-preserve-");
  const configDir = dir;
  const trustPath = join(dir, "ws");
  const other = join(dir, "other");
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({
    theme: "dark",
    numStartups: 7,
    permissions: { defaultMode: "default", allow: ["Read"] },
    projects: { [other]: { allowedTools: ["bash"] } },
  }), "utf8");
  await withLogs(() => applyClaudePrefs({ configDir, trustPath }));
  await withLogs(() => applyClaudePrefs({ configDir, trustPath })); // re-run must not corrupt anything
  const prefs = jsonOf(join(configDir, ".claude.json"));
  eq(prefs.theme, "dark", "unrelated key preserved");
  eq(prefs.numStartups, 7, "unrelated key preserved");
  eq(JSON.stringify(prefs.permissions), JSON.stringify({ defaultMode: "default", allow: ["Read"] }), "existing permissions/defaultMode untouched");
  eq(prefs.hasSeenAutoDefaultNudge, true, "hasSeenAutoDefaultNudge set on existing config");
  eq(prefs.hasSeenAutoDefaultNotice, true, "hasSeenAutoDefaultNotice set on existing config");
  eq(prefs.projects[other].allowedTools.join(","), "bash", "other project preserved");
  eq(Object.keys(prefs.projects).sort().join(","), [other, trustPath].sort().join(","), "exactly the two projects");
  eq(prefs.projects[trustPath].hasTrustDialogAccepted, true, "trust flag set");
  eq(prefs.projects[trustPath].hasCompletedProjectOnboarding, true, "onboarding flag set");
});

await test("refuses to overwrite an unparseable .claude.json — file unchanged, throws", async () => {
  const dir = tmpDir("fenix-prefs-broken-");
  const configDir = dir;
  const trustPath = join(dir, "ws");
  const file = join(configDir, ".claude.json");
  writeFileSync(file, "{ this is not json", "utf8");
  const before = readFileSync(file, "utf8");
  let thrown = null;
  await withLogs(async () => {
    try {
      await applyClaudePrefs({ configDir, trustPath });
    } catch (err) {
      thrown = err;
    }
  });
  ok(thrown, "must throw on unparseable config");
  eq(readFileSync(file, "utf8"), before, "broken file left byte-for-byte unchanged");
  ok(!thrown.message.includes("onboarding done"), "no success line on the failure path");
});

console.log("\ncontainer helpers: fenix-git-identity (injected runGit/fetch, no network)");

const captureLogs = (lines) => (msg) => lines.push(String(msg));

await test("identity already set → no fetch, no config writes", async () => {
  const fetches = [];
  const gitCalls = [];
  let lines = [];
  const orig = console.log;
  console.log = captureLogs(lines);
  try {
    await ensureGitIdentity({
      runGit: (args) => {
        gitCalls.push(args);
        return { status: 0, stdout: "me@example.com\n" };
      },
      fetchImpl: async (url) => { fetches.push(url); return { status: 200, json: async () => ({}) }; },
    });
  } finally {
    console.log = orig;
  }
  eq(fetches.length, 0, "fetch must not be called");
  eq(gitCalls.length, 1, "only the user.email probe ran");
  eq(lines.join("\n"), "git identity: already set", "already-set line");
});

await test("no GITHUB_TOKEN → no fetch, warning, exit still success-shaped", async () => {
  const fetches = [];
  let lines = [];
  const orig = console.log;
  console.log = captureLogs(lines);
  try {
    const result = await ensureGitIdentity({
      env: {},
      runGit: () => ({ status: 1, stdout: "" }),
      fetchImpl: async (url) => { fetches.push(url); return { status: 200, json: async () => ({}) }; },
    });
    eq(result.status, "no-token", "no-token status returned");
  } finally {
    console.log = orig;
  }
  eq(fetches.length, 0, "fetch must not be called");
  ok(lines.some((l) => l.includes("WARN git identity: no GitHub token")), "warning printed");
});

await test("200 → git config called with name/email from the response; token never printed or returned", async () => {
  const TOKEN = "ghp_super_secret_token_123";
  const gitCalls = [];
  const lines = [];
  const orig = console.log;
  console.log = captureLogs(lines);
  let result;
  try {
    result = await ensureGitIdentity({
      env: { GITHUB_TOKEN: TOKEN },
      runGit: (args) => {
        gitCalls.push(args);
        return args[3] === "user.email" ? { status: 1, stdout: "" } : { status: 0, stdout: "" };
      },
      fetchImpl: async (url, opts) => {
        eq(url, "https://api.github.com/user", "GitHub /user endpoint");
        eq(opts.headers.Accept, "application/vnd.github+json", "Accept header");
        eq(opts.headers["User-Agent"], "fenix", "User-Agent header");
        return { status: 200, json: async () => ({ id: 42, login: "octo", name: "Octo Cat" }) };
      },
    });
  } finally {
    console.log = orig;
  }
  eq(result.name, "Octo Cat", "name from json.name");
  eq(result.email, "42+octo@users.noreply.github.com", "noreply email from id+login");
  const configCalls = gitCalls.filter((a) => a[0] === "config" && a[1] === "--global");
  ok(configCalls.some((a) => a.join(" ") === "config --global user.name Octo Cat"), "user.name set");
  ok(configCalls.some((a) => a.join(" ") === "config --global user.email 42+octo@users.noreply.github.com"), "user.email set");
  const everything = JSON.stringify({ calls: gitCalls, lines, result });
  ok(!everything.includes(TOKEN), "token must not appear in any call, print or return value");
});

await test("401 → warning, no git config writes, token never printed", async () => {
  const TOKEN = "ghp_another_secret_456";
  const gitCalls = [];
  const lines = [];
  const orig = console.log;
  console.log = captureLogs(lines);
  try {
    await ensureGitIdentity({
      env: { GITHUB_TOKEN: TOKEN },
      runGit: (args) => { gitCalls.push(args); return { status: 1, stdout: "" }; },
      fetchImpl: async () => ({ status: 401, json: async () => ({}) }),
    });
  } finally {
    console.log = orig;
  }
  ok(lines.some((l) => l.includes("GitHub /user returned 401")), "warning carries the HTTP status");
  ok(!gitCalls.some((a) => a.includes("user.name")), "user.name never set on 401");
  ok(!lines.join("\n").includes(TOKEN), "token must not be printed");
});

console.log("\ncontainer helpers: fenix-projects (mkdtemp only)");

await test("add creates the file, add again updates (no duplicate), list returns entries", () => {
  const dir = tmpDir("fenix-projects-add-");
  const file = join(dir, "maps", "projects.json");
  eq(addProject(file, { linearProject: "Neo", workspace: "joi", repo: "${GITHUB_ROOT}/joint-flows", deploy: { type: "none" } }), "added", "first add → added");
  const first = jsonOf(file);
  eq(first.projects.length, 1, "exactly one entry after first add");
  eq(first.projects[0].workspace, "joi", "entry shape: workspace");
  eq(first.projects[0].deploy.type, "none", "entry shape: deploy");
  eq(addProject(file, { linearProject: "Neo", workspace: "joi", repo: "${GITHUB_ROOT}/other", deploy: { type: "none" } }), "updated", "second add → updated");
  const second = jsonOf(file);
  eq(second.projects.length, 1, "no duplicate on re-add");
  eq(second.projects[0].repo, "${GITHUB_ROOT}/other", "repo replaced on update");
  const listed = listProjects(file);
  eq(listed.length, 1, "list returns entries");
  eq(listed[0].linearProject, "Neo", "list entry: linearProject");
  eq(listed[0].repo, "${GITHUB_ROOT}/other", "list entry: repo");
  eq(listProjects(join(dir, "no-such-file.json")).length, 0, "missing file lists as empty");
});

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\ncontainer helpers: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
