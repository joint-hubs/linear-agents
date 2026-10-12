// scripts/supervisor-session-hook.test.mjs — the session hook that records
// what the Supervisor's Claude Code session is doing (FOC-783,
// supervisor-session-hook.mjs).
//
// The properties worth protecting:
//   · every event maps to its state (SessionStart/UserPromptSubmit/PostToolUse/
//     Stop/SessionEnd) and a Notification gates needs-input on the two pinned
//     types (permission_prompt, elicitation_dialog) or, when the type field is
//     missing, on a message matching /permission|needs your (input|approval)/i;
//     any other notification keeps the state;
//   · the notification is recorded for Notification and reset to null on the
//     state-mapping events;
//   · an unchanged PostToolUse does NOT rewrite the file (no churn), while
//     SessionStart / SessionEnd ALWAYS write a fresh updatedAt — a restart
//     with `claude --continue` reproduces the same content, and a skipped
//     write would look to the host like a session that never started;
//   · a new session_id after SessionStart replaces the old one;
//   · malformed or empty stdin and an unknown event never write and never
//     fail — the hook ALWAYS exits 0 with empty stdout and stderr.
//
// Everything runs through the LA_DATA_HOME seam pointed at a mkdtemp dir set
// BEFORE the import; the hook itself runs as a child process with the JSON
// payload on stdin and the event in argv[2], exactly as the harness invokes it.
//
// Run: node scripts/supervisor-session-hook.test.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { nextSessionState } from "./supervisor-session-hook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "scripts", "supervisor-session-hook.mjs");

const HOME = mkdtempSync(join(tmpdir(), "la-sup-session-"));
process.env.LA_DATA_HOME = HOME;
const SESSION = join(HOME, "supervisor", "session.json");

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

const fail = (msg) => { throw new Error(msg); };
const eq = (a, b, label) => { if (a !== b) fail(`${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

// The harness feeds the payload on stdin and names the event in argv[2].
// stdout/stderr are asserted HERE so every invocation doubles as the
// must-print-nothing check.
function runHook(payload, { event, dataHome = HOME } = {}) {
  const r = spawnSync(
    process.execPath,
    [HOOK, ...(event ? [event] : [])],
    {
      encoding: "utf8",
      input: typeof payload === "string" ? payload : JSON.stringify(payload ?? {}),
      env: { ...process.env, LA_DATA_HOME: dataHome },
    },
  );
  const out = { code: r.status, stdout: r.stdout, stderr: r.stderr };
  eq(out.code, 0, "exit code");
  eq(out.stdout, "", "stdout");
  eq(out.stderr, "", "stderr");
  return out;
}

const readSession = () => JSON.parse(readFileSync(SESSION, "utf8"));
const sessionExists = () => existsSync(SESSION);

const payloadFor = (sessionId, extra = {}) => ({
  session_id: sessionId,
  transcript_path: `/tmp/${sessionId}.jsonl`,
  cwd: "/repo",
  ...extra,
});

console.log("\nsupervisor-session-hook: the state mapping, live through the child");

test("SessionStart → idle", () => {
  runHook(payloadFor("s1"), { event: "SessionStart" });
  const s = readSession();
  eq(s.state, "idle", "state");
  eq(s.sessionId, "s1", "sessionId");
  eq(s.transcriptPath, "/tmp/s1.jsonl", "transcriptPath");
  eq(s.cwd, "/repo", "cwd");
  eq(s.notification, null, "notification");
  if (Number.isNaN(Date.parse(s.updatedAt))) fail(`updatedAt not ISO: ${s.updatedAt}`);
});

test("UserPromptSubmit → busy", () => {
  runHook(payloadFor("s1"), { event: "UserPromptSubmit" });
  eq(readSession().state, "busy", "state");
});

test("PostToolUse → busy, notification null", () => {
  runHook(payloadFor("s1"), { event: "PostToolUse" });
  const s = readSession();
  eq(s.state, "busy", "state");
  eq(s.notification, null, "notification");
});

test("Notification permission_prompt → needs-input, recorded", () => {
  runHook(
    { ...payloadFor("s1"), message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" },
    { event: "Notification" },
  );
  const s = readSession();
  eq(s.state, "needs-input", "state");
  eq(s.notification.type, "permission_prompt", "notification.type");
  eq(s.notification.message, "Claude needs your permission to use Bash", "notification.message");
});

test("Notification elicitation_dialog → needs-input, recorded", () => {
  runHook(payloadFor("s1"), { event: "PostToolUse" }); // back to busy first
  runHook(
    { ...payloadFor("s1"), message: "Claude is waiting for your input", notification_type: "elicitation_dialog" },
    { event: "Notification" },
  );
  const s = readSession();
  eq(s.state, "needs-input", "state");
  eq(s.notification.type, "elicitation_dialog", "notification.type");
});

test("a Notification without a type falls back to the message regex", () => {
  runHook(payloadFor("s1"), { event: "PostToolUse" }); // back to busy first
  runHook(
    { ...payloadFor("s1"), message: "Claude needs your approval to use Bash" },
    { event: "Notification" },
  );
  const s = readSession();
  eq(s.state, "needs-input", "state");
  eq(s.notification.type, null, "notification.type");
});

test("a Notification without a type and a non-matching message keeps the state", () => {
  runHook(payloadFor("s1"), { event: "PostToolUse" }); // busy
  runHook(
    { ...payloadFor("s1"), message: "Task finished in the background" },
    { event: "Notification" },
  );
  const s = readSession();
  eq(s.state, "busy", "state kept");
  eq(s.notification.message, "Task finished in the background", "notification.message");
});

test("another Notification keeps the previous state but records it", () => {
  runHook(payloadFor("s1"), { event: "PostToolUse" }); // pin the state to busy first
  runHook(
    { ...payloadFor("s1"), message: "Waiting for input", notification_type: "idle_prompt" },
    { event: "Notification" },
  );
  const s = readSession();
  eq(s.state, "busy", "state kept");
  eq(s.notification.type, "idle_prompt", "notification.type");
});

test("the next PostToolUse → busy with the notification reset to null", () => {
  runHook(payloadFor("s1"), { event: "PostToolUse" });
  const s = readSession();
  eq(s.state, "busy", "state");
  eq(s.notification, null, "notification");
});

test("Stop → idle", () => {
  runHook(payloadFor("s1"), { event: "Stop" });
  eq(readSession().state, "idle", "state");
});

test("a new session_id after SessionStart replaces the old", () => {
  runHook(payloadFor("s2"), { event: "SessionStart" });
  const s = readSession();
  eq(s.sessionId, "s2", "sessionId");
  eq(s.transcriptPath, "/tmp/s2.jsonl", "transcriptPath");
  eq(s.state, "idle", "state");
});

test("SessionEnd → ended", () => {
  runHook(payloadFor("s2"), { event: "SessionEnd" });
  eq(readSession().state, "ended", "state");
});

test("the event falls back to payload.hook_event_name when argv[2] is missing", () => {
  runHook({ ...payloadFor("s2"), hook_event_name: "UserPromptSubmit" });
  eq(readSession().state, "busy", "state");
});

console.log("\nsupervisor-session-hook: no churn, no write");

test("an unchanged PostToolUse does not rewrite the file", () => {
  const before = readFileSync(SESSION, "utf8");
  const mtime = statSync(SESSION).mtimeMs;
  runHook(payloadFor("s2"), { event: "PostToolUse" });
  eq(readFileSync(SESSION, "utf8"), before, "content unchanged");
  eq(statSync(SESSION).mtimeMs, mtime, "mtime unchanged (no rewrite)");
});

test("an unchanged SessionStart ALWAYS rewrites the file with a fresh updatedAt", () => {
  const before = readSession(); // same session_id etc. — only state/updatedAt differ
  const mtime = statSync(SESSION).mtimeMs;
  runHook(payloadFor("s2"), { event: "SessionStart" });
  const s = readSession();
  eq(s.state, "idle", "state");
  eq(s.sessionId, before.sessionId, "same session (a `claude --continue` restart)");
  if (statSync(SESSION).mtimeMs === mtime) fail("SessionStart skipped the write");
  if (s.updatedAt === before.updatedAt) fail("updatedAt not refreshed");
});

test("missing payload fields keep the previous file's values", () => {
  const before = readSession();
  const mtime = statSync(SESSION).mtimeMs;
  runHook({ session_id: "s2" }, { event: "Stop" });
  const s = readSession();
  eq(s.transcriptPath, before.transcriptPath, "transcriptPath kept");
  eq(s.cwd, before.cwd, "cwd kept");
  eq(s.state, "idle", "state");
  if (statSync(SESSION).mtimeMs !== mtime) {
    // A write DID happen here — the fields above still had to be kept.
    eq(s.sessionId, "s2", "sessionId kept after a real write");
  }
});

test("malformed stdin → exit 0, no output, no write", () => {
  const before = readFileSync(SESSION, "utf8");
  const mtime = statSync(SESSION).mtimeMs;
  runHook("this is { not json", { event: "PostToolUse" });
  eq(readFileSync(SESSION, "utf8"), before, "content unchanged");
  eq(statSync(SESSION).mtimeMs, mtime, "mtime unchanged");
});

test("empty stdin → exit 0, no output, no write", () => {
  const before = readFileSync(SESSION, "utf8");
  runHook("", { event: "PostToolUse" });
  eq(readFileSync(SESSION, "utf8"), before, "content unchanged");
});

test("unknown event → no write (and no file when there is none yet)", () => {
  const fresh = mkdtempSync(join(tmpdir(), "la-sup-session-fresh-"));
  try {
    runHook(payloadFor("s9"), { event: "SomethingElse", dataHome: fresh });
    if (existsSync(join(fresh, "supervisor", "session.json"))) fail("unknown event wrote a file");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

console.log("\nsupervisor-session-hook: nextSessionState (unit)");

const NOW = new Date("2026-10-12T12:00:00.000Z");

test("unknown event → null (no write)", () => {
  eq(nextSessionState(null, "PreToolUse", payloadFor("s1"), NOW), null, "null");
  eq(nextSessionState(null, undefined, payloadFor("s1"), NOW), null, "null");
});

test("Notification without a previous file keeps state null but records", () => {
  const s = nextSessionState(null, "Notification", { notification_type: "idle_prompt", message: "m" }, NOW);
  eq(s.state, null, "state");
  eq(s.notification.type, "idle_prompt", "notification.type");
});

test("a permission prompt with no previous file still flips the state", () => {
  const s = nextSessionState(null, "Notification", { notification_type: "permission_prompt" }, NOW);
  eq(s.state, "needs-input", "state");
});

test("the message-regex fallback fires only when the type field is missing", () => {
  const s = nextSessionState(null, "Notification", { message: "Claude needs your approval to use Bash" }, NOW);
  eq(s.state, "needs-input", "state");
  eq(nextSessionState(null, "Notification",
    { message: "Claude needs your approval", notification_type: "idle_prompt" }, NOW).state,
  null, "an explicit non-gating type wins over the regex");
});

test("identical state → null (the no-churn rule, pure form)", () => {
  const prev = { sessionId: "s1", transcriptPath: "/tmp/s1.jsonl", cwd: "/repo", state: "busy", notification: null };
  eq(nextSessionState(prev, "PostToolUse", payloadFor("s1"), NOW), null, "null");
  eq(nextSessionState({ ...prev, notification: { type: "idle_prompt", message: "m" } },
    "Notification", { notification_type: "idle_prompt", message: "m" }, NOW), null, "null");
});

test("SessionStart / SessionEnd ALWAYS write, even on identical content (pure form)", () => {
  const prev = { sessionId: "s1", transcriptPath: "/tmp/s1.jsonl", cwd: "/repo", state: "idle", notification: null };
  const started = nextSessionState(prev, "SessionStart", payloadFor("s1"), NOW);
  if (!started) fail("SessionStart returned null — it must always write");
  eq(started.updatedAt, NOW.toISOString(), "fresh updatedAt");
  const ended = nextSessionState({ ...prev, state: "ended" }, "SessionEnd", payloadFor("s1"), NOW);
  if (!ended) fail("SessionEnd returned null — it must always write");
  eq(ended.state, "ended", "state");
});

test("a session_id change is a write even at the same state", () => {
  const prev = { sessionId: "s1", transcriptPath: "/tmp/s1.jsonl", cwd: "/repo", state: "idle", notification: null };
  const s = nextSessionState(prev, "Stop", payloadFor("s2"), NOW);
  if (!s) fail("null — a new session must write");
  eq(s.sessionId, "s2", "sessionId");
  eq(s.state, "idle", "state");
});

console.log("\nsupervisor-session-hook: the settings wire-up");

const SETTINGS = JSON.parse(readFileSync(join(ROOT, "agents", "supervisor", "settings.json"), "utf8"));

for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "PostToolUse", "SessionEnd"]) {
  test(`settings.json wires the hook for ${event}`, () => {
    const entries = SETTINGS.hooks[event];
    if (!Array.isArray(entries) || !entries.length) fail(`no ${event} entry`);
    const found = entries.some((e) =>
      (e.hooks ?? []).some((h) => typeof h.command === "string"
        && h.command.includes("supervisor-session-hook.mjs")
        && h.command.split(" ").pop() === event));
    if (!found) fail(`no supervisor-session-hook command for ${event}`);
  });
}

test("settings.json PostToolUse entry matches every tool (matcher *)", () => {
  const entry = SETTINGS.hooks.PostToolUse.find((e) =>
    (e.hooks ?? []).some((h) => h.command?.includes("supervisor-session-hook.mjs")));
  eq(entry.matcher, "*", "matcher");
});

try {
  rmSync(HOME, { recursive: true, force: true });
} catch {
  /* best effort */
}

console.log(`\nsupervisor-session-hook: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}