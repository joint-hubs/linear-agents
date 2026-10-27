#!/usr/bin/env node
/**
 * scripts/check.mjs — Consistency linter for linear-agents repo
 *
 * Checks:
 *   1. Every subagent model: value is a known alias or a slug in models.map
 *   2. Every area.role key in models.map has a corresponding subagent file
 *   2b. Every subagent file has a corresponding area.role key in models.map
 *       (without one, bin/agent.bat silently launches the role on its
 *       hardcoded fallback model, bin/agent.bat:27)
 *   3. Every Linear label clearly referenced in agent prompts exists in labels.json
 *   4. Every config/*.json parses as valid JSON
 *   5. config/models.native.map: format, required roles, allowed values
 *
 * Usage: node scripts/check.mjs
 * Exit 0 = clean, 1 = drift
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Glob helper (no external deps) ──────────────────────────────────

/**
 * Simple recursive glob. Supports * (single dir/file level) and ** (any depth).
 * Only returns files.
 */
function glob(pattern) {
  const parts = pattern.split('/').filter(Boolean);

  function walk(dir, idx) {
    if (idx >= parts.length) {
      try { return fs.statSync(dir).isFile() ? [dir] : []; }
      catch { return []; }
    }

    const part = parts[idx];
    const isLast = idx === parts.length - 1;

    if (part === '**') {
      // ** matches any depth: try matching the rest at this level, then recurse into subdirs
      let results = walk(dir, idx + 1);
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            results = results.concat(walk(path.join(dir, entry.name), idx));
          }
        }
      } catch { /* ignore missing/unreadable */ }
      return results;
    }

    if (part === '*') {
      let results = [];
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            results = results.concat(walk(path.join(dir, entry.name), idx + 1));
          }
        }
      } catch { /* ignore */ }
      return results;
    }

    // Handle file globs in the last segment (e.g. *.md, *.json)
    if (isLast && part.includes('*')) {
      const regex = new RegExp('^' + part.replace(/\*/g, '[^/]*').replace(/\./g, '\\.') + '$');
      let results = [];
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && regex.test(entry.name)) {
            results.push(path.join(dir, entry.name));
          }
        }
      } catch { /* ignore */ }
      return results;
    }

    return walk(path.join(dir, part), idx + 1);
  }

  return walk(ROOT, 0);
}

// ── Helpers ─────────────────────────────────────────────────────────

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Parse YAML frontmatter between --- delimiters.
 * Only extracts top-level scalar keys (no nested YAML).
 */
function parseFrontmatter(content) {
  const lines = content.split('\n');
  if (lines.length < 2 || lines[0].trim() !== '---') return {};
  let end = 1;
  while (end < lines.length && lines[end].trim() !== '---') end++;
  const fm = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const m = line.match(/^(\w+):\s*(.*?)\s*$/);
    if (m) {
      let v = m[2];
      // Strip surrounding YAML quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      // Strip trailing inline comments
      const ci = v.indexOf(' #');
      if (ci !== -1) v = v.slice(0, ci);
      fm[m[1]] = v.trim();
    }
  }
  return fm;
}

// ── 0. config/models.map: regenerate when missing or older than its source ──

/**
 * config/models.map is generated (scripts/gen-model-map.mjs) and gitignored
 * since FOC-779, so a fresh clone starts WITHOUT it — the old behaviour
 * reported MISSING and ran no model checks. Instead, regenerate it here from
 * config/models.json (the committed source of truth) whenever the map is
 * missing or older than that file, then validate as below.
 *
 * Exported so the test suite runs the same regeneration through this seam.
 * Never throws: a failed regeneration is reported to the caller, which logs
 * it and lets the model checks below report MISSING.
 *
 * @param {object} [opts]
 * @param {string} [opts.root] repo root (default: this checkout)
 * @param {Function} [opts.spawnFn] injectable spawn of gen-model-map (tests); default spawnSync node <script>, shell:false
 * @returns {{ status: 'ok'|'regenerated'|'failed', reason: string|null }}
 */
export function ensureModelsMap({ root = ROOT, spawnFn } = {}) {
  const src = path.join(root, 'config', 'models.json');
  const dst = path.join(root, 'config', 'models.map');
  const script = path.join(root, 'scripts', 'gen-model-map.mjs');

  const mtime = (p) => {
    try { return fs.statSync(p).mtimeMs; } catch { return null; }
  };
  const mapM = mtime(dst);
  const srcM = mtime(src);
  const reason =
    mapM === null ? 'missing' :
    srcM !== null && mapM < srcM ? 'older than config/models.json' :
    null;
  if (!reason) return { status: 'ok', reason: null };

  if (!fs.existsSync(script)) {
    return { status: 'failed', reason: `${reason}, and scripts/gen-model-map.mjs not found to regenerate it` };
  }
  const run = spawnFn ||
    ((args, opts) => spawnSync(process.execPath, args, { ...opts, shell: false }));
  const res = run([script], { cwd: root, encoding: 'utf-8' });
  if ((res && res.error) || (res && res.status !== 0)) {
    const tail = (((res && res.stderr) || '') + '').trim().split('\n').pop() || 'unknown error';
    return { status: 'failed', reason: `${reason} — regeneration failed: ${tail}` };
  }
  return { status: 'regenerated', reason };
}

// The module is also imported for its exported helper (check.test.mjs runs the
// regeneration through this seam); everything from the State block on only
// runs when invoked as a script — an import must not check anything or exit.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {

// ── State ───────────────────────────────────────────────────────────

const violations = [];

function report(file, reason) {
  violations.push(`${file}: ${reason}`);
}

const ensured = ensureModelsMap();
if (ensured.status === 'regenerated') {
  console.log(`  PASS  config/models.map  →  regenerated (${ensured.reason})`);
} else if (ensured.status === 'failed') {
  report('config/models.map', `${ensured.reason} — the model checks below run against nothing`);
}

// ── 1. Read models.map ───────────────────────────────────────────────

const MODELS_MAP_PATH = path.join(ROOT, 'config', 'models.map');
const modelsMapRaw = readFileSafe(MODELS_MAP_PATH);

// ── 2. Parse models.map ──────────────────────────────────────────────

const areaRoleKeys = [];   // { key: 'area.role', slug: '...' }
const allSlugs = new Set(); // all RHS slugs from models.map

if (modelsMapRaw === null) {
  report('config/models.map', 'MISSING — cannot run model checks');
} else {
  for (const line of modelsMapRaw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const slug = trimmed.slice(eqIdx + 1).trim();
    allSlugs.add(slug);
    if (!key.startsWith('_id.')) {
      areaRoleKeys.push({ key, slug });
    }
  }
}

// Known model aliases that don't need to be in models.map
const KNOWN_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'inherit']);

// ── 3. Collect subagent files ────────────────────────────────────────

const subagentFiles = glob('agents/*/agents/*.md');
const subagentRelPaths = subagentFiles
  .map(f => path.relative(ROOT, f).replace(/\\/g, '/'));

// Build set of existing subagent identifiers (area.role)
const existingSubagents = new Set();
for (const rel of subagentRelPaths) {
  const parts = rel.split('/');
  if (parts.length === 4 && parts[0] === 'agents' && parts[2] === 'agents') {
    const area = parts[1];
    const role = parts[3].replace(/\.md$/, '');
    existingSubagents.add(`${area}.${role}`);
  }
}

// ── 4. Check 1: Subagent model values ────────────────────────────────

for (const rel of subagentRelPaths) {
  const abs = path.join(ROOT, rel);
  const content = readFileSafe(abs);
  if (content === null) {
    report(rel, 'MISSING — cannot read');
    continue;
  }
  const fm = parseFrontmatter(content);
  const modelVal = fm.model;
  if (!modelVal) {
    report(rel, 'no model: in frontmatter');
    continue;
  }
  if (KNOWN_ALIASES.has(modelVal)) continue;
  if (allSlugs.has(modelVal)) continue;
  report(rel, `model '${modelVal}' not in models.map`);
}

// ── 5. Check 2: area.role keys have subagent files ──────────────────

const areaRoleKeySet = new Set(areaRoleKeys.map(k => k.key));

for (const { key } of areaRoleKeys) {
  if (!existingSubagents.has(key)) {
    const [area, role] = key.split('.');
    report(`config/models.map key '${key}'`, `has no subagent file agents/${area}/agents/${role}.md`);
  }
}

// ── 5. Check 2b: subagent files have area.role keys (reverse) ───────

for (const key of existingSubagents) {
  if (!areaRoleKeySet.has(key)) {
    const [area, role] = key.split('.');
    report(`agents/${area}/agents/${role}.md`, `has no config/models.map key '${key}'`);
  }
}

// ── 5. Check 3: Linear labels in agent prompts ──────────────────────
//
// Pattern used (conservative):
//   a) Backtick-quoted tokens matching `group:name` where `group` is a
//      known label group from labels.json (type, needs, risk, ai).
//   b) Backtick-quoted tokens that exactly match a known flag name
//      (dor-ok, escalated, over-budget, transcript-uncertain, blocked,
//      stage:testing).
//   c) Bare label names without group prefix (e.g. `spike`, `tech`) are
//      SKIPPED to avoid false positives.
//   d) Wildcard patterns like `needs:*` or `type:*` are SKIPPED.
//   e) Non-label backtick tokens (status names, relation types) are
//      naturally excluded since they don't match (a) or (b).

const LABELS_PATH = path.join(ROOT, 'config', 'linear', 'labels.json');
const labelsRaw = readFileSafe(LABELS_PATH);

if (labelsRaw === null) {
  report('config/linear/labels.json', 'MISSING — cannot run label check');
} else {
  let labelGroups = {};
  let labelFlags = [];
  try {
    const parsed = JSON.parse(labelsRaw);
    labelGroups = parsed.groups || {};
    labelFlags = parsed.flags || [];
  } catch (e) {
    // Caught by check 4 below
  }

  const knownGroups = new Set(Object.keys(labelGroups));

  // Build set of valid label ids: "type:spike", "needs:answer", "escalated", etc.
  const validLabels = new Set();
  for (const [group, config] of Object.entries(labelGroups)) {
    if (config.labels && Array.isArray(config.labels)) {
      for (const label of config.labels) {
        validLabels.add(`${group}:${label}`);
      }
    }
  }
  for (const flag of labelFlags) {
    validLabels.add(flag);
  }

  // Collect all agent prompt files
  const agentPromptFiles = [
    ...subagentRelPaths,
    ...glob('agents/*/CLAUDE.md')
      .map(f => path.relative(ROOT, f).replace(/\\/g, '/')),
  ];

  for (const rel of agentPromptFiles) {
    const abs = path.join(ROOT, rel);
    const content = readFileSafe(abs);
    if (content === null) continue;

    // Find all backtick-quoted strings
    const backtickRegex = /`([^`]+)`/g;
    let match;
    while ((match = backtickRegex.exec(content)) !== null) {
      const token = match[1].trim();

      // Pattern (a): group:name where group is a known label group
      const groupMatch = token.match(/^(\w+):([\w*][\w-]*)$/);
      if (groupMatch && knownGroups.has(groupMatch[1])) {
        const fullId = token;
        // Skip wildcard patterns like `needs:*`, `type:*`
        if (fullId.endsWith(':*')) continue;
        if (!validLabels.has(fullId)) {
          report(rel, `label '${fullId}' not in config/linear/labels.json`);
        }
        continue;
      }

      // Pattern (b): bare flag name
      if (labelFlags.includes(token)) {
        // Already in validLabels, no need to check existence
        continue;
      }

      // Pattern (c) and (d): skip bare names and wildcards
    }
  }
}

// ── 6. Check 4: config/*.json must parse ─────────────────────────────

const configJsonFiles = glob('config/**/*.json');
for (const abs of configJsonFiles) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const content = readFileSafe(abs);
  if (content === null) {
    report(rel, 'MISSING');
    continue;
  }
  try {
    JSON.parse(content);
  } catch (e) {
    report(rel, `invalid JSON: ${e.message}`);
  }
}

// ── 7. Check 5: config/models.native.map ──────────────────────────────

const NATIVE_MAP_PATH = path.join(ROOT, 'config', 'models.native.map');
const nativeMapRaw = readFileSafe(NATIVE_MAP_PATH);

const REQUIRED_NATIVE_ROLES = [
  'plan.lead',
  'plan.discovery',
  'plan.spec',
  'plan.spec-review',
  'plan.decomposer',
  'plan.push',
];

const ALLOWED_NATIVE_VALUES = new Set(['claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);

if (nativeMapRaw === null) {
  report('config/models.native.map', 'MISSING');
} else {
  const seenRoles = new Set();
  const lines = nativeMapRaw.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      report(`config/models.native.map:${i + 1}`, `no '=' found in line`);
      continue;
    }

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    if (!key.includes('.')) {
      report(`config/models.native.map:${i + 1}`, `key '${key}' is not in area.role format`);
      continue;
    }

    if (!ALLOWED_NATIVE_VALUES.has(value)) {
      report(`config/models.native.map:${i + 1}`, `value '${value}' not in {claude-opus-5, claude-sonnet-4-6, claude-haiku-4-5-20251001}`);
    }

    seenRoles.add(key);
  }

  for (const role of REQUIRED_NATIVE_ROLES) {
    if (!seenRoles.has(role)) {
      report('config/models.native.map', `missing required role '${role}'`);
    }
  }
}

// ── 8. Check 6: dry-run launcher actually runs dry ──────────────────
//
// Two accepted forms for bin/<squad>-dry.bat:
//   1. Wrapper form (FOC-771): a node line running squad-start.mjs for the
//      squad with --dry-run — the Node side sets <SQUAD>_DRY_RUN=1.
//   2. Legacy _lib.bat form: an explicit `set "<SQUAD>_DRY_RUN=1"` line
//      (fallback only; no launcher should still call _lib.bat).
// Anything else is drift — a dry wrapper naming the squad without --dry-run
// launches the real pipeline.

const dryBatFiles = glob('bin/*-dry.bat');
for (const abs of dryBatFiles) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const content = readFileSafe(abs);
  if (content === null) {
    report(rel, 'MISSING — cannot read');
    continue;
  }
  const squad = path.basename(rel).replace(/-dry\.bat$/, '');
  const envVar = `${squad.toUpperCase()}_DRY_RUN`;

  if (/call\s+"%~dp0_lib\.bat"/.test(content)) {
    // Legacy form: keep the original env-flag rule.
    const m = content.match(new RegExp(`set\\s+"?${envVar}=1"?`));
    if (!m) {
      report(rel, `missing \`set "${envVar}=1"\` line`);
    } else {
      console.log(`  PASS  ${rel}  →  ${envVar}=1`);
    }
    continue;
  }

  const nodeLine = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('node '));
  // FOC-1055: operator-facing wrappers carry Node's experimental-warning silencer
  // before the script path. The shape check accepts the flag; the flag itself is
  // pinned by operator-warning-suppression.test.mjs.
  const prefix = `node --disable-warning=ExperimentalWarning "%~dp0..\\scripts\\squad-start.mjs" ${squad}`;
  if (!nodeLine || !(nodeLine === prefix || nodeLine.startsWith(prefix + ' '))) {
    report(rel, `not a squad-start.mjs wrapper for '${squad}' and no \`set "${envVar}=1"\` line`);
    continue;
  }
  if (!/--dry-run\b/.test(nodeLine)) {
    report(rel, `dry wrapper runs '${squad}' without --dry-run`);
    continue;
  }
  console.log(`  PASS  ${rel}  →  node wrapper ${squad} --dry-run`);
}

// ── 9. Check 7: linear scripts CLI surface intact ───────────────────
//
// Run linear-query.mjs and linear-ops.mjs with no args; assert exit 2
// and "Usage" in output.

const linearScripts = ['linear-query.mjs', 'linear-ops.mjs'];
for (const script of linearScripts) {
  const scriptPath = path.join(ROOT, 'scripts', script);
  let exitCode = -1;
  let output = '';
  try {
    output = execFileSync('node', [scriptPath], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    exitCode = 0;
  } catch (e) {
    exitCode = e.status ?? 1;
    output = e.stdout + e.stderr;
  }
  if (exitCode === 2 && /Usage/i.test(output)) {
    console.log(`  PASS  scripts/${script}  →  exit ${exitCode}, has "Usage"`);
  } else {
    report(`scripts/${script}`, `expected exit 2 + "Usage", got exit ${exitCode}`);
  }
}

// ── 10. Check 8: no committed localhost in provider baseUrls (FOC-164) ──
//
// The repo is public; a developer running a local proxy commits localhost into
// config/models.json and breaks every other machine. Drift test: fail if any
// provider baseUrl contains localhost or 127.0.0.1.

const modelsJsonPath = path.join(ROOT, 'config', 'models.json');
const modelsJsonRaw = readFileSafe(modelsJsonPath);
if (modelsJsonRaw !== null) {
  try {
    const modelsConfig = JSON.parse(modelsJsonRaw);
    const providers = modelsConfig.providers || {};
    for (const [name, entry] of Object.entries(providers)) {
      const url = entry?.baseUrl || '';
      if (/localhost|127\.0\.0\.1/.test(url)) {
        report(`config/models.json providers.${name}`, `baseUrl '${url}' contains localhost — use LA_PROVIDER_BASEURL_<NAME> env override for local proxy dev`);
      }
    }
  } catch (e) {
    // Already caught by check 4 (invalid JSON)
  }
}

// ── 11. Report ──────────────────────────────────────────────────────

violations.sort();

for (const v of violations) {
  console.log(v);
}

const count = violations.length;
if (count === 0) {
  console.log(`OK: 9 checks, 0 violations`);
  process.exit(0);
} else {
  console.log(`DRIFT: ${count} violations`);
  process.exit(1);
}

} // end isMain
