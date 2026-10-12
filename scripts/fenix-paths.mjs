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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
