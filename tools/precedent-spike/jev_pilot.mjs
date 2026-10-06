#!/usr/bin/env node
/**
 * tools/precedent-spike/jev_pilot.mjs - F0 / T0.6: run decision tasks through Jev (typesafe/jev-1.13,
 * OpenRouter alpha decisions endpoint), the same contract scripts/mcp/provider-jev.mjs uses.
 *
 * Input  JSONL {id, kind, state, questions:{qid:{type, instructions, criteria}}}
 * Output JSONL {id, kind, ok, ms, cost_usd, model, answers | error}
 * Every string that leaves the machine (state, instructions, criteria) passes the fail-closed sanitiser
 * (egress.mjs); a blocked task is recorded as {ok:false, error:"egress_blocked"} and never sent. Response
 * bodies are never echoed on failure (status only), like the production provider.
 *
 * Usage: node tools/precedent-spike/jev_pilot.mjs [--in <jsonl>] [--out <jsonl>] [--limit N] [--concurrency 3]
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../../scripts/linear-client.mjs";
import { sanitize } from "./egress.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.13";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanTask(t) {
  let masked = 0;
  const one = (s) => {
    const r = sanitize(String(s ?? ""));
    if (r.blocked) throw new Error("egress_blocked");
    masked += r.masked;
    return r.text;
  };
  const questions = {};
  for (const [qid, q] of Object.entries(t.questions)) {
    questions[qid] = {
      type: q.type,
      instructions: one(q.instructions),
      criteria: Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => [k, one(v)])),
    };
  }
  return { state: one(t.state), questions, masked };
}

async function call(key, body, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return { json: await res.json(), ms: Date.now() - t0 };
      last = new Error(`HTTP ${res.status}`); // status only, never the body
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

async function main() {
  loadEnv();
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set (check .env)");
  const inPath = resolve(arg("--in", join(root, ".spike-precedent", "jev_tasks.jsonl")));
  const outPath = resolve(arg("--out", join(root, ".spike-precedent", "jev_results.jsonl")));
  const limit = Number(arg("--limit", 0)) || Infinity;
  const conc = Number(arg("--concurrency", 3));
  const tasks = readFileSync(inPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(0, limit);
  writeFileSync(outPath, "");
  let next = 0, done = 0, okN = 0, cost = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      const t = tasks[i];
      let rec;
      try {
        const c = cleanTask(t);
        const { json, ms } = await call(key, { model: MODEL, state: c.state, questions: c.questions });
        const usd = typeof json.usage?.cost === "number" ? json.usage.cost : null;
        if (usd) cost += usd;
        rec = { id: t.id, kind: t.kind, ok: true, ms, cost_usd: usd, model: json.model ?? MODEL, masked: c.masked, answers: json.answers };
        okN++;
      } catch (e) {
        rec = { id: t.id, kind: t.kind, ok: false, error: String(e?.message ?? e).slice(0, 120) };
      }
      appendFileSync(outPath, JSON.stringify(rec) + "\n");
      if (++done % 10 === 0) process.stderr.write(`${done}/${tasks.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  process.stdout.write(JSON.stringify({ tasks: tasks.length, ok: okN, failed: tasks.length - okN, cost_usd: cost, out: outPath }) + "\n");
}

main().catch((e) => {
  process.stderr.write(`jev_pilot failed: ${e?.message ?? e}\n`);
  process.exit(1);
});
