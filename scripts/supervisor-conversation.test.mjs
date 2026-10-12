// scripts/supervisor-conversation.test.mjs — the incremental transcript reader
// for the dashboard chat view (FOC-783, supervisor-conversation.mjs).
//
// The properties worth protecting:
//   · user strings and text parts map to user entries; tool_result parts,
//     thinking/redacted_thinking parts and harness wrapper texts
//     (<command-name>, <local-command-stdout>, <local-command-caveat>,
//     <system-reminder>, <task-notification>, <bash-input>, <bash-stdout>,
//     <bash-stderr>, <user-prompt-submit-hook>) are skipped — except
//     "<command-name>/x</command-name>" which renders as a "/x" user entry;
//   · assistant text parts of one line merge with "\n\n"; tool_use parts
//     become tool entries whose summary is the first line of the mapped
//     input field, capped at 160 chars; texts are capped at 20000 with "…";
//   · isSidechain / isMeta lines and every non user/assistant top-level
//     type are skipped;
//   · a partial last line is never consumed — it is picked up on the next
//     read after the rest of the line is appended (the pager contract);
//   · paging forward with `after` resumes exactly at the returned offset;
//     `after` beyond the file size falls back to tail mode with reset:true;
//   · tail mode (after === null) returns the LAST `limit` entries and sets
//     truncated:true when the read window does not start at 0;
//   · a missing file yields an empty result, a torn line is skipped silently.
//
// CRLF-free assumption: real supervisor transcripts are LF-only; the reader
// strips a stray "\r" before "\n" defensively but nothing exercises CRLF here.
//
// Fixtures are synthetic and mirror the REAL top-level shape of supervisor
// transcript lines (keys like parentUuid / message.content / uuid / timestamp
// / userType / cwd) without copying any real content.
//
// Run: node scripts/supervisor-conversation.test.mjs

import { mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { readConversation, mapLine } from "./supervisor-conversation.mjs";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + err.message);
  }
}

const TMP = mkdtempSync(join(tmpdir(), "la-sup-conv-"));
process.on("exit", () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { } });

let counter = 0;
function transcriptPath() {
  return join(TMP, `t${counter++}.jsonl`);
}

// ---- fixture builders (shapes mirror real transcripts, content is synthetic) ----

const TS = "2026-10-12T10:00:00.000Z";
const BASE_USER = { parentUuid: null, isSidechain: false, promptId: "p-1", type: "user", userType: "external", entrypoint: "widgets", cwd: "/repo", sessionId: "s-1", version: "2.1.0", gitBranch: "main" };
const BASE_ASSISTANT = { parentUuid: null, isSidechain: false, message: null, thinkingDurationMs: 1, apiBlockIndex: 0, requestId: "req_1", type: "assistant", session_id: "s-1", userType: "external", entrypoint: "widgets", cwd: "/repo", sessionId: "s-1", version: "2.1.0", gitBranch: "main" };

function userLine(content, overrides = {}) {
  return JSON.stringify({
    ...BASE_USER, type: "user", message: { role: "user", content },
    uuid: overrides.uuid ?? `u-${counter}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: TS, ...overrides,
  });
}

function assistantLine(parts, overrides = {}) {
  return JSON.stringify({
    ...BASE_ASSISTANT, type: "assistant",
    message: { id: "msg_1", role: "assistant", content: parts },
    uuid: overrides.uuid ?? `a-${counter}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: TS, ...overrides,
  });
}

const textPart = (text) => ({ type: "text", text });
const toolUsePart = (id, name, input) => ({ type: "tool_use", id, caller: "assistant", name, input });
const toolResultPart = (toolUseId, content) => ({ tool_use_id: toolUseId, type: "tool_result", content });
const thinkingPart = (thinking) => ({ type: "thinking", thinking, signature: "sig" });

const writeLines = (path, ...lines) => writeFileSync(path, lines.join("\n") + "\n");
const sizeOf = (path) => statSync(path).size;

// ---- mapping of each part type ----

test("user string content → one user entry with uuid and ts", () => {
  const entries = mapLine(userLine("jak status", { uuid: "u1" }));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].role, "user");
  assert.equal(entries[0].text, "jak status");
  assert.equal(entries[0].uuid, "u1#0");
  assert.equal(entries[0].ts, TS);
});

test("user array content: text parts map, tool_result parts are skipped", () => {
  const entries = mapLine(userLine([textPart("witaj"), toolResultPart("tu-1", "ok"), textPart("drugi")], { uuid: "u2" }));
  assert.deepEqual(entries.map((e) => [e.role, e.text]), [["user", "witaj"], ["user", "drugi"]]);
  assert.deepEqual(entries.map((e) => e.uuid), ["u2#0", "u2#2"]);
});

test("assistant: text merges consecutive parts, tool_use maps with summary, thinking skipped", () => {
  const entries = mapLine(assistantLine([
    thinkingPart("cichy monolog"),
    textPart("pierwszy"),
    textPart("drugi"),
    toolUsePart("tu-1", "Bash", { command: "npm test\necho done", description: "run tests" }),
  ], { uuid: "a1" }));
  assert.deepEqual(entries.map((e) => e.role), ["assistant", "tool"]);
  assert.equal(entries[0].text, "pierwszy\n\ndrugi");
  assert.equal(entries[0].uuid, "a1#1");
  assert.deepEqual(entries[1].tool, { name: "Bash", summary: "npm test" });
  assert.equal(entries[1].uuid, "a1#3");
});

test("tool summaries map the right input field per tool", () => {
  const cases = [
    ["Read", { file_path: "src/a.ts" }, "src/a.ts"],
    ["Edit", { file_path: "src/a.ts", old_string: "x" }, "src/a.ts"],
    ["Grep", { pattern: "FOC-783", path: "src" }, "FOC-783"],
    ["Glob", { pattern: "**/*.mjs" }, "**/*.mjs"],
    ["Agent", { description: "rekonesans kodu", prompt: "dlugi prompt" }, "rekonesans kodu"],
    ["WebFetch", { url: "https://example.com/x", prompt: "p" }, "https://example.com/x"],
    ["WebSearch", { query: "claude api" }, "claude api"],
  ];
  for (const [name, input, expected] of cases) {
    const entries = mapLine(assistantLine([toolUsePart("t", name, input)]));
    assert.equal(entries[0].role, "tool");
    assert.deepEqual(entries[0].tool, { name, summary: expected }, name);
  }
});

test("tool summary falls back to the first string-valued input field and is capped at 160", () => {
  const long = "x".repeat(300);
  const entries = mapLine(assistantLine([toolUsePart("t", "PowerShell", { command: long, description: "d" })]));
  assert.equal(entries[0].tool.summary.length, 160);
  assert.equal(entries[0].tool.summary, "x".repeat(160));
  const empty = mapLine(assistantLine([toolUsePart("t", "Bash", { description: "only desc" })]));
  assert.deepEqual(empty[0].tool, { name: "Bash", summary: "only desc" });
});

test("text cap: 20000 chars get a trailing ellipsis marker", () => {
  const entries = mapLine(assistantLine([textPart("y".repeat(25000))]));
  assert.equal(entries[0].text.length, 20001);
  assert.ok(entries[0].text.endsWith("…"));
  const exact = mapLine(assistantLine([textPart("z".repeat(20000))]));
  assert.equal(exact[0].text.length, 20000);
  assert.ok(!exact[0].text.endsWith("…"));
});

// ---- skipped lines ----

test("isSidechain and isMeta lines are skipped", () => {
  assert.deepEqual(mapLine(userLine("hi", { isSidechain: true })), []);
  assert.deepEqual(mapLine(assistantLine([textPart("hi")], { isMeta: true })), []);
});

test("every non user/assistant top-level type is skipped", () => {
  for (const type of ["system", "summary", "attachment", "file-history-snapshot", "last-prompt", "mode", "permission-mode", "atis-latch", "ai-title", "queue-operation", "pr-link", "cost-state"]) {
    const line = JSON.stringify({ type, uuid: "x1", timestamp: TS, subtype: "x" });
    assert.deepEqual(mapLine(line), [], type);
  }
});

test("harness wrapper texts are skipped; <command-name>/x</command-name> renders as /x", () => {
  assert.deepEqual(mapLine(userLine("<task-notification>task done</task-notification>")), []);
  assert.deepEqual(mapLine(userLine("<bash-input>npm test</bash-input>")), []);
  assert.deepEqual(mapLine(userLine("<bash-stdout>\n  ok\n</bash-stdout>")), []);
  assert.deepEqual(mapLine(userLine("<bash-stderr>boom</bash-stderr>")), []);
  assert.deepEqual(mapLine(userLine("<user-prompt-submit-hook>context</user-prompt-submit-hook>")), []);
  const asParts = mapLine(userLine([textPart("<bash-stdout>ok</bash-stdout>"), toolResultPart("t", "x")]));
  assert.deepEqual(asParts, [], "text-part wrappers are skipped too");
  // only the PREFIX decides — a text that merely contains a wrapper marker is shown
  const contained = mapLine(userLine("look: <bash-stdout> inside", { uuid: "uw" }));
  assert.deepEqual(contained.map((e) => [e.role, e.text]), [["user", "look: <bash-stdout> inside"]]);
  assert.deepEqual(mapLine(userLine("<local-command-stdout>\n  ok\n</local-command-stdout>")), []);
  assert.deepEqual(mapLine(userLine("<local-command-caveat>Caveat: x</local-command-caveat>")), []);
  assert.deepEqual(mapLine(userLine("<system-reminder>background context</system-reminder>")), []);
  const cmd = mapLine(userLine("<command-name>/compact</command-name>", { uuid: "uc" }));
  assert.deepEqual(cmd, [{ uuid: "uc#0", ts: TS, role: "user", text: "/compact" }]);
  const argv = mapLine(userLine([textPart("<command-name>/dev FOC-783</command-name>"), toolResultPart("t", "x")], { uuid: "u3" }));
  assert.deepEqual(argv.map((e) => [e.role, e.text, e.uuid]), [["user", "/dev FOC-783", "u3#0"]]);
});

// ---- byte-level paging ----

test("partial last line is not consumed, then picked up after the rest is appended", () => {
  const path = transcriptPath();
  const line1 = userLine("pierwsza", { uuid: "u1" });
  writeFileSync(path, line1 + "\n");
  const first = readConversation({ transcriptPath: path });
  assert.equal(first.entries.length, 1);
  assert.equal(first.offset, sizeOf(path));

  const line2 = userLine("druga", { uuid: "u2" }) + "\n";
  // append the line in two halves — a torn tail must never leak an entry
  appendFileSync(path, line2.slice(0, 40));
  const torn = readConversation({ transcriptPath: path, after: first.offset });
  assert.deepEqual(torn.entries, []);
  assert.equal(torn.offset, first.offset);
  appendFileSync(path, line2.slice(40));
  const whole = readConversation({ transcriptPath: path, after: first.offset });
  assert.deepEqual(whole.entries.map((e) => e.text), ["druga"]);
  assert.equal(whole.offset, sizeOf(path));
});

test("paging with after/limit resumes exactly at the returned offset", () => {
  const path = transcriptPath();
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(userLine(`wiadomosc ${i}`, { uuid: `p${i}` }));
  writeLines(path, ...lines);
  const page1 = readConversation({ transcriptPath: path, after: 0, limit: 2 });
  assert.deepEqual(page1.entries.map((e) => e.text), ["wiadomosc 0", "wiadomosc 1"]);
  assert.equal(page1.reset, false);
  const page2 = readConversation({ transcriptPath: path, after: page1.offset, limit: 2 });
  assert.deepEqual(page2.entries.map((e) => e.text), ["wiadomosc 2", "wiadomosc 3"]);
  const page3 = readConversation({ transcriptPath: path, after: page2.offset, limit: 2 });
  assert.deepEqual(page3.entries.map((e) => e.text), ["wiadomosc 4"]);
  assert.equal(page3.offset, sizeOf(path));
  const page4 = readConversation({ transcriptPath: path, after: page3.offset });
  assert.deepEqual(page4.entries, []);
  // a tool-heavy line carries several entries and is never split across pages
  const path2 = transcriptPath();
  const heavy = assistantLine([textPart("a"), toolUsePart("1", "Read", { file_path: "x" }), toolUsePart("2", "Read", { file_path: "y" }), toolUsePart("3", "Read", { file_path: "z" })], { uuid: "h1" });
  writeLines(path2, userLine("zero", { uuid: "h0" }), heavy, userLine("ostatnia", { uuid: "h2" }));
  const p1 = readConversation({ transcriptPath: path2, after: 0, limit: 2 });
  assert.equal(p1.entries.length, 5); // user + whole heavy line, no split
  const p2 = readConversation({ transcriptPath: path2, after: p1.offset, limit: 2 });
  assert.deepEqual(p2.entries.map((e) => e.text), ["ostatnia"]);
});

test("tail mode returns the LAST limit entries and flags truncated when the window starts inside the file", () => {
  const path = transcriptPath();
  const lines = [];
  for (let i = 0; i < 20; i++) lines.push(userLine(`tail ${i}`, { uuid: `t${i}` }));
  writeLines(path, ...lines);
  // byte offset where each line starts
  const starts = [];
  let acc = 0;
  for (const line of lines) { starts.push(acc); acc += line.length + 1; }
  // window starting 5 bytes into line 18: its partial copy is dropped, line 19 survives
  const tail = readConversation({ transcriptPath: path, maxTailBytes: acc - starts[18] - 5 });
  assert.equal(tail.truncated, true);
  assert.equal(tail.reset, false);
  assert.deepEqual(tail.entries.map((e) => e.text), ["tail 19"]);
  // window covering the last TWO lines exactly (starts at a line boundary)
  const tailTwo = readConversation({ transcriptPath: path, maxTailBytes: acc - starts[18] });
  assert.equal(tailTwo.truncated, true);
  assert.deepEqual(tailTwo.entries.map((e) => e.text), ["tail 18", "tail 19"]);
  // window one byte into line 17: its partial copy is dropped, 18 and 19 survive
  const tailThree = readConversation({ transcriptPath: path, maxTailBytes: acc - starts[17] - 1 });
  assert.deepEqual(tailThree.entries.map((e) => e.text), ["tail 18", "tail 19"]);
  const full = readConversation({ transcriptPath: path, limit: 100 });
  assert.equal(full.truncated, false);
  assert.equal(full.entries.length, 20);
  assert.equal(full.offset, sizeOf(path));
});

test("after beyond the file size falls back to tail mode with reset:true", () => {
  const path = transcriptPath();
  writeLines(path, userLine("jedna", { uuid: "r1" }), userLine("dwie", { uuid: "r2" }));
  const result = readConversation({ transcriptPath: path, after: sizeOf(path) + 1000 });
  assert.equal(result.reset, true);
  assert.deepEqual(result.entries.map((e) => e.text), ["jedna", "dwie"]);
});

test("missing file yields an empty, non-reset result", () => {
  const result = readConversation({ transcriptPath: join(TMP, "nie-ma-takiego.jsonl") });
  assert.deepEqual(result, { offset: 0, entries: [], reset: false, truncated: false });
});

test("torn / unparsable lines are skipped silently", () => {
  const path = transcriptPath();
  const good = userLine("przed", { uuid: "g1" });
  const good2 = userLine("po", { uuid: "g2" });
  writeFileSync(path, good + "\n" + '{"type":"user","message":' + "\n" + good2 + "\n");
  const result = readConversation({ transcriptPath: path });
  assert.deepEqual(result.entries.map((e) => e.text), ["przed", "po"]);
  assert.equal(result.offset, sizeOf(path));
});

test("truncated: when the tail window happens to start at a line boundary, the first line is kept", () => {
  const path = transcriptPath();
  const l1 = userLine("pelna", { uuid: "b1" }) + "\n";
  const l2 = userLine("druga", { uuid: "b2" }) + "\n";
  writeFileSync(path, l1 + l2);
  const windowAtBoundary = l1.length;
  const result = readConversation({ transcriptPath: path, maxTailBytes: sizeOf(path) - windowAtBoundary });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.entries.map((e) => e.text), ["druga"]);
});

test("empty file yields no entries with the requested offset", () => {
  const path = transcriptPath();
  closeSync(openSync(path, "w"));
  const result = readConversation({ transcriptPath: path, after: 0 });
  assert.deepEqual(result, { offset: 0, entries: [], reset: false, truncated: false });
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("FAILED: " + failures.join(", "));
  process.exit(1);
}
