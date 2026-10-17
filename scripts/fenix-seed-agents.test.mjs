// scripts/fenix-seed-agents.test.mjs — FOC-776 (D3): image→volume squad
// config seeding with the dpkg conffile rule.
//
// Covers the full decision table of seedAgents against real temp dirs: the
// first seed lands every whitelisted file and the manifest; a no-op seed
// rewrites nothing; image-only changes update unedited files; user edits are
// kept (with the fresh image version parked as <rel>.fenix-new when the image
// moved on too); files leaving the image are removed or kept as orphans
// depending on whether the user touched them; user deletions stay deleted;
// and non-config / runtime files are never copied nor disturbed. FOC-772: the
// memory/ directories are seeded only when the memory integration is on —
// injected integrations for the decision table, and the CLI default path
// (LA_SETTINGS_FILE overlay) for the wiring.
//
// Run: node scripts/test-run.mjs fenix-seed-agents

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { seedAgents } from "./fenix-seed-agents.mjs";

const CLI = fileURLToPath(new URL("./fenix-seed-agents.mjs", import.meta.url));

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL " + name + "\n       " + err.message);
  }
}

const fail = (msg) => { throw new Error(msg); };
const eq = (a, b, label) => { if (a !== b) fail(`${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
// Key-order-insensitive deep equality: counts and manifest maps must match
// by content, not by insertion order.
const stable = (v) => JSON.stringify(v, (_k, val) => {
  if (val === null || typeof val !== "object" || Array.isArray(val)) return val;
  return Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
});
const deepEq = (a, b, label) => { if (stable(a) !== stable(b)) fail(`${label}: ${stable(a)} !== ${stable(b)}`); };

// Tracked temp dirs — swept at the end, nothing left behind anywhere.
const dirs = [];
const tmpDir = (tag) => {
  const d = mkdtempSync(join(tmpdir(), "fenix-seed-" + tag));
  dirs.push(d);
  return d;
};

const write = (base, rel, content) => {
  const p = join(base, ...rel.split("/"));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
};
const read = (base, rel) => readFileSync(join(base, ...rel.split("/")), "utf8");
const exists = (base, rel) => existsSync(join(base, ...rel.split("/")));
const remove = (base, rel) => rmSync(join(base, ...rel.split("/")));
const sha = (content) => createHash("sha256").update(content).digest("hex");
const manifest = (to) => JSON.parse(read(to, ".fenix-seed.json"));
const manifestRaw = (to) => read(to, ".fenix-seed.json");
const counts = (over = {}) => ({
  added: 0,
  updated: 0,
  unchanged: 0,
  keptEdited: 0,
  keptLocal: 0,
  keptDeleted: 0,
  removed: 0,
  keptOrphan: 0,
  ...over,
});

// The image set used by most cases: five whitelisted files across two squads.
const IMAGE = {
  "dev/CLAUDE.md": "dev claude v1\n",
  "dev/settings.json": '{"model":"sonnet"}\n',
  "dev/agents/reviewer.md": "reviewer v1\n",
  "dev/skills/lint/SKILL.md": "lint v1\n",
  "_shared/memory/notes.md": "shared notes v1\n",
};
const makeImage = (from) => {
  for (const [rel, content] of Object.entries(IMAGE)) write(from, rel, content);
};

console.log("\nfenix-seed-agents: first and repeat seeding");

test("1 first seed copies all whitelisted files and writes the manifest", () => {
  const from = tmpDir("1-from-");
  const to = tmpDir("1-to-");
  makeImage(from);
  const result = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(result.counts, counts({ added: 5 }), "counts");
  deepEq(result.actions.map((a) => a.action), Array(5).fill("added"), "every action is added");
  const expectedFiles = {};
  for (const [rel, content] of Object.entries(IMAGE)) {
    eq(read(to, rel), content, `volume content of ${rel}`);
    expectedFiles[rel] = sha(content);
  }
  const man = manifest(to);
  eq(man.version, 1, "manifest version");
  deepEq(man.files, expectedFiles, "manifest records the seeded digests");
  eq(exists(to, ".fenix-seed.json.tmp"), false, "no tmp residue from the atomic write");
});

test("2 a second seed with no change: all unchanged, nothing written", () => {
  const from = tmpDir("2-from-");
  const to = tmpDir("2-to-");
  makeImage(from);
  seedAgents({ from, to, integrations: { memory: true } });
  const rawBefore = manifestRaw(to);
  const volumeBefore = {};
  for (const rel of Object.keys(IMAGE)) volumeBefore[rel] = read(to, rel);
  const result = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(result.counts, counts({ unchanged: 5 }), "all five unchanged");
  eq(manifestRaw(to), rawBefore, "manifest byte-identical (not rewritten)");
  for (const rel of Object.keys(IMAGE)) {
    eq(read(to, rel), volumeBefore[rel], `volume content of ${rel} untouched`);
  }
  eq(exists(to, ".fenix-seed.json.tmp"), false, "no tmp residue");
});

console.log("\nfenix-seed-agents: image changes vs user edits (dpkg conffile rule)");

test("3 image changes an unedited file: updated, volume gets the new content", () => {
  const from = tmpDir("3-from-");
  const to = tmpDir("3-to-");
  makeImage(from);
  seedAgents({ from, to, integrations: { memory: true } });
  write(from, "dev/CLAUDE.md", "dev claude v2\n");
  const result = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(result.counts, counts({ updated: 1, unchanged: 4 }), "counts");
  eq(read(to, "dev/CLAUDE.md"), "dev claude v2\n", "volume has the new image content");
  eq(manifest(to).files["dev/CLAUDE.md"], sha("dev claude v2\n"), "manifest records the new digest");
});

test("4 user edits a file, image unchanged: kept-edited, no .fenix-new", () => {
  const from = tmpDir("4-from-");
  const to = tmpDir("4-to-");
  makeImage(from);
  seedAgents({ from, to, integrations: { memory: true } });
  write(to, "dev/CLAUDE.md", "user prompt edit\n");
  const result = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(result.counts, counts({ keptEdited: 1, unchanged: 4 }), "counts");
  eq(read(to, "dev/CLAUDE.md"), "user prompt edit\n", "user content kept");
  eq(exists(to, "dev/CLAUDE.md.fenix-new"), false, "no parked image copy");
  eq(manifest(to).files["dev/CLAUDE.md"], sha("dev claude v1\n"), "manifest entry unchanged");
});

test("5 user edits a file and the image changes it: kept-edited with .fenix-new", () => {
  const from = tmpDir("5-from-");
  const to = tmpDir("5-to-");
  makeImage(from);
  seedAgents({ from, to, integrations: { memory: true } });
  write(to, "dev/CLAUDE.md", "user prompt edit\n");
  write(from, "dev/CLAUDE.md", "dev claude v2\n");
  const result = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(result.counts, counts({ keptEdited: 1, unchanged: 4 }), "counts");
  eq(read(to, "dev/CLAUDE.md"), "user prompt edit\n", "user content kept");
  eq(read(to, "dev/CLAUDE.md.fenix-new"), "dev claude v2\n", "image version parked next to it");
  eq(manifest(to).files["dev/CLAUDE.md"], sha("dev claude v1\n"), "manifest entry unchanged");
});

console.log("\nfenix-seed-agents: files leaving the image, user deletions");

test("6 file removed from the image, unedited on the volume: removed", () => {
  const from = tmpDir("6-from-");
  const to = tmpDir("6-to-");
  makeImage(from);
  seedAgents({ from, to, integrations: { memory: true } });
  remove(from, "dev/agents/reviewer.md");
  const result = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(result.counts, counts({ removed: 1, unchanged: 4 }), "counts");
  eq(exists(to, "dev/agents/reviewer.md"), false, "file gone from the volume");
  eq(manifest(to).files["dev/agents/reviewer.md"], undefined, "manifest entry dropped");
});

test("7 removed from the image but edited on the volume: kept-orphan", () => {
  const from = tmpDir("7-from-");
  const to = tmpDir("7-to-");
  makeImage(from);
  seedAgents({ from, to, integrations: { memory: true } });
  write(to, "dev/agents/reviewer.md", "my own reviewer\n");
  remove(from, "dev/agents/reviewer.md");
  const result = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(result.counts, counts({ keptOrphan: 1, unchanged: 4 }), "counts");
  eq(read(to, "dev/agents/reviewer.md"), "my own reviewer\n", "user file kept");
  eq(manifest(to).files["dev/agents/reviewer.md"], undefined, "manifest entry dropped");
});

test("8 user deleted a seeded file: kept-deleted, stays deleted on the next seed", () => {
  const from = tmpDir("8-from-");
  const to = tmpDir("8-to-");
  makeImage(from);
  seedAgents({ from, to, integrations: { memory: true } });
  remove(to, "dev/skills/lint/SKILL.md");
  const first = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(first.counts, counts({ keptDeleted: 1, unchanged: 4 }), "counts");
  eq(exists(to, "dev/skills/lint/SKILL.md"), false, "stays deleted");
  eq(manifest(to).files["dev/skills/lint/SKILL.md"], sha("lint v1\n"), "manifest entry kept");
  const second = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(second.counts, counts({ keptDeleted: 1, unchanged: 4 }), "next seed: still kept-deleted");
  eq(exists(to, "dev/skills/lint/SKILL.md"), false, "still not resurrected");
});

console.log("\nfenix-seed-agents: runtime and local files are never touched");

test("9 non-whitelisted files under --from are never copied", () => {
  const from = tmpDir("9-from-");
  const to = tmpDir("9-to-");
  makeImage(from);
  write(from, "dev/projects/t.jsonl", '{"turn":1}\n');
  write(from, "dev/.claude.json", '{"session":{}}\n');
  write(from, "dev/history.jsonl", "history line\n");
  const result = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(result.counts, counts({ added: 5 }), "only the five whitelisted files seeded");
  eq(exists(to, "dev/projects/t.jsonl"), false, "projects file not copied");
  eq(exists(to, "dev/.claude.json"), false, ".claude.json not copied");
  eq(exists(to, "dev/history.jsonl"), false, "history not copied");
  eq(manifest(to).files["dev/projects/t.jsonl"], undefined, "not recorded in the manifest");
});

test("10 runtime files already on the volume are untouched after a seed", () => {
  const from = tmpDir("10-from-");
  const to = tmpDir("10-to-");
  makeImage(from);
  seedAgents({ from, to, integrations: { memory: true } });
  write(to, "dev/projects/x.jsonl", '{"turn":42}\n');
  write(to, "dev/.claude.json", '{"runtime":true}\n');
  write(from, "dev/CLAUDE.md", "dev claude v2\n"); // force real work in the next seed
  const result = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(result.counts, counts({ updated: 1, unchanged: 4 }), "seed did real work");
  eq(read(to, "dev/projects/x.jsonl"), '{"turn":42}\n', "transcript untouched");
  eq(read(to, "dev/.claude.json"), '{"runtime":true}\n', ".claude.json untouched");
});

test("11 a pre-existing differing local file with no manifest entry: kept-local", () => {
  const from = tmpDir("11-from-");
  const to = tmpDir("11-to-");
  makeImage(from);
  write(to, "dev/CLAUDE.md", "locally grown config\n");
  const result = seedAgents({ from, to, integrations: { memory: true } });
  deepEq(result.counts, counts({ added: 4, keptLocal: 1 }), "counts");
  eq(read(to, "dev/CLAUDE.md"), "locally grown config\n", "local file kept");
  eq(manifest(to).files["dev/CLAUDE.md"], undefined, "local file not recorded");
});

console.log("\nfenix-seed-agents: the memory integration (FOC-772)");

test("12 memory off: memory/ is not seeded and the manifest stays clean", () => {
  const from = tmpDir("12-from-");
  const to = tmpDir("12-to-");
  makeImage(from);
  const result = seedAgents({ from, to, integrations: { memory: false } });
  deepEq(result.counts, counts({ added: 4 }), "only the four non-memory files seeded");
  eq(exists(to, "_shared/memory/notes.md"), false, "memory/ absent from the volume");
  eq(manifest(to).files["_shared/memory/notes.md"], undefined, "manifest does not list memory");
  eq(read(to, "dev/CLAUDE.md"), "dev claude v1\n", "other files seeded as before");
  eq(read(to, "dev/skills/lint/SKILL.md"), "lint v1\n", "non-memory config seeded as before");
});

test("13 memory off after a memory-on seed: the stale memory file is retired", () => {
  const from = tmpDir("13-from-");
  const to = tmpDir("13-to-");
  makeImage(from);
  seedAgents({ from, to, integrations: { memory: true } });
  const result = seedAgents({ from, to, integrations: { memory: false } });
  deepEq(result.counts, counts({ removed: 1, unchanged: 4 }), "memory retired by the orphan rule");
  eq(exists(to, "_shared/memory/notes.md"), false, "memory gone from the volume");
  eq(manifest(to).files["_shared/memory/notes.md"], undefined, "manifest entry dropped");
  eq(read(to, "dev/CLAUDE.md"), "dev claude v1\n", "other files untouched");
});

test("14 CLI default path: integrations.memory resolved from the LA_SETTINGS_FILE overlay", () => {
  const from = tmpDir("14-from-");
  makeImage(from);
  const settingsDir = tmpDir("14-settings-");
  const settingsPath = join(settingsDir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({ provider: { active: null, custom: null }, routing: {}, integrations: { memory: false } }),
    "utf8",
  );
  const cliEnv = { ...process.env, LA_SETTINGS_FILE: settingsPath };
  const toOff = tmpDir("14-to-off-");
  execFileSync(process.execPath, [CLI, "--from", from, "--to", toOff], { env: cliEnv, stdio: "ignore" });
  eq(exists(toOff, "_shared/memory/notes.md"), false, "memory off in the overlay -> not seeded");
  eq(exists(toOff, "dev/CLAUDE.md"), true, "other config still seeded");
  const toOn = tmpDir("14-to-on-");
  writeFileSync(settingsPath, JSON.stringify({ integrations: { memory: true } }), "utf8");
  execFileSync(process.execPath, [CLI, "--from", from, "--to", toOn], { env: cliEnv, stdio: "ignore" });
  eq(exists(toOn, "_shared/memory/notes.md"), true, "memory on in the overlay -> today's behaviour");
});

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\nfenix-seed-agents: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("FAILURES:\n - " + failures.join("\n - "));
  process.exit(1);
}
