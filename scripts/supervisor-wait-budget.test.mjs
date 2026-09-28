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
// Run: node scripts/supervisor-wait-budget.test.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { pollBaseMs } from "./supervisor-lib.mjs";

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
function inTurnWaitViolations(src) {
  const violations = [];
  for (const m of src.matchAll(/--timeout-ms[^0-9\n]{0,40}([0-9][0-9_]*)/gi)) {
    if (Number(m[1].replace(/_/g, "")) > MAX_IN_TURN_WAIT_MS) violations.push(m[0].trim());
  }
  for (const m of src.matchAll(/--wait[^0-9\n]{0,60}([0-9]{4,}[0-9_]*)/gi)) {
    if (Number(m[1].replace(/_/g, "")) > MAX_IN_TURN_WAIT_MS) violations.push(m[0].trim());
  }
  for (const m of src.matchAll(/\b[A-Z_]*(?:TIMEOUT_MS|POLL_MS|WAIT_MS)[A-Z_]*\s*=\s*([0-9][0-9_]*)/g)) {
    if (Number(m[1].replace(/_/g, "")) > MAX_IN_TURN_WAIT_MS) violations.push(m[0].trim());
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
