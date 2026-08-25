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
//   MOCK_CLAUDE_STDERR       text to write to stderr
//   MOCK_CLAUDE_SPLIT        1 → flush init in two chunks, splitting a JSON line
//                                across writes (tests the NDJSON buffering)
//
// FOC-127 extends this for the full suite; it is kept deliberately small so a
// failing test points at the system under test rather than at the mock.

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const sessionId = process.env.MOCK_CLAUDE_SESSION_ID || "11111111-2222-3333-4444-555555555555";
const exitCode = Number(process.env.MOCK_CLAUDE_EXIT ?? 0);
const hangMs = Number(process.env.MOCK_CLAUDE_HANG_MS ?? 0);
const cost = Number(process.env.MOCK_CLAUDE_COST ?? 0.01);

if (process.env.MOCK_CLAUDE_STDERR) {
  process.stderr.write(process.env.MOCK_CLAUDE_STDERR);
}

if (process.env.MOCK_CLAUDE_NO_INIT !== "1") {
  const init = { type: "system", subtype: "init", session_id: sessionId, tools: [], model: "mock" };
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
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  setTimeout(() => process.exit(exitCode), hangMs);
}, 60);
