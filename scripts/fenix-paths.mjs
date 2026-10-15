// scripts/fenix-paths.mjs — every on-disk location Fenix uses, in one place (FOC-770).
//
// Each function reads its env override first, then a per-OS default. On
// Windows the defaults are byte-identical to the paths the scripts built for
// themselves before this module existed, so an existing install keeps its
// store, rewards and worktrees. In the Fenix container the env points all of
// it at the /data volume.
//
// Functions take (env, platform) so tests can pin both; callers use defaults.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Root of the mutable run-state tree — run manifests and the per-run decision
// logs / shadow stores under runs/<runId>/. LA_STATE_ROOT wins when set (the
// container points it at the /data volume, FOC-811 — LA_ROOT is the image
// layer and would lose every run on `fenix update`); unset, this is the
// repo-local `.state` the scripts built for themselves, byte-identical.
// Resolved at call time so tests can set the env after import.
export function stateRoot(env = process.env) {
  if (env.LA_STATE_ROOT) return resolve(env.LA_STATE_ROOT);
  return join(REPO_ROOT, ".state");
}

// The runs directory: <stateRoot>/runs — <runId>.json manifests plus one
// directory per run (decisions.jsonl, graph-steps.jsonl, labels).
export function runsDir(env = process.env) {
  return join(stateRoot(env), "runs");
}

export function dataHome(env = process.env, platform = process.platform) {
  if (env.LA_DATA_HOME) return env.LA_DATA_HOME;
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "linear-agents");
  }
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "linear-agents");
}

export function telemetryHome(env = process.env, platform = process.platform) {
  return env.LA_TELEMETRY_HOME || join(dataHome(env, platform), "telemetry");
}

export function telemetryDbPath(env = process.env, platform = process.platform) {
  return env.LA_TELEMETRY_DB || join(telemetryHome(env, platform), "telemetry.sqlite");
}

// The install's live store with LA_TELEMETRY_DB / LA_TELEMETRY_HOME IGNORED on
// purpose: those can point a dev copy anywhere — including back AT the live
// store — so a guard that must recognise the live store decides by where the
// data home leads, never by which overrides happen to be set.
export function liveTelemetryDbPath(env = process.env, platform = process.platform) {
  return join(dataHome(env, platform), "telemetry", "telemetry.sqlite");
}

export function rewardsHome(env = process.env, platform = process.platform) {
  return env.LA_REWARDS_HOME || join(dataHome(env, platform), "rewards");
}

// The managed Supervisor session id shape (PRD task-workspace-supervisors §5):
// opaque, random hex — the ONLY session identifier safe to compose a path
// from. taskKey/taskId are opaque user data and must never reach a path.
// Mirrors task-sessions.mjs SESSION_ID_PATTERN (kept here because
// task-sessions.mjs imports this module — do not create a cycle).
export const SUPERVISOR_SESSION_ID_PATTERN = /^sup-[a-f0-9]{16,32}$/;

// Home for one Supervisor session's state. Without FENIX_SUPERVISOR_SESSION_ID
// this is the legacy <dataHome>/supervisor directory (single-session compat:
// session.json and current-run.json stay exactly where they always were). A
// validated session id scopes it to <dataHome>/supervisor/sessions/<id>.
// Anything set but NOT matching the pattern throws — never compose a path
// from it.
export function supervisorSessionHome(env = process.env, platform = process.platform) {
  const sessionId = env.FENIX_SUPERVISOR_SESSION_ID;
  if (!sessionId) return join(dataHome(env, platform), "supervisor");
  if (!SUPERVISOR_SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError(
      `FENIX_SUPERVISOR_SESSION_ID must match ${SUPERVISOR_SESSION_ID_PATTERN} — refusing to compose a path from '${sessionId}'`,
    );
  }
  return join(dataHome(env, platform), "supervisor", "sessions", sessionId);
}

// The Supervisor session file — what the frontman's Claude Code session is
// doing right now (state + last notification), written by the session hook
// (FOC-783) so the dashboard can show it. Scoped to the session home.
export function supervisorSessionPath(env = process.env, platform = process.platform) {
  return join(supervisorSessionHome(env, platform), "session.json");
}

// The Supervisor's current-run pointer (FOC-807) — the run id the live
// supervisor session belongs to, written by supervisor-current-run.mjs next to
// session.json so both containers read the same truth from the shared volume.
// Scoped to the session home; the legacy (unscoped) pointer is untouched.
export function supervisorCurrentRunPath(env = process.env, platform = process.platform) {
  return join(supervisorSessionHome(env, platform), "current-run.json");
}

// A managed session's isolated Claude config dir (<sessionHome>/claude) — the
// entrypoint seeds prompt/settings/agents/skills into it and points
// CLAUDE_CONFIG_DIR there, so `claude --continue` can never cross-resume
// another task's native conversation history from the shared squad config.
export function supervisorSessionClaudeDir(env = process.env, platform = process.platform) {
  return join(supervisorSessionHome(env, platform), "claude");
}

// The host's bearer token — written by `supervisor-host.mjs serve` at start
// (FOC-783) and re-read per request by the API container: a supervisor
// restart rotates it, so nothing may cache it.
export function hostTokenPath(env = process.env, platform = process.platform) {
  return join(dataHome(env, platform), "run", "host.token");
}

// Root of the per-squad config dirs (LA_SQUAD_HOME, default <repo>/agents).
export function squadConfigRoot(env = process.env) {
  return env.LA_SQUAD_HOME || join(REPO_ROOT, "agents");
}

export function squadConfigDir(squad, env = process.env) {
  return join(squadConfigRoot(env), squad);
}

// The Linear project → repo map. A user-owned file (LA_PROJECTS_FILE — in the
// container /fenix-config/projects.json) wins when it exists; otherwise the
// repo's config/projects.json.
export function projectsConfigPath(env = process.env, exists = existsSync) {
  if (env.LA_PROJECTS_FILE && exists(env.LA_PROJECTS_FILE)) return env.LA_PROJECTS_FILE;
  return join(REPO_ROOT, "config", "projects.json");
}

// The Settings overlay that survives `fenix update` (FOC-773/786). Precedence:
// LA_SETTINGS_FILE (the container points it at the /data volume), then
// settings.json next to wherever LA_PROJECTS_FILE puts projects.json (the
// user-owned config dir), then the repo-local .fenix/config — the repo layer
// is the image, so anything there is replaceable; the overlay must not be.
export function settingsPath(env = process.env) {
  if (env.LA_SETTINGS_FILE) return env.LA_SETTINGS_FILE;
  if (env.LA_PROJECTS_FILE) return join(dirname(env.LA_PROJECTS_FILE), "settings.json");
  return join(REPO_ROOT, ".fenix", "config", "settings.json");
}

// Child worktrees: siblings of the repo by default (../la-wt/<repo>/<branch>).
export function worktreeRoot(gitRoot, env = process.env) {
  return env.LA_WORKTREE_HOME
    ? join(env.LA_WORKTREE_HOME, basename(gitRoot))
    : join(gitRoot, "..", "la-wt", basename(gitRoot));
}

// The merge integration tree keeps its historical layout (../la-wt/<name>).
export function integrationTreePath(mainRepo, name, env = process.env) {
  return env.LA_WORKTREE_HOME
    ? join(env.LA_WORKTREE_HOME, name)
    : join(mainRepo, "..", "la-wt", name);
}
