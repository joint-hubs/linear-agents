import { stampWorkerToolProfiles } from './worker-tool-profiles.mjs';
import { installRuntimeHooks } from './runtime-hook-config.mjs';
// scripts/agent-launch-profile.mjs — the launch-owned child config dir.
//
// One utility, one contract: every agent process (supervisor child turn, later
// native workers) is launched against a config directory THIS process owns —
// one per run/child/turn — assembled from bounded, known sources:
//
//   · the squad's CLAUDE.md, settings.json, agents/ and skills/ (the only
//     files copied out of the shared squad dir — never its projects/ history
//     and never any auth state);
//   · the vendored shared skills (<squadRoot>/_shared/skills — every child
//     gets them per turn; the squad's own file at the same relative path
//     wins, and a missing shared dir is silently fine);
//   · the tool-profile snapshot (snapshot.json + mcp.json, written by
//     tool-profiles.snapshotToolProfile — the registry revision and resolved
//     tools this process starts with);
//   · on a FOLLOW-UP turn only, the SAME child's previous launch projects/
//     history, so `--resume` finds its own transcripts and nothing else's.
//
// Secrets never travel: every copied source file is scanned for credential
// shapes and the launch is refused when one is found (fail closed — a copied
// key outlives the turn), and symlinks are never followed, so a link out of
// the squad dir cannot smuggle a path in. Provider keys are NOT part of this
// layer: they resolve fresh per launch through childProviderEnv and are passed
// in env only — they are never written into the launch dir.
//
// Public API (no import side effects, no CLI):
//   prepareAgentLaunch({squad, role, outputDir, previousConfigDir,
//     historyMode, previousSessionId, env, context})
//       -> { configDir, cliArgs, env, profile, changes, copied, history }
//   launchDirFor(runDirAbs, childId, turn) -> the per-turn launch dir path
//   freshLaunchDir(runDirAbs, childId, turn) -> that path, or `<path>-r<k>` when
//     something already sits there (FOC-989: never re-prepare a handed-over dir)
//   attemptIdFor(childId, turn) -> `${childId}:turn:${turn}`
//   actorIdFor(runId, childId) -> `${runId}:${childId}` (stable for the child's
//     whole life; the attempt id is what increments per turn)
//
// `context` is the runtime telemetry identity for runtime-otel's
// runtimeTelemetryEnv (loopback 4318 collector only). The caller passes it
// ONLY when the supervisor session id is present and a valid runtime token —
// legacy flows (no FENIX_SUPERVISOR_SESSION_ID) get no telemetry env at all
// and behave exactly as before. An invalid context here is a caller bug and
// throws.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";

import { squadConfigDir } from "./fenix-paths.mjs";
import { snapshotToolProfile } from "./tool-profiles.mjs";
import { runtimeTelemetryEnv } from "./runtime-otel.mjs";
import { isRuntimeToken } from "./runtime-events.mjs";

// ─── bounded copy constants ──────────────────────────────────────────────────

// The ONLY names copied out of the squad config dir. Everything else —
// projects/ history, .claude.json user state, .credentials.json auth — stays
// shared and is never duplicated into a per-turn directory.
const LAUNCH_COPY_FILES = ["CLAUDE.md", "settings.json"];
const LAUNCH_COPY_DIRS = ["agents", "skills"];

const COPY_MAX_FILE_BYTES = 1_000_000;
const COPY_MAX_TOTAL_BYTES = 8_000_000;
const COPY_MAX_FILES = 800;

// Same credential shapes tool-profiles refuses in the registry — the copied
// squad files are shared, reviewed artifacts, and a key pasted into one must
// not quietly multiply into every launch dir.
const SECRET_RE = /sk-or-|sk-ant-|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|lin_api_/;

// ─── small helpers ───────────────────────────────────────────────────────────

export const attemptIdFor = (childId, turn) => `${childId}:turn:${turn}`;
export const actorIdFor = (runId, childId) => `${runId}:${childId}`;
export const launchDirFor = (runDirAbs, childId, turn) =>
  join(runDirAbs, "launch", childId, `turn-${turn}`);

const FRESH_LAUNCH_DIR_MAX_RETRIES = 1000;

// Anything at the path counts — a dir, a file, a dangling link. A stat error
// other than "not there" reads as taken: the safe answer is another name.
function pathTaken(path) {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    return err?.code !== "ENOENT";
  }
}

/**
 * FOC-989: the launch dir for a turn, guaranteed not to exist yet.
 *
 * A launch dir is handed over to the child uid when its watcher starts
 * (docker/fenix-spawn-as-child.sh); after that the Supervisor (uid node) can no
 * longer fchmod the files in it, and libuv's copyfile onto an existing
 * destination does exactly that — EPERM. The registry's turn count and the dirs
 * on disk can diverge (a launch that died after the handover, a child entry
 * that was replaced), so the registry index alone is not a safe name. The
 * canonical `turn-<n>` is used when free, otherwise the first free
 * `turn-<n>-r<k>`. The occupied dir is left exactly as it is — it is the audit
 * trail of the failed attempt.
 */
export function freshLaunchDir(runDirAbs, childId, turn) {
  const canonical = launchDirFor(runDirAbs, childId, turn);
  if (!pathTaken(canonical)) return canonical;
  for (let k = 1; k <= FRESH_LAUNCH_DIR_MAX_RETRIES; k++) {
    const candidate = `${canonical}-r${k}`;
    if (!pathTaken(candidate)) return candidate;
  }
  throw new Error(`no free launch dir for ${childId} turn ${turn} after ${FRESH_LAUNCH_DIR_MAX_RETRIES} attempts under ${dirname(canonical)}`);
}

/** The fields a snapshot.json carries that a profile diff is computed over. */
function snapshotProjection(snap) {
  return {
    revision: snap?.revision ?? null,
    mcpServers: snap?.mcpServers ?? {},
    workerProfiles: snap?.workerProfiles ?? [],
    tools: snap?.tools ?? null,
    unavailable: snap?.unavailable ?? null,
    nativeTools: snap?.nativeTools ?? null,
  };
}

function diffProjection(before, after, prefix, out) {
  for (const key of Object.keys(after)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!isDeepStrictEqual(before?.[key], after[key])) {
      out.push({
        path,
        before: before?.[key] === undefined ? null : before[key],
        after: after[key] === undefined ? null : after[key],
      });
    }
  }
  return out;
}

// ─── bounded, secret-free, symlink-safe copy ─────────────────────────────────

/**
 * Copy one regular file. The scan reads BEFORE writing, so the offending file
 * itself never lands in the launch dir (earlier files may already have been
 * copied when the refusal fires — the launch is refused as a whole, and an
 * unused launch dir is inert). Symlinks never reach this function.
 */
function copyFileScanned(src, dest, state) {
  const stat = lstatSync(src);
  if (stat.size > COPY_MAX_FILE_BYTES) {
    state.skipped.push({ path: src, why: "file-exceeds-size-cap" });
    return;
  }
  let text;
  try {
    text = readFileSync(src, "utf8");
  } catch (err) {
    state.skipped.push({ path: src, why: `unreadable: ${err.message.split("\n")[0]}` });
    return;
  }
  if (SECRET_RE.test(text)) {
    // Fail closed and name the file: a copied credential outlives the turn.
    throw new Error(`agent-launch-profile: refusing to copy ${src} — it matches a credential shape; secrets never travel into a launch dir`);
  }
  state.totalBytes += stat.size;
  state.files += 1;
  if (state.totalBytes > COPY_MAX_TOTAL_BYTES || state.files > COPY_MAX_FILES) {
    throw new Error(
      `agent-launch-profile: launch copy exceeded its bounds ` +
        `(${state.files} files, ${state.totalBytes} bytes) — refusing rather than truncating`,
    );
  }
  copyFileSync(src, dest);
  state.copied.push(src);
}

/**
 * Walk one allowlisted source entry (file or directory) into the launch dir.
 * Symlinks are skipped and recorded — never followed — so a link out of the
 * squad dir cannot smuggle a path into the copy.
 */
function copyEntry(srcEntry, destEntry, state) {
  const stat = lstatSync(srcEntry);
  if (stat.isSymbolicLink()) {
    state.skipped.push({ path: srcEntry, why: "symlink-not-followed" });
    return;
  }
  if (stat.isFile()) {
    copyFileScanned(srcEntry, destEntry, state);
    return;
  }
  if (!stat.isDirectory()) {
    state.skipped.push({ path: srcEntry, why: "not-a-regular-file" });
    return;
  }
  mkdirSync(destEntry, { recursive: true });
  for (const name of readdirSync(srcEntry).sort()) {
    copyEntry(join(srcEntry, name), join(destEntry, name), state);
  }
}

/**
 * The vendored skills every squad shares live in `<squadRoot>/_shared/skills/`
 * — next to the squad dirs, so it exists in the same root natively and under
 * LA_SQUAD_HOME in Docker. A missing shared dir is silently fine (a squad that
 * ships none of them launches unchanged).
 */
export function sharedSkillsDir(squad, env = process.env) {
  return join(dirname(squadConfigDir(squad, env)), "_shared", "skills");
}

/**
 * The bounded squad-source copy: allowlisted names only, out of `sourceDir`
 * into `destDir`. `sharedSkills` (when it exists) is copied into
 * `<destDir>/skills/` FIRST, so the squad's own dir copied after it overwrites
 * a shared file at the same relative path — a squad always wins on a clash.
 * Shared files count toward the same caps and secret scan as squad files.
 * Returns the mutable state the caller reports on.
 */
function copySquadSources(sourceDir, destDir, sharedSkills) {
  const state = { copied: [], skipped: [], files: 0, totalBytes: 0 };
  if (sharedSkills && existsSync(sharedSkills)) {
    copyEntry(sharedSkills, join(destDir, "skills"), state);
  }
  for (const name of LAUNCH_COPY_FILES) {
    const src = join(sourceDir, name);
    if (!existsSync(src)) continue;
    copyEntry(src, join(destDir, name), state);
  }
  for (const name of LAUNCH_COPY_DIRS) {
    const src = join(sourceDir, name);
    if (!existsSync(src)) continue;
    copyEntry(src, join(destDir, name), state);
  }
  return state;
}

/**
 * The resume-history copy — the ONLY path a previous launch's history travels.
 *
 *   historyMode "tree"    → the previous LAUNCH-OWNED dir's whole projects/
 *                           subtree (one child per launch dir, so the tree is
 *                           that child's own history by construction).
 *   historyMode "session" → a LEGACY child whose transcripts live in the
 *                           SHARED squad dir: only the files named after THIS
 *                           child's session id are copied, never the shared
 *                           dir's other children, never auth state.
 *
 * Transcripts are deliberately NOT secret-scanned: they are the child's own
 * prior turn logs (the tee on disk stays unredacted for the same reason), and
 * a redacting copy would break --resume on a transcript that quotes a key.
 */
function copyLaunchHistory({ from, to, mode, sessionId }) {
  const state = { copied: [], skipped: [] };
  if (mode !== "tree" && mode !== "session") return state;
  const projectsDir = join(from, "projects");
  if (!existsSync(projectsDir)) return state;

  const wanted = mode === "session" ? `${sessionId}.jsonl` : null;
  const walk = (src, dest, depth) => {
    if (depth > 6) {
      state.skipped.push({ path: src, why: "history-depth-cap" });
      return;
    }
    const stat = lstatSync(src);
    if (stat.isSymbolicLink()) {
      state.skipped.push({ path: src, why: "symlink-not-followed" });
      return;
    }
    if (stat.isFile()) {
      if (wanted !== null && src.split(/[\\/]/).pop() !== wanted) return;
      // Dirs are created lazily, on the first copied file — a session-mode
      // walk leaves no empty skeleton of other children's project dirs behind.
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      state.copied.push(src);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of readdirSync(src).sort()) walk(join(src, name), join(dest, name), depth + 1);
  };
  walk(projectsDir, join(to, "projects"), 0);
  return state;
}

// ─── the utility ─────────────────────────────────────────────────────────────

/**
 * Assemble one agent process's launch: config dir, CLI args, env, profile
 * snapshot and the change record against the prior safe snapshot.
 *
 * @param {object} params
 * @param {string} params.squad - squad name ("plan" | "dev" | "review" | "test")
 * @param {string} [params.role] - "lead" (default) or a worker role name
 * @param {string} params.outputDir - the launch-owned dir for THIS run/child/turn
 * @param {string|null} [params.previousConfigDir] - the SAME child's previous
 *   launch dir (follow-up turns only; spawn passes null)
 * @param {string|null} [params.historyMode] - null (no history), "tree"
 *   (previous launch-owned projects/) or "session" (legacy shared dir: only
 *   `previousSessionId`'s transcript)
 * @param {string|null} [params.previousSessionId] - required for "session"
 * @param {object} [params.env] - the env the launch resolves paths against
 * @param {object|null} [params.context] - runtime telemetry identity; every
 *   field must be a valid runtime token. The caller passes it ONLY when the
 *   supervisor session id is present and valid — legacy flows pass null.
 * @returns {{ configDir: string, cliArgs: string[], env: object, profile: object,
 *   changes: array, profileInitial: boolean, copied: string[], skipped: object[],
 *   history: { copied: string[], skipped: object[] } }}
 */
export function prepareAgentLaunch({
  squad,
  role = "lead",
  outputDir,
  previousConfigDir = null,
  historyMode = null,
  previousSessionId = null,
  env = process.env,
  context = null,
} = {}) {
  if (typeof squad !== "string" || !squad.trim()) {
    throw new TypeError("prepareAgentLaunch: squad is required");
  }
  if (typeof outputDir !== "string" || !outputDir.trim()) {
    throw new TypeError("prepareAgentLaunch: outputDir is required");
  }
  if (historyMode === "session" && !previousSessionId) {
    throw new TypeError('prepareAgentLaunch: historyMode "session" requires previousSessionId');
  }

  // The telemetry context is all-or-nothing and validated HERE, fail closed:
  // a half-valid identity must never reach the collector as a guess.
  let telemetryEnv = null;
  if (context !== null) {
    telemetryEnv = runtimeTelemetryEnv(context, { collectorUrl: "http://127.0.0.1:4318/v1/traces" });
  }

  const configDir = resolve(outputDir);
  mkdirSync(configDir, { recursive: true });

  // 1. The bounded squad sources (never the shared projects/ or auth), with
  // the vendored shared skills laid down first so a squad's own copy wins.
  const copied = copySquadSources(squadConfigDir(squad, env), configDir, sharedSkillsDir(squad, env));

  // 2. Resume history — the same child's own prior turn only (follow-ups).
  let history = { copied: [], skipped: [] };
  if (previousConfigDir) {
    history = copyLaunchHistory({
      from: previousConfigDir,
      to: configDir,
      mode: historyMode,
      sessionId: previousSessionId,
    });
  }

  // 3. The tool-profile snapshot: registry revision + resolved tools, the
  // thoughtmap mcp.json, and the lead's --tools / --disallowedTools args.
  // --mcp-config ADDS the profile's servers; without --strict-mcp-config the
  // project's own servers stay in place.
  const snapshot = snapshotToolProfile({ squad, role, outputDir: configDir, env });
  const workerProfiles = stampWorkerToolProfiles(configDir, { squad, env });
  snapshot.profile.workerProfiles = workerProfiles;
  const snapshotPath = join(configDir, "snapshot.json");
  writeFileSync(snapshotPath, JSON.stringify({ ...JSON.parse(readFileSync(snapshotPath,"utf8")), workerProfiles },null,2));
  if (context) installRuntimeHooks(configDir);
  const profile = snapshot.profile;
  const cliArgs = [...snapshot.cliArgs, "--mcp-config", snapshot.mcpConfigPath];

  // 4. The change record against the PRIOR safe snapshot (the previous
  // launch's snapshot.json — a file the schema keeps secret-free). No prior
  // (a fresh child) is an initial profile, not a change.
  let changes = [];
  let profileInitial = true;
  if (previousConfigDir) {
    const priorPath = join(previousConfigDir, "snapshot.json");
    let prior = null;
    if (existsSync(priorPath)) {
      try {
        prior = JSON.parse(readFileSync(priorPath, "utf8"));
      } catch {
        prior = null; // an unreadable prior reads as "no baseline", not as "unchanged"
      }
    }
    if (prior) {
      profileInitial = false;
      changes = diffProjection(snapshotProjection(prior), snapshotProjection(profile), "profile", []);
    }
  }

  // 5. The launch env: the MCP server env block (URLs/paths, never secrets)
  // plus the OTel resource identity when a valid context was given. The same
  // context ALSO rides as plain env — the child's own scoped current-run
  // resolution (supervisor-current-run.mjs) reads FENIX_SUPERVISOR_SESSION_ID
  // and LA_TASK_KEY from the environment, not from OTEL_RESOURCE_ATTRIBUTES,
  // so a half-identity there would fail closed and strand the child in legacy
  // mode. All five values were already validated as runtime tokens above.
  const envOut = {
    ...(snapshot.env ?? {}),
    ...(telemetryEnv ?? {}),
    ...(telemetryEnv
      ? {
          FENIX_SUPERVISOR_SESSION_ID: context.supervisorSessionId,
          LA_TASK_KEY: context.taskKey,
          FENIX_ACTOR_ID: context.actorId,
          FENIX_ATTEMPT_ID: context.attemptId,
          FENIX_ACTOR_ROLE: context.role,
        }
      : {}),
  };

  return {
    configDir,
    cliArgs,
    env: envOut,
    profile,
    changes,
    profileInitial,
    copied: copied.copied,
    skipped: copied.skipped,
    history,
  };
}
