#!/usr/bin/env node
// W2+ augment — paraphrase the review-text INPUT of every real training pair
// with glm-5.3 (via OpenRouter), keeping the gold output untouched.
//
// Why glm-5.3 (NOT -flash): flash has mandatory reasoning that consumes
// max_tokens on long review bodies (>4k) → finish=length → null content.
// glm-5.3 has minimal reasoning, works on long inputs.
//
// Why paraphrase-only: the §5 bar evaluates on REAL held-out supervisor text.
// Synthetic inputs in a foreign style would drift from that distribution.
// Paraphrasing preserves the supervisor's style and facts while adding lexical
// diversity — and the gold output (the part the model must learn) is never
// touched, so the enum signal stays correct by construction.
//
// Reads:  ft/verdict-parse/data/train.jsonl  (140 real pairs)
// Writes: ft/verdict-parse/data/train-aug.jsonl  (140 original + N×2 paraphrases)
// Eval split (eval.jsonl) is NOT touched — held-out stays real.
//
// Usage:
//   node ft/verdict-parse/augment-paraphrase.mjs [--factor 2] [--concurrency 8]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'C:/Users/mateu/Documents/GitHub/linear-agents';
const DATA = path.join(ROOT, 'ft/verdict-parse/data');
const OUT = path.join(DATA, 'train-aug.jsonl');
const MODEL = 'z-ai/glm-5.3';
const FACTOR = parseInt(process.argv[process.argv.indexOf('--factor') + 1] || '2', 10);
const CONCURRENCY = parseInt(process.argv[process.argv.indexOf('--concurrency') + 1] || '3', 10);

// ---------- load OPENROUTER_API_KEY from .env ----------
const envFile = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const OR_KEY = (envFile.match(/^OPENROUTER_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!OR_KEY) { console.error('OPENROUTER_API_KEY not found in .env'); process.exit(2); }

// ---------- read real train pairs ----------
const real = (fs.readFileSync(path.join(DATA, 'train.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx > -1 ? parseInt(process.argv[limitIdx + 1], 10) : 0;
const pairs = limit ? real.slice(0, limit) : real;
console.error(`[aug] ${pairs.length} pairs (of ${real.length} real), factor=${FACTOR} → ${pairs.length * (1 + FACTOR)} target`);

// ---------- split input into diff-stats prefix + review body ----------
const splitInput = (input) => {
  const nl = input.indexOf('\n');
  if (nl === -1) return { prefix: '', body: input };
  const first = input.slice(0, nl);
  if (first.startsWith('diff-stats:')) return { prefix: first + '\n', body: input.slice(nl + 1) };
  return { prefix: '', body: input };
};

const PARAPHRASE_PROMPT = (body, variant) => [
  { role: 'system', content:
    'You paraphrase a code review\'s final status text. Rewrite it with different wording and sentence structure. ' +
    'PRESERVE EXACTLY, character-for-character: all file paths, line numbers, test names, function names, ' +
    'AC identifiers (AC1, AC2…), commands, code snippets, numbers, and the review\'s overall meaning and ' +
    'verdict implication. Do NOT add findings, drop findings, or change severity implications. ' +
    'Keep it a status text, not a chat. Output ONLY the paraphrased text, no preamble, no quotes.' +
    (variant === 2 ? ' Use slightly more concise phrasing this time.' : '') },
  { role: 'user', content: body },
];

async function callGLM(messages, retries = 5) {
  const body = JSON.stringify({ model: MODEL, messages, temperature: 0.7, max_tokens: 4096 });
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
        body,
      });
      if (!r.ok) {
        const t = await r.text();
        // rate-limit / server error → backoff and retry
        if (r.status === 429 || r.status >= 500) { await new Promise((x) => setTimeout(x, 3000 * attempt)); continue; }
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      const j = await r.json();
      const out = j.choices?.[0]?.message?.content;
      // null content with stop = provider refusal/empty → retry with backoff
      if (!out || !out.trim()) {
        throw new Error('empty content (finish=' + (j.choices?.[0]?.finish_reason) + ')');
      }
      return out.trim();
    } catch (e) {
      if (attempt === retries) { console.error(`[aug] callGLM fail (attempt ${attempt}): ${String(e.message).slice(0, 160)}`); return null; }
      await new Promise((x) => setTimeout(x, 2000 * attempt));
    }
  }
  return null;
}

// ---------- paraphrase one pair (factor variants) ----------
async function paraphrasePair(pair, idx) {
  const { prefix, body } = splitInput(pair.input);
  const results = [];
  for (let v = 1; v <= FACTOR; v++) {
    const para = await callGLM(PARAPHRASE_PROMPT(body, v));
    if (para && para.length > 40 && para !== body) {
      results.push({ ...pair, input: prefix + para, _src: `${pair._src}-para${v}`, _aug: true });
    } else {
      results.push(null);
    }
  }
  if (idx % 10 === 0) console.error(`[aug] ${idx}/${real.length} done`);
  return results;
}

// ---------- run with bounded concurrency ----------
const run = async () => {
  const out = [...pairs.map((r) => ({ ...r, _aug: false }))];
  let done = 0, fails = 0;
  const queue = pairs.map((p, i) => ({ p, i }));
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const { p, i } = queue.shift();
      const paras = await paraphrasePair(p, i);
      for (const para of paras) { if (para) out.push(para); else fails++; }
      done++;
      if (done % 20 === 0) console.error(`[aug] progress ${done}/${pairs.length} pairs (fails=${fails})`);
    }
  });
  await Promise.all(workers);
  console.error(`[aug] done: ${done} pairs, ${fails} failed paraphrases`);

  // sort: originals first by src, then paraphrases by src
  out.sort((a, b) => (a._aug || false) === (b._aug || false) ? (a._src < b._src ? -1 : 1) : (a._aug ? 1 : -1));
  const augCount = out.filter((r) => r._aug).length;
  fs.writeFileSync(OUT, out.map((r) => JSON.stringify({
    input: r.input, output: r.output, _src: r._src, _verdict: r._verdict, _aug: !!r._aug,
  })).join('\n') + '\n');
  console.error(`[aug] wrote ${out.length} pairs (${real.length} original + ${augCount} paraphrase) → ${OUT}`);
  const totalChars = out.reduce((a, r) => a + r.input.length, 0);
  console.error(`[aug] input chars total: ${totalChars} (orig real was ${real.reduce((a, r) => a + r.input.length, 0)})`);
};
run().catch((e) => { console.error('[aug] FATAL', e); process.exit(1); });
