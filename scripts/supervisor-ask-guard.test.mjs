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

// ── end-to-end: the real hook process ─────────────────────────────────────────

function runHook(command) {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
  return spawnSync(process.execPath, [GUARD], { input: payload, encoding: "utf8" });
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

// ── summary ────────────────────────────────────────────────────────────────────

console.log(
  `\n  ${passed} passed, ${failures.length} failed` +
    (failures.length ? ` — ${failures.join("; ")}` : "")
);
if (failures.length) process.exit(1);
