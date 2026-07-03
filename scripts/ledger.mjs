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
//   inferTaskIdFromBranch(branch) -> "FEN-98" | null
//   aggregateByTask(runs)     -> { [taskId]: { runs, costUSD, ... } }

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

/**
 * Infer a Linear-style task ID from a git branch name.
 *
 * Matches patterns like `fen-98-...` or `feat/pisi-98-...` or `feat/joi-51`
 * and returns normalized IDs like `FEN-98`, `PISI-98`, or `JOI-51`. Returns
 * null for branches that don't match (e.g. `feat/phase-a-offline-foundation`).
 *
 * @param {string|null|undefined} branch
 * @returns {string|null}
 */
export function inferTaskIdFromBranch(branch) {
  if (!branch || typeof branch !== "string") return null;
  const m = branch.match(/(?:^|\/)(fen|pisi|joi)-(\d+)/i);
  if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  return null;
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
 * Pricing is loaded from config/models.json. Cost components:
 *   input  = (inputTokens / 1_000_000) * pricing.input
 *   output = (outputTokens / 1_000_000) * pricing.output
 *   cacheRead = (cacheRead / 1_000_000) * cacheReadRate
 *   cacheCreation = (cacheCreation / 1_000_000) * inputRate
 *
 * Cache read rate: uses pricing.cacheRead if present, else defaults to
 * 10% of input rate (Anthropic-style prompt caching convention).
 * Cache creation is costed at the input (write) rate, matching Anthropic's
 * cache-write pricing (≈ input price).
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
  const cacheRead = usage.cacheRead ?? 0;
  const cacheCreation = usage.cacheCreation ?? 0;

  // Cache read: explicit rate if configured, else default 10% of input rate
  const cacheReadRate = p.cacheRead != null ? p.cacheRead : 0.1 * p.input;

  // Cache creation: cost at input (write) rate
  const cacheCreationRate = p.input;

  return (input / 1_000_000) * p.input
       + (output / 1_000_000) * p.output
       + (cacheRead / 1_000_000) * cacheReadRate
       + (cacheCreation / 1_000_000) * cacheCreationRate;
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
    result.totals.cacheReadInputTokens += turn.cacheRead;
    result.totals.cacheCreationInputTokens += turn.cacheCreation;

    // By model
    const modelKey = turn.model || "unknown";
    if (!result.byModel[modelKey]) {
      result.byModel[modelKey] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
    }
    result.byModel[modelKey].inputTokens += turn.inputTokens;
    result.byModel[modelKey].outputTokens += turn.outputTokens;
    result.byModel[modelKey].cacheReadInputTokens += turn.cacheRead;
    result.byModel[modelKey].cacheCreationInputTokens += turn.cacheCreation;

    // By agent
    const agentKey = turn.attributionAgent || "_lead";
    if (!result.byAgent[agentKey]) {
      result.byAgent[agentKey] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
    }
    result.byAgent[agentKey].inputTokens += turn.inputTokens;
    result.byAgent[agentKey].outputTokens += turn.outputTokens;
    result.byAgent[agentKey].cacheReadInputTokens += turn.cacheRead;
    result.byAgent[agentKey].cacheCreationInputTokens += turn.cacheCreation;

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
/**
 * Derive a short repo name from a cwd path — the last path segment.
 * Handles Windows backslashes, POSIX forward slashes, and trailing
 * separators. Returns null for empty/invalid input.
 *
 * @param {string|null|undefined} cwd
 * @returns {string|null}
 */
function repoFromCwd(cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  const stripped = cwd.replace(/[\\/]+$/, "");
  if (!stripped) return null;
  const parts = stripped.split(/[\\/]/);
  return parts[parts.length - 1] || null;
}

/**
 * Derive the run status from a manifest.
 *
 * - `"running"`  when `endedAt` is unset (still active).
 * - `"failed"`   when `endedAt` is set AND `exitCode >= 1`.
 * - `"completed"` otherwise (ended cleanly or exit code unknown).
 *
 * A missing/null/non-numeric `exitCode` with `endedAt` set is treated as
 * `"completed"` (preserves legacy behavior for manifests without exit code).
 *
 * @param {object} manifest
 * @returns {"running"|"failed"|"completed"}
 */
function statusFromManifest(manifest) {
  if (!manifest.endedAt) return "running";
  const exitNum =
    typeof manifest.exitCode === "number"
      ? manifest.exitCode
      : parseInt(manifest.exitCode, 10);
  if (Number.isFinite(exitNum) && exitNum >= 1) return "failed";
  return "completed";
}

/**
 * Parse every session .jsonl in the transcript dir ONCE into a shared index.
 *
 * `scanRuns()` passes this index to each WINDOW-mode `aggregateRun` so the
 * transcript directory is parsed a single time across all runs, instead of
 * each run re-globbing + re-parsing the whole dir. This turns the old
 * O(runs × transcripts) scan into O(transcripts + runs) — critical once the
 * transcript dir grows past a handful of sessions (161 files / 43 MB here
 * made /api/runs take 5–11 s; the index path parses them once total).
 *
 * EXACT-mode runs (sessionId set) don't use the index — they parse only their
 * own single transcript file, which is already cheap.
 *
 * Returns `null` when the transcript dir is missing/unreadable so callers can
 * fall through to the empty-result path. Each entry is `{ path, parsed }`
 * where `parsed` is the full `parseTranscript()` result (cwd, gitBranch,
 * turns) — the match + aggregation logic in `aggregateRun` is unchanged, it
 * just iterates this pre-parsed list instead of globbing itself.
 */
function buildTranscriptIndex(transcriptDir) {
  if (!transcriptDir || !existsSync(transcriptDir)) return null;
  let sessionFiles;
  try {
    sessionFiles = readdirSync(transcriptDir).filter(
      (f) => f.endsWith(".jsonl") && statSync(join(transcriptDir, f)).isFile(),
    );
  } catch {
    return null;
  }
  const index = [];
  for (const sessionFile of sessionFiles) {
    const sessionPath = join(transcriptDir, sessionFile);
    index.push({ path: sessionPath, parsed: parseTranscript(sessionPath) });
  }
  return index;
}

export function aggregateRun(manifest, transcriptIndex) {
  const transcriptDir = listTranscriptDir();
  const result = {
    runId: manifest.runId,
    squad: manifest.squad || null,
    source: manifest.source || null,
    brief: manifest.brief || null,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt || null,
    status: statusFromManifest(manifest),
    // B1 pass-through fields (additive — straight from the manifest).
    cwd: manifest.cwd || null,
    repo: repoFromCwd(manifest.cwd),
    gitBranch: manifest.gitBranch || null,
    exitCode: manifest.exitCode ?? null,
    native: manifest.native ?? null,
    sessionId: manifest.sessionId || null,
    transcriptPath: manifest.transcriptPath || null,
    claudeConfigDir: manifest.claudeConfigDir || null,
    ambiguous: false,
    taskId: manifest.taskId || manifest.taskIdAuto || inferTaskIdFromBranch(manifest.gitBranch) || null,
    taskIdExplicit: manifest.taskId || null,
    taskIdAuto: manifest.taskIdAuto || null,
    taskIdInferred: inferTaskIdFromBranch(manifest.gitBranch) || null,
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 },
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

  // Session list to match against. `scanRuns()` passes a pre-parsed
  // `transcriptIndex` (built once for ALL runs) so we don't re-glob + re-parse
  // the whole transcript dir per run. Direct callers (e.g. _test_ledger) omit
  // it and we fall back to glob+parse inline — same behavior as before.
  let sessions;
  if (transcriptIndex) {
    sessions = transcriptIndex;
  } else {
    if (!existsSync(transcriptDir)) return result;
    let sessionFiles;
    try {
      sessionFiles = readdirSync(transcriptDir).filter(
        (f) => f.endsWith(".jsonl") && statSync(join(transcriptDir, f)).isFile(),
      );
    } catch {
      return result;
    }
    sessions = sessionFiles.map((f) => {
      const sessionPath = join(transcriptDir, f);
      return { path: sessionPath, parsed: parseTranscript(sessionPath) };
    });
  }

  let matchedCount = 0;

  for (const { parsed } of sessions) {
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

  // Build the transcript index ONCE and share it across all WINDOW-mode runs.
  // Without this, each of the N window-mode runs re-parses the entire
  // transcript dir → O(runs × transcripts). EXACT-mode runs ignore the index
  // (they parse only their own sessionId file).
  const transcriptIndex = buildTranscriptIndex(listTranscriptDir());

  const results = [];
  for (const f of files) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(runsDir, f), "utf8"));
    } catch {
      continue; // skip malformed manifests
    }
    results.push(aggregateRun(manifest, transcriptIndex));
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

/**
 * Aggregate an array of aggregateRun results by task ID.
 *
 * Groups runs by `run.taskId` (or `"__untagged__"` when null), summing
 * token/cost totals and tracking squad-level breakdowns. Sorted by costUSD
 * descending, with `__untagged__` last.
 *
 * @param {Array<object>} runs  Array of aggregateRun results (from scanRuns())
 * @returns {object}  Keyed by taskId, each value:
 *   { runs: number, costUSD: number, inputTokens: number, outputTokens: number,
 *     cacheReadTokens: number, cacheCreationInputTokens: number,
 *     firstStartedAt: string|null, lastEndedAt: string|null,
 *     squads: { [squad]: { runs: number, costUSD: number } } }
 */
export function aggregateByTask(runs) {
  const buckets = {};

  for (const run of runs) {
    const key = run.taskId || "__untagged__";
    if (!buckets[key]) {
      buckets[key] = {
        runs: 0,
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationInputTokens: 0,
        firstStartedAt: null,
        lastEndedAt: null,
        squads: {},
      };
    }

    const b = buckets[key];
    const t = run.totals || {};

    b.runs += 1;
    b.costUSD += t.costUSD || 0;
    b.inputTokens += t.inputTokens || 0;
    b.outputTokens += t.outputTokens || 0;
    b.cacheReadTokens += t.cacheReadTokens || 0;
    b.cacheCreationInputTokens += t.cacheCreationInputTokens || 0;

    // firstStartedAt: min of existing and run.startedAt (null-safe)
    if (run.startedAt != null) {
      if (b.firstStartedAt == null || run.startedAt < b.firstStartedAt) {
        b.firstStartedAt = run.startedAt;
      }
    }

    // lastEndedAt: if any run.endedAt is null, bucket stays null (running)
    if (run.endedAt == null) {
      b.lastEndedAt = null;
    } else if (b.lastEndedAt == null || run.endedAt > b.lastEndedAt) {
      b.lastEndedAt = run.endedAt;
    }

    // Squad breakdown
    const squadKey = run.squad || "unknown";
    if (!b.squads[squadKey]) {
      b.squads[squadKey] = { runs: 0, costUSD: 0 };
    }
    b.squads[squadKey].runs += 1;
    b.squads[squadKey].costUSD += t.costUSD || 0;
  }

  // Sort: non-untagged by costUSD desc, then __untagged__ last
  const entries = Object.entries(buckets);
  const untagged = entries.filter(([k]) => k === "__untagged__");
  const tagged = entries.filter(([k]) => k !== "__untagged__");
  tagged.sort((a, b) => b[1].costUSD - a[1].costUSD);

  const ordered = {};
  for (const [k, v] of tagged) ordered[k] = v;
  for (const [k, v] of untagged) ordered[k] = v;

  return ordered;
}
