// scripts/supervisor-wait-budget.test.mjs — the mechanical proxy for FOC-608
// AC2: the Supervisor completes a run without any in-turn wait longer than
// 120 s. A full run cannot be executed from a test, so this pins the two things
// a wait chain needs to come back:
//
//   (a) no `--wait`/`--timeout-ms` duration above 120 000 ms anywhere in
//       agents/supervisor/** or scripts/supervisor-*.mjs defaults that would
//       drive a run — a wait budget the model cannot exceed in one turn;
//   (b) the documented Monitor loop (agents/supervisor/CLAUDE.md §4) contains
//       no in-turn wait chain: no backoff re-issue ladder, and the loop is
//       drain → handle → ack.
//
// The poll BASE (LA_SUPERVISOR_POLL_MS, default 120_000) is the one allowed
// duration; the stall SLA (5 × base) is deliberately out of scope — it is a
// kill threshold the watcher owns, not a wait the model performs.
//
// TEST-r1 carve-out: a minimal NAMED allowlist (NON_WAIT_TIMEOUTS below)
// exempts individual constants that are subprocess kill-timeouts, not waits
// the spawn blocks on. The default posture is unchanged — any *TIMEOUT_MS
// constant above 120 000 that is not on the allowlist still fails.
//
// FOC-1156: the *_KILL_MS suffix is the standing kill-timeout naming
// convention — a constant so named is exempt by its name (it is a subprocess
// kill-timeout by construction), so the next kill-timeout constant needs no
// allowlist edit. An unlisted *TIMEOUT_MS above the bound still fails.
//
// Run: node scripts/supervisor-wait-budget.test.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  DEPS_INSTALL_TIMEOUT_MS,
  INSTALL_KILL_GRACE_MS,
  pollBaseMs,
} from "./supervisor-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUPERVISOR_AGENTS_DIR = join(ROOT, "agents", "supervisor");
const SCRIPTS_DIR = join(ROOT, "scripts");
const MAX_IN_TURN_WAIT_MS = 120_000;

const MONITOR_START = "### 4. Monitor";

function filesUnder(dir, extensions, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) filesUnder(path, extensions, out);
    else if (extensions.has(entry.split(".").pop())) out.push(path);
  }
  return out;
}

// Extract `--timeout-ms <n>` / `--wait ... <n>` literals (underscores allowed)
// and uppercase duration constants that drive waits. The background-wait
// ceiling (PRINT_BG_WAIT_CEILING_MS, a child-env value) and the stall SLA are
// NOT in-turn waits and are excluded by name.
//
// Constants named in NON_WAIT_TIMEOUTS are exempt: each is a kill-timeout on
// a subprocess, not a re-issued poll/wait loop, and each entry carries the
// reason. The scan scope and the 120 000 ms bound are untouched.
//
// FOC-1156 record correction: the deps install IS awaited — the Supervisor's
// Bash call waits for it, bounded at the DEPS_INSTALL_TIMEOUT_MS + kill-grace
// constants (derived below, not hardcoded), and Claude Code moves an over-time
// call to the background rather than killing it. The block on the child launch
// stays; only the old "not an in-turn wait" wording was wrong.
const DEPS_INSTALL_BOUND = `${DEPS_INSTALL_TIMEOUT_MS / 1000} s + ${INSTALL_KILL_GRACE_MS / 1000} s`;
const NON_WAIT_TIMEOUTS = new Map([
  [
    "DEPS_INSTALL_TIMEOUT_MS",
    `subprocess kill-timeout for worktree deps install (FOC-1153); the Supervisor's Bash call waits for it, bounded at ${DEPS_INSTALL_BOUND} kill grace, and Claude Code moves an over-time call to the background rather than killing it (FOC-1156)`,
  ],
]);

function inTurnWaitViolations(src) {
  const violations = [];
  for (const m of src.matchAll(/--timeout-ms[^0-9\n]{0,40}([0-9][0-9_]*)/gi)) {
    if (Number(m[1].replace(/_/g, "")) > MAX_IN_TURN_WAIT_MS) violations.push(m[0].trim());
  }
  for (const m of src.matchAll(/--wait[^0-9\n]{0,60}([0-9]{4,}[0-9_]*)/gi)) {
    if (Number(m[1].replace(/_/g, "")) > MAX_IN_TURN_WAIT_MS) violations.push(m[0].trim());
  }
  for (const m of src.matchAll(/\b([A-Z_]*(?:TIMEOUT_MS|POLL_MS|WAIT_MS|KILL_MS)[A-Z_]*)\s*=\s*([0-9][0-9_]*)/g)) {
    if (Number(m[2].replace(/_/g, "")) <= MAX_IN_TURN_WAIT_MS) continue;
    // FOC-1156: the *_KILL_MS suffix is the standing kill-timeout naming
    // convention — a constant so named is a subprocess kill-timeout by
    // construction, not a wait, so the name itself is the allowance and the
    // next kill-timeout constant needs no allowlist edit.
    if (m[1].endsWith("_KILL_MS")) continue;
    if (NON_WAIT_TIMEOUTS.has(m[1])) continue; // documented carve-out, reasons above
    violations.push(m[0].trim());
  }
  return violations;
}

const docFiles = filesUnder(SUPERVISOR_AGENTS_DIR, new Set(["md", "json"]));
const scriptFiles = readdirSync(SCRIPTS_DIR)
  .filter((f) => /^supervisor-.*\.mjs$/.test(f))
  .map((f) => join(SCRIPTS_DIR, f));

describe("FOC-608 AC2 — no in-turn wait above 120 s drives a run", () => {
  it("the poll base default is at most 120000 ms", () => {
    assert.ok(
      pollBaseMs() > 0 && pollBaseMs() <= MAX_IN_TURN_WAIT_MS,
      `LA_SUPERVISOR_POLL_MS default must be in (0, 120000], got ${pollBaseMs()}`,
    );
  });

  for (const file of [...docFiles, ...scriptFiles]) {
    it(`no >120 s wait literal in ${file.slice(ROOT.length + 1)}`, () => {
      const violations = inTurnWaitViolations(readFileSync(file, "utf8"));
      assert.deepEqual(violations, [], `waits above ${MAX_IN_TURN_WAIT_MS} ms found`);
    });
  }
});

// TEST-r1: pin the carve-out's edges. The allowlist is named-and-reasoned, and
// the guard's default posture — any NEW >120_000 *TIMEOUT_MS literal fails —
// must hold for everything not on it. Checked against inline source so no
// scratch fixture has to be created or cleaned up.
describe("FOC-608 AC2 — the >120 s constant allowlist stays minimal (TEST-r1)", () => {
  it("the carve-out covers exactly the named constant", () => {
    const src = "const DEPS_INSTALL_TIMEOUT_MS = 300_000;";
    assert.deepEqual(
      inTurnWaitViolations(src),
      [],
      "the allowlisted kill-timeout must not fail the guard",
    );
  });

  it("an UNlisted >120 s TIMEOUT_MS constant still fails the guard", () => {
    // Name assembled so this file's own scan (we live under scripts/supervisor-*.mjs)
    // does not trip on a real >120_000 literal sitting in test source.
    const name = ["SOME_OTHER", "TIMEOUT_MS"].join("_");
    const src = `const ${name} = 300_000;`;
    assert.deepEqual(
      inTurnWaitViolations(src).map((v) => v.includes(name)),
      [true],
      "the default posture (any new >120_000 *TIMEOUT_MS fails) must hold",
    );
  });

  it("every allowlist entry carries a non-empty reason", () => {
    for (const [name, reason] of NON_WAIT_TIMEOUTS) {
      assert.ok(reason.trim().length > 0, `allowlist entry ${name} needs a reason`);
    }
  });

  it("the deps-install carve-out reason names the wait bound and the background-move behavior (FOC-1156)", () => {
    // FOC-1156 record correction: the old reason said the install is "not an
    // in-turn wait", which is wrong — the Supervisor's Bash call DOES wait for
    // it. The reason must say plainly that the wait happens, what bounds it,
    // and why nothing is lost when it runs long.
    const reason = NON_WAIT_TIMEOUTS.get("DEPS_INSTALL_TIMEOUT_MS") ?? "";
    assert.match(
      reason,
      new RegExp(`${DEPS_INSTALL_TIMEOUT_MS / 1000} s \\+ ${INSTALL_KILL_GRACE_MS / 1000} s`),
      "the reason must state the install's bound (derived from the lib constants)",
    );
    assert.match(reason, /background/, "the reason must state Claude Code's over-time background-move");
    assert.doesNotMatch(reason, /not an in-turn wait/, "the corrected record must not repeat the inaccurate claim");
  });

  it("a *_KILL_MS kill-timeout constant needs no allowlist entry (FOC-1156 naming convention)", () => {
    // Name assembled so this file's own scan does not trip on it, as above.
    const name = ["NEXT_THING", "KILL_MS"].join("_");
    const src = `const ${name} = 300_000;`;
    assert.deepEqual(
      inTurnWaitViolations(src),
      [],
      "the *_KILL_MS suffix is the standing kill-timeout allowance — no allowlist edit needed",
    );
  });
});

describe("FOC-608 AC2 — the Monitor loop is drain, not a wait chain", () => {
  const claudeMd = readFileSync(join(SUPERVISOR_AGENTS_DIR, "CLAUDE.md"), "utf8");
  const start = claudeMd.indexOf(MONITOR_START);
  const next = claudeMd.indexOf("\n### ", start + 1);
  const section = claudeMd.slice(start, next === -1 ? undefined : next);

  it("the Monitor section exists", () => {
    assert.ok(start !== -1, `no "${MONITOR_START}" section in agents/supervisor/CLAUDE.md`);
  });

  it("contains no backoff re-issue ladder", () => {
    assert.doesNotMatch(section, /re-?issue[^.\n]*backoff/i, "the ×1/×2/×4 re-issue ladder is back");
    assert.doesNotMatch(section, /[×x]\s*1[,/ ]+[×x]\s*2/i, "the ×1/×2/×4 ladder is back");
  });

  it("is the drain loop: drain at the start of a turn, then ack", () => {
    assert.match(section, /--drain/, "the loop must start with a drain of the wake queue");
    assert.match(section, /--ack/, "handled rows must be acked");
  });

  it("bounds the remaining --wait at 120 s", () => {
    assert.match(section, /120[ _]?000|120\s*s/, "the short bounded wait must be stated (≤ 120 s)");
  });
});
