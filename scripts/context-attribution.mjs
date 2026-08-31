#!/usr/bin/env node
// scripts/context-attribution.mjs — what actually fills a lead's context window.
//
//   node scripts/context-attribution.mjs [--days 30] [--limit N] [--squad <s>]
//                                        [--session <path>] [--json] [--per-session]
//
// WHY (FOC-166). "Optimise the prompts" is the intuitive answer to context cost.
// Measured on this repo's telemetry, the squad CLAUDE.md is ~4k of a ~60k
// average window — 6%. Nobody knew what the other 94% was, and which term
// dominates decides what the fix even is. This measures it.
//
// WHY NOT FROM tool_facts. The table records `tool_input` (truncated to 1000
// chars) and NOT the size of the tool RESULT. The result is the thing that
// enters the window — a Read returning 40k of file is one row with a 60-char
// input. So attribution has to read transcripts. Adding a result-size column
// would fix future runs and answer nothing about the 37k turns already spent.
//
// HOW THE NUMBERS ARE MADE HONEST. Two anchors, neither of them a guess:
//
//   · The FIXED FLOOR is measured, not estimated. The first API call of a
//     session carries the whole system prompt, every tool schema and the squad
//     CLAUDE.md, and its `input_tokens` is reported by the provider. That number
//     IS the floor.
//
//   · The chars→tokens ratio is FITTED per session, not assumed to be 4. Every
//     later call reports its own prompt size, and we know how many characters of
//     conversation had accumulated by then. Least squares through the origin
//     over all turns gives K, and the R² is printed with it — a session whose
//     fit is poor is reported as poor rather than quietly averaged in.
//
// TWO METRICS, and they answer different questions:
//
//   · RESIDENT — the composition of the window at the end of a session. Answers
//     "what is in there".
//   · TOKEN-TURNS — Σ over turns of what was resident at that turn. Answers
//     "what did the cache-read bill actually pay for", which is not the same
//     question: a 20k block added at turn 3 of 300 is re-read 297 times, and a
//     20k block added at turn 299 is not. Cache-read is 73% of squad token
//     volume, so this is the metric that maps to money.
//
// Compaction resets the window. Every `isCompactSummary` boundary starts a new
// segment with its own floor and its own fit; a session that compacted three
// times contributes three segments. Ignoring that would fit a line through a
// sawtooth.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const { DatabaseSync } = await import("node:sqlite");

// ── categories ───────────────────────────────────────────────────────────────
// Deliberately few. A breakdown with thirty rows tells you nothing about which
// lever to pull; these are the five things you can actually do something about,
// plus per-tool detail underneath the tool_result line.
const FLOOR = "system+tools+CLAUDE.md";

const args = parseArgs(process.argv.slice(2));
if (args.help) usage(0);

const DAYS = Number(args.days ?? 30);
const LIMIT = Number(args.limit ?? 25);

// ── selecting sessions ───────────────────────────────────────────────────────

function telemetryDbPath() {
  if (process.env.LA_TELEMETRY_DB) return process.env.LA_TELEMETRY_DB;
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(localAppData, "linear-agents", "telemetry", "telemetry.sqlite");
}

function pickSessions() {
  if (args.session) return [{ path: args.session, squad: "(given)", turns: null }];

  const dbPath = telemetryDbPath();
  if (!existsSync(dbPath)) {
    console.error(`[context-attribution] no telemetry DB at ${dbPath}`);
    console.error("Pass --session <transcript.jsonl> to measure one file directly.");
    process.exit(3);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let sql = `
    SELECT u.source_path AS path, r.squad AS squad, COUNT(*) AS turns, MAX(u.observed_at) AS last
    FROM usage_facts u
    LEFT JOIN runs r ON u.run_id = r.run_id
    WHERE u.agent_key = '_lead'
      AND u.observed_at >= date('now', ?)
      AND r.native IS NOT 1
      AND (r.source IS NULL OR r.source != 'echo test')
  `;
  const params = [`-${DAYS} day`];
  if (args.squad) {
    sql += " AND r.squad = ?";
    params.push(args.squad);
  }
  sql += " GROUP BY u.source_path ORDER BY turns DESC LIMIT ?";
  params.push(LIMIT);

  const rows = db.prepare(sql).all(...params);
  db.close();
  return rows.filter((r) => r.path && existsSync(r.path));
}

// ── reading one transcript ───────────────────────────────────────────────────

const len = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "string") return v.length;
  return JSON.stringify(v).length;
};

/** Which bucket does this block belong to, and (for tools) which tool. */
function classifyToolResult(toolName) {
  // Read/Grep/Glob return file content; Agent/Task returns another model's
  // report; Bash returns command output. Keeping them apart is the whole point
  // — "tool results dominate" is not an actionable finding, "Read dominates" is.
  return `tool_result:${toolName ?? "unknown"}`;
}

function readSession(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { path, error: err.message };
  }

  const segments = [];
  let seg = newSegment();
  const toolNames = new Map(); // tool_use_id → name

  function newSegment() {
    return { blocks: [], calls: [], chars: 0, compacted: false };
  }

  // A single API call emits several transcript lines (thinking, text, tool_use)
  // that repeat the same usage record. Dedupe by requestId, or the arithmetic
  // counts one prompt five times.
  const seenRequests = new Set();

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    // Sidechain lines are a SUBAGENT's own conversation. They never enter the
    // lead's window — only the subagent's final report does, and that arrives
    // as a tool_result on the lead's side, where it is counted.
    if (o.isSidechain) continue;

    if (o.isCompactSummary) {
      if (seg.calls.length) segments.push(seg);
      seg = newSegment();
      seg.compacted = true;
    }

    const msg = o.message;
    const content = msg?.content;

    if (o.type === "assistant" || o.type === "user") {
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (!b || typeof b !== "object") continue;
          let cat;
          let size;
          if (b.type === "tool_use") {
            toolNames.set(b.id, b.name);
            cat = `tool_call:${b.name}`;
            size = len(b.input) + len(b.name);
          } else if (b.type === "tool_result") {
            cat = classifyToolResult(toolNames.get(b.tool_use_id));
            size = len(b.content);
          } else if (b.type === "thinking" || b.type === "redacted_thinking") {
            cat = "thinking";
            size = len(b.thinking ?? b.data);
          } else if (b.type === "text") {
            cat = o.type === "user" ? "conversation:human" : "conversation:assistant";
            size = len(b.text);
          } else {
            cat = `other:${b.type}`;
            size = len(b);
          }
          seg.blocks.push({ cat, size, at: seg.calls.length });
          seg.chars += size;
        }
      }
    } else if (o.type === "attachment") {
      // Claude Code's own injections (agent listings, file-history deltas,
      // system reminders). They are part of the prompt and nobody writes them
      // deliberately, which makes them worth seeing separately.
      const size = len(o.attachment);
      seg.blocks.push({ cat: "harness:attachment", size, at: seg.calls.length });
      seg.chars += size;
    } else if (o.type === "system") {
      const size = len(o.content ?? o);
      seg.blocks.push({ cat: "harness:system", size, at: seg.calls.length });
      seg.chars += size;
    }

    const u = msg?.usage;
    if (u) {
      const key = o.requestId ?? msg.id;
      if (key && seenRequests.has(key)) continue;
      if (key) seenRequests.add(key);
      seg.calls.push({
        window:
          (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        charsBefore: seg.chars,
      });
    }
  }
  if (seg.calls.length) segments.push(seg);

  return { path, segments };
}

// ── fitting chars → tokens ───────────────────────────────────────────────────

/**
 * window(t) ≈ floor + charsBefore(t) × tokensPerChar
 *
 * Ordinary least squares with an intercept. Both terms are fitted, and the
 * intercept IS the floor — everything present on every call that is not
 * conversation: the system prompt, every tool schema, and CLAUDE.md.
 *
 * An earlier version pinned the floor to the first call's window minus
 * chars/4. That hack produced NEGATIVE floors on supervisor sessions, where a
 * large block is already resident before the first call — which is exactly the
 * case the constant 4 was standing in for. Fitting both terms removes the
 * assumption instead of tuning it.
 *
 * R² comes back so a segment the model does not describe can be dropped rather
 * than averaged into the answer.
 */
function fitSegment(seg) {
  const calls = seg.calls;
  if (calls.length < 5) return null;

  const n = calls.length;
  let sx = 0;
  let sy = 0;
  for (const c of calls) {
    sx += c.charsBefore;
    sy += c.window;
  }
  const mx = sx / n;
  const my = sy / n;

  let sxy = 0;
  let sxx = 0;
  for (const c of calls) {
    sxy += (c.charsBefore - mx) * (c.window - my);
    sxx += (c.charsBefore - mx) ** 2;
  }
  // Every call had the same amount of conversation resident — no slope is
  // identifiable, so there is nothing to fit.
  if (sxx === 0) return null;

  const tokensPerChar = sxy / sxx;
  const floor = my - tokensPerChar * mx;
  if (!(tokensPerChar > 0)) return null;

  let ssRes = 0;
  let ssTot = 0;
  for (const c of calls) {
    const pred = floor + tokensPerChar * c.charsBefore;
    ssRes += (c.window - pred) ** 2;
    ssTot += (c.window - my) ** 2;
  }
  const r2 = ssTot === 0 ? null : 1 - ssRes / ssTot;

  return { floor: Math.round(floor), charsPerToken: 1 / tokensPerChar, tokensPerChar, r2, turns: n };
}

// ── attribution ──────────────────────────────────────────────────────────────

function attribute(seg, fit) {
  const turns = seg.calls.length;
  const resident = new Map();
  const tokenTurns = new Map();

  for (const b of seg.blocks) {
    const tokens = b.size * fit.tokensPerChar;
    resident.set(b.cat, (resident.get(b.cat) ?? 0) + tokens);
    // Resident from the call after it was written until the end of the segment.
    const rereads = Math.max(0, turns - b.at);
    tokenTurns.set(b.cat, (tokenTurns.get(b.cat) ?? 0) + tokens * rereads);
  }

  // The floor is present on every single call, by definition.
  resident.set(FLOOR, fit.floor);
  tokenTurns.set(FLOOR, fit.floor * turns);

  return { resident, tokenTurns, turns };
}

const addInto = (target, source) => {
  for (const [k, v] of source) target.set(k, (target.get(k) ?? 0) + v);
};

// ── output ───────────────────────────────────────────────────────────────────

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

function table(title, map, note) {
  const total = [...map.values()].reduce((a, b) => a + b, 0);
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0);
  console.log(`\n${title}`);
  if (note) console.log(`  ${note}`);
  console.log(`  ${"source".padEnd(34)}${"tokens".padStart(10)}${"share".padStart(9)}`);
  console.log(`  ${"-".repeat(53)}`);
  for (const [k, v] of rows) {
    const share = total ? (v / total) * 100 : 0;
    if (share < 0.5 && k !== FLOOR) continue;
    console.log(`  ${k.padEnd(34)}${fmt(v).padStart(10)}${(share.toFixed(1) + "%").padStart(9)}`);
  }
  console.log(`  ${"-".repeat(53)}`);
  console.log(`  ${"TOTAL".padEnd(34)}${fmt(total).padStart(10)}`);
  return { total, rows };
}

/** Collapse tool_result:* / tool_call:* into one line each, for the top view. */
function rollUp(map) {
  const out = new Map();
  for (const [k, v] of map) {
    const group = k.startsWith("tool_result:")
      ? "tool results (all tools)"
      : k.startsWith("tool_call:")
        ? "tool calls (inputs)"
        : k;
    out.set(group, (out.get(group) ?? 0) + v);
  }
  return out;
}

const only = (map, prefix) =>
  new Map([...map].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));

// ── main ─────────────────────────────────────────────────────────────────────

function usage(code) {
  console.log(
    [
      "context-attribution.mjs — what fills a lead's context window (FOC-166)",
      "",
      "  --days N        window of lead runs to consider (default 30)",
      "  --limit N       how many sessions, biggest first (default 25)",
      "  --squad <s>     restrict to one squad",
      "  --session <p>   measure one transcript directly, no DB",
      "  --per-session   print a line per session as well as the aggregate",
      "  --json          machine-readable output",
      "",
      "Reads transcripts because tool_facts records tool INPUT, not result size,",
      "and the result is what enters the window.",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith("--")) {
      out._.push(t);
      continue;
    }
    const k = t.slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith("--")) out[k] = true;
    else {
      out[k] = n;
      i++;
    }
  }
  return out;
}

const sessions = pickSessions();
if (!sessions.length) {
  console.error(`[context-attribution] no lead transcripts on disk in the last ${DAYS} days.`);
  console.error("Retention: node scripts/check-transcript-retention.mjs");
  process.exit(3);
}

const totalResident = new Map();
const totalTokenTurns = new Map();
const perSession = [];
const fits = [];
let segmentsUsed = 0;
let segmentsSkipped = 0;
let compactions = 0;

for (const s of sessions) {
  const parsed = readSession(s.path);
  if (parsed.error) {
    segmentsSkipped++;
    continue;
  }
  for (const seg of parsed.segments) {
    if (seg.compacted) compactions++;
    const fit = fitSegment(seg);
    // Two independent sanity gates, both stated rather than tuned away:
    //   · R² < 0.7 means the linear model does not describe this segment, so
    //     its coefficients are not a measurement of anything.
    //   · a floor below zero or above the context limit is arithmetically
    //     impossible; it means the segment's window moved for a reason this
    //     model does not represent.
    // Dropped segments are counted and reported, never silently included.
    const usable =
      fit &&
      fit.r2 !== null &&
      fit.r2 >= 0.7 &&
      fit.floor > 0 &&
      fit.floor < 400_000 &&
      fit.charsPerToken > 1 &&
      fit.charsPerToken < 20;
    if (!usable) {
      segmentsSkipped++;
      continue;
    }
    segmentsUsed++;
    fits.push(fit);
    const a = attribute(seg, fit);
    addInto(totalResident, a.resident);
    addInto(totalTokenTurns, a.tokenTurns);
    perSession.push({ squad: s.squad, turns: a.turns, fit, path: s.path });
  }
}

if (!segmentsUsed) {
  console.error("[context-attribution] no segment produced a usable fit — nothing to report.");
  process.exit(3);
}

// Turn-weighted, not segment-weighted. A 373-call segment and a 5-call segment
// are not two equal observations of how a window fills — the first is what the
// bill is made of.
const totalTurns = fits.reduce((a, f) => a + f.turns, 0);
const wmean = (pick) => fits.reduce((a, f) => a + pick(f) * f.turns, 0) / totalTurns;
const meanCpt = wmean((f) => f.charsPerToken);
const meanR2 = wmean((f) => f.r2 ?? 0);
const meanFloor = wmean((f) => f.floor);
const floors = fits.map((f) => f.floor).sort((a, b) => a - b);
const medianFloor = floors[Math.floor(floors.length / 2)];

if (args.json) {
  console.log(
    JSON.stringify(
      {
        days: DAYS,
        sessions: sessions.length,
        segmentsUsed,
        segmentsSkipped,
        compactions,
        turns: totalTurns,
        charsPerToken: Number(meanCpt.toFixed(2)),
        r2: Number(meanR2.toFixed(3)),
        floorTokens: Math.round(meanFloor),
        floorMedian: medianFloor,
        resident: Object.fromEntries([...totalResident].map(([k, v]) => [k, Math.round(v)])),
        tokenTurns: Object.fromEntries([...totalTokenTurns].map(([k, v]) => [k, Math.round(v)])),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`\ncontext attribution — ${sessions.length} lead session(s), last ${DAYS} days`);
console.log(`  segments used ......... ${segmentsUsed} (${segmentsSkipped} skipped, ${compactions} after a compaction)`);
console.log(`  API calls ............. ${totalTurns}`);
console.log(`  fitted chars/token .... ${meanCpt.toFixed(2)}   (R² ${meanR2.toFixed(3)})`);
console.log(`  fitted floor .......... ${fmt(meanFloor)} tokens (median ${fmt(medianFloor)}) — system prompt + tool schemas + CLAUDE.md`);

table("RESIDENT — what is in the window", rollUp(totalResident), "composition at the end of each segment");
table(
  "TOKEN-TURNS — what the cache-read bill paid for",
  rollUp(totalTokenTurns),
  "Σ over calls of what was resident then; this is the one that maps to money",
);
table("tool RESULTS by tool", only(totalTokenTurns, "tool_result:"), "token-turns");
table("tool CALLS by tool", only(totalTokenTurns, "tool_call:"), "token-turns — the inputs you write, not the outputs you get");

if (args["per-session"]) {
  console.log("\nper segment");
  for (const p of perSession.sort((a, b) => b.turns - a.turns).slice(0, 20)) {
    console.log(
      `  ${String(p.squad ?? "?").padEnd(12)}${String(p.turns).padStart(5)} calls  ` +
        `floor ${fmt(p.fit.floor).padStart(6)}  cpt ${p.fit.charsPerToken.toFixed(2)}  ` +
        `R² ${p.fit.r2 === null ? "n/a" : p.fit.r2.toFixed(3)}`,
    );
  }
}
