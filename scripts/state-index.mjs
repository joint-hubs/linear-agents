#!/usr/bin/env node
// scripts/state-index.mjs — the generated "Task journals" block in docs/STATE.md (FOC-904).
//
//   node scripts/state-index.mjs render          print the block
//   node scripts/state-index.mjs --write         insert/replace the block in docs/STATE.md
//   node scripts/state-index.mjs --check         exit 1 when the committed block differs
//
// docs/STATE.md stays a hand-written journal for standing rules and global
// decisions; the per-task journals live in docs/state/<TASK-ID>.md, and the
// only thing STATE.md carries about them is this ONE generated block, fenced
// by the markers below. Everything outside the markers is never touched by
// this tool — --write is a splice, not a rewrite.
//
// The block is fully derived: one line per docs/state/*.md, sorted by last
// entry date (newest first), then id. Deterministic, so --check can hold the
// line "the committed block is what the journals say" against drift.
//
// When inserting into a STATE.md that has no markers yet, the block goes right
// after the header block — before the first `## ` heading. The file's existing
// EOL style is preserved (the repo's STATE.md is CRLF); new files get LF.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INDEX_START = "<!-- state-index:start -->";
export const INDEX_END = "<!-- state-index:end -->";
const BLOCK_HEADING = "## Task journals (generated)";

/** The root whose docs/ is indexed: LA_ROOT, else this repo. */
export function resolveRoot(env = process.env) {
  if (env.LA_ROOT) return resolve(env.LA_ROOT);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * One row per journal file. Fields come from the metadata block; the date is
 * the timestamp of the LAST `## YYYY-MM-DD HH:MM — …` heading.
 */
export function readJournal(root, file) {
  const id = file.replace(/\.md$/, "");
  const text = readFileSync(join(root, "docs", "state", file), "utf8");
  const meta = {};
  const headEnd = text.search(/^## /m) === -1 ? text.length : text.search(/^## /m);
  for (const m of text.slice(0, headEnd).matchAll(/^([A-Za-z]+): (.*)$/gm)) {
    meta[m[1]] = m[2].trim();
  }
  const stamps = [...text.matchAll(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) — /gm)].map((m) => m[1]);
  return {
    id: meta.Task || id,
    status: meta.Status || "-",
    branch: meta.Branch || "-",
    pr: meta.PR || "-",
    lastAt: stamps.length ? stamps[stamps.length - 1] : null,
  };
}

export function listJournals(root) {
  const dir = join(root, "docs", "state");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const rows = files.map((f) => readJournal(root, f));
  // Newest first; a journal without entries sorts last. `id` breaks ties so
  // the same tree always renders the same block.
  return rows.sort((a, b) => {
    const ka = a.lastAt ?? "";
    const kb = b.lastAt ?? "";
    if (ka !== kb) return ka < kb ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The block between (and including) the markers, with no trailing newline. */
export function renderBlock(rows, eol = "\n") {
  const lines = rows.map(
    (r) => `- ${r.id} — ${r.status} — last entry ${r.lastAt ?? "-"} — ${r.branch} — ${r.pr}`,
  );
  return [INDEX_START, BLOCK_HEADING, "", ...lines, INDEX_END].join(eol);
}

export function render(root) {
  return renderBlock(listJournals(root));
}

/**
 * Splice the block into docs/STATE.md: replace the marker span when the
 * markers exist, otherwise insert right after the header block, before the
 * first `## ` heading. Bytes outside the block are never touched, and the
 * file's EOL style is preserved — so a no-op write does not even rewrite it.
 */
export function writeIndex(root) {
  const statePath = join(root, "docs", "STATE.md");
  if (!existsSync(statePath)) return { path: statePath, changed: false, reason: "no docs/STATE.md" };
  const content = readFileSync(statePath, "utf8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const block = renderBlock(listJournals(root), eol);

  const start = content.indexOf(INDEX_START);
  const end = content.indexOf(INDEX_END);
  // Malformed markers — only one present, or end before start — must be
  // REFUSED, never spliced around: an insert would add a second block, and a
  // later --write would silently delete the content between the dangling
  // markers. The file is left byte-identical; the CLI reports and exits 2.
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    return { path: statePath, changed: false, error: "malformed index markers" };
  }
  if (start !== -1) {
    const next = content.slice(0, start) + block + content.slice(end + INDEX_END.length);
    if (next === content) return { path: statePath, changed: false };
    writeFileSync(statePath, next, "utf8");
    return { path: statePath, changed: true };
  }

  const heading = content.search(/^## /m);
  if (heading !== -1) {
    const next = content.slice(0, heading) + block + eol + eol + content.slice(heading);
    writeFileSync(statePath, next, "utf8");
    return { path: statePath, changed: true };
  }
  // No `## ` heading to anchor on — append after the (header-only) file.
  const base = content.endsWith("\n") ? content : content + eol;
  const next = base + eol + block + eol;
  writeFileSync(statePath, next, "utf8");
  return { path: statePath, changed: true };
}

/**
 * --check: CRLF-normalised compare of the committed block against the render.
 * No markers at all counts as stale — the block is contractually present.
 */
export function checkIndex(root) {
  const statePath = join(root, "docs", "STATE.md");
  if (!existsSync(statePath)) return { ok: false, message: "no docs/STATE.md" };
  const content = readFileSync(statePath, "utf8");
  const start = content.indexOf(INDEX_START);
  const end = content.indexOf(INDEX_END);
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, message: "no index markers in docs/STATE.md" };
  }
  const committed = content.slice(start, end + INDEX_END.length).replace(/\r\n/g, "\n");
  const expected = renderBlock(listJournals(root), "\n");
  if (committed !== expected) return { ok: false, message: "the committed index block differs from docs/state/" };
  return { ok: true, message: "state-index: docs/STATE.md index block is up to date" };
}

function usage(stream) {
  stream(
    "Usage: node scripts/state-index.mjs render | --write | --check\n" +
      "  render  print the generated block\n" +
      "  --write insert/replace the block in docs/STATE.md (splice; EOL preserved; exit 2 on malformed markers)\n" +
      "  --check exit 1 when the committed block differs (CRLF-normalised)",
  );
}

/** The CLI; returns the exit code so tests can drive it in-process. */
export function runCli(argv, { env = process.env, stdout = console.log, stderr = console.error, root = null } = {}) {
  const verb = argv[0];
  if (verb === "--help" || verb === "-h") {
    usage(console.log);
    return 0;
  }
  if (verb === "--write") {
    const res = writeIndex(root ?? resolveRoot(env));
    if (res.error) {
      stderr(`state-index: ${res.error} in ${res.path}`);
      return 2;
    }
    stdout(
      res.changed
        ? `state-index: ${res.path} updated`
        : `state-index: ${res.path} up to date${res.reason ? ` (${res.reason})` : ""}`,
    );
    return 0;
  }
  if (verb === "--check") {
    const res = checkIndex(root ?? resolveRoot(env));
    (res.ok ? stdout : stderr)(res.ok ? res.message : `state-index: ${res.message}`);
    return res.ok ? 0 : 1;
  }
  if (verb === "render" || verb === undefined) {
    stdout(render(root ?? resolveRoot(env)));
    return 0;
  }
  stderr(`state-index: unknown argument "${verb}"`);
  usage(stderr);
  return 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
