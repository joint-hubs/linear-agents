// scripts/transcript-cost.mjs — price a child session's transcripts per assistant message.
//
// Why: the watcher's `result.modelUsage` is CUMULATIVE for the session (background-task
// wake-ups re-emit it; a resumed turn carries the whole session), so summing result
// events over-counts registry child cost — measured 5.05x ground truth ($781.85 vs
// $154.70, 366 children). Ground truth is the child's own transcripts: one row per
// assistant message, keyed by `message.id` with MAX per token counter across the lines
// of one message (the same merge rule as the ingest projection, telemetry-store.mjs
// FOC-381), priced with `calculateCost` from `pricingSnapshot()`. Zero-token messages
// cost $0 whatever the rate table says; a message on an unpriceable model makes the
// total null — unknown is never silently counted as free.
//
// Pure library: no store access, no state writes. Pricing is injectable so tests stay
// deterministic; the default is built exactly like supervisor-watch.mjs does.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { cwdToHashName } from "./ledger.mjs";
import { calculateCost, priceThreshold, pricingSnapshot } from "./telemetry-store.mjs";

// Transcript usage keys (snake_case, as Claude Code writes them) mapped to the
// calculateCost usage keys (camelCase).
const TOKEN_COUNTERS = [
  ["inputTokens", "input_tokens"],
  ["outputTokens", "output_tokens"],
  ["cacheReadTokens", "cache_read_input_tokens"],
  ["cacheCreationTokens", "cache_creation_input_tokens"],
];

/**
 * Subagent transcript files belonging to a lead session transcript, sorted.
 *
 * Same layouts ledger.mjs discovers: a session-named directory beside the lead
 * (`<dir>/<sessionId>/subagents/`) first, then a flat one (`<dir>/subagents/`).
 * Only `agent-*.jsonl` files count — `*.meta.json` sidecars never do.
 *
 * @param {string} leadPath absolute path to the lead `<sessionId>.jsonl`
 * @returns {string[]} absolute paths, [] when no subagents directory exists
 */
export function subagentTranscriptPaths(leadPath) {
  if (!leadPath) return [];
  const parentDir = dirname(leadPath);
  const candidates = [
    join(parentDir, basename(leadPath, ".jsonl"), "subagents"),
    join(parentDir, "subagents"),
  ];
  const subagentsDir = candidates.find((dir) => {
    try {
      return existsSync(dir) && statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  if (!subagentsDir) return [];
  try {
    return readdirSync(subagentsDir)
      .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl") && !f.endsWith(".meta.json"))
      .map((f) => join(subagentsDir, f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Locate a child's lead transcript and its subagent transcripts.
 *
 * @param {{ configDir?: string, cwd?: string, sessionId?: string }} args
 * @returns {{ lead: string, subagents: string[] } | null}
 *   null when configDir or sessionId is missing, or no transcript is found.
 *   Lead is `<configDir>/projects/<cwdToHashName(cwd)>/<sessionId>.jsonl` when it
 *   exists; otherwise the first matching `<sessionId>.jsonl` under `projects/`, in
 *   sorted directory order. Any fs error counts as not found — never a crash.
 */
export function childTranscriptPaths({ configDir, cwd, sessionId } = {}) {
  if (!configDir || !sessionId) return null;
  const projectsDir = join(resolve(configDir), "projects");
  let lead = null;
  try {
    lead = join(projectsDir, cwdToHashName(cwd), `${sessionId}.jsonl`);
  } catch {
    lead = null; // malformed cwd — fall through to the scan
  }
  if (lead && existsSync(lead)) {
    return { lead, subagents: subagentTranscriptPaths(lead) };
  }
  try {
    const dirs = readdirSync(projectsDir)
      .filter((d) => {
        try {
          return statSync(join(projectsDir, d)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
    for (const dir of dirs) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        return { lead: candidate, subagents: subagentTranscriptPaths(candidate) };
      }
    }
  } catch {
    /* projects dir unreadable — not found */
  }
  return null;
}

// The default pricing pair, built exactly like supervisor-watch.mjs builds its own:
// one pricingSnapshot() read for the whole call, and a snapshot that throws (missing
// or broken config/models.json) means "cannot price" — priceOne returns null — not a
// crashed turn. The flat openrouter scope alone cannot see keys catalogued under
// another provider (FOC-165), so pricing resolves against scopes like ingest does.
function defaultPricing() {
  const snapshot = (() => {
    try {
      return pricingSnapshot();
    } catch {
      return null;
    }
  })();
  const priceOne = (usage, model) =>
    snapshot ? calculateCost(usage, model, snapshot.prices, null, snapshot.scoped) : null;
  const thresholdOne = (model) =>
    snapshot ? priceThreshold(model, snapshot.prices, null, snapshot.scoped) : null;
  return { priceOne, thresholdOne };
}

/**
 * Price assistant messages across transcript files.
 *
 * Every line with `type === "assistant"` and a `message.usage` object counts. Lines
 * sharing a non-empty `message.id` are ONE message, merged with MAX per counter
 * (Claude Code writes one message as several lines — thinking/text/tool_use — each
 * repeating the usage); lines without an id count per line. Counters missing on a
 * line contribute 0. Zero-token messages cost $0 regardless of pricing; a non-zero
 * message that priceOne cannot price leaves the total null and is named in
 * unpricedModels exactly like supervisor-lib costFromResult names them.
 *
 * @param {string[]} paths transcript files (missing/unreadable ones are skipped)
 * @param {{ priceOne?: (usage, model) => number|null, thresholdOne?: (model) => {minPromptTokens}|null }} [opts]
 * @returns {{ costUsd: number|null, knownUsd: number, messages: number,
 *   unpricedModels: string[], byModel: Record<string, { messages: number, usd: number|null }>,
 *   files: number }}
 *   costUsd is null when ANY message is unpriced; knownUsd sums only the priced ones;
 *   byModel.usd is null when any of that model's messages is unpriced; files counts
 *   the files actually read.
 */
export function priceTranscripts(paths, { priceOne, thresholdOne } = {}) {
  if (priceOne === undefined || thresholdOne === undefined) {
    const defaults = defaultPricing();
    priceOne ??= defaults.priceOne;
    thresholdOne ??= defaults.thresholdOne;
  }

  const messages = new Map();
  let files = 0;
  for (const path of paths || []) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // missing or unreadable — not part of this child
    }
    files++;
    const lines = text.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const raw = lines[lineIndex].trim();
      if (!raw) continue;
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        continue; // malformed line — skip it
      }
      if (line?.type !== "assistant" || !line.message?.usage) continue;
      const id =
        typeof line.message.id === "string" && line.message.id ? line.message.id : `${path}:${lineIndex}`;
      let entry = messages.get(id);
      if (!entry) {
        entry = { model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
        messages.set(id, entry);
      }
      // First non-null model wins; the message's later lines repeat it.
      if (entry.model == null && line.message.model != null) entry.model = line.message.model;
      for (const [field, key] of TOKEN_COUNTERS) {
        const value = Number(line.message.usage[key]) || 0;
        if (value > entry[field]) entry[field] = value;
      }
    }
  }

  let knownUsd = 0;
  let anyUnpriced = false;
  const unpriced = new Set();
  const byModel = {};
  for (const entry of messages.values()) {
    const model = entry.model ?? "unknown";
    // Zero tokens cost $0 whatever the rate table says — same skip as costFromResult.
    const zeroTokens =
      !entry.inputTokens && !entry.outputTokens && !entry.cacheReadTokens && !entry.cacheCreationTokens;
    let usd = zeroTokens
      ? 0
      : priceOne(
          {
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            cacheReadTokens: entry.cacheReadTokens,
            cacheCreationTokens: entry.cacheCreationTokens,
          },
          model,
        );
    if (usd === null || !Number.isFinite(usd)) {
      anyUnpriced = true;
      usd = null;
      const t = thresholdOne?.(model);
      unpriced.add(
        t && entry.inputTokens >= t.minPromptTokens
          ? `${model} (unsupported above ${t.minPromptTokens} prompt tokens)`
          : model,
      );
    } else {
      knownUsd += usd;
    }
    const slot = (byModel[model] ??= { messages: 0, usd: 0 });
    slot.messages++;
    if (slot.usd !== null && usd !== null) slot.usd += usd;
    else slot.usd = null;
  }

  return {
    costUsd: anyUnpriced ? null : knownUsd,
    knownUsd,
    messages: messages.size,
    unpricedModels: [...unpriced].sort(),
    byModel,
    files,
  };
}

/**
 * Price one child: the lead + subagent transcripts of EVERY session id given.
 *
 * `sessionId` prices that one session (the original shape). `sessionIds` — a
 * resume can fork a NEW session id (claude writes a fresh `<id>.jsonl` for the
 * resumed turn), so the caller passes the registry's id AND the init event's
 * id: the leads and subagents of every distinct id found are priced together
 * in ONE priceTranscripts call. Overlap is harmless — lines sharing a
 * message.id merge by MAX per counter, so a message present in both files
 * counts once.
 *
 * @param {{ configDir?: string, cwd?: string, sessionId?: string, sessionIds?: string[] }} args
 * @param {object} [opts] priceTranscripts options
 * @returns {object|null} priceTranscripts' result plus `transcriptPath` (the
 *   lead of the FIRST id found) and `transcriptPaths` (every lead found), or
 *   null when no transcript for any id is found.
 */
export function priceChildTranscripts(args, opts) {
  const ids = [args?.sessionId, ...(args?.sessionIds ?? [])].filter(
    (id) => typeof id === "string" && id,
  );
  const paths = [];
  const leads = [];
  for (const id of new Set(ids)) {
    const found = childTranscriptPaths({ ...args, sessionId: id });
    if (!found) continue;
    leads.push(found.lead);
    paths.push(found.lead, ...found.subagents);
  }
  if (paths.length === 0) return null;
  return {
    ...priceTranscripts(paths, opts),
    transcriptPath: leads[0],
    transcriptPaths: leads,
  };
}
