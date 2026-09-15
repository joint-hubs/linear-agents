// scripts/supervisor-cost.test.mjs — the money number has to be a measurement.
//
// Three things this locks down, all of them things that were silently wrong:
//
// 1. COST IS COMPUTED, NOT REPORTED. Claude Code emits `total_cost_usd` from its
//    own table and does not recognise a single model id this repo routes to. A
//    real run on `stealth/ox-alpha` — which OpenRouter serves at $0/$0 — was
//    reported at $0.2059. The Supervisor now prices turns from token counts
//    through config/models.json, and keeps the stream's figure beside it so the
//    divergence stays visible instead of one silently replacing the other.
//
// 2. UNPRICED IS NOT FREE. A model with no price row makes the total `null`, and
//    null is contagious. Treating it as 0 is how 6M Haiku tokens once cost
//    nothing and dragged the dashboard total to null instead (config-drift
//    header). Here it would also hand a spend cap a number it has no right to.
//
// 3. A CAP THAT CANNOT BE EVALUATED IS NOT A CAP. If the operator set a limit
//    and spend is unknown, carrying on spends unbounded money under the one
//    setting whose purpose is to bound it. It refuses, and names the model.
//
// Run: node scripts/supervisor-cost.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  addCost,
  budgetStatus,
  costFromResult,
  ensureRunDir,
  runDir,
  writeRegistry,
} from "./supervisor-lib.mjs";
import { calculateCost, priceThreshold, pricingSnapshot } from "./telemetry-store.mjs";
import { comparePrices } from "./price-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPAWN = join(ROOT, "scripts", "supervisor-spawn.mjs");
const FOLLOWUP = join(ROOT, "scripts", "supervisor-followup.mjs");
const STATUS = join(ROOT, "scripts", "supervisor-status.mjs");

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const fail = (msg) => { throw new Error(msg); };

const cleanup = [];
process.on("exit", () => {
  for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

let n = 0;
function fixtureRun(children = {}) {
  const runId = `test-cost-${process.pid}-${n++}`;
  cleanup.push(runDir(runId));
  ensureRunDir(runId);
  writeFileSync(join(runDir(runId), "triage.json"), JSON.stringify({ issue: "FOC-999", verdict: "dev" }));
  writeRegistry(runId, { runId, children, rounds: {}, });
  return runId;
}
const child = (over = {}) => ({
  childId: "dev-1", squad: "dev", taskId: "FOC-999", sessionId: "s1",
  status: "exited", turns: [{ pid: 1 }], costUsd: 0, worktree: join(tmpdir(), "wt"),
  permissionMode: "bypassPermissions", ...over,
});

// Mirrors supervisor-watch.mjs: the watcher prices through the whole snapshot
// (flat openrouter scope + scoped map), not the flat scope alone — a
// nebul-catalogued key like zai-org/GLM-5.2-FP8 is invisible to flat-only
// resolution (FOC-165).
const SNAPSHOT = pricingSnapshot();
const priceOne = (usage, model) => calculateCost(usage, model, SNAPSHOT.prices, null, SNAPSHOT.scoped);

// The expected side of every cost assertion below is DERIVED from the same
// snapshot the runtime prices through (pricingSnapshot() above), never from a
// literal. A literal tracks a rate level, and the next price sync breaks it —
// the level is price-check.mjs's job (with a date); the tests own the
// CALCULATION. This bit us on 2026-09-15: seven assertions pinned to pre-sync
// rates went red on a green calculation.
const requirePrice = (model, ...fields) => {
  const r = SNAPSHOT.prices[model];
  assert.ok(r, `precondition: ${model} must have a price row in the runtime snapshot`);
  for (const f of fields) {
    assert.ok(r[f] > 0, `precondition: ${model}.${f} must be > 0, got ${r[f]} — a 0-vs-0 comparison would make the test vacuous`);
  }
  return r;
};

// The shape Claude Code actually emits, taken from a real run on 2026-08-26.
const resultEvent = (over = {}) => ({
  type: "result",
  subtype: "success",
  total_cost_usd: 0.20587699999999998,
  usage: { input_tokens: 28572, output_tokens: 2, cache_read_input_tokens: 22784, cache_creation_input_tokens: 0 },
  modelUsage: {
    "stealth/ox-alpha": { inputTokens: 28572, outputTokens: 2, cacheReadInputTokens: 22784, cacheCreationInputTokens: 0 },
  },
  ...over,
});

// ── 1. computed, not reported ─────────────────────────────────────────────────
console.log("\nkoszt liczony, nie przepisany");

test("a $0 model costs $0 however loudly the stream disagrees", () => {
  // The exact case that exposed this: OpenRouter serves stealth/ox-alpha free,
  // Claude Code billed the turn at $0.21.
  const out = costFromResult(resultEvent(), null, priceOne);
  assert.equal(out.computed, 0, "ox-alpha is priced at 0 in config/models.json");
  assert.equal(out.reported, 0.20587699999999998, "the stream's figure is kept, not discarded");
  assert.deepEqual(out.unpriced, []);
});

test("a priced model is costed from its tokens", () => {
  const out = costFromResult(
    resultEvent({
      modelUsage: { "z-ai/glm-5.2": { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 0 } },
    }),
    null,
    priceOne,
  );
  // Expected value derived from the snapshot row the runtime prices through.
  const r = requirePrice("z-ai/glm-5.2", "input", "output");
  const expected = r.input + r.output;
  assert.ok(Math.abs(out.computed - expected) < 0.001, `expected ~${expected} (snapshot input+output per 1M), got ${out.computed}`);
});

test("a turn touching two models prices each at its own rate", () => {
  // `usage` is already summed and would price the whole turn at one rate;
  // modelUsage is the only place the split survives.
  const out = costFromResult(
    resultEvent({
      modelUsage: {
        "z-ai/glm-5.2": { inputTokens: 1_000_000, outputTokens: 0 },
        "minimax/minimax-m3": { inputTokens: 1_000_000, outputTokens: 0 },
      },
    }),
    null,
    priceOne,
  );
  const g = requirePrice("z-ai/glm-5.2", "input");
  const m = requirePrice("minimax/minimax-m3", "input");
  const expected = g.input + m.input;
  assert.ok(Math.abs(out.computed - expected) < 0.001, `expected ~${expected} (snapshot input per 1M for both models), got ${out.computed}`);
});

test("without modelUsage it falls back to usage + the model from system/init", () => {
  const out = costFromResult(
    { type: "result", usage: { input_tokens: 1_000_000, output_tokens: 0 }, total_cost_usd: 9 },
    "z-ai/glm-5.2",
    priceOne,
  );
  const r = requirePrice("z-ai/glm-5.2", "input");
  assert.ok(Math.abs(out.computed - r.input) < 0.001, `expected ~${r.input} (snapshot input per 1M), got ${out.computed}`);
});

test("a nebul-catalogued key prices non-zero on the watch side (FOC-165)", () => {
  // zai-org/GLM-5.2-FP8 lives only under the nebul scope. The flat openrouter
  // scope used to be the only thing the watcher consulted, so every FP8 turn
  // cost "unknown" — and an unknown turn makes the spend cap refuse.
  const out = costFromResult(
    resultEvent({
      modelUsage: { "zai-org/GLM-5.2-FP8": { inputTokens: 1_000_000, outputTokens: 1_000_000 } },
    }),
    null,
    priceOne,
  );
  // nebul rates: input 1.91 + output 9.57 per 1M
  assert.ok(Math.abs(out.computed - (1.91 + 9.57)) < 0.001, `expected ~11.48, got ${out.computed}`);
  assert.deepEqual(out.unpriced, []);
});

test("both spellings of the usage fields are read", () => {
  // camelCase in modelUsage, snake_case in usage. Missing one would silently
  // zero the cache-read tokens, which are ~87% of a lead's volume.
  const camel = costFromResult(
    { type: "result", modelUsage: { "z-ai/glm-5.2": { cacheReadInputTokens: 1_000_000 } } }, null, priceOne);
  const snake = costFromResult(
    { type: "result", usage: { cache_read_input_tokens: 1_000_000 } }, "z-ai/glm-5.2", priceOne);
  assert.ok(camel.computed > 0 && Math.abs(camel.computed - snake.computed) < 1e-9,
    `camel ${camel.computed} vs snake ${snake.computed}`);
});

// ── FOC-165 (f): a promptTokenThreshold row does not bill at/above its
// threshold — the turn is unpriced with a qualifier naming the reason, so the
// refusal is actionable instead of "add a row that already exists". ----------

const thresholdOne = (model) => priceThreshold(model, SNAPSHOT.prices, null, SNAPSHOT.scoped);

test("a turn at/above the declared threshold is unpriced with a named qualifier, not under-counted", () => {
  const out = costFromResult(
    resultEvent({
      modelUsage: { "openai/gpt-6-astra": { inputTokens: 272_000, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    }),
    null,
    priceOne,
    thresholdOne,
  );
  assert.equal(out.computed, null, `computed=${out.computed} (expected null — the flat row must not bill above its threshold)`);
  assert.deepEqual(
    out.unpriced,
    ["openai/gpt-6-astra (unsupported above 272000 prompt tokens)"],
    `unpriced=${JSON.stringify(out.unpriced)}`,
  );
});

test("a turn below the threshold prices at the base rate as before", () => {
  const out = costFromResult(
    resultEvent({
      modelUsage: { "openai/gpt-6-astra": { inputTokens: 271_999, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    }),
    null,
    priceOne,
    thresholdOne,
  );
  assert.ok(Math.abs(out.computed - 2.71999) < 1e-9, `computed=${out.computed} (expected 2.71999)`);
  assert.deepEqual(out.unpriced, []);
});

test("without a thresholdOne binding the unpriced entry stays the bare model name", () => {
  // Back-compat: the watcher passes the binding; other callers of
  // costFromResult (tests, tooling) must not change shape.
  const out = costFromResult(
    resultEvent({
      modelUsage: { "openai/gpt-6-astra": { inputTokens: 300_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    }),
    null,
    priceOne,
  );
  assert.equal(out.computed, null, "calculateCost still refuses above the threshold");
  assert.deepEqual(out.unpriced, ["openai/gpt-6-astra"], `unpriced=${JSON.stringify(out.unpriced)}`);
});

// ── 2. unpriced is not free ───────────────────────────────────────────────────
console.log("\nbez ceny znaczy nieznany, nie darmowy");

test("a model with no price row makes the turn cost null, not 0", () => {
  const out = costFromResult(
    resultEvent({ modelUsage: { "acme/nobody-priced-this": { inputTokens: 5_000_000 } } }),
    null,
    priceOne,
  );
  assert.equal(out.computed, null, "an unpriced model must be visibly unpriced");
  assert.deepEqual(out.unpriced, ["acme/nobody-priced-this"]);
});

test("one unpriced model poisons a turn that also used a priced one", () => {
  // A partial total is worse than no total: it looks authoritative.
  const out = costFromResult(
    resultEvent({
      modelUsage: { "z-ai/glm-5.2": { inputTokens: 1_000_000 }, "acme/unknown": { inputTokens: 1_000_000 } },
    }),
    null,
    priceOne,
  );
  assert.equal(out.computed, null);
  assert.deepEqual(out.unpriced, ["acme/unknown"]);
});

test("addCost keeps null contagious in both directions", () => {
  assert.equal(addCost(1, 2), 3);
  assert.equal(addCost(null, 2), 2, "an unknown running total plus a known turn is that turn");
  assert.equal(addCost(1, null), null, "a known total plus an unknown turn is unknown");
  assert.equal(addCost(undefined, null), null);
});

// ── 3. the cap ────────────────────────────────────────────────────────────────
console.log("\nlimit wydatków");

// A sandbox repo and the mock binary are NOT optional here. Without --repo the
// spawn creates a worktree in this repo; without LA_CLAUDE_BIN it starts the
// real claude. The first version of this file did both, left ../la-wt/foc-999-dev
// attached to the main checkout, and would have spent money on a live model.
function sandboxRepo() {
  const base = mkdtempSync(join(tmpdir(), "la-cost-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repo, "README.md"), "fixture");
  git("add", "-A");
  git("commit", "-m", "init");
  cleanup.push(base);
  return repo;
}

const baseEnv = (env) => ({
  ...process.env,
  LA_SUPERVISOR_NO_TELEMETRY: "1",
  LA_CLAUDE_BIN: join(ROOT, "scripts", "mock-claude.mjs"),
  ...env,
});

const spawnCli = (runId, env = {}, repo = sandboxRepo()) =>
  spawnSync(
    process.execPath,
    [SPAWN, "--run", runId, "--squad", "dev", "--task", "FOC-999", "--prompt", "k", "--repo", repo],
    { cwd: ROOT, encoding: "utf8", env: baseEnv(env) },
  );
const followupCli = (runId, env = {}) =>
  spawnSync(process.execPath, [FOLLOWUP, "--run", runId, "--child", "dev-1", "--prompt", "more"], {
    cwd: ROOT, encoding: "utf8", env: baseEnv(env),
  });
const parse = (r) => JSON.parse(r.stdout);

test("unset cap changes nothing", () => {
  const runId = fixtureRun({ "dev-1": child({ costUsd: 999 }) });
  const b = budgetStatus(runId);
  assert.equal(b.cap, null);
  assert.equal(b.exceeded, false);
});

test("spawn refuses once the cap is reached, and names the spend", () => {
  const runId = fixtureRun({ "dev-1": child({ costUsd: 5.5 }) });
  const r = spawnCli(runId, { LA_SUPERVISOR_MAX_COST_USD: "5" });
  assert.equal(r.status, 1);
  const err = parse(r).error;
  assert.match(err, /5\.5000 of \$5\.00/);
  assert.match(err, /turn boundaries/, "the post-hoc nature has to be stated, not implied");
});

test("followup refuses too — a cap on first spawn only is a cap on one turn", () => {
  const runId = fixtureRun({ "dev-1": child({ costUsd: 5.5 }) });
  const r = followupCli(runId, { LA_SUPERVISOR_MAX_COST_USD: "5" });
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /budget spent/);
});

test("under the cap, nothing is blocked by the budget", () => {
  // Asserted through budgetStatus rather than by spawning: this test only cares
  // that the gate stays open, and starting a child to prove it would leave a
  // worktree and a session behind for no extra confidence.
  const runId = fixtureRun({ "dev-1": child({ costUsd: 1 }) });
  process.env.LA_SUPERVISOR_MAX_COST_USD = "5";
  try {
    const b = budgetStatus(runId);
    assert.equal(b.cap, 5);
    assert.equal(b.spent, 1);
    assert.equal(b.exceeded, false);
    assert.equal(b.evaluable, true);
  } finally {
    delete process.env.LA_SUPERVISOR_MAX_COST_USD;
  }
});

test("a cap with UNKNOWN spend refuses, and names the model that needs a price", () => {
  const runId = fixtureRun({ "dev-1": child({ costUsd: null, unpricedModels: ["acme/unknown"] }) });
  const r = spawnCli(runId, { LA_SUPERVISOR_MAX_COST_USD: "5" });
  assert.equal(r.status, 1);
  const err = parse(r).error;
  assert.match(err, /UNKNOWN/);
  assert.match(err, /acme\/unknown/, "the refusal is only actionable if it names the model");
  assert.match(err, /not a cap/);
});

test("unknown spend WITHOUT a cap is not an error — it is just unknown", () => {
  const runId = fixtureRun({ "dev-1": child({ costUsd: null, unpricedModels: ["acme/unknown"] }) });
  const b = budgetStatus(runId);
  assert.equal(b.cap, null);
  assert.equal(b.evaluable, false);
  assert.equal(b.exceeded, false, "no cap means nothing to exceed");
});

test("a malformed cap is refused rather than silently ignored", () => {
  const runId = fixtureRun({ "dev-1": child() });
  const r = spawnCli(runId, { LA_SUPERVISOR_MAX_COST_USD: "five dollars" });
  assert.equal(r.status, 1);
  assert.match(parse(r).error, /not a number/);
});

test("budgetStatus sums children and keeps the reported figure apart", () => {
  const runId = fixtureRun({
    "dev-1": child({ costUsd: 1.5, costUsdReported: 9 }),
    "review-1": child({ childId: "review-1", costUsd: 0.5, costUsdReported: 4 }),
  });
  const b = budgetStatus(runId);
  assert.equal(b.spent, 2);
  assert.equal(b.reported, 13, "the stream's numbers stay visible for comparison");
});

// ── 4. status reports it honestly ─────────────────────────────────────────────
console.log("\nstatus mówi prawdę o koszcie");

test("an unpriced child makes totals.costUsd null, never 0", () => {
  const runId = fixtureRun({ "dev-1": child({ costUsd: null, costUsdReported: 7, unpricedModels: ["acme/x"] }) });
  const out = parse(spawnSync(process.execPath, [STATUS, "--run", runId], { cwd: ROOT, encoding: "utf8" }));
  assert.equal(out.totals.costUsd, null);
  assert.equal(out.totals.costUsdReported, 7);
  assert.deepEqual(out.totals.unpricedModels, ["acme/x"]);
  assert.equal(out.budget.evaluable, false);
});

test("status carries the budget so the lead can see it without spawning", () => {
  const runId = fixtureRun({ "dev-1": child({ costUsd: 2 }) });
  const out = parse(
    spawnSync(process.execPath, [STATUS, "--run", runId], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, LA_SUPERVISOR_MAX_COST_USD: "5" },
    }),
  );
  assert.equal(out.budget.cap, 5);
  assert.equal(out.budget.spent, 2);
  assert.equal(out.budget.exceeded, false);
});

// ── 5. the price table matches reality ────────────────────────────────────────
console.log("\ncennik vs katalog");

test("comparePrices flags a drifted row and ignores one within tolerance", () => {
  const committed = { "a/b": { input: 1, output: 2, cacheRead: 0.1 }, "c/d": { input: 1, output: 2 } };
  const live = {
    "a/b": { prompt: "0.000002", completion: "0.000002", input_cache_read: "0.0000001" },
    "c/d": { prompt: "0.000001", completion: "0.000002" },
  };
  const { drifted, unlisted } = comparePrices(committed, live);
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0].model, "a/b");
  assert.deepEqual(drifted[0].diffs.map((d) => d.field), ["input"]);
  assert.deepEqual(unlisted, []);
});

test("a $0 model matches $0 — the absolute floor, not just the relative band", () => {
  // Without a floor, any difference from zero is infinitely relative and every
  // free model would report as drifted forever.
  const { drifted } = comparePrices(
    { "free/x": { input: 0, output: 0, cacheRead: 0 } },
    { "free/x": { prompt: "0", completion: "0", input_cache_read: "0" } },
  );
  assert.deepEqual(drifted, []);
});

test("a model absent from the catalogue is unlisted, not drifted", () => {
  // Pinned dated snapshots legitimately outlive their listing.
  const { drifted, unlisted } = comparePrices({ "pinned/model-20260101": { input: 1, output: 2 } }, {});
  assert.deepEqual(drifted, []);
  assert.deepEqual(unlisted, ["pinned/model-20260101"]);
});

test("metadata keys are not mistaken for price rows", () => {
  const { drifted, unlisted } = comparePrices({ _doc: "text", "a/b": { input: 1, output: 2 } }, {});
  assert.deepEqual(unlisted, ["a/b"]);
  assert.deepEqual(drifted, []);
});

// ── 6. the four real result shapes of FOC-165 (g) ─────────────────────────────
console.log("\ncztery kształty result (FOC-165 g)");

// Anonymised from a real supervised child: two turns with tokens, two with
// usage all-zeros and modelUsage {}. Each zero-token event used to null the
// whole child's costUsd through addCost — a known $0.xx spend became UNKNOWN
// and the budget gates refused the next spawn.
const FIXTURE = JSON.parse(
  readFileSync(join(ROOT, "scripts", "fixtures", "foc-165-result-events.json"), "utf8"),
);
const byName = Object.fromEntries(FIXTURE.events.map((e) => [e.name, e]));
const INIT_MODEL = Object.keys(byName["success-with-tokens"].modelUsage)[0];

const spentTokens = (e) =>
  e.usage.input_tokens + e.usage.output_tokens + e.usage.cache_read_input_tokens + e.usage.cache_creation_input_tokens;

// Did this event spend anything ANYWHERE? Per-model entries are authoritative
// when present — a real result can carry `usage` all-zeros while `modelUsage`
// holds the tokens (FOC-165 (g), the `zero-usage-real-model-tokens` fixture: top
// level sums to 0, the event carries real per-model tokens worth a snapshot-derived
// fraction of a dollar — asserted below). Reading only the top-level
// `usage` here is the same mistake `costFromResult` must not make.
const anyTokens = (e) => {
  const models = Object.entries(e.modelUsage ?? {});
  const sources = models.length ? models.map(([, u]) => u) : [e.usage ?? {}];
  return sources.some(
    (u) =>
      (u.inputTokens ?? u.input_tokens ?? 0) +
        (u.outputTokens ?? u.output_tokens ?? 0) +
        (u.cacheReadInputTokens ?? u.cache_read_input_tokens ?? 0) +
        (u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? 0) >
      0,
  );
};

test("a zero-token result prices to the known $0, not unknown", () => {
  for (const name of ["success-zero-tokens", "error-zero-tokens"]) {
    const out = costFromResult(byName[name], INIT_MODEL, priceOne);
    assert.equal(out.computed, 0, `${name} priced ${out.computed}, expected the known $0`);
    assert.deepEqual(out.unpriced, []);
  }
});

test("zero tokens are $0 even with no model on record at all", () => {
  const out = costFromResult(byName["success-zero-tokens"], null, priceOne);
  assert.equal(out.computed, 0, "nothing spent needs no rate table");
});

test("empty modelUsage with real tokens falls back to the system/init model", () => {
  // Sibling of the real shapes: modelUsage {} but usage non-zero — a turn that
  // DID spend. The truthy-but-empty object used to skip the fallback and price
  // the turn as unknown.
  const withTokens = byName["success-with-tokens"];
  const out = costFromResult({ ...withTokens, modelUsage: {} }, INIT_MODEL, priceOne);
  const direct = costFromResult(withTokens, null, priceOne);
  assert.ok(out.computed > 0, `expected a real price, got ${out.computed}`);
  assert.equal(out.computed, direct.computed, "same tokens, same price, whatever shape carried them");
});

test("tokens present and unpriceable stay null — unknown is not folded into $0", () => {
  const modelUsage = byName["success-with-tokens"].modelUsage;
  const out = costFromResult(
    { ...byName["success-with-tokens"], modelUsage: { "acme/nobody-priced-this": modelUsage[INIT_MODEL] } },
    null,
    priceOne,
  );
  assert.equal(out.computed, null);
  assert.deepEqual(out.unpriced, ["acme/nobody-priced-this"]);
});

test("a run of such turns leaves the child total unchanged, not nulled", () => {
  // The watcher's exact loop (supervisor-watch.mjs): addCost over each result.
  let costUsd = 0;
  const unpricedModels = [];
  for (const event of FIXTURE.events) {
    const cost = costFromResult(event, INIT_MODEL, priceOne);
    costUsd = addCost(costUsd, cost.computed);
    for (const m of cost.unpriced) if (!unpricedModels.includes(m)) unpricedModels.push(m);
  }
  const expected = FIXTURE.events
    .filter(anyTokens)
    .reduce((sum, e) => sum + costFromResult(e, INIT_MODEL, priceOne).computed, 0);
  assert.ok(costUsd > 0, "the priced turns survive the zero-token ones");
  assert.equal(costUsd, expected, "zero-token turns add nothing and null nothing");
  assert.deepEqual(unpricedModels, []);
});

// ── (g) turn 2: the two shapes the four above do not cover.
//
// One guards each side of the rule. `zero-tokens-one-zero-key` is the shape that
// must stay a KNOWN $0 — a model on record that spent nothing. Its sibling
// `zero-usage-real-model-tokens` is the shape that must NOT become $0: the
// top-level usage is all zeros while the per-model entries spent real tokens, so
// a `sawTokens` read off `usage` instead of the entries silently discards the
// cost. Both are the (g) fix's own near-misses, and neither existed before.

test("an all-zero single-key modelUsage is the known $0, not unknown", () => {
  const e = byName["zero-tokens-one-zero-key"];
  assert.equal(Object.keys(e.modelUsage).length, 1, "muKeys=1 is the shape under test — {} is already covered");
  const out = costFromResult(e, INIT_MODEL, priceOne);
  assert.equal(out.computed, 0, "a recorded model that spent nothing still spent nothing");
  assert.deepEqual(out.unpriced, []);
});

test("zero top-level usage with real per-model tokens prices the tokens, not $0", () => {
  const e = byName["zero-usage-real-model-tokens"];
  assert.equal(spentTokens(e), 0, "the top-level usage really is all zeros — that is the trap");
  const out = costFromResult(e, null, priceOne);
  // Tolerance, not equality, for two reasons: the expected value is derived
  // from the same snapshot row the runtime prices through (a price sync moves
  // both sides together), and at this magnitude the product differs from the
  // exact decimal in the last binary digits. The claim under test is the ORDER
  // of magnitude — a real cost, not $0.
  assert.equal(Object.keys(e.modelUsage).length, 1, "single-key shape is the premise of the derived expected value");
  const [model, mu] = Object.entries(e.modelUsage)[0];
  const r = requirePrice(model, "input", "output");
  const expected = ((mu.inputTokens ?? 0) / 1e6) * r.input + ((mu.outputTokens ?? 0) / 1e6) * r.output;
  assert.ok(expected > 0, "precondition: the fixture's per-model tokens must price above zero");
  assert.ok(Math.abs(out.computed - expected) < 1e-12, `sawTokens must come from the per-model entries, got ${out.computed} (expected ~${expected})`);
  assert.deepEqual(out.unpriced, []);
  // And through the watcher's accumulator it is a real, non-zero contribution.
  assert.equal(addCost(0, out.computed), out.computed);
  assert.ok(addCost(0, out.computed) > 0, "an accumulator must not fold it into $0");
});

test("the cap refusal names the child holding the unknown cost", () => {
  const runId = fixtureRun({ "dev-1": child({ costUsd: null, unpricedModels: ["acme/unknown"] }) });
  const r = spawnCli(runId, { LA_SUPERVISOR_MAX_COST_USD: "5" });
  assert.equal(r.status, 1);
  const err = parse(r).error;
  assert.match(err, /child dev-1 \(dev\): no price row for acme\/unknown/);
  assert.doesNotMatch(err, /no price row for dev\b/, "a squad is not a price row");
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
