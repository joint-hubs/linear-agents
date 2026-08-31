// scripts/prompt-library.mjs
// Backend biblioteki promptów — drzewo intencji, dokumenty ról i leadów.
//
// ESM, zero runtime deps (Node 22 built-ins only).
//
// Exports:
//   buildPromptTree(root)  -> { intents, squads }
//   readRoleDoc(squad, role, root) -> { squad, role, model, tools:[], body }
//   readLeadDoc(squad, root) -> { squad, body }
//   extractRefs(text) -> [{ path, raw, isTemplate }]
//   resolvePromptRefs(root, { squad, role }) -> { sources, refs, stats }
//   listContextFiles(root) -> Set<string>   (allowlist for readContextFile / writeContextFile)
//   readContextFile(root, relPath) -> { path, body, lines } | { error }
//   writeContextFile(root, relPath, body, { dryRun }) -> { path, before, after, changed, bytes } | { error }

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { KICKOFF_TEMPLATES } from "./launch.mjs";
import { readSquadConfig } from "./squad-config.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = join(__dir, "..");

// Read from squad-config rather than listed again. Eight copies of this array
// are why the Supervisor was invisible in the dashboard for as long as it
// existed (FOC-170) — the ninth squad should appear by existing.
const SQUADS = Object.keys(readSquadConfig(defaultRoot).squads);

const INTENTS = [
  { id: "plan", label: "Zaplanować nowy feature", squad: "plan" },
  { id: "dev", label: "Zakodować gotowe zadanie", squad: "dev" },
  { id: "review", label: "Zrecenzować kod", squad: "review" },
  { id: "test", label: "Przetestować i wdrożyć", squad: "test" },
  { id: "cadence", label: "Podsumować tydzień", squad: "cadence" },
  // The Supervisor is driven interactively — Mateusz talks to it and it starts
  // the squad children itself — so its "kickoff" is an issue id, not a template.
  { id: "supervisor", label: "Poprowadzić zadanie przez Supervisora", squad: "supervisor" },
  { id: "single", label: "Uruchomić pojedynczą rolę (debug)", squad: null },
];

// Entry conditions per squad (HOW-TO-RUN-AGENTS.md §3 + §4).
const ENTRY_CONDITIONS = {
  plan: "Approved feature na tablicy albo notatka w planning/inbox/",
  dev: "Zadanie w Todo z etykietą dor-ok",
  review: "Zadanie w In Review (zwykle z ai:coded)",
  test: "Zadanie z etykietą stage:testing (po approve z REVIEW)",
  cadence: "Uruchamiane cotygodniowo — nie wymaga zadania",
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ROLE_RE = /^[a-z0-9-]+$/;

function validateSquad(squad) {
  if (!SQUADS.includes(squad)) {
    return { error: `invalid squad: must be one of ${SQUADS.join(", ")}` };
  }
  return { ok: true };
}

function validateRole(role) {
  if (!role || typeof role !== "string" || !ROLE_RE.test(role)) {
    return { error: "invalid role: must match /^[a-z0-9-]+$/" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Returns { frontmatter: { key: value }, body: string }.
 * Frontmatter is between the first two `---` lines.
 */
function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: content };

  const fm = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx > 0) {
      const key = lines[i].slice(0, colonIdx).trim();
      const value = lines[i].slice(colonIdx + 1).trim();
      fm[key] = value;
    }
  }

  // Body starts after the closing ---
  const bodyStart = i + 1;
  const body = lines.slice(bodyStart).join("\n");

  return { frontmatter: fm, body };
}

// ---------------------------------------------------------------------------
// Role discovery
// ---------------------------------------------------------------------------

/**
 * Read all agent .md files from agents/<squad>/agents/ (skipping plugins/).
 * Returns an array of { role, model, tools }.
 */
function readSquadRoles(squadDir) {
  const agentsDir = join(squadDir, "agents");
  if (!existsSync(agentsDir)) return [];

  let entries;
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const roles = [];
  for (const entry of entries) {
    // Only .md files, skip directories (plugins/) and non-.md files
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const role = entry.name.replace(/\.md$/, "");
    // Validate role name (defense in depth — path traversal guard)
    if (!ROLE_RE.test(role)) continue;

    const filePath = join(agentsDir, entry.name);
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const { frontmatter } = parseFrontmatter(content);
    const model = frontmatter.model || null;
    const tools = frontmatter.tools
      ? frontmatter.tools.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    roles.push({ role, model, tools });
  }

  return roles;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full prompt tree for the UI.
 *
 * @param {string} [root]  Repo root path (defaults to ../ from this script).
 * @returns {{ intents: Array, squads: object }}
 */
export function buildPromptTree(root) {
  const r = root || defaultRoot;
  const config = readSquadConfig(r);

  const squads = {};

  for (const squad of SQUADS) {
    const squadDir = join(r, "agents", squad);
    const roles = readSquadRoles(squadDir);

    squads[squad] = {
      squad,
      kickoff: KICKOFF_TEMPLATES[squad] || [],
      entryCondition: ENTRY_CONDITIONS[squad] || null,
      lead: {
        model: (config.squads[squad] && config.squads[squad].lead) || null,
      },
      roles,
      agentCmd: `bin\\agent.bat ${squad} <rola>`,
    };
  }

  return { intents: INTENTS, squads };
}

/**
 * Read a single role's documentation (frontmatter + body).
 *
 * @param {string} squad  One of plan/dev/review/test/cadence.
 * @param {string} role   Role name matching /^[a-z0-9-]+$/.
 * @param {string} [root] Repo root path.
 * @returns {{ squad, role, model, tools: string[], body: string } | { error: string }}
 */
export function readRoleDoc(squad, role, root) {
  const r = root || defaultRoot;

  const squadCheck = validateSquad(squad);
  if (squadCheck.error) return { error: squadCheck.error };

  const roleCheck = validateRole(role);
  if (roleCheck.error) return { error: roleCheck.error };

  const filePath = join(r, "agents", squad, "agents", `${role}.md`);
  if (!existsSync(filePath)) {
    return { error: "not found" };
  }

  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return { error: "not found" };
  }

  const { frontmatter, body } = parseFrontmatter(content);
  const model = frontmatter.model || null;
  const tools = frontmatter.tools
    ? frontmatter.tools.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return { squad, role, model, tools, body };
}

/**
 * Read a squad lead's CLAUDE.md (full body, no frontmatter stripping).
 *
 * @param {string} squad  One of plan/dev/review/test/cadence.
 * @param {string} [root] Repo root path.
 * @returns {{ squad, body: string } | { error: string }}
 */
export function readLeadDoc(squad, root) {
  const r = root || defaultRoot;

  const squadCheck = validateSquad(squad);
  if (squadCheck.error) return { error: squadCheck.error };

  const filePath = join(r, "agents", squad, "CLAUDE.md");
  if (!existsSync(filePath)) {
    return { error: "not found" };
  }

  let body;
  try {
    body = readFileSync(filePath, "utf8");
  } catch {
    return { error: "not found" };
  }

  return { squad, body };
}

// ---------------------------------------------------------------------------
// Context tracing — which files a prompt actually pulls in
// (docs/ui/prompt-context-tracing.md)
// ---------------------------------------------------------------------------

// Extensions we recognise as a file reference. Anything else in prose is noise.
const REF_EXT = "md|json|mjs|js|bat|ps1|sh|yml|yaml";

// A reference is >=2 path segments joined by / or \, ending in a known extension.
// Optional `$LA_ROOT/` prefix — the squads call scripts as `node $LA_ROOT/scripts/x.mjs`.
// The leading `(?:\.{1,2}[\/\\])*` matters: docs link each other doc-relatively
// (`[spec](../agents/agent-2-dev.md)`), and dropping the `../` would silently
// rewrite a valid link into a path that does not exist.
// Single-word filenames (bare `CLAUDE.md`) are deliberately NOT matched: they are
// self-references handled as sources, and matching them would flood the list.
const REF_RE = new RegExp(
  String.raw`(?:\$LA_ROOT[\/\\])?((?:\.{1,2}[\/\\])*(?:\.?[A-Za-z0-9_*<>-]+[\/\\])+[A-Za-z0-9_.*<>-]+\.(?:${REF_EXT}))`,
  "g"
);

const TOOL_EXT = new Set(["mjs", "js", "bat", "ps1", "sh"]);
const DATA_EXT = new Set(["json", "yml", "yaml"]);

/** Normalise a matched path: backslashes -> /. Relative prefixes are kept. */
function normalizeRef(p) {
  return p.replace(/\\/g, "/");
}

/**
 * Resolve a reference to a repo-relative path.
 * `./x` and `../x` resolve against the directory of the document they appear in;
 * anything else is already repo-root-relative.
 */
function resolveRefPath(fromPath, refPath) {
  if (!/^\.{1,2}\//.test(refPath)) return refPath.replace(/^\.\//, "");

  const baseDir =
    fromPath && fromPath.includes("/")
      ? fromPath.slice(0, fromPath.lastIndexOf("/"))
      : "";

  const segs = [];
  for (const seg of (baseDir ? baseDir.split("/") : []).concat(refPath.split("/"))) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return segs.join("/");
}

/**
 * A "template" reference is a placeholder, not a broken link:
 *   agents/*\/agents/*.md   docs/adr/NNN-slug.md   planning/inbox/<plik>.md
 * These must not be reported as missing files.
 */
function isTemplateRef(p) {
  return /[*<>]/.test(p) || /(^|\/)N{3,}/.test(p);
}

/** read | tool | config | state — what the agent does with this file. */
function classifyRef(p) {
  // `.state/` holds runtime artefacts (WIP markers, fixtures). Absent is the
  // normal case between runs, so these must not be reported as broken links.
  if (p.startsWith(".state/")) return "state";
  const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
  if (TOOL_EXT.has(ext)) return "tool";
  if (DATA_EXT.has(ext)) return "config";
  return "read";
}

// Lead/role docs are the two path shapes resolvePromptRefs always registers
// via addSource(...,"auto") — and addRef() keeps a path's first-assigned kind,
// so within resolvePromptRefs these are "auto" no matter what else references
// them. Matching the shape directly (instead of re-running resolvePromptRefs)
// gives the same answer without a squad-by-squad traversal.
const LEAD_DOC_RE = /^agents\/([a-z0-9-]+)\/CLAUDE\.md$/;
const ROLE_DOC_RE = /^agents\/([a-z0-9-]+)\/agents\/([a-z0-9-]+)\.md$/;

/**
 * The kind of a context-file path, matching how resolvePromptRefs classifies
 * it: lead/role docs are always `auto` sources; everything else falls back to
 * classifyRef's extension / `.state/`-prefix rules (`read`, `tool`, `config`,
 * `state`).
 */
function refKind(p) {
  const lead = LEAD_DOC_RE.exec(p);
  if (lead && SQUADS.includes(lead[1])) return "auto";
  const role = ROLE_DOC_RE.exec(p);
  if (role && SQUADS.includes(role[1])) return "auto";
  return classifyRef(p);
}

/**
 * Extract every repo-relative file reference from a block of prose.
 *
 * @param {string} text
 * @returns {Array<{ path: string, raw: string, isTemplate: boolean }>} deduped, in first-seen order
 */
export function extractRefs(text) {
  if (!text || typeof text !== "string") return [];

  const seen = new Set();
  const out = [];

  // Blank out URLs first. Matching around them is unreliable — the host part of
  // `https://example.com/docs/spec.md` is not a path segment, so the regex would
  // otherwise latch onto `com/docs/spec.md` and report a phantom repo file.
  const scrubbed = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");

  for (const m of scrubbed.matchAll(REF_RE)) {
    const path = normalizeRef(m[1]);
    if (seen.has(path)) continue;
    seen.add(path);

    out.push({ path, raw: m[0], isTemplate: isTemplateRef(path) });
  }

  return out;
}

/** Stat a repo-relative path. Returns null when absent or unreadable. */
function statRef(root, relPath) {
  const abs = join(root, relPath);
  if (!existsSync(abs)) return null;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    const body = readFileSync(abs, "utf8");
    return { bytes: st.size, lines: body.split(/\r?\n/).length, body };
  } catch {
    return null;
  }
}

/**
 * Resolve the full context graph behind a squad's (or a single role's) prompt.
 *
 * Depth 0 = documents loaded automatically into the agent's context
 *           (kickoff line, lead CLAUDE.md, role .md files).
 * Depth 1 = files those documents point at.
 * Depth 2 = files those .md documents point at in turn. Recursion stops here.
 *
 * @param {string} root
 * @param {{ squad: string, role?: string|null }} opts
 * @returns {{ squad, role, sources: Array, refs: Array, stats: object } | { error: string }}
 */
export function resolvePromptRefs(root, opts = {}) {
  const r = root || defaultRoot;
  const squad = opts.squad;
  const role = opts.role || null;

  const squadCheck = validateSquad(squad);
  if (squadCheck.error) return { error: squadCheck.error };
  if (role) {
    const roleCheck = validateRole(role);
    if (roleCheck.error) return { error: roleCheck.error };
  }

  const refs = new Map(); // path -> ref record
  const sources = [];

  function addRef(path, { kind, depth, from, isTemplate }) {
    const existing = refs.get(path);
    if (existing) {
      if (from && !existing.referencedBy.includes(from)) existing.referencedBy.push(from);
      // Keep the shallowest depth — a file reached both directly and indirectly
      // is really a direct dependency.
      if (depth < existing.depth) existing.depth = depth;
      return existing;
    }
    const st = isTemplate ? null : statRef(r, path);
    const rec = {
      path,
      kind,
      depth,
      isTemplate: Boolean(isTemplate),
      exists: isTemplate ? null : st !== null,
      lines: st ? st.lines : null,
      bytes: st ? st.bytes : null,
      // Sources are loaded automatically, not referenced by anything — empty list.
      referencedBy: from ? [from] : [],
    };
    refs.set(path, rec);
    return rec;
  }

  // --- Depth 0: the documents that ARE the prompt ------------------------

  /** Register a source doc and queue its references. */
  function addSource(id, label, relPath, kind) {
    sources.push({ id, label, path: relPath, kind });
    if (relPath) {
      addRef(relPath, { kind, depth: 0, from: null, isTemplate: false });
    }
  }

  const queue = []; // { text, from, depth }

  if (role) {
    const rel = `agents/${squad}/agents/${role}.md`;
    const st = statRef(r, rel);
    if (!st) return { error: "not found" };
    addSource(rel, `rola ${role}`, rel, "auto");
    queue.push({ text: st.body, from: rel, depth: 1 });
  } else {
    // The kickoff line — pasted into the agent window, so it is context too.
    const kickoff = (KICKOFF_TEMPLATES[squad] || []).join(" ");
    if (kickoff) {
      sources.push({ id: "kickoff", label: "prompt kickoff", path: null, kind: "auto" });
      queue.push({ text: kickoff, from: "kickoff", depth: 1 });
    }

    // Lead CLAUDE.md — auto-loaded by Claude Code, the real instruction.
    const leadRel = `agents/${squad}/CLAUDE.md`;
    const leadSt = statRef(r, leadRel);
    if (leadSt) {
      addSource(leadRel, "instrukcja leada", leadRel, "auto");
      queue.push({ text: leadSt.body, from: leadRel, depth: 1 });
    }

    // Every role doc in the squad.
    for (const { role: roleName } of readSquadRoles(join(r, "agents", squad))) {
      const roleRel = `agents/${squad}/agents/${roleName}.md`;
      const roleSt = statRef(r, roleRel);
      if (!roleSt) continue;
      addSource(roleRel, `rola ${roleName}`, roleRel, "auto");
      queue.push({ text: roleSt.body, from: roleRel, depth: 1 });
    }
  }

  // --- Depth 1..2: follow the references ---------------------------------

  const MAX_DEPTH = 2;
  const scanned = new Set(); // cycle guard: a doc is scanned at most once

  while (queue.length) {
    const { text, from, depth } = queue.shift();

    for (const ref of extractRefs(text)) {
      // `../x.md` in a doc is relative to that doc, not to the repo root.
      const path = resolveRefPath(from === "kickoff" ? "" : from, ref.path);
      if (!path) continue;

      // A source doc referencing itself adds nothing.
      if (path === from) continue;

      const kind = classifyRef(path);
      const rec = addRef(path, { kind, depth, from, isTemplate: ref.isTemplate });

      // Only markdown docs are worth following — their prose carries more
      // references. Scripts and JSON are leaves.
      if (depth < MAX_DEPTH && kind === "read" && rec.exists && !scanned.has(path)) {
        scanned.add(path);
        const st = statRef(r, path);
        if (st) queue.push({ text: st.body, from: path, depth: depth + 1 });
      }
    }
  }

  // --- Stats -------------------------------------------------------------

  const list = [...refs.values()].sort(
    (a, b) => a.depth - b.depth || a.path.localeCompare(b.path)
  );

  // `missing` counts real broken links only: templates have no file by design,
  // and `.state/` artefacts legitimately do not exist between runs.
  const stats = { total: list.length, missing: 0, byKind: {} };
  for (const rec of list) {
    if (rec.exists === false && rec.kind !== "state") stats.missing++;
    stats.byKind[rec.kind] = (stats.byKind[rec.kind] || 0) + 1;
  }

  return { squad, role, sources, refs: list, stats };
}

/**
 * Every file any prompt in the repo can reach. This is the allowlist for
 * readContextFile — a path outside it is never served, regardless of where it
 * points. Cheap enough to recompute per request (~30 small files).
 *
 * @param {string} [root]
 * @returns {Set<string>}
 */
export function listContextFiles(root) {
  const r = root || defaultRoot;
  const all = new Set();

  for (const squad of SQUADS) {
    const result = resolvePromptRefs(r, { squad });
    if (result.error) continue;
    for (const ref of result.refs) {
      if (ref.exists) all.add(ref.path);
    }
  }

  return all;
}

/**
 * Read one context file, but only if a prompt actually references it.
 *
 * Two independent guards, because this reads arbitrary paths off disk:
 *   1. membership in the reference allowlist (the real lock);
 *   2. the resolved path must stay inside `root` (defence in depth).
 *
 * @param {string} root
 * @param {string} relPath  Repo-relative path.
 * @returns {{ path, body, lines } | { error: string }}
 */
export function readContextFile(root, relPath) {
  const r = root || defaultRoot;

  if (!relPath || typeof relPath !== "string") {
    return { error: "path is required" };
  }

  const normalized = normalizeRef(relPath);

  // Guard 2 first — it is pure string/path math and rejects the obvious attacks
  // before we spend anything building the allowlist.
  const abs = resolve(r, normalized);
  const rootAbs = resolve(r);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    return { error: "forbidden: path escapes repo root" };
  }

  // Guard 1 — the actual authorisation check.
  if (!listContextFiles(r).has(normalized)) {
    return { error: "forbidden: not referenced by any prompt" };
  }

  const st = statRef(r, normalized);
  if (!st) return { error: "not found" };

  return { path: normalized, body: st.body, lines: st.lines };
}

// ---------------------------------------------------------------------------
// External prompt roots — ~/.claude and hermes
// (docs/ui/prompt-editing-external.md)
//
// Outside the repo the "must stay inside root" guard no longer applies, so it is
// replaced by an explicit roots + include-globs allowlist. config/prompt-roots.json
// is the security boundary: adding a root there grants this local HTTP server
// write access to that directory. It is .json, so the .md-only editor cannot
// modify it from the UI.
// ---------------------------------------------------------------------------

const EXTERNAL_PREFIX = "@";

/**
 * Expand ~ and %VAR%, and resolve repo-relative roots against `root`.
 *
 * A root without ~, %VAR% or a drive letter is repo-relative — that is how the
 * orchestrator context (agents/orchestrator) is reached now that it lives in
 * the repo rather than in ~/.claude.
 */
function expandPath(p, root) {
  let out = p.replace(/^~(?=[/\\]|$)/, process.env.USERPROFILE || process.env.HOME || "~");
  out = out.replace(/%([A-Z_][A-Z0-9_]*)%/gi, (m, name) => process.env[name] || m);
  out = out.replace(/\\/g, "/");
  const absolute = /^([A-Za-z]:|\/|\\\\)/.test(out);
  if (!absolute) out = join(root || defaultRoot, out).replace(/\\/g, "/");
  return out;
}

/** Glob with `*` only (no `**`): one segment, no separators. */
function globToRe(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, "[^/]*") + "$");
}

/**
 * Read the external-root allowlist.
 * A malformed or missing file yields zero roots — the feature degrades to
 * repo-only, which is the safe direction.
 */
export function readPromptRoots(root) {
  const r = root || defaultRoot;
  try {
    const raw = readFileSync(join(r, "config", "prompt-roots.json"), "utf8");
    const parsed = JSON.parse(raw);
    const roots = Array.isArray(parsed.roots) ? parsed.roots : [];
    return roots
      .filter((x) => x && typeof x.id === "string" && typeof x.path === "string")
      .map((x) => ({
        id: x.id,
        label: x.label || x.id,
        hint: x.hint || null,
        path: expandPath(x.path, r),
        include: Array.isArray(x.include) ? x.include : [],
        exclude: Array.isArray(x.exclude) ? x.exclude : [],
      }));
  } catch {
    return [];
  }
}

/** Split "@rootId/rel/path.md" into { rootId, rel }, or null when not prefixed. */
function parseExternalPath(p) {
  if (typeof p !== "string" || !p.startsWith(EXTERNAL_PREFIX)) return null;
  const rest = p.slice(1).replace(/\\/g, "/");
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { rootId: rest.slice(0, slash), rel: rest.slice(slash + 1) };
}

function matchesAny(rel, globs) {
  return globs.some((g) => globToRe(g).test(rel));
}

/**
 * Resolve "@rootId/rel" to an absolute path, applying every guard.
 * Returns { abs, root, rel } or { error }.
 */
function resolveExternal(root, p) {
  const parsed = parseExternalPath(p);
  if (!parsed) return { error: "forbidden: not an external prompt path" };

  const cfg = readPromptRoots(root).find((x) => x.id === parsed.rootId);
  if (!cfg) return { error: `forbidden: unknown prompt root '${parsed.rootId}'` };

  if (!parsed.rel.endsWith(".md")) {
    return { error: "forbidden: only .md files are editable" };
  }

  // realpath, not resolve: a symlink inside the root would otherwise be a way
  // out of it. Both the parent directory AND the file itself are checked —
  // a directory junction (skills/x -> elsewhere) and a file symlink
  // (memory/x.md -> elsewhere) are two different escapes, and checking only the
  // directory would let the second one through.
  const abs = resolve(cfg.path, parsed.rel);
  let rootReal;
  try {
    rootReal = realpathSync(cfg.path);
  } catch {
    return { error: "not found" };
  }
  const inside = (p) => p === rootReal || p.startsWith(rootReal + sep);

  try {
    if (!inside(realpathSync(dirname(abs)))) {
      return { error: "forbidden: path escapes the prompt root" };
    }
  } catch {
    return { error: "not found" };
  }

  // The file need not exist yet for the directory check above to be meaningful,
  // but when it does exist its own real location must also be inside the root.
  if (existsSync(abs)) {
    try {
      if (!inside(realpathSync(abs))) {
        return { error: "forbidden: path escapes the prompt root" };
      }
    } catch {
      return { error: "not found" };
    }
  }

  if (!matchesAny(parsed.rel, cfg.include)) {
    return { error: "forbidden: path is not in this root's include list" };
  }
  if (cfg.exclude.length && matchesAny(parsed.rel, cfg.exclude)) {
    return { error: "forbidden: path is excluded in this root" };
  }

  return { abs, root: cfg, rel: parsed.rel };
}

/**
 * Enumerate every editable file across the configured external roots.
 * @returns {Array<{ rootId, label, hint, path, rel, lines, bytes }>}
 */
export function listExternalPromptFiles(root) {
  const out = [];
  for (const cfg of readPromptRoots(root)) {
    if (!existsSync(cfg.path)) continue;
    for (const glob of cfg.include) {
      const parts = glob.split("/");
      // Only two shapes are used: "FILE.md" and "dir/*.md" / "dir/*/FILE.md".
      const candidates = [];
      if (parts.length === 1) {
        candidates.push(parts[0]);
      } else if (parts.length === 2) {
        const [d, f] = parts;
        try {
          for (const e of readdirSync(join(cfg.path, d), { withFileTypes: true })) {
            if (e.isFile() && globToRe(f).test(e.name)) candidates.push(`${d}/${e.name}`);
          }
        } catch { /* directory absent — skip */ }
      } else if (parts.length === 3) {
        const [d, mid, f] = parts;
        try {
          for (const e of readdirSync(join(cfg.path, d), { withFileTypes: true })) {
            if (!e.isDirectory() || !globToRe(mid).test(e.name)) continue;
            const inner = join(cfg.path, d, e.name, f);
            if (existsSync(inner)) candidates.push(`${d}/${e.name}/${f}`);
          }
        } catch { /* directory absent — skip */ }
      }

      for (const rel of candidates) {
        if (cfg.exclude.length && matchesAny(rel, cfg.exclude)) continue;
        const abs = join(cfg.path, rel);
        if (!existsSync(abs)) continue;
        if (out.some((x) => x.path === `${EXTERNAL_PREFIX}${cfg.id}/${rel}`)) continue;
        let lines = null;
        let bytes = null;
        try {
          const txt = readFileSync(abs, "utf8");
          lines = txt.split(/\r?\n/).length;
          bytes = statSync(abs).size;
        } catch { continue; }
        out.push({
          rootId: cfg.id,
          label: cfg.label,
          hint: cfg.hint,
          path: `${EXTERNAL_PREFIX}${cfg.id}/${rel}`,
          rel,
          lines,
          bytes,
        });
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read one external prompt document. */
export function readExternalFile(root, p) {
  const res = resolveExternal(root, p);
  if (res.error) return res;
  try {
    const body = readFileSync(res.abs, "utf8");
    return { path: p, body, lines: body.split(/\r?\n/).length };
  } catch {
    return { error: "not found" };
  }
}

/** Write one external prompt document, preserving its line endings. */
export function writeExternalFile(root, p, body, opts = {}) {
  const res = resolveExternal(root, p);
  if (res.error) return res;
  if (typeof body !== "string") return { error: "body is required" };

  let before;
  try {
    before = readFileSync(res.abs, "utf8");
  } catch {
    return { error: "not found" };
  }

  const eol = detectEOL(before);
  const after = normalizeEOL(body, eol);
  const changed = after !== before;

  if (changed && !opts.dryRun) atomicWriteText(res.abs, after);

  return { path: p, before, after, changed, bytes: Buffer.byteLength(after, "utf8") };
}

/** True when a path targets an external root rather than the repo. */
export function isExternalPath(p) {
  return parseExternalPath(p) !== null;
}

// ---------------------------------------------------------------------------
// Context tracing — writing prompt/context documents
// (docs/ui/prompt-editing.md)
// ---------------------------------------------------------------------------

/** Detect line ending of file content: "\r\n" or "\n". */
function detectEOL(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Normalise every line ending in text to a single target EOL. */
function normalizeEOL(text, eol) {
  return text.replace(/\r\n|\n/g, eol);
}

/** Atomic text write: write to a sibling temp file, then rename over the target. */
function atomicWriteText(filePath, content) {
  const tmp = `${filePath}.${randomBytes(4).readUInt32BE(0).toString(36)}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

/**
 * Write one context/prompt document — the write-side counterpart of
 * readContextFile. Same allowlist, same defence-in-depth path check, plus a
 * `kind` check so `.state/**` and other non-prompt `.md` files stay read-only.
 *
 * Guards run cheapest-first, first match wins:
 *   1. `relPath` must end in `.md`
 *   2. resolved path must stay inside `root` (defence in depth)
 *   3. `relPath` must be in listContextFiles(root) — the real lock
 *   4. the file's kind must be `auto` or `read` (blocks `.state/**.md`)
 *   5. `body` must be a string
 *
 * On write, `body` is normalised to the file's existing EOL style before
 * comparison and before hitting disk — this repo mixes CRLF/LF, and writing
 * one style over the whole file would turn a three-line edit into a
 * whole-file diff.
 *
 * @param {string} root
 * @param {string} relPath  Repo-relative path.
 * @param {string} body     New file content.
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ path, before, after, changed, bytes } | { error: string }}
 */
export function writeContextFile(root, relPath, body, opts = {}) {
  const r = root || defaultRoot;
  const dryRun = Boolean(opts.dryRun);

  // Guard 1 — cheapest rejection: extension allowlist.
  if (typeof relPath !== "string" || !relPath.endsWith(".md")) {
    return { error: "forbidden: only .md files are editable" };
  }

  const normalized = normalizeRef(relPath);

  // Guard 2 — defence in depth: resolved path must stay inside root.
  const abs = resolve(r, normalized);
  const rootAbs = resolve(r);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    return { error: "forbidden: path escapes repo root" };
  }

  // Guard 3 — the real lock: the file must be referenced by some prompt.
  if (!listContextFiles(r).has(normalized)) {
    return { error: "forbidden: not referenced by any prompt" };
  }

  // Guard 4 — only auto/read documents are prompt text (blocks `.state/**.md`).
  const kind = refKind(normalized);
  if (kind !== "auto" && kind !== "read") {
    return { error: "forbidden: not an editable prompt document" };
  }

  // Guard 5 — body must be a string.
  if (typeof body !== "string") {
    return { error: "body is required" };
  }

  const before = statRef(r, normalized);
  if (!before) return { error: "not found" };

  const eol = detectEOL(before.body);
  const after = normalizeEOL(body, eol);
  const changed = after !== before.body;

  if (changed && !dryRun) {
    atomicWriteText(abs, after);
  }

  return {
    path: normalized,
    before: before.body,
    after,
    changed,
    bytes: Buffer.byteLength(after, "utf8"),
  };
}
