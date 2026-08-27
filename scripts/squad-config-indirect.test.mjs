// scripts/squad-config-indirect.test.mjs — a launcher that routes its model
// through its own variable.
//
// bin/supervisor.bat does this:
//
//     if defined NATIVE (
//         if not defined SUPERVISOR_MODEL set "SUPERVISOR_MODEL=claude-opus-4-8"
//     ) else (
//         if not defined SUPERVISOR_MODEL set "SUPERVISOR_MODEL=z-ai/glm-5.2"
//     )
//     set "ANTHROPIC_MODEL=%SUPERVISOR_MODEL%"
//
// The last line is deliberately OUTSIDE the block — inside a parenthesised block
// cmd expands the variable when it parses the whole block, before the `set` on
// the previous line has run, so the assignment read empty. That launcher comment
// is load-bearing and this file must not tempt anyone into "simplifying" it.
//
// The consequence: reading only `ANTHROPIC_MODEL` reported the Supervisor's lead
// as null, and WRITING it changed nothing while reporting success — the
// dashboard said saved and the launcher kept its model (FOC-170). A silent
// no-op that reports success is worse than a refusal.
//
// Run: node scripts/squad-config-indirect.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harness } from "./supervisor-test-fixtures.mjs";
import { readSquadConfig, writeSquadConfig } from "./squad-config.mjs";

const { test, fail, summary } = harness();

const INDIRECT_BAT = [
  "@echo off",
  "setlocal",
  'set "SQUAD_SLUG=supervisor"',
  'call "%~dp0_lib.bat" || exit /b 1',
  "if defined NATIVE (",
  '    if not defined SUPERVISOR_MODEL set "SUPERVISOR_MODEL=claude-opus-4-8"',
  ") else (",
  '    if not defined SUPERVISOR_MODEL set "SUPERVISOR_MODEL=z-ai/glm-5.2"',
  '    set "ANTHROPIC_SMALL_FAST_MODEL=minimax/minimax-m3"',
  ")",
  'set "ANTHROPIC_MODEL=%SUPERVISOR_MODEL%"',
  "claude %*",
  "endlocal",
].join("\r\n");

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "la-indirect-"));
  roots.push(root);
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "agents", "supervisor"), { recursive: true });

  writeFileSync(join(root, "bin", "supervisor.bat"), INDIRECT_BAT);
  writeFileSync(
    join(root, "config", "models.json"),
    JSON.stringify({
      providers: { openrouter: { baseUrl: "https://openrouter.ai/api", authEnv: "OPENROUTER_API_KEY" } },
      ids: { glm: "z-ai/glm-5.2" },
      routing: { supervisor: { default: "glm" } },
      pricing: { openrouter: { "z-ai/glm-5.2": { input: 1.19, output: 3.74 } } },
    }),
  );
  return root;
}

process.on("exit", () => {
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

console.log("\nlauncher kierujący model przez własną zmienną");

test("the lead reads through the indirection", () => {
  const root = fixture();
  const cfg = readSquadConfig(root);
  assert.equal(cfg.squads.supervisor.lead, "z-ai/glm-5.2");
});

test("the NATIVE branch is not the one reported", () => {
  // Same rule as plan.bat: the OpenRouter model (the one with a "/") is the
  // lead, not the native id sitting in the other branch.
  const root = fixture();
  assert.notEqual(readSquadConfig(root).squads.supervisor.lead, "claude-opus-4-8");
});

test("the small/fast helper is not mistaken for the lead", () => {
  // It also ends in _MODEL and also contains a "/", and it sits in the same
  // branch. Excluding it by name is the only thing keeping them apart.
  const root = fixture();
  assert.notEqual(readSquadConfig(root).squads.supervisor.lead, "minimax/minimax-m3");
});

test("writing the lead changes the indirect line, not ANTHROPIC_MODEL", () => {
  // The failure this replaces: the write found no ANTHROPIC_MODEL line in the
  // branch, changed nothing, and still reported a before/after pair.
  const root = fixture();
  const res = writeSquadConfig({ squads: { supervisor: { lead: "z-ai/glm-9.9" } } }, root);
  assert.ok(res.changed.length >= 1, JSON.stringify(res));

  const bat = readFileSync(join(root, "bin", "supervisor.bat"), "utf8");
  assert.match(bat, /SUPERVISOR_MODEL=z-ai\/glm-9\.9/);

  // The line the launcher comment protects must survive verbatim: rewriting it
  // to a literal would drop the NATIVE branch silently.
  assert.match(bat, /set "ANTHROPIC_MODEL=%SUPERVISOR_MODEL%"/);
  assert.equal(readSquadConfig(root).squads.supervisor.lead, "z-ai/glm-9.9");
});

test("a write reports what it actually did", () => {
  const root = fixture();
  const res = writeSquadConfig({ squads: { supervisor: { lead: "z-ai/glm-9.9" } } }, root);
  const entry = res.changed.find((c) => c.file.includes("supervisor.bat"));
  assert.ok(entry, "no change entry for supervisor.bat");
  assert.equal(entry.before, "z-ai/glm-5.2");
  assert.equal(entry.after, "z-ai/glm-9.9");
});

test("the CRLF launcher stays CRLF", () => {
  // A .bat rewritten with LF endings is a .bat cmd may refuse to parse.
  const root = fixture();
  writeSquadConfig({ squads: { supervisor: { lead: "z-ai/glm-9.9" } } }, root);
  const raw = readFileSync(join(root, "bin", "supervisor.bat"), "utf8");
  const lone = raw.split("\n").filter((l, i, a) => i < a.length - 1 && !l.endsWith("\r"));
  if (lone.length) fail(`${lone.length} line(s) lost their CR: ${JSON.stringify(lone.slice(0, 2))}`);
});

summary();
