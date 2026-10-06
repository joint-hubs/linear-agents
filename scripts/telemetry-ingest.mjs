#!/usr/bin/env node
// telemetry-ingest.mjs — imports legacy manifests and incrementally parses
// transcript JSONL into the central telemetry store. It is the only path that
// reads raw transcript trees; HTTP handlers query SQLite projections only.
//
// FOC-547: every transcript read is CHUNKED (jsonlChunksFrom — one event-loop
// turn per ~256 KiB) and INCREMENTAL (a pass resumes at the byte offset stored
// in transcript_sources). On the real corpus this is what keeps a single
// ingest tick from blocking Node's event loop for minutes: the previous full
// readFileSync + per-line parse per manifest produced 120–152 s single blocks
// during boot backfill and starved request serving outright.

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
  recordDelegationLink,
  recordManifest,
  recordSessionLink,
  recordTaskLink,
  recordToolFact,
  recordWorkspace,
  reportDataQuality,
  replayPending,
  resolveQualityIssue,
  queryRunsForIngest,
  warmGitFacts,
  sqliteAvailable,
} from "./telemetry-store.mjs";
import { createPacer, createToolLinkState, extractToolFacts, jsonlChunksFrom } from "./telemetry-tool-extract.mjs";
import { reconstructDelegationLinksAsync, scanSpawnToolUsesAsync } from "./telemetry-delegation-recon.mjs";

// Data roots (runs manifests, per-squad transcript corpora) resolve through
// ledger.runsManifestDir() / ledger.squadProjectsRoot() — the LA_STATE_ROOT /
// LA_CORPUS_ROOT seams (FOC-599), so tests never open the live `.state`.

// The runId format run-manifest.mjs stamps into manifests and transcripts
// (e.g. "2026-06-29T17-43-31-dev"). Used by the lazy transcript-locating sweep
// below; a runId that does not match simply stays unlocated — the same answer
// the old content scan produced when nothing matched.
const RUN_ID_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z][a-z0-9]*\b/g;

function refFromBranch(branch) {
  if (branch === "HEAD") return { refType: "detached", refName: null };
  if (branch) return { refType: "branch", refName: branch };
  return { refType: "unknown", refName: null };
}

/**
 * Subagent transcripts belonging to a lead transcript. Mirrors the layout
 * convention in telemetry-delegation-recon.mjs:findSubagentTranscripts —
 *   1. `<dirname(leadPath)>/<basename-without-.jsonl>/subagents/`
 *   2. `<dirname(leadPath)>/subagents/`
 * Each agent-*.jsonl gets its own incremental ingest pass (ingestTranscript).
 */
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

// ---------------------------------------------------------------------------
// Per-(run, path) incremental parse state
// ---------------------------------------------------------------------------

// FOC-547: workspace emission state and pending tool-fact links must survive
// BETWEEN passes (a growing transcript is parsed once per 15 s tick, not once
// per process). Keyed by (runId, path) — the same run-scoped semantics as the
// transcript_sources skip-cache (JOI-260): two runs ingesting the same file
// never share state. The maps are pruned per pass; a state whose file stopped
// growing is finalized and dropped (see ingestTranscript).
const parseStates = new Map();

function getParseState(runId, path) {
  const key = `${runId}\u0000${path}`;
  let state = parseStates.get(key);
  if (!state) {
    state = {
      toolLinks: createToolLinkState(),
      agentKey: null,
      // Carries lastWorkspace/lastCwd/lastBranch/lastObservedAt between passes
      // so an unchanged cwd:branch emits no new workspace.observed event.
      workspace: { lastWorkspace: null, lastCwd: null, lastBranch: null, lastObservedAt: null },
      // Lead transcripts only: incremental delegation-link reconstruction.
      delegation: null,
      // One-time full re-scan guard for the restart gap (see ingestTranscript).
      fullToolScanDone: false,
    };
    parseStates.set(key, state);
  }
  return state;
}

/**
 * FOC-599 item 7 (nit 3): the unchanged-file skip branch finalizes pending
 * tool facts and used to DROP the whole in-memory state. The next grown pass
 * then started fresh (workspace.lastWorkspace = null) and re-emitted
 * workspace.observed for an unchanged cwd:branch — and the store's dedup key
 * is (run_id, observed_at, cwd), so a re-emit with the NEW line timestamp
 * lands as a real duplicate row.
 *
 * The pause must not lose the FILE-GLOBAL state: keep workspace, delegation
 * (else the spawn scan restarts at 0 and re-pushes every spawn), agentKey
 * (else the attributionAgent scan re-reads the file) and the turn_index
 * counter (extractToolFacts carries linkState.turnIndex across incremental
 * passes so turn_index stays file-global). Only the tool-fact link maps
 * restart — their pending uses were just finalized — and the restart-gap full
 * re-scan is re-armed: with the uses registry empty, a late tool_result can
 * only find its use through that re-scan.
 */
function swapParseState(key) {
  const state = parseStates.get(key);
  if (!state) return; // no state to keep (orphan finalization path) — nothing to do
  const toolLinks = createToolLinkState();
  toolLinks.turnIndex = state.toolLinks.turnIndex;
  parseStates.set(key, { ...state, toolLinks, fullToolScanDone: false });
}

/** Test seam: simulate a process restart (state is deliberately in-memory). */
export function _resetTranscriptParseStateForTests() {
  parseStates.clear();
}

/**
 * Determine the agent_key for a transcript path.
 *
 * For the lead transcript (isLead=true), returns "_lead".
 * For subagent transcripts, scans the file (chunked, FOC-547 — no full-file
 * synchronous read) for attributionAgent (e.g. "first-pass", "security") or
 * agentId, falling back to the filename. Semantics are identical to the old
 * full readFileSync scan: first matching line wins, wherever it sits.
 */
async function agentKeyFromTranscript(path, isLead) {
  if (isLead) return "_lead";
  // FOC-547 (AC2): chunk reads are synchronous — pace so a worst-case
  // full-file scan (no attribution line found) stays below the block bar.
  const pacer = createPacer();
  for await (const { lines } of jsonlChunksFrom(path, 0)) {
    await pacer();
    for (const { raw } of lines) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.attributionAgent) return parsed.attributionAgent;
        if (parsed.agentId) return `agent-${parsed.agentId}`;
      } catch { /* skip unparseable lines */ }
    }
  }
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

// ---------------------------------------------------------------------------
// One chunked pass over a transcript range: usage + workspace events
// ---------------------------------------------------------------------------

/**
 * Stream the transcript from `startOffset`, emit usage.recorded (and, for the
 * lead, workspace.observed) events exactly like the previous full-file
 * jsonLineEvents, applied to the store one CHUNK per transaction.
 *
 * Why per-chunk transactions: a 31 MB transcript is ~100k events; applying
 * them in one transaction was a multi-second synchronous block on the event
 * loop. Per-chunk application is safe by design — every event dedups on its
 * (source_path, source_offset) natural key, so a pass that dies mid-way is
 * simply re-parsed from the last stored offset and the already-applied lines
 * are absorbed as duplicates. The transcript.progress event (which advances
 * the skip-cache byte_offset) is only written after the pass reached EOF.
 */
// FOC-547 (AC2): one ingest chunk can carry hundreds of events; applying them
// in a single transaction blocked the event loop for seconds per large chunk.
// Slices keep every apply — and the event-loop turn between them — bounded; a
// failed slice leaves the stored offset untouched exactly like a failed
// whole-chunk apply did, and dedup absorbs the partially applied events on the
// re-parse.
const FLUSH_SLICE = 25;

// FOC-547 (D2): applyWorkspaceObserved consults git SYNCHRONOUSLY inside the
// apply transaction. Prefetching the slice's cwds with async git first means
// git runs while the event loop is free and the synchronous fallback is a
// cache hit — a single cold git call measured up to ~600 ms, well over the
// 250 ms AC2 bar.
async function warmWorkspaceCwds(events) {
  const cwds = new Set();
  for (const event of events) {
    if (event.eventType === "workspace.observed" && event.payload?.cwd) cwds.add(event.payload.cwd);
  }
  if (cwds.size > 0) await warmGitFacts([...cwds]);
}

async function ingestTranscriptRange(db, runId, path, sessionId, opts) {
  const { startOffset, isLead, state, statsSize, resetOffset } = opts;
  const ws = state.workspace;
  let eventsApplied = 0;
  let pendingEvents = [];
  let lastFlushedOffset = startOffset;
  let sawEof = false;
  const pacer = createPacer();

  const flush = async () => {
    if (pendingEvents.length === 0) return;
    const batch = pendingEvents;
    pendingEvents = [];
    while (batch.length > 0) {
      const slice = batch.splice(0, FLUSH_SLICE);
      await warmWorkspaceCwds(slice);
      const results = await applyEvents(db, slice);
      eventsApplied += results.filter((result) => !result?.duplicate).length;
      await pacer();
    }
  };

  for await (const chunk of jsonlChunksFrom(path, startOffset)) {
    // FOC-597: the EOF tail may commit only if it parses as a whole record.
    let tailParsed = false;
    for (const { raw, offset: lineOffset } of chunk.lines) {
      if (!raw) continue;
      let line;
      try { line = JSON.parse(raw); } catch { continue; }
      if (chunk.tail && lineOffset === chunk.tail.offset) tailParsed = true;
      const observedAt = line.timestamp || ws.lastObservedAt || new Date().toISOString();
      const observedCwd = line.relocatedCwd || line.worktreeSession?.worktreePath || line.cwd || ws.lastCwd;
      const branch = line.worktreeSession?.worktreeBranch || line.gitBranch || ws.lastBranch;
      if (line.timestamp) ws.lastObservedAt = line.timestamp;
      if (observedCwd) ws.lastCwd = observedCwd;
      if (branch) ws.lastBranch = branch;
      if (isLead && observedCwd && `${observedCwd}:${branch || ""}` !== ws.lastWorkspace) {
        ws.lastWorkspace = `${observedCwd}:${branch || ""}`;
        const ref = refFromBranch(branch);
        pendingEvents.push(makeEvent("workspace.observed", {
          runId, cwd: observedCwd, ...ref, headSha: null,
          source: "transcript",
        }, { runId, observedAt, sourceKind: "transcript-workspace", sourcePath: path, sourceOffset: lineOffset }));
      }
      if (line.type !== "assistant" || !line.message?.usage) continue;
      const usage = line.message.usage;
      // FOC-381 (B1): message.id identifies the physical model call. One
      // assistant message lands as several transcript lines (thinking / text /
      // tool_use), each repeating the same usage object — or zeros on some
      // lines. The event stays per line with its own dedup key; message.id
      // travels in the payload so the projection (applyUsageRecorded) can
      // merge the lines into one usage_facts row instead of counting each.
      pendingEvents.push(makeEvent("usage.recorded", {
        runId, sessionId: line.sessionId || line.session_id || sessionId || null,
        agentKey: line.attributionAgent || (line.agentId ? `agent-${line.agentId}` : "_lead"),
        model: line.message.model || null, observedAt,
        messageId: line.message?.id ?? null,
        inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      }, { runId, observedAt, sourceKind: "transcript", sourcePath: path, sourceOffset: lineOffset }));
    }
    try {
      await flush();
      // FOC-597: never advance past the unterminated EOF tail unless it parsed
      // as a whole record — a torn write is resumed at its start, so the line
      // that completes it is parsed on the next pass instead of being lost.
      lastFlushedOffset = chunk.tail
        ? (tailParsed ? chunk.tail.end : chunk.tail.offset)
        : chunk.endOffset;
      if (chunk.atEof) sawEof = true;
    } catch (error) {
      // A failed chunk leaves the stored offset untouched — the next pass
      // re-parses from there and dedup absorbs what already landed. Never
      // advance the skip-cache past a chunk that did not commit.
      console.error(`[telemetry] transcript chunk apply failed for ${path}: ${error.message}`);
      return { events: eventsApplied, eofOffset: lastFlushedOffset, complete: false };
    }
  }

  if (!sawEof) return { events: eventsApplied, eofOffset: lastFlushedOffset, complete: false };

  // Progress AFTER the whole range applied — this is what arms the skip-cache
  // (transcript_sources.file_size) for the next pass.
  let modifiedAt = null;
  try { modifiedAt = statSync(path).mtime.toISOString(); } catch { /* transient file */ }
  const progressEvent = makeEvent("transcript.progress", {
    runId, sessionId, byteOffset: lastFlushedOffset, fileSize: statsSize, modifiedAt, parseStatus: "parsed",
    // FOC-598: a shrink/rotation pass resets the skip-cache row instead of
    // max()-merging into the previous incarnation's offsets.
    resetOffset: Boolean(resetOffset),
  }, { runId, sourceKind: "transcript-progress", sourcePath: path, sourceOffset: lastFlushedOffset });
  try {
    await flush(); // no-op unless a race left events pending
    applyEvents(db, [progressEvent]);
  } catch (error) {
    console.error(`[telemetry] transcript progress write failed for ${path}: ${error.message}`);
    return { events: eventsApplied, eofOffset: lastFlushedOffset, complete: false };
  }
  return { events: eventsApplied, eofOffset: lastFlushedOffset, complete: true };
}

// ---------------------------------------------------------------------------
// Tool facts + delegation links (incremental)
// ---------------------------------------------------------------------------

/**
 * Resolve pending tool facts whose tool_result has arrived in linkState.results,
 * then prune result entries that resolve nothing (bounds memory across passes).
 */
async function resolvePendingToolFacts(db, linkState) {
  const pacer = createPacer();
  for (const [id, use] of linkState.uses) {
    const result = linkState.results.get(id);
    if (!result) continue;
    // `use` is the FULL record snapshotted at pending-registration time (see
    // writeToolFact) — the upgrade path re-binds every INSERT column, so the
    // identity fields (agent_key, tool_name_raw, turn_index, …) must be
    // present; node:sqlite refuses to bind undefined.
    const resolved = {
      ...use,
      tool_has_error: result.isError ? 1 : 0,
      tool_result_state: result.isError ? "error" : "ok",
      tool_result_bytes: result.bytes,
      tool_result_full: result.text,
    };
    await recordToolFact(resolved, { db });
    // FOC-624: capture here too. The pending use was written without a result, so
    // this is the first moment the result text is in hand and freshness/returns can
    // be derived. (finalizePendingToolFacts passes tool_result_full: null and so
    // correctly captures nothing.)
    await captureCodegraphFact(db, resolved);
    linkState.uses.delete(id);
    linkState.results.delete(id);
    await pacer();
  }
}

/**
 * Finalize pending tool facts as 'missing': the file has stopped growing (the
 * skip-cache matched its size), so their tool_result never arrived. This
 * reproduces the old full-file EOF semantics — without it an incremental pass
 * would leave the outcome NULL forever (FOC-547 AC7).
 */
async function finalizePendingToolFacts(db, linkState) {
  const pacer = createPacer();
  for (const [, use] of linkState.uses) {
    // Same full-record requirement as resolvePendingToolFacts: the pending
    // entry carries every bound column, the outcome fields are overridden.
    await recordToolFact({
      ...use,
      tool_has_error: 0,
      tool_result_state: "missing",
      tool_result_bytes: null,
      tool_result_full: null,
    }, { db });
    await pacer();
  }
  linkState.uses.clear();
}

/**
 * DB-side twin of finalizePendingToolFacts for the RESTART case: the in-memory
 * pending registry died with the previous process, but the NULL rows it wrote
 * are still in tool_facts. On an unchanged pass (file size matches — no new
 * tool_result can arrive) those rows finalize to 'missing', exactly like the
 * old full-file EOF semantics. Without this, a crash between a pending write
 * and its resolution would leave the outcome NULL forever.
 */
async function finalizeOrphanedPendingToolFacts(db, runId, path) {
  const pending = db
    .prepare("SELECT source_offset, tool_index FROM tool_facts WHERE run_id=? AND source_path=? AND tool_result_state IS NULL")
    .all(runId, path);
  const pacer = createPacer();
  for (const row of pending) {
    await recordToolFact({
      run_id: runId,
      source_path: path,
      source_offset: row.source_offset,
      tool_index: row.tool_index,
      // Columns the INSERT binds but the UPDATE path never touches — explicit
      // nulls so the bind never sees undefined.
      agent_key: null,
      tool_name_raw: null,
      turn_index: null,
      tool_has_error: 0,
      tool_result_state: "missing",
      tool_result_bytes: null,
      tool_result_full: null,
    }, { db });
    await pacer();
  }
  return pending.length;
}

// FOC-624 (collection half): CodeGraph query-trajectory capture and attribution.
// Dynamically imported and memoised — the ingest hot path pays the module lookup
// once per process, and node caches it either way.
let codegraphTrajectory = null;
async function codegraphTrajectoryModule() {
  if (!codegraphTrajectory) codegraphTrajectory = await import("./codegraph-trajectory.mjs");
  return codegraphTrajectory;
}

/**
 * FOC-624: capture one CodeGraph query's trajectory while its result text is still
 * in hand — freshness and the returned identifiers. IDENTIFIERS ONLY (FOC-220 keeps
 * the result text out of the store; see scripts/codegraph-trajectory.mjs).
 *
 * No-op for every other tool, and for a use whose result has not arrived yet — that
 * case is captured from resolvePendingToolFacts once the outcome lands.
 */
async function captureCodegraphFact(db, record) {
  if (!record || typeof record.tool_result_full !== "string") return;
  const { captureFromRecord, recordCodegraphCapture } = await codegraphTrajectoryModule();
  const row = captureFromRecord(record);
  if (row) recordCodegraphCapture(db, row);
}

/**
 * FOC-624: back-fill which returned identifiers were later used, and the 3-way
 * outcome FOC-627 grades (answered / fallback / unused, plus `unknown` so the
 * classification never fabricates). "Later used" is future information, so this can
 * only run once a pass has seen what follows the query.
 *
 * Idempotent UPDATE: re-running over a grown transcript widens `used`, never
 * narrows it.
 */
async function attributeCodegraphUse(db, { runId, agentKey, sourcePath }) {
  const { attributeQueries, loadProseAfter } = await codegraphTrajectoryModule();
  const queries = db.prepare(
    "SELECT * FROM codegraph_query_facts WHERE run_id=? AND agent_key=? AND source_path=?",
  ).all(runId, agentKey, sourcePath);
  if (queries.length === 0) return 0;
  const toolRows = db.prepare(
    `SELECT tool_fact_id, run_id, agent_key, source_offset, tool_index, tool_name_raw, tool_name_canon, tool_input
       FROM tool_facts WHERE run_id=? AND agent_key=?`,
  ).all(runId, agentKey);
  // tool_facts keeps a 1000-char preview of tool_input (the full text feeds only the
  // identity digest), so usage matching can only UNDER-report. Stated, not hidden.
  const proseByOffset = await loadProseAfter(queries);
  attributeQueries({ queries, toolRows, proseByOffset });
  for (const row of queries) {
    db.prepare("UPDATE codegraph_query_facts SET used_files=?, used_symbols=?, outcome=? WHERE tool_fact_id=?")
      .run(row.used_files, row.used_symbols, row.outcome, row.tool_fact_id);
  }
  return queries.length;
}

/**
 * Tool-fact ingest for ONE transcript range (FOC-547).
 *
 * extractToolFacts scans only [startOffset, EOF); outcomes are carried in
 * state.toolLinks so a result arriving in a later pass still resolves the
 * tool_use recorded by an earlier one (recordToolFact upgrades the row in
 * place). Pending uses are written immediately with a NULL outcome — never as
 * a final 'missing' — so the fact exists (crash-safe) and is resolvable later.
 *
 * Restart gap: a result for a tool_use parsed by a PREVIOUS process has no
 * pending entry. One bounded full re-scan per (run, path) per process rebuilds
 * the pending map (recordToolFact dedup absorbs the already-written facts);
 * after that, truly orphan results (no matching tool_use in the file at all —
 * the old extractor ignored them too) are pruned.
 */

async function ingestToolFactsRange(db, runId, path, agentKey, startOffset, state) {
  const linkState = state.toolLinks;
  // One shared write path for range records and full-re-scan records: BOTH
  // must register unresolved uses in linkState.uses — otherwise a use
  // (re)discovered by the restart-gap re-scan would never be tracked, and the
  // later finalize pass would have nothing to finalize (found by the AC5
  // tool-fact regression test).
  const writeToolFact = async (record) => {
    if (record._toolUseId) {
      // Pending: outcome not in this range (yet). Register for later passes;
      // extractToolFacts leaves the outcome NULL in linkState mode.
      //
      // Store the FULL record, not just the natural key: a later pass re-emits
      // it through recordToolFact (resolve/finalize), and that call binds every
      // INSERT column — agent_key, tool_name_raw, turn_index included. The
      // earlier key-only snapshot left those undefined and the tick died with
      // "Provided value cannot be bound to SQLite parameter 3" (agent_key) the
      // moment a pending use got resolved in-process.
      linkState.uses.set(record._toolUseId, record);
    }
    await recordToolFact(record, { db });
    await captureCodegraphFact(db, record);
  };
  const pacer = createPacer();
  const records = await extractToolFacts(path, runId, agentKey, { startOffset, linkState });
  addToolIndex(records);
  for (const record of records) {
    await writeToolFact(record);
    await pacer();
  }
  await resolvePendingToolFacts(db, linkState);

  const orphans = [...linkState.results.keys()].filter((id) => !linkState.uses.has(id));
  if (orphans.length > 0 && !state.fullToolScanDone) {
    state.fullToolScanDone = true;
    const fullRecords = await extractToolFacts(path, runId, agentKey, { startOffset: 0, linkState });
    addToolIndex(fullRecords);
    for (const record of fullRecords) {
      await writeToolFact(record);
      await pacer();
    }
    await resolvePendingToolFacts(db, linkState);
  }
  // Prune results that resolve nothing — they would otherwise sit in memory
  // for the lifetime of a growing transcript.
  for (const id of [...linkState.results.keys()]) {
    if (!linkState.uses.has(id)) linkState.results.delete(id);
  }
  // FOC-624: attribute "returned -> later used" only now, once the pass has seen
  // what follows each query. Idempotent UPDATE — a later pass over a grown
  // transcript can widen `used`, never narrow it.
  await attributeCodegraphUse(db, { runId, agentKey, sourcePath: path });
}

/**
 * Delegation-link ingest for a LEAD transcript (incremental, FOC-547).
 *
 * Spawn tool_uses are scanned from the NEW range only (state.delegation
 * .spawnOffset tracks the scan frontier), subagent metadata is re-read only
 * when a subagent file is new or grown, and recordDelegationLink's INSERT OR
 * IGNORE keeps re-emission idempotent.
 */
async function ingestDelegationRange(db, runId, path, eofOffset, state) {
  const delegation = state.delegation || (state.delegation = { spawnOffset: 0, spawns: [], meta: new Map() });
  const spawnStart = Math.min(delegation.spawnOffset, eofOffset);
  const newSpawns = await scanSpawnToolUsesAsync(path, spawnStart);
  delegation.spawns.push(...newSpawns);
  delegation.spawnOffset = eofOffset;
  const records = await reconstructDelegationLinksAsync({
    runId, parentAgent: "_lead", transcriptPath: path,
    spawns: delegation.spawns, metaCache: delegation.meta,
  });
  const pacer = createPacer();
  for (const record of records) {
    await recordDelegationLink(record, { db });
    await pacer();
  }
}

// ---------------------------------------------------------------------------
// Public ingest API
// ---------------------------------------------------------------------------

export async function ingestTranscript(db, runId, transcriptPath, sessionId = null) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { files: 0, events: 0, missing: true };
  const paths = [transcriptPath, ...subagentPaths(transcriptPath)];
  let eventsApplied = 0;
  for (const path of paths) {
    const stats = statSync(path);
    const isLead = path === transcriptPath;
    // Skip-cache is run-scoped: transcript_sources PK is (source_path, run_id)
    // (v5, JOI-260), so run B parsing the same file as run A must NOT be skipped
    // by run A's row. Querying source_path alone matched any prior run's row and
    // silently dropped run B's ingest — binding run_id constrains the lookup to
    // this run's own row (or none), so each run parses its own copy.
    const known = db.prepare("SELECT byte_offset, file_size, parse_status FROM transcript_sources WHERE source_path=? AND run_id=?").get(path, runId);
    if (known?.parse_status === "parsed" && known.file_size === stats.size) {
      // FOC-547: the file has not grown since the last pass — any still-pending
      // tool facts can only be genuinely missing. Finalize them (old full-file
      // EOF semantics) and drop the in-memory state. With no in-memory state
      // (previous process died holding the pending registry) the NULL rows it
      // wrote are finalized straight from the store.
      const state = parseStates.get(`${runId}\u0000${path}`);
      if (sqliteAvailable()) {
        if (state) await finalizePendingToolFacts(db, state.toolLinks);
        else await finalizeOrphanedPendingToolFacts(db, runId, path);
      }
      swapParseState(`${runId}\u0000${path}`);
      continue;
    }
    // FOC-598: a SHRUNKEN file (rotated/truncated) forces a full re-parse from 0
    // AND a reset of the skip-cache row (`resetOffset`) — the max() upsert would
    // otherwise retain the old incarnation's byte_offset/file_size and every
    // later tick would re-parse the whole file again. Honest limit: the offset
    // row recovers, but the natural-key dedup still absorbs genuinely NEW
    // content at offsets the previous incarnation already claimed — only a
    // content/generation-aware key fixes that (FOC-598 AC1b, open).
    const knownBytes = Number.isInteger(known?.byte_offset) ? known.byte_offset : 0;
    const knownSize = Number.isInteger(known?.file_size) ? known.file_size : 0;
    const shrunk = stats.size < knownSize || knownBytes > stats.size;
    let startOffset = 0;
    if (knownBytes > 0 && !shrunk) startOffset = knownBytes;
    const state = getParseState(runId, path);
    const range = await ingestTranscriptRange(db, runId, path, sessionId, {
      startOffset, isLead, state, statsSize: stats.size, resetOffset: shrunk,
    });
    eventsApplied += range.events;

    // Extract tool_facts and delegation_links for the SAME incremental range.
    // Wrapped in sqliteAvailable() so Node degrades gracefully when node:sqlite
    // is unavailable (e.g. Node 20 or custom builds).
    if (sqliteAvailable()) {
      const agentKey = state.agentKey || (state.agentKey = await agentKeyFromTranscript(path, isLead));
      if (range.eofOffset > startOffset) {
        await ingestToolFactsRange(db, runId, path, agentKey, startOffset, state);
      }
      // For the lead transcript only, reconstruct delegation links from the
      // subagents/ directory. Subagent transcripts are processed separately
      // above (they get their own tool_facts), but the parent→child link is
      // recorded once on the lead.
      if (isLead) {
        await ingestDelegationRange(db, runId, path, range.eofOffset, state);
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
    run.squad ? ledger.squadProjectsRoot(run.squad) : null,
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

// ---------------------------------------------------------------------------
// Transcript metadata (backfill) — one chunked pass instead of three full reads
// ---------------------------------------------------------------------------

/**
 * Everything backfill needs from a transcript, in ONE chunked streaming pass:
 * the first sessionId, the LAST workspace observation (cwd/branch/timestamp —
 * last line wins, same as the old latestWorkspaceFromTranscript), and the
 * timestamp of the first line mentioning run-manifest.mjs together with the
 * manifest's auto-picked taskId (same as the old taskLinkTimeFromTranscript).
 *
 * The old code full-read the file up to three separate times per manifest
 * (ledger.parseTranscript + latestWorkspaceFromTranscript +
 * taskLinkTimeFromTranscript); this replaces all three. Line offsets are not
 * consumed here, so byte-accurate offsets for events stay the domain of
 * ingestTranscriptRange.
 */
async function scanTranscriptMeta(path, taskId) {
  const normalized = taskId ? taskId.toUpperCase() : null;
  let sessionId = null;
  let cwd = null;
  let branch = null;
  let observedAt = null;
  let taskLinkTime = null;
  // FOC-547 (AC2): this scans a FULL lead transcript on first ingest (it must
  // reach EOF for the latest cwd/branch), and the chunk reads are synchronous
  // — a bare `for await` never reaches the event loop, measured as one
  // multi-second block per transcript on the real corpus. The pacer yields at
  // least every ~40 ms of accumulated work.
  const pacer = createPacer();
  for await (const { lines } of jsonlChunksFrom(path, 0)) {
    await pacer();
    for (const { raw } of lines) {
      if (!raw) continue;
      let line = null;
      try { line = JSON.parse(raw); } catch { /* ignore malformed rows */ }
      if (normalized && !taskLinkTime && raw.includes("run-manifest.mjs") && raw.toUpperCase().includes(normalized)) {
        if (line?.timestamp) taskLinkTime = line.timestamp;
      }
      if (!line) continue;
      if (line.sessionId && !sessionId) sessionId = line.sessionId;
      cwd = line.relocatedCwd || line.worktreeSession?.worktreePath || line.cwd || cwd;
      branch = line.worktreeSession?.worktreeBranch || line.gitBranch || branch;
      observedAt = line.timestamp || observedAt;
    }
  }
  return { sessionId, workspace: cwd ? { cwd, branch, observedAt } : null, taskLinkTime };
}

// ---------------------------------------------------------------------------
// Lazy runId → transcript index (bounded fallback, FOC-547 AC3)
// ---------------------------------------------------------------------------

/**
 * Locate a legacy transcript by runId WITHOUT reading every file per manifest.
 *
 * The old transcriptContainingRunId() ran a full readFileSync+includes sweep
 * over agents/<squad>/projects for EVERY manifest (~1014 manifests × the whole
 * corpus = the dominant backfill blocker). This builds the same runId→path
 * mapping with ONE chunked streamed sweep per squad root, lazily — only when a
 * manifest actually has no recorded path — and reuses it for every subsequent
 * miss. Files are matched on the runId token pattern; a runId that appears in
 * no file stays unlocated (null), exactly like the old sweep coming up empty.
 * Only direct children of the hash directories are indexed (lead transcripts);
 * subagents/ subtrees are not — the old two-level readdir saw the same files.
 */
async function buildRunIdTranscriptIndex(projectsRoot) {
  const index = new Map();
  let hashDirs;
  try { hashDirs = readdirSync(projectsRoot); } catch { return index; }
  // FOC-547 (AC2): this sweep reads the WHOLE per-squad projects corpus line
  // by line. The reads are synchronous, so a bare `for await` over the
  // chunk generator drains its already-resolved promises in microtasks and
  // never reaches the event loop — measured as one uninterrupted 0.8–5 s
  // block per squad root on the real corpus. The pacer returns control to
  // the loop at least every ~40 ms of accumulated sweep work.
  const pacer = createPacer();
  for (const hashDirectory of hashDirs) {
    const hashPath = join(projectsRoot, hashDirectory);
    let isDir = false;
    try { isDir = statSync(hashPath).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    let files;
    try {
      files = readdirSync(hashPath).filter((name) => name.endsWith(".jsonl"));
    } catch { continue; }
    for (const file of files) {
      const candidate = join(hashPath, file);
      try {
        for await (const { lines } of jsonlChunksFrom(candidate, 0, { chunkBytes: 1 << 20 })) {
          await pacer();
          for (const { raw } of lines) {
            if (!raw) continue;
            for (const match of raw.match(RUN_ID_PATTERN) || []) {
              if (!index.has(match)) index.set(match, candidate);
            }
          }
        }
      } catch {
        // Unreadable file — skip; the manifest stays unlocated.
      }
    }
  }
  return index;
}

/**
 * RunId → transcript path for manifests with no recorded path, via the lazy
 * per-squad index. indexCache is per-backfill.
 */
async function runIdTranscriptLookup(manifest, indexCache) {
  if (!manifest.runId || !manifest.squad) return null;
  let index = indexCache.get(manifest.squad);
  if (index === undefined) {
    index = await buildRunIdTranscriptIndex(ledger.squadProjectsRoot(manifest.squad));
    indexCache.set(manifest.squad, index);
  }
  return index.get(manifest.runId) || null;
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

// FOC-547 (AC2): paced — ~1000 small manifest reads in a bare synchronous
// loop measure as one ~0.4 s event-loop block. The pacer yields at least
// every ~40 ms of reads.
async function manifests() {
  const runsDir = ledger.runsManifestDir();
  if (!existsSync(runsDir)) return [];
  const pacer = createPacer();
  const out = [];
  for (const file of readdirSync(runsDir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(runsDir, file);
    try { out.push({ path, manifest: JSON.parse(readFileSync(path, "utf8")) }); } catch { /* skip malformed */ }
    await pacer();
  }
  return out;
}

export async function backfill(options = {}) {
  const summary = { manifests: 0, runs: 0, transcripts: 0, usageEvents: 0, missingTranscripts: 0, pending: 0 };
  summary.pending = replayPending(options).ingested;
  const sourceRuns = await ledger.scanRuns();
  const discovered = new Map(sourceRuns.map((run) => [run.runId, run]));
  // Per-backfill cache for the lazy runId→transcript index (one sweep per
  // squad root at most — see buildRunIdTranscriptIndex).
  const runIdIndexes = new Map();
  // One db connection for the whole loop: recordManifest/recordTaskLink/…
  // (options.db) and ingestTranscript (first argument) share it instead of
  // paying an open + migrate + close per manifest and per record (FOC-547).
  const db = await openTelemetryDb(options.dbPath);
  try {
    // FOC-547 (AC2): the per-manifest work between transcripts is synchronous
    // (SQL checks, record* emits, fs) and the `await`s inside are microtask-
    // only — a bare loop can run its whole body without one event-loop
    // iteration. Pace it: at least one loop turn every ~40 ms of work.
    const pacer = createPacer();
    for (const { path, manifest } of await manifests()) {
      summary.manifests++;
      await pacer();
      const aggregate = discovered.get(manifest.runId);
      if (aggregate?.ambiguous || manifest.sessionAmbiguous) {
        reportDataQuality(manifest.runId, "legacy_session_ambiguous", {
          sessionId: manifest.sessionId || aggregate?.sessionId || null,
          transcriptPath: manifest.transcriptPath || aggregate?.transcriptPath || null,
        }, { ...options, db, sourceKind: "legacy-discovery", severity: "warning" });
      }
      const recoveredPath = manifest.transcriptPath || aggregate?.transcriptPath
        ? null
        : await runIdTranscriptLookup(manifest, runIdIndexes);
      const transcriptPath = manifest.transcriptPath || aggregate?.transcriptPath || recoveredPath || null;

      // FOC-547: metadata (sessionId fallback / latest workspace / auto-task
      // pick time) needs transcript reads. They run only when THIS file
      // version has not been ingested before — once transcript_sources shows
      // the (path, run) row parsed at the current size, the previous pass
      // already recorded everything the reads produce (all of it is event-
      // deduped downstream), and re-reading is pure waste on every boot.
      let leadSettled = false;
      let leadSize = 0;
      if (transcriptPath && existsSync(transcriptPath)) {
        try {
          leadSize = statSync(transcriptPath).size;
          const leadKnown = db.prepare("SELECT file_size, parse_status FROM transcript_sources WHERE source_path=? AND run_id=?").get(transcriptPath, manifest.runId);
          leadSettled = Boolean(leadKnown?.parse_status === "parsed" && leadKnown.file_size === leadSize);
        } catch { /* unreadable — treat as unsettled */ }
      }
      let sessionId = manifest.sessionId || aggregate?.sessionId || null;
      let workspace = null;
      let pickTime = null;
      const needsTaskPickTime = !manifest.taskId && manifest.taskIdAuto;
      if (transcriptPath && existsSync(transcriptPath) && !leadSettled) {
        const meta = await scanTranscriptMeta(transcriptPath, needsTaskPickTime ? manifest.taskIdAuto : null);
        if (!sessionId) sessionId = meta.sessionId;
        workspace = meta.workspace;
        pickTime = meta.taskLinkTime;
      }

      const startManifest = manifest.taskIdAuto ? { ...manifest, taskIdAuto: null } : manifest;
      // FOC-547 (D2): the record* calls below emit workspace.observed events
      // whose synchronous apply consults git per cwd. Prefetch the facts with
      // async git first (git runs while the event loop is free) so the apply
      // is a cache hit — a cold sync git call measured up to ~600 ms.
      {
        const warmCwds = new Set();
        if (manifest.cwd) warmCwds.add(manifest.cwd);
        if (workspace?.cwd) warmCwds.add(workspace.cwd);
        if (aggregate?.cwd) warmCwds.add(aggregate.cwd);
        if (warmCwds.size > 0) await warmGitFacts([...warmCwds]);
        recordManifest(startManifest, "started", { ...options, db, sourcePath: path });
        if (manifest.endedAt) recordManifest(manifest, "ended", { ...options, db, sourcePath: path });
        if (!manifest.taskId && manifest.taskIdAuto) {
          recordTaskLink(manifest.runId, manifest.taskIdAuto, "agent_pick", {
            ...options,
            db,
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
            db,
            observedAt: manifest.startedAt,
            confidence: aggregate.taskIdKickoff ? 0.7 : 0.4,
            sourceKind: "legacy-inference",
            sourcePath: path,
            sourceOffset: 4,
          });
        }
        if (sessionId) {
          recordSessionLink(manifest.runId, sessionId, { transcriptPath, source: manifest.sessionId ? "manifest" : "legacy_discovery" }, { ...options, db });
        }
        if (workspace || aggregate?.cwd) {
          const cwd = workspace?.cwd || aggregate.cwd;
          const branch = workspace?.branch || aggregate.gitBranch || null;
          recordWorkspace(manifest.runId, cwd, { ...refFromBranch(branch), headSha: null, source: "legacy_transcript" }, {
            ...options,
            db,
            observedAt: workspace?.observedAt || manifest.endedAt || manifest.startedAt,
          });
        }
      }
      const result = await ingestTranscript(db, manifest.runId, transcriptPath, sessionId);
      if (result.missing) {
        summary.missingTranscripts++;
        if (!hasOpenQualityIssue(db, manifest.runId, "transcript_missing")) {
          reportDataQuality(manifest.runId, "transcript_missing", { manifestPath: path, sessionId }, { ...options, db });
        }
      }
      else { summary.transcripts += result.files; summary.usageEvents += result.events; }
      summary.runs++;
    }
  } finally {
    await db.close();
  }
  return summary;
}

// A run that has ENDED does not need its transcript re-read every 15 seconds.
//
// The skip cache inside ingestTranscript compares FILE SIZE, so a transcript
// that is still growing defeats it forever — and a finished run's transcript
// keeps growing whenever something else is still writing to that file: a live
// session, or a stale run->session link pointing this run at someone else's
// transcript.
//
// Measured 2026-09-05, before this gate: 68.7 MB of JSON re-parsed on every
// cycle, with one 16.7 MB file parsed FOUR times over because four completed
// August runs all claimed it. That is synchronous work on Node's single
// thread, so every dashboard request queued behind it — /api/runs took 24.9 s
// and even a 404 took 25.6 s.
//
// The grace window exists because `run-manifest end` writes the manifest
// before the transcript's last lines are necessarily flushed. Inside it the
// run is re-read normally; only afterwards is it considered settled.
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed"]);
const REINGEST_GRACE_MS = 5 * 60 * 1000;

/**
 * True when this run is finished, past the flush grace, and already has its
 * transcript parsed — so anything the file gained since belongs to someone
 * else. A run that ended but was NEVER ingested is not settled: it still needs
 * its one pass, otherwise a crash during ingest would lose it permanently.
 */
function settledRun(db, run) {
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return false;
  const ended = run.endedAt ? new Date(run.endedAt).getTime() : NaN;
  if (!Number.isFinite(ended)) return false;
  if (Date.now() - ended <= REINGEST_GRACE_MS) return false;
  const pending = db
    .prepare("SELECT COUNT(*) AS c FROM transcript_sources WHERE run_id=? AND parse_status<>'parsed'")
    .get(run.runId);
  const parsed = db
    .prepare("SELECT COUNT(*) AS c FROM transcript_sources WHERE run_id=? AND parse_status='parsed'")
    .get(run.runId);
  return (parsed?.c ?? 0) > 0 && (pending?.c ?? 0) === 0;
}

export async function ingestKnownRuns(options = {}) {
  const db = openTelemetryDb(options.dbPath);
  const summary = { runs: 0, transcripts: 0, usageEvents: 0, missingTranscripts: 0, settled: 0 };
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
    // FOC-547 (AC2): for settled runs this loop is pure synchronous SQL plus
    // microtask awaits — measured as one multi-second continuous block per
    // tick with no loop iteration at all (the phase histogram missed it
    // because its resume sample landed after the stats were read). Pace it.
    const pacer = createPacer();
    for (const run of await queryRunsForIngest(db)) {
      await pacer();
      // Checked before transcriptForSession: that helper stats the path and
      // may search three roots for it, which is itself per-run work this loop
      // repeats every 15 s for runs that finished days ago.
      if (await settledRun(db, run)) {
        summary.settled++;
        continue;
      }
      const transcriptPath = await transcriptForSession(run);
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
    await db.close();
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
