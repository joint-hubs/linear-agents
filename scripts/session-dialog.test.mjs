// scripts/session-dialog.test.mjs — the pure dialog library for the
// Supervisor cockpit (FOC-810, session-dialog.mjs).
//
// Pins the parser against real pane captures (scripts/fixtures/
// session-dialogs/): permission dialog, auto-mode select nudge, ask screens
// (single, multi-question, multiSelect, review, type-something), the idle
// prompt between dialogs (echoed `❯ MOCK-TOOL...` lines must never read as
// a dialog), plus askKeyPlan, pendingAskFromTranscript, readPendingAsk,
// slashCommandPolicy and extractCommandOutput.
//
// Everything is pure: fixtures are read read-only; the only writes are the
// mkdtemp transcript for the readPendingAsk tail test.
//
// Run: node --test scripts/session-dialog.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  askKeyPlan,
  extractCommandOutput,
  parseDialog,
  pendingAskFromTranscript,
  readPendingAsk,
  slashCommandPolicy,
} from "./session-dialog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "session-dialogs");
const readFixture = (name) => readFileSync(join(FIXTURES, name), "utf8");

test("permission-bash: full dialog shape", () => {
  const d = parseDialog(readFixture("permission-bash.txt"));
  assert.ok(d, "permission dialog must parse");
  assert.equal(d.kind, "permission");
  assert.equal(d.title, "Bash command");
  assert.equal(d.command, "npm audit --json");
  assert.equal(d.question, null);
  assert.equal(d.tabs, null);
  assert.equal(d.footer, "Esc to cancel · Tab to amend");
  assert.ok(d.lines.includes("Do you want to proceed?"));
  assert.equal(d.options.length, 4);
  assert.deepEqual(d.options[0], {
    key: "1", label: "Yes", description: null, focused: true, checked: null, choice: "allow-once",
  });
  assert.equal(d.options[1].label, "Yes, and don’t ask again for: npm audit *");
  assert.equal(d.options[1].choice, "allow-always");
  assert.equal(d.options[1].focused, false);
  assert.equal(d.options[2].choice, "auto-mode");
  assert.ok(d.options[2].label.includes("switch to auto mode"));
  assert.equal(d.options[3].label, "No");
  assert.equal(d.options[3].choice, "deny");
  assert.equal(d.options[3].focused, false);
});

test("auto-mode nudge: select list with ❯ focus, focus move changes it", () => {
  const d = parseDialog(readFixture("auto-mode-nudge.txt"));
  assert.ok(d, "select dialog must parse");
  assert.equal(d.kind, "select");
  assert.equal(d.title, "Make auto mode your default permission mode?");
  assert.equal(d.command, null);
  assert.equal(d.question, null);
  assert.equal(d.tabs, null);
  assert.equal(d.footer, null);
  assert.equal(d.options.length, 2);
  assert.deepEqual(d.options[0], {
    key: null, label: "Yes, set auto mode as my default permission mode",
    description: null, focused: true, checked: null, choice: null,
  });
  assert.equal(d.options[1].label, "No, keep manual mode");
  assert.equal(d.options[1].focused, false);

  const down = parseDialog(readFixture("auto-mode-nudge-down.txt"));
  assert.equal(down.kind, "select");
  assert.equal(down.options[0].focused, false);
  assert.equal(down.options[1].focused, true);
  assert.notEqual(down.id, d.id);
});

test("idle captures: no dialog, echoed ❯ lines never count", () => {
  assert.equal(parseDialog(readFixture("idle-after-cancel.txt")), null);
  assert.equal(parseDialog(readFixture("idle-after-answer.txt")), null);
});

test("a single ❯ prompt line is not a select dialog (at least two options required)", () => {
  // A typed-but-unsent prompt whose closing rule scrolled off: the block
  // after the last rule is one focused line — never a dialog.
  const pane = [
    "  some earlier output",
    "────────────────────────────────",
    "❯ fix the widget",
  ].join("\n");
  assert.equal(parseDialog(pane), null);
});

test("ask-single: single question screen", () => {
  const d = parseDialog(readFixture("ask-single.txt"));
  assert.ok(d, "ask dialog must parse");
  assert.equal(d.kind, "ask");
  assert.equal(d.title, "Audit");
  assert.deepEqual(d.tabs, [{ label: "Audit", done: false }]);
  assert.equal(d.question, "npm audit found 2 critical advisories in devDependencies. What now?");
  assert.equal(d.command, null);
  assert.equal(d.footer, "Enter to select · ↑/↓ to navigate · Esc to cancel");
  assert.equal(d.options.length, 5);
  assert.deepEqual(d.options[0], {
    key: "1", label: "Override tinypool", description: "Pin the patched version, ticket the rest",
    focused: true, checked: null, choice: null,
  });
  assert.equal(d.options[1].label, "Separate ticket");
  assert.equal(d.options[1].description, "Nothing now");
  assert.equal(d.options[2].description, "Major bump");
  assert.equal(d.options[3].key, "4");
  assert.equal(d.options[3].label, "Type something.");
  assert.equal(d.options[3].description, null);
  assert.equal(d.options[3].focused, false);
  assert.equal(d.options[4].key, "5");
  assert.equal(d.options[4].label, "Chat about this");
  assert.equal(d.options[4].description, null);
});

test("ask-multi q1: tab strip and question", () => {
  const d = parseDialog(readFixture("ask-multi-q1.txt"));
  assert.equal(d.kind, "ask");
  assert.equal(d.title, "Export");
  assert.deepEqual(d.tabs, [
    { label: "Export", done: false },
    { label: "Checks", done: false },
    { label: "Submit", done: true },
  ]);
  assert.equal(d.question, "Should the export land in v1?");
  assert.equal(d.options[0].label, "Narrow the AC");
  assert.equal(d.options[0].description, "Export moves out of v1");
  assert.equal(d.options[0].focused, true);
  assert.equal(d.options[1].description, "One more DEV round");
  assert.equal(d.options[2].label, "Leave as a DoD gap");
});

test("ask-multi q2: multiSelect checkboxes, toggled vs not", () => {
  const d = parseDialog(readFixture("ask-multi-q2.txt"));
  assert.equal(d.kind, "ask");
  assert.deepEqual(d.tabs, [
    { label: "Export", done: true },
    { label: "Checks", done: false },
    { label: "Submit", done: true },
  ]);
  assert.equal(d.question, "Which checks should run before the PR?");
  assert.equal(d.options[0].label, "Unit tests");
  assert.equal(d.options[0].checked, false);
  assert.equal(d.options[0].description, "npm test");
  assert.equal(d.options[1].label, "npm audit");
  assert.equal(d.options[1].checked, false);
  assert.equal(d.options[2].label, "E2E");
  assert.equal(d.options[2].description, "browser journey");
  assert.equal(d.options[3].label, "Type something");
  assert.equal(d.options[3].checked, false);
  assert.equal(d.options[3].description, "Submit");

  const toggled = parseDialog(readFixture("ask-multi-q2-toggled.txt"));
  assert.equal(toggled.kind, "ask");
  assert.equal(toggled.options[0].checked, true);
  assert.equal(toggled.options[1].checked, true);
  assert.equal(toggled.options[2].checked, false);
});

test("ask-multi review screen", () => {
  const d = parseDialog(readFixture("ask-multi-review.txt"));
  assert.equal(d.kind, "ask-review");
  assert.deepEqual(d.tabs, [
    { label: "Export", done: true },
    { label: "Checks", done: true },
    { label: "Submit", done: true },
  ]);
  assert.equal(d.question, null);
  assert.equal(d.footer, null);
  assert.equal(d.options.length, 2);
  assert.equal(d.options[0].key, "1");
  assert.equal(d.options[0].label, "Submit answers");
  assert.equal(d.options[0].focused, true);
  assert.equal(d.options[1].label, "Cancel");
  assert.equal(d.options[1].focused, false);
});

test("single multiSelect: question, toggled, review", () => {
  const d = parseDialog(readFixture("ask-single-multi.txt"));
  assert.equal(d.kind, "ask");
  assert.deepEqual(d.tabs, [
    { label: "Review", done: false },
    { label: "Submit", done: true },
  ]);
  assert.equal(d.question, "Which reviewers should look at this PR?");
  assert.equal(d.options[0].label, "Security");
  assert.equal(d.options[0].checked, false);
  assert.equal(d.options[0].description, "trust boundaries");
  assert.equal(d.options[1].label, "Frontend");
  assert.equal(d.options[2].label, "Docs");
  assert.equal(d.options[3].label, "Type something");

  const toggled = parseDialog(readFixture("ask-single-multi-toggled.txt"));
  assert.equal(toggled.kind, "ask");
  assert.equal(toggled.options[0].checked, true);
  assert.equal(toggled.options[1].checked, false);
  assert.equal(toggled.options[2].checked, true);

  const review = parseDialog(readFixture("ask-single-multi-review.txt"));
  assert.equal(review.kind, "ask-review");
  assert.equal(review.question, null);
  assert.deepEqual(review.options.map((o) => o.label), ["Submit answers", "Cancel"]);
});

test("type-something focus and typed text", () => {
  const focused = parseDialog(readFixture("ask-type-something.txt"));
  assert.equal(focused.kind, "ask");
  assert.equal(focused.options[3].key, "4");
  assert.equal(focused.options[3].label, "Type something.");
  assert.equal(focused.options[3].focused, true);

  const typed = parseDialog(readFixture("ask-typed.txt"));
  assert.equal(typed.kind, "ask");
  assert.equal(typed.options[3].label, "Diagnose first, then decide");
  assert.equal(typed.options[3].focused, true);
});

test("id: stable for the same text, distinct across dialogs", () => {
  const a = parseDialog(readFixture("permission-bash.txt"));
  const b = parseDialog(readFixture("permission-bash.txt"));
  assert.equal(b.id, a.id);
  assert.match(a.id, /^[0-9a-f]{12}$/);
  const other = parseDialog(readFixture("ask-single.txt"));
  assert.notEqual(other.id, a.id);
});

test("slash scrollbacks are not dialogs", () => {
  assert.equal(parseDialog(readFixture("slash-context-scrollback.txt")), null);
  assert.equal(parseDialog(readFixture("slash-cost-scrollback.txt")), null);
});

test("askKeyPlan: single choice", () => {
  const q = { question: "Q?", multiSelect: false, options: [{ label: "a" }, { label: "b" }, { label: "c" }] };
  const steps = askKeyPlan([q], [{ choices: [0], text: "" }]);
  assert.deepEqual(steps, [{ expectQuestion: true, keys: ["1"] }]);
  const steps2 = askKeyPlan([q], [{ choices: [2] }]);
  assert.deepEqual(steps2, [{ expectQuestion: true, keys: ["3"] }]);
});

test("askKeyPlan: single text answer", () => {
  const q = { question: "Q?", multiSelect: false, options: [{ label: "a" }, { label: "b" }, { label: "c" }] };
  const steps = askKeyPlan([q], [{ choices: [], text: "  Do it now\nplease  " }]);
  assert.deepEqual(steps, [{
    expectQuestion: true, keys: ["4"], literal: "Do it now please", after: ["Enter"],
  }]);
});

test("askKeyPlan: control bytes never reach the literal typed with send-keys -l", () => {
  const q = { question: "Q?", multiSelect: false, options: [{ label: "a" }, { label: "b" }, { label: "c" }] };
  // ESC (0x1b) would press the Escape key, 0x03 is Ctrl-C, 0x9b a C1 CSI —
  // none of them may survive into the literal.
  const steps = askKeyPlan([q], [{ choices: [], text: "fix\u001b[A the\u0003 bug\u009b, then\r\nship it" }]);
  assert.deepEqual(steps, [{
    expectQuestion: true,
    keys: ["4"],
    literal: "fix[A the bug, then ship it",
    after: ["Enter"],
  }]);
  assert.ok(!/[\u0000-\u001F\u007F-\u009F]/.test(steps[0].literal), "no control characters in the literal");
});

test("askKeyPlan: text that is only control bytes is the empty-text error", () => {
  const q = { question: "Q?", multiSelect: false, options: [{ label: "a" }, { label: "b" }, { label: "c" }] };
  assert.throws(() => askKeyPlan([q], [{ choices: [], text: "\u001b\u0003\u009b\r" }]), /non-empty text/);
});

test("askKeyPlan: two questions with review step", () => {
  const q1 = { question: "Q1?", multiSelect: false, options: [{ label: "a" }, { label: "b" }, { label: "c" }] };
  const q2 = { question: "Q2?", multiSelect: true, options: [{ label: "x" }, { label: "y" }, { label: "z" }] };
  const steps = askKeyPlan([q1, q2], [{ choices: [0] }, { choices: [0, 1] }]);
  assert.deepEqual(steps, [
    { expectQuestion: true, keys: ["1"] },
    { expectQuestion: true, keys: ["1", "2", "Right"] },
    { expectReview: true, keys: ["1"] },
  ]);
});

test("askKeyPlan: single multiSelect still goes through review", () => {
  const q = { question: "Q?", multiSelect: true, options: [{ label: "a" }, { label: "b" }, { label: "c" }] };
  const steps = askKeyPlan([q], [{ choices: [0, 2] }]);
  assert.deepEqual(steps, [
    { expectQuestion: true, keys: ["1", "3", "Right"] },
    { expectReview: true, keys: ["1"] },
  ]);
});

test("askKeyPlan: validation errors", () => {
  const q1 = { question: "Q1?", multiSelect: false, options: [{ label: "a" }, { label: "b" }, { label: "c" }] };
  const qm = { question: "QM?", multiSelect: true, options: [{ label: "a" }, { label: "b" }] };
  assert.throws(() => askKeyPlan([q1], []), /lengths must match/);
  assert.throws(() => askKeyPlan([q1], [{ choices: [3] }]), /out of range/);
  assert.throws(() => askKeyPlan([q1], [{ choices: [-1] }]), /out of range/);
  assert.throws(() => askKeyPlan([q1], [{ choices: [] }]), /exactly one choice or non-empty text/);
  assert.throws(() => askKeyPlan([q1], [{ choices: [0, 1] }]), /exactly one choice or non-empty text/);
  assert.throws(() => askKeyPlan([q1], [{ choices: [], text: "   " }]), /non-empty text/);
  assert.throws(() => askKeyPlan([q1], [{ choices: [], text: "x".repeat(2001) }]), /limit is 2000/);
  assert.throws(() => askKeyPlan([qm], [{ choices: [], text: "no" }]), /multiSelect.*free text is not supported/is);
  assert.throws(() => askKeyPlan([qm], [{ choices: [] }]), /at least one choice/);
  assert.throws(() => askKeyPlan([qm], [{ choices: [5] }]), /out of range/);
});

test("pendingAskFromTranscript: pending and answered transcripts", () => {
  const pending = pendingAskFromTranscript(readFixture("pending-ask-multi.jsonl"));
  assert.ok(pending, "pending transcript must yield an ask");
  assert.equal(pending.toolUseId, "toolu_mock_0450d5b7-a1be-4ca7-8270-405f3a99368a");
  assert.equal(pending.questions.length, 2);
  assert.equal(pending.questions[0].header, "Export");
  assert.equal(pending.questions[0].question, "Should the export land in v1?");
  assert.equal(pending.questions[0].multiSelect, false);
  assert.deepEqual(pending.questions[0].options[0], { label: "Narrow the AC", description: "Export moves out of v1" });
  assert.equal(pending.questions[1].header, "Checks");
  assert.equal(pending.questions[1].multiSelect, true);
  assert.deepEqual(pending.questions[1].options.map((o) => o.label), ["Unit tests", "npm audit", "E2E"]);
  assert.equal(pendingAskFromTranscript(readFixture("answered-asks.jsonl")), null);
  assert.equal(pendingAskFromTranscript(""), null);
});

test("pendingAskFromTranscript: tolerates garbage lines", () => {
  const text = "not json at all\n{\n" + readFixture("pending-ask-multi.jsonl");
  const pending = pendingAskFromTranscript(text);
  assert.ok(pending);
  assert.equal(pending.questions.length, 2);
});

test("readPendingAsk: missing file, temp file, tail cut", () => {
  assert.equal(readPendingAsk(join(FIXTURES, "does-not-exist.jsonl")), null);
  assert.equal(readPendingAsk(FIXTURES), null, "a directory reads as null, never throws");

  const dir = mkdtempSync(join(tmpdir(), "la-session-dialog-"));
  try {
    const path = join(dir, "transcript.jsonl");
    const content = readFixture("pending-ask-multi.jsonl");
    writeFileSync(path, content, "utf8");
    const full = readPendingAsk(path);
    assert.ok(full);
    assert.equal(full.questions[1].header, "Checks");
    // Tail cut that drops a partial first line but keeps the pending ask.
    const cut = readPendingAsk(path, { maxTailBytes: content.length - 100 });
    assert.ok(cut);
    assert.equal(cut.questions[1].header, "Checks");
    // A tiny tail must not throw either way.
    readPendingAsk(path, { maxTailBytes: 10 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slashCommandPolicy table", () => {
  assert.deepEqual(slashCommandPolicy("hello"), { allowed: false, command: null, modal: false, reason: null });
  assert.deepEqual(slashCommandPolicy("/compact"), { allowed: true, command: "/compact", modal: false, reason: null });
  assert.deepEqual(slashCommandPolicy("/compact focus tests"), { allowed: true, command: "/compact", modal: false, reason: null });
  assert.equal(slashCommandPolicy("/compact " + "x".repeat(491)).allowed, true, "500 chars total is allowed");
  assert.equal(slashCommandPolicy("/compact " + "x".repeat(492)).allowed, false, "501 chars total is refused");
  assert.equal(slashCommandPolicy("/compact a\nb").allowed, false);
  assert.deepEqual(slashCommandPolicy("/context"), { allowed: true, command: "/context", modal: false, reason: null });
  assert.equal(slashCommandPolicy("/context all").allowed, true);
  assert.equal(slashCommandPolicy("/context all extra").allowed, false);
  assert.equal(slashCommandPolicy("/context foo").allowed, false);
  assert.deepEqual(slashCommandPolicy("/cost"), { allowed: true, command: "/cost", modal: true, reason: null });
  assert.equal(slashCommandPolicy("/cost now").allowed, false);
  const refused = slashCommandPolicy("/init");
  assert.equal(refused.allowed, false);
  assert.equal(refused.command, "/init");
  assert.equal(refused.reason, "only /compact, /context and /cost can be sent from the chat");
});

test("extractCommandOutput: /context and /cost scrollback", () => {
  const context = extractCommandOutput(readFixture("slash-context-scrollback.txt"), "/context");
  assert.ok(context.length > 0, "/context output must be found");
  assert.ok(context.includes("tokens"));
  assert.ok(!/─{20,}/.test(context), "must stop before the closing rule");
  assert.ok(context.split("\n").length <= 80);
  assert.ok(!context.includes("❯"), "must not include the prompt line below the output");

  const cost = extractCommandOutput(readFixture("slash-cost-scrollback.txt"), "/cost");
  assert.ok(cost.length > 0, "/cost panel must be found");
  assert.ok(cost.includes("Total cost"));
  assert.ok(!cost.includes("Esc to cancel"), "must stop before the Esc hint");
  assert.ok(!/▔{20,}/.test(cost), "must not include the banner");

  assert.equal(extractCommandOutput(readFixture("slash-cost-scrollback.txt"), "/context"), "");
  assert.equal(extractCommandOutput(readFixture("slash-context-scrollback.txt"), "/rm"), "");
});

test("ask-rule-override: permission with reason ask-rule", () => {
  const d = parseDialog(readFixture("ask-rule-override.txt"));
  assert.ok(d, "dialog must parse");
  assert.equal(d.kind, "permission");
  assert.equal(d.title, "Bash command");
  assert.equal(d.command, "rm -rf /tmp/fenix-child/dev-2/node_modules; ls node_modules 2>/dev/null");
  assert.deepEqual(d.options.map((o) => o.label), ["Yes", "No"]);
  assert.deepEqual(d.options.map((o) => o.choice), ["allow-once", "deny"]);
  assert.equal(d.footer, "Esc to cancel · Tab to amend");
  assert.deepEqual(d.reason, { type: "ask-rule", detail: "Bash(rm -rf:*)" });
});

test("classifier-blocked: permission with reason classifier", () => {
  const d = parseDialog(readFixture("classifier-blocked.txt"));
  assert.ok(d, "dialog must parse");
  assert.equal(d.kind, "permission");
  assert.equal(d.title, "Bash command");
  assert.equal(d.command, "node scripts/test-run.mjs team 2>&1 | tail -8");
  assert.deepEqual(d.options.map((o) => o.choice), ["allow-once", "deny"]);
  assert.deepEqual(d.reason, { type: "classifier", detail: "External System Writes" });
});

test("reason is null on an ordinary permission and on ask dialogs", () => {
  assert.equal(parseDialog(readFixture("permission-bash.txt")).reason, null);
  assert.equal(parseDialog(readFixture("ask-single.txt")).reason, null);
});
