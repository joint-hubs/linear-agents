// scripts/codegraph-runtime.mjs — the shared CodeGraph runtime contract.
//
// ONE place that knows the three things every CodeGraph caller needs, so the
// CLI wrapper, the launch preflight and the MCP boundary peer cannot drift:
//
//   · WHICH project a query targets. The wrapper used to take the root from
//     its own script location (code-intel.mjs:55), so invoking
//     $LA_ROOT/scripts/code-intel.mjs from a task worktree silently targeted
//     the tooling checkout and the wrong tree answered confidently.
//     resolveProjectRoot replaces that: an explicit root wins; otherwise the
//     caller's cwd must resolve to a git toplevel (a linked worktree resolves
//     to THE WORKTREE, not the main checkout — git's own answer). There is no
//     fallback to the script location and no silent default; when neither
//     source resolves, this throws and the caller refuses.
//
//   · WHICH binary runs the CLI. On win32 `codegraph` is a .cmd shim, so a
//     shell:false spawn cannot launch it and shell:true spawns eat quoting.
//     resolveCodegraphCommand reads the first shim `where codegraph` finds —
//     the same binary cmd.exe and the MCP server's "command": "codegraph"
//     resolve to — and unwraps the node.exe + JS entry it points at, so every
//     caller spawns shell:false with real argument arrays. It never installs
//     and never upgrades anything.
//
//   · WHAT "ready" means. ensureCodegraphReady states the freshness contract
//     the CLI wrapper and the MCP boundary peer enforce (FOC-114 rounds 4–5
//     plus the 2026-09-23 review corrections), importably: readable
//     `status --json` with finite non-negative pending counts, a git baseline
//     (the pending signal is computed against it and reports false zeros
//     without one — measured, round 5), no borrowed index (worktreeMismatch),
//     no schema gap (the `index` block the installed CLI reports —
//     reindexRecommended, the extraction-version pair, state, pendingRefs —
//     checked only when supplied), sync ONLY when something is provably
//     stale, and — the P1 correction — the per-worktree exact-HEAD proof:
//
//     `.codegraph/synced-head` records the commit sha the index was PROVEN
//     synced at. The old "lastIndexed >= HEAD commit time" comparison could
//     not distinguish "synced after this HEAD" from "an older revision was
//     checked out / a backdated commit landed after a newer sync" — both
//     read pending 0/0/0 with a lastIndexed after HEAD's commit time, so
//     both answered from the stale graph (review 2026-09-23, P1). The guard
//     compares the stamp against exact `git rev-parse HEAD` instead: a
//     missing, mismatched or corrupt stamp triggers ONE bounded sync (never a
//     rebuild per query), git HEAD is re-read after it, and unless it is the
//     SAME sha on both sides freshness is UNKNOWN — the proof is never
//     claimed for a tree that moved under the check. The stamp is written
//     only after a successful sync/init/rebuild, atomically (temp file +
//     rename), inside the CLI's own per-root index directory.
//
// Bounds: every subprocess runs under the caller's overall deadline; nothing
// here calls process.exit; nothing caches freshness (the command resolution
// memoizes successes only — identity, not freshness); no watcher and no lock
// of our own — the CodeGraph package owns those (one watcher/engine per
// root, cross-process write lock). The one state file this module writes is
// the .codegraph/synced-head proof, inside the CLI's own gitignored index
// directory. No package instrument exposes the indexed revision; that is why
// the proof is ours to keep.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ── project root ─────────────────────────────────────────────────────────────

/**
 * Canonical project root for a CodeGraph target.
 *
 * Explicit `projectRoot` wins and is used exactly as given (realpath'd, never
 * re-resolved to a git toplevel — explicit means the caller decided). Without
 * one, the cwd must be inside a git repository and its toplevel is the target.
 * `git rev-parse --show-toplevel` inside a linked worktree returns the
 * worktree's own root, so every repo shape gets the right tree.
 *
 * @param {{projectRoot?: string, cwd?: string}} [opts]
 * @returns {string} canonical absolute path
 * @throws when the explicit root does not exist as a directory, or the cwd is
 *   not inside a git repository — the caller must refuse, never guess
 */
export function resolveProjectRoot({ projectRoot, cwd = process.cwd() } = {}) {
  if (projectRoot != null && String(projectRoot).trim() !== "") {
    const p = String(projectRoot);
    let st;
    try {
      st = statSync(p);
    } catch {
      throw new Error(`project root does not exist: ${p}`);
    }
    if (!st.isDirectory()) throw new Error(`project root is not a directory: ${p}`);
    return realpathSync(p);
  }
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  const top = (res.stdout || "").trim();
  if (res.error || res.status !== 0 || !top) {
    throw new Error(
      "current directory is not inside a git repository — pass --project-root <repo-root> " +
        "naming the target (a linked worktree root is a valid target)",
    );
  }
  return realpathSync(top);
}

// ── CLI binary ───────────────────────────────────────────────────────────────
//
// `where codegraph` (win32) / `which codegraph` (POSIX) lists candidates in
// PATH order — the same order cmd.exe resolves for the MCP server's
// "command": "codegraph", so the first hit IS the canonical binary. A .cmd
// candidate is unwrapped to the node.exe + JS entry the shim launches
// (`"%~dp0..\node.exe" ... "%~dp0..\lib\dist\bin\codegraph.js"`), because
// spawning the shim itself needs shell:true, which on win32 both mangles
// quoting and reports a missing binary as a plain exit 1.

let cmdCache = null;

function locateCodegraph(injected) {
  if (injected) return injected();
  return spawnSync(process.platform === "win32" ? "where" : "which", ["codegraph"], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

// A .cmd shim launches "%~dp0<relative>" targets; %~dp0 expands to the shim's
// own directory WITH a trailing separator, so each capture is shim-relative.
// Unwrapping is best-effort: an unreadable shim or a missing JS target is not
// proof the CLI is absent — the loop just tries the next candidate, and the
// bare-name fallback keeps the caller's proven not-on-PATH handling.
function parseCmdShim(shimPath) {
  let text;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const js = text.match(/"%~dp0([^"]+\.js)"/i);
  if (!js) return null;
  const shimDir = dirname(shimPath);
  const jsPath = join(shimDir, js[1]);
  if (!existsSync(jsPath)) return null;
  let command = process.execPath;
  const exe = text.match(/"%~dp0([^"]+\.exe)"/i);
  if (exe) {
    const candidate = join(shimDir, exe[1]);
    if (existsSync(candidate)) command = candidate;
  }
  return { command, args: [jsPath] };
}

/**
 * The codegraph binary to spawn — `{command, args}` ready for
 * spawnSync/spawn with shell:false, on Windows too (node.exe + JS entry).
 * The first PATH candidate is the same binary the MCP server's
 * "command": "codegraph" resolves to, so CLI and MCP never disagree about
 * which index writer they talk to. A `.ps1` candidate is skipped — a
 * PowerShell script is not spawnable under shell:false, so selecting it
 * would produce a binary that can never run. When nothing resolvable is
 * found the bare name `{command: "codegraph", args: []}` comes back —
 * correct on POSIX, and on win32 a signal to the caller to keep its proven
 * shell:true fallback. A failed probe is NEVER memoized (only a real
 * resolution is), so a retry after an install or PATH fix re-probes instead
 * of serving the negative result for the rest of the process. Never
 * installs, never upgrades the global package.
 *
 * @param {{where?: () => {status: number|null, stdout?: string}}} [inject]
 *   test seam replacing the where/which probe.
 * @returns {{command: string, args: string[]}}
 */
export function resolveCodegraphCommand(inject = {}) {
  if (cmdCache && inject.where === undefined) return cmdCache;
  const res = locateCodegraph(inject.where);
  const candidates = (res?.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let out = { command: "codegraph", args: [] };
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (lower.endsWith(".ps1")) continue; // not spawnable shell:false — skip
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      const unwrapped = parseCmdShim(candidate);
      if (!unwrapped) continue;
      out = unwrapped;
      break;
    }
    // A real .exe, or a POSIX shim with a shebang: spawn it directly.
    out = { command: candidate, args: [] };
    break;
  }
  // Memoize SUCCESS only: `out.command === "codegraph"` is the bare-name
  // fallback, i.e. nothing was found — caching it would freeze the failure.
  if (inject.where === undefined && out.command !== "codegraph") cmdCache = out;
  return out;
}

// ── the synced-head freshness proof ───────────────────────────────────────────
//
// `.codegraph/synced-head` is the per-worktree record that closes the false
// fresh shapes the package's own instruments cannot see (review 2026-09-23,
// P1): a BACKDATED commit and a BACKWARDS checkout both read
// pendingChanges 0/0/0 with a lastIndexed ordered after HEAD's commit time,
// and both leave the graph describing a different revision. No package
// instrument exposes the indexed revision, so the runtime keeps its own:
// the exact `git rev-parse HEAD` sha it PROVED the index synced at. The
// file lives inside the CLI's own per-root gitignored index directory, is
// written atomically (temp file + rename — the CLI's own per-root write
// discipline serializes index writers; no new lock, no daemon), and is
// rebuildable: deleting it costs one bounded sync, never a rebuild.

const SHA_RE = /^[0-9a-f]{40}$/i;

function readSyncedHeadStamp(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".codegraph", "synced-head"), "utf8"));
    return SHA_RE.test(parsed?.head) ? { head: parsed.head.toLowerCase() } : null;
  } catch {
    return null; // missing, unreadable or corrupt — never trusted as proof
  }
}

function writeSyncedHeadStamp(root, head) {
  const dir = join(root, ".codegraph");
  const tmp = join(dir, `synced-head.${process.pid}.${Date.now()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify({ head, syncedAt: new Date().toISOString() }) + "\n");
    renameSync(tmp, join(dir, "synced-head")); // atomic replace, both platforms
    return null;
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    return err;
  }
}

/**
 * Readiness per the FOC-114 contract (plus the 2026-09-23 review
 * corrections), importable. Never exits; every subprocess is bounded by
 * `timeoutMs` overall.
 *
 * Result: `{ok, root, reason, synced, initialized, version?, syncCause?,
 * pendingBefore?, mismatch?}`.
 *   ok          — true only when freshness is PROVEN
 *   root        — canonical target root, or null when unresolved
 *   reason      — null when ok; otherwise `<stable-prefix>: <detail>` with a
 *                 prefix the MCP peer may branch on: root-unresolved,
 *                 cli-not-found, timeout, status-unreadable, status-invalid,
 *                 index-missing, init-failed, index-missing-after-init,
 *                 index-schema-stale, index-rebuild-failed,
 *                 index-schema-stale-after-rebuild, no-git-baseline,
 *                 index-mismatch, sync-failed, pending-after-sync,
 *                 head-changed-midcheck, proof-unwritable
 *   synced      — true only when a sync ran here AND the state settled clean
 *   syncCause   — "pending" (dirt was synced) | "proof" (the synced-head
 *                 stamp was missing/mismatched) — present only when synced
 *   pendingBefore — the pending count that caused a "pending" sync
 *   initialized — the index exists and status says so
 *   version     — the CLI version `status` reported, when readable (carried
 *                 on refusals too, so a diagnostic names the refusing binary)
 *   mismatch    — the worktreeMismatch object, when that is the reason
 *
 * `initialize: true` is the AUTHORIZED provision path (the supervisor's launch
 * preflight): init runs once per missing index, non-interactively, and never
 * touches AGENTS.md/CLAUDE.md/.mcp.json — those are `codegraph install`'s
 * territory (verified against 1.6.0 on 2026-09-23: sentinel files around a
 * real `init -y` were byte-identical). It is also the only path that may
 * REBUILD a schema-stale index, in place, via `codegraph index <root>` —
 * "Rebuild the full index from scratch (same result as a fresh init)" per the
 * installed 1.5's own `index --help` — with the schema re-verified after.
 * With `initialize: false` a missing index is a reported reason and a schema
 * gap is a refusal, never a side effect.
 *
 * `runner` (file, args, opts) → spawnSync-like result is the test seam; the
 * default resolves the canonical binary and bounds every call by the shared
 * deadline. Git itself (the exact-HEAD baseline) goes through the same runner.
 */
export function ensureCodegraphReady({
  projectRoot,
  cwd = process.cwd(),
  initialize = false,
  timeoutMs = 30_000,
  runner = defaultRunner,
} = {}) {
  let version;
  const fail = (root, reason, extra = {}) => ({
    ok: false,
    root,
    reason,
    synced: false,
    initialized: false,
    ...(version ? { version } : {}),
    ...extra,
  });

  let root;
  try {
    root = resolveProjectRoot({ projectRoot, cwd });
  } catch (err) {
    return fail(null, `root-unresolved: ${err.message}`);
  }

  const deadline = Date.now() + timeoutMs;
  const left = () => deadline - Date.now();
  const TIMED_OUT = { status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } };
  // Every call shares the caller's deadline; an over-budget call reports
  // timeout rather than hanging the launch preflight.
  const run = (file, args, opts = {}) => {
    if (left() <= 0) return TIMED_OUT;
    return runner(file, args, {
      cwd: opts.cwd ?? root,
      timeoutMs: Math.min(opts.timeoutMs ?? 10_000, left()),
    });
  };

  const readStatus = () => {
    const r = run("codegraph", ["status", root, "--json"]);
    if (r.error?.code === "ENOENT") return { fail: "cli-not-found" };
    if (r.error?.code === "ETIMEDOUT") return { fail: "timeout" };
    const start = (r.stdout || "").indexOf("{");
    if (r.status !== 0 && start < 0) {
      // The wrapper's own disambiguation (FOC-114 §4): on win32 a missing
      // binary surfaces as a plain non-zero exit, not ENOENT — `where` proves
      // absence only with ITS OWN exit 1. Anything else stays status-unreadable.
      if (r.error == null && r.status !== 0) {
        const w = run("where", ["codegraph"], { timeoutMs: 10_000 });
        if (w.status === 1) return { fail: "cli-not-found" };
      }
      return { fail: "status-unreadable" };
    }
    let json;
    try {
      json = JSON.parse((r.stdout || "").slice(start));
    } catch {
      return { fail: "status-unreadable" };
    }
    if (!json || typeof json !== "object") return { fail: "status-unreadable" };
    return { json };
  };

  const pendingOf = (json) => {
    const p = json?.pendingChanges;
    const nums = p ? [p.added, p.modified, p.removed] : null;
    // Counts must be real, whole, non-negative numbers — a corrupt index
    // answering `{"initialized":false}` or a negative/infinite count proves
    // nothing, and a value that proves nothing is UNKNOWN, never "clean".
    if (!nums || nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
    return nums[0] + nums[1] + nums[2];
  };

  let json = null;

  // ── index present? (provision only when authorized) ──────────────────────
  {
    const st = readStatus();
    if (st.fail) return fail(root, st.fail);
    json = st.json;
  }
  if (typeof json?.version === "string") version = json.version;
  // An index THIS run built (init below, or the schema rebuild further down)
  // is at the current tree — the proof can be written without another sync.
  let provisioned = false;
  if (json.initialized !== true) {
    if (!initialize) return fail(root, "index-missing");
    // Non-interactive init. `-y` is discovered from the installed CLI's own
    // help rather than assumed — a future CLI could rename it, and a flag the
    // binary does not know would fail the provisioning outright.
    const flags = discoverInitFlags(run);
    const init = run("codegraph", ["init", ...flags, root], { timeoutMs: Math.max(left(), 1) });
    if (init.error?.code === "ETIMEDOUT") return fail(root, "timeout");
    if (init.error || (init.status ?? 1) !== 0) return fail(root, "init-failed");
    const again = readStatus();
    if (again.fail) return fail(root, again.fail);
    json = again.json;
    if (typeof json?.version === "string") version = json.version;
    if (json.initialized !== true) return fail(root, "index-missing-after-init");
    provisioned = true;
  }
  const initialized = true;

  // ── the git baseline, as the exact sha the proof compares ──────────────────
  // One `git rev-parse HEAD` is both the no-baseline check and the sha the
  // synced-head proof compares. The old commit-time comparison (%cI) is gone:
  // it could not see a backdated commit or a backwards checkout (P1, review
  // 2026-09-23) — only the sha can.
  const headRes = run("git", ["rev-parse", "HEAD"]);
  if (headRes.error || headRes.status !== 0) {
    return fail(root, "no-git-baseline: git rev-parse HEAD failed — no committed HEAD in this tree");
  }
  const headSha = (headRes.stdout || "").trim().toLowerCase();
  if (!SHA_RE.test(headSha)) {
    return fail(root, "status-invalid: git rev-parse HEAD returned something not shaped like a commit sha");
  }

  const mismatchReason = (m) =>
    `index-mismatch: the index was built for ${m.indexRoot ?? "another tree"} ` +
    `(this worktree: ${m.worktreeRoot ?? root}) — one index per worktree; run codegraph init at the target root`;

  const mismatch = json.worktreeMismatch ?? null;
  if (mismatch) return fail(root, mismatchReason(mismatch), { mismatch });

  let pending = pendingOf(json);
  if (pending === null) {
    return fail(root, "status-invalid: pendingChanges missing or not finite non-negative integers");
  }

  // ── schema-stale: the index was built by a different extraction ────────────
  // The fields live under `index` in `status --json` (verified against the
  // installed 1.5.0 on 2026-09-23: reindexRecommended,
  // builtWithExtractionVersion, currentExtractionVersion, state, pendingRefs)
  // and are checked ONLY when supplied — a status that reports none of them
  // stays provable by the rest of the contract. The comparison runs against
  // the SAME resolved binary that would answer the query, so a disagreeing
  // pair is a real schema gap, never a PATH-order artifact: both numbers come
  // out of one process's status.
  const schemaStaleness = (j) => {
    const idx = j?.index;
    if (!idx || typeof idx !== "object") return null;
    const bits = [];
    if (idx.reindexRecommended === true) bits.push("reindexRecommended=true");
    const built = idx.builtWithExtractionVersion;
    const current = idx.currentExtractionVersion;
    if (built != null && current != null && String(built) !== String(current)) {
      bits.push(`builtWithExtractionVersion ${built} != currentExtractionVersion ${current}`);
    }
    if (idx.state != null && idx.state !== "complete") bits.push(`index state "${idx.state}" is not complete`);
    if (Number.isInteger(idx.pendingRefs) && idx.pendingRefs > 0) bits.push(`${idx.pendingRefs} refs still pending`);
    return bits.length ? bits.join("; ") : null;
  };

  const schemaStale = schemaStaleness(json);
  if (schemaStale) {
    if (!initialize) return fail(root, `index-schema-stale: ${schemaStale}`);
    // Authorized rebuild, in place. `codegraph index` is a FULL rebuild per
    // its own help; a sync cannot close a schema gap, so none is attempted.
    const rb = run("codegraph", ["index", root], { timeoutMs: Math.max(left(), 1) });
    if (rb.error?.code === "ETIMEDOUT") return fail(root, "timeout");
    if (rb.error || (rb.status ?? 1) !== 0) {
      const why = (rb.stderr || rb.stdout || "").trim().split(/\r?\n/)[0] || "";
      return fail(
        root,
        `index-rebuild-failed: codegraph index exited ${rb.status ?? "without a status"}${why ? ` — ${why}` : ""}`,
      );
    }
    const after = readStatus();
    if (after.fail) return fail(root, after.fail);
    json = after.json;
    if (typeof json?.version === "string") version = json.version;
    if (json.initialized !== true) {
      return fail(root, "index-rebuild-failed: the index is still missing after codegraph index");
    }
    const still = schemaStaleness(json);
    if (still) return fail(root, `index-schema-stale-after-rebuild: ${still}`);
    if (json.worktreeMismatch) return fail(root, mismatchReason(json.worktreeMismatch), { mismatch: json.worktreeMismatch });
    pending = pendingOf(json);
    if (pending === null) {
      return fail(root, "status-invalid: pendingChanges missing or not finite non-negative integers");
    }
    provisioned = true;
  }

  // ── sync ONLY when something is provably stale ─────────────────────────────
  let synced = false;
  let syncCause = null;
  let pendingBefore = 0;
  const doSync = () => {
    const s = run("codegraph", ["sync", root], { timeoutMs: Math.max(left(), 1) });
    if (s.error?.code === "ETIMEDOUT") return "timeout";
    if (s.error || (s.status ?? 1) !== 0) {
      const why = (s.stderr || s.stdout || "").trim().split(/\r?\n/)[0] || "";
      return `sync-failed: codegraph sync exited ${s.status ?? "without a status"}${why ? ` — ${why}` : ""}`;
    }
    const after = readStatus();
    if (after.fail) return after.fail;
    json = after.json;
    if (typeof json?.version === "string") version = json.version;
    if (json.worktreeMismatch) return mismatchReason(json.worktreeMismatch);
    const p2 = pendingOf(json);
    if (p2 === null) return "status-invalid: pendingChanges missing or not finite non-negative integers";
    pending = p2;
    return null;
  };

  // (a) dirt against the git baseline: pendingChanges sees it, sync clears it.
  if (pending > 0) {
    pendingBefore = pending;
    const err = doSync();
    if (err) return fail(root, err);
    if (pending > 0) return fail(root, `pending-after-sync: ${pending} change(s) still pending — the index does not settle`);
    synced = true;
    syncCause = "pending";
  }

  // (b) the exact-HEAD proof (P1 correction): a missing, mismatched or
  // corrupt stamp means the index was last PROVEN synced at some other
  // revision — a backdated commit and a backwards checkout both read
  // pending 0/0/0 here, which is exactly why the sha, not the timestamp,
  // decides. ONE bounded sync re-proves; after a run that already synced
  // (a) or provisioned the index (init/rebuild), the tree is current and
  // the sync is not repeated. The HEAD is re-read around the write: unless
  // it is the SAME sha on both sides, freshness is UNKNOWN and no proof is
  // claimed — an answer would describe neither revision.
  const stamp = readSyncedHeadStamp(root);
  if (!stamp || stamp.head !== headSha) {
    if (!synced && !provisioned) {
      const err = doSync();
      if (err) return fail(root, err);
      if (pending > 0) {
        return fail(root, `pending-after-sync: ${pending} change(s) still pending — the index does not settle`);
      }
      synced = true;
      syncCause = "proof";
    }
    const again = run("git", ["rev-parse", "HEAD"]);
    if (again.error || again.status !== 0) {
      return fail(root, "no-git-baseline: git rev-parse HEAD failed while the proof was being written");
    }
    const sha2 = (again.stdout || "").trim().toLowerCase();
    if (!SHA_RE.test(sha2)) {
      return fail(root, "status-invalid: git rev-parse HEAD returned something not shaped like a commit sha");
    }
    if (sha2 !== headSha) {
      return fail(
        root,
        `head-changed-midcheck: git HEAD moved ${headSha.slice(0, 8)}..${sha2.slice(0, 8)} while freshness was being proven — an answer would describe neither revision`,
      );
    }
    const werr = writeSyncedHeadStamp(root, headSha);
    if (werr) return fail(root, `proof-unwritable: cannot write .codegraph/synced-head — ${werr.message}`);
  }

  return {
    ok: true,
    root,
    reason: null,
    synced,
    initialized,
    ...(synced
      ? { syncCause, ...(syncCause === "pending" ? { pendingBefore } : {}) }
      : {}),
    ...(version ? { version } : {}),
  };
}

// ── the default runner ───────────────────────────────────────────────────────

// Under shell:true (win32 fallback) node hands the command line to cmd.exe
// unquoted, so a path with spaces must be quoted here; POSIX spawns skip the
// shell and get real argument arrays, where quoting would be wrong.
function quoteForShell(p) {
  if (process.platform !== "win32" || !/[\s"&|<>^]/.test(p)) return p;
  return `"${p.replaceAll('"', '""')}"`;
}

function defaultRunner(file, args, opts = {}) {
  const spawnOpts = {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 10_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  };
  if (file === "codegraph") {
    const cmd = resolveCodegraphCommand();
    const shell = cmd.command === "codegraph" && process.platform === "win32";
    const finalArgs = shell ? args.map(quoteForShell) : args;
    return spawnSync(cmd.command, [...cmd.args, ...finalArgs], { ...spawnOpts, shell });
  }
  return spawnSync(file, args, spawnOpts);
}

// The installed CLI's own help is the source of truth for the non-interactive
// flag (1.6.0 ships `-y, --yes`; the resolved 1.5.0 ships none — verified
// 2026-09-23, which is why discovery, not assumption); discovering it beats
// assuming, because an unknown flag would fail provisioning outright. Nothing
// else is passed — no --force, and no installer flags: init must not touch
// agent config files.
function discoverInitFlags(run) {
  const help = run("codegraph", ["init", "--help"], { timeoutMs: 10_000 });
  const text = `${help.stdout ?? ""}${help.stderr ?? ""}`;
  return /(^|\s)-y\b|--yes\b/.test(text) ? ["-y"] : [];
}
