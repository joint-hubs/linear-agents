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
//   aggregateFlow(runs)       -> { squads: { [squad]: { agents: {...} } } } (Flow screen)
//   extractAgentTurns(path, agentKey, opts) -> turn log with text (Flow screen)

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

/**
 * Infer a Linear task ID from free text (a kickoff prompt). First match wins —
 * kickoffs lead with the task ("Weź task JOI-61…", "DEV task PISI-98: …").
 *
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function inferTaskIdFromText(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/\b(FEN|PISI|JOI)-(\d{1,5})\b/i);
  if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  return null;
}

/**
 * Fold kickoff-derived task id into an aggregateRun result. Kickoff evidence
 * beats branch inference (branches go stale between runs and have carried the
 * wrong team prefix); explicit `taskId` and `taskIdAuto` still win.
 */
function applyKickoffTaskId(result, parsed, manifest) {
  const kickoff = inferTaskIdFromText(parsed.firstUserText);
  if (!kickoff) return;
  result.taskIdKickoff = kickoff;
  if (!manifest.taskId && !manifest.taskIdAuto) result.taskId = kickoff;
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
    firstUserText: null,
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

    // First non-sidechain user message — the operator's kickoff. Used for
    // task-id inference: branches go stale between runs, kickoffs don't.
    if (!result.firstUserText && line.type === "user" && !line.isSidechain) {
      const c = line.message?.content ?? line.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        text = c
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n");
      }
      if (text.trim()) result.firstUserText = text.slice(0, 2000);
    }

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

  // Merge subagent transcripts. Real Claude Code layout: a directory NAMED
  // like the session (transcript path minus .jsonl) containing subagents/ —
  // i.e. <dir>/<sessionId>/subagents/agent-*.jsonl. The flat sibling
  // <dir>/subagents/ is kept as a fallback for older/synthetic layouts.
  const subagentsDirCandidates = [
    join(parentDir, basename(absPath, ".jsonl"), "subagents"),
    join(parentDir, "subagents"),
  ];
  const subagentsDir = subagentsDirCandidates.find(
    (d) => existsSync(d) && statSync(d).isDirectory(),
  );
  if (subagentsDir) {
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
          // Sidechain lines carry attributionAgent (role name); fall back to
          // the agentId so subagent usage never collapses into "_lead".
          attributionAgent: line.attributionAgent || (line.agentId ? `agent-${line.agentId}` : null),
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

    // Last activity (ISO strings compare lexicographically)
    if (turn.ts && (!result.lastActivityAt || turn.ts > result.lastActivityAt)) {
      result.lastActivityAt = turn.ts;
    }

    // By agent
    const agentKey = turn.attributionAgent || "_lead";
    if (!result.byAgent[agentKey]) {
      result.byAgent[agentKey] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, turns: 0, models: {} };
    }
    result.byAgent[agentKey].inputTokens += turn.inputTokens;
    result.byAgent[agentKey].outputTokens += turn.outputTokens;
    result.byAgent[agentKey].cacheReadInputTokens += turn.cacheRead;
    result.byAgent[agentKey].cacheCreationInputTokens += turn.cacheCreation;
    // Flow screen (additive): per-agent turn count + model mix so /api/flow
    // can show which model actually executed a pipeline step and how often.
    result.byAgent[agentKey].turns += 1;
    result.byAgent[agentKey].models[modelKey] = (result.byAgent[agentKey].models[modelKey] || 0) + 1;

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

// ---------------------------------------------------------------------------
// Late transcript discovery — for manifests whose launcher never ran
// `run-manifest end` (killed terminal, crash): sessionId is null, EXACT mode
// can't run, and the legacy WINDOW match looks in the wrong pool (the
// server's own cwd hash — NOT the squad's CLAUDE_CONFIG_DIR, NOT other
// repos' hashes). Mirrors the candidate-root logic of run-manifest cmdEnd,
// but assigns files to runs GLOBALLY (greedy closest-start, strictly 1:1)
// so a burst of aborted launches can't all claim the same session file and
// double-count its cost.
// ---------------------------------------------------------------------------

const BIRTH_BEFORE_MS = 30 * 1000; // session file may slightly predate manifest start
const BIRTH_AFTER_MS = 120 * 1000; // fallback upper bound for still-running manifests
const AMBIGUOUS_MARGIN_MS = 2000;

/**
 * Upper bound for a transcript's birthtime, given a manifest.
 *
 * BIRTH_AFTER_MS assumes claude starts writing its session file within ~2 min
 * of launch — false for a cold start in a brand-new project directory (first
 * MCP/indexing overhead can push it past that). A COMPLETED run has a much
 * better bound available: the transcript must have been born before the run
 * ended (a session can't end before its own file exists) — a logical
 * constraint, not a heuristic, and typically far more generous. Manifests
 * still running (no endedAt) fall back to the fixed window.
 */
export function birthUpperBound(manifest, startedMs) {
  const fallback = startedMs + BIRTH_AFTER_MS;
  if (!manifest.endedAt) return fallback;
  const ended = new Date(manifest.endedAt).getTime();
  return Number.isFinite(ended) ? Math.max(fallback, ended) : fallback;
}

/** All hash subdirectories of a `<configDir>/projects` root (existing dirs only). */
function projectHashDirs(projectsRoot) {
  try {
    return readdirSync(projectsRoot)
      .map((e) => join(projectsRoot, e))
      .filter((p) => statSync(p).isDirectory());
  } catch {
    return [];
  }
}

/**
 * Candidate transcript roots for a manifest.
 *
 * manifest.cwd is NOT trusted for hash derivation: launchers spawned from an
 * arbitrary directory (dashboard /api/launch, .bat double-clicked elsewhere)
 * record that directory as cwd, while the claude process itself runs from the
 * repo — so the transcript lands under a different hash. Instead we scan ALL
 * hash dirs under the squad/config projects root (there are few) and let the
 * birthtime window + global 1:1 assignment discriminate.
 *
 * The ~/.claude fallback is used ONLY when no squad/config root exists —
 * squad launchers always run with CLAUDE_CONFIG_DIR, so matching a squad run
 * against the user's personal sessions would be a false positive.
 */
function candidateRootsForManifest(manifest) {
  const roots = [];
  if (manifest.claudeConfigDir && manifest.cwd) {
    roots.push(...projectHashDirs(join(resolve(manifest.cwd, manifest.claudeConfigDir), "projects")));
  }
  if (roots.length === 0 && manifest.squad) {
    // Killed-window manifests never got claudeConfigDir (launchers set it
    // AFTER `run-manifest start`; `end` backfills it — which never ran).
    // Squad config dirs are deterministic: <repo>/agents/<squad>.
    roots.push(...projectHashDirs(join(root, "agents", manifest.squad, "projects")));
  }
  if (roots.length === 0 && manifest.cwd) {
    roots.push(join(homedir(), ".claude", "projects", cwdToHashName(manifest.cwd)));
  }
  return roots;
}

/**
 * Batch-discover transcripts for sessionId-less manifests.
 *
 * Returns Map<runId, { path, ambiguous }>. A transcript file is assigned to
 * at most ONE run (the one whose startedAt is closest to the file birthtime,
 * within [start-30s, start+120s]). `ambiguous` is set when a competing
 * run/file was within 2 s of the winning assignment.
 *
 * @param {Array<object>} manifests
 * @returns {Map<string, {path: string, ambiguous: boolean}>}
 */
export function discoverTranscriptsForRuns(manifests) {
  const dirCache = new Map();
  const pairs = [];

  for (const manifest of manifests) {
    if (manifest.sessionId || !manifest.startedAt || !manifest.cwd) continue;
    const started = new Date(manifest.startedAt).getTime();
    if (!Number.isFinite(started)) continue;
    const upper = birthUpperBound(manifest, started);

    for (const rootDir of candidateRootsForManifest(manifest)) {
      if (!dirCache.has(rootDir)) {
        let files = [];
        try {
          files = readdirSync(rootDir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => {
              const p = join(rootDir, f);
              const st = statSync(p);
              if (!st.isFile()) return null;
              const birth =
                st.birthtime && st.birthtime.getTime() ? st.birthtime.getTime() : st.mtime.getTime();
              return { path: p, birth };
            })
            .filter(Boolean);
        } catch {
          files = [];
        }
        dirCache.set(rootDir, files);
      }

      for (const { path, birth } of dirCache.get(rootDir)) {
        if (birth >= started - BIRTH_BEFORE_MS && birth <= upper) {
          pairs.push({ runId: manifest.runId, path, diff: Math.abs(birth - started) });
        }
      }
    }
  }

  pairs.sort((a, b) => a.diff - b.diff);
  const byRun = new Map();
  const usedFiles = new Set();
  for (const pair of pairs) {
    if (byRun.has(pair.runId) || usedFiles.has(pair.path)) continue;
    const contested = pairs.some(
      (o) =>
        o !== pair &&
        (o.runId === pair.runId || o.path === pair.path) &&
        !byRun.has(o.runId) &&
        !usedFiles.has(o.path) &&
        o.diff - pair.diff < AMBIGUOUS_MARGIN_MS,
    );
    byRun.set(pair.runId, { path: pair.path, ambiguous: contested });
    usedFiles.add(pair.path);
  }
  return byRun;
}

export function aggregateRun(manifest, transcriptIndex, discoveredMatch) {
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
    lastActivityAt: null,
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
    applyKickoffTaskId(result, parsed, manifest);

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
  // LATE DISCOVERY: no sessionId (launcher never ran `end`) — locate the
  // run's own transcript via config-dir-aware roots + birthtime instead of
  // falling straight into the legacy window match. `scanRuns()` passes the
  // batch-assigned match (or null when none); standalone callers trigger a
  // single-run discovery here (discoveredMatch === undefined).
  // -----------------------------------------------------------------------
  const lateMatch =
    discoveredMatch === undefined
      ? discoverTranscriptsForRuns([manifest]).get(manifest.runId) || null
      : discoveredMatch;

  if (lateMatch) {
    const parsed = parseTranscript(lateMatch.path);
    const runStart = new Date(manifest.startedAt).getTime();
    const runEnd = manifest.endedAt
      ? new Date(manifest.endedAt).getTime() + 60 * 1000
      : Date.now() + 60 * 1000;
    const filtered = {
      turns: parsed.turns.filter((t) => {
        if (!t.ts) return false;
        const ts = new Date(t.ts).getTime();
        return ts >= runStart && ts <= runEnd;
      }),
    };
    if (filtered.turns.length > 0) {
      result.ambiguous = lateMatch.ambiguous || false;
      result.sessionId = basename(lateMatch.path, ".jsonl");
      result.transcriptPath = lateMatch.path;
      result.discovered = true;
      applyKickoffTaskId(result, parsed, manifest);
      aggregateTurns(result, filtered);
      return result;
    }
    // Discovered file had no in-window turns — fall through to legacy window.
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

  // Read all manifests first, then batch-discover transcripts for the
  // sessionId-less ones (1:1 file↔run assignment across the whole scan).
  const manifests = [];
  for (const f of files) {
    try {
      manifests.push(JSON.parse(readFileSync(join(runsDir, f), "utf8")));
    } catch {
      continue; // skip malformed manifests
    }
  }
  const discovered = discoverTranscriptsForRuns(manifests);

  const results = [];
  for (const manifest of manifests) {
    results.push(
      aggregateRun(manifest, transcriptIndex, discovered.get(manifest.runId) || null),
    );
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

// ---------------------------------------------------------------------------
// Flow screen (interactive Overview) — per-step aggregation + log extraction
// ---------------------------------------------------------------------------

/**
 * Aggregate runs into a pipeline-flow view: squad → agent(step) → stats + runs.
 *
 * Consumes the output of scanRuns() (each run carries byAgent with turn counts
 * and model mix — see aggregateTurns). Pure function, no I/O — testable.
 *
 * @param {Array<object>} runs  Output of scanRuns()
 * @returns {{ squads: { [squad]: { agents: { [agentKey]: {
 *   executions, turns, inputTokens, outputTokens, costUSD,
 *   models: {[slug]: turns}, lastActivityAt,
 *   runs: [{runId, taskId, startedAt, endedAt, status, turns, costUSD, models}]
 * } } } } }}
 */
export function aggregateFlow(runs) {
  const squads = {};

  for (const run of runs) {
    const squadKey = run.squad || "_unknown";
    if (!squads[squadKey]) squads[squadKey] = { agents: {} };

    for (const [agentKey, a] of Object.entries(run.byAgent || {})) {
      if (!squads[squadKey].agents[agentKey]) {
        squads[squadKey].agents[agentKey] = {
          executions: 0,
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUSD: 0,
          models: {},
          lastActivityAt: null,
          runs: [],
        };
      }
      const node = squads[squadKey].agents[agentKey];

      node.executions += 1;
      node.turns += a.turns || 0;
      node.inputTokens += a.inputTokens || 0;
      node.outputTokens += a.outputTokens || 0;
      node.costUSD += a.costUSD || 0;
      for (const [slug, n] of Object.entries(a.models || {})) {
        node.models[slug] = (node.models[slug] || 0) + n;
      }
      if (
        run.lastActivityAt &&
        (!node.lastActivityAt || run.lastActivityAt > node.lastActivityAt)
      ) {
        node.lastActivityAt = run.lastActivityAt;
      }

      node.runs.push({
        runId: run.runId,
        taskId: run.taskId || null,
        startedAt: run.startedAt || null,
        endedAt: run.endedAt || null,
        status: run.status || null,
        turns: a.turns || 0,
        costUSD: a.costUSD || 0,
        models: Object.keys(a.models || {}),
      });
    }
  }

  // Newest execution first inside each node.
  for (const squad of Object.values(squads)) {
    for (const node of Object.values(squad.agents)) {
      node.runs.sort((x, y) => (y.startedAt || "").localeCompare(x.startedAt || ""));
    }
  }

  return { squads };
}

/** Extract text blocks from a transcript message content. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/** Extract tool_use summaries from a transcript message content. */
function contentToolUses(content, maxInput = 300) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p) => p && p.type === "tool_use")
    .map((p) => {
      let input = "";
      try {
        input = JSON.stringify(p.input);
      } catch {
        input = "";
      }
      if (input.length > maxInput) input = input.slice(0, maxInput) + "…";
      return { name: p.name || "?", input };
    });
}

/**
 * Extract the full turn log (model responses) for ONE agent in ONE transcript.
 *
 * Same file layout as parseTranscript (lead .jsonl + optional subagents/ dir),
 * but keeps the assistant message CONTENT: text blocks + tool_use summaries.
 * This is the data source for the Flow screen's log viewer.
 *
 * @param {string} absPath   Lead transcript path (.jsonl)
 * @param {string} agentKey  attributionAgent value, or "_lead" for the lead
 * @param {object} [opts]    { windowStart, windowEnd (ms epoch), maxTextLen }
 * @returns {Array<{ts, model, agent, text, truncated, toolUses, usage}>}
 */
export function extractAgentTurns(absPath, agentKey, opts = {}) {
  const { windowStart = null, windowEnd = null, maxTextLen = 8000 } = opts;
  const out = [];
  if (!existsSync(absPath)) return out;

  const inWindow = (ts) => {
    if (!ts) return false;
    const t = new Date(ts).getTime();
    if (windowStart != null && t < windowStart) return false;
    if (windowEnd != null && t > windowEnd) return false;
    return true;
  };

  const pushTurn = (line, attribution) => {
    if (line.type !== "assistant" || !line.message) return;
    if ((attribution || "_lead") !== agentKey) return;
    if ((windowStart != null || windowEnd != null) && !inWindow(line.timestamp)) return;

    const msg = line.message;
    let text = contentText(msg.content);
    const truncated = text.length > maxTextLen;
    if (truncated) text = text.slice(0, maxTextLen) + "…";

    const usage = msg.usage || {};
    out.push({
      ts: line.timestamp || null,
      model: msg.model || null,
      agent: agentKey,
      text,
      truncated,
      toolUses: contentToolUses(msg.content),
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreation: usage.cache_creation_input_tokens ?? 0,
      },
    });
  };

  const readJsonl = (p) => {
    let lines;
    try {
      lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
    const parsed = [];
    for (const raw of lines) {
      try {
        const line = JSON.parse(raw);
        if (line && typeof line === "object") parsed.push(line);
      } catch {
        // skip malformed lines
      }
    }
    return parsed;
  };

  // Lead transcript
  for (const line of readJsonl(absPath)) {
    pushTurn(line, line.attributionAgent || null);
  }

  // Subagent transcripts (same discovery as parseTranscript)
  const parentDir = dirname(absPath);
  const subagentsDirCandidates = [
    join(parentDir, basename(absPath, ".jsonl"), "subagents"),
    join(parentDir, "subagents"),
  ];
  const subagentsDir = subagentsDirCandidates.find(
    (d) => existsSync(d) && statSync(d).isDirectory(),
  );
  if (subagentsDir) {
    let agentFiles = [];
    try {
      agentFiles = readdirSync(subagentsDir).filter(
        (f) => f.startsWith("agent-") && f.endsWith(".jsonl") && !f.endsWith(".meta.json"),
      );
    } catch {
      agentFiles = [];
    }
    for (const agentFile of agentFiles) {
      for (const line of readJsonl(join(subagentsDir, agentFile))) {
        pushTurn(line, line.attributionAgent || (line.agentId ? `agent-${line.agentId}` : null));
      }
    }
  }

  // Chronological order (ISO strings compare lexicographically).
  out.sort((x, y) => (x.ts || "").localeCompare(y.ts || ""));
  return out;
}
