// Tests for scripts/permission-rules.mjs — run with: node scripts/test-run.mjs permission-rules
//
// Pins the model of Claude Code's documented permission-rule matching
// (https://code.claude.com/docs/en/permissions, read 2026-10-15) against the
// docs' own example table, the ":*" suffix equivalence, compound-command
// splitting (separators outside quotes, plus $(…) substitutions and (…)
// subshells as extra subcommands), the documented residual (a rule does not
// match a different invocation form), the wildcard forms this repo uses for
// the FOC-511 deny rules, and the PowerShell case-insensitive shape.
//
// Pure unit tests over literal strings — no fs writes, no ports, no socket
// binds, no child processes, no telemetry DB.

import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const { parseRule, matchesBashRule, matchesPowerShellRule, splitSubcommands, isDenied } = await import(
  pathToFileURL(join(__dirname, "permission-rules.mjs")).href
);

// ---------------------------------------------------------------------------
// Test harness (mirrors scripts/egress-screen.test.mjs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

function bashRuleMatches(rule, command) {
  return matchesBashRule(rule, command);
}

// ---------------------------------------------------------------------------
// 1. parseRule
// ---------------------------------------------------------------------------

console.log("parseRule: tool/pattern extraction");
{
  assert(JSON.stringify(parseRule("Bash(npm run build)")) === JSON.stringify({ tool: "Bash", pattern: "npm run build" }), "Bash(npm run build) parses");
  assert(JSON.stringify(parseRule("Bash")) === JSON.stringify({ tool: "Bash", pattern: "*" }), "bare Bash → pattern *");
  assert(JSON.stringify(parseRule("PowerShell(Remove-Item *)")) === JSON.stringify({ tool: "PowerShell", pattern: "Remove-Item *" }), "PowerShell rule parses");
  assert(JSON.stringify(parseRule("Bash(ls:*)")) === JSON.stringify({ tool: "Bash", pattern: "ls *" }), ":* suffix becomes a trailing space-star");
  assert(JSON.stringify(parseRule("Bash(git:* push)")) === JSON.stringify({ tool: "Bash", pattern: "git:* push" }), "a colon anywhere else stays literal");
}

// ---------------------------------------------------------------------------
// 2. The docs' example table, row by row (Bash)
// ---------------------------------------------------------------------------

console.log("docs table: Bash rule examples");
{
  const rows = [
    // [rule, [commands that MATCH], [commands that DO NOT match]]
    ["Bash(npm run build)", ["npm run build"], ["npm run build --watch"]],
    ["Bash(npm run *)", ["npm run build", "npm run test --watch", "npm run"], ["npm install"]],
    ["Bash(git log * main)", ["git log --oneline main", "git log -5 main"], ["git log main", "git push origin main"]],
    ["Bash(git * main)", ["git merge main", "git push origin main", "git -c core.fsmonitor=x diff main"], ["git log"]],
    ["Bash(* --version)", ["node --version", "bash -c 'echo hi' --version"], ["node -v"]],
    ["Bash(ls *)", ["ls -la", "ls"], ["lsof"]],
    ["Bash(ls*)", ["ls -la", "lsof"], [""]],
    ["Bash(* --help *)", ["npm --help x"], ["npm --help"]],
  ];
  for (const [rule, yes, no] of rows) {
    for (const cmd of yes) assert(bashRuleMatches(rule, cmd), `${rule} matches ${JSON.stringify(cmd)}`);
    for (const cmd of no) assert(!bashRuleMatches(rule, cmd), `${rule} does NOT match ${JSON.stringify(cmd)}`);
  }
}

// ---------------------------------------------------------------------------
// 3. ":*" suffix equivalence
// ---------------------------------------------------------------------------

console.log("colon-star: ls:* behaves exactly like ls *");
{
  for (const rule of ["Bash(ls:*)", "Bash(ls *)"]) {
    assert(bashRuleMatches(rule, "ls -la"), `${rule} matches "ls -la"`);
    assert(bashRuleMatches(rule, "ls"), `${rule} matches the bare "ls" (trailing space-star special case)`);
    assert(!bashRuleMatches(rule, "lsof"), `${rule} does not match "lsof"`);
  }
  const colonRule = "Bash(git:* push)";
  assert(!bashRuleMatches(colonRule, "git push"), "a non-terminal colon is LITERAL: git:* push does not match git push");
  assert(bashRuleMatches(colonRule, "git:* push"), "git:* push still matches the exact literal text");
}

// ---------------------------------------------------------------------------
// 4. Compound commands: separators, quotes, substitutions, subshells
// ---------------------------------------------------------------------------

console.log("split: separators outside quotes, $(…)/(…) interiors as extra pieces");
{
  assert(JSON.stringify(splitSubcommands("cd /tmp && git clean -f")) === JSON.stringify(["cd /tmp", "git clean -f"]), "&& splits into two pieces");
  assert(JSON.stringify(splitSubcommands("a || b; c | d & e")) === JSON.stringify(["a", "b", "c", "d", "e"]), "||, ;, |, & all split");
  assert(JSON.stringify(splitSubcommands("one")) === JSON.stringify(["one"]), "a single command is one piece");
  assert(JSON.stringify(splitSubcommands("a && ")) === JSON.stringify(["a"]), "empties are dropped");
  assert(JSON.stringify(splitSubcommands("a\nb\rc")) === JSON.stringify(["a", "b", "c"]), "newlines (\\n, \\r) split");
}

console.log("split: quotes protect separators");
{
  assert(JSON.stringify(splitSubcommands('echo "a && b"')) === JSON.stringify(['echo "a && b"']), "double quotes protect &&");
  assert(JSON.stringify(splitSubcommands("echo 'a | b'")) === JSON.stringify(["echo 'a | b'"]), "single quotes protect |");
  assert(JSON.stringify(splitSubcommands('echo "a && b" && c')) === JSON.stringify(['echo "a && b"', "c"]), "separators outside the quotes still split");
}

console.log("split: $(…) substitutions and (…) subshells are split out");
{
  assert(JSON.stringify(splitSubcommands('echo "$(git clean -f)"')) === JSON.stringify(['echo "$(git clean -f)"', "git clean -f"]), "the inside of a $(…) is an extra piece (even inside double quotes)");
  assert(JSON.stringify(splitSubcommands("echo $(cd there && ls)")) === JSON.stringify(["echo $(cd there && ls)", "cd there", "ls"]), "a $(…) interior is split recursively");
  assert(JSON.stringify(splitSubcommands("(cd /tmp && git clean -f)")) === JSON.stringify(["(cd /tmp && git clean -f)", "cd /tmp", "git clean -f"]), "a subshell's interior is split out");
  assert(JSON.stringify(splitSubcommands("echo 'no $(sub) here'")) === JSON.stringify(["echo 'no $(sub) here'"]), "single quotes protect a $(…) (the shell would not execute it)");
}

// ---------------------------------------------------------------------------
// 5. isDenied: first matching rule of the tool wins
// ---------------------------------------------------------------------------

console.log("isDenied: deny across compound commands and substitutions");
{
  const r1 = isDenied(["Bash(git clean *)"], "Bash", "cd /tmp && git clean -f");
  assert(r1.denied === true, "compound command is denied");
  assert(r1.rule === "Bash(git clean *)", "the winning rule is reported");
  assert(r1.subcommand === "git clean -f", "the matching subcommand is reported");
  assert(isDenied([], "Bash", "git clean -f").denied === false, "empty deny list → not denied");
  assert(JSON.stringify(isDenied(["Bash(git clean *)"], "Bash", "git status")) === JSON.stringify({ denied: false }), "clean command → { denied: false } only");

  const r2 = isDenied(["Bash(git clean *)"], "Bash", 'echo "$(git clean -f)"');
  assert(r2.denied === true && r2.subcommand === "git clean -f", "a deny inside a $(…) substitution is visible");

  // "Bash(safe-cmd *)" does not match "safe-cmd && other-cmd" as a whole —
  // the pieces are separated first.
  assert(!bashRuleMatches("Bash(safe-cmd *)", "safe-cmd && other-cmd"), "a whole compound command is not matched by one piece's rule");
  const r3 = isDenied(["Bash(safe-cmd *)"], "Bash", "safe-cmd && other-cmd");
  assert(r3.denied === true && r3.subcommand === "safe-cmd", "split first: safe-cmd piece matches, other-cmd is reported separately");
  const r4 = isDenied(["Bash(other-cmd)"], "Bash", "safe-cmd && other-cmd");
  assert(r4.subcommand === "other-cmd", "the second piece can be the denied one");

  const r5 = isDenied(["Bash(git clean *)", "Bash(git *)"], "Bash", "git clean -f");
  assert(r5.rule === "Bash(git clean *)", "the FIRST matching rule wins");
  assert(isDenied(["PowerShell(Remove-Item *)"], "Bash", "Remove-Item x").denied === false, "a PowerShell rule is ignored for Bash");
  assert(isDenied(["Bash(rm *)"], "PowerShell", "rm x").denied === false, "a Bash rule is ignored for PowerShell");
}

// ---------------------------------------------------------------------------
// 6. Documented limits: a rule does not match a different invocation form
// ---------------------------------------------------------------------------

console.log("residual: different invocation forms are not matched (the doc's own caveat)");
{
  assert(!bashRuleMatches("Bash(git push *)", "git -C . push origin main"), "a leading flag breaks the prefix: git push * does not match");
  assert(!bashRuleMatches("Bash(git push *)", "git -c push.default=current push origin main"), "a leading -c assignment breaks the prefix: git push * does not match");
  assert(!bashRuleMatches("Bash(git push *)", "sh -c 'git push origin main'"), "sh -c wrapping is not matched");
  assert(!bashRuleMatches("Bash(npm run build)", "/usr/bin/npm run build"), "an absolute binary path is a different text");
}

// ---------------------------------------------------------------------------
// 6b. Whole-text matching vs compound text (resolved doc ambiguity)
// ---------------------------------------------------------------------------

console.log("whole-text: rules apply to single commands, never to a compound text");
{
  assert(bashRuleMatches("Bash(git log * main)", "git log $(whoami) main"), "a $(…) substitution inside ONE command stays opaque: the whole text still matches");
  assert(!bashRuleMatches("Bash(git log * main)", "git log main && echo x"), "a top-level && makes the text compound: the whole text never matches (isDenied splits first)");
}

// ---------------------------------------------------------------------------
// 7. The wildcard forms this repo uses (FOC-511 deny rules)
// ---------------------------------------------------------------------------

console.log("repo forms: Bash(node *linear-ops.mjs*)");
{
  const rule = "Bash(node *linear-ops.mjs*)";
  for (const cmd of [
    "node scripts/linear-ops.mjs transition FOC-1 Done",
    "node C:/Users/x/scripts/linear-ops.mjs comment FOC-1",
    "node $LA_ROOT/scripts/linear-ops.mjs comment",
  ]) {
    assert(bashRuleMatches(rule, cmd), `${rule} matches ${JSON.stringify(cmd)}`);
  }
  for (const cmd of [
    "node --test scripts/linear-ops.test.mjs",
    "cat scripts/linear-ops.mjs",
    "node scripts/test-run.mjs linear-ops",
  ]) {
    assert(!bashRuleMatches(rule, cmd), `${rule} does NOT match ${JSON.stringify(cmd)}`);
  }
}

// ---------------------------------------------------------------------------
// 7b. `*` spans newlines: a quoted newline stays inside ONE subcommand
// ---------------------------------------------------------------------------

console.log("repo forms: a quoted newline does not split the subcommand");
{
  const rule = "Bash(node *linear-ops.mjs*)";
  const cmd = "node scripts/linear-ops.mjs --body 'a\nb'";
  assert(bashRuleMatches(rule, cmd), `${rule} matches a command with a quoted newline in one argument`);
  const r = isDenied([rule], "Bash", cmd);
  assert(r.denied === true, "isDenied reports the quoted-newline command denied");
  assert(r.subcommand === cmd, "the quoted newline must not split the subcommand");
}

// ---------------------------------------------------------------------------
// 8. PowerShell: same shape, case-insensitive
// ---------------------------------------------------------------------------

console.log("powershell: case-insensitive matching, same wildcard shape");
{
  const rule = "PowerShell(node *linear-ops.mjs*)";
  assert(matchesPowerShellRule(rule, "Node scripts\\linear-ops.mjs Transition FOC-1 Done"), "mixed-case PowerShell command matches (case-insensitive)");
  assert(matchesPowerShellRule(rule, "node scripts\\linear-ops.mjs Transition FOC-1 Done"), "exact-case PowerShell command matches");
  assert(!matchesPowerShellRule("PowerShell(Remove-Item *)", "Get-ChildItem"), "Remove-Item * does not match Get-ChildItem");
  assert(matchesPowerShellRule("PowerShell(Remove-Item *)", "remove-item x"), "the rule side is case-insensitive too");
  assert(!matchesPowerShellRule(rule, "node --test scripts\\linear-ops.test.mjs"), "the Bash negatives carry over to PowerShell");
  const r = isDenied(["PowerShell(node *linear-ops.mjs*)"], "PowerShell", "Get-Item; Node scripts\\linear-ops.mjs comment FOC-1");
  assert(r.denied === true && r.subcommand === "Node scripts\\linear-ops.mjs comment FOC-1", "PowerShell compounds split on |, ;, &&, ||  (no bare &, no subst extraction)");
  // A bare `&` does NOT split PowerShell pieces: the tail is a matching
  // command form, so only the un-split whole text keeps this out of the deny.
  assert(isDenied(["PowerShell(node *linear-ops.mjs*)"], "PowerShell", "Get-Item & node C:/x/linear-ops.mjs comment").denied === false, "a bare & does not split PowerShell pieces (documented model limitation)");
}

// ---------------------------------------------------------------------------
console.log(`\n${passed}/${passed + failed} assertions passed.`);
if (failed > 0) process.exit(1);