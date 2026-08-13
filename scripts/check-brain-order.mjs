#!/usr/bin/env node
/**
 * scripts/check-brain-order.mjs — Structural-order assertion for squad brain prompts
 *
 * Asserts that each squad brain (`agents/<brain>/CLAUDE.md`) declares its v2 canonical
 * section markers in the order defined by ADR-0006 (D1). The assertion is structural
 * (marker topology), not lexical: it records the first line where each `<xxx_*>` tag
 * appears and checks that line numbers strictly increase in canonical order.
 *
 * The orchestrator brain is whitelisted: it has no squad-only markers
 * (`<xxx_linear_tools>`, `<xxx_squad>`, `<xxx_delegation_policy>`, `<xxx_tools>`,
 * `<xxx_loop>`, `<examples>`, domain extras) — only the relative order of the three
 * markers it does have (`<precedence_policy>` → `<doubt_defaults>` → `<final_reminders>`)
 * is enforced.
 *
 * Usage:
 *   node scripts/check-brain-order.mjs              # check all 6 brains
 *   node scripts/check-brain-order.mjs --brain dev  # check one brain (smoke)
 *   node scripts/check-brain-order.mjs --help       # print usage
 *
 * Exit 0 = all PASS, 1 = one or more FAIL (DRIFT).
 *
 * Zero external dependencies — only node:fs, node:path, node:url.
 * Dry-run safe: read-only, never writes or mutates.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── Canonical marker sequences (ADR-0006 D1) ────────────────────────────
// Each entry: ordered list of marker tags as they must appear top-down.
// The first line where each tag appears must strictly increase.

const CANONICAL = {
  // Orchestrator is whitelisted: squad-only markers are N/A (not enforced, not FAIL).
  orchestrator: [
    'precedence_policy',
    'doubt_defaults',
    'final_reminders',
  ],
  plan: [
    'precedence_policy',
    'plan_linear_tools',
    'plan_squad',
    'plan_delegation_policy',
    'plan_tools',
    'plan_loop',
    'plan_hard_rules',
    'plan_dry_run',
    'plan_comment_helpers',
    'doubt_defaults',
    'examples',
    'final_reminders',
  ],
  dev: [
    'precedence_policy',
    'dev_linear_tools',
    'dev_squad',
    'dev_delegation_policy',
    'dev_tools',
    'dev_loop',
    'dev_hard_rules',
    'dev_types',
    'doubt_defaults',
    'examples',
    'final_reminders',
  ],
  review: [
    'precedence_policy',
    'review_linear_tools',
    'review_squad',
    'review_delegation_policy',
    'review_tools',
    'review_loop',
    'review_hard_rules',
    'review_file_writes',
    'doubt_defaults',
    'examples',
    'final_reminders',
  ],
  test: [
    'precedence_policy',
    'test_linear_tools',
    'test_squad',
    'test_delegation_policy',
    'test_tools',
    'test_loop',
    'test_hard_rules',
    'test_dry_run',
    'test_comment_helper',
    'doubt_defaults',
    'examples',
    'final_reminders',
  ],
  cadence: [
    'precedence_policy',
    'cadence_linear_tools',
    'cadence_squad',
    'cadence_delegation_policy',
    'cadence_tools',
    'cadence_loop',
    'cadence_hard_rules',
    'cadence_file_writes',
    'cadence_dry_run',
    'doubt_defaults',
    'examples',
    'final_reminders',
  ],
};

const BRAINS = Object.keys(CANONICAL);

// ── Helpers ────────────────────────────────────────────────────────────

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * For each marker tag, find the first 1-based line number where a line starts
 * with `<tag>` (opening tag at column 0). Returns Map<tag, lineNumber>.
 */
function findMarkerLines(content, tags) {
  const lines = content.split('\n');
  const found = new Map();
  for (const tag of tags) {
    const pattern = new RegExp(`^\\s*<${tag}>`);
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        found.set(tag, i + 1);
        break;
      }
    }
  }
  return found;
}

/**
 * Assert one brain's marker order. Returns { brain, pass, markers, missing, outOfOrder }.
 *   markers: Map<tag, line> for found markers (in canonical order)
 *   missing: array of missing tags
 *   outOfOrder: array of { tag, line, prevTag, prevLine }
 */
function assertBrain(brain) {
  const seq = CANONICAL[brain];
  const filePath = path.join(ROOT, 'agents', brain, 'CLAUDE.md');
  const content = readFileSafe(filePath);

  if (content === null) {
    return { brain, pass: false, markers: new Map(), missing: [], outOfOrder: [],
      error: `MISSING ${path.relative(ROOT, filePath).replace(/\\/g, '/')}` };
  }

  const found = findMarkerLines(content, seq);

  const missing = [];
  const outOfOrder = [];
  let prevTag = null;
  let prevLine = -1;
  for (const tag of seq) {
    if (!found.has(tag)) {
      missing.push(tag);
      continue;
    }
    const line = found.get(tag);
    if (prevTag !== null && line <= prevLine) {
      outOfOrder.push({ tag, line, prevTag, prevLine });
    }
    prevTag = tag;
    prevLine = line;
  }

  const pass = missing.length === 0 && outOfOrder.length === 0;
  return { brain, pass, markers: found, missing, outOfOrder };
}

function formatPass(brain, markers, seq) {
  const parts = [];
  for (const tag of seq) {
    if (markers.has(tag)) parts.push(`${tag}@${markers.get(tag)}`);
  }
  return `PASS ${brain}: ${parts.join(' ')}`;
}

function formatFail(brain, missing, outOfOrder) {
  const segs = [];
  if (missing.length) segs.push(`missing ${missing.map(t => `<${t}>`).join(' ')}`);
  for (const oo of outOfOrder) {
    segs.push(`out-of-order: <${oo.tag}>@${oo.line} < <${oo.prevTag}>@${oo.prevLine}`);
  }
  return `FAIL ${brain}: ${segs.join(' | ')}`;
}

function printHelp() {
  console.log(`Usage: node scripts/check-brain-order.mjs [--brain <name>] [--help]

Asserts v2 canonical marker order (ADR-0006 D1) in the 6 squad brains
located at agents/<brain>/CLAUDE.md.

Options:
  (no args)         Check all 6 brains (orchestrator, plan, dev, review, test, cadence).
  --brain <name>    Check a single brain (smoke test).
  --help            Print this message and exit 0.

Exit codes:
  0 = all checked brains PASS
  1 = one or more brains FAIL (DRIFT) or invalid args`);
}

// ── CLI parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { brain: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--brain') {
      if (i + 1 >= argv.length) throw new Error('--brain requires a value');
      args.brain = argv[++i];
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

// ── Main ──────────────────────────────────────────────────────────────

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    printHelp();
    process.exit(1);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let selected;
  if (args.brain) {
    if (!Object.hasOwn(CANONICAL, args.brain)) {
      console.error(`error: unknown brain '${args.brain}'. Known: ${BRAINS.join(', ')}`);
      process.exit(1);
    }
    selected = [args.brain];
  } else {
    selected = BRAINS;
  }

  const violations = [];

  for (const brain of selected) {
    const seq = CANONICAL[brain];
    const result = assertBrain(brain);
    if (result.error) {
      console.log(formatFail(brain, [], []));
      violations.push(`${brain}: ${result.error}`);
      continue;
    }
    if (result.pass) {
      console.log(formatPass(brain, result.markers, seq));
    } else {
      console.log(formatFail(brain, result.missing, result.outOfOrder));
      // Build a sortable violation string per failure detail
      if (result.missing.length) {
        violations.push(`${brain}: missing ${result.missing.map(t => `<${t}>`).join(' ')}`);
      }
      for (const oo of result.outOfOrder) {
        violations.push(`${brain}: out-of-order <${oo.tag}>@${oo.line} < <${oo.prevTag}>@${oo.prevLine}`);
      }
    }
  }

  violations.sort();

  const checked = selected.length;
  const failed = violations.length;
  if (failed === 0) {
    console.log(`OK: ${checked}/${BRAINS.length} brains pass structural-order assertion`);
    process.exit(0);
  } else {
    console.log(`DRIFT: ${failed} brain(s) failed structural-order assertion`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
