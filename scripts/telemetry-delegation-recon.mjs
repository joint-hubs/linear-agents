#!/usr/bin/env node
/**
 * scripts/telemetry-delegation-recon.mjs — reconstruct parent→child delegation
 * links from transcript directories.
 *
 * Scans a lead transcript's subagents/ directory, matches each subagent to
 * the lead's Agent/Task/agent_spawn tool_use blocks, and produces records
 * ready for insertion into the `delegation_links` table (see
 * docs/plans/agent-intelligence.md §7.2).
 *
 * This module does NOT touch SQLite. Fields that require SQLite aggregation
 * (child_tokens, child_cost_usd, child_turns) are returned as null — a
 * separate post-pass populates them from usage_facts / cost_facts.
 *
 * Usage:
 *   node scripts/telemetry-delegation-recon.mjs <lead-transcript.jsonl> [runId] [parentAgent]
 *   node scripts/telemetry-delegation-recon.mjs --test
 *
 * Import:
 *   import { reconstructDelegationLinks, findSubagentTranscripts, resolveChildAgentKey }
 *     from './scripts/telemetry-delegation-recon.mjs';
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool names that indicate a subagent spawn in the lead transcript. */
const SPAWN_TOOL_NAMES = new Set(["Agent", "Task", "agent_spawn"]);

// ---------------------------------------------------------------------------
// Exported: findSubagentTranscripts
// ---------------------------------------------------------------------------

/**
 * Find all subagent transcript files under a lead transcript's subagents/ dir.
 *
 * Mirrors the convention in telemetry-ingest.mjs:subagentPaths() — tries two
 * candidate layouts:
 *   1. `<dirname(leadPath)>/<sessionId>/subagents/` (session-named subdirectory)
 *   2. `<dirname(leadPath)>/subagents/` (flat subagents directory)
 *
 * @param {string} leadTranscriptPath - Path to the lead's .jsonl transcript
 * @returns {Array<{path: string, agentHash: string}>}
 *   Empty array if no subagent directory exists or is unreadable.
 */
export function findSubagentTranscripts(leadTranscriptPath) {
  const dir = dirname(leadTranscriptPath);
  const sessionId = basename(leadTranscriptPath, ".jsonl");

  const candidates = [
    join(dir, sessionId, "subagents"),
    join(dir, "subagents"),
  ];

  const subDir = candidates.find((candidate) => existsSync(candidate));
  if (!subDir) return [];

  try {
    return readdirSync(subDir)
      .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl") && !f.endsWith(".meta.json"))
      .map((f) => ({
        path: join(subDir, f),
        agentHash: f.replace(/^agent-/, "").replace(/\.jsonl$/, ""),
      }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Exported: resolveChildAgentKey
// ---------------------------------------------------------------------------

/**
 * Resolve the child agent_key for a subagent transcript by scanning the lead
 * transcript for matching Agent/Task/agent_spawn tool_use blocks.
 *
 * Strategy (in order of reliability):
 * 1. Read the subagent transcript's assistant messages for `attributionAgent`
 *    (e.g., "first-pass", "security", "deep").
 * 2. Scan the lead transcript for tool_use blocks with names in
 *    ['Agent', 'Task', 'agent_spawn'].
 * 3. Match by subagent_type (from lead tool_use) === attributionAgent
 *    (from subagent transcript).
 * 4. If no match, fall back to 'agent-<hash>' from the filename.
 *
 * @param {object} opts
 * @param {string} opts.leadTranscriptPath - Path to the lead's .jsonl transcript
 * @param {string} opts.subagentPath - Path to the subagent's .jsonl transcript
 * @returns {string} The resolved agent_key
 */
export function resolveChildAgentKey({ leadTranscriptPath, subagentPath }) {
  // 1. Read subagent metadata
  const subMeta = readSubagentMetadata(subagentPath);
  if (!subMeta) return agentKeyFromPath(subagentPath);

  // 2. If we have an attributionAgent, try to match it against the lead's
  //    spawn tool_use blocks to confirm the role name is correct.
  if (subMeta.attributionAgent) {
    const spawns = findSpawnToolUses(leadTranscriptPath);
    const match = spawns.find((s) => s.subagentType === subMeta.attributionAgent);
    if (match) return subMeta.attributionAgent;
  }

  // 3. Fall back to 'agent-<hash>' from the filename
  return agentKeyFromPath(subagentPath);
}

// ---------------------------------------------------------------------------
// Exported: reconstructDelegationLinks
// ---------------------------------------------------------------------------

/**
 * Reconstruct delegation links from a lead transcript and its subagents/ dir.
 *
 * For each subagent found, produces a record matching the delegation_links
 * schema (docs/plans/agent-intelligence.md §7.2). Fields that require SQLite
 * aggregation (child_tokens, child_cost_usd, child_turns) are returned as
 * null — a separate post-pass populates them from usage_facts / cost_facts.
 *
 * Records are deduped by (parent_run_id, parent_agent, child_agent, observed_at).
 *
 * @param {object} opts
 * @param {string} opts.runId - The run_id for the parent run
 * @param {string} opts.parentAgent - The parent agent_key (e.g., 'lead')
 * @param {string} opts.transcriptPath - Path to the lead's .jsonl transcript
 * @returns {Array<object>} Delegation link records, or [] if none found
 */
export function reconstructDelegationLinks({ runId, parentAgent, transcriptPath }) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];

  const subagents = findSubagentTranscripts(transcriptPath);
  if (subagents.length === 0) return [];

  // Pre-scan lead transcript for spawn tool_use blocks (one pass, not per subagent)
  const spawns = findSpawnToolUses(transcriptPath);

  const records = [];
  const seen = new Set();

  for (const sub of subagents) {
    const subMeta = readSubagentMetadata(sub.path);
    if (!subMeta) continue;

    // Resolve child agent_key
    let childAgent = agentKeyFromPath(sub.path);
    if (subMeta.attributionAgent) {
      const match = spawns.find((s) => s.subagentType === subMeta.attributionAgent);
      if (match) childAgent = subMeta.attributionAgent;
    }

    // Find the matching spawn event for observed_at
    const spawnEvent = subMeta.attributionAgent
      ? spawns.find((s) => s.subagentType === subMeta.attributionAgent)
      : null;

    const observedAt = spawnEvent?.timestamp || subMeta.firstTimestamp || new Date().toISOString();

    // Build dedup key: (parent_run_id, parent_agent, child_agent, observed_at)
    const dedupKey = `${runId}|${parentAgent}|${childAgent}|${observedAt}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // delegation_id = hash of the dedup key (matches the SQL PK convention)
    const delegationId = createHash("sha256")
      .update(dedupKey)
      .digest("hex")
      .slice(0, 16);

    records.push({
      delegation_id: delegationId,
      parent_run_id: runId,
      parent_agent: parentAgent,
      child_agent: childAgent,
      child_model: subMeta.model || null,
      child_transcript: sub.path,
      observed_at: observedAt,
      // child_tokens, child_cost_usd, child_turns are null here because this
      // module does NOT query SQLite. A separate post-pass (in the orchestrator
      // or telemetry-ingest integration) populates them from usage_facts and
      // cost_facts for the same (run_id, agent_key) pair.
      child_tokens: null,
      child_cost_usd: null,
      child_turns: null,
      source: "transcript",
      created_at: new Date().toISOString(),
    });
  }

  return records;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read subagent metadata from its transcript.
 *
 * Scans the first N lines for:
 * - `agentId` (from user messages — matches the filename hash)
 * - `attributionAgent` (from assistant messages — the role name)
 * - `model` (from assistant messages — the model slug)
 * - `firstTimestamp` (earliest timestamp in the transcript)
 *
 * @param {string} subagentPath
 * @returns {{ agentId: string|null, attributionAgent: string|null, model: string|null, firstTimestamp: string|null } | null}
 */
function readSubagentMetadata(subagentPath) {
  try {
    const content = readFileSync(subagentPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    let agentId = null;
    let attributionAgent = null;
    let model = null;
    let firstTimestamp = null;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);

        // Capture first timestamp from any line
        if (!firstTimestamp && parsed.timestamp) {
          firstTimestamp = parsed.timestamp;
        }

        // agentId from user messages (sidechain subagents)
        if (parsed.agentId) {
          agentId = parsed.agentId;
        }

        // attributionAgent from assistant messages
        if (parsed.attributionAgent) {
          attributionAgent = parsed.attributionAgent;
        }

        // model from assistant messages (first one wins — all should be same)
        if (parsed.type === "assistant" && parsed.message?.model && !model) {
          model = parsed.message.model;
        }
      } catch {
        // Skip unparseable lines
        continue;
      }
    }

    return { agentId, attributionAgent, model, firstTimestamp };
  } catch {
    return null;
  }
}

/**
 * Scan the lead transcript for spawn tool_use blocks.
 *
 * Looks for assistant messages whose content contains a tool_use block with
 * name in ['Agent', 'Task', 'agent_spawn'].
 *
 * @param {string} leadTranscriptPath
 * @returns {Array<{subagentType: string|null, description: string|null, timestamp: string|null}>}
 */
function findSpawnToolUses(leadTranscriptPath) {
  const results = [];
  try {
    const content = readFileSync(leadTranscriptPath, "utf8");
    for (const line of content.split("\n").filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== "assistant") continue;
        if (!parsed.message?.content) continue;

        const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : [];
        for (const block of blocks) {
          if (block.type === "tool_use" && SPAWN_TOOL_NAMES.has(block.name)) {
            results.push({
              subagentType: block.input?.subagent_type || null,
              description: block.input?.description || null,
              timestamp: parsed.timestamp || null,
            });
          }
        }
      } catch {
        // Skip unparseable lines
        continue;
      }
    }
  } catch {
    // File not readable — return empty
  }
  return results;
}

/**
 * Extract agent_key from a subagent transcript path.
 *
 * Given `/path/to/subagents/agent-abc123.jsonl`, returns `agent-abc123`.
 * This matches the agent_key convention used in usage_facts.
 */
function agentKeyFromPath(subagentPath) {
  return basename(subagentPath).replace(/\.jsonl$/, "");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] === __filename ||
  (process.argv[1] && basename(process.argv[1]) === basename(__filename));

if (isMain) {
  const args = process.argv.slice(2);

  if (args.includes("--test")) {
    runSelfTest();
  } else if (args.length >= 1 && !args[0].startsWith("--")) {
    const transcriptPath = args[0];
    const runId = args[1] || "test-run-id";
    const parentAgent = args[2] || "lead";
    const records = reconstructDelegationLinks({ runId, parentAgent, transcriptPath });
    console.log(JSON.stringify(records, null, 2));
  } else {
    console.error("Usage: node scripts/telemetry-delegation-recon.mjs <lead-transcript.jsonl> [runId] [parentAgent]");
    console.error("       node scripts/telemetry-delegation-recon.mjs --test");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * Self-test: creates a fake lead + subagent pair in a temp directory with
 * realistic JSONL structure, calls reconstructDelegationLinks, and asserts
 * at least 1 record with correct field values.
 *
 * Exits 0 on pass, 1 on fail.
 */
function runSelfTest() {
  const tmpDir = join(tmpdir(), "delegation-recon-test");

  // Clean and recreate
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });

  const sessionId = "test-session-12345678";
  const leadPath = join(tmpDir, `${sessionId}.jsonl`);
  const subDir = join(tmpDir, "subagents");
  mkdirSync(subDir, { recursive: true });

  const subAgentId = "testhash1234";
  const subPath = join(subDir, `agent-${subAgentId}.jsonl`);

  // ── Write lead transcript with Agent tool_use ──
  const leadLines = [
    JSON.stringify({
      type: "queue-operation", operation: "enqueue",
      timestamp: "2026-08-03T10:00:00.000Z", sessionId,
    }),
    JSON.stringify({
      type: "queue-operation", operation: "dequeue",
      timestamp: "2026-08-03T10:00:00.000Z", sessionId,
    }),
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: "Do the review" },
      uuid: "u1", timestamp: "2026-08-03T10:00:01.000Z", sessionId,
    }),
    JSON.stringify({
      parentUuid: "u1", isSidechain: false, type: "assistant",
      message: {
        id: "msg1", type: "message", role: "assistant",
        content: [{
          type: "tool_use", id: "call1", name: "Agent",
          input: {
            subagent_type: "first-pass",
            description: "First pass review",
            prompt: "Review the code",
          },
        }],
        model: "z-ai/glm-5.2-20260616",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      timestamp: "2026-08-03T10:00:02.000Z", sessionId,
    }),
  ];
  writeFileSync(leadPath, leadLines.join("\n") + "\n", "utf8");

  // ── Write subagent transcript ──
  const subLines = [
    JSON.stringify({
      parentUuid: null, isSidechain: true, agentId: subAgentId,
      type: "user",
      message: { role: "user", content: "Review the code" },
      uuid: "su1", timestamp: "2026-08-03T10:00:03.000Z", sessionId,
    }),
    JSON.stringify({
      parentUuid: "su1", isSidechain: true, agentId: subAgentId,
      type: "assistant",
      message: {
        id: "submsg1", type: "message", role: "assistant",
        content: [{ type: "text", text: "Findings: looks good" }],
        model: "deepseek/deepseek-v4-pro-20260423",
        usage: { input_tokens: 500, output_tokens: 200 },
      },
      attributionAgent: "first-pass",
      timestamp: "2026-08-03T10:00:05.000Z", sessionId,
    }),
  ];
  writeFileSync(subPath, subLines.join("\n") + "\n", "utf8");

  // ── Reconstruct ──
  const records = reconstructDelegationLinks({
    runId: "test-run-001",
    parentAgent: "lead",
    transcriptPath: leadPath,
  });

  let passed = true;

  if (records.length === 0) {
    console.error("FAIL: Expected at least 1 delegation record, got 0");
    passed = false;
  } else {
    const r = records[0];
    const checks = [
      ["parent_run_id", r.parent_run_id === "test-run-001"],
      ["parent_agent", r.parent_agent === "lead"],
      ["child_agent", r.child_agent === "first-pass"],
      ["child_model", r.child_model === "deepseek/deepseek-v4-pro-20260423"],
      ["child_transcript", r.child_transcript === subPath],
      ["observed_at", r.observed_at === "2026-08-03T10:00:02.000Z"],
      ["child_tokens is null", r.child_tokens === null],
      ["child_cost_usd is null", r.child_cost_usd === null],
      ["child_turns is null", r.child_turns === null],
      ["source", r.source === "transcript"],
      ["delegation_id present", typeof r.delegation_id === "string" && r.delegation_id.length > 0],
    ];

    for (const [name, ok] of checks) {
      if (!ok) {
        console.error(`FAIL: ${name} — got ${JSON.stringify(r[name.replace(/\s.*$/, "")] || r[Object.keys(r).find(k => name.startsWith(k))])}`);
        passed = false;
      }
    }
  }

  // Cleanup
  rmSync(tmpDir, { recursive: true });

  if (passed) {
    console.log("PASS: delegation-recon self-test");
    process.exit(0);
  } else {
    process.exit(1);
  }
}
