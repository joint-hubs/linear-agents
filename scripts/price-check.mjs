// scripts/price-check.mjs — do the committed prices still match what OpenRouter charges?
//
//   node scripts/price-check.mjs [--json] [--tolerance 0.02]
//
// NOT a unit test, on purpose. scripts/config-drift.test.mjs is documented as
// offline and CI-safe; this one hits the network, so it lives beside it rather
// than inside it. Run it when prices feel wrong, or on a cadence.
//
// Why it exists: a stale price is silent. `deepseek/deepseek-v4-pro` sat ~10%
// under the real rate with 8.9M input and 53.5M cache-read tokens already
// spent against it, and nothing anywhere would ever have said so (FOC-165).
//
// What it does NOT do: invent prices. A model absent from the live catalogue is
// reported as unknown, not as an error — pinned dated snapshots
// (`anthropic/claude-4.8-opus-20260528`) legitimately outlive their listing.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOGUE = "https://openrouter.ai/api/v1/models";

// OpenRouter quotes per token; models.json quotes per million.
const perMillion = (v) => (v === undefined || v === null ? null : Number(v) * 1e6);

// Field names differ between the two sources. Left = ours, right = theirs.
const FIELDS = [
  ["input", "prompt"],
  ["output", "completion"],
  ["cacheRead", "input_cache_read"],
];

export function comparePrices(committed, live, tolerance = 0.02) {
  const drifted = [];
  const unlisted = [];

  for (const [model, ours] of Object.entries(committed)) {
    if (model.startsWith("_")) continue; // metadata, repo-wide convention
    const theirs = live[model];
    if (!theirs) {
      unlisted.push(model);
      continue;
    }
    const diffs = [];
    for (const [ourKey, theirKey] of FIELDS) {
      const a = ours[ourKey];
      const b = perMillion(theirs[theirKey]);
      if (b === null) continue; // they do not quote this field for this model
      // Absolute floor as well as the relative band: without it a $0 model can
      // never match, since any difference is infinitely relative.
      if (a === undefined || a === null || Math.abs(a - b) > Math.max(0.0001, b * tolerance)) {
        diffs.push({ field: ourKey, committed: a ?? null, live: Number(b.toFixed(6)) });
      }
    }
    if (diffs.length) drifted.push({ model, diffs });
  }

  return { drifted, unlisted };
}

async function main() {
  const args = process.argv.slice(2);
  const tolerance = Number(args[args.indexOf("--tolerance") + 1]) || 0.02;

  const config = JSON.parse(readFileSync(join(ROOT, "config", "models.json"), "utf8"));
  const committed = config.pricing?.openrouter ?? {};

  let live;
  try {
    const res = await fetch(CATALOGUE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    live = Object.fromEntries(body.data.map((m) => [m.id, m.pricing || {}]));
  } catch (err) {
    // A network failure is not price drift. Say which one happened.
    console.error(`could not reach ${CATALOGUE}: ${err.message}`);
    return 2;
  }

  const { drifted, unlisted } = comparePrices(committed, live, tolerance);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: drifted.length === 0, tolerance, drifted, unlisted }, null, 2));
    return drifted.length ? 1 : 0;
  }

  if (unlisted.length) {
    console.error(`not in the live catalogue (pinned snapshots are expected here):`);
    for (const m of unlisted) console.error(`  · ${m}`);
    console.error("");
  }

  if (!drifted.length) {
    console.error(`every listed price matches OpenRouter within ${tolerance * 100}%`);
    return 0;
  }

  console.error(`${drifted.length} price(s) disagree with OpenRouter:`);
  for (const { model, diffs } of drifted) {
    console.error(`  ${model}`);
    for (const d of diffs) console.error(`    ${d.field}: committed ${d.committed} → live ${d.live}`);
  }
  console.error("\nEvery token already spent on these was mis-costed. Update config/models.json.");
  return 1;
}

if (process.argv[1]?.endsWith("price-check.mjs")) process.exit(await main());
