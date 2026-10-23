// scripts/supervisor-ask-guard.test.mjs — the FOC-978 spelling table.
//
// The proven gap (worktree push on the VM): prefix ask-rules like
// "Bash(git push:*)" match only literal prefixes, so `git -C /data/... push`,
// `env GIT_X=1 git push`, `sh -c 'git push'` and friends sailed through the
// auto-mode classifier with no human gate. This suite pins every spelling that
// MUST be asked and every near-miss that MUST NOT, against the real classifier,
// then spawns the actual hook once per direction to pin its stdin→stdout JSON.
//
// Run: node scripts/supervisor-ask-guard.test.mjs

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyDangerous } from "./supervisor-ask-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(ROOT, "scripts", "supervisor-ask-guard.mjs");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const fail = (msg) => { throw new Error(msg); };

// ── spelling table ─────────────────────────────────────────────────────────────
// [command, expected op] — expected op null means "MUST NOT ask".
const MUST_ASK = [
  ["git push", "git push"],
  ["git push -u origin x", "git push"],
  ["git -C /data/w/repo push -u origin x", "git push"],
  ["git -c core.sshCommand=ssh push", "git push"],
  ["GIT_TRACE=1 git push", "git push"],
  ["env GIT_X=1 git push", "git push"],
  ["cd /x && git push", "git push"],
  ["git status && git -C /r push", "git push"],
  ["/usr/bin/git push", "git push"],
  ["sudo git push", "git push"],
  ["git --git-dir=/r/.git push", "git push"],
  ["git --no-pager -C /r push origin", "git push"],
  ["sh -c 'git push'", "git push"],
  ['bash -c "git -C /r push"', "git push"],
  ["git reset --hard HEAD~1", "git reset --hard"],
  ["git -C /r reset --hard", "git reset --hard"],
  ["git clean -fdx", "git clean"],
  ["git -C /r clean -n", "git clean"],
  ["git branch -D x", "git branch -D"],
  ["git -C /r branch -D x", "git branch -D"],
  ["gh pr merge 12", "gh pr merge"],
  ["gh -R a/b pr merge 12", "gh pr merge"],
  ["gh --repo a/b pr merge 12 --squash", "gh pr merge"],
  ["rm -rf /tmp/x", "rm -rf"],
  ["rm -fr x", "rm -rf"],
  ["rm -r -f x", "rm -rf"],
  // git globals — the skip loop must keep looping and read attached values
  ["git -C/r push", "git push"],
  ["git -C /a -C /b push", "git push"],
  ["git -C /r --no-pager push", "git push"],
  ["git --work-tree /r --git-dir /r/.git push", "git push"],
  ["git -c a=b -C /r push", "git push"],
  // wrappers with their own arguments, nesting included
  ["exec git push", "git push"],
  ["timeout 30 git push", "git push"],
  ["timeout -k 5 30s git -C /r push", "git push"],
  ["nice -n 5 git push", "git push"],
  ["env -i git push", "git push"],
  ["env -u HOME git push", "git push"],
  ["sudo -u root git push", "git push"],
  ["command -p git push", "git push"],
  ["echo x | xargs git push", "git push"],
  ["xargs -n1 git push", "git push"],
  ["sudo env X=1 timeout 30 git push", "git push"],
  // shell recursion: shells at any path, flag clusters, eval, depth 3
  ["/bin/sh -c 'git push'", "git push"],
  ["/usr/bin/bash -lc 'git -C /r push'", "git push"],
  ['bash -ec "git push"', "git push"],
  ["sh -c 'sh -c \"git push\"'", "git push"],
  ['eval "git push"', "git push"],
  ["eval git push", "git push"],
  // separators: background &, subshells, braces, command substitution
  ["echo done & git push", "git push"],
  ["(git push)", "git push"],
  ["{ git push; }", "git push"],
  ["$(git push)", "git push"],
  ["`git push`", "git push"],
  ["x=$(git -C /r push)", "git push"],
  // heredoc body is data; a push after the terminator is not
  ["cat <<EOF > x\nhi\nEOF\ngit push", "git push"],
];

const MUST_NOT_ASK = [
  "git status",
  "git -C /r log --oneline",
  "git -C /r fetch",
  "git branch --list",
  "git branch -d merged",
  "git reset --soft HEAD~1",
  "gh pr view 12",
  "gh pr list",
  'echo "git push"',
  'grep -n "git push" file.md',
  "rm file.txt",
  "rm -r dir",
  "node scripts/gh-screened.mjs pr create --title x --body-file y",
  // quoted mentions of gated ops stay data — the tokenizer must not split them
  'echo "see \\`git push\\`"',
  "echo '$(git push)'",
  // redirect spellings must not be read as a background separator
  "node a.mjs 2>&1 | tail -5",
  "cmd &> /tmp/log",
  // heredoc bodies are data, never commands
  "cat <<'EOF'\ngit push\nEOF",
  "cat > /tmp/s.sh <<EOF\ngit push\nEOF",
  'cat <<-"END"\nrm -rf x\nEND',
];

test("spelling table: every gated spelling forces the ask decision", () => {
  const missed = [];
  for (const [command, expectedOp] of MUST_ASK) {
    const verdict = classifyDangerous(command);
    if (!verdict || verdict.op !== expectedOp) {
      missed.push(`${command} → ${verdict ? verdict.op : "NO ASK"} (want ${expectedOp})`);
    }
  }
  if (missed.length) fail(`missed spellings:\n       ${missed.join("\n       ")}`);
});

test("spelling table: benign near-misses stay silent", () => {
  const falsePositives = [];
  for (const command of MUST_NOT_ASK) {
    const verdict = classifyDangerous(command);
    if (verdict) falsePositives.push(`${command} → ${verdict.op}`);
  }
  if (falsePositives.length)
    fail(`false positives:\n       ${falsePositives.join("\n       ")}`);
});

// ── the container boundary: FOC-988 (Fenix's own code) and FOC-1001 (child worktrees) ──
// Inert natively; inside the container (ctx.container) these ask. [command, ticket, op]
const CODE = "/opt/fenix";
const WT = "/data/workspaces/la-wt";
const IN_CONTAINER = { container: true, cwd: "/data/workspaces", env: { LA_ROOT: CODE, LA_WORKTREE_HOME: WT } };
const WRITE_OP = "write to Fenix's own code";

const BOUNDARY_ASK = [
  // FOC-988 — writes into LA_ROOT, every spelling the Supervisor has or might use
  ["echo x > /opt/fenix/scripts/a.mjs", "FOC-988", WRITE_OP],
  ["echo x >/opt/fenix/scripts/a.mjs", "FOC-988", WRITE_OP],
  ["echo x >> $LA_ROOT/scripts/a.mjs", "FOC-988", WRITE_OP],
  ["echo x >> ${LA_ROOT}/scripts/a.mjs", "FOC-988", WRITE_OP],
  ["printf x 2> /opt/fenix/e", "FOC-988", WRITE_OP],
  ["cat <<EOF > /opt/fenix/a.txt\nbody\nEOF", "FOC-988", WRITE_OP],
  ["sed -i 's/a/b/' /opt/fenix/scripts/supervisor-spawn.mjs", "FOC-988", WRITE_OP],
  ["sed -i.bak -e 's/a/b/' $LA_ROOT/scripts/x.mjs", "FOC-988", WRITE_OP],
  ["sed -ni 's/a/b/p' /opt/fenix/x", "FOC-988", WRITE_OP],
  ["sed --in-place s/a/b/ /opt/fenix/x", "FOC-988", WRITE_OP],
  ["echo x | tee /opt/fenix/a", "FOC-988", WRITE_OP],
  ["echo x | sudo tee -a /opt/fenix/a", "FOC-988", WRITE_OP],
  ["cp /tmp/x /opt/fenix/scripts/x.mjs", "FOC-988", WRITE_OP],
  ["cp -t /opt/fenix/scripts /tmp/x", "FOC-988", WRITE_OP],
  ["cp --target-directory=/opt/fenix/scripts /tmp/x", "FOC-988", WRITE_OP],
  ["mv /tmp/x $LA_ROOT/scripts/x", "FOC-988", WRITE_OP],
  ["mv /opt/fenix/scripts/x /tmp/x", "FOC-988", WRITE_OP],
  ["rm /opt/fenix/scripts/x.mjs", "FOC-988", WRITE_OP],
  ["chmod +x /opt/fenix/docker/entrypoint.sh", "FOC-988", WRITE_OP],
  ["touch /opt/fenix/x", "FOC-988", WRITE_OP],
  ["mkdir -p /opt/fenix/scripts/new", "FOC-988", WRITE_OP],
  ["install -m 644 /tmp/x /opt/fenix/x", "FOC-988", WRITE_OP],
  ["ln -sf /tmp/x /opt/fenix/x", "FOC-988", WRITE_OP],
  ["dd if=/tmp/x of=/opt/fenix/x", "FOC-988", WRITE_OP],
  ["patch -p1 -d /opt/fenix < fix.diff", "FOC-988", WRITE_OP],
  ["perl -pi -e 's/a/b/' /opt/fenix/scripts/x.mjs", "FOC-988", WRITE_OP],
  ['node -e "require(\'fs\').writeFileSync(\'/opt/fenix/scripts/x.mjs\', \'\')"', "FOC-988", WRITE_OP],
  ['node -e "fs.appendFileSync(process.env.LA_ROOT + \'/x\', 1)"', "FOC-988", WRITE_OP],
  ['python3 -c "open(\'/opt/fenix/scripts/x.py\', \'w\').write(\'\')"', "FOC-988", WRITE_OP],
  ["sh -c 'echo x > /opt/fenix/a'", "FOC-988", WRITE_OP],
  ["bash -lc \"sed -i s/a/b/ $LA_ROOT/scripts/x\"", "FOC-988", WRITE_OP],
  // a relative path after `cd` into the tree is still the tree
  ["cd /opt/fenix && sed -i s/a/b/ scripts/x.mjs", "FOC-988", WRITE_OP],
  ["cd /opt/fenix/scripts && echo x > a.mjs", "FOC-988", WRITE_OP],
  ["cd $LA_ROOT; rm -f scripts/x.mjs", "FOC-988", WRITE_OP],
  // FOC-1001 — trusting a directory
  ["git config --global --add safe.directory /data/workspaces/la-wt/linear-agents/foc-958-dev-x", "FOC-1001", "git safe.directory"],
  ["git config --system safe.directory '*'", "FOC-1001", "git safe.directory"],
  ["git config safe.directory /x", "FOC-1001", "git safe.directory"],
  ["git -C /data/workspaces/linear-agents config --global --add safe.directory /x", "FOC-1001", "git safe.directory"],
  ["git -c safe.directory=* status", "FOC-1001", "git safe.directory"],
  ["git -csafe.directory=/x status", "FOC-1001", "git safe.directory"],
  ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' git status", "FOC-1001", "git safe.directory"],
  ["env GIT_CONFIG_PARAMETERS=\"'safe.directory=*'\" git log", "FOC-1001", "git safe.directory"],
  // FOC-1001 — git inside a child-owned worktree, by -C / --git-dir / --work-tree / cd
  [`git -C ${WT}/linear-agents/foc-958-dev-x log --oneline`, "FOC-1001", "git in a child worktree"],
  [`git -C ${WT}/linear-agents/foc-958-dev-x push -u origin x`, "FOC-1001", "git in a child worktree"],
  [`git -C ${WT}/linear-agents/foc-958-dev-x/sub status`, "FOC-1001", "git in a child worktree"],
  [`git -C${WT}/linear-agents/b status`, "FOC-1001", "git in a child worktree"],
  [`git --git-dir=${WT}/linear-agents/b/.git log`, "FOC-1001", "git in a child worktree"],
  [`git --work-tree ${WT}/linear-agents/b status`, "FOC-1001", "git in a child worktree"],
  [`cd ${WT}/linear-agents/foc-958-dev-x && git status`, "FOC-1001", "git in a child worktree"],
  [`cd ${WT}/linear-agents/foc-958-dev-x; git push -u origin x`, "FOC-1001", "git in a child worktree"],
  ["cd $LA_WORKTREE_HOME/linear-agents/b && git diff", "FOC-1001", "git in a child worktree"],
  [`sh -c 'cd ${WT}/linear-agents/b && git status'`, "FOC-1001", "git in a child worktree"],
  [`git -C /data/workspaces/linear-agents status && git -C ${WT}/linear-agents/b log`, "FOC-1001", "git in a child worktree"],
  ["cd /data/workspaces/linear-agents && git -C ../la-wt/linear-agents/b status", "FOC-1001", "git in a child worktree"],
];

const BOUNDARY_SILENT = [
  // reads of Fenix's code, and writes anywhere else
  "cat /opt/fenix/scripts/x.mjs",
  "ls -la /opt/fenix",
  "grep -rn foo $LA_ROOT/scripts",
  "find /opt/fenix -name '*.mjs'",
  "sed -n 1,5p /opt/fenix/scripts/x.mjs",
  "sed -e s/a/b/ /opt/fenix/scripts/x.mjs",
  "node $LA_ROOT/scripts/supervisor-status.mjs --drain --tail 20",
  "node /opt/fenix/scripts/supervisor-gate.mjs list --open",
  "cp /opt/fenix/config/x.json /tmp/x.json",
  "cp -r $LA_ROOT/agents /data/agents",
  "mv /tmp/a /tmp/b",
  "echo x > /tmp/a",
  "echo x > /data/workspaces/linear-agents/x",
  "sed -i s/a/b/ /data/workspaces/linear-agents/f.txt",
  "rm /tmp/x",
  "mkdir -p /data/state/x",
  "tee /tmp/log < in.txt",
  "node scripts/x.mjs 2>&1 | tail -5",
  "ls 2>/dev/null",
  "echo done >&2",
  'node -e "console.log(require(\'fs\').readFileSync(\'/opt/fenix/VERSION\', \'utf8\'))"',
  'python3 -c "print(open(\'/opt/fenix/VERSION\').read())"',
  "perl -ne 'print' /opt/fenix/VERSION",
  "cd /opt/fenix && ls scripts",
  "cd /opt/fenix && cat package.json > /tmp/p.json",
  // a path that only SHARES the prefix is not the tree
  "echo x > /opt/fenix-notes/a",
  "touch /opt/fenixer/a",
  // git in the main checkout and everywhere that is not a child worktree
  "git -C /data/workspaces/linear-agents log --oneline",
  "git -C /data/workspaces/linear-agents worktree list",
  "git -C /data/workspaces/linear-agents diff main..foc-958-dev-x",
  "cd /data/workspaces/linear-agents && git status",
  "git config --global user.email x@y.example",
  "git config --global credential.helper store",
  "git -c core.quotepath=off status",
  `git -C /data/workspaces/la-wt-notes/x log`,
  `git -C ${WT} worktree list`,
  "cd /data/workspaces/linear-agents && git -C ../linear-agents status",
];

test("boundary: every FOC-988 / FOC-1001 spelling asks inside the container, naming its ticket", () => {
  const missed = [];
  for (const [command, ticket, op] of BOUNDARY_ASK) {
    const verdict = classifyDangerous(command, 0, IN_CONTAINER);
    if (!verdict || verdict.ticket !== ticket || verdict.op !== op) {
      missed.push(`${command} → ${verdict ? `${verdict.ticket}/${verdict.op}` : "NO ASK"} (want ${ticket}/${op})`);
    }
  }
  if (missed.length) fail(`missed spellings:\n       ${missed.join("\n       ")}`);
});

test("boundary: benign near-misses stay silent inside the container", () => {
  const falsePositives = [];
  for (const command of BOUNDARY_SILENT) {
    const verdict = classifyDangerous(command, 0, IN_CONTAINER);
    if (verdict) falsePositives.push(`${command} → ${verdict.ticket ?? "FOC-978"}/${verdict.op}`);
  }
  if (falsePositives.length) fail(`false positives:\n       ${falsePositives.join("\n       ")}`);
});

test("boundary: the session cwd counts — git from inside a child worktree asks, from the main checkout does not", () => {
  const inTree = { ...IN_CONTAINER, cwd: `${WT}/linear-agents/foc-958-dev-x` };
  for (const command of ["git status", "git log --oneline", "git push", "git -C . diff", "git -C sub status"]) {
    const verdict = classifyDangerous(command, 0, inTree);
    if (!verdict) fail(`${command} did not ask from inside a child worktree`);
  }
  if (classifyDangerous("git -C /data/workspaces/linear-agents log", 0, inTree)) {
    fail("an explicit -C into the main checkout must override a worktree cwd");
  }
  const inMain = { ...IN_CONTAINER, cwd: "/data/workspaces/linear-agents" };
  if (classifyDangerous("git status", 0, inMain)) fail("git status from the main checkout asked");
});

test("boundary: a configured LA_ROOT / LA_WORKTREE_HOME moves both fences", () => {
  const moved = { container: true, cwd: "/srv", env: { LA_ROOT: "/srv/fenix-code", LA_WORKTREE_HOME: "/srv/wt" } };
  if (!classifyDangerous("echo x > /srv/fenix-code/a", 0, moved)) fail("custom LA_ROOT not honoured");
  if (classifyDangerous("echo x > /opt/fenix/a", 0, moved)) fail("the default LA_ROOT still fenced after override");
  if (!classifyDangerous("git -C /srv/wt/r/b status", 0, moved)) fail("custom LA_WORKTREE_HOME not honoured");
  if (classifyDangerous("git -C /data/workspaces/la-wt/r/b status", 0, moved)) fail("the default worktree root still fenced after override");
});

test("boundary: natively (no container) the same commands are silent — the Supervisor edits its own repo there", () => {
  const native = { container: false, cwd: "/work/repo", env: {} };
  for (const [command, ticket] of BOUNDARY_ASK) {
    const verdict = classifyDangerous(command, 0, native);
    // a push or other FOC-978 op in the command may still ask; the boundary classes must not
    if (verdict && (verdict.ticket === "FOC-988" || verdict.ticket === "FOC-1001")) fail(`${ticket} class fired natively: ${command}`);
  }
  if (classifyDangerous("echo x > /opt/fenix/a")) fail("no ctx at all must keep the FOC-978 behaviour");
});

test("boundary: a FOC-978 op still asks and keeps its own ticket outside the boundary", () => {
  const verdict = classifyDangerous("cd /data/workspaces/linear-agents && git push -u origin x", 0, IN_CONTAINER);
  if (!verdict || verdict.op !== "git push" || verdict.ticket !== undefined) fail(`got ${JSON.stringify(verdict)}`);
});

// ── end-to-end: the real hook process ─────────────────────────────────────────

function runHook(command, { cwd, env = {} } = {}) {
  const payload = JSON.stringify({ tool_name: "Bash", ...(cwd ? { cwd } : {}), tool_input: { command } });
  const childEnv = { ...process.env, FENIX_IN_CONTAINER: "", LA_ROOT: "", LA_WORKTREE_HOME: "", ...env };
  return spawnSync(process.execPath, [GUARD], { input: payload, encoding: "utf8", env: childEnv });
}

function expectAsk(hook, command, expectedOp) {
  if (hook.status !== 0) fail(`hook exited ${hook.status}: ${hook.stderr}`);
  const out = hook.stdout.trim();
  if (!out) fail(`no stdout for: ${command}`);
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    fail(`stdout is not one JSON: ${out}`);
  }
  if (parsed?.hookSpecificOutput?.hookEventName !== "PreToolUse")
    fail(`wrong hookEventName: ${out}`);
  if (parsed?.hookSpecificOutput?.permissionDecision !== "ask")
    fail(`not an ask decision: ${out}`);
  if (!parsed?.hookSpecificOutput?.permissionDecisionReason?.includes(expectedOp))
    fail(`reason does not name ${expectedOp}: ${out}`);
}

function expectSilent(hook, command) {
  if (hook.status !== 0) fail(`hook exited ${hook.status}: ${hook.stderr}`);
  if (hook.stdout.trim()) fail(`hook spoke for a benign command: ${command} → ${hook.stdout}`);
}

test("e2e hook: a gated spelling produces the ask JSON on stdout", () => {
  expectAsk(runHook("git -C /data/workspaces/linear-agents push -u origin feat-x"), "git -C /data/workspaces/linear-agents push -u origin feat-x", "git push");
});

test("e2e hook: a benign command produces no stdout", () => {
  expectSilent(runHook("git -C /r log --oneline"), "git -C /r log --oneline");
});

const CONTAINER_ENV = { FENIX_IN_CONTAINER: "1", LA_ROOT: CODE, LA_WORKTREE_HOME: WT };

test("e2e hook (container): a write into Fenix's own code asks, citing FOC-988, as valid JSON", () => {
  const command = "sed -i 's/a/b/' /opt/fenix/scripts/supervisor-spawn.mjs";
  expectAsk(runHook(command, { cwd: "/data/workspaces", env: CONTAINER_ENV }), command, "FOC-988: write to Fenix's own code");
});

test("e2e hook (container): git config safe.directory asks, citing FOC-1001", () => {
  const command = `git config --global --add safe.directory ${WT}/linear-agents/foc-958-dev-x`;
  expectAsk(runHook(command, { cwd: "/data/workspaces", env: CONTAINER_ENV }), command, "FOC-1001: git safe.directory");
});

test("e2e hook (container): a plain git status from inside a child worktree asks (the session cwd counts)", () => {
  const command = "git status";
  expectAsk(runHook(command, { cwd: `${WT}/linear-agents/foc-958-dev-x`, env: CONTAINER_ENV }), command, "FOC-1001: git in a child worktree");
});

test("e2e hook (container): the main checkout stays silent, push still asks under its own ticket", () => {
  expectSilent(runHook("git -C /data/workspaces/linear-agents log --oneline", { cwd: "/data/workspaces", env: CONTAINER_ENV }), "git log in main");
  expectAsk(runHook("cd /data/workspaces/linear-agents && git push -u origin x", { cwd: "/data/workspaces", env: CONTAINER_ENV }), "git push", "FOC-978: git push");
});

test("e2e hook (native): the boundary classes are silent without FENIX_IN_CONTAINER", () => {
  expectSilent(runHook("sed -i s/a/b/ /opt/fenix/scripts/x.mjs", { cwd: "/work" }), "sed -i /opt/fenix");
  expectSilent(runHook("git config --global --add safe.directory /x", { cwd: "/work" }), "git config safe.directory");
  expectSilent(runHook("git status", { cwd: `${WT}/linear-agents/b` }), "git status in a tree-shaped cwd");
});

// ── summary ────────────────────────────────────────────────────────────────────

console.log(
  `\n  ${passed} passed, ${failures.length} failed` +
    (failures.length ? ` — ${failures.join("; ")}` : "")
);
if (failures.length) process.exit(1);
