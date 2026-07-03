#!/usr/bin/env node
// scripts/backfill-task-ids.mjs — retro-tag untagged run manifests.
//
// For every manifest in .state/runs/ with NO task attribution (no explicit
// taskId, no taskIdAuto, no branch-inferable id), locate its transcript
// (manifest.transcriptPath, or ledger late discovery) and scan the FIRST
// user message for a Linear task reference (FEN-/PISI-/JOI-NNN) — kickoff
// prompts name the task up front ("Weź task FEN-98…"). Writes taskIdAuto
// (never the explicit taskId), so an explicit tag always wins.
//
// Usage:
//   node scripts/backfill-task-ids.mjs                    # dry-run (default): print proposals
//   node scripts/backfill-task-ids.mjs --apply            # write taskIdAuto into manifests
//   node scripts/backfill-task-ids.mjs --recheck-branch   # ALSO verify branch-inferred ids
//                                                         # against the kickoff; propose an
//                                                         # override when they disagree (e.g.
//                                                         # branch fen-98-… but kickoff says
//                                                         # PISI-98 — FEN-98 doesn't exist).
//                                                         # taskIdAuto beats branch inference
//                                                         # in the ledger, so the override wins.
//
// ESM, zero deps (Node 18+).

import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { inferTaskIdFromBranch, discoverTranscriptsForRuns } from "./ledger.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const RUNS_DIR = join(root, ".state", "runs");

const TASK_RE = /\b(FEN|PISI|JOI)-(\d{1,5})\b/i;
const apply = process.argv.includes("--apply");
const recheckBranch = process.argv.includes("--recheck-branch");

/** Atomic JSON write (same pattern as run-manifest.mjs). */
function atomicWriteJSON(filePath, data) {
  const tmp = filePath + "." + randomBytes(4).readUInt32BE(0).toString(36);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, filePath);
}

/** Extract plain text from a transcript user line (string or content-array). */
function userText(line) {
  const c = line?.message?.content ?? line?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

/** First non-sidechain user message text from a transcript, or null. */
function firstUserMessage(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  } catch {
    return null;
  }
  for (const raw of lines) {
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!line || line.type !== "user" || line.isSidechain) continue;
    const text = userText(line);
    if (text.trim()) return text;
  }
  return null;
}

// --- Load manifests, pick the untagged ones ---
const files = existsSync(RUNS_DIR)
  ? readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"))
  : [];

const manifests = [];
for (const f of files) {
  try {
    manifests.push({ file: join(RUNS_DIR, f), data: JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")) });
  } catch {
    continue;
  }
}

const candidates = manifests.filter(({ data }) => {
  if (data.taskId || data.taskIdAuto) return false;
  const inferred = inferTaskIdFromBranch(data.gitBranch);
  if (inferred && !recheckBranch) return false; // branch-tagged: only touch with --recheck-branch
  return true;
});

// Late discovery for those without a recorded transcriptPath.
const discovered = discoverTranscriptsForRuns(candidates.map(({ data }) => data));

let proposed = 0;
let skipped = 0;

console.log(`${candidates.length} candidate manifest(s) of ${manifests.length} total\n`);

for (const { file, data } of candidates) {
  const inferred = inferTaskIdFromBranch(data.gitBranch);
  const transcriptPath = data.transcriptPath || discovered.get(data.runId)?.path || null;
  const text = firstUserMessage(transcriptPath);

  if (!text) {
    skipped++;
    console.log(`  -    ${data.runId.padEnd(30)} no transcript / no user message`);
    continue;
  }

  const m = text.match(TASK_RE);
  if (!m) {
    skipped++;
    console.log(`  -    ${data.runId.padEnd(30)} no task reference in kickoff`);
    continue;
  }

  const taskId = `${m[1].toUpperCase()}-${m[2]}`;

  if (inferred && taskId === inferred) {
    skipped++;
    console.log(`  ok   ${data.runId.padEnd(30)} branch id ${inferred} confirmed by kickoff`);
    continue;
  }

  proposed++;
  const snippet = text.replace(/\s+/g, " ").slice(0, 70);
  const note = inferred ? ` (OVERRIDES branch ${inferred})` : "";
  console.log(`  ${apply ? "SET " : "WOULD"} ${data.runId.padEnd(30)} → ${taskId.padEnd(9)}${note} "${snippet}…"`);

  if (apply) {
    data.taskIdAuto = taskId;
    data.taskIdAutoSource = inferred ? "transcript-backfill-branch-override" : "transcript-backfill";
    atomicWriteJSON(file, data);
  }
}

console.log(`\n${proposed} proposal(s), ${skipped} left untagged.${apply ? "" : " Run with --apply to write."}`);
