// scripts/session-dialog.mjs — pure dialog parsing for the Fenix Supervisor
// cockpit (FOC-810).
//
// The Supervisor is an interactive Claude Code TUI in tmux; the cockpit must
// show and answer its dialogs without the terminal. This module is the pure
// library behind that: it parses `tmux capture-pane -p` text into dialog
// records, plans the key sequence that answers an AskUserQuestion from the
// transcript's tool_use input, detects a pending (unanswered) ask in the
// transcript JSONL, gates which slash commands may be typed from the chat,
// and extracts command output from scrollback.
//
// No state, no I/O (except readPendingAsk's tail read), no dependencies.
// Fixtures this was built against live in scripts/fixtures/session-dialogs/.
//
// Run: node --test scripts/session-dialog.test.mjs

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

// A full-width horizontal rule that frames dialog blocks in the pane.
const RULE_RE = /^\s*─{20,}\s*$/;
// The lighter dashed rule that wraps the command inside a permission dialog.
const DASH_RULE_RE = /^\s*╌{10,}\s*$/;
// The heavy upper border of the /cost modal panel.
const BANNER_RE = /^\s*▔{20,}\s*$/;
// A numbered option line: optional focus marker, "N.", label.
const OPT_NUM_RE = /^\s*(?:(❯)\s*)?(\d+)\.\s*(.*)$/;
// Any line whose first visible character is the focus marker.
const FOCUS_RE = /^\s*❯\s*(.*)$/;

// Control characters that must never reach `send-keys -l`: tmux interprets
// the bytes, so ESC (0x1b) would press the Escape key and 0x03 is Ctrl-C.
// Same class supervisor-host.mjs strips from chat messages and notes —
// \r plus C0/C1, keeping \t and \n (the ask literal collapses newlines
// itself; a tab is typed literally).
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

const leadingWs = (line) => line.length - line.trimStart().length;

// ── parseDialog ───────────────────────────────────────────────────────

/**
 * Parse a tmux pane capture into a dialog record, or null when the pane
 * shows no dialog.
 *
 * Detection rule: only the bottom block of the pane is considered — the
 * lines after a full-width `─{20,}` rule. Rules are tried from the
 * bottom-most upward and the first block that parses into a valid dialog
 * wins; a block parses only when it carries real dialog markers (a
 * "Do you want to proceed?" permission screen, "Review your answers", an
 * ask tab strip with numbered options, or a `❯` selection list). Echoed
 * user lines like `❯ MOCK-TOOL-... please` live above the bottom rules in
 * idle captures and are never reached; the bare `❯ ` prompt between the
 * bottom rules yields no options and parses as nothing.
 *
 * Returns null, or:
 *   { id, kind, title, lines, command, question, tabs, options, footer }
 *   kind: "permission" | "ask" | "ask-review" | "select"
 *   options: [{ key, label, description, focused, checked, choice }]
 */
export function parseDialog(paneText) {
  if (typeof paneText !== "string") return null;
  const lines = paneText.split(/\r?\n/);
  const ruleIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (RULE_RE.test(lines[i])) ruleIdx.push(i);
  }
  for (let r = ruleIdx.length - 1; r >= 0; r--) {
    const block = lines.slice(ruleIdx[r] + 1);
    while (block.length && !block[block.length - 1].trim()) block.pop();
    if (!block.length) continue;
    const dialog = parseDialogBlock(block);
    if (dialog) {
      // The id is the hash of the raw block, so it CHANGES when a focus
      // marker or a checkbox mark moves — intended: the dashboard must not
      // act on a dialog someone is navigating in the Terminal.
      dialog.id = createHash("sha1").update(block.join("\n")).digest("hex").slice(0, 12);
      return {
        id: dialog.id,
        kind: dialog.kind,
        title: dialog.title,
        lines: dialog.lines,
        command: dialog.command,
        question: dialog.question,
        tabs: dialog.tabs,
        options: dialog.options,
        footer: dialog.footer,
      };
    }
  }
  return null;
}

/**
 * Parse one candidate block (the lines after an opening rule, trailing
 * blanks already trimmed) into a dialog body, or null when the block is
 * not a dialog. The id is attached by parseDialog over the raw block.
 */
function parseDialogBlock(block) {
  const trimmed = block.map((l) => l.replace(/\s+$/, ""));
  const rulePos = [];
  const dashPos = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (RULE_RE.test(trimmed[i])) rulePos.push(i);
    else if (DASH_RULE_RE.test(trimmed[i])) dashPos.push(i);
  }
  // `lines`: the dialog's text lines — trimmed, blanks and rule lines out.
  const textLines = trimmed
    .filter((l) => l.trim() && !RULE_RE.test(l) && !DASH_RULE_RE.test(l))
    .map((l) => l.trim());
  if (!textLines.length) return null;

  const hasProceed = trimmed.some((l) => l.trim() === "Do you want to proceed?");
  const hasReview = trimmed.some((l) => l.trim() === "Review your answers");
  const tabIdx = trimmed.findIndex((l) => parseTabStrip(l) !== null);
  const hasFocus = trimmed.some((l) => {
    const m = l.match(FOCUS_RE);
    return !!m && m[1].trim().length > 0;
  });
  const hasNumbered = trimmed.some((l) => OPT_NUM_RE.test(l));

  let kind;
  if (hasProceed && hasNumbered) kind = "permission";
  else if (hasReview) kind = "ask-review";
  else if (tabIdx >= 0 && hasNumbered) kind = "ask";
  else if (hasFocus && rulePos.length === 0) kind = "select";
  else return null;

  const firstLine = textLines[0].trim();
  const footerIdx = findFooterIdx(trimmed);
  let title = null;
  let tabs = null;
  let question = null;
  let command = null;
  let options = [];

  if (kind === "permission") {
    title = firstLine;
    if (dashPos.length >= 2) {
      const between = trimmed
        .slice(dashPos[0] + 1, dashPos[dashPos.length - 1])
        .filter((l) => l.trim())
        .map((l) => l.trim());
      command = between.length ? between.join("\n") : null;
    }
    const proceedIdx = trimmed.findIndex((l) => l.trim() === "Do you want to proceed?");
    options = scanNumbered(trimmed, proceedIdx + 1, footerIdx);
    for (const o of options) {
      o.choice = permissionChoice(o.label);
    }
  } else if (kind === "ask-review") {
    tabs = parseTabStrip(trimmed[tabIdx]);
    title = tabs && tabs.length ? tabs[0].label : firstLine.replace(/^[☐☒]\s*/, "");
    const readyIdx = trimmed.findIndex((l) => l.trim() === "Ready to submit your answers?");
    options = scanNumbered(trimmed, readyIdx + 1, footerIdx);
  } else if (kind === "ask") {
    tabs = parseTabStrip(trimmed[tabIdx]);
    title = tabs && tabs.length ? tabs[0].label : firstLine.replace(/^[☐☒]\s*/, "");
    const questionIdx = findQuestionIdx(trimmed, tabIdx, footerIdx);
    if (questionIdx >= 0) question = trimmed[questionIdx].trim();
    options = scanNumbered(trimmed, questionIdx >= 0 ? questionIdx + 1 : tabIdx + 1, footerIdx);
  } else {
    // select — a `❯` selection list without numbered options. A single
    // focused line (a typed-but-unsent prompt whose closing rule scrolled
    // off) is not a dialog: at least two options are required.
    title = firstLine.replace(/^[☐☒]\s*/, "");
    options = parseSelectOptions(trimmed);
    if (options.length < 2) return null;
  }

  return { kind, title, lines: textLines, command, question, tabs, options, footer: footerIdx >= 0 ? trimmed[footerIdx].trim() : null };
}

/**
 * The footer is the last non-blank line of the block, when it is a hint
 * line (contains the "·" separator and is not itself an option or tab
 * strip). Returns its index, or -1.
 */
function findFooterIdx(trimmed) {
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const t = trimmed[i].trim();
    if (!t) continue;
    if (OPT_NUM_RE.test(trimmed[i]) || FOCUS_RE.test(trimmed[i])) return -1;
    if (parseTabStrip(trimmed[i])) return -1;
    return t.includes("·") ? i : -1;
  }
  return -1;
}

/**
 * Parse the ask tab strip: `←  ☐ Export  ☐ Checks  ✔ Submit  →` or the
 * single-question header ` ☐ Audit`. Returns [{ label, done }] or null.
 */
function parseTabStrip(line) {
  const t = line.trim();
  if (!/[☐☒✔]/.test(t)) return null;
  let body = t;
  if (body.startsWith("←")) body = body.slice(1);
  if (body.endsWith("→")) body = body.slice(0, -1);
  const tabs = [];
  for (const tok of body.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean)) {
    const m = tok.match(/^([☐☒✔])\s*(.*)$/);
    if (!m) return null;
    tabs.push({ label: m[2], done: m[1] !== "☐" });
  }
  return tabs.length ? tabs : null;
}

/**
 * The question line of an ask screen: the first non-blank, non-rule line
 * after the tab strip that is not itself an option. -1 when there is none.
 */
function findQuestionIdx(trimmed, tabIdx, footerIdx) {
  for (let i = tabIdx + 1; i < trimmed.length; i++) {
    if (i === footerIdx) return -1;
    const line = trimmed[i];
    if (!line.trim()) continue;
    if (RULE_RE.test(line) || DASH_RULE_RE.test(line)) continue;
    if (parseTabStrip(line)) continue;
    if (OPT_NUM_RE.test(line) || FOCUS_RE.test(line)) return -1;
    return i;
  }
  return -1;
}

/**
 * Scan numbered options from startIdx to the end of the block (rule lines
 * inside the block — e.g. the divider above "5. Chat about this" — are
 * crossed). A non-option line indented deeper than the option above it is
 * that option's description.
 */
function scanNumbered(trimmed, startIdx, footerIdx) {
  const options = [];
  let last = null;
  for (let i = startIdx; i < trimmed.length; i++) {
    if (i === footerIdx) break;
    const line = trimmed[i];
    if (!line.trim()) continue;
    if (RULE_RE.test(line) || DASH_RULE_RE.test(line)) continue;
    if (parseTabStrip(line)) continue;
    const m = line.match(OPT_NUM_RE);
    if (m) {
      const raw = m[3].trim();
      const cb = raw.match(/^\[([^\]]*)\]\s*(.*)$/);
      last = {
        key: m[2],
        label: cb ? cb[2] : raw,
        description: null,
        focused: !!m[1],
        checked: cb ? cb[1].includes("✔") || cb[1].includes("☒") : null,
        choice: null,
      };
      last.indent = leadingWs(line);
      options.push(last);
      continue;
    }
    if (last && leadingWs(line) > last.indent && last.description === null) {
      last.description = line.trim();
    }
  }
  for (const o of options) delete o.indent;
  return options;
}

/**
 * Options of an unnumbered `❯` selection list: every line of the last
 * paragraph run (blank/rule separated) that contains a focused entry.
 */
function parseSelectOptions(trimmed) {
  const runs = [];
  let cur = [];
  for (const line of trimmed) {
    if (!line.trim() || RULE_RE.test(line)) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) runs.push(cur);
  for (let r = runs.length - 1; r >= 0; r--) {
    if (!runs[r].some((l) => {
      const m = l.match(FOCUS_RE);
      return !!m && m[1].trim().length > 0;
    })) continue;
    const options = [];
    for (const line of runs[r]) {
      const label = line.replace(/^\s*❯\s*/, "").trim();
      if (!label) continue;
      options.push({
        key: null,
        label,
        description: null,
        focused: /^\s*❯/.test(line),
        checked: null,
        choice: null,
      });
    }
    return options;
  }
  return [];
}

/**
 * Permission option semantics: allow-once for "Yes", allow-always for the
 * don't-ask-again variants (curly or straight apostrophe), auto-mode for
 * anything mentioning auto mode, deny for "No".
 */
function permissionChoice(label) {
  if (label === "Yes") return "allow-once";
  if (/^Yes, and don[`'’]t ask again/.test(label)) return "allow-always";
  if (label.includes("auto mode")) return "auto-mode";
  if (label === "No") return "deny";
  return null;
}

// ── askKeyPlan ────────────────────────────────────────────────────────

/**
 * Plan the key sequence that answers an AskUserQuestion dialog.
 *
 * questions: [{ question, multiSelect, options: [{ label }] }] — the
 * tool_use input shape. answers: [{ choices: [index...], text }] aligned
 * by index with questions.
 *
 * Returns one step per question — { expectQuestion: true, keys: [...] },
 * with { literal, after: ["Enter"] } added when the answer is free text
 * typed into the "Type something." option — plus, when the dialog has more
 * than one question or ends with a multiSelect, a final
 * { expectReview: true, keys: ["1"] } for the review screen.
 *
 * Throws Error with a clear message on length mismatch, out-of-range
 * choices, a single-select with not exactly one choice and no text, empty
 * text, text over 2000 characters, or text on a multiSelect question.
 */
export function askKeyPlan(questions, answers) {
  if (!Array.isArray(questions) || !Array.isArray(answers)) {
    throw new Error("askKeyPlan: questions and answers must be arrays");
  }
  if (answers.length !== questions.length) {
    throw new Error(`askKeyPlan: ${answers.length} answers for ${questions.length} questions — lengths must match`);
  }
  const steps = [];
  let lastMulti = false;
  questions.forEach((q, i) => {
    const multiSelect = !!(q && q.multiSelect);
    const optCount = Array.isArray(q && q.options) ? q.options.length : 0;
    const a = answers[i] || {};
    const choices = Array.isArray(a.choices) ? a.choices : [];
    const text = typeof a.text === "string" ? a.text : "";
    if (multiSelect) {
      if (text.trim()) {
        throw new Error(`askKeyPlan: question ${i + 1} is multiSelect — free text is not supported, toggle choices instead`);
      }
      if (!choices.length) {
        throw new Error(`askKeyPlan: question ${i + 1} is multiSelect — at least one choice is required`);
      }
      const keys = choices.map((c) => {
        checkChoice(c, optCount, i);
        return String(c + 1);
      });
      keys.push("Right");
      steps.push({ expectQuestion: true, keys });
      lastMulti = true;
    } else {
      lastMulti = false;
      if (choices.length === 1) {
        checkChoice(choices[0], optCount, i);
        steps.push({ expectQuestion: true, keys: [String(choices[0] + 1)] });
      } else {
        // Stripped BEFORE the checks: text made only of control bytes is the
        // empty-text error, and the length limit applies to what would
        // actually be typed.
        const literal = text.replace(/\r/g, "").replace(CONTROL_CHARS, "").trim();
        if (!literal) {
          throw new Error(`askKeyPlan: question ${i + 1} is single-select — exactly one choice or non-empty text is required`);
        }
        if (literal.length > 2000) {
          throw new Error(`askKeyPlan: question ${i + 1} text is ${literal.length} characters — the limit is 2000`);
        }
        steps.push({
          expectQuestion: true,
          keys: [String(optCount + 1)],
          literal: literal.replace(/\s*\r?\n\s*/g, " "),
          after: ["Enter"],
        });
      }
    }
  });
  if (questions.length > 1 || lastMulti) {
    steps.push({ expectReview: true, keys: ["1"] });
  }
  return steps;
}

function checkChoice(choice, optCount, qIndex) {
  if (!Number.isInteger(choice) || choice < 0 || choice >= optCount) {
    throw new Error(`askKeyPlan: question ${qIndex + 1} choice ${choice} is out of range (0..${optCount - 1})`);
  }
}

// ── pending ask from the transcript ───────────────────────────────────

/**
 * Find the pending AskUserQuestion in transcript JSONL text: the LAST
 * assistant tool_use named AskUserQuestion whose id has no later user
 * tool_result with the same tool_use_id. Unparseable lines are tolerated.
 *
 * Returns null, or { toolUseId, questions: [{ question, header,
 * multiSelect, options: [{ label, description }] }] }.
 */
export function pendingAskFromTranscript(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const asks = [];
  const askIdxById = new Map();
  const answered = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry && entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (entry.type === "assistant" && item.type === "tool_use" && item.name === "AskUserQuestion" && typeof item.id === "string") {
        askIdxById.set(item.id, asks.length);
        asks.push({ id: item.id, input: item.input });
      } else if (item.type === "tool_result" && typeof item.tool_use_id === "string" && askIdxById.has(item.tool_use_id)) {
        answered.add(item.tool_use_id);
      }
    }
  }
  for (let i = asks.length - 1; i >= 0; i--) {
    if (answered.has(asks[i].id)) continue;
    return normalizePendingAsk(asks[i].input, asks[i].id);
  }
  return null;
}

function normalizePendingAsk(input, toolUseId) {
  const questions = Array.isArray(input && input.questions) ? input.questions : [];
  return {
    toolUseId,
    questions: questions.map((q) => ({
      question: typeof q.question === "string" ? q.question : "",
      header: typeof q.header === "string" ? q.header : null,
      multiSelect: !!q.multiSelect,
      options: (Array.isArray(q.options) ? q.options : []).map((o) => ({
        label: typeof o.label === "string" ? o.label : "",
        description: typeof o.description === "string" ? o.description : null,
      })),
    })),
  };
}

/**
 * Read at most the tail of a transcript file (skipping the first partial
 * line when the file is cut) and return pendingAskFromTranscript over it.
 * A missing or unreadable file reads as null; this never throws.
 */
export function readPendingAsk(transcriptPath, { maxTailBytes = 2_000_000 } = {}) {
  try {
    const fh = openSync(transcriptPath, "r");
    try {
      const size = fstatSync(fh).size;
      const start = Math.max(0, size - maxTailBytes);
      const length = size - start;
      const buf = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fh, buf, got, length - got, start + got);
        if (n <= 0) break;
        got += n;
      }
      let text = buf.toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        text = nl >= 0 ? text.slice(nl + 1) : "";
      }
      return pendingAskFromTranscript(text);
    } finally {
      closeSync(fh);
    }
  } catch {
    return null;
  }
}

// ── slash command policy ──────────────────────────────────────────────

/**
 * Which chat input may be forwarded to the Supervisor as a slash command.
 *
 * Returns { allowed, command, modal, reason }: /compact (optional free
 * text, single line, 500 characters total), /context (no arguments or
 * "all"), /cost (no arguments, opens a modal panel). Anything else
 * starting with "/" is refused with the canonical reason; text that does
 * not start with "/" is not a command at all ({ allowed: false,
 * command: null, reason: null }).
 */
export function slashCommandPolicy(text) {
  const result = { allowed: false, command: null, modal: false, reason: null };
  if (typeof text !== "string" || !text.startsWith("/")) return result;
  const m = text.match(/^\/\S+/);
  const command = m ? m[0] : "/";
  const args = text.slice(command.length);
  if (command === "/compact") {
    if (/\r|\n/.test(text)) {
      return { allowed: false, command, modal: false, reason: "/compact must be a single line" };
    }
    if (text.length > 500) {
      return { allowed: false, command, modal: false, reason: "/compact is limited to 500 characters" };
    }
    return { allowed: true, command, modal: false, reason: null };
  }
  if (command === "/context") {
    const arg = args.trim();
    if (arg === "" || arg === "all") {
      return { allowed: true, command, modal: false, reason: null };
    }
    return { allowed: false, command, modal: false, reason: '/context takes no arguments (or the argument "all")' };
  }
  if (command === "/cost") {
    if (args.trim() === "") {
      return { allowed: true, command, modal: true, reason: null };
    }
    return { allowed: false, command, modal: false, reason: "/cost takes no arguments" };
  }
  return { allowed: false, command, modal: false, reason: "only /compact, /context and /cost can be sent from the chat" };
}

// ── command output from scrollback ────────────────────────────────────

/**
 * Extract the rendered output of a slash command from pane scrollback.
 *
 * /context: the lines after the LAST echo line `❯ /context...` up to (not
 * including) the next full-width rule. /cost: the panel lines after the
 * last `▔{20,}` banner up to (not including) the "Esc to cancel" line.
 * Trailing blank lines are trimmed, output is capped at 80 lines; "" when
 * the command's output is not in the scrollback.
 */
export function extractCommandOutput(scrollbackText, command) {
  if (typeof scrollbackText !== "string" || typeof command !== "string") return "";
  const lines = scrollbackText.split(/\r?\n/);
  if (command === "/context") {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*❯\s*\/context\b/.test(lines[i])) {
        return collectUntil(lines, i + 1, (l) => RULE_RE.test(l));
      }
    }
    return "";
  }
  if (command === "/cost") {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (BANNER_RE.test(lines[i])) {
        return collectUntil(lines, i + 1, (l) => l.trim() === "Esc to cancel");
      }
    }
    return "";
  }
  return "";
}

function collectUntil(lines, from, stopAt) {
  const out = [];
  for (let j = from; j < lines.length; j++) {
    if (stopAt(lines[j])) break;
    out.push(lines[j]);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(0, 80).join("\n");
}
