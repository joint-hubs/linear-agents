// scripts/fenix-seed-agents.mjs — FOC-776 (D3): seed squad config from the
// image onto the data volume at container start.
//
// In the Fenix container the squad config dirs live on the data volume
// (/data/agents) while the image ships the current config in /opt/fenix/agents.
// At every container start this seeder copies the image config onto the volume
// with the dpkg conffile rule: a file the user never edited follows the image;
// a file the user edited (e.g. in the dashboard prompt editor) is kept — and
// when the image changed too, the fresh image version is parked next to it as
// <rel>.fenix-new. Runtime files on the volume (transcripts, .claude.json,
// history, ...) are never touched: only whitelisted config paths are managed,
// and only through the manifest this seeder writes.
//
// The manifest <to>/.fenix-seed.json records the sha256 of the content last
// seeded for each file; it is what distinguishes "seeded, untouched" from
// "user-owned" on later runs. A missing or corrupt manifest means starting
// fresh: every already-present file then counts as kept-local and is left
// alone, never recorded.
//
// CLI:
//   node scripts/fenix-seed-agents.mjs --from <imageAgentsDir> --to <volumeAgentsDir> [--json]
//
// FOC-772: the personal memory is an optional integration. When
// integrations.memory is off, <squad>/memory/ directories are not seeded and
// previously seeded memory files are retired from the volume by the orphan
// rule below; the manifest never lists them. Tests can inject the
// readIntegrations shape via the `integrations` option; the CLI resolves it
// from the real settings overlay.
//
// Run: node scripts/fenix-seed-agents.test.mjs

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { integrationEnabled } from "./fenix-integrations.mjs";

const MANIFEST_NAME = ".fenix-seed.json";
const NEW_SUFFIX = ".fenix-new";

const USAGE =
  "Usage: node scripts/fenix-seed-agents.mjs --from <imageAgentsDir> --to <volumeAgentsDir> [--json]";

// Action (as reported) -> key in result.counts.
const COUNT_KEYS = {
  "added": "added",
  "updated": "updated",
  "unchanged": "unchanged",
  "kept-edited": "keptEdited",
  "kept-local": "keptLocal",
  "kept-deleted": "keptDeleted",
  "removed": "removed",
  "kept-orphan": "keptOrphan",
};

// Only squad config is seeded: <squad>/CLAUDE.md, <squad>/settings.json and
// everything under <squad>/{agents,skills,memory}/. The squad is the first
// path segment (including "_shared"). Anything else under --from — projects,
// .claude.json, history, ... — is image-shipped runtime data, never copied.
// memory/ is whitelisted only when the memory integration is on (FOC-772).
function isConfigFile(rel, includeMemory) {
  const parts = rel.split("/");
  if (parts.length < 2) return false;
  if (parts.length === 2) {
    return parts[1] === "CLAUDE.md" || parts[1] === "settings.json";
  }
  return parts[1] === "agents" || parts[1] === "skills" || (includeMemory && parts[1] === "memory");
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

// Whitelisted image files as { abs, rel }; rel in "/" form, sorted so the
// output and the manifest are deterministic.
function listImageFiles(from, includeMemory) {
  return walkFiles(from)
    .map((abs) => ({ abs, rel: relative(from, abs).split(sep).join("/") }))
    .filter((f) => isConfigFile(f.rel, includeMemory))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Digest of a volume file, or null when the file is not there.
function volDigest(file) {
  try {
    return sha256(file);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

// Returns { raw, files }: raw is the manifest text as read (null when absent),
// files the parsed digest map (empty when missing or corrupt). A corrupt
// manifest warns once and starts fresh.
function loadManifest(to) {
  const path = join(to, MANIFEST_NAME);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { raw: null, files: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.files || typeof parsed.files !== "object") {
      throw new Error("unexpected manifest shape");
    }
    return { raw, files: parsed.files };
  } catch {
    console.error("WARN manifest unreadable, starting fresh");
    return { raw, files: {} };
  }
}

// Place an image file at <to>/<rel>; parent dirs are created as needed.
function placeFile(to, rel, fromAbs) {
  const dest = join(to, ...rel.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(fromAbs, dest);
}

// The optional integrations switch: injectable for tests (the readIntegrations
// shape, { memory: boolean, ... }); when absent the CLI path resolves it from
// the real settings overlay. A corrupt overlay must fail loudly, per
// fenix-integrations.mjs — an invalid settings file never reads as "off".
function memorySeedingOn(integrations) {
  if (integrations !== undefined) return Boolean(integrations.memory);
  return integrationEnabled("memory");
}

export function seedAgents({ from, to, integrations }) {
  const includeMemory = memorySeedingOn(integrations);
  mkdirSync(to, { recursive: true });
  const imageFiles = listImageFiles(from, includeMemory);
  const imageRels = new Set(imageFiles.map((f) => f.rel));
  const loaded = loadManifest(to);
  const files = { ...loaded.files };
  const actions = [];
  const counts = {
    added: 0,
    updated: 0,
    unchanged: 0,
    keptEdited: 0,
    keptLocal: 0,
    keptDeleted: 0,
    removed: 0,
    keptOrphan: 0,
  };
  const record = (action, rel) => {
    actions.push({ action, rel });
    counts[COUNT_KEYS[action]]++;
  };

  // The dpkg conffile rule, per image file, against the volume and manifest.
  for (const { abs, rel } of imageFiles) {
    const img = sha256(abs);
    const vol = volDigest(join(to, ...rel.split("/")));
    const man = files[rel];
    if (vol === null && man === undefined) {
      placeFile(to, rel, abs);
      files[rel] = img;
      record("added", rel);
    } else if (vol === null) {
      // The user deleted a seeded file: the deletion wins, the entry stays so
      // the file is not resurrected by the next seed.
      record("kept-deleted", rel);
    } else if (vol === img) {
      files[rel] = img;
      record("unchanged", rel);
    } else if (man !== undefined && vol === man) {
      // Seeded and untouched by the user: follow the image.
      placeFile(to, rel, abs);
      files[rel] = img;
      record("updated", rel);
    } else if (man === undefined) {
      // A local file that predates seeding: user-owned, never recorded.
      record("kept-local", rel);
    } else {
      // The user edited a seeded file: their content wins. When the image
      // moved on too, park the fresh image version next to the file.
      if (img !== man) placeFile(to, rel + NEW_SUFFIX, abs);
      record("kept-edited", rel);
    }
  }

  // Manifest entries whose file no longer ships in the image.
  const orphaned = Object.keys(files)
    .filter((rel) => !imageRels.has(rel))
    .sort();
  for (const rel of orphaned) {
    const vol = volDigest(join(to, ...rel.split("/")));
    const man = files[rel];
    if (vol === null) {
      delete files[rel]; // already gone on the volume; drop silently
    } else if (vol === man) {
      rmSync(join(to, ...rel.split("/")), { force: true });
      delete files[rel];
      record("removed", rel);
    } else {
      delete files[rel];
      record("kept-orphan", rel);
    }
  }

  // Rewrite the manifest only when it changed, atomically (tmp + rename).
  const sorted = {};
  for (const rel of Object.keys(files).sort()) sorted[rel] = files[rel];
  const serialized = JSON.stringify({ version: 1, files: sorted }, null, 2) + "\n";
  if (serialized !== loaded.raw) {
    const tmp = join(to, MANIFEST_NAME + ".tmp");
    writeFileSync(tmp, serialized, "utf8");
    renameSync(tmp, join(to, MANIFEST_NAME));
  }

  return { actions, counts };
}

// --- CLI --------------------------------------------------------------------

function parseArgs(argv) {
  const args = { from: undefined, to: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
    } else if (arg === "--from" || arg === "--to") {
      const value = argv[++i];
      if (value === undefined) return null;
      args[arg.slice(2)] = value;
    } else {
      return null;
    }
  }
  if (!args.from || !args.to) return null;
  return args;
}

function runCli(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  let result;
  try {
    result = seedAgents({ from: args.from, to: args.to });
  } catch (err) {
    console.error(`seed failed: ${err && err.message ? err.message : err}`);
    return 1;
  }
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const { action, rel } of result.actions) {
      if (action !== "unchanged") console.log(`seed ${action} ${rel}`);
    }
    const c = result.counts;
    console.log(
      `seed: added ${c.added}, updated ${c.updated}, kept-edited ${c.keptEdited}, ` +
        `kept-local ${c.keptLocal}, kept-deleted ${c.keptDeleted}, removed ${c.removed}, ` +
        `kept-orphan ${c.keptOrphan}, unchanged ${c.unchanged}`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
