#!/usr/bin/env node
/**
 * scripts/security-scan.mjs — provisioned security scanners for the REVIEW path (FOC-285)
 *
 * F-09 (docs/reviews/foc-272-topology-review.md §9): scanners were promised in the
 * review squad's security rules and allow-listed in settings.json, but never
 * provisioned and never called — zero scanner calls corpus-wide. This script is the
 * single invocation a review child runs; it wires TWO scanner types into one command:
 *
 *   1. Secret scanning — secretlint (@secretlint/core, rule preset-recommend),
 *      run in-process from the devDependencies in package.json. The config is built
 *      here (no rc-file discovery to break in worktrees). AWS ID-scan is enabled
 *      explicitly — the preset ships it off by default to cut false positives.
 *   2. SAST — semgrep with the committed local ruleset config/security/semgrep-rules.yml.
 *      No registry, no network: --config points at the local file, metrics off.
 *      The binary can be swapped for a custom launcher via LA_SEMGREP_CMD
 *      (split on whitespace; Docker recipe in docs/tools/security-scan.md).
 *
 * Findings are reported as file:line + rule id + severity ONLY. Matched source
 * lines and rule messages are deliberately NOT echoed — secretlint messages embed
 * the matched secret value, so echoing them would put a secret into the very
 * output that is supposed to prove none leaked (AC4 of FOC-285). The reviewer
 * opens the file at the cited line instead.
 *
 * A scanner that did not run must never look like a pass: an unavailable tool is
 * an explicit "Not scanned" line and a non-zero exit, never a silent clean.
 *
 * Scope (default mode, run inside the repo):
 *   every file git tracks or would track (git ls-files --cached --others
 *   --exclude-standard). Binary-looking files (NUL byte in the first 8 KiB) and
 *   files over MAX_SCAN_BYTES are skipped, and every skip is counted in the report.
 *   Gitignored content is never scanned.
 * Scope (--root <dir>, fixture/testing mode):
 *   a raw recursive walk of <dir> excluding .git/.codegraph/node_modules/.state;
 *   no gitignore filtering. The mode is printed on every run.
 *
 * Semgrep targets the root directory itself and applies its own ignore cascade;
 * its javascript/typescript rules only fire on code files, so the two scanners
 * intentionally see slightly different scope (stated in docs/tools/security-scan.md).
 *
 * Usage: node scripts/security-scan.mjs [--root <dir>] [--json] [--output <file>]
 * Exit 0 = both scanners ran, no findings
 * Exit 1 = findings found (loudest fact wins over exit 2)
 * Exit 2 = a scanner was unavailable or errored — incomplete evidence (or usage error)
 * Exit 3 = scope unavailable (git ls-files failed, unreadable files, missing ruleset)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const SEMGREP_RULES = path.join(DEFAULT_ROOT, 'config', 'security', 'semgrep-rules.yml');

const MAX_SCAN_BYTES = 1024 * 1024; // skip files > 1 MiB (runtime guard, counted in report)
const SNIFF_BYTES = 8192;           // a NUL byte inside this window marks the file binary
const WALKER_EXCLUDED_DIRS = new Set(['.git', '.codegraph', 'node_modules', '.state']);
const SEMGREP_TIMEOUT_MS = 10 * 60 * 1000;

// ── Secretlint config (single source, no rc-file discovery) ──────────

// Per-rule options inside the preset: the AWS rule ships enableIDScanRule=false
// (bare AKIA patterns are false-positive-prone), so the review path turns it on
// explicitly — a key ID without context is exactly what this scanner exists to catch.
const SECRETLINT_CONFIG_DESCRIPTOR = {
  rules: [
    {
      id: '@secretlint/secretlint-rule-preset-recommend',
      rules: [
        { id: '@secretlint/secretlint-rule-aws', options: { enableIDScanRule: true } },
      ],
    },
  ],
};

// ── Scope resolution (mirrors scripts/lint.mjs) ──────────────────────

/**
 * Resolve the scan scope for `root`.
 * Returns { mode, files, skippedBinary, skippedLarge, unreadable, scopeErrors } —
 * `files` holds the text files to scan (forward-slash rel paths); the skip lists
 * are surfaced in the report so nothing disappears silently.
 */
export function resolveScope(root) {
  const mode = fs.existsSync(path.join(root, '.git')) ? 'git' : 'walk';

  let candidates;
  let scopeErrors = [];
  if (mode === 'git') {
    let out;
    try {
      out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      return { mode, files: [], skippedBinary: [], skippedLarge: [], unreadable: [], scopeErrors: [`git ls-files failed — ${e.message}`] };
    }
    candidates = out.split('\0').filter(Boolean);
  } else {
    candidates = [];
    walk(root, '', candidates);
    const unreadableDirs = candidates.filter((c) => c.startsWith('UNREADABLE_DIR:'));
    candidates = candidates.filter((c) => !c.startsWith('UNREADABLE_DIR:'));
    scopeErrors = unreadableDirs.map((c) => `${c.slice('UNREADABLE_DIR:'.length)} — directory could not be listed`);
  }

  const files = [];
  const skippedBinary = [];
  const skippedLarge = [];
  const unreadable = [];
  for (const rel of candidates) {
    const abs = path.join(root, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (e) {
      unreadable.push(rel);
      continue;
    }
    if (buf.length > MAX_SCAN_BYTES) {
      skippedLarge.push(rel);
      continue;
    }
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) {
      skippedBinary.push(rel);
      continue;
    }
    files.push(rel.replace(/\\/g, '/'));
  }
  return { mode, files, skippedBinary, skippedLarge, unreadable, scopeErrors };
}

function walk(dir, prefix, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    out.push(`UNREADABLE_DIR:${prefix || dir}`); // surfaced as a scope error, never skipped silently
    return;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (WALKER_EXCLUDED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

// ── Scanner 1: secretlint (in-process) ───────────────────────────────

/**
 * Run the secretlint pass over `files`.
 * Returns { tool, status: 'ok'|'unavailable'|'error', version, reason?, findings }.
 * Findings carry file/line/rule/severity only — never the matched value.
 */
export async function scanSecrets(root, files) {
  let lintSource;
  let loadPackagesFromConfigDescriptor;
  try {
    ({ lintSource } = await import('@secretlint/core'));
    ({ loadPackagesFromConfigDescriptor } = await import('@secretlint/config-loader'));
  } catch (e) {
    return { tool: 'secretlint', status: 'unavailable', reason: `secretlint modules not installed — run: npm install [${e.code || e.message}]`, findings: [] };
  }

  let config;
  try {
    const loaded = await loadPackagesFromConfigDescriptor({ configDescriptor: SECRETLINT_CONFIG_DESCRIPTOR });
    config = loaded.config;
  } catch (e) {
    return { tool: 'secretlint', status: 'error', reason: `secretlint config load failed — ${e.message}`, findings: [] };
  }

  const findings = [];
  try {
    let index = 0;
    async function worker() {
      while (index < files.length) {
        const rel = files[index++];
        let content;
        try {
          content = fs.readFileSync(path.join(root, rel), 'utf8');
        } catch (e) {
          continue; // vanished mid-scan — the resolve pass already surfaced read failures
        }
        const result = await lintSource({
          source: { filePath: rel, content, ext: path.extname(rel), contentType: 'text' },
          options: { config },
        });
        for (const m of result.messages) {
          findings.push({
            tool: 'secretlint',
            rule: m.ruleId,
            file: rel,
            line: m.loc && m.loc.start ? m.loc.start.line : 0,
            severity: m.severity || 'error',
          });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, files.length)) }, worker));
  } catch (e) {
    return { tool: 'secretlint', status: 'error', reason: `secretlint pass failed — ${e.message}`, findings: [] };
  }

  return { tool: 'secretlint', status: 'ok', version: secretlintVersion(), findings };
}

function secretlintVersion() {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@secretlint/secretlint-rule-preset-recommend/package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch (e) {
    return 'unknown';
  }
}

// ── Scanner 2: semgrep (child process, local ruleset) ────────────────

/**
 * Resolve the scanner command from LA_SEMGREP_CMD (FOC-576).
 * Unset → the historical native invocation, byte-identical. Set → the value is
 * split on whitespace: the first token is the executable, the rest are fixed
 * args prepended to every semgrep argv (scan + --version). No shell, no
 * quoting — a single token containing spaces is unsupported
 * (docs/tools/security-scan.md). Set but blank → `misconfigured`: the caller
 * must fail closed rather than silently fall back to native semgrep.
 */
function scannerCmd() {
  const raw = process.env.LA_SEMGREP_CMD;
  if (raw === undefined) return { cmd: 'semgrep', prefix: [], misconfigured: false };
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { cmd: 'semgrep', prefix: [], misconfigured: true };
  return { cmd: tokens[0], prefix: tokens.slice(1), misconfigured: false };
}

/**
 * Run the semgrep SAST pass over `root` with the committed local ruleset.
 * Returns the same row shape as scanSecrets.
 */
export function scanSast(root, rulesPath = SEMGREP_RULES, { noGitIgnore = false } = {}) {
  if (!fs.existsSync(rulesPath)) {
    return { tool: 'semgrep', status: 'unavailable', reason: `ruleset missing: ${rulesPath}`, findings: [] };
  }

  const { cmd, prefix, misconfigured } = scannerCmd();
  if (misconfigured) {
    // A set-but-blank LA_SEMGREP_CMD is a misconfiguration, not a request for
    // the native default: failing closed keeps a half-configured run from
    // silently degrading to whatever binary happens to be on PATH (FOC-576).
    return {
      tool: 'semgrep',
      status: 'error',
      reason: 'LA_SEMGREP_CMD is set but empty/whitespace-only — refusing to fall back to native semgrep (fail closed; see docs/tools/security-scan.md)',
      findings: [],
    };
  }

  // A configured launcher (e.g. `docker run ... -w /src ... semgrep`) views the
  // filesystem differently from this process: the documented Docker recipe
  // mounts the repo at /src and sets it as the container workdir, which equals
  // the spawn cwd (root) on the host. Root-relative forward-slash paths
  // therefore resolve to the same files in both worlds, while host absolute
  // paths would only resolve natively. The unset (native) case keeps the
  // historical absolute argv byte-identical (FOC-576). The Docker recipe itself
  // is live-verification pending — NOT verified: the image pull fails on this
  // machine (Docker Desktop internal proxy cuts blob downloads with EOF).
  const configured = prefix.length > 0 || cmd !== 'semgrep';
  const semgrepArgs = [
    ...prefix,
    'scan',
    '--config', configured ? path.relative(root, rulesPath).replace(/\\/g, '/') : rulesPath,
    '--json',
    '--error',
    '--quiet',
    '--metrics=off',
    // Without this semgrep prefixes every check_id with the config file path
    // ("config.security.security.eval-usage") — the YAML id is what the review
    // report cites.
    '--no-rewrite-rule-ids',
    // Fixture mode (--root outside git tracking): semgrep consults the nearest
    // .gitignore cascade even for a non-repo target, which would silently skip
    // fixtures under .state/ — the flag turns that off there. Git mode keeps the
    // default cascade, matching the lint.mjs scope philosophy.
    ...(noGitIgnore ? ['--no-git-ignore'] : []),
    configured ? '.' : root,
  ];
  const res = spawnSync(cmd, semgrepArgs, {
    cwd: root,
    encoding: 'utf-8',
    timeout: SEMGREP_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, SEMGREP_SEND_METRICS: 'off' },
  });

  if (res.error && res.error.code === 'ENOENT') {
    const reason = configured
      ? `configured scanner command not found: '${cmd}' (LA_SEMGREP_CMD) — see docs/tools/security-scan.md`
      : 'semgrep not on PATH — run: pip install semgrep==1.172.0 (see docs/tools/security-scan.md)';
    return { tool: 'semgrep', status: 'unavailable', reason, findings: [] };
  }

  // Empty stdout is the evidence failure itself, whatever the exit code: no
  // output means no scan happened. Parsing nothing into a fake-clean `{}` is
  // exactly how a dead scanner used to read as a clean one (FOC-576).
  if (!(res.stdout || '').trim()) {
    return {
      tool: 'semgrep',
      status: 'error',
      reason: `semgrep produced no output (exit ${res.status}) — no scan evidence`,
      findings: [],
    };
  }

  // semgrep --json prints pure JSON on stdout (banner text goes to stderr).
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    return {
      tool: 'semgrep',
      status: 'error',
      reason: `semgrep output was not JSON (exit ${res.status}) — stderr: ${(res.stderr || '').slice(0, 200).replace(/\s+/g, ' ')}`,
      findings: [],
    };
  }

  if (res.error) {
    return { tool: 'semgrep', status: 'error', reason: `semgrep failed — ${res.error.message}`, findings: [] };
  }
  // Warn-level entries (e.g. PartialParsing) do not void the pass; only
  // error-level ones mean the scan evidence is incomplete.
  const hardErrors = (parsed.errors || []).filter((e) => e.level === 'error');
  if (hardErrors.length) {
    const first = hardErrors[0];
    return {
      tool: 'semgrep',
      status: 'error',
      reason: `semgrep reported ${hardErrors.length} scan error(s); first: ${String(first.message || first.type || 'unknown').slice(0, 160)}`,
      findings: [],
    };
  }

  const findings = (parsed.results || []).map((r) => {
    // semgrep echoes absolute paths when given a directory target — normalize to
    // root-relative (forward slashes) so report rows match the secretlint rows.
    // Relative result paths (a configured-command target '.') resolve against
    // the scan root; absolute paths pass through unchanged, so the native case
    // is unaffected.
    const absPath = path.resolve(root, String(r.path || ''));
    const rel = absPath.startsWith(path.resolve(root))
      ? path.relative(path.resolve(root), absPath).replace(/\\/g, '/')
      : absPath.replace(/\\/g, '/');
    return {
      tool: 'semgrep',
      rule: r.check_id,
      file: rel,
      line: r.start && r.start.line ? r.start.line : 0,
      severity: (r.extra && r.extra.severity) || 'WARNING',
    };
  });
  // A scan whose scanner version cannot be attested is not evidence: 'ok' with
  // version 'unknown' would let an unverifiable run read as a clean one (FOC-576).
  const version = semgrepVersion();
  if (version === 'unknown') {
    return {
      tool: 'semgrep',
      status: 'error',
      reason: 'semgrep version could not be determined (no x.y.z line from semgrep --version) — scan evidence cannot be attributed to a scanner version',
      findings,
    };
  }
  return { tool: 'semgrep', status: 'ok', version, findings };
}

function semgrepVersion() {
  // Same configured command as the scan itself — the version must attest the
  // scanner that actually produced the evidence (FOC-576).
  const { cmd, prefix, misconfigured } = scannerCmd();
  if (misconfigured) return 'unknown';
  const res = spawnSync(cmd, [...prefix, '--version'], { encoding: 'utf-8', timeout: 30000 });
  const line = (res.stdout || '').split(/\r?\n/).find((l) => /^\d+\.\d+\.\d+/.test(l.trim()));
  return line ? line.trim() : 'unknown';
}

// ── Reporting ────────────────────────────────────────────────────────

function fmtRow(f) {
  return `  [${f.tool}] ${f.file}:${f.line} ${f.rule} (${f.severity})`;
}

/**
 * Build the human-readable report lines. No file content, no rule message
 * text, no matched lines — ever (FOC-285 AC4).
 */
export function humanReport({ scope, tools }) {
  const lines = [];
  const extCounts = {};
  for (const rel of scope.files) {
    const ext = path.extname(rel).toLowerCase() || '(none)';
    extCounts[ext] = (extCounts[ext] || 0) + 1;
  }
  const parts = Object.entries(extCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([e, n]) => `${e} ${n}`);
  lines.push(`Scope covered: ${scope.files.length} files (${parts.join(', ')}) — root: ${scope.root} — mode: ${scope.mode === 'git' ? 'git ls-files, gitignore-respecting' : 'raw walk, .git/.codegraph/node_modules/.state excluded'}`);
  if (scope.skippedBinary.length) lines.push(`Skipped (binary): ${scope.skippedBinary.length} file(s)`);
  if (scope.skippedLarge.length) lines.push(`Skipped (> 1 MiB): ${scope.skippedLarge.length} file(s)`);

  for (const t of tools) {
    if (t.status === 'ok') {
      if (t.findings.length === 0) {
        lines.push(`PASS ${t.tool} (${t.version || 'version unknown'}) — 0 findings`);
      } else {
        lines.push(`FAIL ${t.tool} (${t.version || 'version unknown'}) — ${t.findings.length} finding(s):`);
        for (const f of t.findings) lines.push(fmtRow(f));
      }
    } else {
      lines.push(`NOT SCANNED ${t.tool} — ${t.reason}`);
      lines.push('  (a scanner that did not run is never reported as clean)');
    }
  }
  return lines;
}

// ── CLI ──────────────────────────────────────────────────────────────

function printUsage(stream) {
  stream('Usage: node scripts/security-scan.mjs [--root <dir>] [--json] [--output <file>]');
  stream('  --root <dir>    scan another directory (fixture mode: raw walk, no gitignore)');
  stream('  --json          print the machine-readable report');
  stream('  --output <file> write the JSON report to <file> (e.g. .state/security-scan.json)');
  stream('Exit: 0 clean · 1 findings · 2 scanner unavailable · 3 scope unavailable');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  let root = null;
  let jsonMode = false;
  let outputFile = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') {
      printUsage(console.log);
      process.exit(0);
    }
    if (args[i] === '--json') {
      jsonMode = true;
      continue;
    }
    if (args[i] === '--root') {
      if (i + 1 >= args.length) {
        console.error('security-scan: --root requires a directory argument');
        printUsage(console.error);
        process.exit(2);
      }
      root = path.resolve(args[++i]);
      continue;
    }
    if (args[i] === '--output') {
      if (i + 1 >= args.length) {
        console.error('security-scan: --output requires a file argument');
        printUsage(console.error);
        process.exit(2);
      }
      outputFile = path.resolve(args[++i]);
      continue;
    }
    console.error(`security-scan: unknown argument '${args[i]}'`);
    printUsage(console.error);
    process.exit(2);
  }

  root = root || DEFAULT_ROOT;
  const rootStat = fs.existsSync(root) ? fs.statSync(root) : null;
  if (!rootStat || !rootStat.isDirectory()) {
    console.error(`security-scan: root is not an existing directory: ${root}`);
    printUsage(console.error);
    process.exit(2);
  }
  if (!fs.existsSync(SEMGREP_RULES)) {
    console.error(`security-scan: ruleset missing: ${SEMGREP_RULES} — repo wiring is broken; refusing to scan`);
    process.exit(3);
  }

  const scope = { ...resolveScope(root), root };
  if (scope.scopeErrors.length) {
    for (const err of scope.scopeErrors) console.error(`ERROR: scope unavailable — ${err}`);
    console.error('The tool cannot establish what it would cover, so it refuses to answer.');
    process.exit(3);
  }
  if (scope.unreadable.length) {
    // Mirrors lint.mjs: a file that cannot be read is a coverage hole, not a silent skip.
    console.error(`ERROR: scope unavailable — ${scope.unreadable.length} file(s) unreadable, first: ${scope.unreadable[0]}`);
    process.exit(3);
  }

  const secrets = await scanSecrets(root, scope.files);
  const sast = scanSast(root, SEMGREP_RULES, { noGitIgnore: scope.mode === 'walk' });
  const tools = [secrets, sast];

  const lines = humanReport({ scope, tools });
  if (!jsonMode) {
    for (const line of lines) console.log(line);
  }

  const ranClean = tools.every((t) => t.status === 'ok');
  const totalFindings = tools.reduce((sum, t) => sum + t.findings.length, 0);

  if (jsonMode || outputFile) {
    const report = {
      ok: ranClean && totalFindings === 0,
      exitCode: totalFindings > 0 ? 1 : ranClean ? 0 : 2,
      scope: {
        root,
        mode: scope.mode,
        files: scope.files.length,
        skippedBinary: scope.skippedBinary.length,
        skippedLarge: scope.skippedLarge.length,
        unreadable: scope.unreadable.length,
      },
      tools: tools.map((t) => ({
        tool: t.tool,
        status: t.status,
        version: t.version,
        reason: t.reason,
        findingsCount: t.findings.length,
        findings: t.findings,
      })),
      note: 'file/line/rule/severity only — matched values are never emitted (FOC-285 AC4)',
    };
    const json = JSON.stringify(report, null, 2);
    if (outputFile) fs.writeFileSync(outputFile, json + '\n');
    if (jsonMode) console.log(json);
  }

  if (jsonMode) {
    // Pure JSON on stdout: the machine contract is the whole answer — the human
    // summary rows and the exit code field above carry the rest.
    process.exit(totalFindings > 0 ? 1 : ranClean ? 0 : 2);
  }

  if (totalFindings > 0) {
    console.log(`FAIL: ${totalFindings} finding(s) across ${tools.filter((t) => t.status === 'ok').length} scanner(s) — see rows above`);
    process.exit(1);
  }
  if (!ranClean) {
    console.log('INCOMPLETE: at least one scanner did not run cleanly — no full-clean verdict is possible');
    process.exit(2);
  }
  console.log(`OK: ${scope.files.length} files, 2 scanners, 0 findings`);
  process.exit(0);
}