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

import { readSettings } from "./fenix-settings.mjs";
import { childModelFor } from "./child-model.mjs";

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

// Generic subagents (`general-purpose`, `Explore`) have no role definition, so
// they inherit the SONNET tier — the same model Claude Code claims for its
// auto-mode permission classifier, tuned for terse allow/deny rather than work.
// Measured once at 48.8% tool errors across one such session. The instruction to
// pass an explicit `model: "haiku"` at spawn is the only thing standing between
// that tier and real work, and it lives in five prompts that drift apart the
// moment someone edits one.
const GENERIC_MODEL_SQUADS = ["plan", "dev", "review", "test", "cadence"];
const genericModelBlock = (squad) => {
  const doc = read(`agents/${squad}/CLAUDE.md`).replace(/\r\n/g, "\n");
  const open = doc.indexOf("**A generic subagent needs an explicit model.**");
  if (open === -1) return null;
  const close = doc.indexOf("explicit slug in their own frontmatter.", open);
  if (close === -1) return null;
  return doc.slice(open, close).trimEnd();
};

test("każdy skład mówi, jaki model dać generycznemu subagentowi", () => {
  const missing = GENERIC_MODEL_SQUADS.filter((s) => genericModelBlock(s) === null);
  if (missing.length) fail(`brak instrukcji o modelu generycznego subagenta w: ${missing.join(", ")}`);
});

test("instrukcja o generycznym subagencie jest identyczna we wszystkich składach", () => {
  const reference = genericModelBlock("plan");
  const diverged = GENERIC_MODEL_SQUADS.filter((s) => genericModelBlock(s) !== reference);
  if (diverged.length) fail(`rozjechana instrukcja w: ${diverged.join(", ")} — edytuj wszystkie naraz`);
});

test("alias z instrukcji faktycznie wskazuje na model roboczy", () => {
  // The instruction names `haiku`, which resolves through
  // ANTHROPIC_DEFAULT_HAIKU_MODEL (ADR-0002 test 3b). If that tier is ever
  // pointed at the same model as `sonnet`, the advice becomes a no-op and
  // nothing else would say so.
  const tiers = readJson("config/models.json").providers?.openrouter?.tiers ?? {};
  const block = genericModelBlock("plan") ?? "";
  const alias = block.match(/pass `model: "(\w+)"`/)?.[1];
  if (!alias) fail("nie da się odczytać aliasu z instrukcji");
  if (!tiers[alias]) fail(`alias '${alias}' nie ma odpowiednika w providers.openrouter.tiers`);
  if (tiers[alias] === tiers.sonnet) {
    fail(`alias '${alias}' wskazuje ten sam model co tier sonnet (${tiers.sonnet}) — instrukcja nic nie zmienia`);
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
  //
  // FOC-943: external-write servers are the Supervisor's only; children deny them.
  // FOC-958: fenix-control is denied for ALL roles (including the Supervisor) —
  // its answer tools write HUMAN decisions (gate/ask/dialog); a Supervisor with
  // fenix_gate_answer could self-answer its own HITL gate.
  const SUPERVISOR_ONLY_MCP = ["fenix-linear", "fenix-github"];
  // Denied for EVERY role including the Supervisor (FOC-958): its answer tools
  // write HUMAN decisions (gate/ask/dialog) — no process may self-answer a
  // HITL gate.  The transport is stdio, driven by a local operator client.
  const DENIED_FOR_ALL_MCP = ["fenix-control"];
  // Pinned: the exact tools the Supervisor may call on the supervisor-only servers.
  const SUPERVISOR_ONLY_EXPECTED = [
    "mcp__fenix-linear__transition",
    "mcp__fenix-linear__comment",
    "mcp__fenix-linear__comment_replace",
    "mcp__fenix-linear__attach_link",
    "mcp__fenix-github__pr_create",
    "mcp__fenix-github__pr_edit",
    "mcp__fenix-github__pr_comment",
  ];
  const servers = Object.keys(readJson(".mcp.json").mcpServers || {});
  const missing = [];
  for (const squad of SQUADS) {
    const perms = readJson(`agents/${squad}/settings.json`).permissions || {};
    const allow = perms.allow || [];
    const deny = perms.deny || [];
    for (const name of servers) {
      if (DENIED_FOR_ALL_MCP.includes(name)) {
        // Every role, Supervisor included, carries deny mcp__<name>__*.
        if (!deny.includes(`mcp__${name}__*`)) missing.push(`${squad}: brak deny mcp__${name}__*`);
        if (allow.some((r) => r.startsWith(`mcp__${name}__`))) {
          missing.push(`${squad}: allow na serwerze zabronionym dla wszystkich (${name})`);
        }
        continue;
      }
      if (SUPERVISOR_ONLY_MCP.includes(name)) {
        if (squad === "supervisor") {
          const expected = SUPERVISOR_ONLY_EXPECTED.filter((r) => r.startsWith(`mcp__${name}__`));
          for (const rule of expected) {
            if (!allow.includes(rule)) missing.push(`supervisor: brak ${rule}`);
          }
          // Exactly the pinned tools, nothing more: no wildcard allow and no
          // extra mcp__<name>__* rule beyond the pinned list.
          if (allow.includes(`mcp__${name}__*`)) missing.push(`supervisor: wildcard allow mcp__${name}__* na serwerze tylko-dla-Supervisora`);
          const actual = allow.filter((r) => r.startsWith(`mcp__${name}__`));
          for (const rule of actual) {
            if (!expected.includes(rule)) missing.push(`supervisor: nadprogramowe allow ${rule}`);
          }
        } else {
          if (!deny.includes(`mcp__${name}__*`)) missing.push(`${squad}: brak deny mcp__${name}__*`);
          if (allow.some((r) => r.startsWith(`mcp__${name}__`))) {
            missing.push(`${squad}: allow na serwerze tylko-dla-Supervisora (${name})`);
          }
        }
        continue;
      }
      const ok = allow.some((r) => r === `mcp__${name}__*` || r.startsWith(`mcp__${name}__`));
      if (!ok) missing.push(`${squad}: brak mcp__${name}__*`);
    }
  }
  // The orchestrator is NOT in SQUADS (AC-10 FOC-116 keeps it out of the squad
  // checks), but the supervisor-only and denied-for-all servers must be denied
  // there too — it is the one other interactive session that must never reach
  // them. Checked separately, never by adding it to the global list.
  const orchestratorPerms = readJson("agents/orchestrator/settings.json").permissions || {};
  const orchestratorDeny = orchestratorPerms.deny || [];
  for (const name of [...SUPERVISOR_ONLY_MCP, ...DENIED_FOR_ALL_MCP]) {
    if (!orchestratorDeny.includes(`mcp__${name}__*`)) missing.push(`orchestrator: brak deny mcp__${name}__*`);
    if ((orchestratorPerms.allow || []).some((r) => r.startsWith(`mcp__${name}__`))) {
      missing.push(`orchestrator: allow na serwerze tylko-dla-Supervisora (${name})`);
    }
  }
  if (missing.length) fail(`serwer bez uprawnienia:\n       ${missing.join("\n       ")}`);
});

test("supervisor ask/deny match the pinned child baseline (FOC-900)", () => {
  // The Supervisor's ask list is the exact human-gate set (push, PR, history
  // rewrite) and its deny carries the Linear-MCP + worktree-reclaim rules.
  // agent-tools check re-derives the deny baseline from SUPERVISOR_DENY; this
  // pins the Supervisor's own settings.json against silent edits from either
  // side.
  const perms = readJson("agents/supervisor/settings.json").permissions || {};
  const expectedAsk = [
    "Bash(git push:*)",
    "Bash(gh pr merge:*)",
    "Bash(git reset --hard:*)",
    "Bash(git clean:*)",
    "Bash(git branch -D:*)",
    "Bash(rm -rf:*)",
    "WebFetch",
  ];
  if (JSON.stringify(perms.ask || []) !== JSON.stringify(expectedAsk)) {
    fail(`supervisor permissions.ask drifted from the pinned list: ${JSON.stringify(perms.ask)}`);
  }
  const deny = perms.deny || [];
  const requiredDeny = [
    // FOC-958: fenix-control is denied for every role INCLUDING the Supervisor —
    // its answer tools write human decisions (gate/ask/dialog); a Supervisor with
    // fenix_gate_answer could self-answer its own HITL gate.
    "mcp__fenix-control__*",
    "mcp__linear__*",
    "mcp__claude_ai_Linear__*",
    "Bash(git worktree remove:*)",
    "Bash(git worktree prune:*)",
  ];
  const missingDeny = requiredDeny.filter((rule) => !deny.includes(rule));
  if (missingDeny.length) fail(`supervisor permissions.deny is missing: ${missingDeny.join(", ")}`);
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

test("lead model każdego składu z routingu ma cenę", () => {
  // FOC-771: the .bat launchers carry no ANTHROPIC_MODEL lines anymore, so the
  // lead a squad will actually run comes from the routing chain — the settings
  // overlay, then config/models.json routing.<squad> (roles through ids), then
  // the provider's defaultModel — the same childModelFor the Node entry point
  // and the Supervisor resolve at start. Every lead those sources can hand a
  // launcher must have a price row, or the cost check bills it as zero.
  const models = readJson("config/models.json");
  let settings = {};
  try {
    settings = readSettings();
  } catch {
    // A broken overlay cannot forbid the check: the table still must price its
    // leads, and dashboard writes are what put leads in the overlay anyway.
  }
  const providerEntry = models.providers?.openrouter?.defaultModel
    ? { defaultModel: models.providers.openrouter.defaultModel }
    : null;
  // Every squad the sources can name: the fixed floor, the routing table's
  // keys, and whatever the dashboard has pinned in the overlay.
  const squads = new Set(SQUADS);
  for (const k of Object.keys(models.routing ?? {})) if (!k.startsWith("_")) squads.add(k);
  for (const k of Object.keys(settings.routing ?? {})) if (!k.startsWith("_")) squads.add(k);
  const openrouter = models.pricing?.openrouter || {};
  const keys = Object.keys(openrouter);
  const shortOf = (s) => s.split("/").pop().replace(/\./g, "-");
  const resolves = (model) =>
    openrouter[model] != null || keys.some((k) => shortOf(k) === shortOf(model));
  const bad = [];
  // The Supervisor's hard floor when the sources resolve nothing for it —
  // duplicated in scripts/squad-start.mjs and scripts/squad-config.mjs; if the
  // id changes there, change it here too.
  const SUPERVISOR_FALLBACK_MODEL = "xiaomi/mimo-v2.6-pro";
  for (const squad of squads) {
    // routing.supervisor.default is the CHILDREN's alias, not the frontman's
    // model (FOC-771): the supervisor runs on the overlay's
    // routing.supervisor.lead or the built-in fallback — never the table's
    // default. Every other squad resolves through the routing chain.
    const model =
      squad === "supervisor"
        ? typeof settings.routing?.supervisor?.lead === "string" && settings.routing.supervisor.lead.trim()
          ? settings.routing.supervisor.lead.trim()
          : SUPERVISOR_FALLBACK_MODEL
        : childModelFor({
            squad,
            settings,
            modelsConfig: models,
            provider: "openrouter",
            providerEntry,
          }).model;
    if (model && !resolves(model)) bad.push(`routing ${squad} → ${model}`);
  }
  if (!resolves(SUPERVISOR_FALLBACK_MODEL)) {
    bad.push(`supervisor fallback → ${SUPERVISOR_FALLBACK_MODEL}`);
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

// ── powierzchnia narzędzi (FOC-169) ────────────────────────────────────
console.log("\npowierzchnia narzędzi");

// Zmierzone 2026-08-26 (`scripts/floor-probe.mjs --spend`, skład dev): schematy
// tych czterech narzędzi kosztują 8 689 tokenów W KAŻDYM wywołaniu — dwa razy
// tyle co cały prompt składu, ~$46/mies. przy obecnym wolumenie. Żadne z nich nie
// jest używalne przez headless dziecko: `Artifact` publikuje stronę na claude.ai,
// `PushNotification` dzwoni na telefon, `ListAgents` i `Monitor` obsługują sesje
// interaktywne obok. Pełna metoda: docs/decisions/context-attribution-2026-08-26.md
//
// `permissions.deny` zdejmuje SCHEMAT, nie tylko prawo wywołania — to jest powod,
// dla którego poprawka mieszka w commitowanym settings.json, a nie we fladze
// launchera, o której każde nowe wejście musiałoby pamiętać.
const HEADLESS_UNUSABLE = ["Artifact", "PushNotification", "ListAgents", "Monitor"];

test("każdy skład odmawia czterech narzędzi nieużywalnych headless", () => {
  const missing = [];
  for (const squad of SQUADS) {
    const deny = readJson(`agents/${squad}/settings.json`).permissions?.deny ?? [];
    for (const tool of HEADLESS_UNUSABLE) {
      if (!deny.includes(tool)) missing.push(`${squad}: brak deny na ${tool}`);
    }
  }
  // Cicha regresja w czystej postaci: nic nie pada, gdy ktoś usunie wpis —
  // rachunek po prostu rośnie o 8,7k tokenów na wywołanie i nikt tego nie widzi.
  if (missing.length) fail(`odzyskana powierzchnia narzędzi wróciła:\n       ${missing.join("\n       ")}`);
});

test("odmówione narzędzie nie jest jednocześnie nakazane w prompcie", () => {
  // Odwrotność testu "instrukcja bez uprawnienia": tu chodzi o uprawnienie
  // zdjęte, gdy instrukcja została. Dopasowanie tylko w backtickach, bo tak ten
  // repo nazywa narzędzia — nagłówek "### 4. Monitor — never busy-loop" w
  // prompcie Supervisora to rzeczownik i NIE ma być trafieniem.
  const conflicts = [];
  for (const squad of SQUADS) {
    const doc = read(`agents/${squad}/CLAUDE.md`);
    const deny = readJson(`agents/${squad}/settings.json`).permissions?.deny ?? [];
    for (const tool of HEADLESS_UNUSABLE) {
      if (deny.includes(tool) && new RegExp("`" + tool + "`").test(doc)) {
        conflicts.push(`${squad}: CLAUDE.md wskazuje \`${tool}\`, a settings.json go odmawia`);
      }
    }
  }
  if (conflicts.length) fail(`prompt każe użyć narzędzia, którego harness zabrania:\n       ${conflicts.join("\n       ")}`);
});

test("orchestrator zostaje nietknięty przez tę zmianę", () => {
  // AC-10 FOC-116 jest dosłowne: `git diff -- agents/orchestrator` ma być pusty,
  // a PR właśnie to zadeklarował. Orchestrator jest sesją interaktywną z własnym
  // kontraktem i nie należy do SQUADS — ten test pilnuje, żeby porządkowanie
  // powierzchni narzędzi nie weszło tam bokiem.
  const deny = readJson("agents/orchestrator/settings.json").permissions?.deny ?? [];
  const leaked = HEADLESS_UNUSABLE.filter((t) => deny.includes(t));
  if (leaked.length) fail(`agents/orchestrator/settings.json zmieniony (${leaked.join(", ")}) — to łamie AC-10`);
});

// ── widoczność składu w dashboardzie (FOC-170) ───────────────────────────
console.log("\nwidoczność składu w dashboardzie");

// Supervisor istniał jako skład wszędzie poza dashboardem: telemetria miała jego
// runy (4 runy, 3 456 wierszy usage_facts), config/models.json miał
// routing.supervisor — a UI go nie pokazywało, bo lista składów była
// zahardkodowana w ośmiu miejscach. Nic nie padło: te testy pilnowały spójności
// config↔prompt, nie pokrycia w dashboardzie.
const ROUTED_SQUADS = Object.keys(readJson("config/models.json").routing ?? {}).filter(
  (k) => !k.startsWith("_"),
);

test("każdy skład z routingu ma etykietę i kolor w UI", () => {
  const card = read("ui/src/components/SquadCard.jsx");
  const theme = read("ui/src/theme.css");

  // Wycinamy KONKRETNY blok, nie cały plik. Pierwsza wersja szukała
  // `^\s*<squad>: '` w całym SquadCard.jsx i przechodziła na wpisie z mapy
  // KOLORÓW — usunięcie etykiety niczego nie łamało. Sprawdzone przez zepsucie
  // testu: nadal był zielony, czyli pilnował niczego.
  //
  // Druga wersja też nie działała: kotwica `\n};` nie łapie `\r\n};`, a te pliki
  // UI mają CRLF. Regex zaczepiony o koniec linii musi to zakładać — inaczej
  // przechodzi zawsze, bo blok jest pusty, a pusty blok "nie zawiera" niczego.
  const block = (name) => {
    const m = card.match(new RegExp(`const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\r?\\n\\};`, "m"));
    return m ? m[1] : "";
  };
  const labels = block("SQUAD_LABELS");
  const colors = block("SQUAD_COLOR");
  if (!labels || !colors) fail("nie znaleziono SQUAD_LABELS / SQUAD_COLOR w SquadCard.jsx");

  const missing = [];
  for (const squad of ROUTED_SQUADS) {
    if (!new RegExp(`\\b${squad}:`).test(labels)) missing.push(`${squad}: brak etykiety w SQUAD_LABELS`);
    if (!new RegExp(`\\b${squad}:`).test(colors)) missing.push(`${squad}: brak koloru w SQUAD_COLOR`);
    if (!theme.includes(`--sq-${squad}:`)) missing.push(`${squad}: brak tokenu --sq-${squad} w theme.css`);
  }
  // Bez etykiety wiersz renderuje się fallbackiem i wygląda jak inny skład —
  // gorzej niż gdyby go nie było.
  if (missing.length) fail(`skład w routingu, niewidoczny w UI:\n       ${missing.join("\n       ")}`);
});

test("każdy skład z routingu przechodzi przez readSquadConfig", async () => {
  // To jest ekran Konfiguracji i źródło listy dla Promptów. Skład, którego tu nie
  // ma, jest nieedytowalny — i nikt się nie dowie, że istnieje.
  const { readSquadConfig } = await import("./squad-config.mjs");
  const seen = Object.keys(readSquadConfig(ROOT).squads);
  const missing = ROUTED_SQUADS.filter((s) => !seen.includes(s));
  if (missing.length) fail(`routing zna ${missing.join(", ")}, readSquadConfig nie`);
});

test("każdy skład z routingu jest na osi czasu", () => {
  const timeline = read("ui/src/screens/Timeline.jsx");
  const missing = ROUTED_SQUADS.filter((s) => !new RegExp(`'${s}'`).test(timeline));
  // Filtrowanie po zahardkodowanej liście ukrywa runy, które SA w telemetrii —
  // wygląda to jak brak danych, a jest brakiem wpisu.
  if (missing.length) fail(`skład bez wpisu w Timeline.jsx: ${missing.join(", ")}`);
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED`);
  console.log("\nKażdy z tych błędów jest cichy w czasie działania — dlatego ten plik istnieje.");
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
