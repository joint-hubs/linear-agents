#!/usr/bin/env node
// scripts/code-intel.mjs — code intelligence for squads, over the CodeGraph index.
//
// Answers "where is X / what calls Y / what breaks if I change Z" with one
// command instead of a grep-and-read expedition. A recon subagent that opens
// fifteen files to answer a structural question is the single most expensive
// pattern in this repo; this exists to remove the excuse.
//
// Usage:
//   node scripts/code-intel.mjs explore "<question>"    relevant source + call paths, one shot
//   node scripts/code-intel.mjs symbol <name>           one symbol: source, callers, callees
//   node scripts/code-intel.mjs impact <name>           blast radius before changing it
//   node scripts/code-intel.mjs callers <name>          who calls it
//   node scripts/code-intel.mjs callees <name>          what it calls
//   node scripts/code-intel.mjs find "<term>"           symbol search (--kind, --limit)
//   node scripts/code-intel.mjs files                   file structure from the index
//   node scripts/code-intel.mjs affected [<file> ...]   test files hit by a change
//   node scripts/code-intel.mjs status                  index present and in sync?
//
// Flags pass through to codegraph: --json, --limit N, --kind K, --depth N, ...
//
// WHY THIS WRAPPER STILL EXISTS now that CodeGraph ships an MCP server:
//   · Children run with an isolated CLAUDE_CONFIG_DIR per squad, so MCP has to
//     be wired per squad (agents/*/settings.json). This works with none of that.
//   · The MCP surface lists ONE tool by default (`codegraph_explore`); the
//     narrower ones are unlisted unless CODEGRAPH_MCP_TOOLS re-enables them.
//     Here every verb is always reachable.
//   · Scripts and hooks can call it. An MCP tool is only reachable from a model.
// When you are a lead with the MCP tools available, prefer `codegraph_explore`
// — it is one call and it returns source. This is the floor, not the ceiling.
//
// Requires a CodeGraph index (`.codegraph/`). If absent, every command says so
// and exits 3 — it does NOT silently return nothing, because an empty answer
// that looks like "no results" would send the agent down a wrong path.
//
// FRESHNESS (FOC-114 rounds 4–5): a query verb never answers from an index it
// cannot prove fresh. Before every query verb the wrapper reads `status --json`;
// when changes are pending it runs `codegraph sync <root>` (positional) and
// re-checks; when freshness cannot be PROVEN it exits 3 (UNKNOWN), never a
// silent pass-through, and never naming the queried symbol. "Proven" takes a
// readable status with numeric pendingChanges AND a git baseline — a `.git` at
// the project root with a resolvable HEAD. The baseline is not bureaucracy: the
// CLI's pending signal is computed against it and reports false zeros where it
// is missing (measured, round 5 — both CLI versions in a git-ignored tree with
// no own `.git`; 1.5.0 in a repo before its first commit), so a zero counts as
// proof only where the baseline exists. The raw one-shot `codegraph` CLI has NO
// such guard (tripwired, evidence §5–6) — query through this wrapper.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// Resolved CLI version as `status --json` reports it — surfaced on the guard's
// diagnostic stderr so a refusal or sync note says WHICH binary answered. On
// this machine cmd's PATH resolves 1.5.0 while the npm shim is 1.6.0 (evidence
// §3); the wrapper spawns through shell:true, so its binary is the one cmd
// finds first. Measurement, not a refusal: the documented workflow pairs a
// 1.6.0-built index with this 1.5.0 query path, so version mismatch alone must
// not fail a query.
let cliVersion = "unknown";
const cliTag = () => (cliVersion === "unknown" ? "" : ` (codegraph CLI ${cliVersion})`);

// Verb → codegraph subcommand. The left column is this repo's vocabulary, which
// the five squad CLAUDE.md files already speak; the right is CodeGraph's.
const SUBCOMMANDS = {
  explore: "explore",
  symbol: "node",
  impact: "impact",
  callers: "callers",
  callees: "callees",
  find: "query",
  files: "files",
  affected: "affected",
  status: "status",
};

// Verbs the GitNexus-backed version had that CodeGraph does not answer. Saying
// so beats a wrapper that maps them onto something adjacent: an agent told
// "cycles: none found" when nothing was checked will report a clean bill.
const RETIRED = {
  path: 'use: code-intel explore "how does <from> reach <to>" — CodeGraph returns call paths inline',
  cycles: "no equivalent — CodeGraph has no circular-import check. Use `npx madge --circular` or Grep.",
  raw: "no equivalent — CodeGraph is not a Cypher store.",
};

// Verbs that ANSWER from the index, so freshness must be proven first (see
// pendingGuard). `status` is exempt — it is the guard's own instrument.
const QUERY_VERBS = new Set([
  "explore",
  "symbol",
  "find",
  "callers",
  "callees",
  "impact",
  "affected",
  "files",
]);

function usage(code = 2) {
  console.error(
    [
      "Usage: node scripts/code-intel.mjs <command> [args] [codegraph flags]",
      "",
      '  explore "<question>"   relevant symbols\' source + call paths, one shot (start here)',
      "  symbol <name>          one symbol: source, callers, callees",
      "  impact <name>          what breaks if you change it (--depth N, --json)",
      "  callers <name>         who calls it (--limit N, --json)",
      "  callees <name>         what it calls (--limit N, --json)",
      '  find "<term>"          symbol search (--kind function|class, --limit N, --json)',
      "  files                  file structure from the index (--filter, --pattern, --json)",
      "  affected [<file> ...]  test files hit by changing these (--depth N, --json)",
      "  status                 index present and in sync?",
      "",
      "Ask the graph BEFORE grepping. One call here replaces a read-and-search sweep.",
    ].join("\n"),
  );
  process.exit(code);
}

// Exit 3, never 0-with-nothing. An agent that reads "no results" from a missing
// index concludes the symbol does not exist and acts on it.
function requireIndex() {
  if (existsSync(join(ROOT, ".codegraph"))) return;
  console.error(
    [
      "[code-intel] No CodeGraph index in this repo (.codegraph/ is missing).",
      "",
      "Nothing here can answer until it exists. Build it:  codegraph init",
      "A negative result from this tool right now would be a lie, so it refuses instead.",
    ].join("\n"),
  );
  process.exit(3);
}

function notOnPath() {
  console.error(
    [
      "[code-intel] The `codegraph` CLI is not on PATH.",
      "",
      "Install:  npm i -g @colbymchenry/codegraph",
      "Then:     codegraph init",
    ].join("\n"),
  );
  process.exit(3);
}

function spawnCli(args, opts = {}) {
  return spawnSync("codegraph", args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    ...opts,
  });
}

// Under shell:true (win32) node hands the command line to cmd.exe unquoted, so
// a path with spaces must be quoted here; POSIX spawns skip the shell and get
// real argument arrays, where quoting would be wrong. Paths with cmd
// metacharacters fail safe either way — a mangled sync is a refusal, never a
// false answer — but a space in the repo path is ordinary, so quote it.
function quoteForShell(p) {
  if (process.platform !== "win32" || !/[\s"&|<>^]/.test(p)) return p;
  return `"${p.replaceAll('"', '""')}"`;
}

// True only when this spawn provably failed because the CLI cannot run at all.
// On win32 a missing binary never reaches us as ENOENT — cmd.exe itself spawns
// fine (shell: true) and reports the failure as a plain exit 1 with a localized
// "'codegraph' is not recognized" message (observed and captured, FOC-114
// evidence §4). Disambiguate with `where`, whose exit code is
// locale-independent — but only its own "not found" (1) proves absence: 0
// (found) or >=2 (`where` itself failed) are NOT proof, so the CLI's own status
// is preserved rather than misreporting not-on-PATH. The probe only runs on a
// failing spawn.
function cliMissing(res) {
  if (res.error?.code === "ENOENT") return true;
  if (process.platform === "win32" && res.status !== 0 && res.error == null) {
    const where = spawnSync("where", ["codegraph"], { encoding: "utf8" });
    if (where.status === 1) return true;
  }
  return false;
}

// Pending change count from `status --json` — or null when the state cannot be
// PROVEN: non-zero exit, unparseable JSON, or a missing/non-numeric
// pendingChanges (a corrupt index dir answers `{"initialized":false}` with exit
// 0 and no pendingChanges — measured, FOC-114 round 4). null means UNKNOWN,
// never "clean".
function pendingCount() {
  const res = spawnCli(["status", "--json"]);
  if (cliMissing(res)) notOnPath();
  if (res.status !== 0) return null;
  const start = (res.stdout || "").indexOf("{");
  if (start < 0) return null;
  let json;
  try {
    json = JSON.parse(res.stdout.slice(start));
  } catch {
    return null;
  }
  const p = json && json.pendingChanges;
  if (typeof json?.version === "string") cliVersion = json.version;
  if (!p || [p.added, p.modified, p.removed].some((n) => typeof n !== "number")) return null;
  return p.added + p.modified + p.removed;
}

function refuseStateUnknown() {
  console.error(
    [
      `[code-intel] Cannot read the index state (codegraph status --json failed or was unreadable${cliTag()}).`,
      "",
      "An answer from an index of unknown freshness can be confidently wrong (FOC-114), so this",
      "refuses instead.",
      "Retry the read first:  codegraph status --json",
      "Still unreadable — rebuild:  codegraph init",
    ].join("\n"),
  );
  process.exit(3);
}

// FOC-114 round 5: pendingChanges is computed AGAINST a git baseline, and the
// CLI reports a false zero wherever that baseline is missing — measured: in a
// tree with no own `.git` nested where an enclosing repo ignores it, both CLI
// versions answer `added:0` while a file is pending; in a git repo before its
// first commit, 1.5.0 (the binary cmd resolves on win32) does the same. So a
// pendingChanges zero proves cleanliness only when git itself has a baseline.
// Require one before trusting ANY pendingChanges value — including zero — and
// before any sync: a fresh index still needs the baseline for the NEXT query's
// zero to mean anything.
function refuseNoBaseline(why) {
  console.error(
    [
      `[code-intel] Index freshness cannot be proven: ${why}${cliTag()}.`,
      "",
      "The pending-change signal is computed against a git baseline, and without one a",
      '"clean" reading can be a false zero (FOC-114 round 5, measured). Commit the tree,',
      "then re-run:",
      "  git init                      (if there is no repository here)",
      "  git add -A && git commit -m init   (if HEAD is unresolvable)",
      "",
      "A query from here right now would be UNKNOWN, so this refuses instead.",
    ].join("\n"),
  );
  process.exit(3);
}

function requireGitBaseline() {
  if (!existsSync(join(ROOT, ".git"))) {
    refuseNoBaseline("no git repository at the project root");
  }
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (head.error || head.status !== 0) {
    refuseNoBaseline("git HEAD is unresolvable (repository has no commit yet?)");
  }
}

// FOC-114 rounds 4–5 (AC2, decided 2026-09-14): the CLI's one-shot answer layer
// does not flag staleness — it answers confidently from an outdated index
// (pending → "not found" exit 0; stale edit → outdated file:line; evidence
// §5–6). The wrapper therefore proves freshness before every query verb:
// `status --json` readable; a git baseline present (round 5 — without it the
// pending signal itself lies, evidence §7); `codegraph sync <root>` (positional
// — it rejects --path) then re-check when not clean; exit 3 UNKNOWN whenever
// any of that cannot be proven. All refusals name the fix and never the queried
// symbol. Two wrappers syncing at once surface here as one failed sync — a
// refusal, never a false answer.
//
// Order matters: the instrument is checked first so a missing CLI still gets
// its specific not-on-PATH refusal, and the baseline is checked before any
// pendingChanges value is trusted — including zero — and before any sync.
function pendingGuard() {
  let pending = pendingCount();
  if (pending === null) refuseStateUnknown();
  requireGitBaseline();
  if (pending > 0) {
    const sync = spawnCli(["sync", quoteForShell(ROOT)]);
    if (sync.error || sync.status !== 0) {
      const detail = (sync.stderr || "").trim();
      console.error(
        [
          `[code-intel] The index is out of date (${pending} pending change(s)) and "codegraph sync" failed` +
            `${sync.status != null ? ` (exit ${sync.status})` : ""}${cliTag()}.`,
          ...(detail ? ["", detail] : []),
          "",
          "Concurrent wrappers surface here as one failed sync — a refusal, never a false answer.",
          "Retry alone:  codegraph sync <project-root>",
          "Rebuild:      codegraph init",
        ].join("\n"),
      );
      process.exit(3);
    }
    console.error(`[code-intel] index was stale (${pending} pending change(s)); synced before answering${cliTag()}`);
    pending = pendingCount();
    if (pending === null) refuseStateUnknown();
    if (pending > 0) {
      console.error(
        [
          `[code-intel] Still ${pending} pending change(s) after sync — the index does not settle${cliTag()}.`,
          "",
          "An answer from a stale index can be confidently wrong (FOC-114), so this refuses instead.",
          "Rebuild it:  codegraph init",
        ].join("\n"),
      );
      process.exit(3);
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];

  if (!verb || verb === "--help" || verb === "-h") usage(0);

  if (RETIRED[verb]) {
    console.error(`[code-intel] "${verb}" was a GitNexus verb and has no CodeGraph equivalent.\n  ${RETIRED[verb]}`);
    process.exit(2);
  }

  const sub = SUBCOMMANDS[verb];
  if (!sub) {
    console.error(`[code-intel] unknown command "${verb}"\n`);
    usage(2);
  }

  requireIndex();

  // Query verbs answer FROM the index, so freshness is proven first; `status`
  // is exempt because it IS the guard's instrument.
  if (QUERY_VERBS.has(verb)) pendingGuard();

  // `--path ROOT` because squads run from a worktree or a subdirectory, and
  // CodeGraph would otherwise resolve the index relative to cwd and report
  // "no index" for a repo that has one.
  //
  // `status` is the one subcommand that does NOT accept --path (it takes only
  // --json). Passing it there is a hard `error: unknown option` — found by
  // running it, not by reading the flag table.
  const args = [sub, ...argv.slice(1), ...(sub === "status" ? [] : ["--path", quoteForShell(ROOT)])];

  const res = spawnSync("codegraph", args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });

  if (cliMissing(res)) notOnPath();
  process.exit(res.status ?? 1);
}

main();
