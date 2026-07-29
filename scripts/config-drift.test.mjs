// scripts/config-drift.test.mjs — does the configuration still describe reality?
//
// Every check here exists because the drift it catches actually happened, silently,
// and cost hours to find by hand on 2026-07-27/28:
//
//   · four squad leads pointed at docs/agent-N-*.md; the real path is docs/agents/
//   · the review kickoff named "DeepSeek Pro / Kimi / GLM-5.2" while the passes'
//     models live in agents/review/agents/*.md — editing one left the other stale
//   · the plan kickoff hardcoded "team FEN" although _lib.bat honours LINEAR_TEAM_KEY
//   · no squad had Bash(node:*) allowed, yet every CLAUDE.md mandates
//     `node $LA_ROOT/scripts/linear-query.mjs` as the ONLY way to reach Linear
//   · config/models.json carried $1.4/$4.4 for GLM-5.2 while OpenRouter served it
//     at half that, and no model had a cacheRead price at all — so the store fell
//     back to input*0.1, a guess that is 12x too high for DeepSeek V4 Pro and 2x
//     too low for MiniMax
//   · Claude Haiku 4.5 ran for 6M tokens with no price, which is why /api/summary
//     returned costUSD: null instead of a number
//
// The class is always the same: config asserts something the repo no longer backs
// up, nothing fails, and the lie surfaces days later as a wrong number or a wasted
// turn. These are cheap file reads — no network, no API keys, safe in CI.
//
// Run: node scripts/config-drift.test.mjs

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SQUADS = ["plan", "dev", "review", "test", "cadence"];

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
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

// ── 1. Every file a prompt points at must exist ────────────────────────────────
console.log("\nlinki w promptach");

// Command examples carry template paths the reader is meant to fill in, e.g.
// `docs/adr/NNN-slug.md` where N is the ADR number. Those are placeholders, not
// links, and flagging them would train everyone to ignore this check.
const PLACEHOLDER = /NNN|<|>|\{|\*|\bslug\b/;

test("każdy plik wskazany w agents/*/CLAUDE.md istnieje", () => {
  const dead = [];
  for (const squad of SQUADS) {
    const rel = `agents/${squad}/CLAUDE.md`;
    for (const m of read(rel).matchAll(/`(docs\/[A-Za-z0-9._\/-]+\.md)`/g)) {
      if (PLACEHOLDER.test(m[1])) continue;
      if (!existsSync(join(ROOT, m[1]))) dead.push(`${rel} → ${m[1]}`);
    }
  }
  if (dead.length) fail(`martwe odnośniki:\n       ${dead.join("\n       ")}`);
});

// ── 2. Kickoffs must not restate what they do not own ─────────────────────────
console.log("\nkickoffy nie duplikują konfiguracji");

test("kickoff nie zaszywa nazwy modelu ani klucza teamu", () => {
  const kickoff = readJson("config/prompts.json").kickoff || {};
  const banned = [
    [/\b(DeepSeek|Kimi|MiniMax|GLM-|Opus|Sonnet|Haiku|Grok|Qwen)\b/i, "nazwa modelu (żyje w agents/<squad>/agents/*.md + config/models.json)"],
    [/\bteam\s+(FEN|JOI|PISI|FOC)\b/i, "klucz teamu (pochodzi z LINEAR_TEAM_KEY)"],
  ];
  const bad = [];
  for (const [squad, lines] of Object.entries(kickoff)) {
    if (!Array.isArray(lines)) continue;
    const text = lines.join(" ");
    for (const [re, what] of banned) if (re.test(text)) bad.push(`${squad}: ${what}`);
  }
  if (bad.length) fail(`kickoff powtarza cudze dane:\n       ${bad.join("\n       ")}`);
});

test("wbudowany fallback w launch.mjs też nie zaszywa modeli", () => {
  // The fallback is what runs when config/prompts.json is missing or broken, so a
  // clean JSON file is not enough on its own — the stale copy lived here.
  const src = read("scripts/launch.mjs");
  const block = src.slice(src.indexOf("DEFAULT_KICKOFF_TEMPLATES"), src.indexOf("_loadKickoffFromFile"));
  if (/'[^']*\b(DeepSeek|Kimi|MiniMax|GLM-5|Opus|Sonnet)\b[^']*'/.test(block)) {
    fail("DEFAULT_KICKOFF_TEMPLATES nadal wymienia model z nazwy");
  }
});

// ── 3. Mandated commands must actually be permitted ───────────────────────────
console.log("\nuprawnienia zgadzają się z instrukcjami");

test("komendy nakazane w CLAUDE.md są w allow-liście składu", () => {
  const missing = [];
  for (const squad of SQUADS) {
    const doc = read(`agents/${squad}/CLAUDE.md`);
    const allow = (readJson(`agents/${squad}/settings.json`).permissions?.allow) || [];
    const allows = (bin) => allow.some((rule) => rule === `Bash(${bin}:*)` || rule.startsWith(`Bash(${bin} `));
    // The leads are told to reach Linear only through node scripts; without the
    // grant every one of those calls raises a permission prompt mid-run.
    if (/node \$LA_ROOT\/scripts\//.test(doc) && !allows("node")) {
      missing.push(`${squad}: CLAUDE.md wymaga \`node $LA_ROOT/scripts/...\`, brak Bash(node:*)`);
    }
  }
  if (missing.length) fail(`instrukcja bez uprawnienia:\n       ${missing.join("\n       ")}`);
});

test("żaden skład nie ma jednocześnie allow i deny na to samo", () => {
  const conflicts = [];
  for (const squad of SQUADS) {
    const p = readJson(`agents/${squad}/settings.json`).permissions || {};
    for (const rule of p.allow || []) {
      if ((p.deny || []).includes(rule)) conflicts.push(`${squad}: ${rule}`);
    }
  }
  if (conflicts.length) fail(`reguła w allow i deny naraz:\n       ${conflicts.join("\n       ")}`);
});

// ── 4. Model routing must be internally consistent ────────────────────────────
console.log("\nmodele i cennik");

test("każdy model użyty przez rolę ma cenę w models.json", () => {
  const prices = readJson("config/models.json").pricing || {};
  const keys = Object.keys(prices);
  // Mirrors resolvePrice in telemetry-store: exact id, else last path segment with
  // dots normalised. A role model that resolves to nothing is billed at zero.
  const shortOf = (s) => s.split("/").pop().replace(/\./g, "-");
  const resolves = (model) =>
    prices[model] != null || keys.some((k) => shortOf(k) === shortOf(model));

  const unpriced = [];
  for (const squad of SQUADS) {
    const dir = join(ROOT, "agents", squad, "agents");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const m = read(`agents/${squad}/agents/${file}`).match(/^model:\s*(\S+)/m);
      if (m && !resolves(m[1])) unpriced.push(`${squad}/${file.replace(/\.md$/, "")} → ${m[1]}`);
    }
  }
  if (unpriced.length) fail(`rola z modelem bez ceny:\n       ${unpriced.join("\n       ")}`);
});

test("model leada z bin/<squad>.bat ma cenę", () => {
  const prices = readJson("config/models.json").pricing || {};
  const keys = Object.keys(prices);
  const shortOf = (s) => s.split("/").pop().replace(/\./g, "-");
  const bad = [];
  for (const squad of SQUADS) {
    const bat = `bin/${squad}.bat`;
    if (!existsSync(join(ROOT, bat))) continue;
    for (const m of read(bat).matchAll(/set "ANTHROPIC_MODEL=([^"]+)"/g)) {
      const model = m[1].trim();
      if (!model || model.includes("%")) continue; // env indirection, not a literal
      if (prices[model] == null && !keys.some((k) => shortOf(k) === shortOf(model))) {
        bad.push(`${bat} → ${model}`);
      }
    }
  }
  if (bad.length) fail(`lead bez ceny (koszt policzy się jako 0):\n       ${bad.join("\n       ")}`);
});

test("każda cena ma cacheRead — bez tego store zgaduje input*0.1", () => {
  // The guess is wrong in both directions: 12x too high for DeepSeek V4 Pro,
  // 2x too low for MiniMax. Cache reads are ~87% of a lead's token volume.
  const prices = readJson("config/models.json").pricing || {};
  const missing = Object.entries(prices)
    .filter(([, v]) => v && typeof v === "object" && v.cacheRead == null)
    .map(([k]) => k);
  if (missing.length) fail(`brak cacheRead (zgadywane):\n       ${missing.join("\n       ")}`);
});

test("cennik ma sensowne wartości", () => {
  const prices = readJson("config/models.json").pricing || {};
  const bad = [];
  for (const [k, v] of Object.entries(prices)) {
    if (!v || typeof v !== "object") continue;
    for (const f of ["input", "output"]) {
      if (!Number.isFinite(v[f]) || v[f] < 0) bad.push(`${k}.${f} = ${v[f]}`);
    }
    if (Number.isFinite(v.cacheRead) && v.cacheRead > v.input) {
      bad.push(`${k}: cacheRead (${v.cacheRead}) > input (${v.input})`);
    }
  }
  if (bad.length) fail(`podejrzane ceny:\n       ${bad.join("\n       ")}`);
});

// ── 5. The loop must have one owner ───────────────────────────────────────────
console.log("\njedno źródło prawdy dla pętli");

test("agents/dev/CLAUDE.md deklaruje się jedynym opisem pętli", () => {
  // DEV briefly had three: 6 steps in the kickoff, 7 here, 8 in FENIX_WORKFLOW §5.
  const doc = read("agents/dev/CLAUDE.md");
  if (!/jedynym obowiązującym opisem pętli/i.test(doc)) {
    fail("brak zdania o pierwszeństwie — bez niego kickoff i FENIX_WORKFLOW znów zaczną konkurować");
  }
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  console.log("\nKażdy z tych błędów jest cichy w czasie działania — dlatego ten plik istnieje.");
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
