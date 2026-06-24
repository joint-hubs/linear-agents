#!/usr/bin/env node
/**
 * scripts/check.mjs — Consistency linter for linear-agents repo
 *
 * Checks:
 *   1. Every subagent model: value is a known alias or a slug in models.map
 *   2. Every area.role key in models.map has a corresponding subagent file
 *   3. Every Linear label clearly referenced in agent prompts exists in labels.json
 *   4. Every config/*.json parses as valid JSON
 *   5. config/models.native.map: format, required roles, allowed values
 *
 * Usage: node scripts/check.mjs
 * Exit 0 = clean, 1 = drift
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ── State ───────────────────────────────────────────────────────────

const violations = [];

function report(file, reason) {
  violations.push(`${file}: ${reason}`);
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

for (const { key } of areaRoleKeys) {
  if (!existingSubagents.has(key)) {
    const [area, role] = key.split('.');
    report(`config/models.map key '${key}'`, `has no subagent file agents/${area}/agents/${role}.md`);
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

const ALLOWED_NATIVE_VALUES = new Set(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);

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
      report(`config/models.native.map:${i + 1}`, `value '${value}' not in {claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001}`);
    }

    seenRoles.add(key);
  }

  for (const role of REQUIRED_NATIVE_ROLES) {
    if (!seenRoles.has(role)) {
      report('config/models.native.map', `missing required role '${role}'`);
    }
  }
}

// ── 8. Report ───────────────────────────────────────────────────────

violations.sort();

for (const v of violations) {
  console.log(v);
}

const count = violations.length;
if (count === 0) {
  console.log(`OK: 5 checks, 0 violations`);
  process.exit(0);
} else {
  console.log(`DRIFT: ${count} violations`);
  process.exit(1);
}
