// Task-id recognition shared by the ledger and the backfill (FOC-221).
//
// The prefix list used to live twice — once in ledger.mjs (kickoff inference)
// and once as a local copy in backfill-task-ids.mjs — and it drifted: the
// backfill never knew FOC-, so FOC- runs stayed untagged no matter how loudly
// their kickoffs announced the task. Both now import the one TASK_ID_RE.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inferTaskIdFromText, TASK_ID_RE } from "./ledger.mjs";
import { backfillDecision, firstUserMessage, userText } from "./backfill-task-ids.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// --- the shared regex: every squad's prefix matches ------------------------
check("FOC-221 is recognised", inferTaskIdFromText("Task(implementer): FOC-221 — qualify canonical usage") === "FOC-221");
check("FEN-30 is recognised", inferTaskIdFromText("Weź task FEN-98…") === "FEN-98");
check("JOI is recognised", inferTaskIdFromText("kickoff for JOI-61 pipeline") === "JOI-61");
check("PISI is recognised", inferTaskIdFromText("DEV task PISI-98: …") === "PISI-98");
check("lowercase input is normalised to the canonical form",
  inferTaskIdFromText("start foc-221 now") === "FOC-221");
check("first match wins", inferTaskIdFromText("follows FEN-30, built on JOI-7") === "FEN-30");

// Not every UPPERCASE-NNN shape is a task: unknown teams stay unrecognised.
check("unknown team prefix is not matched", inferTaskIdFromText("see ABC-123 for details") === null);
check("prefix must be followed by digits, not more letters",
  inferTaskIdFromText("run focus-221 to the end") === null);
check("digits beyond 5 are not a task id", inferTaskIdFromText("FEN-123456 overflow") === null);
check("no digits is no task id", inferTaskIdFromText("task FEN- is incomplete") === null);
check("non-text is null", inferTaskIdFromText(null) === null && inferTaskIdFromText(42) === null);
check("regex itself is the exported one", TASK_ID_RE instanceof RegExp && TASK_ID_RE.source.includes("FOC"));

// --- backfill decision: pure core of the CLI -------------------------------
check("untagged manifest with a FOC- kickoff proposes the id",
  backfillDecision({ runId: "r1" }, "Task: FOC-221 qualify usage").status === "propose"
  && backfillDecision({ runId: "r1" }, "Task: FOC-221 qualify usage").taskId === "FOC-221");
check("missing kickoff text skips, never guesses",
  backfillDecision({ runId: "r2" }, null).status === "skip");
check("kickoff without a task reference skips",
  backfillDecision({ runId: "r3" }, "please look into the pipeline").status === "skip");
check("branch-tagged manifests are skipped unless --recheck-branch",
  backfillDecision({ runId: "r4", gitBranch: "fen-98-gantt" }, "Task: FOC-221").status === "skip"
  && backfillDecision({ runId: "r4", gitBranch: "fen-98-gantt" }, "Task: FOC-221", { recheckBranch: true }).status === "propose-override");
check("kickoff confirming the branch id is a confirm, not a write",
  backfillDecision({ runId: "r5", gitBranch: "fen-98-gantt" }, "Weź task FEN-98…", { recheckBranch: true }).status === "confirm"
  && backfillDecision({ runId: "r5", gitBranch: "fen-98-gantt" }, "Weź task FEN-98…", { recheckBranch: true }).taskId === "FEN-98");

// --- transcript plumbing ---------------------------------------------------
const temp = mkdtempSync(join(tmpdir(), "backfill-task-ids-test-"));
const transcript = join(temp, "session.jsonl");
writeFileSync(transcript, [
  JSON.stringify({ type: "user", isSidechain: true, message: { content: "sidechain noise JOI-99" } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking about FEN-7" }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Task: FOC-221" }, { type: "text", text: "second line" }] } }),
].join("\n"));
check("first non-sidechain user message wins",
  firstUserMessage(transcript) === "Task: FOC-221\nsecond line",
  JSON.stringify(firstUserMessage(transcript)));
check("sidechain lines are excluded from recognition",
  inferTaskIdFromText(firstUserMessage(transcript)) === "FOC-221");
check("content-array user lines are flattened",
  userText({ message: { content: [{ type: "text", text: "PISI-98 kickoff" }] } }) === "PISI-98 kickoff");
check("missing transcript file returns null", firstUserMessage(join(temp, "absent.jsonl")) === null);

rmSync(temp, { recursive: true, force: true });

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
