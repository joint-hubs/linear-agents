// scripts/launcher-wrappers.test.mjs — FOC-771: every squad .bat is a two-line wrapper.
//
// The squad launchers used to own the whole startup sequence in cmd (model lines,
// provider env, kickoffs). That moved to scripts/squad-start.mjs, so each
// bin/<squad>.bat must now be exactly: @echo off, optional REM history, one node
// line forwarding %* to squad-start.mjs with the right static flags, and an exit
// code pass-through — plus, for the supervisor wrappers only, the FOC-172
// `set "LA_SUPERVISOR_REPO=%CD%"` capture line. Any drift back to real logic in
// cmd would silently fork the startup path away from the Node entry point (the
// bug this ticket exists for).
//
// Also pins: no .bat outside the Windows-tooling allowlist sets ANTHROPIC_MODEL or
// calls _lib.bat any more, and bin/orchestrate.bat stays deleted (FOC-288/FOC-771).
//
// Run: node scripts/launcher-wrappers.test.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin");

// file -> the exact args the node line must pass after squad-start.mjs
const WRAPPERS = {
  "plan.bat": "plan %*",
  "dev.bat": "dev %*",
  "review.bat": "review %*",
  "test.bat": "test %*",
  "cadence.bat": "cadence %*",
  "supervisor.bat": "supervisor %*",
  "plan-dry.bat": "plan --dry-run %*",
  "dev-dry.bat": "dev --dry-run %*",
  "review-dry.bat": "review --dry-run %*",
  "test-dry.bat": "test --dry-run %*",
  "cadence-dry.bat": "cadence --dry-run %*",
  "plan-native.bat": "plan --native %*",
  "supervisor-native.bat": "supervisor --native %*",
  "agent.bat": "--agent %*", // %* starts with <area> <role>, the rest are claude args
};

// .bat files that are NOT squad wrappers and may still carry real cmd logic.
const ALLOWLIST = ["_lib.bat", "all.bat", "orchestrate-openrouter.bat"];

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
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// ── 1. Two-line shape + static flags ──────────────────────────────────────────
console.log("\nwrapper shape");

for (const [file, expectedArgs] of Object.entries(WRAPPERS)) {
  test(`${file} -> squad-start.mjs ${expectedArgs}`, () => {
    const lines = read(`bin/${file}`).split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines[0] !== "@echo off") fail(`first line must be '@echo off', got: ${lines[0]}`);
    // Supervisor wrappers may carry exactly one extra line: the FOC-172
    // defence-in-depth capture of the launch cwd, before the node entry point.
    const supervisor = file.startsWith("supervisor");
    const code = lines.filter(
      (l) => !l.startsWith("REM") && !(supervisor && l === 'set "LA_SUPERVISOR_REPO=%CD%"'),
    );
    if (code.length !== 3) {
      fail(`expected @echo off + 1 node line + exit /b (comments aside), got ${code.length} code lines:\n       ${code.join("\n       ")}`);
    }
    const nodeLine = code[1];
    const m = nodeLine.match(
      /^node --disable-warning=ExperimentalWarning "%~dp0\.\.\\scripts\\squad-start\.mjs" (.+)$/,
    );
    if (!m) {
      fail(
        `node line must call squad-start.mjs with --disable-warning=ExperimentalWarning ` +
          `(FOC-1055 — keep node:sqlite's ExperimentalWarning out of the operator's terminal): ${nodeLine}`,
      );
    }
    if (m[1] !== expectedArgs) fail(`flags drift: expected "${expectedArgs}", got "${m[1]}"`);
    if (!m[1].endsWith("%*")) fail(`user args (%*) not forwarded: ${nodeLine}`);
    if (code[2] !== "exit /b %errorlevel%") fail(`exit code pass-through missing: ${code[2]}`);
  });
}

// ── 2. No launcher logic left in cmd outside the allowlist ────────────────────
console.log("\nno launcher logic in cmd");

test("no .bat outside the allowlist sets ANTHROPIC_MODEL or calls _lib.bat", () => {
  const bad = [];
  for (const f of readdirSync(BIN).filter((f) => f.endsWith(".bat"))) {
    if (ALLOWLIST.includes(f) || f.startsWith("dashboard")) continue;
    const text = read(`bin/${f}`);
    if (/ANTHROPIC_MODEL/i.test(text)) bad.push(`${f}: sets ANTHROPIC_MODEL`);
    if (/_lib\.bat/i.test(text)) bad.push(`${f}: calls _lib.bat`);
  }
  if (bad.length) fail(`logic back in cmd:\n       ${bad.join("\n       ")}`);
});

test("bin/orchestrate.bat stays deleted (FOC-288 withdrawal, FOC-771 removal)", () => {
  if (existsSync(join(BIN, "orchestrate.bat"))) fail("orchestrate.bat is back in bin/");
});

// ── 3. Live check: the wrapper reaches squad-start.mjs through cmd ────────────
console.log("\nspawn (Windows only)");

const isWindows = process.platform === "win32";
const squadStart = join(ROOT, "scripts", "squad-start.mjs");

if (!isWindows) {
  console.log("  SKIP live cmd run (not win32) — the .bat wrappers are Windows-only");
} else if (!existsSync(squadStart)) {
  console.log("  SKIP live cmd run (scripts/squad-start.mjs not on disk yet — FOC-771's other worker owns it)");
} else {
  test("cmd /c bin\\dev.bat --print-plan runs the Node entry point", () => {
    // --print-plan is the pure probe: prints the plan as JSON and exits 0,
    // before any manifest/env side effect.
    const r = spawnSync("cmd", ["/c", "bin\\dev.bat", "--print-plan"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30000,
      shell: false,
    });
    if (r.status !== 0) {
      fail(`exit ${r.status}\n       stdout: ${r.stdout}\n       stderr: ${r.stderr}`);
    }
    const out = r.stdout ?? "";
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start === -1 || end <= start) fail(`no JSON plan on stdout:\n       ${out}`);
    try { JSON.parse(out.slice(start, end + 1)); } catch { fail(`--print-plan output is not JSON:\n       ${out}`); }
  });
}

// ── summary ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(`\nOK: ${passed} checks passed`);
