#!/usr/bin/env node
/**
 * scripts/lint.mjs — zero-dependency linter for the linear-agents tree
 *
 * Lint is a completion condition in the DEV contract (agents/dev/CLAUDE.md,
 * hand-off) and a DoD row (docs/FENIX_WORKFLOW.md). A lint that lints nothing
 * and always exits 0 manufactures false evidence, so this tool:
 *   - prints the scope it actually covered (files read, per extension) and an
 *     explicit "Not covered" statement on EVERY run,
 *   - refuses to report clean when the scope resolves to 0 files,
 *   - surfaces unreadable files as violations instead of dropping them.
 *
 * Scope (default mode, run inside the repo):
 *   every file git tracks or would track (git ls-files --cached --others
 *   --exclude-standard) whose extension is .md / .mjs / .js / .jsx / .json.
 *   Gitignored content (node_modules, .state, .codegraph, agent runtime dirs,
 *   nebul wire captures, generated config/atlas-mcp.json, per-agent local
 *   settings files) is never read.
 * Scope (--root <dir>, fixture/testing mode):
 *   a raw recursive walk of <dir>, excluding only .git/.codegraph/node_modules/
 *   .state; no gitignore filtering. The mode is printed on every run.
 *
 * Not covered (stated on every run, see NOT_COVERED below): non-code
 * extensions (.py, .bat, .sh, .yml, .html, ...), Markdown style rules, and
 * semantic/AST-level lint — this is a line-based checker.
 *
 * Rules:
 *   .mjs/.js/.jsx/.json — trailing-whitespace, tab-indentation, conflict-marker, bom
 *   .mjs/.js/.jsx only  — debugger-statement
 *   .json only          — json-parse
 *   .md only            — conflict-marker, bom
 *
 * Output: one line per violation `<file>:<line> <rule> — <detail>` (line 0 =
 * file-level finding, e.g. bom/json-parse/read-error); one `PASS <rule> — N
 * files, 0 violations` line per silent rule; final `OK:` (exit 0) or
 * `FAIL:`/`ERROR:` summary.
 *
 * Usage: node scripts/lint.mjs [--root <dir>]
 * Exit 0 = clean and scope non-empty
 * Exit 1 = violations found, or scope resolved to 0 files
 * Exit 2 = usage error (unknown argument, missing --root value, bad root)
 * Exit 3 = scope unavailable (default mode, git ls-files failed)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');

// ── Scope definition ────────────────────────────────────────────────

const COVERED_EXTENSIONS = ['.md', '.mjs', '.js', '.jsx', '.json'];
const CODE_EXTENSIONS = new Set(['.mjs', '.js', '.jsx']);

// Raw-walk mode (--root) skips these directory names; default (git) mode
// needs none of them — gitignore already keeps runtime/generated content out.
const WALKER_EXCLUDED_DIRS = new Set(['.git', '.codegraph', 'node_modules', '.state']);

const NOT_COVERED = [
  'extensions other than .md/.mjs/.js/.jsx/.json — .py (Python), .bat, .sh, .yml/.yaml, .html, .css and the rest are never read',
  'Markdown style — trailing-whitespace/tab-indentation do not run on .md (pre-existing docs carry trailing whitespace; cleaning them is not this tool\'s job), only conflict-marker and bom do',
  'semantic/AST-level lint (unused variables, import order, type errors) — this is a deterministic line-based checker, not a parser',
  'gitignored and machine-generated content in git mode (node_modules/, .state/, agent runtime dirs, tools/nebul wire captures, generated config/atlas-mcp.json, credential files) — never read, by design',
];

// ── Rules ───────────────────────────────────────────────────────────

// Which rules apply to which extension. Order = output order.
const RULES_BY_EXT = {
  '.md': ['conflict-marker', 'bom'],
  '.mjs': ['trailing-whitespace', 'tab-indentation', 'debugger-statement', 'conflict-marker', 'bom'],
  '.js': ['trailing-whitespace', 'tab-indentation', 'debugger-statement', 'conflict-marker', 'bom'],
  '.jsx': ['trailing-whitespace', 'tab-indentation', 'debugger-statement', 'conflict-marker', 'bom'],
  '.json': ['trailing-whitespace', 'tab-indentation', 'json-parse', 'conflict-marker', 'bom'],
};
const ALL_RULES = ['trailing-whitespace', 'tab-indentation', 'debugger-statement', 'json-parse', 'conflict-marker', 'bom'];

// ── Scope resolution ────────────────────────────────────────────────

/**
 * Resolve the lint scope for `root`.
 * Returns { mode, files: [{rel, ext}], scopeErrors } — files use forward
 * slashes; scopeErrors is non-empty when the scope could not be established
 * (the caller must not report clean in that case).
 */
export function resolveScope(root) {
  const gitDir = path.join(root, '.git');
  const mode = fs.existsSync(gitDir) ? 'git' : 'walk';

  if (mode === 'git') {
    let out;
    try {
      out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      return { mode, files: [], scopeErrors: [`git ls-files failed — ${e.message}`] };
    }
    const files = [];
    for (const rel of out.split('\0')) {
      if (!rel) continue;
      const ext = path.extname(rel).toLowerCase();
      if (!RULES_BY_EXT[ext]) continue;
      files.push({ rel: rel.replace(/\\/g, '/'), ext });
    }
    return { mode, files, scopeErrors: [] };
  }

  // Raw walk (fixture/testing mode, or a directory without .git).
  const files = [];
  const scopeErrors = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      scopeErrors.push(`could not list ${dir} — ${e.code || e.message}`);
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (WALKER_EXCLUDED_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!RULES_BY_EXT[ext]) continue;
        files.push({ rel: path.relative(root, abs).replace(/\\/g, '/'), ext });
      }
      // Symlinks are not followed — a scope built on symlinks would not be
      // the tree on disk, so they are skipped rather than silently read.
    }
  }

  walk(root);
  return { mode, files, scopeErrors };
}

// ── Per-file lint ───────────────────────────────────────────────────

/**
 * Lint one file against the rules for its extension.
 * Returns { violations: [{file, line, rule, detail}], unreadable: 0|1 }.
 * A read failure is a violation (rule `read-error`), never a silent skip.
 */
export function lintFile(root, rel) {
  const abs = path.join(root, rel);
  const violations = [];
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    violations.push({
      file: rel,
      line: 0,
      rule: 'read-error',
      detail: `could not read file (${e.code || e.message}) — scope was not fully covered`,
    });
    return { violations, unreadable: 1 };
  }

  const ext = path.extname(rel).toLowerCase();
  const rules = RULES_BY_EXT[ext] || [];
  if (!rules.length) return { violations, unreadable: 0 };

  // bom — a UTF-8 BOM breaks shebang execution on .mjs and round-trips badly.
  if (rules.includes('bom') && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    violations.push({ file: rel, line: 0, rule: 'bom', detail: 'UTF-8 BOM at start of file' });
  }

  const content = buf.toString('utf8');

  if (ext === '.json') {
    try {
      JSON.parse(content);
    } catch (e) {
      violations.push({ file: rel, line: 0, rule: 'json-parse', detail: e.message });
    }
  }

  const isCode = CODE_EXTENSIONS.has(ext);
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCode && /[ \t]+$/.test(line)) {
      violations.push({ file: rel, line: i + 1, rule: 'trailing-whitespace', detail: 'line ends with a space or tab' });
    }
    if (rules.includes('tab-indentation') && /^\t/.test(line)) {
      violations.push({ file: rel, line: i + 1, rule: 'tab-indentation', detail: 'line starts with a tab' });
    }
    if (isCode && /^\s*debugger\s*;?\s*$/.test(line)) {
      violations.push({ file: rel, line: i + 1, rule: 'debugger-statement', detail: 'standalone debugger statement — debug leftover' });
    }
    if (rules.includes('conflict-marker') && (/^<{7}/.test(line) || /^>{7}/.test(line))) {
      violations.push({ file: rel, line: i + 1, rule: 'conflict-marker', detail: 'unresolved merge conflict marker' });
    }
  }

  return { violations, unreadable: 0 };
}

// ── Whole-tree lint ─────────────────────────────────────────────────

/**
 * Lint everything in scope under `root`.
 * Returns { mode, scopeErrors, files, counts, violations, unreadable }.
 */
export function lintTree(root) {
  const { mode, files, scopeErrors } = resolveScope(root);
  const violations = [];
  let unreadable = 0;
  const counts = {};

  for (const { rel, ext } of files) {
    counts[ext] = (counts[ext] || 0) + 1;
    const r = lintFile(root, rel);
    unreadable += r.unreadable;
    violations.push(...r.violations);
  }

  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  return { mode, scopeErrors, files, counts, violations, unreadable };
}

// ── Reporting ───────────────────────────────────────────────────────

function formatViolation(v) {
  return `${v.file}:${v.line} ${v.rule} — ${v.detail}`;
}

function scopeSummary(counts) {
  const parts = COVERED_EXTENSIONS.filter(ext => counts[ext]).map(ext => `${ext.slice(1)} ${counts[ext]}`);
  return parts.join(', ');
}

function printScopeFooter(result, root) {
  const total = result.files.length;
  const covered = scopeSummary(result.counts);
  // The root is part of the evidence: it names the tree the green/red verdict
  // is about, so an invocation against the wrong tree cannot look right.
  console.log(`Scope covered: ${total} files (${covered || 'none'}) — root: ${root} — mode: ${result.mode === 'git' ? 'git ls-files, gitignore-respecting' : 'raw walk, .git/.codegraph/node_modules/.state excluded'}`);
  for (const nc of NOT_COVERED) {
    console.log(`Not covered: ${nc}`);
  }
  return total;
}

// ── CLI ─────────────────────────────────────────────────────────────

function printUsage(stream) {
  stream('Usage: node scripts/lint.mjs [--root <dir>]');
  stream('  --root <dir>  lint another directory (fixture mode: raw walk, no gitignore)');
  stream('Exit: 0 clean · 1 violations / empty scope · 2 usage · 3 scope unavailable');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  let root = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') {
      printUsage(console.log);
      process.exit(0);
    }
    if (args[i] === '--root') {
      if (i + 1 >= args.length) {
        console.error('lint: --root requires a directory argument');
        printUsage(console.error);
        process.exit(2);
      }
      root = path.resolve(args[++i]);
      continue;
    }
    console.error(`lint: unknown argument '${args[i]}'`);
    printUsage(console.error);
    process.exit(2);
  }

  root = root || DEFAULT_ROOT;
  const rootStat = fs.existsSync(root) ? fs.statSync(root) : null;
  if (!rootStat || !rootStat.isDirectory()) {
    console.error(`lint: root is not an existing directory: ${root}`);
    printUsage(console.error);
    process.exit(2);
  }

  const result = lintTree(root);

  for (const err of result.scopeErrors) {
    console.error(`ERROR: scope unavailable — ${err}`);
    console.error('The tool cannot establish what it would cover, so it refuses to answer.');
    process.exit(3);
  }

  const total = printScopeFooter(result, root);

  if (total === 0) {
    console.log('ERROR: scope resolved to 0 files — nothing was linted; refusing to report clean.');
    process.exit(1);
  }

  for (const v of result.violations) {
    console.log(formatViolation(v));
  }

  // Per-rule PASS line for every silent rule — a rule that did not fire says so.
  const perRuleViolations = {};
  for (const v of result.violations) perRuleViolations[v.rule] = (perRuleViolations[v.rule] || 0) + 1;
  for (const rule of ALL_RULES) {
    const appliesTo = COVERED_EXTENSIONS.filter(ext => RULES_BY_EXT[ext].includes(rule));
    const nFiles = appliesTo.reduce((sum, ext) => sum + (result.counts[ext] || 0), 0);
    if (nFiles === 0) continue; // rule not applicable to this tree
    if (perRuleViolations[rule]) {
      console.log(`FAIL ${rule} — ${perRuleViolations[rule]} violation(s) across ${nFiles} files`);
    } else {
      console.log(`PASS ${rule} — ${nFiles} files, 0 violations`);
    }
  }

  if (result.violations.length === 0) {
    console.log(`OK: ${total} files checked, 0 violations`);
    process.exit(0);
  }
  const suffix = result.unreadable ? ` (incl. ${result.unreadable} unreadable)` : '';
  console.log(`FAIL: ${result.violations.length} violation(s)${suffix} — see lines above`);
  process.exit(1);
}