// Tests for extractAgentTurns includeUser + maxTextLen:null + role field.
// Run: node scripts/flow-turns.test.mjs
//
// Uses temp fixtures (mkdtemp), never touches real ~/.claude data.

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ledger from "./ledger.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, message: e.message });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmp = join(tmpdir(), "_flow_turns_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
mkdirSync(tmp, { recursive: true });

function jsonl(lines) {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

// Lead transcript with user + assistant turns
const leadPath = join(tmp, "session-flow.jsonl");
writeFileSync(
  leadPath,
  jsonl([
    { sessionId: "session-flow", cwd: "C:\\repo", gitBranch: "main", type: "user", timestamp: "2026-07-01T10:00:00Z", message: { content: "kickoff JOI-9" } },
    {
      type: "assistant",
      timestamp: "2026-07-01T10:00:10Z",
      message: {
        model: "z-ai/glm-5.2",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "text", text: "Lead odpowiada: plan gotowy." }],
      },
    },
    { type: "user", timestamp: "2026-07-01T10:01:00Z", message: { content: "dodaj też testy" } },
    {
      type: "assistant",
      timestamp: "2026-07-01T10:01:30Z",
      message: {
        model: "z-ai/glm-5.2",
        usage: { input_tokens: 15, output_tokens: 8 },
        content: [{ type: "text", text: "Dodałem testy." }],
      },
    },
    { type: "user", timestamp: "2026-07-01T10:02:00Z", isSidechain: true, message: { content: "sidechain message from subagent" } },
  ]),
);

// Subagent transcript
const subDir = join(tmp, "session-flow", "subagents");
mkdirSync(subDir, { recursive: true });
writeFileSync(
  join(subDir, "agent-xyz.jsonl"),
  jsonl([
    {
      type: "assistant",
      timestamp: "2026-07-01T10:05:00Z",
      attributionAgent: "recon",
      message: {
        model: "minimax/minimax-m3",
        usage: { input_tokens: 20, output_tokens: 10 },
        content: [{ type: "text", text: "Recon done." }],
      },
    },
  ]),
);

// Transcript with long text
const longPath = join(tmp, "session-long.jsonl");
writeFileSync(
  longPath,
  jsonl([
    {
      type: "assistant",
      timestamp: "2026-07-01T10:00:00Z",
      message: {
        model: "z-ai/glm-5.2",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: "x".repeat(10000) }],
      },
    },
  ]),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Test 1: default call does NOT return user turns
test("default call excludes user turns", () => {
  const turns = ledger.extractAgentTurns(leadPath, "_lead");
  assert(turns.length === 2, `expected 2 assistant turns, got ${turns.length}`);
  assert(turns.every((t) => t.role === "assistant"), "all turns have role=assistant");
});

// Test 2: includeUser:true returns user + assistant turns, chronologically
test("includeUser:true returns user + assistant turns chronologically", () => {
  const turns = ledger.extractAgentTurns(leadPath, "_lead", { includeUser: true });
  assert(turns.length === 4, `expected 4 turns (2 user + 2 assistant), got ${turns.length}`);
  // Chronological order
  for (let i = 1; i < turns.length; i++) {
    assert(turns[i - 1].ts <= turns[i].ts, `turns not chronological at index ${i}`);
  }
  // Check roles
  assert(turns[0].role === "user", "first turn is user");
  assert(turns[1].role === "assistant", "second turn is assistant");
  assert(turns[2].role === "user", "third turn is user");
  assert(turns[3].role === "assistant", "fourth turn is assistant");
});

// Test 3: each turn has correct role field
test("each turn has correct role field", () => {
  const turns = ledger.extractAgentTurns(leadPath, "_lead", { includeUser: true });
  for (const t of turns) {
    assert(t.role === "user" || t.role === "assistant", `turn has valid role: ${t.role}`);
  }
  const userTurns = turns.filter((t) => t.role === "user");
  assert(userTurns.length === 2, "2 user turns");
  // User turns have no model, no toolUses, zero usage
  for (const ut of userTurns) {
    assert(ut.model === null, "user turn model is null");
    assert(ut.toolUses.length === 0, "user turn has no toolUses");
    assert(ut.usage.inputTokens === 0, "user turn has zero inputTokens");
  }
});

// Test 4: maxTextLen:null does not truncate
test("maxTextLen:null does not truncate long text", () => {
  const turns = ledger.extractAgentTurns(longPath, "_lead", { maxTextLen: null });
  assert(turns.length === 1, "1 turn");
  assert(turns[0].truncated === false, "not truncated");
  assert(turns[0].text.length === 10000, `full text length 10000, got ${turns[0].text.length}`);
});

// Test 5: maxTextLen:100 truncates (existing behavior)
test("maxTextLen:100 truncates long text", () => {
  const turns = ledger.extractAgentTurns(longPath, "_lead", { maxTextLen: 100 });
  assert(turns[0].truncated === true, "truncated flag is true");
  assert(turns[0].text.length <= 101, `text length <= 101, got ${turns[0].text.length}`);
  assert(turns[0].text.endsWith("…"), "truncated text ends with …");
});

// Test 6: time window works for user turns too (kickoff always included)
test("time window filters user turns (kickoff always included)", () => {
  const turns = ledger.extractAgentTurns(leadPath, "_lead", {
    includeUser: true,
    windowStart: new Date("2026-07-01T10:00:30Z").getTime(),
    windowEnd: new Date("2026-07-01T10:01:15Z").getTime(),
  });
  // Kickoff at 10:00:00 is always included (isKickoff).
  // User at 10:01:00 is within widened window (10:00:30 - 5min = 09:55:30).
  // Assistant at 10:00:10 is before windowStart → dropped.
  // Assistant at 10:01:30 is after windowEnd → dropped.
  assert(turns.length === 2, `expected 2 turns (kickoff + in-window user), got ${turns.length}`);
  assert(turns[0].role === "user" && turns[0].isKickoff === true, "first is kickoff user");
  assert(turns[1].role === "user" && turns[1].isKickoff === undefined, "second is in-window user");
});

// Test 7: sidechain user messages are excluded
test("sidechain user messages are excluded", () => {
  const turns = ledger.extractAgentTurns(leadPath, "_lead", { includeUser: true });
  const sidechainTurns = turns.filter((t) => t.text.includes("sidechain"));
  assert(sidechainTurns.length === 0, "no sidechain user messages in results");
});

// Test 7b: tool_result-only user lines carry no text and must not appear.
// On a real dev run 48 of 56 user lines were empty tool_result envelopes —
// they would render as blank rows in the conversation view.
test("user lines without text (tool_result envelopes) are dropped", () => {
  const toolResultOnly = join(tmp, "toolresult.jsonl");
  writeFileSync(
    toolResultOnly,
    [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T10:00:00.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T10:00:01.000Z",
        message: { content: [{ type: "text", text: "prawdziwa wiadomosc" }] },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  const turns = ledger.extractAgentTurns(toolResultOnly, "_lead", { includeUser: true });
  assert(turns.length === 1, `expected only the text turn, got ${turns.length}`);
  assert(turns[0].text === "prawdziwa wiadomosc", "kept the real message");
});

// Test 8: includeUser with non-lead agentKey returns no user turns
test("includeUser with non-lead agentKey returns no user turns", () => {
  const turns = ledger.extractAgentTurns(leadPath, "recon", { includeUser: true });
  // recon has 1 assistant turn from subagent
  assert(turns.length === 1, "only recon assistant turn");
  assert(turns[0].role === "assistant", "turn is assistant");
});

// Test 9: default call returns same shape as before (plus role field)
test("default call returns same shape plus role field", () => {
  const turns = ledger.extractAgentTurns(leadPath, "_lead");
  assert(turns.length === 2, "2 turns");
  for (const t of turns) {
    // All existing fields present
    assert("ts" in t, "has ts");
    assert("model" in t, "has model");
    assert("agent" in t, "has agent");
    assert("text" in t, "has text");
    assert("truncated" in t, "has truncated");
    assert("toolUses" in t, "has toolUses");
    assert("usage" in t, "has usage");
    // New field
    assert("role" in t, "has role");
    assert(t.role === "assistant", "role is assistant");
  }
});

// Test 10: subagent turns also get role field
test("subagent turns get role=assistant", () => {
  const turns = ledger.extractAgentTurns(leadPath, "recon");
  assert(turns.length === 1, "1 recon turn");
  assert(turns[0].role === "assistant", "subagent turn has role=assistant");
});

// ---------------------------------------------------------------------------
// Kickoff fix (FOC-38): first user turn is always included, user window widened
// ---------------------------------------------------------------------------

// Transcript where kickoff is BEFORE the run window.
// Run starts at 08:19:20, kickoff at 08:19:00 — 20s gap.
const kickoffPath = join(tmp, "session-kickoff.jsonl");
writeFileSync(
  kickoffPath,
  jsonl([
    // Kickoff — 20s before run start
    { type: "user", timestamp: "2026-07-24T08:19:00.072Z", message: { content: "check Claude.md i zrób recon JOI-9" } },
    // Assistant response — also before run start (should be dropped)
    {
      type: "assistant",
      timestamp: "2026-07-24T08:19:10.000Z",
      message: {
        model: "z-ai/glm-5.2",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "text", text: "OK, sprawdzam Claude.md." }],
      },
    },
    // Assistant response — inside window
    {
      type: "assistant",
      timestamp: "2026-07-24T08:19:25.000Z",
      message: {
        model: "z-ai/glm-5.2",
        usage: { input_tokens: 20, output_tokens: 10 },
        content: [{ type: "text", text: "Recon gotowy." }],
      },
    },
    // User follow-up — inside window
    { type: "user", timestamp: "2026-07-24T08:20:00.000Z", message: { content: "dodaj testy" } },
    // Assistant response — inside window
    {
      type: "assistant",
      timestamp: "2026-07-24T08:20:15.000Z",
      message: {
        model: "z-ai/glm-5.2",
        usage: { input_tokens: 15, output_tokens: 8 },
        content: [{ type: "text", text: "Testy dodane." }],
      },
    },
  ]),
);

// Test 11: kickoff before window is included and has isKickoff:true
test("kickoff before window is included with isKickoff:true", () => {
  const windowStart = new Date("2026-07-24T08:19:20.044Z").getTime();
  const windowEnd = new Date("2026-07-24T08:21:00.000Z").getTime();

  const turns = ledger.extractAgentTurns(kickoffPath, "_lead", {
    includeUser: true,
    windowStart,
    windowEnd,
  });

  // Expected: kickoff (user, 08:19:00) + assistant (08:19:25) + user (08:20:00) + assistant (08:20:15)
  // The assistant at 08:19:10 is before windowStart and should be dropped
  assert(turns.length === 4, `expected 4 turns (kickoff + 2 assistant + 1 user), got ${turns.length}`);

  // First turn is the kickoff
  assert(turns[0].role === "user", "first turn is user (kickoff)");
  assert(turns[0].isKickoff === true, "first turn has isKickoff:true");
  assert(turns[0].text.includes("check Claude.md"), "kickoff text preserved");

  // Second turn is the in-window assistant (08:19:25)
  assert(turns[1].role === "assistant", "second turn is assistant");
  assert(turns[1].text === "Recon gotowy.", "in-window assistant text");

  // Third turn is the in-window user (08:20:00)
  assert(turns[2].role === "user", "third turn is user");
  assert(turns[2].isKickoff === undefined, "follow-up user does NOT have isKickoff");

  // Fourth turn is the in-window assistant (08:20:15)
  assert(turns[3].role === "assistant", "fourth turn is assistant");
});

// Test 12: assistant turn before window is still rejected
test("assistant turn before window is still rejected", () => {
  const windowStart = new Date("2026-07-24T08:19:20.044Z").getTime();
  const windowEnd = new Date("2026-07-24T08:21:00.000Z").getTime();

  const turns = ledger.extractAgentTurns(kickoffPath, "_lead", {
    includeUser: true,
    windowStart,
    windowEnd,
  });

  // The assistant at 08:19:10 (before window) must NOT appear
  const earlyAssistant = turns.filter(
    (t) => t.role === "assistant" && t.text.includes("sprawdzam Claude.md"),
  );
  assert(earlyAssistant.length === 0, "assistant before window is dropped");
});

// Test 13: without includeUser nothing changes (no user turns at all)
test("without includeUser nothing changes", () => {
  const windowStart = new Date("2026-07-24T08:19:20.044Z").getTime();
  const windowEnd = new Date("2026-07-24T08:21:00.000Z").getTime();

  const turns = ledger.extractAgentTurns(kickoffPath, "_lead", {
    windowStart,
    windowEnd,
  });

  // Only assistant turns in window: 08:19:25 + 08:20:15
  assert(turns.length === 2, `expected 2 assistant turns, got ${turns.length}`);
  assert(turns.every((t) => t.role === "assistant"), "all turns are assistant");
  assert(turns[0].text === "Recon gotowy.", "first assistant");
  assert(turns[1].text === "Testy dodane.", "second assistant");
});

// Test 14: user turn within widened window (5min back) is included
test("user turn within widened 5min window is included", () => {
  // Window starts at 08:24:00, user turn at 08:20:00 — within 5min margin
  const windowStart = new Date("2026-07-24T08:24:00.000Z").getTime();
  const windowEnd = new Date("2026-07-24T08:30:00.000Z").getTime();

  const turns = ledger.extractAgentTurns(kickoffPath, "_lead", {
    includeUser: true,
    windowStart,
    windowEnd,
  });

  // Kickoff (08:19:00) is always included (isKickoff)
  // User at 08:20:00 is within widened window (08:24:00 - 5min = 08:19:00)
  const userTurns = turns.filter((t) => t.role === "user");
  assert(userTurns.length === 2, `expected 2 user turns (kickoff + widened), got ${userTurns.length}`);
  assert(userTurns[0].isKickoff === true, "first user is kickoff");
  assert(userTurns[1].isKickoff === undefined, "second user is NOT kickoff");
  assert(userTurns[1].text === "dodaj testy", "widened user turn included");
});

// ---------------------------------------------------------------------------
// Cleanup + report
// ---------------------------------------------------------------------------

if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });

console.log("");
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
}
console.log(`${passed} passed, ${failed} failed out of ${passed + failed}`);
console.log(failed === 0 ? `PASS ${passed}/${passed + failed}` : `FAIL`);
process.exit(failed === 0 ? 0 : 1);
