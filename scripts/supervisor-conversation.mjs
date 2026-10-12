// scripts/supervisor-conversation.mjs — incremental reader for the Supervisor's
// Claude Code transcript (.jsonl) feeding the dashboard chat view (FOC-783).
//
// Mapping rules (observed against real transcripts under
// agents/supervisor/projects/**.jsonl — top-level types seen there:
// user, assistant, system, last-prompt, mode, permission-mode, atis-latch,
// attachment, file-history-snapshot, file-history-delta, ai-title,
// queue-operation, pr-link, cost-state; only "user" and "assistant" map):
//   · lines with isSidechain or isMeta are skipped;
//   · user lines: message.content string → one user entry; array → each
//     "text" part is a user entry, "tool_result" parts (and everything else)
//     are skipped; harness wrapper texts starting with "<command-name>",
//     "<local-command-stdout>", "<local-command-caveat>", "<system-reminder>",
//     "<task-notification>", "<bash-input>", "<bash-stdout>",
//     "<bash-stderr>", "<user-prompt-submit-hook>"
//     are skipped, except "<command-name>/x</command-name>" which renders as
//     {role:"user", text:"/x"};
//   · assistant lines: consecutive "text" parts merge with "\n\n";
//     "tool_use" parts become {role:"tool", tool:{name, summary}} where the
//     summary is the first line of the mapped input field (Bash→command,
//     Read/Edit/Write/NotebookEdit→file_path, Grep/Glob→pattern,
//     Task/Agent→description, WebFetch→url, WebSearch→query, otherwise the
//     first string-valued input field), trimmed and capped at 160 chars;
//     "thinking"/"redacted_thinking" parts are skipped;
//   · every other top-level type is skipped.
// Each entry carries uuid ("<line uuid>#<part index>") and ts (line timestamp);
// texts are capped at 20000 chars with a trailing "…" marker.
//
// Byte discipline: only complete "\n"-terminated lines are parsed; reads seek
// to byte offsets (large files are never read whole). The pager contract:
// `after === null` reads the last maxTailBytes (when that window does not
// start at 0, truncated:true is set and the first line is dropped if it is
// genuinely partial) and returns the LAST `limit` entries; a numeric `after`
// reads forward from that byte offset, returning up to `limit` entries —
// `limit` is applied at line granularity (a line's entries are never split
// across pages), so the count can exceed `limit` by one line's entries.
// `after` beyond the file size falls back to tail mode with reset:true.
// Torn/unparsable lines are skipped silently. CRLF is assumed absent (real
// transcripts are LF-only; a stray "\r" before "\n" is stripped defensively).

import { openSync, fstatSync, readSync, closeSync } from "node:fs";

const TEXT_CAP = 20000;
const SUMMARY_CAP = 160;
const WRAPPER_PREFIXES = [
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<system-reminder>",
  "<task-notification>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<user-prompt-submit-hook>",
];
const CHUNK = 256 * 1024;

const SUMMARY_FIELD = {
  Bash: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "file_path",
  Grep: "pattern",
  Glob: "pattern",
  Task: "description",
  Agent: "description",
  WebFetch: "url",
  WebSearch: "query",
};

function capText(text) {
  return text.length <= TEXT_CAP ? text : text.slice(0, TEXT_CAP) + "…";
}

function commandNameText(raw) {
  const match = raw.match(/^<command-name>([\s\S]*?)<\/command-name>/);
  if (!match) return null;
  const inner = match[1].trim();
  return inner.startsWith("/") ? inner : null;
}

function toolSummary(name, input) {
  let value;
  const key = SUMMARY_FIELD[name];
  if (key && input && typeof input[key] === "string") {
    value = input[key];
  } else if (input) {
    for (const field of Object.keys(input)) {
      if (typeof input[field] === "string" && input[field]) { value = input[field]; break; }
    }
  }
  if (typeof value !== "string") return "";
  return value.split("\n")[0].trim().slice(0, SUMMARY_CAP);
}

// One parsed transcript line → zero or more entries, in part order.
export function mapLine(line) {
  const j = JSON.parse(line);
  if (j.isSidechain === true || j.isMeta === true) return [];
  if (j.type !== "user" && j.type !== "assistant") return [];
  const content = j.message && j.message.content;
  if (content === undefined || content === null) return [];
  const uuidOf = (part) => `${j.uuid ?? ""}#${part}`;
  const entries = [];

  if (typeof content === "string") {
    if (WRAPPER_PREFIXES.some((prefix) => content.startsWith(prefix))) {
      const rendered = commandNameText(content);
      if (rendered) entries.push({ uuid: uuidOf(0), ts: j.timestamp, role: "user", text: capText(rendered) });
      return entries;
    }
    entries.push({ uuid: uuidOf(0), ts: j.timestamp, role: "user", text: capText(content) });
    return entries;
  }
  if (!Array.isArray(content)) return entries;

  for (const [index, part] of content.entries()) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      if (WRAPPER_PREFIXES.some((prefix) => part.text.startsWith(prefix))) {
        const rendered = commandNameText(part.text);
        if (rendered) entries.push({ uuid: uuidOf(index), ts: j.timestamp, role: "user", text: capText(rendered) });
        continue;
      }
      const role = j.type === "user" ? "user" : "assistant";
      const previous = entries[entries.length - 1];
      if (role === "assistant" && previous && previous.role === "assistant" && previous._merging) {
        previous.text = capText(`${previous.rawText}\n\n${part.text}`);
        previous.rawText = `${previous.rawText}\n\n${part.text}`;
        continue;
      }
      const entry = { uuid: uuidOf(index), ts: j.timestamp, role, text: capText(part.text), rawText: part.text };
      if (role === "assistant") entry._merging = true;
      entries.push(entry);
      continue;
    }
    if (j.type === "assistant" && part.type === "tool_use") {
      entries.push({
        uuid: uuidOf(index),
        ts: j.timestamp,
        role: "tool",
        tool: { name: part.name, summary: toolSummary(part.name, part.input) },
      });
    }
    // user tool_result, thinking / redacted_thinking and unknown part types are skipped
  }
  for (const entry of entries) {
    delete entry.rawText;
    delete entry._merging;
  }
  return entries;
}

export function readConversation({
  transcriptPath,
  after = null,
  limit = 200,
  maxTailBytes = 1048576,
}) {
  let fd;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return { offset: 0, entries: [], reset: false, truncated: false };
  }
  try {
    const size = fstatSync(fd).size;
    const tailMode = after === null || after > size;
    const reset = tailMode && after !== null;
    const start = tailMode ? Math.max(0, size - maxTailBytes) : after;
    if (size === 0) return { offset: 0, entries: [], reset, truncated: false };

    // In tail mode the window may cut into the first line; only drop it when
    // the byte before the window is not a newline (i.e. it is genuinely partial).
    let dropFirstLine = false;
    let truncated = false;
    if (tailMode && start > 0) {
      truncated = true;
      const prev = Buffer.alloc(1);
      readSync(fd, prev, 0, 1, start - 1);
      if (prev[0] !== 0x0a) dropFirstLine = true;
    }

    let byteCursor = start; // offset just after the last complete line consumed
    let readPos = start;
    let pending = Buffer.alloc(0);
    let entries = [];
    let done = size === start;
    const chunk = Buffer.allocUnsafe(CHUNK);

    while (!done) {
      let read = 0;
      if (readPos < size) {
        read = readSync(fd, chunk, 0, Math.min(CHUNK, size - readPos), readPos);
        readPos += read;
        pending = read > 0 ? Buffer.concat([pending, chunk.subarray(0, read)]) : pending;
      }
      const lastNl = pending.lastIndexOf(0x0a);
      if (lastNl === -1) {
        if (read === 0) break; // EOF with an unterminated tail: not a complete line
        continue; // need more bytes before any line is complete
      }
      const complete = pending.subarray(0, lastNl + 1);
      pending = Buffer.from(pending.subarray(lastNl + 1));
      const lines = complete.toString("utf8").split("\n");
      lines.pop(); // empty element after the trailing newline
      let consumed = 0;
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        if (dropFirstLine) {
          dropFirstLine = false;
        } else {
          const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (trimmed.trim()) {
            try {
              entries.push(...mapLine(trimmed));
            } catch {
              // torn / unparsable line: skipped silently
            }
          }
        }
        consumed += lineBytes;
        byteCursor += lineBytes;
        if (!tailMode && entries.length >= limit) break;
      }
      if (!tailMode && entries.length >= limit) done = true;
      else if (read === 0) done = true; // EOF reached and everything parsed
    }

    if (tailMode && entries.length > limit) entries = entries.slice(-limit);
    return { offset: byteCursor, entries, reset, truncated };
  } finally {
    closeSync(fd);
  }
}
