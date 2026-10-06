#!/usr/bin/env node
/**
 * tools/precedent-spike/embed.mjs — F0 / T0.2: embed texts through the OpenRouter embeddings API.
 *
 * Fail-closed egress: every text is screened with scanEgress() (scripts/egress-screen.mjs) BEFORE it
 * is sent. A hit skips that item (recorded by id and shape only, never by value) — it is never sent.
 * The API key is read from the environment (.env via loadEnv) and never printed.
 *
 * Usage
 *   node tools/precedent-spike/embed.mjs --list                       # embedding models (id, price, context)
 *   node tools/precedent-spike/embed.mjs --model <id> --facet problem [--dims 1024] [--prefix "..."] [--tag instr]
 *        [--input .spike-precedent/texts.jsonl] [--out-dir .spike-precedent/vec] [--batch 16] [--max-chars 8000]
 * Input  JSONL {id, facet, text}. Output <out-dir>/<model>__<facet>__<dims|native>[__tag].{f32,json}
 *        (float32 row-major matrix + metadata: ids, skipped, tokens, cost, latency).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../../scripts/linear-client.mjs";
import { sanitize } from "./egress.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const BASE = "https://openrouter.ai/api/v1";

function arg(name, dflt = undefined) {
  const i = process.argv.indexOf(name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, body, key, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      if (res.ok) return { json: JSON.parse(text), ms: Date.now() - t0 };
      last = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      last.status = res.status;
      if (res.status !== 429 && res.status < 500) throw last;
    } catch (e) {
      last = e;
      if (e.status && e.status !== 429 && e.status < 500) throw e;
    }
    await sleep(1500 * 2 ** i);
  }
  throw last;
}

async function listModels(key) {
  const { json } = await http("GET", "/models?output_modalities=embeddings", null, key);
  const rows = (json.data ?? []).map((m) => ({
    id: m.id,
    usd_per_1m: m.pricing?.prompt != null ? Number(m.pricing.prompt) * 1e6 : null,
    context: m.context_length ?? m.top_provider?.context_length ?? null,
    name: m.name,
  }));
  rows.sort((a, b) => a.id.localeCompare(b.id));
  for (const r of rows) process.stdout.write(JSON.stringify(r) + "\n");
}

function slug(s) {
  return String(s).replace(/[^A-Za-z0-9.-]+/g, "_");
}

async function main() {
  loadEnv();
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set (check .env)");
  if (arg("--list")) return listModels(key);

  const model = arg("--model");
  const facet = arg("--facet", "problem");
  const dims = arg("--dims") ? Number(arg("--dims")) : null;
  const prefix = typeof arg("--prefix") === "string" ? arg("--prefix").replace(/\\n/g, "\n") : "";
  const tag = typeof arg("--tag") === "string" ? arg("--tag") : "";
  const input = resolve(arg("--input", join(root, ".spike-precedent", "texts.jsonl")));
  const outDir = resolve(arg("--out-dir", join(root, ".spike-precedent", "vec")));
  const batchN = Number(arg("--batch", 16));
  const maxChars = Number(arg("--max-chars", 8000));
  if (!model || model === true) throw new Error("--model <id> required");

  const rows = readFileSync(input, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.facet === facet);
  const items = [];
  const skipped = [];
  let maskedItems = 0, maskedTokens = 0;
  for (const r of rows) {
    const raw = prefix + String(r.text ?? "").slice(0, maxChars);
    if (!raw.trim()) continue;
    const s = sanitize(raw);
    if (s.blocked) {
      skipped.push({ id: r.id, hits: s.blocked });
      continue; // fail-closed: never sent
    }
    if (s.masked) { maskedItems++; maskedTokens += s.masked; }
    items.push({ id: r.id, text: s.text });
  }
  if (arg("--dry-run")) {
    const fam = {};
    for (const s of skipped) for (const h of s.hits) fam[h.family] = (fam[h.family] ?? 0) + 1;
    process.stdout.write(JSON.stringify({ dry_run: true, facet, items: items.length, skipped: skipped.length, skipped_families: fam, masked_items: maskedItems, masked_tokens: maskedTokens }) + "\n");
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const name = [slug(model), facet, dims ?? "native", tag].filter(Boolean).join("__");
  const digest = createHash("sha256").update(JSON.stringify([model, dims, prefix, items.map((i) => [i.id, i.text])])).digest("hex");
  const metaPath = join(outDir, `${name}.json`);
  if (existsSync(metaPath)) {
    try {
      if (JSON.parse(readFileSync(metaPath, "utf8")).digest === digest) {
        process.stdout.write(JSON.stringify({ name, cached: true, n: items.length }) + "\n");
        return;
      }
    } catch { /* recompute */ }
  }

  const vecs = [];
  let tokens = 0, cost = 0, costKnown = true, respModel = null, provider = null;
  const lat = [];
  const t0 = Date.now();
  for (let i = 0; i < items.length;) {
    const batch = [];
    let chars = 0;
    while (i < items.length && batch.length < batchN && (batch.length === 0 || chars + items[i].text.length <= 48_000)) {
      chars += items[i].text.length;
      batch.push(items[i++]);
    }
    const body = { model, input: batch.map((b) => b.text), encoding_format: "float" };
    if (dims) body.dimensions = dims;
    const { json, ms } = await http("POST", "/embeddings", body, key);
    lat.push(ms);
    const data = [...json.data].sort((a, b) => a.index - b.index);
    if (data.length !== batch.length) throw new Error(`embedding count mismatch: ${data.length} vs ${batch.length}`);
    for (const d of data) vecs.push(Float32Array.from(d.embedding));
    tokens += json.usage?.total_tokens ?? json.usage?.prompt_tokens ?? 0;
    if (typeof json.usage?.cost === "number") cost += json.usage.cost; else costKnown = false;
    respModel = json.model ?? respModel;
    provider = json.provider ?? provider;
  }
  const d = vecs[0]?.length ?? 0;
  if (vecs.some((v) => v.length !== d)) throw new Error("inconsistent embedding dimensions");
  const buf = Buffer.alloc(vecs.length * d * 4);
  vecs.forEach((v, r) => Buffer.from(v.buffer).copy(buf, r * d * 4));
  writeFileSync(join(outDir, `${name}.f32`), buf);
  lat.sort((a, b) => a - b);
  const meta = {
    name, model, resp_model: respModel, provider, facet, dims_requested: dims, dims: d, n: vecs.length,
    ids: items.map((x) => x.id), skipped, masked_items: maskedItems, masked_tokens: maskedTokens,
    prefix_chars: prefix.length, tokens, cost_usd: costKnown ? cost : null,
    batches: lat.length, latency_ms: { median: lat[Math.floor(lat.length / 2)] ?? null, max: lat[lat.length - 1] ?? null, total: Date.now() - t0 },
    digest, created: new Date().toISOString(),
  };
  writeFileSync(metaPath, JSON.stringify(meta));
  process.stdout.write(JSON.stringify({ name, n: meta.n, dims: d, tokens, cost_usd: meta.cost_usd, skipped: skipped.length, masked_items: maskedItems, ms: meta.latency_ms.total }) + "\n");
}

main().catch((e) => {
  process.stderr.write(`embed failed: ${e?.message ?? e}\n`);
  process.exit(1);
});
