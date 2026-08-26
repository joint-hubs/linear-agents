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
// `supervisor` joined on 2026-08-25 (FOC-124). It has no agents/supervisor/agents/
// roles — children are OS processes, not Task-tool subagents — so the model/price
// checks below skip it via their own existsSync guards, while the link, kickoff
// and permission checks apply to it exactly like any other squad.
const SQUADS = ["plan", "dev", "review", "test", "cadence", "supervisor"];

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

test("każda zmienna LA_* opisana w CLAUDE.md jest przez coś czytana", () => {
  // agents/supervisor/CLAUDE.md miał całą sekcję "Budget guardrail" opisującą
  // LA_SUPERVISOR_MAX_COST_USD — jego semantykę post-hoc, zachowanie przy
  // przekroczeniu, wiersz w tabeli trybów awarii. Żaden skrypt tej zmiennej nie
  // czytał. Lead był przekonany, że ma limit wydatków, którego nie miał
  // (FOC-165). To jest dokładnie klasa "config twierdzi coś, czego repo już nie
  // pokrywa", tyle że o zmiennych środowiskowych.
  const scripts = readdirSync(join(ROOT, "scripts"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => read(`scripts/${f}`))
    .join("\n");

  const orphaned = [];
  for (const squad of SQUADS) {
    const doc = read(`agents/${squad}/CLAUDE.md`);
    for (const m of doc.matchAll(/\b(LA_[A-Z0-9_]+)\b/g)) {
      if (!scripts.includes(m[1]) && !orphaned.some((o) => o.startsWith(m[1]))) {
        orphaned.push(`${m[1]} (obiecana w agents/${squad}/CLAUDE.md)`);
      }
    }
  }
  if (orphaned.length) {
    fail(`instrukcja obiecuje zmienną, której nikt nie czyta:\n       ${orphaned.join("\n       ")}`);
  }
});

console.log("\ntryb nadzorowany");

// The four squads run as children of the same Supervisor, so a rule that holds
// for one and not another is not a rule. The section is the contract between
// the lead and its children; it drifts the moment someone edits one file.
const SUPERVISED_SQUADS = ["plan", "dev", "review", "test"];
const supervisedBlock = (squad) => {
  const doc = read(`agents/${squad}/CLAUDE.md`).replace(/\r\n/g, "\n");
  const open = doc.indexOf("<supervised_mode>");
  const close = doc.indexOf("</supervised_mode>");
  if (open === -1 || close === -1) return null;
  return doc.slice(open, close);
};

test("każdy skład ma sekcję Supervised mode", () => {
  const missing = SUPERVISED_SQUADS.filter((s) => supervisedBlock(s) === null);
  if (missing.length) fail(`brak <supervised_mode> w: ${missing.join(", ")}`);
});

test("sekcja Supervised mode jest identyczna we wszystkich czterech składach", () => {
  // DEV carries one extra subsection (spec §1.6.1, the single resume path).
  // Everything BEFORE it must match the other three byte for byte.
  const shared = (squad) => {
    const b = supervisedBlock(squad);
    const extra = b.indexOf("### DEV only");
    return (extra === -1 ? b : b.slice(0, extra)).trimEnd();
  };
  const reference = shared("plan");
  const diverged = SUPERVISED_SQUADS.filter((s) => shared(s) !== reference);
  if (diverged.length) {
    fail(`rozjechana sekcja w: ${diverged.join(", ")} — edytuj wszystkie cztery naraz`);
  }
});

test("tylko DEV ma dodatek o pojedynczej ścieżce wznowienia", () => {
  // §1.6.1 is DEV-specific: only DEV had three resume mechanisms to collapse.
  const withExtra = SUPERVISED_SQUADS.filter((s) => supervisedBlock(s).includes("### DEV only"));
  if (withExtra.join(",") !== "dev") fail(`dodatek DEV-only jest w: ${withExtra.join(", ") || "(nigdzie)"}`);
});

test("każda reguła o needs:* / notify Mateusz ma odsyłacz do trybu nadzorowanego", () => {
  // Appending the section is not enough: a hard rule saying "never walk away"
  // contradicts it, and the lead would have to pick one. Every such rule carries
  // an explicit rider instead (FOC-125).
  const CONFLICTS = /needs:answer|needs:approval|notify Mateusz|walk away|stay synchronous/i;
  const orphaned = [];
  for (const squad of SUPERVISED_SQUADS) {
    const doc = read(`agents/${squad}/CLAUDE.md`).replace(/\r\n/g, "\n");
    // Paragraphs, not lines: a rider legitimately lands at the end of the
    // paragraph rather than on the line that trips the regex.
    const body = doc.slice(0, doc.indexOf("<supervised_mode>"));
    for (const para of body.split(/\n\s*\n/)) {
      if (CONFLICTS.test(para) && !/LA_SUPERVISOR/.test(para)) {
        orphaned.push(`${squad}: ${para.trim().split("\n")[0].slice(0, 90)}`);
      }
    }
  }
  if (orphaned.length) {
    fail(`reguła sprzeczna z trybem nadzorowanym, bez odsyłacza:\n       ${orphaned.join("\n       ")}`);
  }
});

console.log("\nMCP");

test("zaden settings.json nie deklaruje mcpServers", () => {
  // Claude Code NIE czyta `mcpServers` z settings.json — bierze je z
  // `.claude.json` (user) i `.mcp.json` (projekt). To repo trzymało tam martwy
  // `mcpServers.linear` w dwóch składach: plik wyglądał na skonfigurowany, a
  // `claude mcp list` pod CLAUDE_CONFIG_DIR składu odpowiadał
  // "No MCP servers configured". Config, który twierdzi coś, czego runtime nie
  // widzi — dokładnie po to jest ten plik.
  const bad = SQUADS.filter((s) => readJson(`agents/${s}/settings.json`).mcpServers);
  if (bad.length) {
    fail(`mcpServers w settings.json (ignorowane przez Claude Code): ${bad.join(", ")} — przenieś do .mcp.json`);
  }
});

test("kazdy serwer z .mcp.json jest dozwolony w allow-liscie skladow", () => {
  // Serwer podłączony, ale nieprzepuszczony przez uprawnienia, znaczy monit w
  // środku headlessowej tury — czyli dziecko, które wisi.
  const servers = Object.keys(readJson(".mcp.json").mcpServers || {});
  const missing = [];
  for (const squad of SQUADS) {
    const allow = readJson(`agents/${squad}/settings.json`).permissions?.allow || [];
    for (const name of servers) {
      const ok = allow.some((r) => r === `mcp__${name}__*` || r.startsWith(`mcp__${name}__`));
      if (!ok) missing.push(`${squad}: brak mcp__${name}__*`);
    }
  }
  if (missing.length) fail(`serwer bez uprawnienia:\n       ${missing.join("\n       ")}`);
});

// ── 4. Model routing must be internally consistent ────────────────────────────
console.log("\nmodele i cennik");

test("każdy model użyty przez rolę ma cenę w models.json", () => {
  // All current squads route through OpenRouter, so the price row must live under
  // pricing.openrouter. A model priced under another provider but missing here is
  // a real gap — store would bill it at zero.
  const openrouter = readJson("config/models.json").pricing?.openrouter || {};
  const keys = Object.keys(openrouter);
  // Mirrors resolvePrice in telemetry-store: exact id, else last path segment with
  // dots normalised. A role model that resolves to nothing is billed at zero.
  const shortOf = (s) => s.split("/").pop().replace(/\./g, "-");
  const resolves = (model) =>
    openrouter[model] != null || keys.some((k) => shortOf(k) === shortOf(model));

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
  // Leads invoke OpenRouter, so the row must live under pricing.openrouter.
  const openrouter = readJson("config/models.json").pricing?.openrouter || {};
  const keys = Object.keys(openrouter);
  const shortOf = (s) => s.split("/").pop().replace(/\./g, "-");
  const bad = [];
  for (const squad of SQUADS) {
    const bat = `bin/${squad}.bat`;
    if (!existsSync(join(ROOT, bat))) continue;
    for (const m of read(bat).matchAll(/set "ANTHROPIC_MODEL=([^"]+)"/g)) {
      const model = m[1].trim();
      if (!model || model.includes("%")) continue; // env indirection, not a literal
      if (openrouter[model] == null && !keys.some((k) => shortOf(k) === shortOf(model))) {
        bad.push(`${bat} → ${model}`);
      }
    }
  }
  if (bad.length) fail(`lead bez ceny (koszt policzy się jako 0):\n       ${bad.join("\n       ")}`);
});

test("każda cena ma cacheRead — bez tego store zgaduje input*0.1", () => {
  // The guess is wrong in both directions: 12x too high for DeepSeek V4 Pro,
  // 2x too low for MiniMax. Cache reads are ~87% of a lead's token volume.
  // Iterate every provider scope — a future provider's rows must satisfy this
  // too. `_`-prefixed keys inside a scope are metadata (repo-wide convention)
  // and must be skipped; price rows themselves carry input/output/cacheRead.
  const scopes = readJson("config/models.json").pricing || {};
  const missing = [];
  for (const [provider, rows] of Object.entries(scopes)) {
    if (!rows || typeof rows !== "object") continue;
    for (const [model, v] of Object.entries(rows)) {
      if (model.startsWith("_")) continue; // metadata, not a price row
      if (!v || typeof v !== "object") continue;
      if (!Number.isFinite(v.input) || !Number.isFinite(v.output)) continue;
      if (v.cacheRead == null || !Number.isFinite(v.cacheRead)) {
        missing.push(`${provider}/${model}`);
      }
    }
  }
  if (missing.length) fail(`brak cacheRead (zgadywane):\n       ${missing.join("\n       ")}`);
});

test("cennik ma sensowne wartości", () => {
  // Iterate every provider scope; `_`-prefixed keys inside a scope are metadata.
  const scopes = readJson("config/models.json").pricing || {};
  const bad = [];
  for (const [provider, rows] of Object.entries(scopes)) {
    if (!rows || typeof rows !== "object") continue;
    for (const [k, v] of Object.entries(rows)) {
      if (k.startsWith("_")) continue; // metadata, not a price row
      if (!v || typeof v !== "object") continue;
      for (const f of ["input", "output"]) {
        if (!Number.isFinite(v[f]) || v[f] < 0) bad.push(`${provider}/${k}.${f} = ${v[f]}`);
      }
      if (Number.isFinite(v.cacheRead) && Number.isFinite(v.input) && v.cacheRead > v.input) {
        bad.push(`${provider}/${k}: cacheRead (${v.cacheRead}) > input (${v.input})`);
      }
    }
  }
  if (bad.length) fail(`podejrzane ceny:\n       ${bad.join("\n       ")}`);
});

// ── 5. The loop must have one owner ───────────────────────────────────────────
console.log("\njedno źródło prawdy dla pętli");

test("agents/dev/CLAUDE.md deklaruje się jedynym opisem pętli", () => {
  // DEV briefly had three: 6 steps in the kickoff, 7 here, 8 in FENIX_WORKFLOW §5.
  const doc = read("agents/dev/CLAUDE.md");
  if (!/jedynym obowiązującym opisem pętli|single source of truth for the DEV loop/i.test(doc)) {
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
