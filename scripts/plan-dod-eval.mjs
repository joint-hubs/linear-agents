// scripts/plan-dod-eval.mjs — FOC-474 AC4: measure the plan.dod [G] node
// against the 12 Fenix issues whose DoD Mateusz already approved.
//
// For each fixture issue the harness builds the SAME input partition the
// runner hands a live plan.dod step (title + accepted-scope summary — the
// approved DoD section is GROUND TRUTH and never enters the inputs), then
// drives ONE real cheap-tier call through the runner's own default generator
// (createDefaultGenerator, the exact transport a live graph run uses). Usage
// and cost come off the FOC-449 event lines the generator wrote — the same
// ledger a live run produces, never a second meter.
//
// Scoring (complete / verifiable / no-invented-scope, pass/partial/fail) is
// human: an LLM grader would need its own validation, so the harness ships
// the raw outputs plus mechanical facts (schema validity, item counts, kind
// distribution, latency, tokens, cost) and the graded table lives in the
// run report + docs/benchmark/plan-dod-eval.md. A FAIL verdict here is a
// measurement, not an error (codegraph-benchmark posture).
//
// Input partition (FOC-474 design, decided point 1):
//   - the runtime payload carries the issue title + the accepted scope
//     summary, extracted deterministically by THIS caller;
//   - the scope summary is the description with (a) the approved DoD
//     section stripped — from the "## Definition of [Dd]one" heading or the
//     inline "**Definition of done:**" / "**DoD:**" marker to the next "## "
//     heading (or EOF) — and (b) the terminal "<!-- fenix-roadmap-… -->"
//     metadata block stripped;
//   - the repo's DoD conventions (suite green, lint 0, one commit) live in
//     the registry prompt, never in the per-issue payload.
//
// CLI:
//   node scripts/plan-dod-eval.mjs [--fixture <path>] [--out-dir <dir>]
//        [--limit <n>] [--run-id <id>]
// Artifacts (gitignored, under .state/foc-474/eval/<timestamp>/):
//   outputs.jsonl  — one line per issue: inputs as built, output, usage, cost
//   summary.json   — aggregate: counts, tokens, cost, model
//   table.txt      — compact per-issue table
//   <run-id>/decisions.jsonl — the FOC-449 event lines themselves
// Exit 0 = run completed (some rows may have failed calls — that is a
// measurement); exit 3 = no OPENROUTER_API_KEY, nothing measured.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";
import { loadGraph } from "./graph-validate.mjs";
import { createDefaultGenerator } from "./graph-runner.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, "..");

const FIXTURE_PATH = join(__dir, "plan-dod-eval-fixture.json");

// The approved DoD section, in its three shapes: a "## Definition of
// [Dd]one" heading (9 issues) or the inline "**Definition of done:**" /
// "**DoD:**" marker (FOC-441, FOC-443). FOC-406 carries neither — its DoD
// was never written, so it has NO ground truth and is excluded from the
// completeness aggregate (reported UNKNOWN, never scored a fake pass).
const DOD_HEADING = /^## Definition of [Dd]one[^\n]*(?:\n|$)/m;
const DOD_INLINE = /\*\*(?:Definition of done|DoD):\*\*/;
// Roadmap metadata is a terminal block: from the marker to end-of-text.
const ROADMAP_BLOCK = /[ \t]*<!-- fenix-roadmap[\s\S]*$/;

function stripRoadmap(text) {
  return text.replace(ROADMAP_BLOCK, "").trimEnd();
}

/**
 * Build the plan.dod input partition for one fixture issue. Pure.
 * Returns { id, title, scopeSummary, dodGroundTruth, hasGroundTruth }.
 * Throws TypeError on a malformed fixture row — the fixture is external
 * input and gets validated, not trusted.
 */
export function buildInputs(issue) {
  if (!issue || typeof issue !== "object") throw new TypeError("fixture row is not an object");
  const { id, title, description } = issue;
  if (typeof id !== "string" || !id.trim()) throw new TypeError("fixture row: id missing");
  if (typeof title !== "string" || !title.trim()) throw new TypeError(`fixture row ${id}: title missing`);
  if (typeof description !== "string") throw new TypeError(`fixture row ${id}: description missing`);

  // Ground truth first: locate the DoD section, then cut it out of the
  // scope text. The section spans from the marker to the next "## " heading
  // (or EOF). Roadmap metadata is stripped from BOTH — in the 2026-09-21
  // fixture the marker sits between the DoD section and the roadmap
  // heading, so the raw slice would otherwise carry it.
  let dodGroundTruth = null;
  let scopeText = description;
  const marker = DOD_HEADING.exec(description) ?? DOD_INLINE.exec(description);
  if (marker) {
    const start = marker.index + marker[0].length;
    const nextHeading = /^## /m.exec(description.slice(start));
    const end = nextHeading ? start + nextHeading.index : description.length;
    dodGroundTruth = stripRoadmap(description.slice(start, end)).trim() || null;
    scopeText = description.slice(0, marker.index) + description.slice(end);
  }
  const scopeSummary = stripRoadmap(scopeText).replace(/\n{3,}/g, "\n\n").trim();
  return { id: id.trim(), title, scopeSummary, dodGroundTruth, hasGroundTruth: dodGroundTruth !== null };
}

/** Read the FOC-449 event lines a run wrote, keyed by taskKey. */
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
      if (line_.type === "event" && typeof line_.taskKey === "string") byTask.set(line_.taskKey, line_);
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

/**
 * Run the eval: one real plan.dod call per fixture issue, artifacts under
 * outDir. Returns the summary object (also written as summary.json).
 * Deps are injectable so tests drive it offline (fetchImpl stub, explicit
 * issues list).
 */
export async function runAll({
  fixturePath = FIXTURE_PATH,
  outDir,
  apiKey = process.env.OPENROUTER_API_KEY,
  fetchImpl = fetch,
  timeoutMs = 120000,
  runId = "foc-474-eval",
  issues: issuesOverride,
  limit,
} = {}) {
  if (!outDir || typeof outDir !== "string") throw new TypeError("outDir is required — artifacts land under it");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const source = issuesOverride ?? fixture.issues;
  if (!Array.isArray(source) || source.length === 0) throw new TypeError("fixture carries no issues — nothing to measure");
  const issues = source.slice(0, Number.isInteger(limit) ? limit : undefined);

  const step = loadGraph().nodes?.plan?.steps?.["plan.dod"];
  if (!step) throw new TypeError("config/graph.json has no plan.dod step — the eval drives the runner's real step object");
  const shadowDir = join(outDir, runId);
  mkdirSync(shadowDir, { recursive: true });
  const validate = schemaValidator(step.output);

  const rows = [];
  for (const issue of issues) {
    const inputs = buildInputs(issue);
    const row = {
      id: inputs.id,
      title: inputs.title,
      hasGroundTruth: inputs.hasGroundTruth,
      scopeSummary: inputs.scopeSummary,
      dodGroundTruth: inputs.dodGroundTruth,
    };
    const startedAt = Date.now();
    try {
      // ONE real call, the same transport a live graph run uses: registry
      // prompt + resolved reads + strict schema, cheap tier.
      const generator = createDefaultGenerator({
        apiKey,
        runId,
        taskKey: inputs.id,
        shadowDir,
        fetchImpl,
        timeoutMs,
      });
      const output = await generator({ stepId: "plan.dod", step, reads: { "inbox.entry": { title: inputs.title, scopeSummary: inputs.scopeSummary } } });
      row.ok = true;
      row.output = output;
      row.schemaValid = validate(output) === true;
      row.durationMs = Date.now() - startedAt;
      if (!inputs.hasGroundTruth) row.note = "no ground truth in fixture — excluded from the completeness aggregate, reported UNKNOWN";
    } catch (err) {
      row.ok = false;
      row.error = {
        code: typeof err?.code === "string" ? err.code : "unknown",
        message: typeof err?.message === "string" ? err.message.slice(0, 200) : "unknown",
      };
    }
    rows.push(row);
  }

  // Usage/cost join: the generator appended one event line per successful
  // call (taskKey = issue id) — the same ledger a live run produces.
  const events = readEventLines(shadowDir);
  for (const row of rows) {
    const line = events.get(row.id);
    if (!line) continue;
    row.model = line.model ?? null;
    row.usage = line.usage ?? null;
    row.callDurationMs = line.durationMs ?? null;
    row.cost = costOf(line.model, line.usage);
  }

  const okRows = rows.filter((r) => r.ok);
  const schemaValid = okRows.filter((r) => r.schemaValid === true);
  const withUsage = okRows.filter((r) => r.usage);
  const summary = {
    ranAt: new Date().toISOString(),
    fixture: fixturePath,
    runId,
    issues: rows.length,
    ok: okRows.length,
    failed: rows.length - okRows.length,
    schemaValid: schemaValid.length,
    noGroundTruth: rows.filter((r) => !r.hasGroundTruth).map((r) => r.id),
    totalInputTokens: withUsage.reduce((n, r) => n + (r.usage.inputTokens ?? 0), 0),
    totalOutputTokens: withUsage.reduce((n, r) => n + (r.usage.outputTokens ?? 0), 0),
    totalCostUsd: withUsage.reduce((n, r) => n + (r.cost ?? 0), 0),
    costNote: withUsage.length < okRows.length
      ? `${okRows.length - withUsage.length} successful call(s) carried no usable usage row — their cost is NOT in the totals`
      : null,
    model: [...new Set(okRows.map((r) => r.model).filter(Boolean))],
    scoring: "human — see docs/benchmark/plan-dod-eval.md and the run report",
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "outputs.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(outDir, "table.txt"), renderTable(rows, summary));
  return summary;
}

function renderTable(rows, summary) {
  const lines = [
    `plan.dod eval — ${summary.ranAt} — model: ${summary.model.join(", ") || "n/a"}`,
    `issues ${summary.issues} · ok ${summary.ok} · failed ${summary.failed} · schema-valid ${summary.schemaValid}`,
    `tokens in ${summary.totalInputTokens} · out ${summary.totalOutputTokens} · cost $${summary.totalCostUsd.toFixed(6)}${summary.costNote ? ` (${summary.costNote})` : ""}`,
    "",
    "id       ok  schema  items  kinds                          ms      in/out tok   cost USD",
  ];
  for (const r of rows) {
    const items = Array.isArray(r.output?.definitionOfDone) ? r.output.definitionOfDone : [];
    const kinds = [...new Set(items.map((i) => i?.kind).filter(Boolean))].join(",") || "-";
    lines.push(
      [
        r.id.padEnd(8),
        String(r.ok),
        r.ok ? String(r.schemaValid).padEnd(6) : "-".padEnd(6),
        String(items.length).padEnd(5),
        kinds.padEnd(30),
        String(r.callDurationMs ?? "-").padEnd(7),
        r.usage ? `${r.usage.inputTokens ?? "?"}/${r.usage.outputTokens ?? "?"}` : "-",
        r.cost != null ? r.cost.toFixed(6) : "-",
      ].join("  "),
    );
  }
  if (summary.noGroundTruth.length) lines.push("", `no ground truth (UNKNOWN, excluded from completeness): ${summary.noGroundTruth.join(", ")}`);
  return lines.join("\n") + "\n";
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
  };
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("plan-dod-eval: OPENROUTER_API_KEY is absent — nothing measured (exit 3)");
    return 3;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = flag("out-dir") ?? join(root, ".state", "foc-474", "eval", stamp);
  const limitRaw = flag("limit");
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
  if (limitRaw !== undefined && !Number.isInteger(limit)) {
    console.error("plan-dod-eval: --limit must be an integer");
    return 2;
  }
  const summary = await runAll({
    fixturePath: flag("fixture") ?? FIXTURE_PATH,
    outDir,
    limit,
    runId: flag("run-id") ?? "foc-474-eval",
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
      console.error(`plan-dod-eval: ${err?.message || err}`);
      process.exit(1);
    });
}
