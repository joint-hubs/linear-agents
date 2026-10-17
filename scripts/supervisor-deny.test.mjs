// Tests for SUPERVISOR_DENY under the documented matcher semantics — run with:
// node scripts/test-run.mjs supervisor-deny
//
// FOC-511 regression test: this file proves the deny LIST, evaluated through
// the model of Claude Code's documented permission-rule matching in
// scripts/permission-rules.mjs. Claude Code itself is the enforcer at runtime;
// P9 in supervisor-spawn.test.mjs proves the list reaches every child's
// settings file.
//
// Covered here: every helper script (linear-ops, publish-linear-comment,
// linear-query, linear-push, gh-screened) is denied in launcher, relative,
// absolute POSIX, absolute Windows (both slash directions), compound
// (`cd x && …`), substitution (`echo "$(…)"`) and bare `node scripts/<x>`
// forms, under both the Bash and the PowerShell tool — while reads and the
// test runner stay allowed. The documented residuals (`sh -c '…'`,
// `git -C . push`) are asserted NOT denied, so the test states the limit
// honestly: sandboxing or a PreToolUse hook is the boundary there, not this
// list.
//
// Pure unit tests over literal strings — no fs writes, no ports, no socket
// binds, no child processes, no telemetry DB.

import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const { isDenied } = await import(
  pathToFileURL(join(__dirname, "permission-rules.mjs")).href
);
const { SUPERVISOR_DENY } = await import(
  pathToFileURL(join(__dirname, "supervisor-lib.mjs")).href
);

// ---------------------------------------------------------------------------
// Test harness (mirrors scripts/permission-rules.test.mjs)
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

// ---------------------------------------------------------------------------
// 1. Every helper script, every invocation form, is denied
// ---------------------------------------------------------------------------

const SCRIPTS = [
  "linear-ops.mjs",
  "publish-linear-comment.mjs",
  "linear-query.mjs",
  "linear-push.mjs",
  "gh-screened.mjs",
];

// Simple (single-subcommand) Bash forms. `{S}` is replaced with the script.
const bashForms = [
  ["launcher form", "node $LA_ROOT/scripts/{S} transition FOC-1 Done"],
  ["relative path", "node scripts/{S} comment FOC-1 --body x"],
  ["absolute POSIX", "node /home/u/linear-agents/scripts/{S} comment FOC-1"],
  ["absolute Windows (forward slashes)", "node C:/Users/u/Documents/GitHub/linear-agents/scripts/{S} comment FOC-1"],
  ["absolute Windows (backslashes)", "node C:\\Users\\u\\scripts\\{S} comment FOC-1"],
  ["bare, no arguments", "node scripts/{S}"],
];

console.log("FOC-511: SUPERVISOR_DENY denies every invocation form of every helper");
for (const script of SCRIPTS) {
  for (const [label, tmpl] of bashForms) {
    const cmd = tmpl.replaceAll("{S}", script);
    const r = isDenied(SUPERVISOR_DENY, "Bash", cmd);
    assert(r.denied === true, `${script}: ${label} denied by ${r.rule} — ${JSON.stringify(cmd)}`);
  }

  // Compound: the deny applies to the node subcommand, which is the one reported.
  {
    const cmd = `cd /tmp/x && node scripts/${script} transition FOC-1 Done`;
    const r = isDenied(SUPERVISOR_DENY, "Bash", cmd);
    assert(r.denied === true, `${script}: compound (cd x && node …) denied by ${r.rule}`);
    assert(r.subcommand === `node scripts/${script} transition FOC-1 Done`, `${script}: compound reports the node subcommand`);
  }

  // Inside a $(…) substitution the deny must stay visible.
  {
    const cmd = `echo "$(node scripts/${script} transition FOC-1 Done)"`;
    const r = isDenied(SUPERVISOR_DENY, "Bash", cmd);
    assert(r.denied === true, `${script}: inside a $(…) substitution denied by ${r.rule}`);
    assert(r.subcommand === `node scripts/${script} transition FOC-1 Done`, `${script}: substitution reports the inner node subcommand`);
  }

  // PowerShell: same wildcard shape, case-insensitive.
  const psForms = [
    ["PowerShell plain", `node scripts/${script.replace(/\//g, "\\")} Transition FOC-1 Done`],
    ["PowerShell mixed case", `Node .\\scripts\\${script} transition FOC-1 Done`],
  ];
  for (const [label, cmd] of psForms) {
    const r = isDenied(SUPERVISOR_DENY, "PowerShell", cmd);
    assert(r.denied === true, `${script}: ${label} denied by ${r.rule} — ${JSON.stringify(cmd)}`);
  }
  {
    const cmd = `Set-Location C:\\x; node scripts\\${script} comment FOC-1`;
    const r = isDenied(SUPERVISOR_DENY, "PowerShell", cmd);
    assert(r.denied === true, `${script}: PowerShell compound (Set-Location …; node …) denied by ${r.rule}`);
    assert(r.subcommand === `node scripts\\${script} comment FOC-1`, `${script}: PowerShell compound reports the node subcommand`);
  }
}

// ---------------------------------------------------------------------------
// 2. Negatives: reads and the test runner stay allowed
// ---------------------------------------------------------------------------

console.log("FOC-511: the `node ` prefix keeps reads and the test runner outside the rule");
for (const cmd of [
  "node --test scripts/linear-ops.test.mjs",
  "node scripts/test-run.mjs linear-ops",
  "cat scripts/linear-ops.mjs",
  "git diff -- scripts/linear-ops.mjs",
  "grep -n assertEgressClean scripts/linear-ops.mjs",
  "node scripts/egress-screen.mjs check --body-file x.md",
  "gh pr view 76",
]) {
  assert(isDenied(SUPERVISOR_DENY, "Bash", cmd).denied === false, `allowed: ${cmd}`);
}

// ---------------------------------------------------------------------------
// 3. Documented residual: a different invocation form is NOT matched
// ---------------------------------------------------------------------------

console.log("residual: wrapper forms walk past the list (sandboxing / PreToolUse is the boundary there)");
{
  // `Bash(node *linear-ops.mjs*)` requires the command to START with `node `;
  // `sh -c '…'` starts with `sh`, so the rule cannot fire. Asserted NOT denied
  // on purpose — this documents the limit honestly instead of hiding it.
  const cmd = "sh -c 'node scripts/linear-ops.mjs transition FOC-1 Done'";
  const r = isDenied(SUPERVISOR_DENY, "Bash", cmd);
  assert(r.denied === false, `residual NOT denied (covered by sandboxing/PreToolUse, not this list): ${cmd}`);
}

// ---------------------------------------------------------------------------
// 4. The git/gh prefix denies still hold (and their documented residual)
// ---------------------------------------------------------------------------

console.log("git/gh prefix denies");
for (const cmd of [
  "git push origin main",
  "gh pr create --title x --body y",
  "gh api repos/x/pulls",
  "git worktree remove ../x",
]) {
  const r = isDenied(SUPERVISOR_DENY, "Bash", cmd);
  assert(r.denied === true, `denied by ${r.rule}: ${cmd}`);
}
assert(
  isDenied(SUPERVISOR_DENY, "Bash", "git -C . push origin main").denied === false,
  "residual NOT denied (documented): git -C . push origin main",
);

// ---------------------------------------------------------------------------
console.log(`\n${passed}/${passed + failed} assertions passed.`);
if (failed > 0) process.exit(1);
