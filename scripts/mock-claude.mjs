// scripts/mock-claude.mjs — a fake `claude` that speaks stream-json.
//
// Lets the supervisor scripts be exercised end-to-end with no API key, no model
// call and no waiting. Point LA_CLAUDE_BIN at this file and supervisor-lib's
// claudeCommand() will run it under node.
//
// Behaviour is driven by env so one binary covers every scenario:
//   MOCK_CLAUDE_SESSION_ID   session_id to emit         (default: fixed uuid)
//   MOCK_CLAUDE_EXIT         exit code                  (default: 0)
//   MOCK_CLAUDE_NO_INIT      1 → never emit system/init (tests the 30 s timeout)
//   MOCK_CLAUDE_HANG_MS      stay alive this long after the events
//   MOCK_CLAUDE_COST         total_cost_usd on result   (default: 0.01)
//   MOCK_CLAUDE_MODEL        model id on init + modelUsage (default: "mock", unpriced)
//   MOCK_CLAUDE_INPUT_TOKENS input tokens on result     (default: 10)
//   MOCK_CLAUDE_STDERR       text to write to stderr
//   MOCK_CLAUDE_SPLIT        1 → flush init in two chunks, splitting a JSON line
//                                across writes (tests the NDJSON buffering)
//   MOCK_CLAUDE_ARGV_FILE    append the argv it was called with, one JSON array
//                            per line — how tests assert --resume carried the
//                            right session id
//
// FOC-127 extends this for the full suite; it is kept deliberately small so a
// failing test points at the system under test rather than at the mock.

import { appendFileSync } from "node:fs";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (process.env.MOCK_CLAUDE_ARGV_FILE) {
  appendFileSync(process.env.MOCK_CLAUDE_ARGV_FILE, JSON.stringify(process.argv.slice(2)) + "\n");
}

const sessionId = process.env.MOCK_CLAUDE_SESSION_ID || "11111111-2222-3333-4444-555555555555";
const exitCode = Number(process.env.MOCK_CLAUDE_EXIT ?? 0);
const hangMs = Number(process.env.MOCK_CLAUDE_HANG_MS ?? 0);
const cost = Number(process.env.MOCK_CLAUDE_COST ?? 0.01);
// FOC-165: the Supervisor prices turns from TOKEN COUNTS, so the mock has to
// carry a model id and a token count, not just a headline cost. Default "mock"
// is deliberately unpriced — that is the path where cost must come out null.
// Set MOCK_CLAUDE_MODEL to a real id to exercise the priced path.
const model = process.env.MOCK_CLAUDE_MODEL || "mock";
const inputTokens = Number(process.env.MOCK_CLAUDE_INPUT_TOKENS ?? 10);

if (process.env.MOCK_CLAUDE_STDERR) {
  process.stderr.write(process.env.MOCK_CLAUDE_STDERR);
}

if (process.env.MOCK_CLAUDE_NO_INIT !== "1") {
  const init = { type: "system", subtype: "init", session_id: sessionId, tools: [], model };
  if (process.env.MOCK_CLAUDE_SPLIT === "1") {
    const line = JSON.stringify(init) + "\n";
    const cut = Math.floor(line.length / 2);
    process.stdout.write(line.slice(0, cut));
    setTimeout(() => process.stdout.write(line.slice(cut)), 30);
  } else {
    emit(init);
  }
}

setTimeout(() => {
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "mock turn" }] } });
  emit({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    total_cost_usd: cost,
    usage: { input_tokens: inputTokens, output_tokens: 5, cache_read_input_tokens: 0 },
    modelUsage: { [model]: { inputTokens, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  });

  setTimeout(() => process.exit(exitCode), hangMs);
}, 60);
