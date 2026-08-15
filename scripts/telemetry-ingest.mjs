#!/usr/bin/env node
// telemetry-ingest.mjs — imports legacy manifests and incrementally parses
// transcript JSONL into the central telemetry store. It is the only path that
// reads raw transcript trees; HTTP handlers query SQLite projections only.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import * as ledger from "./ledger.mjs";
import {
  applyEvents,
  makeEvent,
  hasOpenQualityIssue,
  openTelemetryDb,
  queryRuns,
  recordDelegationLink,
  recordManifest,
  recordSessionLink,
  recordTaskLink,
  recordToolFact,
  recordWorkspace,
  reportDataQuality,
  replayPending,
  resolveQualityIssue,
  sqliteAvailable,
} from "./telemetry-store.mjs";
import { extractToolFacts } from "./telemetry-tool-extract.mjs";
import { reconstructDelegationLinks } from "./telemetry-delegation-recon.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");
const runsDir = join(root, ".state", "runs");

function refFromBranch(branch) {
  if (branch === "HEAD") return { refType: "detached", refName: null };
  if (branch) return { refType: "branch", refName: branch };
  return { refType: "unknown", refName: null };
}

function jsonLineEvents(path, runId, sessionId, includeWorkspace = true) {
  const content = readFileSync(path, "utf8");
  const lines = content.split(/(?<=\n)/);
  const events = [];
  let offset = 0;
  let lastWorkspace = null;
  let lastCwd = null;
  let lastBranch = null;
  let lastObservedAt = null;
  for (const rawLine of lines) {
    const raw = rawLine.trim();
    const lineOffset = offset;
    offset += Buffer.byteLength(rawLine, "utf8");
    if (!raw) continue;
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    const observedAt = line.timestamp || lastObservedAt || new Date().toISOString();
    const observedCwd = line.relocatedCwd || line.worktreeSession?.worktreePath || line.cwd || lastCwd;
    const branch = line.worktreeSession?.worktreeBranch || line.gitBranch || lastBranch;
    if (line.timestamp) lastObservedAt = line.timestamp;
    if (observedCwd) lastCwd = observedCwd;
    if (branch) lastBranch = branch;
    if (includeWorkspace && observedCwd && `${observedCwd}:${branch || ""}` !== lastWorkspace) {
      lastWorkspace = `${observedCwd}:${branch || ""}`;
      const ref = refFromBranch(branch);
      events.push(makeEvent("workspace.observed", {
        runId, cwd: observedCwd, ...ref, headSha: null,
        source: "transcript",
      }, { runId, observedAt, sourceKind: "transcript-workspace", sourcePath: path, sourceOffset: lineOffset }));
    }
    if (line.type !== "assistant" || !line.message?.usage) continue;
    const usage = line.message.usage;
    events.push(makeEvent("usage.recorded", {
      runId, sessionId: line.sessionId || line.session_id || sessionId || null,
      agentKey: line.attributionAgent || (line.agentId ? `agent-${line.agentId}` : "_lead"),
      model: line.message.model || null, observedAt,
      inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    }, { runId, observedAt, sourceKind: "transcript", sourcePath: path, sourceOffset: lineOffset }));
  }
  return { events, size: Buffer.byteLength(content, "utf8") };
}

function latestWorkspaceFromTranscript(path) {
  if (!path || !existsSync(path)) return null;
  let cwd = null;
  let branch = null;
  let observedAt = null;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    try {
      const line = JSON.parse(raw);
      cwd = line.relocatedCwd || line.worktreeSession?.worktreePath || line.cwd || cwd;
      branch = line.worktreeSession?.worktreeBranch || line.gitBranch || branch;
      observedAt = line.timestamp || observedAt;
    } catch {
      // Ignore malformed transcript rows.
    }
  }
  return cwd ? { cwd, branch, observedAt } : null;
}

function taskLinkTimeFromTranscript(path, taskId) {
  if (!path || !taskId || !existsSync(path)) return null;
  const normalized = taskId.toUpperCase();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.includes("run-manifest.mjs") || !raw.toUpperCase().includes(normalized)) continue;
    try {
      const line = JSON.parse(raw);
      if (line.timestamp) return line.timestamp;
    } catch {
      // Ignore malformed rows.
    }
  }
  return null;
}

function subagentPaths(transcriptPath) {
  const candidates = [
    join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents"),
    join(dirname(transcriptPath), "subagents"),
  ];
  const directory = candidates.find((candidate) => existsSync(candidate));
  if (!directory) return [];
  try {
    return readdirSync(directory)
      .filter((file) => file.startsWith("agent-") && file.endsWith(".jsonl") && !file.endsWith(".meta.json"))
      .map((file) => join(directory, file));
  } catch {
    return [];
  }
}

/**
 * Determine the agent_key for a transcript path.
 *
 * For the lead transcript (isLead=true), returns "_lead".
 * For subagent transcripts, scans the first few lines for attributionAgent
 * (e.g. "first-pass", "security") or agentId, falling back to the filename.
 */
function agentKeyFromTranscript(path, isLead) {
  if (isLead) return "_lead";
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.attributionAgent) return parsed.attributionAgent;
        if (parsed.agentId) return `agent-${parsed.agentId}`;
      } catch { /* skip unparseable lines */ }
    }
  } catch { /* file not readable */ }
  return basename(path).replace(/\.jsonl$/, "");
}

/**
 * Add a tool_index field to each record so recordToolFact can compute a unique
 * hash. Groups records by (source_path, source_offset) — all tool_use blocks
 * in the same assistant message share the same source_offset — and assigns
 * 0, 1, 2, … within each group.
 */
function addToolIndex(records) {
  const counters = {};
  for (const record of records) {
    const key = `${record.source_path}:${record.source_offset}`;
    counters[key] = (counters[key] || 0) + 1;
    record.tool_index = counters[key] - 1;
  }
  return records;
}

export async function ingestTranscript(db, runId, transcriptPath, sessionId = null) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { files: 0, events: 0, missing: true };
  const paths = [transcriptPath, ...subagentPaths(transcriptPath)];
  let eventsApplied = 0;
  for (const path of paths) {
    const stats = statSync(path);
    // Skip-cache is run-scoped: transcript_sources PK is (source_path, run_id)
    // (v5, JOI-260), so run B parsing the same file as run A must NOT be skipped
    // by run A's row. Querying source_path alone matched any prior run's row and
    // silently dropped run B's ingest — binding run_id constrains the lookup to
    // this run's own row (or none), so each run parses its own copy.
    const known = db.prepare("SELECT file_size, parse_status FROM transcript_sources WHERE source_path=? AND run_id=?").get(path, runId);
    if (known?.parse_status === "parsed" && known.file_size === stats.size) continue;
    const { events, size } = jsonLineEvents(path, runId, sessionId, path === transcriptPath);
    const progressEvent = makeEvent("transcript.progress", {
      runId, sessionId, byteOffset: size, fileSize: size, modifiedAt: statSync(path).mtime.toISOString(), parseStatus: "parsed",
    }, { runId, sourceKind: "transcript-progress", sourcePath: path, sourceOffset: size });
    const results = applyEvents(db, [...events, progressEvent]);
    eventsApplied += results.slice(0, -1).filter((result) => !result?.duplicate).length;

    // Extract tool_facts and delegation_links for this transcript.
    // Wrapped in sqliteAvailable() so Node degrades gracefully when node:sqlite
    // is unavailable (e.g. Node 20 or custom builds).
    if (sqliteAvailable()) {
      const isLead = path === transcriptPath;
      const agentKey = agentKeyFromTranscript(path, isLead);
      const toolRecords = await extractToolFacts(path, runId, agentKey);
      addToolIndex(toolRecords);
      for (const record of toolRecords) {
        await recordToolFact(record);
      }
      // For the lead transcript only, reconstruct delegation links from the
      // subagents/ directory. Subagent transcripts are processed separately
      // above (they get their own tool_facts), but the parent→child link is
      // recorded once on the lead.
      if (isLead) {
        const delegationRecords = reconstructDelegationLinks({
          runId,
          parentAgent: "_lead",
          transcriptPath: path,
        });
        for (const record of delegationRecords) {
          await recordDelegationLink(record);
        }
      }
    }
  }
  // Transcript is now available — close any open "transcript_missing" issue
  // for this run so the dashboard stops reporting it as ongoing. Without
  // this, the issue opened by an earlier failed ingest cycle stays open
  // forever and ingest cycles keep reporting it as still missing.
  resolveQualityIssue(db, runId, "transcript_missing");
  return { files: paths.length, events: eventsApplied, missing: false };
}

// Strip the legacy "workspace/{workspaceId}/" segment inserted by older record
// paths. Older ledger rows store transcript_path with an extra workspace
// subfolder that no longer exists on disk; the file actually lives directly
// under .../agents/{squad}/projects/{projectHash}/{sessionId}.jsonl.
function stripLegacyWorkspaceSegment(transcriptPath) {
  if (!transcriptPath) return null;
  return transcriptPath.replace(/[/\\]workspace[/\\][^/\\]+[/\\]/, "/");
}

export function transcriptForSession(run) {
  if (!run.sessionId) return null;
  if (run.transcriptPath && existsSync(run.transcriptPath)) return run.transcriptPath;
  // The path stored in DB may include a stale /workspace/{id}/ segment that
  // no longer matches the on-disk layout. Strip it and try again before
  // falling back to a sessionId search across the known roots.
  const stripped = stripLegacyWorkspaceSegment(run.transcriptPath);
  if (stripped && stripped !== run.transcriptPath && existsSync(stripped)) return stripped;
  const roots = [
    run.claudeConfigDir ? join(run.claudeConfigDir, "projects") : null,
    run.squad ? join(root, "agents", run.squad, "projects") : null,
    join(homedir(), ".claude", "projects"),
  ].filter(Boolean);
  for (const projectsRoot of roots) {
    try {
      for (const hashDirectory of readdirSync(projectsRoot)) {
        const candidate = join(projectsRoot, hashDirectory, `${run.sessionId}.jsonl`);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Try the next root.
    }
  }
  return null;
}

function transcriptContainingRunId(run) {
  if (!run.runId || !run.squad) return null;
  const projectsRoot = join(root, "agents", run.squad, "projects");
  try {
    for (const hashDirectory of readdirSync(projectsRoot)) {
      const hashPath = join(projectsRoot, hashDirectory);
      if (!statSync(hashPath).isDirectory()) continue;
      for (const file of readdirSync(hashPath).filter((name) => name.endsWith(".jsonl"))) {
        const candidate = join(hashPath, file);
        if (readFileSync(candidate, "utf8").includes(run.runId)) return candidate;
      }
    }
  } catch {
    // No local squad transcript root for this legacy run.
  }
  return null;
}

function manifests() {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const path = join(runsDir, file);
      try { return [{ path, manifest: JSON.parse(readFileSync(path, "utf8")) }]; } catch { return []; }
    });
}

export async function backfill(options = {}) {
  const summary = { manifests: 0, runs: 0, transcripts: 0, usageEvents: 0, missingTranscripts: 0, pending: 0 };
  summary.pending = replayPending(options).ingested;
  const sourceRuns = await ledger.scanRuns();
  const discovered = new Map(sourceRuns.map((run) => [run.runId, run]));
  for (const { path, manifest } of manifests()) {
    summary.manifests++;
    const aggregate = discovered.get(manifest.runId);
    if (aggregate?.ambiguous || manifest.sessionAmbiguous) {
      reportDataQuality(manifest.runId, "legacy_session_ambiguous", {
        sessionId: manifest.sessionId || aggregate?.sessionId || null,
        transcriptPath: manifest.transcriptPath || aggregate?.transcriptPath || null,
      }, { ...options, sourceKind: "legacy-discovery", severity: "warning" });
    }
    const recoveredPath = transcriptContainingRunId(manifest);
    const transcriptPath = manifest.transcriptPath || aggregate?.transcriptPath || recoveredPath || null;
    const parsed = transcriptPath ? ledger.parseTranscript(transcriptPath) : null;
    const sessionId = manifest.sessionId || aggregate?.sessionId || parsed?.sessionId || null;
    const startManifest = manifest.taskIdAuto ? { ...manifest, taskIdAuto: null } : manifest;
    recordManifest(startManifest, "started", { ...options, sourcePath: path });
    if (manifest.endedAt) recordManifest(manifest, "ended", { ...options, sourcePath: path });
    if (!manifest.taskId && manifest.taskIdAuto) {
      const pickTime = taskLinkTimeFromTranscript(transcriptPath, manifest.taskIdAuto);
      recordTaskLink(manifest.runId, manifest.taskIdAuto, "agent_pick", {
        ...options,
        observedAt: pickTime || manifest.startedAt,
        confidence: pickTime ? 1 : 0.6,
        correctExisting: true,
        sourceKind: pickTime ? "legacy-agent-pick" : "legacy-inference",
        sourcePath: path,
        sourceOffset: 4,
      });
    } else if (!manifest.taskId && !manifest.taskIdAuto && aggregate?.taskId) {
      const source = aggregate.taskIdKickoff ? "kickoff_inference" : "branch_inference";
      recordTaskLink(manifest.runId, aggregate.taskId, source, {
        ...options,
        observedAt: manifest.startedAt,
        confidence: aggregate.taskIdKickoff ? 0.7 : 0.4,
        sourceKind: "legacy-inference",
        sourcePath: path,
        sourceOffset: 4,
      });
    }
    if (sessionId) {
      recordSessionLink(manifest.runId, sessionId, { transcriptPath, source: manifest.sessionId ? "manifest" : "legacy_discovery" }, options);
    }
    const workspace = latestWorkspaceFromTranscript(transcriptPath);
    if (workspace || aggregate?.cwd) {
      const cwd = workspace?.cwd || aggregate.cwd;
      const branch = workspace?.branch || aggregate.gitBranch || null;
      recordWorkspace(manifest.runId, cwd, { ...refFromBranch(branch), headSha: null, source: "legacy_transcript" }, {
        ...options,
        observedAt: workspace?.observedAt || manifest.endedAt || manifest.startedAt,
      });
    }
    const db = openTelemetryDb(options.dbPath);
    try {
      const result = await ingestTranscript(db, manifest.runId, transcriptPath, sessionId);
      if (result.missing) {
        summary.missingTranscripts++;
        if (!hasOpenQualityIssue(db, manifest.runId, "transcript_missing")) {
          reportDataQuality(manifest.runId, "transcript_missing", { manifestPath: path, sessionId }, options);
        }
      }
      else { summary.transcripts += result.files; summary.usageEvents += result.events; }
      summary.runs++;
    } finally {
      db.close();
    }
  }
  return summary;
}

export async function ingestKnownRuns(options = {}) {
  const db = openTelemetryDb(options.dbPath);
  const summary = { runs: 0, transcripts: 0, usageEvents: 0, missingTranscripts: 0 };
  try {
    // This loop runs on a 15s timer in telemetry-server, so every run whose
    // transcript is gone is re-checked ~5 700 times a day. Report the issue
    // only when it is not already open, otherwise the emit is pure waste — a
    // spool file plus a database open per run per tick.
    const reportMissing = (runId, details) => {
      summary.missingTranscripts++;
      if (hasOpenQualityIssue(db, runId, "transcript_missing")) return;
      reportDataQuality(runId, "transcript_missing", details, options);
    };
    for (const run of queryRuns(db)) {
      const transcriptPath = transcriptForSession(run);
      if (!transcriptPath) {
        reportMissing(run.runId, { sessionId: run.sessionId || null });
        continue;
      }
      const result = await ingestTranscript(db, run.runId, transcriptPath, run.sessionId);
      summary.runs++;
      if (result.missing) {
        reportMissing(run.runId, { sessionId: run.sessionId || null });
      }
      else { summary.transcripts += result.files; summary.usageEvents += result.events; }
    }
  } finally {
    db.close();
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "ingest";
  const asJson = args.includes("--json");
  let result;
  if (command === "backfill") result = await backfill();
  else if (command === "ingest") result = await ingestKnownRuns();
  else if (command === "replay") result = replayPending();
  else {
    console.error("Usage: node scripts/telemetry-ingest.mjs <backfill|ingest|replay> [--json]");
    process.exit(2);
  }
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else console.log(`[telemetry-ingest] ${Object.entries(result).map(([key, value]) => `${key}=${value}`).join(" ")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(`[telemetry-ingest] ${error.message}`); process.exit(1); });
}