// scripts/agent-tools.test.mjs — FOC-900: the read-only agent permission tool.
//
// Everything runs against mkdtemp fixtures: a synthetic agents root, a
// synthetic .mcp.json, and (for `diff`) one local git fixture repo that never
// touches the network or this repo's own checkout. The docs test performs a
// read-only render of the real tree and pins the committed docs/agent-tools.md
// to it — that comparison is what forces regeneration after a settings change.
//
// Run: node scripts/agent-tools.test.mjs   (also: node --test <this file>)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DENY_BASELINE,
  checkFindings,
  diffAgent,
  diffLists,
  hookCounts,
  parseRule,
  renderDocs,
  rulePrefix,
  runCli,
  showAgent,
} from "./agent-tools.mjs";
import { SUPERVISOR_DENY } from "./supervisor-lib.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPTS_DIR);

const tempDirs = [];
const makeTemp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function writeAgent(agentsDir, name, settings) {
  const dir = path.join(agentsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  return dir;
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Agents root + .mcp.json covering every MCP/skill shape `show` distinguishes. */
function makeAgentsFixture() {
  const dir = makeTemp("agent-tools-fixture-");
  const agentsDir = mkdirp(path.join(dir, "agents"));
  writeAgent(agentsDir, "alpha", {
    permissions: {
      allow: ["Read", "mcp__alpha__*", "Bash(node:*)", "Bash(cd:*)"],
      ask: ["Bash(git push:*)"],
      deny: ["mcp__beta__*", "Artifact"],
      defaultMode: "acceptEdits",
      additionalDirectories: ["C:/tmp/elsewhere"],
    },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }],
    },
  });
  writeAgent(agentsDir, "beta", {
    permissions: { allow: ["mcp__*"], deny: ["mcp__alpha__*"] },
  });
  mkdirp(path.join(agentsDir, "bare")); // agent dir without settings.json
  mkdirp(path.join(agentsDir, "_shared", "skills", "shared-skill"));
  mkdirp(path.join(agentsDir, "alpha", "skills", "alpha-own"));
  mkdirp(path.join(agentsDir, "alpha", "skills", "shared-skill"));
  mkdirp(path.join(agentsDir, "beta", "skills", "other-shared"));
  const mcpPath = path.join(dir, ".mcp.json");
  fs.writeFileSync(
    mcpPath,
    JSON.stringify({ mcpServers: { alpha: {}, beta: {}, gamma: {} } }, null, 2),
  );
  return { dir, agentsDir, mcpPath };
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  };
}

const run = (argv, env = process.env) => {
  const io = capture();
  const code = runCli(argv, { stdout: io.stdout, stderr: io.stderr, env });
  return { code, text: io.out.join(""), errText: io.err.join(""), json: () => JSON.parse(io.out.join("")) };
};

// ── rule shapes ──────────────────────────────────────────────────────────────

test("parseRule accepts bare tools and Tool(pattern) forms", () => {
  assert.deepEqual(parseRule("Read"), { ok: true, tool: "Read", pattern: null });
  assert.equal(parseRule("Bash(git status:*)").ok, true);
  assert.equal(parseRule("Bash(git -C * show*)").ok, true);
});

test("parseRule rejects the documented invalid shapes", () => {
  assert.equal(parseRule(42).reason, "not-a-string");
  assert.equal(parseRule("   ").reason, "empty");
  assert.equal(parseRule("Bash()").reason, "empty-pattern");
  assert.equal(parseRule("Bash(command:ls)").reason, "primary-field");
  assert.equal(parseRule("Read(file_path:x)").reason, "primary-field");
  assert.equal(parseRule("Grep(path:x)").reason, "primary-field");
  assert.equal(parseRule("WebFetch(url:x)").reason, "primary-field");
  assert.equal(parseRule("Bash(git (status)").reason, "shape");
  assert.equal(parseRule("Bash(git status").reason, "shape");
});

test("rulePrefix normalises the trailing colon to a space", () => {
  assert.equal(rulePrefix("Bash(git branch:*)"), "git branch ");
  assert.equal(rulePrefix("Bash(git branch -D:*)"), "git branch -D ");
  assert.equal(rulePrefix("Bash(git -C * status*)"), "git -C ");
  assert.equal(rulePrefix("Bash(true)"), "true");
  assert.equal(rulePrefix("WebFetch"), null);
});

// ── show ─────────────────────────────────────────────────────────────────────

const fixture = makeAgentsFixture();

test("show reports permissions in file order, mcp reachability and skills", () => {
  const data = showAgent("alpha", fixture);
  assert.equal(data.agent, "alpha");
  assert.ok(data.settingsPath.endsWith("agents/alpha/settings.json") || data.settingsPath.endsWith("agents\\alpha\\settings.json"));
  assert.deepEqual(data.permissions.allow, ["Read", "mcp__alpha__*", "Bash(node:*)", "Bash(cd:*)"]);
  assert.deepEqual(data.permissions.ask, ["Bash(git push:*)"]);
  assert.deepEqual(data.permissions.deny, ["mcp__beta__*", "Artifact"]);
  assert.deepEqual(data.additionalDirectories, ["C:/tmp/elsewhere"]);
  assert.equal(data.defaultMode, "acceptEdits");
  assert.deepEqual(data.hooks, { SessionStart: 1 });
  assert.deepEqual(data.mcp, [
    { server: "alpha", reachable: true, via: "mcp__alpha__*", deniedBy: null },
    { server: "beta", reachable: false, via: null, deniedBy: "mcp__beta__*" },
    { server: "gamma", reachable: false, via: null, deniedBy: null },
  ]);
  assert.deepEqual(data.skills, [
    { name: "alpha-own", source: "own" },
    { name: "shared-skill", source: "both" },
  ]);
});

test("show: wildcard allow makes servers reachable, server-wildcard deny wins", () => {
  const data = showAgent("beta", fixture);
  assert.deepEqual(data.mcp, [
    { server: "alpha", reachable: false, via: "mcp__*", deniedBy: "mcp__alpha__*" },
    { server: "beta", reachable: true, via: "mcp__*", deniedBy: null },
    { server: "gamma", reachable: true, via: "mcp__*", deniedBy: null },
  ]);
  assert.deepEqual(data.skills, [{ name: "other-shared", source: "own" }, { name: "shared-skill", source: "shared" }]);
});

test("show handles an agent dir without settings.json gracefully", () => {
  const data = showAgent("bare", fixture);
  assert.deepEqual(data.permissions, { allow: [], ask: [], deny: [] });
  assert.deepEqual(data.hooks, {});
  assert.equal(data.defaultMode, null);
  assert.equal(data.mcp.every((m) => !m.reachable), true);
});

test("show via the CLI: --json, text, and the unknown-agent usage exit", () => {
  const json = run(["show", "alpha", "--root", fixture.agentsDir, "--mcp", fixture.mcpPath, "--json"]);
  assert.equal(json.code, 0);
  assert.equal(json.json().agent, "alpha");

  const text = run(["show", "alpha", "--root", fixture.agentsDir, "--mcp", fixture.mcpPath]);
  assert.equal(text.code, 0);
  assert.match(text.text, /allow \(4\)/);
  assert.match(text.text, /beta — denied by mcp__beta__\*/);
  assert.match(text.text, /shared-skill — both/);

  const unknown = run(["show", "nope", "--root", fixture.agentsDir, "--mcp", fixture.mcpPath]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.errText, /unknown agent: nope/);
  assert.match(unknown.errText, /alpha, beta/);
});

test("show defaults to the effective root: LA_SQUAD_HOME when set, repo tree otherwise", () => {
  const squadRoot = makeTemp("agent-tools-squad-");
  writeAgent(squadRoot, "delta", { permissions: { allow: ["Read"] } });
  const withEnv = { ...process.env, LA_SQUAD_HOME: squadRoot };
  const baseEnv = { ...process.env };
  delete baseEnv.LA_SQUAD_HOME;

  // with LA_SQUAD_HOME, show (no --root) reads the squad root
  const viaEnv = run(["show", "delta", "--json"], withEnv);
  assert.equal(viaEnv.code, 0);
  assert.equal(viaEnv.json().agent, "delta");
  assert.ok(viaEnv.json().settingsPath.startsWith(squadRoot));

  // without it, the same command falls back to the repo tree — delta lives
  // only in the squad root, so it is unknown there
  const viaRepo = run(["show", "delta", "--json"], baseEnv);
  assert.equal(viaRepo.code, 2);
  assert.match(viaRepo.errText, /unknown agent: delta/);
  // ...and a repo-tree agent is still visible without --root
  assert.equal(run(["show", "dev", "--json"], baseEnv).code, 0);
});

// ── diff ─────────────────────────────────────────────────────────────────────

test("diffLists is a pure order-preserving diff", () => {
  assert.deepEqual(diffLists(["a", "b"], ["b", "c"]), { added: ["a"], removed: ["c"] });
  assert.deepEqual(diffLists([], []), { added: [], removed: [] });
});

function makeGitFixture() {
  const dir = makeTemp("agent-tools-git-");
  const agentsDir = mkdirp(path.join(dir, "agents"));
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    return r;
  };
  writeAgent(agentsDir, "dev", {
    permissions: { allow: ["Bash(git status:*)"], ask: [], deny: [] },
  });
  git(["init", "-q"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  // after the commit: one allow added, one ask added
  writeAgent(agentsDir, "dev", {
    permissions: { allow: ["Bash(git status:*)", "Bash(git log:*)"], ask: ["Bash(git push:*)"], deny: [] },
  });
  return { dir, agentsDir };
}

test("diff against a git ref reports added/removed per list", () => {
  const repo = makeGitFixture();
  const data = diffAgent("dev", "HEAD", { agentsDir: repo.agentsDir });
  assert.deepEqual(data.allow, { added: ["Bash(git log:*)"], removed: [] });
  assert.deepEqual(data.ask, { added: ["Bash(git push:*)"], removed: [] });
  assert.deepEqual(data.deny, { added: [], removed: [] });
});

test("diff via the CLI: --json shape, missing --against, non-repo root", () => {
  const repo = makeGitFixture();
  const json = run(["diff", "dev", "--against", "HEAD", "--root", repo.agentsDir, "--json"]);
  assert.equal(json.code, 0);
  assert.deepEqual(json.json(), {
    agent: "dev",
    against: "HEAD",
    allow: { added: ["Bash(git log:*)"], removed: [] },
    ask: { added: ["Bash(git push:*)"], removed: [] },
    deny: { added: [], removed: [] },
  });

  assert.equal(run(["diff", "dev", "--root", repo.agentsDir]).code, 2);
  const outside = makeTemp("agent-tools-norepo-");
  assert.equal(run(["diff", "dev", "--against", "HEAD", "--root", outside]).code, 2);

  // an unknown agent is the usage error, not every base rule counted as removed
  const unknown = run(["diff", "nope", "--against", "HEAD", "--root", repo.agentsDir]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.errText, /unknown agent: nope/);
  assert.match(unknown.errText, /\bdev\b/);
});

// ── check ────────────────────────────────────────────────────────────────────

function checkFixture(permissions) {
  const dir = makeTemp("agent-tools-check-");
  const agentsDir = mkdirp(path.join(dir, "agents"));
  writeAgent(agentsDir, "squad", { permissions });
  return agentsDir;
}

const find = (findings, level, rule) =>
  findings.find((f) => f.level === level && f.rule === rule);

test("check: invalid rule shapes are errors", () => {
  for (const [rule, fragment] of [
    ["Bash(command:ls)", "primary content field"],
    [42, "not a string"],
    ["   ", "empty"],
    ["Bash()", "empty pattern"],
    ["Bash(git (status)", "balanced parentheses"],
  ]) {
    const { findings, ok } = checkFindings({ agentsDir: checkFixture({ allow: [rule] }) });
    assert.equal(ok, false, rule);
    const error = findings.find((f) => f.level === "error" && f.rule === String(rule));
    assert.ok(error, `no error finding for ${rule}`);
    assert.match(error.message, new RegExp(fragment));
    assert.equal(error.agent, "squad");
    assert.equal(error.list, "allow");
  }
});

test("check: duplicate rules are errors, within one list and across lists", () => {
  const within = checkFindings({
    agentsDir: checkFixture({ allow: ["Bash(git status:*)", "Bash(git status:*)"] }),
  });
  assert.equal(within.ok, false);
  assert.ok(find(within.findings, "error", "Bash(git status:*)"));

  const across = checkFindings({
    agentsDir: checkFixture({ allow: ["WebFetch"], ask: ["WebFetch"] }),
  });
  assert.equal(across.ok, false);
  const finding = find(across.findings, "error", "WebFetch");
  assert.equal(finding.list, "ask");
  assert.match(finding.message, /also in allow/);
});

test("check: an allow+deny duplicate is one error, not a silent overlap", () => {
  const agentsDir = checkFixture({ allow: ["WebFetch"], ask: [], deny: ["WebFetch"] });
  const { findings, ok, summary } = checkFindings({ agentsDir });
  assert.equal(ok, false);
  const errors = findings.filter((f) => f.level === "error" && f.rule === "WebFetch");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].list, "deny");
  assert.match(errors[0].message, /also in allow/);
  // the overlap warning stays silent — the duplicate was reported as an error
  assert.equal(findings.filter((f) => f.level === "warning" && f.rule === "WebFetch").length, 0);
  assert.deepEqual(summary, { errors: 1, warnings: 0, infos: 0 });
  assert.equal(run(["check", "--root", agentsDir]).code, 1);
});

test("check: an ask prefix extending an allow prefix is a warning only", () => {
  const agentsDir = checkFixture({
    allow: ["Bash(git branch:*)"],
    ask: ["Bash(git branch -D:*)"],
    deny: [],
  });
  const { findings, ok, summary } = checkFindings({ agentsDir });
  assert.equal(ok, true);
  const warning = find(findings, "warning", "Bash(git branch -D:*)");
  assert.ok(warning);
  assert.match(warning.message, /overlap with allow rule Bash\(git branch:\*\)/);
  assert.match(warning.message, /deny > ask > allow/);
  assert.deepEqual(summary, { errors: 0, warnings: 1, infos: 0 });
  assert.equal(run(["check", "--root", agentsDir]).code, 0);
});

test("check: interpreter and compound-helper allow rules are infos", () => {
  const agentsDir = checkFixture({
    allow: ["Bash(node:*)", "Bash(cd:*)", "Bash(*/Scripts/python.exe*)", "Bash(git status:*)"],
  });
  const { findings, ok, summary } = checkFindings({ agentsDir });
  assert.equal(ok, true);
  assert.ok(find(findings, "info", "Bash(node:*)"));
  assert.ok(find(findings, "info", "Bash(cd:*)"));
  assert.ok(find(findings, "info", "Bash(*/Scripts/python.exe*)"));
  assert.equal(findings.filter((f) => f.level === "info").length, 3);
  assert.equal(summary.infos, 3);
  const interpreter = find(findings, "info", "Bash(node:*)");
  assert.match(interpreter.message, /command text only/);
  assert.match(find(findings, "info", "Bash(cd:*)").message, /compound commands/);
});

test("check: a shrunk SUPERVISOR_DENY is an error through the seam", () => {
  const empty = mkdirp(path.join(makeTemp("agent-tools-baseline-"), "agents"));
  const shrunk = SUPERVISOR_DENY.filter((r) => r !== "Bash(gh api:*)");
  const { findings } = checkFindings({ agentsDir: empty, supervisorDeny: shrunk });
  const error = find(findings, "error", "Bash(gh api:*)");
  assert.ok(error);
  assert.equal(error.agent, "supervisor-lib");
  assert.equal(error.list, "deny");
  assert.match(error.message, /baseline shrank/);

  // the live export still covers the whole baseline — no baseline errors
  const intact = checkFindings({ agentsDir: empty });
  assert.equal(intact.findings.filter((f) => f.agent === "supervisor-lib").length, 0);
  assert.deepEqual(DENY_BASELINE.filter((r) => !SUPERVISOR_DENY.includes(r)), []);
});

test("check via the CLI: exit 1 on errors, summary line, --json shape", () => {
  const bad = checkFixture({ allow: ["Bash(command:ls)"] });
  const badRun = run(["check", "--root", bad]);
  assert.equal(badRun.code, 1);
  assert.match(badRun.text, /^ERROR squad allow Bash\(command:ls\) — /m);
  assert.match(badRun.text, /summary: 1 error/);

  const jsonRun = run(["check", "--root", bad, "--json"]);
  assert.equal(jsonRun.code, 1);
  const parsed = jsonRun.json();
  assert.equal(parsed.ok, false);
  assert.equal(parsed.summary.errors, 1);
  assert.equal(parsed.findings[0].level, "error");
});

// ── hooks ────────────────────────────────────────────────────────────────────

test("hookCounts counts command hooks across nested and flat entries", () => {
  assert.deepEqual(
    hookCounts({
      hooks: {
        Stop: [
          { matcher: "*", hooks: [{ type: "command", command: "a" }, { type: "command", command: "b" }] },
          { hooks: [{ type: "command", command: "c" }] },
        ],
        SessionEnd: [{ hooks: [{ type: "command", command: "d" }] }],
      },
    }),
    { Stop: 3, SessionEnd: 1 },
  );
  assert.deepEqual(hookCounts({}), {});
  assert.deepEqual(hookCounts({ hooks: { Stop: "not-an-array" } }), {});
});

// ── docs ─────────────────────────────────────────────────────────────────────

test("renderDocs is deterministic for the same tree", () => {
  const first = renderDocs(fixture);
  const second = renderDocs(fixture);
  assert.equal(first, second);
  assert.match(first, /^# Agent settings — generated reference/);
  assert.match(first, /do not edit by hand/);
  assert.match(first, /deny > ask > allow/);
  assert.match(first, /Rendered from the repository's `agents\/` tree/);
  assert.match(first, /server-wildcard denies only/);
  assert.match(first, /tool-level deny/);
  assert.match(first, /## alpha/);
  assert.match(first, /\| `Bash\(node:\*\)` \| interpreter \|/);
  assert.match(first, /\| `Bash\(cd:\*\)` \| compound helper \|/);
  assert.match(first, /\| `Bash\(git push:\*\)` \|  \|/);
  assert.match(first, /\| shared-skill \| both \|/);
});

test("the committed docs/agent-tools.md is current (render with the real root)", () => {
  // Normalise CRLF → LF: with core.autocrlf=true a fresh Windows checkout has
  // CRLF on disk although the blob is LF (.gitattributes pins the file to LF).
  const committed = fs
    .readFileSync(path.join(REPO_ROOT, "docs", "agent-tools.md"), "utf8")
    .replace(/\r\n/g, "\n");
  // --write appends exactly one trailing newline to the render
  assert.equal(renderDocs() + "\n", committed);
});

// ── CLI usage ────────────────────────────────────────────────────────────────

test("usage exits: no args, unknown command, missing values, unknown option", () => {
  assert.equal(run([]).code, 2);
  assert.equal(run(["bogus"]).code, 2);
  assert.equal(run(["show"]).code, 2);
  assert.equal(run(["show", "alpha", "--root"]).code, 2);
  assert.equal(run(["show", "alpha", "--nope"]).code, 2);
  assert.equal(run(["--help"]).code, 0);
});
