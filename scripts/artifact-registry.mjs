// scripts/artifact-registry.mjs — FOC-779: registered generated artifacts,
// their freshness, and the refresh that keeps them fresh.
//
// The registry (config/artifacts.json, committed) lists every artifact the
// repo generates — models.map, ui/dist, atlas-mcp.json, diagram PNGs, the
// CodeGraph index, the analysis cache — with what it is derived from, how it
// is regenerated, and who owns the regeneration. Freshness is content-based:
// a sha256 over the sorted `relpath\0size\0sha256(content)` lines of the
// matched sources, so a fresh clone matches an already-refreshed tree (mtime
// comparisons could not), and touching a file without changing it does not
// flip an entry stale.
//
// The manifest <dataHome>/artifacts-manifest.json (LA_ARTIFACTS_MANIFEST seam;
// gitignored, outside the repo tree) records, per artifact, the HEAD sha and
// source digest at generation time. `refresh` runs the generator of every
// start/watch entry that is stale or missing, never two ways: external and
// launcher entries are reported only, one generator failure never blocks the
// others, and inside the container entries marked inContainer:false are
// skipped (the image ships them).
//
// CLI:
//   node scripts/artifact-registry.mjs status [--json] [--root <path>]
//   node scripts/artifact-registry.mjs refresh [--json] [--dry-run] [--only <id>]
//                                              [--in-container] [--root <path>]
// Exit: 0 ok, 1 when refresh left failures, 2 on usage.
//
// Run: node scripts/artifact-registry.test.mjs

import { createHash } from "node:crypto";
import {
  existsSync,
  globSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atomicWriteJSON } from "./utils.mjs";
import { dataHome } from "./fenix-paths.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, "..");

const REGISTRY_PATH = (root) => join(root, "config", "artifacts.json");
const REFRESH_KINDS = new Set(["start", "watch", "launcher", "external"]);
const SHA_RE = /^[0-9a-f]{40,64}$/;

const USAGE = [
  "Usage: node scripts/artifact-registry.mjs <command> [flags]",
  "",
  "  status [--json] [--root <path>]        every artifact's freshness, one line each",
  "  refresh [--dry-run] [--only <id>]      regenerate stale/missing start/watch",
  "          [--in-container] [--root <path>] artifacts, update the manifest",
  "",
  "Manifest: <dataHome>/artifacts-manifest.json, overridden by LA_ARTIFACTS_MANIFEST.",
].join("\n");

// ── registry ─────────────────────────────────────────────────────────────────

// Read + validate config/artifacts.json. A committed registry that is missing
// or malformed is a real defect — throw with the path in the message, never
// silently report nothing.
export function readRegistry({ root }) {
  const path = REGISTRY_PATH(root);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`artifact registry unreadable: ${path} (${err.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`artifact registry is not valid JSON: ${path}`);
  }
  return { ...validateRegistry(parsed, path), path };
}

function validateRegistry(parsed, path) {
  const bad = (msg) => {
    throw new Error(`artifact registry ${path}: ${msg}`);
  };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) bad("not an object");
  if (parsed.version !== 1) bad(`version must be 1, got ${JSON.stringify(parsed.version)}`);
  if (!Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0) {
    bad("artifacts must be a non-empty array");
  }
  const seen = new Set();
  for (const entry of parsed.artifacts) {
    if (!entry || typeof entry !== "object") bad("artifact entry is not an object");
    if (typeof entry.id !== "string" || !entry.id) bad("entry id must be a non-empty string");
    if (typeof entry.title !== "string" || !entry.title) bad(`entry ${entry.id}: title must be a non-empty string`);
    if (typeof entry.notes !== "string") bad(`entry ${entry.id}: notes must be a string`);
    if (!/^[a-z0-9-]+$/.test(entry.id)) bad(`entry id "${entry.id}" must match [a-z0-9-]+`);
    if (seen.has(entry.id)) bad(`duplicate entry id "${entry.id}"`);
    seen.add(entry.id);
    if (entry.output !== null && typeof entry.output !== "string") {
      bad(`entry ${entry.id}: output must be a string or null`);
    }
    if (!Array.isArray(entry.sources) || entry.sources.some((s) => typeof s !== "string" || !s)) {
      bad(`entry ${entry.id}: sources must be an array of non-empty strings`);
    }
    const gen = entry.generator;
    if (gen !== null && (!gen || !Array.isArray(gen.cmd) || gen.cmd.length === 0 || gen.cmd.some((c) => typeof c !== "string" || !c))) {
      bad(`entry ${entry.id}: generator must be null or { cmd: [string, ...] }`);
    }
    if (!REFRESH_KINDS.has(entry.refresh)) {
      bad(`entry ${entry.id}: refresh must be one of ${[...REFRESH_KINDS].join(", ")} (got ${JSON.stringify(entry.refresh)})`);
    }
    if (typeof entry.committed !== "boolean") bad(`entry ${entry.id}: committed must be a boolean`);
    if (typeof entry.inContainer !== "boolean") bad(`entry ${entry.id}: inContainer must be a boolean`);
  }
  return parsed;
}

// ── the manifest ─────────────────────────────────────────────────────────────

// <dataHome>/artifacts-manifest.json by default (the mutable-state home, not
// the repo); LA_ARTIFACTS_MANIFEST wins so tests and hooks can point it at a
// temp file. Resolved at call time so a test can set the env after import.
export function manifestPath(env = process.env) {
  if (env.LA_ARTIFACTS_MANIFEST) return resolve(env.LA_ARTIFACTS_MANIFEST);
  return join(dataHome(env), "artifacts-manifest.json");
}

// Read the manifest; a missing or corrupt file means "never refreshed" —
// every managed entry then reports stale (no manifest entry), never an error.
export function readManifest({ manifestPath: path }) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.artifacts || typeof parsed.artifacts !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ── sources: matching + the content digest ───────────────────────────────────

const GLOB_MAGIC = /[*?[\]{]/;
const hasMagic = (pattern) => GLOB_MAGIC.test(pattern);

// Files matched by one source pattern, as [{ rel, abs, size }] with rel in "/"
// form. Regular files only — directories and symlinks are never followed, so
// a planted link cannot pull an outside tree into the digest. fs.globSync when
// this Node has it (22.20 does), else a tiny recursive `**`/`*` matcher.
function matchSource(pattern, root) {
  const hasGlobSync = typeof globSync === "function";
  const candidates = hasGlobSync
    ? globSync(pattern, { cwd: root })
    : miniGlob(pattern, root);
  const out = [];
  for (const hit of candidates) {
    const rel = relative(root, resolve(root, hit)).split(sep).join("/");
    if (!rel || rel.startsWith("..")) continue;
    const abs = join(root, ...rel.split("/"));
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({ rel, abs, size: st.size });
  }
  return out;
}

// Fallback matcher for Nodes without fs.globSync: `**` spans segments, `*`
// stays inside one segment, everything else is literal. Never follows
// symlinks (directories are only descended when they are real dirs).
function miniGlob(pattern, root) {
  const segments = pattern.split("/");
  const hits = [];
  const walk = (dir, segs, rel) => {
    const [seg, ...rest] = segs;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const segOk = seg === "**" ? true : segMatch(seg, entry.name);
      if (!segOk) continue;
      const abs = join(dir, entry.name);
      if (rest.length === 0) {
        if (entry.isFile()) hits.push(childRel);
        continue;
      }
      if (seg === "**") {
        if (entry.isDirectory()) {
          walk(abs, rest, childRel); // consume the ** here
          walk(abs, segs, childRel); // ...or let it span deeper
        } else {
          walk(abs, segs, childRel); // a file passes a spanning ** through
        }
        continue;
      }
      if (entry.isDirectory()) walk(abs, rest, childRel);
    }
  };
  walk(root, segments, "");
  return hits;
}

const segMatch = (seg, name) => {
  if (seg === "*") return true;
  if (!seg.includes("*")) return seg === name;
  const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
  return re.test(name);
};

// Content digest of everything an entry's sources match: sha256 over the
// sorted `relpath\0size\0sha256(content)` lines. Patterns that match nothing
// are REPORTED (missingSources), never thrown — a fresh clone before the
// first generation must still be describable. An entry with no sources (or
// nothing matched) has no digest (null).
export function sourceDigest(entry, { root }) {
  const files = [];
  const missingSources = [];
  for (const pattern of entry.sources) {
    const matched = matchSource(pattern, root);
    if (matched.length === 0) missingSources.push(pattern);
    files.push(...matched);
  }
  if (entry.sources.length === 0 || files.length === 0) {
    return { digest: null, files: files.length, missingSources };
  }
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const lines = [...byRel.keys()]
    .sort()
    .map((rel) => {
      const f = byRel.get(rel);
      return `${rel}\0${f.size}\0${sha256File(f.abs)}`;
    });
  return {
    digest: createHash("sha256").update(lines.join("\n")).digest("hex"),
    files: lines.length,
    missingSources,
  };
}

const sha256File = (abs) =>
  createHash("sha256").update(readFileSync(abs)).digest("hex");

// The current git HEAD of the tree being described — the sha the manifest
// records so a status row can show which revision produced the output. Null
// when git fails (no commit yet, no git at all): digest remains the real
// freshness instrument, head is provenance only.
export function currentHead({ root }) {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  const head = (res.stdout || "").trim().toLowerCase();
  return SHA_RE.test(head) ? head : null;
}

// ── status ───────────────────────────────────────────────────────────────────

// One entry's freshness. State vocabulary (mirrors code-intel's verdict style):
//   fresh    — output exists, manifest entry present, source digest unchanged
//   stale    — output exists but the manifest entry is missing or its digest
//              differs (content, not mtime)
//   missing  — the output is not on disk at all
//   external — refresh launcher/external: reported only, never managed here
export function artifactStatus(entry, { root, manifest, head, now = Date.now() }) {
  const base = {
    id: entry.id,
    title: entry.title,
    output: entry.output,
    refresh: entry.refresh,
    committed: entry.committed,
    inContainer: entry.inContainer,
    exists: false,
    outputMtime: null,
    age: null,
    head: head ?? null,
    digest: null,
    missingSources: [],
    manifest: null,
    state: "external",
    reason: null,
  };

  const outputProbe = probeOutput(entry, root, now);
  Object.assign(base, outputProbe);

  if (entry.refresh === "external" || entry.refresh === "launcher") {
    base.state = "external";
    base.reason = `refresh ${entry.refresh} — reported only${
      entry.id === "codegraph-index" ? "" : outputProbe.exists ? "" : " (output absent)"
    }`;
    if (entry.id === "codegraph-index") {
      const verdict = codegraphVerdict(root);
      base.verdict = verdict.verdict;
      base.reason = `code-intel status: ${verdict.reason}`;
    }
    return base;
  }

  const digestInfo = sourceDigest(entry, { root });
  base.digest = digestInfo.digest;
  base.missingSources = digestInfo.missingSources;

  const man = manifest?.artifacts?.[entry.id] ?? null;
  base.manifest = man
    ? { head: man.head ?? null, digest: man.digest ?? null, generatedAt: man.generatedAt ?? null }
    : null;

  if (!outputProbe.exists) {
    base.state = "missing";
    base.reason = "output missing";
    return base;
  }
  if (!man) {
    base.state = "stale";
    base.reason = "no manifest entry (never refreshed here)";
    return base;
  }
  if (digestInfo.digest === null) {
    base.state = "stale";
    base.reason = digestInfo.missingSources.length
      ? `sources missing: ${digestInfo.missingSources.join(", ")}`
      : "no source files matched";
    return base;
  }
  if (man.digest !== digestInfo.digest) {
    base.state = "stale";
    base.reason = "source digest changed since last refresh";
    return base;
  }
  base.state = "fresh";
  base.reason = null;
  return base;
}

// exists + mtime for an output that may be a literal path, a directory, a
// glob ("docs/diagrams/*.png"), or null (nothing on disk to look at). For a
// glob the newest matched file's mtime is the output mtime; for a directory
// the directory's own mtime.
function probeOutput(entry, root, now = Date.now()) {
  if (!entry.output) return { exists: false, outputMtime: null, age: null };
  const newest = (stats) => stats.length ? Math.max(...stats.map((s) => s.mtimeMs)) : null;
  let exists = false;
  let mtimeMs = null;
  if (hasMagic(entry.output)) {
    const hits = typeof globSync === "function"
      ? globSync(entry.output, { cwd: root })
      : miniGlob(entry.output, root);
    const stats = [];
    for (const hit of hits) {
      const abs = join(root, ...String(hit).split("/"));
      try {
        const st = lstatSync(abs);
        if (st.isFile()) stats.push(st);
      } catch {
        // vanished between glob and stat — not an output file then
      }
    }
    exists = stats.length > 0;
    mtimeMs = newest(stats);
  } else {
    const abs = join(root, ...entry.output.split("/"));
    exists = existsSync(abs);
    if (exists) {
      try {
        mtimeMs = statSync(abs).mtimeMs;
      } catch {
        mtimeMs = null;
      }
    }
  }
  const age = mtimeMs === null ? null : Math.max(0, Math.round((now - mtimeMs) / 1000));
  return { exists, outputMtime: mtimeMs === null ? null : new Date(mtimeMs).toISOString(), age };
}

// The codegraph index's own verdict, delegated to the wrapper that owns the
// freshness vocabulary (code-intel.mjs status). Its exit codes ARE the
// vocabulary: 0 proven fresh, 3 the UNKNOWN refusal, anything else also
// unproven. A wrapper that cannot run at all is "unknown", never "fresh".
function codegraphVerdict(root) {
  const res = spawnSync(
    process.execPath,
    [join(SCRIPTS_DIR, "code-intel.mjs"), "status", "--project-root", root],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  if (res.error || typeof res.status !== "number") {
    return { verdict: "unknown", reason: "code-intel unavailable" };
  }
  if (res.status === 0) return { verdict: "fresh", reason: "index proven fresh for HEAD" };
  const detail = (res.stderr || "").split("\n").find((l) => l.includes("[code-intel]"));
  return { verdict: "unknown", reason: detail ? detail.trim() : `code-intel status exit ${res.status}` };
}

// Every entry's status against one shared manifest/head read.
export function artifactStatuses({ root, manifestPath: mpArg, now = Date.now() }) {
  const mp = mpArg || manifestPath();
  const { artifacts } = readRegistry({ root });
  const manifest = readManifest({ manifestPath: mp });
  const head = currentHead({ root });
  return {
    computedAt: new Date(now).toISOString(),
    head,
    manifestPath: mp,
    artifacts: artifacts.map((entry) => artifactStatus(entry, { root, manifest, head, now })),
  };
}

// ── the cross-process refresh lock ───────────────────────────────────────────

// <manifest>.lock, JSON { pid, startedAt, ids }: serializes refreshes across
// PROCESSES — bin/dashboard.bat's CLI refresh and a running server's tick
// (which refreshes through a CLI child) both go through refreshArtifacts, and
// two concurrent runs would both empty and rewrite ui/dist. A run that crashed
// with the lock held must not wedge refreshes forever: a lock whose pid is
// dead or whose startedAt is older than LOCK_TIMEOUT_MS is stale and may be
// replaced. Held by a live process → the whole refresh is skipped
// (`locked: true`), never queued — the next call retries.
const LOCK_TIMEOUT_MS = 15 * 60_000;

// A 0-signal probe: no throw = alive; EPERM = alive but unsignalable (another
// user's process); anything else (ESRCH, ...) = gone.
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

// Who holds the lock right now? Anything unreadable — corrupted JSON from a
// half-written lock included — counts as stale, so a crash can never block.
function lockHolder(lockPath, { now, timeoutMs = LOCK_TIMEOUT_MS, alive = pidAlive } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return { stale: true, pid: null };
  }
  const pid = typeof parsed?.pid === "number" ? parsed.pid : null;
  const startedAt = Date.parse(parsed?.startedAt);
  if (Number.isNaN(startedAt) || now - startedAt > timeoutMs) {
    return { stale: true, pid };
  }
  if (pid === null || !alive(pid)) return { stale: true, pid };
  return { stale: false, pid };
}

// Take the lock for `candidates`: O_EXCL create after clearing a stale holder,
// never an overwrite of a lock someone else may have just taken. Returning
// { ok: false, pid } means a live process holds it.
function acquireArtifactLock(lockPath, candidates, { now, timeoutMs, alive } = {}) {
  const holder = lockHolder(lockPath, { now, timeoutMs, alive });
  if (!holder.stale) return { ok: false, pid: holder.pid };
  if (existsSync(lockPath)) {
    try {
      unlinkSync(lockPath);
    } catch {
      // lost the race to clear it — the exclusive create below decides
    }
  }
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date(now).toISOString(),
        ids: candidates.map((e) => e.id),
      }) + "\n",
      { flag: "wx" }, // exclusive: fail loudly rather than clobber a live lock
    );
    return { ok: true };
  } catch {
    // someone created it between the clear and the create — read who
    const again = lockHolder(lockPath, { now, timeoutMs, alive });
    return { ok: false, pid: again.stale ? null : again.pid };
  }
}

// ── refresh ──────────────────────────────────────────────────────────────────

// Regenerate every start/watch entry that is stale or missing, then record
// head + digest + generatedAt per refreshed id in the manifest. One generator
// failure lands in `failed` and never blocks the others; launcher/external
// entries and fresh entries are skipped with the reason; inContainer:true and
// an entry marked inContainer:false means "the image ships it" — skipped.
// `runGenerator` is injectable so tests never run `npm run build`.
export function refreshArtifacts({
  root,
  manifestPath: mpArg,
  only,
  dryRun = false,
  inContainer = false,
  now = Date.now(),
  runGenerator,
  isPidAlive,
  lockTimeoutMs,
} = {}) {
  const mp = mpArg || manifestPath();
  const { artifacts } = readRegistry({ root });
  const manifest = readManifest({ manifestPath: mp });
  const entries = { ...(manifest?.artifacts ?? {}) };
  const head = currentHead({ root });
  const refreshed = [];
  const skipped = [];
  const failed = [];
  const candidates = []; // entries whose generator must actually run

  for (const entry of artifacts) {
    if (only && entry.id !== only) {
      skipped.push({ id: entry.id, reason: "not selected (--only)" });
      continue;
    }
    if (entry.refresh !== "start" && entry.refresh !== "watch") {
      skipped.push({ id: entry.id, reason: `refresh ${entry.refresh} — not managed here` });
      continue;
    }
    if (inContainer && entry.inContainer === false) {
      skipped.push({ id: entry.id, reason: "not-in-container" });
      continue;
    }
    const st = artifactStatus(entry, { root, manifest, head, now });
    if (st.state === "fresh") {
      skipped.push({ id: entry.id, reason: "fresh" });
      continue;
    }
    if (dryRun) {
      skipped.push({ id: entry.id, reason: `dry-run (${st.state})` });
      continue;
    }
    candidates.push(entry);
  }

  // Cross-process lock, taken before ANY generator runs (and never by a
  // dry-run or an all-fresh pass). Held by a live process → report and leave
  // the generators untouched.
  let lockPath = null;
  if (candidates.length > 0) {
    lockPath = `${mp}.lock`;
    const got = acquireArtifactLock(lockPath, candidates, {
      now,
      timeoutMs: lockTimeoutMs,
      alive: isPidAlive,
    });
    if (!got.ok) {
      return {
        refreshed: [],
        skipped: candidates.map((e) => ({ id: e.id, reason: `locked by pid ${got.pid ?? "unknown"}` })),
        failed: [],
        locked: true,
        manifestPath: mp,
        head,
      };
    }
  }

  try {
    for (const entry of candidates) {
      const run = runGenerator
        ? runGenerator(entry, { root })
        : defaultRunGenerator(entry, root);
      if (!run || run.ok !== true) {
        failed.push({ id: entry.id, error: (run && run.error) || "generator failed" });
        continue;
      }
      const dig = sourceDigest(entry, { root });
      const probe = probeOutput(entry, root, now);
      if (dig.digest === null || !probe.exists) {
        failed.push({ id: entry.id, error: "generator reported success but the output is missing" });
        continue;
      }
      entries[entry.id] = {
        head,
        digest: dig.digest,
        generatedAt: new Date(now).toISOString(),
        generator: entry.generator ? entry.generator.cmd.join(" ") : null,
      };
      refreshed.push({ id: entry.id, digest: dig.digest, generatedAt: entries[entry.id].generatedAt });
    }

    if (refreshed.length > 0) {
      const sorted = {};
      for (const id of Object.keys(entries).sort()) sorted[id] = entries[id];
      atomicWriteJSON(mp, { version: 1, artifacts: sorted });
    }
  } finally {
    // The lock never outlives the call — a generator throw included.
    if (lockPath) {
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone (lost a stale-replacement race) — the invariant holds
      }
    }
  }
  return { refreshed, skipped, failed, manifestPath: mp, head };
}

// ── the server-side refresh: async, via this script as a child process ──────

// The telemetry server's tick must never block its event loop on a generator —
// a ui/dist rebuild (vite) takes seconds of spawnSync, and every dashboard
// request freezes with it. The route's default refresh therefore runs THIS
// script as a child process with an async spawn and parses the CLI's --json
// result (the CLI captures generator output itself, so --json stdout is
// exactly one JSON document). A run that reports failures (exit 1) still
// resolves to its parsed result — the caller keys off `failed` — while a child
// that cannot be spawned at all, or whose stdout is not the result, rejects.
// `spawnImpl` is injectable so tests can assert the argv without spawning.
export function refreshArtifactsViaCli({ root, manifestPath: mpArg, only, inContainer = false, spawnImpl } = {}) {
  const mp = mpArg || manifestPath();
  const argv = [
    join(SCRIPTS_DIR, "artifact-registry.mjs"),
    "refresh",
    ...(only != null ? ["--only", only] : []),
    "--root",
    root,
    "--json",
  ];
  if (inContainer) argv.push("--in-container");
  const run = spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    const child = run(process.execPath, argv, {
      cwd: root,
      env: { ...process.env, LA_ARTIFACTS_MANIFEST: mp },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.on?.("error", (err) =>
      reject(new Error(`artifact-registry spawn failed: ${err.message}`)),
    );
    child.stdout?.on?.("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr += chunk;
    });
    child.on?.("close", (code) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          new Error(
            `artifact-registry refresh --json printed no parseable result (exit ${code ?? "signal"})` +
              (stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ""),
          ),
        );
      }
    });
  });
}

// ── generators ───────────────────────────────────────────────────────────────

// Spawn the generator, cwd the repo root. Default is a direct spawn with a
// real argument array (shell:false — the arguments never pass through a
// shell), except on win32 for .cmd/.bat launchers (npm/npx/pnpm/yarn are
// installed as .cmd shims): since the CVE-2024-27980 mitigation Node refuses
// to spawn .cmd/.bat without a shell and such a spawnSync fails with EINVAL.
// Those launchers are routed through `cmd.exe /d /s /c` with conservative
// quoting instead. This is safe because the registry (config/artifacts.json)
// is COMMITTED CONFIGURATION, not user input — the shell is only ever fed
// strings a developer wrote, and only for these launchers; every other
// command (node, git, sh) keeps the direct, no-shell spawn on all platforms.
// Output is captured rather than inherited so a failure's stderr can travel
// in the report.
const CMD_LAUNCHERS = new Set(["npm", "npx", "pnpm", "yarn"]);

function isWindowsShellLauncher(file) {
  const name = String(file).split(/[\\/]/).pop().toLowerCase();
  // Any .cmd/.bat target needs the shell (it would EINVAL otherwise), and the
  // extension-less launcher names get PATHEXT-resolved to a .cmd by cmd.exe.
  return /\.(cmd|bat)$/.test(name) || CMD_LAUNCHERS.has(name);
}

// Resolve a launcher name to an ABSOLUTE .cmd/.bat path: root (the child's
// cwd) first, then each PATH entry. Verified on this machine: a .cmd spawned
// by bare name through cmd.exe runs with %~dp0 = the child's CWD, not its own
// directory — so npm.cmd's self-resolution (%~dp0\node_modules\npm\bin\...)
// looks for npm inside the repo's node_modules and dies with MODULE_NOT_FOUND.
// An absolute path pins %~dp0 to the launcher's real directory.
function resolveWindowsLauncher(file, root) {
  if (String(file).includes("/") || String(file).includes("\\")) {
    return resolve(file); // an explicit path — absolutize it for the same reason
  }
  const exts = /\.(cmd|bat)$/i.test(file) ? [""] : [".cmd", ".bat"];
  const path = (process.env.PATH || "").split(";").filter(Boolean);
  for (const dir of [root, ...path]) {
    const clean = dir.startsWith('"') && dir.endsWith('"') ? dir.slice(1, -1) : dir;
    for (const ext of exts) {
      const candidate = join(clean, file + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // keep searching
      }
    }
  }
  return file; // not found on disk — cmd.exe reports the honest failure
}

// Per-argument cmd.exe quoting: wrap in double quotes, escape inner " as \"
// (the C-runtime convention CommandLineToArgvW understands, so the child sees
// the original argument); the /s rule adds one more pair of quotes around the
// whole line, which cmd /s /c strips before executing.
const quoteForCmd = (a) => `"${String(a).replace(/"/g, '\\"')}"`;

function defaultRunGenerator(entry, root) {
  if (!entry.generator) {
    return { ok: false, error: `entry ${entry.id} has no generator to run` };
  }
  const [cmd, ...args] = entry.generator.cmd;
  let res;
  if (process.platform === "win32" && isWindowsShellLauncher(cmd)) {
    const launcher = resolveWindowsLauncher(cmd, root);
    const line = [launcher, ...args].map(quoteForCmd).join(" ");
    res = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      cwd: root,
      shell: false,
      windowsVerbatimArguments: true,
      encoding: "utf8",
    });
  } else {
    res = spawnSync(cmd, args, { cwd: root, shell: false, encoding: "utf8" });
  }
  if (res.error) return { ok: false, error: `spawn failed: ${res.error.message}` };
  if (res.status !== 0) {
    const tail = (res.stderr || "").trim().split("\n").slice(-3).join(" | ");
    return { ok: false, error: `exit ${res.status ?? "signal"}${tail ? `: ${tail}` : ""}` };
  }
  return { ok: true, stdout: res.stdout || "" };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { cmd: null, json: false, dryRun: false, only: null, inContainer: false, root: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--in-container") args.inContainer = true;
    else if (arg === "--only") {
      args.only = argv[++i];
      if (args.only === undefined) return null;
    } else if (arg === "--root") {
      args.root = argv[++i];
      if (args.root === undefined) return null;
    } else if (!args.cmd && (arg === "status" || arg === "refresh")) args.cmd = arg;
    else return null;
  }
  if (!args.cmd) return null;
  return args;
}

const short = (sha) => (sha ? String(sha).slice(0, 7) : "-");
const humanAge = (age) => {
  if (age === null || age === undefined) return "-";
  if (age < 90) return `${age}s`;
  if (age < 5400) return `${Math.round(age / 60)}m`;
  if (age < 129600) return `${Math.round(age / 3600)}h`;
  return `${Math.round(age / 86400)}d`;
};

function printTable(statuses) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    pad("id", 18) + pad("state", 10) + pad("age", 8) + pad("head", 9) + pad("digest", 9) + "reason",
  );
  for (const st of statuses) {
    console.log(
      pad(st.id, 18) +
        pad(st.state, 10) +
        pad(humanAge(st.age), 8) +
        pad(short(st.manifest?.head ?? st.head), 9) +
        pad(short(st.manifest?.digest ?? st.digest), 9) +
        (st.reason ?? ""),
    );
  }
}

function runCli(argv) {
  const args = parseArgs(argv);
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  const root = resolve(args.root || REPO_ROOT);
  try {
    if (args.cmd === "status") {
      const result = artifactStatuses({ root });
      if (args.json) console.log(JSON.stringify(result, null, 2));
      else printTable(result.artifacts);
      return 0;
    }
    const result = refreshArtifacts({
      root,
      only: args.only,
      dryRun: args.dryRun,
      inContainer: args.inContainer,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const r of result.refreshed) console.log(`refreshed ${r.id}`);
      for (const s of result.skipped) console.log(`skipped ${s.id} (${s.reason})`);
      for (const f of result.failed) console.error(`failed ${f.id}: ${f.error}`);
      console.log(
        `refresh: ${result.refreshed.length} refreshed, ${result.skipped.length} skipped, ` +
          `${result.failed.length} failed (manifest: ${result.manifestPath})`,
      );
    }
    return result.failed.length > 0 ? 1 : 0;
  } catch (err) {
    console.error(`artifact-registry failed: ${err && err.message ? err.message : err}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
