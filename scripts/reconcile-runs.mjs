#!/usr/bin/env node
// scripts/reconcile-runs.mjs — close zombie run manifests + repair manifest data.
//
// A "zombie" is a manifest with endedAt=null whose launcher never ran
// `run-manifest end` (terminal window closed / crash). The dashboard then
// shows the run as "running" forever (elapsed 40h+) and it never leaves
// /api/live. This script:
//
//   1. Locates the run's transcript (recorded transcriptPath, or ledger late
//      discovery) and reads its LAST activity timestamp.
//   2. If the transcript has been idle for > 60 min → closes the manifest:
//      endedAt = last activity, endedBy = "reconciled". Genuinely active
//      runs (fresh transcript writes) are left open.
//   3. Orphans (no transcript at all, started > 24 h ago — aborted launches)
//      are closed at startedAt with endedBy = "reconciled-orphan".
//   4. Repairs manifest.cwd from the transcript's own cwd when they differ
//      (launchers started from an arbitrary directory record a junk cwd,
//      which corrupts the dashboard Repo column).
//   5. Persists discovered sessionId/transcriptPath (sessionSource =
//      "reconciled") so future scans take the cheap EXACT path.
//
// Usage:
//   node scripts/reconcile-runs.mjs           # dry-run (default)
//   node scripts/reconcile-runs.mjs --apply   # write changes
//
// Safe to re-run any time (idempotent). ESM, zero deps (Node 18+).

import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { parseTranscript, discoverTranscriptsForRuns } from "./ledger.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const RUNS_DIR = join(root, ".state", "runs");

const IDLE_MS = 60 * 60 * 1000; // transcript idle for 1 h → run is over
const ORPHAN_MS = 24 * 60 * 60 * 1000; // no transcript + this old → aborted launch

const apply = process.argv.includes("--apply");
const now = Date.now();

function atomicWriteJSON(filePath, data) {
  const tmp = filePath + "." + randomBytes(4).readUInt32BE(0).toString(36);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, filePath);
}

// --- Load manifests ---
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

// Late discovery for manifests without a captured session.
const discovered = discoverTranscriptsForRuns(manifests.map(({ data }) => data));

let closed = 0;
let orphaned = 0;
let repaired = 0;
let active = 0;

console.log(`${manifests.length} manifest(s) in .state/runs\n`);

for (const { file, data } of manifests) {
  const changes = [];

  const match = data.sessionId ? null : discovered.get(data.runId) || null;
  const transcriptPath = data.transcriptPath || match?.path || null;
  const parsed = transcriptPath && existsSync(transcriptPath) ? parseTranscript(transcriptPath) : null;

  // Last activity from the transcript (max turn ts; ISO strings compare lexicographically).
  let lastTs = null;
  if (parsed) {
    for (const t of parsed.turns) if (t.ts && (!lastTs || t.ts > lastTs)) lastTs = t.ts;
  }

  // --- 1/2/3: close zombies ---
  if (!data.endedAt) {
    if (lastTs) {
      const idleMs = now - new Date(lastTs).getTime();
      if (idleMs > IDLE_MS) {
        data.endedAt = lastTs;
        data.endedBy = "reconciled";
        changes.push(`closed at ${lastTs} (idle ${Math.round(idleMs / 3600000)}h)`);
        closed++;
      } else {
        active++;
        console.log(`  ACT  ${data.runId.padEnd(30)} genuinely active (last activity ${Math.round(idleMs / 60000)}m ago)`);
      }
    } else if (now - new Date(data.startedAt).getTime() > ORPHAN_MS) {
      data.endedAt = data.startedAt;
      data.endedBy = "reconciled-orphan";
      changes.push("closed as orphan (no transcript)");
      orphaned++;
    } else {
      active++;
      console.log(`  ?    ${data.runId.padEnd(30)} no transcript yet, too fresh to orphan — skipped`);
    }
  }

  // --- 5: persist discovered session so future scans go EXACT ---
  if (!data.sessionId && match) {
    data.sessionId = basename(match.path, ".jsonl");
    data.transcriptPath = match.path;
    data.sessionAmbiguous = match.ambiguous || false;
    data.sessionSource = "reconciled";
    changes.push(`session ${data.sessionId.slice(0, 8)}…${match.ambiguous ? " (ambiguous)" : ""}`);
  }

  // --- 4: repair junk cwd from the transcript's own cwd ---
  if (parsed?.cwd && data.cwd && parsed.cwd !== data.cwd) {
    changes.push(`cwd "${data.cwd.split("\\").pop()}" → "${parsed.cwd.split("\\").pop()}"`);
    data.cwdLaunchedFrom = data.cwd;
    data.cwd = parsed.cwd;
    repaired++;
  }

  if (changes.length > 0) {
    console.log(`  ${apply ? "FIX " : "WOULD"} ${data.runId.padEnd(30)} ${changes.join(" · ")}`);
    if (apply) atomicWriteJSON(file, data);
  }
}

console.log(
  `\n${closed} zombie(s) closed, ${orphaned} orphan(s), ${repaired} cwd repair(s), ${active} left running.${apply ? "" : " Run with --apply to write."}`,
);
