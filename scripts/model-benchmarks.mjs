// AA intelligence index per model (FOC-786 companion to the Settings routing
// table). Backed by config/model-benchmarks.json, a recorded snapshot derived
// from the same payload docs/ui/refresh-model-data.py embeds in
// model-explorer.html — deliberately not live and never guessed:
//
//   benchmarkFor("z-ai/glm-5.3-flash")            -> 57.5
//   benchmarkFor("no-such/model")                 -> null
//   benchmarkFor("x", "anthropic")                -> null (openrouter only)
//
// The score is the default-effort variant's AA intelligence index; when the
// model has no default-effort variant, the first scored variant (the order
// refresh-model-data.py sorts its variants into) stands in. Everything absent
// or malformed — missing file, broken JSON, bad shape — reads as null, never
// a throw and never an invented number. Reads the file per call (small,
// ~15 KB); the settings routes call it a handful of times per request.

import { readFileSync } from 'node:fs';

// config/ is a sibling of scripts/, wherever the checkout lives.
const DEFAULT_PATH = new URL('../config/model-benchmarks.json', import.meta.url);

export function benchmarkFor(modelId, provider = 'openrouter', opts = {}) {
  if (provider !== 'openrouter') return null; // scores were recorded for OpenRouter ids
  if (typeof modelId !== 'string' || !modelId) return null;

  let data;
  try {
    data = JSON.parse(readFileSync(opts.path ?? DEFAULT_PATH, 'utf8'));
  } catch {
    return null; // missing or unparseable snapshot is unavailable, not an error
  }
  if (!data || typeof data !== 'object' || typeof data.snapshot !== 'string' || !data.snapshot) return null;
  if (!data.models || typeof data.models !== 'object' || Array.isArray(data.models)) return null;

  const entry = data.models[modelId];
  if (!Array.isArray(entry)) return null;

  const intel = (v) =>
    v && typeof v === 'object' && typeof v.intel === 'number' && Number.isFinite(v.intel) ? v.intel : null;

  const fromDefault = intel(entry.find((v) => v && v.e === 'default'));
  if (fromDefault !== null) return fromDefault;
  for (const v of entry) {
    const score = intel(v);
    if (score !== null) return score;
  }
  return null;
}
