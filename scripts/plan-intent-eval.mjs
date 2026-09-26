// scripts/plan-intent-eval.mjs — FOC-515: measure the plan.intent [G] node
// against the 12 Fenix issues whose DoD/AC Mateusz already approved.
//
// For each fixture case the harness builds the SAME input partition the runner
// hands a live plan.intent step (the entry text, the DoR gap list, the task
// type — all composed deterministically by THIS caller, the node has no tools
// and no repo access), then drives the REAL node loop (runPlanIntentNode with
// the runner's own default generator — the exact composition a live graph run
// uses, including the one-regeneration-then-stop policy). Usage and cost come
// off the FOC-449 event lines the transport wrote — the same ledger a live run
// produces, never a second meter. A retry writes a second line under the same
// taskKey, so the join sums per case instead of keeping the last one.
//
// Scoring is human: an LLM grader would need its own validation, so the
// harness ships the raw outputs plus mechanical facts (the [D] check results,
// item counts, the stated/inferred/unknown distribution, attempts, latency,
// tokens, cost) and the graded table lives in the run report +
// docs/benchmark/plan-intent-eval.md. A FAIL verdict here is a measurement,
// not an error (codegraph-benchmark posture).
//
// Input partition (FOC-515, mirroring the plan.ac eval's decided point 4):
//   - `inbox.entry` = { issueId, title, scopeSummary } — the scope summary is
//     the description with (a) the GROUND-TRUTH sections stripped (both the
//     Acceptance-criteria and the Definition-of-done section, in their heading
//     and inline-marker shapes) and (b) the terminal "<!-- fenix-roadmap-… -->"
//     metadata block stripped. Both are documented here and pinned by
//     scripts/plan-intent-eval.test.mjs. The ground truth is stripped because
//     the rubric grades whether a known scope/boundary miss comes back as an
//     `inferred`/`unknown` item — it can only do that if the miss is NOT in
//     the model's input.
//   - `plan.dor.gaps` and `intake.taskType` come from the fixture's eval-only
//     columns (scripts/plan-intent-eval-fixture.json), standing in for the two
//     upstream reads FOC-397 wires. They are authored from the issue's own
//     Context/Scope text, never from the stripped ground truth.
//   - the round-2 reads (gate.plan.gate1.answers / .corrections) are NOT fed:
//     FOC-517 owns the gate's write side and there is no conversation to fold
//     in an eval. Every case runs round 1. The fold is covered by
//     scripts/plan-intent.test.mjs instead.
//
// Honest-eval rule: land the prompt, run the eval ONCE, record what comes out
// — fixing transport/schema bugs is fine; do NOT iterate the prompt against
// the ground truth (criteriaVersion discipline).
//
// CLI:
//   node scripts/plan-intent-eval.mjs [--fixture <path>] [--out-dir <dir>]
//        [--ids <a,b,c>] [--limit <n>] [--run-id <id>] [--timeout <ms>]
// Artifacts (gitignored, under .state/foc-515/eval/<timestamp>/):
//   outputs.jsonl  — one line per case: inputs as built, output, checks, usage, cost
//   summary.json   — aggregate: counts, the [D] check tallies, tokens, cost, latency
//   table.txt      — compact per-case table
//   <run-id>/decisions.jsonl — the FOC-449 event lines themselves
// Artifacts are incremental: run the 12 cases in batches with --ids into the
// same --out-dir and the summary covers everything measured so far. An id
// already present in outputs.jsonl is never re-measured.
// Exit 0 = run completed (some rows may have failed calls or a rejected map —
// that is a measurement); exit 3 = no OPENROUTER_API_KEY, nothing measured.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";
import { loadGraph } from "./graph-validate.mjs";
import { createDefaultGenerator } from "./graph-runner.mjs";
import { runPlanIntentNode } from "./plan-intent.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

const FIXTURE_PATH = join(__dir, "plan-intent-eval-fixture.json");

// Ground truth, in both shapes per section: a heading ("## Acceptance
// [Cc]riteria", "## Definition of [Dd]one") or an inline bold marker
// ("**Acceptance criteria:**", "**AC:**", "**Definition of done:**", "**DoD:**").
// A section runs from its marker to the next section marker, the next "## "
// heading, or end of text.
const GT_MARKERS = [
  /^## Acceptance [Cc]riteria[^\n]*(?:\n|$)/m,
  /\*\*(?:Acceptance criteria|AC):\*\*/,
  /^## Definition of [Dd]one[^\n]*(?:\n|$)/m,
  /\*\*(?:Definition of done|DoD):\*\*/,
];
const NEXT_HEADING = /^## /m;
// Roadmap metadata is a terminal block: from the marker to end-of-text.
const ROADMAP_BLOCK = /[ \t]*<!-- fenix-roadmap[\s\S]*$/;

function stripRoadmap(text) {
  return text.replace(ROADMAP_BLOCK, "").trimEnd();
}

/**
 * Cut every ground-truth section out of a description. Returns
 * `{ scopeText, groundTruth }` — the former is the entry text the model sees,
 * the latter the answer key the rubric grades against (null when the issue
 * carries no AC/DoD section at all, as FOC-406 does not).
 */
export function splitGroundTruth(description) {
  const spans = [];
  for (const marker of GT_MARKERS) {
    const match = marker.exec(description);
    if (!match) continue;
    const start = match.index;
    const rest = description.slice(start + match[0].length);
    const nextMark = GT_MARKERS
      .map((m) => m.exec(rest))
      .filter(Boolean)
      .reduce((min, m) => (min === null || m.index < min ? m.index : min), null);
    const nextHeading = NEXT_HEADING.exec(rest);
    const ends = [nextMark, nextHeading?.index].filter((n) => n !== undefined && n !== null);
    const end = start + match[0].length + (ends.length ? Math.min(...ends) : description.length - start - match[0].length);
    spans.push([start, end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  // Merge overlapping spans so a cut never re-exposes a later marker.
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  let scopeText = "";
  let groundTruth = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    scopeText += description.slice(cursor, start);
    groundTruth += (groundTruth ? "\n\n" : "") + description.slice(start, end);
    cursor = end;
  }
  scopeText += description.slice(cursor);
  const gt = stripRoadmap(groundTruth).replace(/\n{3,}/g, "\n\n").trim();
  return { scopeText, groundTruth: gt || null };
}

/**
 * Build the plan.intent input partition for one fixture case. Pure.
 * Returns { id, title, taskType, gaps, entry, scopeSummary, groundTruth,
 * hasGroundTruth }. Throws TypeError on a malformed fixture row — the fixture
 * is external input and gets validated, not trusted.
 */
export function buildInputs(issue) {
  if (!issue || typeof issue !== "object") throw new TypeError("fixture row is not an object");
  const { id, title, description, taskType, gaps } = issue;
  if (typeof id !== "string" || !id.trim()) throw new TypeError("fixture row: id missing");
  if (typeof title !== "string" || !title.trim()) throw new TypeError(`fixture row ${id}: title missing`);
  if (typeof description !== "string") throw new TypeError(`fixture row ${id}: description missing`);
  if (typeof taskType !== "string" || !taskType.trim()) throw new TypeError(`fixture row ${id}: taskType missing`);
  if (!Array.isArray(gaps) || gaps.length > 8 || gaps.some((g) => typeof g !== "string" || !g.trim() || g.length > 200)) {
    throw new TypeError(`fixture row ${id}: gaps must be 0–8 non-empty strings of at most 200 chars`);
  }

  const { scopeText, groundTruth } = splitGroundTruth(description);
  const scopeSummary = stripRoadmap(scopeText).replace(/\n{3,}/g, "\n\n").trim();
  return {
    id: id.trim(),
    title,
    taskType,
    gaps: [...gaps],
    entry: { issueId: id.trim(), title, scopeSummary },
    scopeSummary,
    groundTruth,
    hasGroundTruth: groundTruth !== null,
  };
}

/** Read the FOC-449 event lines a run wrote, grouped by taskKey (a retry
 *  appends a second line under the same key — keep them all). */
function readEventLines(shadowDir) {
  const byTask = new Map();
  let text;
  try {
    text = readFileSync(join(shadowDir, "decisions.jsonl"), "utf8");
  } catch {
    return byTask; // no successful call wrote a line — nothing to join
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const line_ = JSON.parse(line);
      if (line_.type === "event" && typeof line_.taskKey === "string") {
        const list = byTask.get(line_.taskKey) ?? [];
        list.push(line_);
        byTask.set(line_.taskKey, list);
      }
    } catch {
      // A torn line is skipped, never guessed at.
    }
  }
  return byTask;
}

/** Cost from config/models.json pricing (OpenRouter scope), USD. */
function costOf(model, usage) {
  if (typeof usage?.cost === "number") return usage.cost;
  if (!usage || usage.inputTokens == null || usage.outputTokens == null) return null;
  let pricing;
  try {
    pricing = JSON.parse(readFileSync(join(root, "config", "models.json"), "utf8")).pricing?.openrouter || {};
  } catch {
    return null;
  }
  const row = pricing[model];
  if (!row || typeof row.input !== "number" || typeof row.output !== "number") return null;
  return (usage.inputTokens / 1e6) * row.input + (usage.outputTokens / 1e6) * row.output;
}

function schemaValidator(schema) {
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(schema ?? { type: "object" });
}

/** Rows an earlier invocation into this outDir already measured. */
function loadRows(outDir) {
  try {
    return readFileSync(join(outDir, "outputs.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/**
 * Join one row to the FOC-449 event lines the transport wrote for it
 * (taskKey = case id) — the same ledger a live run produces. A retry is a
 * second line under the same key, so this SUMS per case.
 */
function attachUsage(row, shadowDir) {
  const lines = readEventLines(shadowDir).get(row.id) ?? [];
  row.calls = lines.length;
  row.model = [...new Set(lines.map((l) => l.model).filter(Boolean))].join(",") || null;
  row.usage = lines.length
    ? {
      inputTokens: lines.reduce((n, l) => n + (l.usage?.inputTokens ?? 0), 0),
      outputTokens: lines.reduce((n, l) => n + (l.usage?.outputTokens ?? 0), 0),
    }
    : null;
  row.callDurationMs = lines.length ? lines.reduce((n, l) => n + (l.durationMs ?? 0), 0) : null;
  const costs = lines.map((l) => costOf(l.model, l.usage));
  row.cost = costs.some((c) => c != null) ? costs.reduce((n, c) => n + (c ?? 0), 0) : null;
  return row;
}

/** Write outputs.jsonl in fixture order. */
function writeOutputs(outDir, rows, source) {
  const order = new Map(source.map((i, n) => [i.id, n]));
  const sorted = [...rows].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "outputs.jsonl"), sorted.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Latency percentile over measured per-case call durations (ms). */
function percentile(values, p) {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

/**
 * Run the eval: one real plan.intent node run per fixture case, artifacts
 * under outDir. Returns the summary object (also written as summary.json).
 *
 * Artifacts are INCREMENTAL and idempotent: rows already present in
 * outDir/outputs.jsonl are kept and never re-measured, so the run can be
 * spread over several invocations (`--ids`) and the summary always covers
 * everything measured so far. Deps are injectable so tests drive it offline
 * (fetchImpl stub, explicit issues list).
 */
export async function runAll({
  fixturePath = FIXTURE_PATH,
  outDir,
  apiKey = process.env.OPENROUTER_API_KEY,
  fetchImpl = fetch,
  // 300s: the decided eval budget per call. The plan.dod eval measured a
  // cheap-tier [G] call at 299.2s against the runner's 120s default, so 300s
  // is the contract's figure and the runner's own default stays fail-closed.
  // plan.intent's map is a heavier task than a DoD list (glm-5.3-flash's
  // reasoning is mandatory — 61 reasoning tokens even on a one-field probe),
  // so calls that need more than this ABORT here and that is reported as a
  // measurement, never hidden by widening the budget. Pass --timeout to
  // measure the model under more headroom; the budget used is always named.
  timeoutMs = 300000,
  runId = "foc-515-eval",
  issues: issuesOverride,
  limit,
  ids,
} = {}) {
  if (!outDir || typeof outDir !== "string") throw new TypeError("outDir is required — artifacts land under it");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const source = issuesOverride ?? fixture.issues;
  if (!Array.isArray(source) || source.length === 0) throw new TypeError("fixture carries no cases — nothing to measure");
  let issues = source.slice(0, Number.isInteger(limit) ? limit : undefined);
  if (Array.isArray(ids) && ids.length) {
    const wanted = new Set(ids);
    issues = issues.filter((i) => wanted.has(i.id));
    if (!issues.length) throw new TypeError(`--ids ${ids.join(",")} matches no fixture case`);
  }

  const step = loadGraph().nodes?.plan?.steps?.["plan.intent"];
  if (!step) throw new TypeError("config/graph.json has no plan.intent step — the eval drives the runner's real step object");
  const shadowDir = join(outDir, runId);
  mkdirSync(shadowDir, { recursive: true });
  // The node reports only that "the map failed the step's output schema" — the
  // AJV detail would otherwise be lost. Wrap the validator so the run can ship
  // the actual violations: a schema failure is the one thing that must never
  // be reported as an unexplained red.
  const ajvValidate = schemaValidator(step.output);
  const schemaErrors = [];
  const validate = (raw) => {
    const ok = ajvValidate(raw) === true;
    if (!ok) schemaErrors.push(JSON.parse(JSON.stringify(ajvValidate.errors ?? [])));
    return ok;
  };

  // Rows measured by an earlier invocation into this outDir: kept verbatim.
  const rows = loadRows(outDir);
  const done = new Set(rows.map((r) => r.id));
  for (const issue of issues) {
    if (done.has(issue.id)) continue;
    schemaErrors.length = 0;
    const inputs = buildInputs(issue);
    const row = {
      id: inputs.id,
      title: inputs.title,
      taskType: inputs.taskType,
      failClosedType: false,
      gaps: inputs.gaps,
      scopeSummary: inputs.scopeSummary,
      groundTruth: inputs.groundTruth,
      hasGroundTruth: inputs.hasGroundTruth,
    };
    const startedAt = Date.now();
    try {
      // ONE real node run, the same transport a live graph run uses: registry
      // prompt + resolved reads + strict schema, cheap tier, one retry policy.
      const generator = createDefaultGenerator({
        apiKey,
        runId,
        taskKey: inputs.id,
        shadowDir,
        fetchImpl,
        timeoutMs,
      });
      const result = await runPlanIntentNode({
        stepId: "plan.intent",
        step,
        reads: {
          "inbox.entry": inputs.entry,
          "plan.dor.gaps": inputs.gaps,
          "intake.taskType": inputs.taskType,
        },
        generator,
        validate,
        maps: {},
        presented: {},
      });
      row.nodeStatus = result.status;
      row.attempts = result.attempts ?? null;
      row.mapVersion = result.mapVersion ?? null;
      row.failClosedType = result.failClosedType === true;
      row.checks = result.checks ?? null;
      row.foldStale = result.fold?.stale?.length ?? 0;
      if (result.status === "done") {
        row.ok = true;
        row.output = result.output;
        row.schemaValid = validate(result.output) === true;
      } else {
        row.ok = false;
        row.error = result.error;
        row.problems = result.problems ?? null;
      }
      row.durationMs = Date.now() - startedAt;
      if (!inputs.hasGroundTruth) row.note = "no ground truth in fixture — coverage reported UNKNOWN, excluded from the coverage aggregate";
    } catch (err) {
      row.ok = false;
      row.nodeStatus = "threw";
      row.error = {
        code: typeof err?.code === "string" ? err.code : "unknown",
        message: typeof err?.message === "string" ? err.message.slice(0, 200) : "unknown",
      };
    }
    if (schemaErrors.length) row.schemaErrors = schemaErrors.map((list) => list.slice(0, 12));
    attachUsage(row, shadowDir);
    rows.push(row);
    // Persist as we go: a serial 12-case run is long, and a measurement that
    // only exists in memory at the end is a measurement that can be lost.
    writeOutputs(outDir, rows, source);
  }

  // Usage/cost join: the transport appended one event line per real call
  // (taskKey = case id) — the same ledger a live run produces. A retry is a
  // second line under the same key, so this SUMS per case. Attached per row as
  // it runs (above); re-attached here so rows from an earlier invocation are
  // refreshed too.
  for (const row of rows) attachUsage(row, shadowDir);

  const okRows = rows.filter((r) => r.ok);
  const schemaValid = okRows.filter((r) => r.schemaValid === true);
  const withUsage = rows.filter((r) => r.usage);
  // Latency is NODE WALL-CLOCK, not the provider's own meter: a call that
  // aborts writes no FOC-449 event line, so `callDurationMs` is null exactly
  // for the SLOWEST cases. Dropping them would report a p90 that is lower than
  // reality — the wall clock covers every case, aborts included.
  const latencies = rows.map((r) => r.durationMs);
  const itemCounts = okRows.map((r) => (Array.isArray(r.output?.interpretations) ? r.output.interpretations.length : 0));
  const summary = {
    ranAt: new Date().toISOString(),
    fixture: fixturePath,
    runId,
    cases: rows.length,
    ok: okRows.length,
    rejected: rows.length - okRows.length,
    schemaValid: schemaValid.length,
    retries: rows.reduce((n, r) => n + Math.max(0, (r.calls ?? 0) - 1), 0),
    calls: rows.reduce((n, r) => n + (r.calls ?? 0), 0),
    failClosedType: rows.filter((r) => r.failClosedType).map((r) => r.id),
    noGroundTruth: rows.filter((r) => !r.hasGroundTruth).map((r) => r.id),
    items: {
      total: itemCounts.reduce((n, v) => n + v, 0),
      min: itemCounts.length ? Math.min(...itemCounts) : 0,
      max: itemCounts.length ? Math.max(...itemCounts) : 0,
    },
    sources: sourceDistribution(okRows),
    latencyMs: {
      basis: "node wall-clock, aborts included (a timed-out call writes no FOC-449 event line)",
      min: latencies.filter((v) => v != null).length ? Math.min(...latencies.filter((v) => v != null)) : null,
      max: latencies.filter((v) => v != null).length ? Math.max(...latencies.filter((v) => v != null)) : null,
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
    },
    callLatencyMs: {
      basis: "provider call durations from the FOC-449 event lines — null exactly where a call aborted",
      p50: percentile(rows.map((r) => r.callDurationMs), 50),
      p90: percentile(rows.map((r) => r.callDurationMs), 90),
    },
    aborted: rows.filter((r) => r.error?.code === "provider_error" && /timed out/.test(r.error?.message ?? "")).map((r) => r.id),
    totalInputTokens: withUsage.reduce((n, r) => n + (r.usage.inputTokens ?? 0), 0),
    totalOutputTokens: withUsage.reduce((n, r) => n + (r.usage.outputTokens ?? 0), 0),
    totalCostUsd: rows.reduce((n, r) => n + (r.cost ?? 0), 0),
    costPerCall: null, // filled below
    costNote: rows.filter((r) => r.ok && !r.usage).length
      ? `${rows.filter((r) => r.ok && !r.usage).length} successful call(s) carried no usable usage row — their cost is NOT in the totals`
      : null,
    model: [...new Set(rows.map((r) => r.model).filter(Boolean))],
    scoring: "human — see docs/benchmark/plan-intent-eval.md and the run report",
  };
  summary.costPerCall = summary.calls ? summary.totalCostUsd / summary.calls : null;

  // Fixture order, whatever order the batches measured in.
  const order = new Map(source.map((i, n) => [i.id, n]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  writeOutputs(outDir, rows, source);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(outDir, "table.txt"), renderTable(rows, summary));
  return summary;
}

/** The stated/inferred/unknown distribution across every accepted map. */
function sourceDistribution(okRows) {
  const out = { stated: 0, inferred: 0, unknown: 0, other: 0 };
  for (const row of okRows) {
    for (const item of row.output?.interpretations ?? []) {
      const src = item?.source;
      if (src === "stated" || src === "inferred" || src === "unknown") out[src]++;
      else out.other++;
    }
  }
  return out;
}

function renderTable(rows, summary) {
  const lines = [
    `plan.intent eval — ${summary.ranAt} — model: ${summary.model.join(", ") || "n/a"}`,
    `cases ${summary.cases} · ok ${summary.ok} · rejected ${summary.rejected} · schema-valid ${summary.schemaValid} · aborted ${summary.aborted.length} · retries ${summary.retries} · calls ${summary.calls}`,
    `items ${summary.items.total} (min ${summary.items.min} / max ${summary.items.max}) · stated ${summary.sources.stated} · inferred ${summary.sources.inferred} · unknown ${summary.sources.unknown}`,
    `latency ms (node wall-clock) p50 ${summary.latencyMs.p50 ?? "-"} · p90 ${summary.latencyMs.p90 ?? "-"} · max ${summary.latencyMs.max ?? "-"}`,
    `tokens in ${summary.totalInputTokens} · out ${summary.totalOutputTokens} · cost $${summary.totalCostUsd.toFixed(6)}${summary.costNote ? ` (${summary.costNote})` : ""}`,
    "",
    "id       ok  items  st/in/un   ms       in/out tok   cost USD  retries  errors",
  ];
  for (const r of rows) {
    const items = Array.isArray(r.output?.interpretations) ? r.output.interpretations : [];
    const counts = { stated: 0, inferred: 0, unknown: 0 };
    for (const it of items) if (counts[it?.source] !== undefined) counts[it.source]++;
    lines.push(
      [
        r.id.padEnd(8),
        String(r.ok),
        String(items.length).padEnd(6),
        `${counts.stated}/${counts.inferred}/${counts.unknown}`.padEnd(10),
        String(r.durationMs ?? "-").padEnd(8),
        r.usage ? `${r.usage.inputTokens ?? "?"}/${r.usage.outputTokens ?? "?"}` : "-",
        r.cost != null ? r.cost.toFixed(6) : "-",
        String(Math.max(0, (r.calls ?? 0) - 1)).padEnd(8),
        r.ok ? "-" : (r.error?.code ?? "unknown"),
      ].join("  "),
    );
  }
  if (summary.failClosedType.length) lines.push("", `taskType fail-closed (all 8 perspectives): ${summary.failClosedType.join(", ")}`);
  if (summary.noGroundTruth.length) lines.push(`no ground truth (UNKNOWN, excluded from coverage): ${summary.noGroundTruth.join(", ")}`);
  return lines.join("\n") + "\n";
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("plan-intent-eval: OPENROUTER_API_KEY is absent — nothing measured (exit 3)");
    return 3;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = flag("out-dir") ?? join(root, ".state", "foc-515", "eval", stamp);
  const limitRaw = flag("limit");
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
  if (limitRaw !== undefined && !Number.isInteger(limit)) {
    console.error("plan-intent-eval: --limit must be an integer");
    return 2;
  }
  const idsRaw = flag("ids");
  const ids = idsRaw !== undefined ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const summary = await runAll({
    fixturePath: flag("fixture") ?? FIXTURE_PATH,
    outDir,
    limit,
    ids,
    runId: flag("run-id") ?? "foc-515-eval",
    ...(flag("timeout") ? { timeoutMs: Number.parseInt(flag("timeout"), 10) } : {}),
  });
  console.log(readFileSync(join(outDir, "table.txt"), "utf8"));
  console.log(`artifacts: ${outDir}`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`plan-intent-eval: ${err?.message || err}`);
      process.exit(1);
    });
}
