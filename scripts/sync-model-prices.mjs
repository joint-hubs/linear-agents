#!/usr/bin/env node
/**
 * scripts/sync-model-prices.mjs — reconcile config/models.json against OpenRouter's
 * live price list (JOI-79).
 *
 * Why this exists rather than a one-off edit: prices move. GLM-5.2 sat in config at
 * $1.4/$4.4 while OpenRouter served it at roughly half that, so every cost number in
 * the dashboard was inflated for as long as nobody re-checked by hand. The same will
 * happen again the next time a promo lands or lapses.
 *
 * It also fills in `cacheRead`, which config never carried. Without it
 * telemetry-store falls back to `input * 0.1` — and that guess is wrong for almost
 * every model we run: GLM bills cache reads at 0.186x input, MiniMax at 0.200x,
 * DeepSeek V4 Pro at 0.008x. Cache reads are ~87% of a lead's token volume, so the
 * guess is not a rounding error.
 *
 * Usage:
 *   node scripts/sync-model-prices.mjs            # report drift, change nothing
 *   node scripts/sync-model-prices.mjs --write    # apply live prices to config
 *   node scripts/sync-model-prices.mjs --json     # machine-readable drift report
 *
 * Exit codes: 0 = in sync (or written), 1 = drift found (report mode), 2 = fetch failed.
 * The non-zero-on-drift behaviour is what makes it usable as a CI check.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config", "models.json");
const ENDPOINT = "https://openrouter.ai/api/v1/models";
const PER_M = 1_000_000;
const TOLERANCE = 0.02; // 2% — ignores float noise, catches every real change

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const AS_JSON = args.includes("--json");

/** Fetch the public model list. No API key needed — pricing is public. */
async function fetchLive() {
  const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`OpenRouter responded ${res.status}`);
  const body = await res.json();
  const map = new Map();
  for (const m of body.data || []) {
    const p = m.pricing || {};
    // Round on the way in: 0.0000006902 * 1e6 lands on 0.6901999999999999 in binary
    // float, and that noise would be written straight into config. Six significant
    // digits is finer than any price we have ever been quoted.
    const num = (v) => {
      if (v == null || v === "") return null;
      const n = Number(v) * PER_M;
      return Number.isFinite(n) ? Number(n.toPrecision(6)) : null;
    };
    map.set(m.id, {
      input: num(p.prompt),
      output: num(p.completion),
      cacheRead: num(p.input_cache_read),
      cacheWrite: num(p.input_cache_write),
    });
  }
  return map;
}

const off = (a, b) => a == null || b == null ? false : Math.abs(a - b) / (b || 1) > TOLERANCE;

function compare(configured, live) {
  const rows = [];
  for (const [key, cur] of Object.entries(configured)) {
    if (!cur || typeof cur !== "object") continue;
    const real = live.get(key);
    if (!real) { rows.push({ key, status: "not-on-openrouter", cur }); continue; }

    const issues = [];
    if (off(cur.input, real.input)) issues.push("input");
    if (off(cur.output, real.output)) issues.push("output");
    // cacheRead absent means telemetry-store silently guesses input*0.1.
    if (real.cacheRead != null && cur.cacheRead == null) issues.push("cacheRead-missing");
    else if (off(cur.cacheRead, real.cacheRead)) issues.push("cacheRead");

    rows.push({ key, status: issues.length ? "drift" : "ok", issues, cur, real });
  }
  return rows;
}

function applyTo(raw, rows) {
  // Point-edit each price line instead of re-serialising the file: models.json keeps
  // `routing` as compact one-liners that a JSON.stringify round-trip would explode
  // into ~100 lines of noise (the reformatting problem noted in the pricing UI).
  let out = raw, applied = 0;
  for (const r of rows) {
    if (r.status !== "drift") continue;
    const esc = r.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = new RegExp(`("${esc}"\\s*:\\s*)\\{[^}]*\\}`);
    if (!line.test(out)) { console.error(`  ! nie znalazłem wpisu dla ${r.key} — pomijam`); continue; }
    const parts = [`"input": ${r.real.input}`, `"output": ${r.real.output}`];
    if (r.real.cacheRead != null) parts.push(`"cacheRead": ${r.real.cacheRead}`);
    if (r.real.cacheWrite != null) parts.push(`"cacheWrite": ${r.real.cacheWrite}`);
    out = out.replace(line, `$1{ ${parts.join(", ")} }`);
    applied++;
  }
  return { out, applied };
}

function report(rows) {
  const drift = rows.filter(r => r.status === "drift");
  const missing = rows.filter(r => r.status === "not-on-openrouter");
  const pad = (s, n) => String(s).padEnd(n);

  console.log(`\n  ${pad("model", 36)} ${pad("pole", 18)} ${pad("config", 10)} ${pad("OpenRouter", 10)} różnica`);
  console.log("  " + "─".repeat(88));
  for (const r of drift) {
    for (const f of r.issues) {
      const field = f === "cacheRead-missing" ? "cacheRead" : f;
      const c = f === "cacheRead-missing" ? `(brak → ${(r.cur.input * 0.1).toFixed(4)} zgadywane)` : r.cur[field];
      const v = r.real[field];
      const ratio = (typeof c === "number" && v) ? `${(c / v).toFixed(2)}×` : "—";
      console.log(`  ${pad(r.key, 36)} ${pad(field, 18)} ${pad(typeof c === "number" ? c.toFixed(4) : c, 10)} ${pad(v?.toFixed(5) ?? "—", 10)} ${ratio}`);
    }
  }
  if (!drift.length) console.log("  (brak rozjazdów)");
  if (missing.length) {
    console.log(`\n  Nie ma ich na OpenRouterze (nie da się zweryfikować):`);
    for (const r of missing) console.log(`    ${r.key}`);
  }
  console.log(`\n  ${rows.length} wpisów · ${drift.length} z rozjazdem · ${missing.length} nieweryfikowalnych\n`);
  return drift.length;
}

async function main() {
  let live;
  try {
    live = await fetchLive();
  } catch (err) {
    console.error(`[sync-model-prices] nie udało się pobrać cennika: ${err.message}`);
    process.exit(2);
  }

  const raw = await readFile(CONFIG, "utf8");
  const rows = compare(JSON.parse(raw).pricing || {}, live);

  if (AS_JSON) {
    console.log(JSON.stringify({ checked: rows.length, rows }, null, 2));
    process.exit(rows.some(r => r.status === "drift") ? 1 : 0);
  }

  const driftCount = report(rows);

  if (WRITE) {
    const { out, applied } = applyTo(raw, rows);
    JSON.parse(out); // never write a file we just broke
    await writeFile(CONFIG, out, "utf8");
    console.log(`  zapisano ${applied} wpisów do config/models.json`);
    console.log(`  UWAGA: historyczne koszty policzono starym cennikiem — przelicz je, żeby dashboard się zgadzał.\n`);
    process.exit(0);
  }

  if (driftCount) console.log("  uruchom z --write, żeby zastosować\n");
  process.exit(driftCount ? 1 : 0);
}

main();
