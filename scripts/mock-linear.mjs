#!/usr/bin/env node
/**
 * scripts/mock-linear.mjs — File-based mock of Linear push.
 *
 * Used by T-A4 PLAN dry-run. A decomposer writes a DRAFT JSON; this script
 * validates it (DoR/DoD), dedups idempotently, and writes a final brief JSON.
 *
 * Modes:
 *   --ingest   Glob .draft.*.json in briefs-dir, validate, idempotent-write.
 *   --verify   List final briefs in briefs-dir.
 *
 * Usage:
 *   node scripts/mock-linear.mjs --ingest [--briefs-dir planning/briefs]
 *   node scripts/mock-linear.mjs --verify [--briefs-dir planning/briefs]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { idempotentCreate } from "./utils.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set(["feat", "fix", "chore", "test", "docs", "refactor"]);
const VALID_ESTIMATES = new Set(["S", "M", "L", "XL"]);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a single subtask against DoR criteria.
 *
 * @param {object} st - A subtask object from the draft.
 * @param {number} idx - Index for error messages.
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateSubtask(st, idx) {
  const label = `subtask[${idx}]`;

  if (!st || typeof st !== "object") {
    return { valid: false, reason: `${label}: not an object` };
  }
  if (!st.title || typeof st.title !== "string" || !st.title.trim()) {
    return { valid: false, reason: `${label}: title is missing or empty` };
  }
  if (!st.type || !VALID_TYPES.has(st.type)) {
    return { valid: false, reason: `${label}: type "${st.type}" not in {feat,fix,chore,test,docs,refactor}` };
  }
  if (!st.estimate || !VALID_ESTIMATES.has(st.estimate)) {
    return { valid: false, reason: `${label}: estimate "${st.estimate}" not in {S,M,L,XL}` };
  }
  if (!Array.isArray(st.ac) || st.ac.length === 0) {
    return { valid: false, reason: `${label}: ac is missing, not an array, or empty` };
  }
  for (let i = 0; i < st.ac.length; i++) {
    const ac = st.ac[i];
    if (!ac || typeof ac !== "object") {
      return { valid: false, reason: `${label}: ac[${i}] is not an object` };
    }
    if (!ac.given || typeof ac.given !== "string" || !ac.given.trim()) {
      return { valid: false, reason: `${label}: ac[${i}].given is missing or empty` };
    }
    if (!ac.when || typeof ac.when !== "string" || !ac.when.trim()) {
      return { valid: false, reason: `${label}: ac[${i}].when is missing or empty` };
    }
    if (!ac.then || typeof ac.then !== "string" || !ac.then.trim()) {
      return { valid: false, reason: `${label}: ac[${i}].then is missing or empty` };
    }
  }

  return { valid: true };
}

/**
 * Validate an entire draft and return { validSubtasks, rejected }.
 *
 * @param {object} draft - Parsed draft JSON.
 * @returns {{ validSubtasks: object[], rejected: { subtask: object, reason: string }[] }}
 */
export function validateDraft(draft) {
  const validSubtasks = [];
  const rejected = [];

  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return { validSubtasks: [], rejected: [{ subtask: null, reason: "draft is not a valid object" }] };
  }

  if (!Array.isArray(draft.subtasks)) {
    return { validSubtasks: [], rejected: [{ subtask: null, reason: "draft.subtasks is not an array" }] };
  }

  for (let i = 0; i < draft.subtasks.length; i++) {
    const st = draft.subtasks[i];
    const result = validateSubtask(st, i);
    if (result.valid) {
      validSubtasks.push(st);
    } else {
      rejected.push({ subtask: st, reason: result.reason });
    }
  }

  return { validSubtasks, rejected };
}

// ---------------------------------------------------------------------------
// Ingest one draft
// ---------------------------------------------------------------------------

/**
 * Ingest a single draft: validate, idempotent-write final brief.
 *
 * @param {object} draft       - Parsed draft JSON.
 * @param {string} briefsDir   - Absolute path to briefs directory.
 * @returns {{ externalId: string, valid: number, rejected: number, idempotentSkip: boolean, fail?: boolean }}
 */
export async function ingestOne(draft, briefsDir) {
  const { validSubtasks, rejected } = validateDraft(draft);
  const externalId = draft.parent?.externalId || "unknown";

  // DoR: need >= 3 valid subtasks
  if (validSubtasks.length < 3) {
    console.log(`FAIL: DoR — only ${validSubtasks.length} valid subtasks (need >=3)`);
    for (const r of rejected) {
      console.log(`  REJECTED: ${r.reason}`);
    }
    return { externalId, valid: validSubtasks.length, rejected: rejected.length, fail: true };
  }

  // Sanitize externalId for use as a filename (colons are ADS separators on Windows)
  const slug = externalId.replace(/[:<>"\/\\|?*]/g, "_");
  const hash = createHash("sha256").update(externalId).digest("hex").slice(0, 8);
  const safeName = `${slug}_${hash}`;
  if (/^\.+$/.test(safeName) || safeName.includes("..")) {
    return { externalId, valid: 0, rejected: 0, fail: true };
  }
  const finalPath = join(briefsDir, `${safeName}.json`);
  const existedBefore = existsSync(finalPath);

  await idempotentCreate({
    key: externalId,
    externalId,
    existsFn: async () => existsSync(finalPath),
    createFn: async () => {
      const output = {
        source: draft.source,
        parent: draft.parent,
        subtasks: validSubtasks,
        rejected,
        dryRun: true,
      };
      writeFileSync(finalPath, JSON.stringify(output, null, 2), "utf8");
      return finalPath;
    },
  });

  const idempotentSkip = existedBefore;
  return { externalId, valid: validSubtasks.length, rejected: rejected.length, idempotentSkip };
}

/**
 * Ingest all drafts in a directory.
 *
 * @param {string} briefsDir - Absolute path to briefs directory.
 * @returns {Promise<{ total: number, fails: number, reports: object[] }>}
 */
export async function ingestAll(briefsDir) {
  const entries = readdirSync(briefsDir, { withFileTypes: true });
  const draftFiles = entries
    .filter(e => e.isFile() && e.name.startsWith(".draft.") && e.name.endsWith(".json"))
    .map(e => join(briefsDir, e.name))
    .sort();

  if (draftFiles.length === 0) {
    console.log("No draft files found.");
    return { total: 0, fails: 0, reports: [] };
  }

  const reports = [];
  let fails = 0;

  for (const df of draftFiles) {
    const raw = readFileSync(df, "utf8");
    let draft;
    try {
      draft = JSON.parse(raw);
    } catch (e) {
      console.log(`PARSE ERROR: ${df} — ${e.message}`);
      fails++;
      continue;
    }

    const result = await ingestOne(draft, briefsDir);

    if (result.fail) {
      fails++;
      reports.push(result);
      continue;
    }

    const line = `INGEST ${result.externalId}: valid=${result.valid} rejected=${result.rejected} idempotent_skip=${result.idempotentSkip ? 1 : 0}`;
    console.log(line);
    reports.push(result);
  }

  return { total: draftFiles.length, fails, reports };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify all final briefs in a directory.
 *
 * @param {string} briefsDir - Absolute path to briefs directory.
 * @returns {{ count: number, briefs: object[] }}
 */
export function verifyBriefs(briefsDir) {
  const entries = readdirSync(briefsDir, { withFileTypes: true });
  const briefFiles = entries
    .filter(e => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith(".draft.") && e.name !== ".gitkeep")
    .map(e => join(briefsDir, e.name))
    .sort();

  const briefs = [];

  for (const bf of briefFiles) {
    try {
      const raw = readFileSync(bf, "utf8");
      const brief = JSON.parse(raw);
      const externalId = brief.parent?.externalId || bf;
      const subtaskCount = Array.isArray(brief.subtasks) ? brief.subtasks.length : 0;
      const rejectedCount = Array.isArray(brief.rejected) ? brief.rejected.length : 0;
      briefs.push({ externalId, subtasks: subtaskCount, rejected: rejectedCount });
    } catch {
      // Skip unparseable files
    }
  }

  console.log(`BRIEFS: ${briefs.length}`);
  for (const b of briefs) {
    console.log(`  ${b.externalId}: subtasks=${b.subtasks} rejected=${b.rejected}`);
  }

  return { count: briefs.length, briefs };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function usage() {
  console.log("Usage:");
  console.log("  node scripts/mock-linear.mjs --ingest [--briefs-dir planning/briefs]");
  console.log("  node scripts/mock-linear.mjs --verify [--briefs-dir planning/briefs]");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);

  const modeIdx = args.findIndex(a => a === "--ingest" || a === "--verify");
  if (modeIdx === -1) usage();

  const mode = args[modeIdx];
  const briefsDirIdx = args.findIndex(a => a === "--briefs-dir");
  const briefsDir = briefsDirIdx !== -1
    ? resolve(process.cwd(), args[briefsDirIdx + 1])
    : resolve(process.cwd(), "planning", "briefs");

  if (mode === "--ingest") {
    const result = await ingestAll(briefsDir);
    process.exit(result.fails > 0 ? 1 : 0);
  } else if (mode === "--verify") {
    verifyBriefs(briefsDir);
    process.exit(0);
  }
}

// Only run CLI when this module is the entry point
const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
