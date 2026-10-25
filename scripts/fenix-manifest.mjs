#!/usr/bin/env node
// scripts/fenix-manifest.mjs — hashes of the image's own code, and the drift check (FOC-988).
//
// On the FOC-789 run the Supervisor patched Fenix's code in /opt/fenix four times
// (once removing the duplicate-child-id guard) and told nobody. The filesystem is
// deliberately not made read-only (Mateusz, 2026-10-23), so the Edit/Write deny
// rules and the Bash guard are the prevention and THIS is the detection: the image
// build writes a manifest of SHA-256 sums of the code, `fenix doctor` re-hashes
// the live tree and names every file that differs.
//
// The manifest lives OUTSIDE /opt/fenix (/usr/local/share/fenix, root-owned, 0444)
// so the writer of a patch cannot also rewrite the evidence by accident — only by
// a deliberate act on a path nothing else touches.
//
// What is hashed: the code the runtime executes or reads as policy — scripts/,
// config/, agents/, docker/, package.json, package-lock.json, VERSION. Not
// node_modules, not ui/dist (build output), not caches. A file that differs or is
// gone is drift (FAIL); a file that is not in the image is a WARN (a stray new
// script is worth a look, a cache a tool dropped is not an emergency).
//
// Usage:
//   node scripts/fenix-manifest.mjs write [--root <dir>] --out <manifest.json>
//   node scripts/fenix-manifest.mjs check [--root <dir>] [--manifest <path>] [--json]
// Exit: 0 clean (added files only is still 0) | 1 drift or unreadable manifest | 2 usage

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_VERSION = 1;
export const MANIFEST_DIRS = ["scripts", "config", "agents", "docker"];
export const MANIFEST_FILES = ["package.json", "package-lock.json", "VERSION"];
export const DEFAULT_MANIFEST_PATH = "/usr/local/share/fenix/manifest.json";

const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git", ".state", ".cache"]);
const SKIP_FILE = /\.(pyc|pyo|log|tmp)$/i;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");

function sha256(file, fsImpl) {
  return createHash("sha256").update(fsImpl.readFileSync(file)).digest("hex");
}

function walk(dir, rel, out, fsImpl) {
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // an unreadable directory is simply not listed; compare reports its files as missing
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), childRel, out, fsImpl);
    } else if (entry.isFile() && !SKIP_FILE.test(entry.name)) {
      out.push(childRel);
    }
  }
}

/** Sorted relative posix paths of everything the manifest covers under `root`. */
export function listCodeFiles(root, fsImpl = fs) {
  const files = [];
  for (const dir of MANIFEST_DIRS) walk(path.join(root, dir), dir, files, fsImpl);
  for (const file of MANIFEST_FILES) {
    if (fsImpl.existsSync(path.join(root, file))) files.push(file);
  }
  return files.sort();
}

/** { version, files: { "scripts/x.mjs": "<sha256>", … } } for the tree at `root`. */
export function buildManifest(root = DEFAULT_ROOT, fsImpl = fs) {
  const files = {};
  for (const rel of listCodeFiles(root, fsImpl)) files[rel] = sha256(path.join(root, rel), fsImpl);
  return { version: MANIFEST_VERSION, files };
}

/** { modified, missing, added } — sorted relative paths — of the live tree against `manifest`. */
export function compareToManifest(manifest, root = DEFAULT_ROOT, fsImpl = fs) {
  const expected = manifest?.files ?? {};
  const live = new Set(listCodeFiles(root, fsImpl));
  const modified = [];
  const missing = [];
  for (const [rel, want] of Object.entries(expected)) {
    if (!live.has(rel)) {
      missing.push(rel);
      continue;
    }
    let have;
    try {
      have = sha256(path.join(root, rel), fsImpl);
    } catch {
      missing.push(rel);
      continue;
    }
    if (have !== want) modified.push(rel);
  }
  const added = [...live].filter((rel) => !(rel in expected));
  return { modified: modified.sort(), missing: missing.sort(), added: added.sort() };
}

/** Read a manifest; null when it is absent, an Error-shaped { error } when it is unreadable or not ours. */
export function readManifest(manifestPath = DEFAULT_MANIFEST_PATH, fsImpl = fs) {
  let text;
  try {
    text = fsImpl.readFileSync(manifestPath, "utf8");
  } catch (err) {
    return err?.code === "ENOENT" ? null : { error: `cannot read ${manifestPath}: ${err.message}` };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.version !== MANIFEST_VERSION || typeof parsed.files !== "object" || parsed.files === null) {
      return { error: `${manifestPath} is not a version ${MANIFEST_VERSION} manifest` };
    }
    return parsed;
  } catch (err) {
    return { error: `${manifestPath} is not valid JSON: ${err.message}` };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--root" || a === "--out" || a === "--manifest") args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || process.env.LA_ROOT || DEFAULT_ROOT);
  const verb = args._[0];

  if (verb === "write") {
    if (!args.out) {
      console.error("usage: fenix-manifest.mjs write [--root <dir>] --out <manifest.json>");
      process.exit(2);
    }
    const manifest = buildManifest(root);
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(manifest, null, 1)}\n`);
    console.log(`manifest: ${Object.keys(manifest.files).length} files from ${root} -> ${args.out}`);
    return;
  }

  if (verb === "check") {
    const manifestPath = args.manifest || process.env.LA_FENIX_MANIFEST || DEFAULT_MANIFEST_PATH;
    const manifest = readManifest(manifestPath);
    if (manifest === null || manifest.error) {
      const message = manifest === null ? `no manifest at ${manifestPath}` : manifest.error;
      if (args.json) console.log(JSON.stringify({ ok: false, error: message }));
      else console.error(`fenix-manifest: ${message}`);
      process.exit(1);
    }
    const drift = compareToManifest(manifest, root);
    const clean = drift.modified.length === 0 && drift.missing.length === 0;
    if (args.json) {
      console.log(JSON.stringify({ ok: clean, root, ...drift }));
    } else {
      for (const rel of drift.modified) console.log(`modified  ${rel}`);
      for (const rel of drift.missing) console.log(`missing   ${rel}`);
      for (const rel of drift.added) console.log(`added     ${rel}`);
      console.log(clean ? `ok: ${Object.keys(manifest.files).length} files match the image` : "DRIFT: the live code differs from the image");
    }
    process.exit(clean ? 0 : 1);
  }

  console.error("usage: fenix-manifest.mjs write --out <manifest.json> | check [--manifest <path>] [--json]");
  process.exit(2);
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedAs === fileURLToPath(import.meta.url)) main();
