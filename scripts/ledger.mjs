// Telemetry ledger — transcript parser, cost calculator, run aggregator.
//
// ESM, zero deps (Node 22 built-ins only). Pricing from config/models.json.
//
// Exports:
//   parseTranscript(absPath)  -> { sessionId, cwd, gitBranch, turns }
//   costTokens(usage, model) -> number (USD)
//   aggregateRun(manifest)    -> { runId, squad, ..., totals, byModel, byAgent }
//   scanRuns()                -> array of aggregateRun results
//   liveRuns(now)             -> scanRuns() filtered to active runs
//   listTranscriptDir()       -> resolved project transcript directory

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

/** Lazy-loaded pricing table from config/models.json. */
let _pricing = null;
function getPricing() {
  if (_pricing) return _pricing;
  try {
    const cfg = JSON.parse(readFileSync(join(root, "config", "models.json"), "utf8"));
    _pricing = cfg.pricing || {};
  } catch {
    _pricing = {};
  }
  return _pricing;
}

/**
 * Resolve a transcript model slug to a pricing entry.
 *
 * Tries, in order:
 *   1. Exact match on the pricing key.
 *   2. Short-name match (last segment after `/`), with `.`/`-` normalization.
 *   3. Substring containment (handles versioned slugs like
 *      `deepseek/deepseek-v4-flash-20260423` → `deepseek/deepseek-v4-flash`).
 *
 * Returns the pricing object `{ input, output }` or `null`.
 */
function resolvePricing(modelSlug, pricing) {
  if (!modelSlug || typeof modelSlug !== "string") return null;
  const slug = modelSlug.trim();
  if (!slug || slug === "synthetic") return null;

  // 1. Exact match
  if (pricing[slug]) return pricing[slug];

  // 2. Short-name match
  const short = slug.split("/").pop();
  for (const [key, val] of Object.entries(pricing)) {
    const keyShort = key.split("/").pop();
    if (keyShort === short) return val;
    // Normalize . vs - (e.g. claude-sonnet-4-6 vs claude-sonnet-4.6)
    if (keyShort.replace(/\./g, "-") === short.replace(/\./g, "-")) return val;
  }

  // 3. Substring containment (versioned slugs)
  for (const [key, val] of Object.entries(pricing)) {
    const keyShort = key.split("/").pop();
    if (slug.includes(keyShort) || keyShort.includes(slug)) return val;
  }

  return null;
}

/**
 * Normalize a Windows path for hash computation.
 * Converts `/c/Users/...` (Git Bash) to `C:\Users\...` and ensures `\` separators.
 */
function normalizePathForHash(p) {
  let normalized = p;
  // Handle Git Bash /c/Users/... paths
  if (normalized.startsWith("/") && /^\/[a-zA-Z]\//.test(normalized)) {
    normalized = normalized[1].toUpperCase() + ":" + normalized.slice(2);
  }
  return normalized.replace(/\//g, "\\");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the project transcript directory under ~/.claude/projects/.
 *
 * Derives the expected hash from process.cwd(), then falls back to globbing
 * for `*linear-agents` in the projects dir.
 */
export function cwdToHashName(cwd) {
  // Match the claude CLI's hash: replace `:` with `-` first, then `\` with `-`.
  // E.g. C:\Users\... → C-\Users\... → C--Users-...
  return normalizePathForHash(cwd).replace(/:/g, "-").replace(/\\/g, "-");
}

export function listTranscriptDir() {
  const projectsDir = join(homedir(), ".claude", "projects");
  const hashName = cwdToHashName(process.cwd());
  const exactPath = join(projectsDir, hashName);

  if (existsSync(exactPath) && statSync(exactPath).isDirectory()) {
    return exactPath;
  }

  // Fallback: glob for *linear-agents
  try {
    const entries = readdirSync(projectsDir);
    const match = entries.find(
      (e) => e.includes("linear-agents") && statSync(join(projectsDir, e)).isDirectory(),
    );
    if (match) return join(projectsDir, match);
  } catch {
    // projectsDir doesn't exist or isn't readable
  }

  return exactPath;
}

/**
 * Parse a single transcript .jsonl file.
 *
 * @param {string} absPath  Absolute path to the .jsonl file.
 * @returns {{ sessionId: string|null, cwd: string|null, gitBranch: string|null, turns: Array<object> }}
 *
 * Each turn: `{ model, attributionAgent, inputTokens, outputTokens, cacheCreation, cacheRead, ts }`.
 * Subagent files in a sibling `subagents/` directory are merged in when present.
 */
export function parseTranscript(absPath) {
  const result = {
    sessionId: null,
    cwd: null,
    gitBranch: null,
    turns: [],
  };

  if (!existsSync(absPath)) return result;

  const lines = readFileSync(absPath, "utf8").split("\n").filter(Boolean);
  const parentDir = dirname(absPath);

  for (const raw of lines) {
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // skip malformed lines
    }
    if (!line || typeof line !== "object") continue;

    // Capture session metadata from any line that carries it
    if (line.sessionId && !result.sessionId) result.sessionId = line.sessionId;
    if (line.cwd && !result.cwd) result.cwd = line.cwd;
    if (line.gitBranch && !result.gitBranch) result.gitBranch = line.gitBranch;

    // Only assistant lines carry usage data
    if (line.type !== "assistant") continue;
    if (!line.message || !line.message.usage) continue;

    const msg = line.message;
    const usage = msg.usage;

    result.turns.push({
      model: msg.model || null,
      attributionAgent: line.attributionAgent || null,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      ts: line.timestamp || null,
    });
  }

  // Merge subagent transcripts from sibling subagents/ directory
  const subagentsDir = join(parentDir, "subagents");
  if (existsSync(subagentsDir) && statSync(subagentsDir).isDirectory()) {
    let agentFiles;
    try {
      agentFiles = readdirSync(subagentsDir).filter(
        (f) => f.startsWith("agent-") && f.endsWith(".jsonl") && !f.endsWith(".meta.json"),
      );
    } catch {
      agentFiles = [];
    }

    for (const agentFile of agentFiles) {
      const agentLines = readFileSync(join(subagentsDir, agentFile), "utf8")
        .split("\n")
        .filter(Boolean);

      for (const raw of agentLines) {
        let line;
        try {
          line = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!line || typeof line !== "object") continue;
        if (line.type !== "assistant") continue;
        if (!line.message || !line.message.usage) continue;

        const msg = line.message;
        const usage = msg.usage;

        result.turns.push({
          model: msg.model || null,
          attributionAgent: line.attributionAgent || null,
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheCreation: usage.cache_creation_input_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          ts: line.timestamp || null,
        });
      }
    }
  }

  return result;
}

/**
 * Compute USD cost for a set of token counts given a model slug.
 *
 * Pricing is loaded from config/models.json. Matches cost-report.mjs approach:
 *   cost = (inputTokens / 1_000_000) * pricing.input
 *        + (outputTokens / 1_000_000) * pricing.output
 *
 * Cache tokens are NOT costed separately (matching cost-report.mjs which only
 * handles prompt + completion tokens from OpenRouter activity).
 *
 * @param {{ inputTokens: number, outputTokens: number, cacheCreation: number, cacheRead: number }} usage
 * @param {string} modelSlug
 * @returns {number} USD cost (0 if model not in pricing)
 */
export function costTokens(usage, modelSlug) {
  const pricing = getPricing();
  const p = resolvePricing(modelSlug, pricing);
  if (!p) return 0;

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;

  return (input / 1_000_000) * p.input + (output / 1_000_000) * p.output;
}

/**
 * Aggregate parsed transcript turns into a result accumulator.
 *
 * Shared between exact-match (sessionId) and window-based (legacy) paths.
 *
 * @param {object} result  Mutable result accumulator (totals, byModel, byAgent)
 * @param {object} parsed  Return value from parseTranscript()
 */
function aggregateTurns(result, parsed) {
  for (const turn of parsed.turns) {
    // Totals
    result.totals.inputTokens += turn.inputTokens;
    result.totals.outputTokens += turn.outputTokens;
    result.totals.cacheReadTokens += turn.cacheRead;

    // By model
    const modelKey = turn.model || "unknown";
    if (!result.byModel[modelKey]) {
      result.byModel[modelKey] = { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    }
    result.byModel[modelKey].inputTokens += turn.inputTokens;
    result.byModel[modelKey].outputTokens += turn.outputTokens;

    // By agent
    const agentKey = turn.attributionAgent || "_lead";
    if (!result.byAgent[agentKey]) {
      result.byAgent[agentKey] = { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    }
    result.byAgent[agentKey].inputTokens += turn.inputTokens;
    result.byAgent[agentKey].outputTokens += turn.outputTokens;

    // Per-turn cost — computed once using turn.model, added to both buckets
    const turnCost = costTokens(
      { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, cacheCreation: turn.cacheCreation, cacheRead: turn.cacheRead },
      turn.model,
    );
    result.byModel[modelKey].costUSD += turnCost;
    result.byAgent[agentKey].costUSD += turnCost;
    result.totals.costUSD += turnCost;
  }
}

/**
 * Find transcripts matching a run manifest and aggregate tokens/cost.
 *
 * Two matching modes:
 *   1. EXACT (sessionId set) — parse ONLY the named transcript file.
 *      Sets `ambiguous` from manifest.sessionAmbiguous.
 *   2. WINDOW (sessionId null/undefined) — legacy: match by cwd + gitBranch +
 *      timestamp window [startedAt-2min, endedAt+2min].
 *
 * @param {object} manifest  Run manifest object from .state/runs/<runId>.json
 * @returns {object} Aggregated run result
 */
export function aggregateRun(manifest) {
  const transcriptDir = listTranscriptDir();
  const result = {
    runId: manifest.runId,
    squad: manifest.squad || null,
    source: manifest.source || null,
    brief: manifest.brief || null,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt || null,
    status: manifest.endedAt ? "completed" : "running",
    ambiguous: false,
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0 },
    byModel: {},
    byAgent: {},
  };

  // -----------------------------------------------------------------------
  // EXACT MATCH: manifest has a captured sessionId
  // -----------------------------------------------------------------------
  if (manifest.sessionId) {
    const transcriptPath =
      manifest.transcriptPath || join(transcriptDir, manifest.sessionId + ".jsonl");
    const parsed = parseTranscript(transcriptPath);

    if (parsed.turns.length === 0) {
      result.missing = true;
      return result;
    }

    result.ambiguous = manifest.sessionAmbiguous || false;

    // Filter turns to those within the run window [startedAt, endedAt+60s]
    // so that pre-existing session data (same sessionId, earlier turns) is excluded.
    const runStart = new Date(manifest.startedAt).getTime();
    const runEnd = manifest.endedAt
      ? new Date(manifest.endedAt).getTime() + 60 * 1000
      : Date.now() + 60 * 1000;

    const filtered = { turns: parsed.turns.filter((t) => {
      if (!t.ts) return false;
      const ts = new Date(t.ts).getTime();
      return ts >= runStart && ts <= runEnd;
    })};

    aggregateTurns(result, filtered);
    return result;
  }

  // -----------------------------------------------------------------------
  // WINDOW-BASED MATCHING (legacy, for manifests without sessionId)
  // -----------------------------------------------------------------------
  const startedAt = new Date(manifest.startedAt);
  const endedAt = manifest.endedAt ? new Date(manifest.endedAt) : new Date();
  const windowStart = new Date(startedAt.getTime() - 2 * 60 * 1000);
  const windowEnd = new Date(endedAt.getTime() + 2 * 60 * 1000);

  if (!existsSync(transcriptDir)) return result;

  let sessionFiles;
  try {
    sessionFiles = readdirSync(transcriptDir).filter(
      (f) => f.endsWith(".jsonl") && statSync(join(transcriptDir, f)).isFile(),
    );
  } catch {
    return result;
  }

  let matchedCount = 0;

  for (const sessionFile of sessionFiles) {
    const sessionPath = join(transcriptDir, sessionFile);
    const parsed = parseTranscript(sessionPath);

    // Check cwd + gitBranch match
    if (parsed.cwd !== manifest.cwd && normalizePathForHash(parsed.cwd) !== normalizePathForHash(manifest.cwd)) {
      continue;
    }
    if (parsed.gitBranch !== manifest.gitBranch) continue;

    // Check timestamp window: first assistant turn's ts must be within window
    const firstAssistant = parsed.turns.find((t) => t.ts);
    if (!firstAssistant) continue;

    const firstTs = new Date(firstAssistant.ts);
    if (firstTs < windowStart || firstTs > windowEnd) continue;

    matchedCount++;
    aggregateTurns(result, parsed);
  }

  if (matchedCount > 1) result.ambiguous = true;

  return result;
}

/**
 * Scan all run manifests in .state/runs/ and aggregate each.
 *
 * @returns {Promise<Array<object>>} Sorted by startedAt descending (newest first).
 */
export async function scanRuns() {
  const runsDir = join(root, ".state", "runs");
  if (!existsSync(runsDir)) return [];

  let files;
  try {
    files = readdirSync(runsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const results = [];
  for (const f of files) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(runsDir, f), "utf8"));
    } catch {
      continue; // skip malformed manifests
    }
    results.push(aggregateRun(manifest));
  }

  // Sort by startedAt descending (newest first)
  results.sort((a, b) => {
    const da = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const db = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return db - da;
  });

  return results;
}

/**
 * Filter scanRuns() to currently-active runs.
 *
 * A run is "live" if endedAt is null OR it ended within the last 10 minutes.
 *
 * @param {Date} [now=new Date()]
 * @returns {Promise<Array<object>>}
 */
export async function liveRuns(now) {
  const _now = now || new Date();
  const all = await scanRuns();
  const cutoff = _now.getTime() - 10 * 60 * 1000;

  return all.filter((r) => {
    if (!r.endedAt) return true;
    const ended = new Date(r.endedAt).getTime();
    return ended >= cutoff;
  });
}
