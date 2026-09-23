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
//   node scripts/code-intel.mjs impact <name>          blast radius before changing it
//   node scripts/code-intel.mjs callers <name>         who calls it
//   node scripts/code-intel.mjs callees <name>          what it calls
//   node scripts/code-intel.mjs find "<term>"           symbol search (--kind, --limit)
//   node scripts/code-intel.mjs files                   file structure from the index
//   node scripts/code-intel.mjs affected [<file> ...]   test files hit by a change
//   node scripts/code-intel.mjs status                  index present and in sync?
//   node scripts/code-intel.mjs ready                   small JSON readiness verdict for the target
//
// Flags pass through to codegraph: --json, --limit N, --kind K, --depth N, ...
// --project-root <root> names the target; --timeout <ms> bounds every spawn
// this wrapper makes (the freshness guard and the query) and is not forwarded.
//
// TARGET ROOT (2026-09-23 — replaces the script-location root):
//   The target is resolved by scripts/codegraph-runtime.mjs, never from this
//   file's location. Taking ROOT from the script directory was a real defect:
//   invoking $LA_ROOT/scripts/code-intel.mjs from a task worktree silently
//   queried the tooling checkout, and the wrong tree answered confidently.
//   The target is, in order:
//     --project-root <repo-root>   explicit — used exactly as given (a linked
//                                  worktree root is a valid target)
//     otherwise                    the git toplevel of the caller's cwd
//   Neither resolving → exit 3 with the fix named; there is NO fallback to the
//   script location and NO silent default. `--path` is rejected outright: it
//   is how a single verb would be retargeted past the guard, and a guarded
//   answer must never come from a different checkout than the one checked.
//   status, the freshness guard, sync and the query all address the SAME root.
//   Querying the tooling's own repo on purpose stays possible — spell it with
//   --project-root; it is never inferred from where this script lives.
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
// FRESHNESS (FOC-114 rounds 4–5 + the 2026-09-23 review corrections): a query
// verb never answers from an index it cannot prove fresh. The verdict comes
// from ONE shared algorithm — scripts/codegraph-runtime.mjs
// (ensureCodegraphReady); this wrapper owns the diagnostics and the exit
// codes, not a second copy of the checks (P2: the duplicate had drifted
// before). "Proven" means a readable `status --json` with whole non-negative
// pendingChanges counts, a git baseline (the pending signal is computed
// against it and reports false zeros without one — measured, 2026-09-23), no
// borrowed index (`worktreeMismatch`), no schema gap (the `index` block:
// reindexRecommended / the extraction-version pair / state / pendingRefs),
// and the per-worktree exact-HEAD proof `.codegraph/synced-head`: the runtime
// records the sha it PROVED the index synced at, so a backdated commit or a
// backwards checkout — which both read pending 0/0/0 with an in-order
// lastIndexed, the false-fresh shapes the old time comparison could not see
// — is caught by the sha instead of answered from the stale graph. When
// freshness cannot be PROVEN the wrapper exits 3 (UNKNOWN), never a silent
// pass-through, and never naming the queried symbol. Every spawn is bounded
// (--timeout; default 30s for the guard, 120s for the query) — a wrapper
// that can hang is not a guarded one. The raw one-shot `codegraph` CLI has
// NO such guard (tripwired, evidence §5–6) — query through this wrapper.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureCodegraphReady, resolveCodegraphCommand, resolveProjectRoot } from "./codegraph-runtime.mjs";

// Spawn budgets: the guard's own status/sync/git calls and the query itself.
// A hung codegraph must surface as a bounded refusal (UNKNOWN), never an
// indefinite wait; --timeout overrides both with one knob.
const GUARD_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 120_000;

// Resolved CLI version as `status --json` reports it — surfaced on the guard's
// diagnostic stderr so a refusal or sync note says WHICH binary answered. On
// this machine cmd's PATH resolves 1.5.0 while the npm shim is 1.6.0 (evidence
// §3); the wrapper spawns through shell:true, so its binary is the one cmd
// finds first. Measurement, not a refusal: the documented workflow pairs a
// 1.6.0-built index with this 1.5.0 query path, so version mismatch alone must
// not fail a query — and the guard compares the extraction pair reported by
// the SAME resolved binary, so a disagreeing pair is a real schema gap, never
// a PATH-order artifact.
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
// freshnessGuard). `status` is exempt — it is the guard's own instrument. `ready`
// is a wrapper verb, not a codegraph subcommand, and exempt for the same reason.
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
      "  ready                  one-line JSON readiness verdict (never initializes)",
      "",
      "Target root: --project-root <repo-root> wins; otherwise the git toplevel of the",
      "caller's cwd is used (a linked worktree resolves to the worktree, not main).",
      "`--path` is not accepted — it would retarget a query past the freshness guard.",
      "--timeout <ms> bounds every spawn this wrapper makes (guard + query), and is",
      "not forwarded to codegraph.",
      "",
      "Ask the graph BEFORE grepping. One call here replaces a read-and-search sweep.",
    ].join("\n"),
  );
  process.exit(code);
}

// Exit 3, never 0-with-nothing. An agent that reads "no results" from a missing
// index concludes the symbol does not exist and acts on it.
function requireIndex(root) {
  if (existsSync(join(root, ".codegraph"))) return;
  console.error(
    [
      `[code-intel] No CodeGraph index in the target project (${root}) (.codegraph/ is missing).`,
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

// The codegraph binary: resolved once per process by codegraph-runtime — the
// same canonical binary the MCP server's "command": "codegraph" reaches, with
// .cmd shims unwrapped to node.exe + JS entry so every spawn runs shell:false
// with real argument arrays (quoting stops being a hazard). The bare-name
// fallback on win32 still needs shell:true — the proven path, kept here.
const cli = resolveCodegraphCommand();
const shellNeeded = cli.command === "codegraph" && process.platform === "win32";

function spawnCli(args, opts = {}) {
  const finalArgs = shellNeeded ? args.map(quoteForShell) : args;
  return spawnSync(cli.command, [...cli.args, ...finalArgs], {
    encoding: "utf8",
    shell: shellNeeded,
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

// ── freshness: the shared verdict, this wrapper's diagnostics ────────────────
//
// The guard algorithm is ONE place — codegraph-runtime.mjs (ensureCodegraphReady).
// This wrapper used to duplicate it (its own status read, its own baseline
// check, its own sync loop), and a duplicate drifts: the runtime gained the
// exact-HEAD proof while the copy still compared timestamps (P2, review
// 2026-09-23). What stays here is what a CLI is for: mapping the verdict to
// the diagnostic the human needs, exit 3 (UNKNOWN) on every refusal, and
// never naming the queried symbol in a refusal.
function freshnessGuard(root, timeoutMs) {
  const r = ensureCodegraphReady({ projectRoot: root, initialize: false, timeoutMs });
  if (typeof r.version === "string") cliVersion = r.version;
  if (r.ok) {
    if (r.synced) {
      const why =
        r.syncCause === "pending"
          ? `index was stale (${r.pendingBefore} pending change(s)); synced before answering`
          : "index freshness was not proven for the current git HEAD; synced before answering";
      console.error(`[code-intel] ${why}${cliTag()}`);
    }
    return;
  }
  refuseUnproven(r, root, timeoutMs);
}

// Map the shared verdict's stable reason prefixes to the refusal diagnostics.
// Every branch exits 3 and every text is a constant — the queried symbol can
// never leak into a refusal.
function refuseUnproven(r, root, guardBudgetMs) {
  const reason = String(r.reason ?? "unknown");
  const cut = reason.indexOf(":");
  const prefix = cut < 0 ? reason : reason.slice(0, cut);
  const detail = cut < 0 ? "" : reason.slice(cut + 1).trim();
  switch (prefix) {
    case "cli-not-found":
      return notOnPath();
    case "timeout":
      return refuseGuardTimeout(guardBudgetMs);
    case "index-missing":
      return refuseUninitializedIndex();
    case "index-schema-stale":
    case "index-schema-stale-after-rebuild":
      return refuseSchemaState(reason);
    case "no-git-baseline": {
      // The shared guard sees one instrument (rev-parse); the two shapes a
      // human can fix differently are told apart here, at the diagnostics.
      const why = existsSync(join(root, ".git"))
        ? "git HEAD is unresolvable (repository has no commit yet?)"
        : "no git repository at the project root";
      return refuseNoBaseline(why);
    }
    case "index-mismatch":
      return refuseBorrowedIndex(r.mismatch ?? {});
    case "sync-failed":
      return refuseSyncFailed(detail);
    case "pending-after-sync":
      return refuseStillPending(detail);
    case "head-changed-midcheck":
      return refuseHeadMoved(detail);
    case "proof-unwritable":
      return refuseProofUnwritable(detail);
    default:
      return refuseStateUnknown();
  }
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

function refuseUninitializedIndex() {
  console.error(
    [
      `[code-intel] The target has a .codegraph directory but ` +
        `\`codegraph status\` reports no initialized index in it${cliTag()}.`,
      "",
      "Nothing here can answer until the index really exists — an answer from an absent",
      "index would be a confident lie, so this refuses instead.",
      "Build it:  codegraph init <project-root>",
    ].join("\n"),
  );
  process.exit(3);
}

function refuseSchemaState(reason) {
  console.error(
    [
      `[code-intel] The index was built by a different extraction schema — queries are refused (${reason})${cliTag()}.`,
      "",
      "A schema-stale index can answer confidently wrong (review 2026-09-23, P1): its",
      "edges may describe symbols the current CLI no longer extracts. Rebuild it in place:",
      "  codegraph index <project-root>      (full rebuild, same result as a fresh init)",
      "",
      "This refuses instead of answering.",
    ].join("\n"),
  );
  process.exit(3);
}

function refuseNoBaseline(why) {
  console.error(
    [
      `[code-intel] Index freshness cannot be proven: ${why}${cliTag()}.`,
      "",
      "The pending-change signal is computed against a git baseline, and without one a",
      '"clean" reading can be a false zero (FOC-114 round 5, measured). Commit the tree,',
      "then re-run:",
      "  git init                 (if there is no repository here)",
      "  git add <specific files> && git commit -m init",
      "                           (if HEAD is unresolvable)",
      "",
      "Do not stage with a blind `git add -A`: it sweeps scratch files and the local",
      ".codegraph/ index into the baseline. Stage what belongs there, and keep",
      ".codegraph/ ignored.",
      "",
      "A query from here right now would be UNKNOWN, so this refuses instead.",
    ].join("\n"),
  );
  process.exit(3);
}

// The index records which tree it was built for. A borrowed index (a query run
// from a worktree whose `.codegraph` lookup reached another tree's index) is
// exactly the wrong-checkout failure class: its edges describe symbols and
// lines that do not exist here. One index per worktree, at the worktree root.
function refuseBorrowedIndex(mismatch) {
  console.error(
    [
      `[code-intel] The index under the target belongs to a different git worktree ` +
        `(index: ${mismatch.indexRoot ?? "another tree"}; this tree: ${mismatch.worktreeRoot ?? "unknown"}).`,
      "",
      "An answer from it would describe the OTHER tree's symbols — the wrong-checkout failure this",
      "wrapper exists to prevent. Give this worktree its own index:",
      "  codegraph init <worktree-root>",
      "",
      "This refuses instead of answering.",
    ].join("\n"),
  );
  process.exit(3);
}

function refuseSyncFailed(detail) {
  console.error(
    [
      `[code-intel] The index was stale and "codegraph sync" failed${detail ? ` (${detail})` : ""}${cliTag()}.`,
      "",
      "Concurrent wrappers surface here as one failed sync — a refusal, never a false answer.",
      "Retry alone:  codegraph sync <project-root>",
      "Rebuild:      codegraph init",
    ].join("\n"),
  );
  process.exit(3);
}

function refuseStillPending(detail) {
  console.error(
    [
      `[code-intel] ${detail || "Still pending after sync — the index does not settle"}${cliTag()}.`,
      "",
      "An answer from a stale index can be confidently wrong (FOC-114), so this refuses instead.",
      "Rebuild it:  codegraph init",
    ].join("\n"),
  );
  process.exit(3);
}

function refuseHeadMoved(detail) {
  console.error(
    [
      `[code-intel] git HEAD changed while freshness was being proven${detail ? ` (${detail})` : ""}${cliTag()}.`,
      "",
      "The proof is only valid when the tree does not move under it: the HEAD must be the",
      "same commit on both sides of the sync, else an answer would describe neither",
      "revision — UNKNOWN, so this refuses instead.",
      "The tree has settled by now — retry the query and the proof re-establishes itself.",
    ].join("\n"),
  );
  process.exit(3);
}

function refuseProofUnwritable(detail) {
  console.error(
    [
      `[code-intel] Cannot write the freshness proof .codegraph/synced-head${detail ? ` (${detail})` : ""}${cliTag()}.`,
      "",
      "Without the proof the index cannot be certified fresh for the current HEAD, so this",
      "refuses instead of answering from it. Check that .codegraph/ is writable and",
      "gitignored, then retry.",
    ].join("\n"),
  );
  process.exit(3);
}

function refuseGuardTimeout(ms) {
  console.error(
    [
      `[code-intel] The freshness check did not complete within ${ms}ms — the verdict is UNKNOWN${cliTag()}.`,
      "",
      "Every subprocess the guard runs is bounded by that one deadline; a bounded wrapper",
      "refuses instead of hanging. Retry with a larger budget:",
      "  node scripts/code-intel.mjs <verb> ... --timeout <ms>",
    ].join("\n"),
  );
  process.exit(3);
}

function refuseQueryTimeout(ms) {
  console.error(
    [
      `[code-intel] The codegraph query did not answer within ${ms}ms and was killed — the answer is UNKNOWN${cliTag()}.`,
      "",
      "A bounded wrapper never hangs on a stuck query; an answer that never arrived is not",
      "an answer. Retry with a larger budget:",
      "  node scripts/code-intel.mjs <verb> ... --timeout <ms>",
    ].join("\n"),
  );
  process.exit(3);
}

function refuseQuerySpawnFailed(err) {
  console.error(
    [
      `[code-intel] The codegraph query could not run (${err?.code ?? err?.message ?? "unknown spawn error"}) — the answer is UNKNOWN${cliTag()}.`,
      "",
      "A failed spawn is a refusal, never an empty answer that looks like \"no results\".",
      "Check that the CLI runs:  codegraph --version",
    ].join("\n"),
  );
  process.exit(3);
}

function refuseNoRoot(err) {
  console.error(
    [
      "[code-intel] Cannot determine the target project root — refusing rather than guessing.",
      "",
      `  ${err.message.split("\n")[0]}`,
      "",
      "Name the target explicitly:",
      "  node scripts/code-intel.mjs <verb> --project-root <repo-root> ...",
      "Or run from inside the target repository — its git toplevel is the target, linked",
      "worktrees included. There is NO default to this script's own checkout.",
    ].join("\n"),
  );
  process.exit(3);
}

function refusePassthroughPath() {
  console.error(
    [
      "[code-intel] `--path` is not accepted here — it would retarget this one query past the",
      "freshness guard, which checked a different root.",
      "",
      "Name the target with --project-root <repo-root> (a linked worktree root is valid); the",
      "root is checked ONCE and every verb — status, sync and the query — addresses it.",
    ].join("\n"),
  );
  process.exit(2);
}

function refuseProjectRootWithoutValue() {
  console.error(
    [
      "[code-intel] --project-root needs a value — the target repo root (a git toplevel or a",
      "linked worktree root). A missing value would otherwise be guessed, which is the bug",
      "class this contract exists to close.",
    ].join("\n"),
  );
  process.exit(2);
}

function refuseTimeoutWithoutValue() {
  console.error(
    [
      "[code-intel] --timeout needs a positive number of milliseconds — it bounds every spawn",
      "this wrapper makes (the freshness guard and the query). A missing or invalid value",
      "would be guessed, which is the bug class this contract exists to close.",
    ].join("\n"),
  );
  process.exit(2);
}

function main() {
  const raw = process.argv.slice(2);

  // Flag extraction BEFORE verb handling: --project-root may sit anywhere, a
  // passthrough `--path` is refused before it can retarget one verb, and
  // --timeout is the wrapper's own budget (never forwarded to codegraph).
  let explicitRoot;
  let timeoutMs = null;
  const argv = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--project-root") {
      const v = raw[++i];
      if (v === undefined || v === "" || v.startsWith("--")) refuseProjectRootWithoutValue();
      explicitRoot = v;
    } else if (a.startsWith("--project-root=")) {
      const v = a.slice("--project-root=".length);
      if (!v) refuseProjectRootWithoutValue();
      explicitRoot = v;
    } else if (a === "--timeout" || a.startsWith("--timeout=")) {
      const v = a === "--timeout" ? raw[++i] : a.slice("--timeout=".length);
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) refuseTimeoutWithoutValue();
      timeoutMs = n;
    } else if (a === "--path" || a.startsWith("--path=")) {
      refusePassthroughPath();
    } else {
      argv.push(a);
    }
  }

  if (!argv[0] || argv[0] === "--help" || argv[0] === "-h") usage(0);

  if (RETIRED[argv[0]]) {
    console.error(`[code-intel] "${argv[0]}" was a GitNexus verb and has no CodeGraph equivalent.\n  ${RETIRED[argv[0]]}`);
    process.exit(2);
  }

  const guardBudget = timeoutMs ?? GUARD_TIMEOUT_MS;

  if (argv[0] === "ready") return readyCommand(explicitRoot, argv.slice(1), guardBudget);

  const sub = SUBCOMMANDS[argv[0]];
  if (!sub) {
    console.error(`[code-intel] unknown command "${argv[0]}"\n`);
    usage(2);
  }

  // The ONE root for everything this run does: resolution, baseline check,
  // status read, sync and the query all address it.
  let root;
  try {
    root = resolveProjectRoot({ projectRoot: explicitRoot, cwd: process.cwd() });
  } catch (err) {
    refuseNoRoot(err);
  }

  requireIndex(root);

  // Query verbs answer FROM the index, so freshness is proven first; `status`
  // is exempt because it IS the guard's instrument.
  if (QUERY_VERBS.has(argv[0])) freshnessGuard(root, guardBudget);

  // `--path root` because squads run from a worktree or a subdirectory, and
  // CodeGraph would otherwise resolve the index relative to cwd and report
  // "no index" for a repo that has one. `status` is the one subcommand that
  // does NOT accept --path (it takes only --json) — but it DOES take a
  // positional path, so it is passed that way; either spelling addresses the
  // SAME root the guard just verified.
  const args = [sub, ...argv.slice(1), ...(sub === "status" ? [root] : ["--path", root])];

  const res = spawnCli(args, { cwd: root, stdio: "inherit", timeout: timeoutMs ?? QUERY_TIMEOUT_MS });

  if (res.error?.code === "ETIMEDOUT") refuseQueryTimeout(timeoutMs ?? QUERY_TIMEOUT_MS);
  if (cliMissing(res)) notOnPath();
  if (res.error) refuseQuerySpawnFailed(res.error);
  process.exit(res.status ?? 1);
}

// `ready` — the root-testing verb: one-line JSON, exit 0 when the target's
// index is PROVEN ready, 3 when it is not (the UNKNOWN exit). It never
// initializes anything: provisioning belongs to the authorized launch
// preflight (supervisor-spawn) and to a human running `codegraph init`.
function readyCommand(explicitRoot, rest, timeoutMs = GUARD_TIMEOUT_MS) {
  let root = null;
  try {
    root = resolveProjectRoot({ projectRoot: explicitRoot, cwd: process.cwd() });
  } catch (err) {
    console.log(
      JSON.stringify({
        ok: false,
        root: null,
        reason: `root-unresolved: ${err.message.split("\n")[0]}`,
        synced: false,
        initialized: false,
      }),
    );
    process.exit(3);
  }
  const r = ensureCodegraphReady({ projectRoot: root, initialize: false, timeoutMs });
  if (typeof r.version === "string") cliVersion = r.version;
  console.log(
    JSON.stringify({
      ok: r.ok,
      root: r.root,
      reason: r.reason,
      synced: r.synced,
      initialized: r.initialized,
      ...(r.version ? { version: r.version } : {}),
    }),
  );
  process.exit(r.ok ? 0 : 3);
}

main();
