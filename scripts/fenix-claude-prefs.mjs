// scripts/fenix-claude-prefs.mjs — FOC-776: pre-answer Claude Code onboarding
// inside the Fenix container. Interactive Claude Code must not stop at the
// first-run onboarding or the folder-trust dialog, so the entrypoint runs:
//
//   node scripts/fenix-claude-prefs.mjs --config-dir <dir> --trust <absPath>
//
// It sets hasCompletedOnboarding = true and, under projects[<trustPath>],
// hasTrustDialogAccepted + hasCompletedProjectOnboarding = true. Every other
// key (and every other project entry) is preserved. An unparseable
// .claude.json is never overwritten — exit 1 and let a human fix it.
// Writes are atomic (tmp + rename) and configDir is created when missing.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Atomic JSON write: tmp file + rename, same shape as scripts/utils.mjs. */
function atomicWriteJSON(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * Apply the onboarding/trust prefs to <configDir>/.claude.json.
 *
 * @param {object} opts
 * @param {string} opts.configDir - Claude config directory (created if missing).
 * @param {string} opts.trustPath - Absolute workspace path to trust.
 * @returns {{ file: string, prefs: object }} The resulting prefs object.
 * @throws {Error} When the existing file is present but unparseable — the
 *   file is left byte-for-byte unchanged and the caller should exit non-zero.
 */
export function applyClaudePrefs({ configDir, trustPath }) {
  const file = path.join(configDir, ".claude.json");
  let prefs;
  try {
    prefs = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      prefs = {}; // Missing file is fine — start from an empty config.
    } else {
      throw new Error(`claude prefs: cannot parse ${file} (${err.message}) — fix or remove it by hand, not overwritten`);
    }
  }
  if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) {
    throw new Error(`claude prefs: ${file} is not a JSON object — fix or remove it by hand, not overwritten`);
  }
  prefs.hasCompletedOnboarding = true;
  const projects = (prefs.projects ??= {});
  const project = (projects[trustPath] ??= {});
  project.hasTrustDialogAccepted = true;
  project.hasCompletedProjectOnboarding = true;
  fs.mkdirSync(configDir, { recursive: true });
  atomicWriteJSON(file, prefs);
  console.log(`claude prefs: onboarding done, trusted ${trustPath}`);
  return { file, prefs };
}

// ---------------------------------------------------------------------------
// Main — only when executed directly (not when imported for the helper).
// ---------------------------------------------------------------------------
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const configDir = arg("config-dir");
  const trustPath = arg("trust");
  if (!configDir || !trustPath) {
    console.error("usage: node scripts/fenix-claude-prefs.mjs --config-dir <dir> --trust <absPath>");
    process.exit(1);
  }
  try {
    applyClaudePrefs({ configDir, trustPath });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
