#!/usr/bin/env node
import { resolveToolProfile } from './tool-profiles.mjs';
import { createRuntimeCollector } from './runtime-otel.mjs';
// scripts/task-session-host.mjs — the task-session multiplexer (PRD
// task-workspace-supervisors §5, plan task-workspace-delivery P1B).
//
// ONE authenticated HTTP server on the internal port 7332 multiplexes MANY
// unbound supervisor-host controllers in the SAME process — one per managed
// task session. No extra public ports: HTTP requests are dispatched into a
// controller's unbound server via its own 'request' listeners, WebSocket
// upgrades into its 'upgrade' listener. Each controller runs with an env copy
// carrying FENIX_SUPERVISOR_SESSION_ID / LA_TASK_KEY / LA_TASK_ID, so its tmux
// identity (socket, session, chat buffer), its state files
// (<dataHome>/supervisor/sessions/<id>/) and its isolated Claude config dir
// are that session's and nobody else's.
//
// SECURITY MODEL — identical to supervisor-host.mjs and enforced BEFORE any
// lookup or store operation (AC-4: routing never trusts the UI):
//   · peer: only addresses FENIX_HOST_PEER (fenix-api) resolves to may call
//     in; · token: x-fenix-host-token must equal the global host.token,
//     re-read per request. Both gates fail closed. GET /healthz stays
//     loopback-only, tokenless.
//   · session ids are validated against the strict opaque pattern before any
//     path or tmux name is composed from them; unknown ids 404; malformed
//     ids 400. Raw internal errors never leak (generic 500 body).
//
// GLOBAL vs SESSION routes: the legacy global routes (/state, /session,
// /message, /dialog*, /terminal) keep working ONLY while the store holds no
// managed sessions at all (a fresh install behaves byte-identically to the
// single-session host). The moment managed sessions exist the global routes
// fail closed with 409 selection-required — the host never guesses which task
// a request means. /alive stays a global process probe; /healthz a global
// health check.
//
// SCHEDULING — the durable coordinator is task-sessions.mjs (SQLite, one
// active owner per task, atomic cap). The initial prompt is durable under the
// session home (pending-prompt.json): armed before the session may start,
// delivering once the paste begins, delivered on proof. A crash between
// states leaves delivery UNPROVEN — the host then never resends (it cannot
// know the paste did not land) and surfaces the reason instead; an operator
// re-attaches and delivers manually.
//
// CLI:
//   node scripts/task-session-host.mjs serve
//   node scripts/task-session-host.mjs session-home --session <id>
//   node scripts/task-session-host.mjs config-dir   --session <id>
//   node scripts/task-session-host.mjs attach-target
//
// ESM, zero runtime deps beyond node + ws (via supervisor-host).

import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BODY_CAP_BYTES,
  MAX_MESSAGE_BYTES,
  createGatekeeper,
  createHost,
  readBody,
  sendJSON,
  parseJSON,
  tmuxIdentity,
  writeHostToken,
} from "./supervisor-host.mjs";
import { SUPERVISOR_SESSION_ID_PATTERN, dataHome, projectsConfigPath } from "./fenix-paths.mjs";
import { migrateLegacy as realMigrateLegacy } from "./supervisor-migrate-legacy.mjs";
import {
  DEFAULT_MAX_ACTIVE,
  OWNER_STATUSES,
  TERMINAL_STATUSES,
  createTaskSessionStore,
  issuePartOf,
  resolveTaskKey,
  workspaceNameFor,
} from "./task-sessions.mjs";
import { readProcessIdentity, matchesProcess } from "./task-process-identity.mjs";
import { readCurrentRun } from "./supervisor-current-run.mjs";
import { readTaskSessionsSettings, normalizeAutoPickup } from "./fenix-settings.mjs";
import { startText } from "./work-board.mjs";
import { SESSION_ANSWER_ROUTES } from "./task-session-routes.mjs";
import { buildBranchName } from "./dev-branch.mjs";
import { releaseClaim as realReleaseClaim } from "./workspace-claims.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const platform = process.platform;

// supervisor-lib loads lazily (its static load costs ~160 ms and only the
// stop path and the FOC-1088 worktree lane need it), shared by every caller
// in this module — one module-level promise memo.
let libRef = null;
const loadLib = async () => {
  if (!libRef) libRef = await import("./supervisor-lib.mjs");
  return libRef;
};

// The Linear issue-facts resolver loads lazily too (it pulls its own module
// graph; only the FOC-1088 lane resolving a repository through Linear needs
// it) — the same one-promise-memo pattern as loadLib.
let issueFactsRef = null;
const loadIssueFacts = async () => {
  if (!issueFactsRef) issueFactsRef = await import("./agent-state-resolve.mjs");
  return issueFactsRef.fetchIssueFacts;
};

// FOC-1147: operator-visible error text is redacted through supervisor-lib's
// redact() — repository-resolution failures echo the candidate values they
// tried (a URL whose authority carries credentials, an api_key=… echo), and
// lastError is served verbatim to the Cockpit and the /pickup route.
// Redacting AT THE WRITE means every reader sees the redacted text. Lazy like
// loadLib (the module load costs ~160 ms, the redaction is on the error path
// only); on any failure it returns the text unredacted — never worse than
// before, and never a thrown error inside a catch block.
let redactRef = null;
const redactOperatorText = async (text) => {
  try {
    if (!redactRef) redactRef = (await loadLib()).redact;
    return redactRef(text);
  } catch {
    return String(text ?? "");
  }
};

// FOC-902 §D: when the task-ownership helper exists (branch
// fenix-task-ownership), its checkOwnership decides the pickup owner scope;
// until it lands, the projects.json rule in createTaskSessionHost applies.
// One try import, resolved once at module load — a missing module is the
// normal case here, never an error.
let taskOwnership = null;
try {
  taskOwnership = await import("./task-ownership.mjs");
} catch {
  taskOwnership = null;
}

// The first pickup tick fires 10 s after start — the host has reconciled by
// then and the store reflects the restart — then every pollSeconds.
const PICKUP_FIRST_TICK_MS = 10_000;

// The session id is the ONLY identifier composed into paths or tmux names;
// everything else (taskKey/taskId) is opaque user data.
const validSessionId = (value) => typeof value === "string" && SUPERVISOR_SESSION_ID_PATTERN.test(value);

/** <dataHome>/supervisor/sessions/<id> for a VALIDATED id (throws otherwise). */
export function sessionHomePath(env, sessionId) {
  if (!validSessionId(sessionId)) {
    throw new TypeError(
      `sessionId must match ${SUPERVISOR_SESSION_ID_PATTERN} — refusing to compose a path from '${sessionId}'`,
    );
  }
  return join(dataHome(env, platform), "supervisor", "sessions", sessionId);
}

// ── FOC-1088: per-task workspaces ────────────────────────────────────────────

// The issue identifier a task-session branch is derived from must already be
// in the TEAM-NUM shape before buildBranchName sees it: dev-branch's parser
// process.exit()s on a malformed identifier, and a host must fail ONE session,
// never kill itself.
const TASK_IDENTIFIER_RE = /^[A-Za-z]+-\d+$/;

// The ticket prefix of a TEAM-NUM identifier — FOC in FOC-1080 — matched
// against the STRUCTURED projects.json `ticketPrefix` field only. A guess
// from free text (the note-text fallback repoPrefixMap accepts) must never
// pick a repository here.
const TICKET_PREFIX_RE = /^([A-Za-z]+)-\d+$/;

/**
 * The per-task branch a managed session works on, derived DETERMINISTICALLY
 * from the task — buildBranchName's shape (`<team>-<n>-<slug>`) with the fixed
 * slug "task" (FOC-1088 → foc-1088-task). The session id NEVER appears in the
 * name: a stopped session's next generation (resume) carries a new session id
 * but the SAME task, so it must resolve to the SAME branch — and therefore the
 * same worktree — to continue its predecessor's state.
 */
export function sessionBranchFor(record) {
  const issueId = String(record?.issueId ?? "");
  if (!TASK_IDENTIFIER_RE.test(issueId)) {
    throw new Error(
      `issueId '${issueId}' is not a TEAM-NUM identifier — refusing to derive a task-session branch from it`,
    );
  }
  return buildBranchName(issueId, "task");
}

/**
 * Every projects.json entry, or null when the map is missing or unreadable —
 * a deployment without a project map, for which map-based resolution rules
 * are simply not applicable.
 */
function projectEntries(env) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(projectsConfigPath(env), "utf8"));
  } catch {
    return null;
  }
  return Array.isArray(parsed?.projects) ? parsed.projects : [];
}

/**
 * The Linear project the auto-pickup owner scope resolves to for `workspace`
 * (FOC-1147): the projects.json entries whose OWN `workspace` field names it,
 * yielding exactly one distinct `linearProject`. The map is local and
 * synchronous — no Linear call in the pickup tick; each entry's workspace
 * field is the Linear workspace whose tickets the mapped repository serves.
 *
 * Matching the task-key workspace against a repo NAME (repoRefName of
 * entry.repo) was the FOC-1088 round-2 bug in a second seat: the workspace
 * half of a task key is the Linear workspace name ("jointhubs"),
 * repoRefName yields the repo directory basename — the two can never be
 * equal, so the scope always came up empty. That comparison mode is gone
 * here; the FOC-1088 session-repo lane keeps its own issue-driven resolution
 * (resolveGitRootFor) and is untouched by this rule.
 *
 * Fail closed WITH the operator remedy on every gap — a missing/unreadable
 * map, no entry for the workspace, no linearProject on the matches, more
 * than one distinct project (ambiguous). The throw lands in
 * pickup.lastError through the tick's catch.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} workspace the task-key workspace (the pickup's scope)
 * @returns {string} the one distinct Linear project
 * @throws {Error} when the scope cannot be proven
 */
export function ownerProjectForWorkspace(env, workspace) {
  const entries = projectEntries(env);
  if (entries === null) {
    throw new Error(
      `no owner scope for workspace '${workspace}': the projects map (${projectsConfigPath(env)}) is missing or unreadable — ` +
        `point LA_PROJECTS_FILE at a readable map, or turn the pickup off (fenix settings set taskSessions.autoPickup.enabled false + fenix restart supervisor)`,
    );
  }
  const matched = entries.filter((entry) => typeof entry?.workspace === "string" && entry.workspace.trim() === workspace);
  if (matched.length === 0) {
    throw new Error(
      `no owner scope for workspace '${workspace}': no projects.json entry carries workspace '${workspace}' — ` +
        `map it: node scripts/fenix-projects.mjs add --linear-project <name> --repo <repo template> --workspace ${workspace}, ` +
        `or set taskSessions.autoPickup.workspace to a workspace the map defines`,
    );
  }
  const projects = new Set();
  for (const entry of matched) {
    if (typeof entry?.linearProject === "string" && entry.linearProject.trim()) projects.add(entry.linearProject.trim());
  }
  if (projects.size === 0) {
    throw new Error(
      `no owner scope for workspace '${workspace}': ${matched.length} projects.json entr${matched.length === 1 ? "y carries" : "ies carry"} ` +
        `workspace '${workspace}' but none of them names a linearProject — set the entry's linearProject field to the ` +
        `Linear project whose tickets this host picks`,
    );
  }
  if (projects.size > 1) {
    throw new Error(
      `no owner scope for workspace '${workspace}': the projects map maps workspace '${workspace}' to ` +
        `${projects.size} distinct Linear projects (${[...projects].join(", ")}) — ambiguous; ` +
        `keep exactly one distinct linearProject for the workspace`,
    );
  }
  return [...projects][0];
}

/**
 * The path a projects-file `repo` ref points at. The `${GITHUB_ROOT}/<name>`
 * template the entrypoint's repo-add writes is a REFERENCE, not a path — it
 * expands against env GITHUB_ROOT (the clones root the template names;
 * /data/workspaces in the container). Any other value — a full path, a bare
 * name — passes through unchanged and must resolve (or fail) as a git repo on
 * its own.
 *
 * FOC-1147: an unexpandable template (no env GITHUB_ROOT) is a configuration
 * error the operator must see, not a silent null that reads as "no match" —
 * throw naming what to set. A `..` segment is refused the same way: the
 * expansion must stay inside the clones root, never escape it. (The caller,
 * the lane's oneRepoFor, has no try around this — the throw fails the
 * session closed through the usual start catch, remedy appended there.)
 *
 * @param {unknown} repo
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} the expanded path, or the pass-through value
 * @throws {Error} when a `${GITHUB_ROOT}/...` template cannot expand or tries
 *   to escape the clones root
 */
export function repoRefPath(repo, env) {
  if (typeof repo !== "string" || !repo.trim()) return null;
  const ref = repo.trim();
  const template = /^\$\{GITHUB_ROOT\}\/(.+)$/.exec(ref);
  if (!template) return ref;
  const root = typeof env.GITHUB_ROOT === "string" ? env.GITHUB_ROOT.trim() : "";
  if (!root) {
    throw new Error(
      `repo ref '${ref}' cannot expand: env GITHUB_ROOT is unset — set it to the clones root ` +
        `(/data/workspaces in the container, the directory the entrypoint's repo-add clones into)`,
    );
  }
  if (template[1].split(/[\\/]/).includes("..")) {
    throw new Error(
      `repo ref '${ref}' tries to escape the clones root with a '..' segment — refusing to expand it outside GITHUB_ROOT; ` +
        `map the repository where it really lives`,
    );
  }
  return join(root, template[1]);
}

/**
 * The real FOC-1088 workspace lane: resolve the task's repository, ensure a
 * per-task worktree on a task-derived branch, claim it in the workspace-claims
 * registry, and hand the worktree path back for the controller env.
 *
 * `loadLib` is the host's lazy supervisor-lib loader — the lane only runs when
 * it is enabled, so the git helpers load on first use, not at module import.
 * `fetchIssueFacts` is the Linear facts seam (tests inject a stub; the default
 * lazy-loads the real resolver, same pattern as loadLib).
 *
 * @param {{ repo?: string|null, env: object, loadLib: () => Promise<object>, fetchIssueFacts?: ((identifier: string, opts?: { env?: object }) => Promise<object|null>)|null }} args
 */
function createRealSessionWorkspace({ repo = null, env, loadLib, fetchIssueFacts = null }) {
  // Linear facts: the injected seam, or the lazily imported real resolver.
  const factsFor = fetchIssueFacts ?? (async (identifier, opts) => (await loadIssueFacts())(identifier, opts));
  // Resolved repositories, memoized PER CANDIDATE LIST — never one gitRoot
  // for the whole host: two sessions mapped to different repositories must
  // not share a resolution. Only successes are memoized; a failure re-resolves
  // on the next attempt, so an operator fix takes effect without a restart.
  const resolvedRepos = new Map();
  const resolveFrom = async (candidates) => {
    const key = candidates.map((c) => `${c.from}\u0000${c.value}`).join("\n");
    const known = resolvedRepos.get(key);
    if (known) return known;
    const lib = await loadLib();
    // resolveRepoFromCandidates' semantics (shared with the DEV-child spawn):
    // an explicit candidate fails loudly when it is not a git repo; the first
    // resolvable candidate wins; all-fail fails with the tried list.
    // process.cwd() is deliberately NOT a candidate: the host runs from the
    // fenix stack checkout, never the task's repository — a cwd fallback
    // would silently pick the wrong repository (the FOC-172 bug class).
    const resolved = lib.resolveRepoFromCandidates(candidates);
    resolvedRepos.set(key, resolved.gitRoot);
    return resolved.gitRoot;
  };

  // The workspace half of the task key (`<workspace>:<issueId>` — the shape
  // resolveTaskKey builds and the store enforces). The record's workspace
  // field is authoritative; the taskKey prefix is the fallback.
  const workspaceOf = (record) => {
    if (typeof record?.workspace === "string" && record.workspace.trim()) return record.workspace.trim();
    const taskKey = String(record?.taskKey ?? "");
    const at = taskKey.indexOf(":");
    return at > 0 ? taskKey.slice(0, at).trim() || null : null;
  };

  // The operator remedy appended to EVERY repository-resolution failure — an
  // error an operator can copy-paste a fix from, whether the map is missing,
  // ambiguous or the mapped clone is simply not there yet.
  const resolutionRemedy =
    "Fix it either way: map the repository — `fenix repo add <repository url> --project <the task's Linear project>` — " +
    "or turn per-task worktrees off — `fenix settings set taskSessions.worktrees false` + `fenix restart supervisor`.";

  /**
   * The repository THIS record works on, in the documented order:
   *   (a) a repository carried on the session record (no writer produces one
   *       today — the forward-compatible hook);
   *   (b) deps.repo, the embedder's explicit pin (tests, single-repo hosts);
   *   (c) the projects.json entry whose `linearProject` equals the issue's
   *       Linear project (fetchIssueFacts) — exactly one distinct repository
   *       required, ambiguous fails closed;
   *   (d) only when (c) found no project or no matching entry: the STRUCTURED
   *       `ticketPrefix` field equal to the issue id's prefix (FOC in
   *       FOC-1080) — never a guess from note text; exactly one distinct
   *       repository required;
   *   (e) env FENIX_REPO_DIR / LA_SUPERVISOR_REPO — only when the project map
   *       does not exist or is unreadable (the map rules are then not
   *       applicable and the env decides, first resolvable wins).
   * A readable map that matches neither rule fails closed, naming what was
   * tried — it does not fall through to the host env.
   */
  const resolveGitRootFor = async (record) => {
    const taskKey = String(record?.taskKey ?? "(no taskKey)");
    const pinned = [
      record?.repo ? { value: String(record.repo), from: "the session record", explicit: true } : null,
      repo ? { value: repo, from: "deps.repo", explicit: true } : null,
    ].filter(Boolean);
    if (pinned.length > 0) return resolveFrom(pinned);
    const workspace = workspaceOf(record);
    if (!workspace) {
      throw new Error(
        `no repository for managed task '${taskKey}': the record names no workspace, so even the pisi routing of the Linear lookup is undecidable`,
      );
    }
    const entries = projectEntries(env);
    if (entries !== null) {
      // The ISSUE drives the map match, not the workspace half of the task
      // key (round 3: that half is the Linear workspace name — "jointhubs" —
      // never a repository name). The workspace matters only as the pisi
      // routing flag for the Linear call (the pisi workspace reads
      // LINEAR_API_KEY_PISI); it is passed through unchanged otherwise.
      const issueId = typeof record?.issueId === "string" ? record.issueId.trim() : "";
      const prefixMatch = TICKET_PREFIX_RE.exec(issueId);
      const prefix = prefixMatch ? prefixMatch[1] : null;
      const facts = issueId
        ? await factsFor(issueId, { env: workspace === "pisi" ? { ...env, LINEAR_WORKSPACE: "pisi" } : env })
        : null;
      const project = typeof facts?.project === "string" && facts.project.trim() ? facts.project.trim() : null;
      // Match a set of map entries to ONE distinct expanded repository path —
      // or fail closed when they disagree (ambiguous). Matching entries whose
      // repo refs cannot expand count as no match: the fallback rule decides,
      // and if neither rule names a repository the failure lists what was
      // tried.
      const oneRepoFor = (matching, label) => {
        const paths = new Set();
        for (const entry of matching) {
          const value = repoRefPath(entry?.repo, env);
          if (value) paths.add(value);
        }
        if (paths.size > 1) {
          throw new Error(
            `no repository for managed task '${taskKey}': the project map maps ${label} to ` +
              `${paths.size} repositories (${[...paths].join(", ")}) — ambiguous`,
          );
        }
        if (paths.size === 1) {
          // The mapped repository is authoritative: an explicit candidate
          // that fails LOUDLY (repo not cloned, not a git repo) — falling
          // through to the host env could only hand the session the WRONG
          // repository, the FOC-172 bug class this lane exists to prevent.
          const [value] = [...paths];
          return { value, from: `projects.json repo for ${label}`, explicit: true };
        }
        return null;
      };
      const projectMatches = project ? entries.filter((entry) => entry?.linearProject === project) : [];
      const byProject = project ? oneRepoFor(projectMatches, `Linear project '${project}'`) : null;
      if (byProject) return resolveFrom([byProject]);
      const prefixMatches = prefix ? entries.filter((entry) => entry?.ticketPrefix === prefix) : [];
      const byPrefix = prefix ? oneRepoFor(prefixMatches, `ticket prefix '${prefix}'`) : null;
      if (byPrefix) return resolveFrom([byPrefix]);
      // Fail closed, naming WHAT WAS TRIED — the project Linear gave (or why
      // it gave none) and the ticket prefix — so the remedy is actionable.
      const tried = [];
      if (facts === null) tried.push(`Linear is unavailable (no facts for '${issueId || "no issueId"}')`);
      else if (project) {
        tried.push(
          projectMatches.length
            ? `the projects.json entries matching Linear project '${project}' name no resolvable repository`
            : `Linear project '${project}' matches no projects.json entry`,
        );
      } else tried.push("the issue has no Linear project in Linear");
      if (prefix) tried.push(`no projects.json entry carries ticket prefix '${prefix}'`);
      else tried.push(`the issue id '${issueId || "(none)"}' carries no TEAM-NUM ticket prefix`);
      throw new Error(`no repository for managed task '${taskKey}': ${tried.join("; ")}`);
    }
    try {
      return await resolveFrom(
        [
          env.FENIX_REPO_DIR ? { value: env.FENIX_REPO_DIR, from: "FENIX_REPO_DIR" } : null,
          env.LA_SUPERVISOR_REPO ? { value: env.LA_SUPERVISOR_REPO, from: "LA_SUPERVISOR_REPO" } : null,
        ].filter(Boolean),
      );
    } catch (err) {
      const tried = Array.isArray(err?.tried) && err.tried.length ? ` (tried: ${err.tried.join("; ")})` : "";
      throw new Error(`no repository for managed task '${taskKey}': ${err.message}${tried}`);
    }
  };

  return {
    async ensure(record) {
      const lib = await loadLib();
      let gitRoot;
      try {
        gitRoot = await resolveGitRootFor(record);
      } catch (err) {
        throw new Error(`${err.message}. ${resolutionRemedy}`);
      }
      const branch = sessionBranchFor(record);
      // The claim owner is the TASK, not the session: a resumed generation
      // carries a new session id but the same task, and must re-claim its own
      // branch as the SAME owner — a session-scoped owner would turn every
      // resume into a claim conflict.
      const ownerId = `task-session:${record.taskKey}`;
      // ensureWorktree enforces the start point on reuse as well as creation,
      // but a resumed tree stands at the PREVIOUS generation's HEAD — exactly
      // the state a resume must continue from. So the start point (the origin
      // default branch, the one deterministic base every session of the repo
      // shares) is resolved and pinned only when the branch has no worktree
      // yet; an existing tree is reused as it stands.
      const existing = lib.listWorktrees(gitRoot).find((w) => w.branch === branch);
      const startPoint = existing ? null : lib.resolveBranchStartPoint({ gitRoot, candidate: null });
      const ensured = lib.ensureWorktree(gitRoot, branch, startPoint, { ownerId });
      // FOC-1153: the same provisioning the spawn path applies. The tree a
      // session is about to work in gets its deps as real directories — the
      // improvisation this replaces is exactly the junction incident. Tolerant
      // by design, so it is a no-op for repos without manifests.
      const depsInstall = await lib.installWorktreeDeps(ensured.worktree);
      if (!depsInstall.ok) {
        console.error(
          `task-session-host: dependency install did not complete in ${ensured.worktree} — ` +
            `the session starts anyway (${depsInstall.locations.filter((l) => l.ok === false).map((l) => l.location).join(", ")})`,
        );
      }
      return { gitRoot, branch, worktree: ensured.worktree, ownerId, startPoint, depsInstall };
    },
    release(record, resolved) {
      // `resolved` is the session's memoized ensure() result — release must
      // hit the SAME repository ensure claimed, never a re-resolution (an
      // operator remapping the project map between ensure and release must
      // not redirect the release to another repository). A session that never
      // ensured (no resolved) claimed nothing.
      if (!resolved?.gitRoot) return { ok: true, released: false, claim: null };
      return realReleaseClaim({ gitRoot: resolved.gitRoot, branch: resolved.branch, ownerId: resolved.ownerId });
    },
  };
}

// ── durable initial prompt ───────────────────────────────────────────────────

const pendingPromptPath = (sessionHome) => join(sessionHome, "pending-prompt.json");

const readPendingPrompt = (sessionHome) => {
  try {
    const parsed = JSON.parse(readFileSync(pendingPromptPath(sessionHome), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

// Atomic AND exclusive: 'wx' refuses to overwrite, so two racing POSTs for the
// same session can never double-arm or replace the prompt — first text wins
// and every later duplicate start re-reads the same text.
const armPendingPrompt = (sessionHome, payload) => {
  mkdirSync(sessionHome, { recursive: true });
  try {
    writeFileSync(pendingPromptPath(sessionHome), JSON.stringify({ ...payload, state: "armed" }, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (err) {
    if (/EEXIST/.test(String(err?.code ?? err?.message))) return false;
    throw err;
  }
};

const markPendingPrompt = (sessionHome, pending, patch) => {
  const path = pendingPromptPath(sessionHome);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...pending, ...patch }, null, 2) + "\n");
  // Atomic rename over the target; the file was proven to exist (we read it
  // before marking), so the delivery state never goes backwards.
  renameSync(tmp, path);
};

// ── the multiplexer ──────────────────────────────────────────────────────────

const STATUS_TEXT = { 400: "Bad Request", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error" };

/**
 * Build the task-session host. Every dep is optional; the defaults are the
 * real thing. deps.controllerDeps is either an object spread into EVERY
 * controller's createHost deps, or a function (sessionId) → deps — the seam
 * tests use to give each session its own fake tmux/pty/clock.
 */
/**
 * The owner-scope filter of auto-pickup, over task-ownership's verdict
 * function. `checkOwnership(issue, opts)` returns `{ verdict, allowed, … }`
 * (see task-ownership.mjs) — the candidate is kept iff `allowed === true`; a
 * throwing check excludes it (never a guessed scope) and is counted as
 * `error`. Exported so the test exercises it against the REAL module.
 *
 * FOC-1081: the first wiring called `checkOwnership({ issue, workspace, env })`
 * and kept a candidate when the result `=== true` — an object never is, and the
 * wrapped issue read as "no project" — so auto-pickup enqueued nothing on every
 * installation that ships task-ownership.mjs (all of them).
 */
export function ownershipKeeps(issues, checkOwnership) {
  const kept = [];
  const verdicts = {};
  for (const issue of issues) {
    let verdict = "error";
    try {
      const result = checkOwnership(issue);
      verdict = typeof result?.verdict === "string" ? result.verdict : "malformed";
      if (result?.allowed === true) kept.push(issue);
    } catch {
      /* excluded — counted below */
    }
    verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
  }
  return { kept, verdicts };
}

export function createTaskSessionHost(deps = {}) {
  const baseEnv = deps.env ?? process.env;
  // FOC-901: where the cap comes from — deps.maxActive (tests / embedders) →
  // env FENIX_MAX_ACTIVE_SUPERVISORS (the operational override, integer >= 1)
  // → overlay taskSessions.maxActive (survives `fenix update`) →
  // DEFAULT_MAX_ACTIVE (1 for 1.0, FOC-1088). The
  // chosen source is exposed (and logged once at serve start) so an operator
  // can see which layer decided.
  const envRaw = baseEnv.FENIX_MAX_ACTIVE_SUPERVISORS;
  const envNumber = Number.parseInt(envRaw ?? "", 10);
  const envMaxActive = Number.isInteger(envNumber) && envNumber >= 1 ? envNumber : null;
  // An empty value reads as unset (no warning); only a non-empty invalid one warns.
  if (envRaw != null && envRaw !== "" && envMaxActive === null) {
    console.error("task-session-host: FENIX_MAX_ACTIVE_SUPERVISORS must be an integer >= 1 — ignoring it");
  }
  const overlayMaxActive = readTaskSessionsSettings(baseEnv).maxActive;
  let maxActive;
  let maxActiveSource;
  if (deps.maxActive != null) {
    maxActive = deps.maxActive;
    maxActiveSource = "deps.maxActive";
  } else if (envMaxActive !== null) {
    maxActive = envMaxActive;
    maxActiveSource = "env FENIX_MAX_ACTIVE_SUPERVISORS";
  } else if (overlayMaxActive !== null) {
    maxActive = overlayMaxActive;
    maxActiveSource = "settings taskSessions.maxActive";
  } else {
    maxActive = DEFAULT_MAX_ACTIVE;
    maxActiveSource = "default";
  }
  const processIdentity = deps.processIdentity ?? readProcessIdentity;
  const stopping = new Set();
  const uncertain = new Set();
  const startById = new Map();
  const tmuxBin = baseEnv.LA_TMUX_BIN || "tmux";

  const store = deps.store ?? createTaskSessionStore({ dbPath: deps.dbPath, maxActive });
  const gate = deps.gate
    ?? createGatekeeper({ env: baseEnv, readToken: deps.readToken, resolvePeer: deps.resolvePeer });

  // The legacy controller serves the global routes while no managed session
  // exists. Its env is explicitly stripped of any session scoping.
  const legacyEnv = { ...baseEnv };
  delete legacyEnv.FENIX_SUPERVISOR_SESSION_ID;
  const legacy = createHost({ ...(deps.legacyDeps ?? {}), env: legacyEnv });

  // ── controllers: one per managed session, created lazily, never twice ────
  const controllers = new Map(); // sessionId → { host, env, sessionHome, sessionId }
  const creating = new Map(); // sessionId → Promise<controller>

  async function controllerFor(sessionId) {
    const existing = controllers.get(sessionId);
    if (existing) return existing;
    const inflight = creating.get(sessionId);
    if (inflight) return inflight;
    const promise = (async () => {
      const record = store.get(sessionId);
      if (!record) {
        const err = new Error(`unknown session ${sessionId}`);
        err.statusCode = 404;
        throw err;
      }
      const sessionHome = sessionHomePath(baseEnv, sessionId);
      // FOC-1088: the session's workspace is derived ONCE (memoized in
      // `workspaces`) and its worktree path becomes this controller's
      // FENIX_REPO_DIR — the entrypoint's supervisor-run branch resolves
      // LA_SUPERVISOR_REPO from it and cds there before starting claude. A
      // resolution failure throws: startSession marks the session `waiting`
      // naming the reason; there is no fallback to a shared checkout.
      const workspace = sessionWorkspace ? await ensureWorkspace(sessionId, record) : null;
      const env = {
        ...baseEnv,
        FENIX_SUPERVISOR_SESSION_ID: sessionId,
        LA_TASK_KEY: record.taskKey,
        LA_TASK_ID: record.taskId,
        LA_SUPERVISOR_SESSION_HOME: sessionHome,
        ...(workspace ? { FENIX_REPO_DIR: workspace.worktree } : {}),
      };
      const controllerDeps = typeof deps.controllerDeps === "function"
        ? (deps.controllerDeps(sessionId) ?? {})
        : (deps.controllerDeps ?? {});
      const host = createHost({ ...controllerDeps, env });
      const ctl = { host, env, sessionHome, sessionId };
      controllers.set(sessionId, ctl);
      return ctl;
    })().finally(() => creating.delete(sessionId));
    creating.set(sessionId, promise);
    return promise;
  }

  // The FOC-1088 lane itself. deps.sessionWorkspace replaces it wholesale
  // ({ ensure(record), release(record, resolved) }) for tests and embedders;
  // `null` disables it explicitly. Undefined → the real lane, on unless
  // switched off. Where the switch comes from — the same ladder the cap uses:
  // deps.worktrees (tests / embedders) → env FENIX_TASK_WORKTREES "0"|"1"
  // (the test / emergency override, winning over the overlay BOTH ways: an
  // operator who set =0 before the lane went default-on keeps their opt-out)
  // → the overlay's taskSessions.worktrees, DEFAULT TRUE (FOC-1088 round 2:
  // the shared checkout is the data-integrity bug — two managed sessions
  // editing one tree — and the cap is 1 anyway). A host that cannot resolve a
  // repository fails sessions closed with the remedy, never a silent fallback
  // to a shared checkout.
  const envWorktrees = baseEnv.FENIX_TASK_WORKTREES;
  const worktrees =
    deps.worktrees ??
    (envWorktrees === "0" || envWorktrees === "1"
      ? envWorktrees === "1"
      // readTaskSessionsSettings already defaults worktrees to true — no
      // second default here (the old `?? true` was dead).
      : readTaskSessionsSettings(baseEnv).worktrees);
  const sessionWorkspace = deps.sessionWorkspace !== undefined
    ? deps.sessionWorkspace
    : worktrees
      ? createRealSessionWorkspace({
          repo: deps.repo ?? null,
          env: baseEnv,
          loadLib,
          fetchIssueFacts: deps.fetchIssueFacts ?? null,
        })
      : null;
  const workspaces = new Map(); // sessionId → lane ensure() result, derived once per session
  const ensureWorkspace = async (sessionId, record) => {
    const known = workspaces.get(sessionId);
    if (known) return known;
    const resolved = await sessionWorkspace.ensure(record);
    workspaces.set(sessionId, resolved);
    return resolved;
  };
  // Release the claim — NEVER the tree (nothing in this runtime auto-removes a
  // worktree; cleanup is an operator decision). Called on the paths that end a
  // session's ownership: stop (including its queued and terminal early
  // returns) and failed starts. The release runs against the session's OWN
  // memoized ensure() result — never a re-resolution, which could land on a
  // different repository after an operator remap. The memo is dropped either
  // way: the next ensure must start fresh (re-resolve, re-claim), never
  // inherit a released generation's workspace. A `waiting` session from a
  // FAILED ENSURE holds no memo and no claim — it re-ensures (and re-claims)
  // after recovery, so an operator fix takes effect without a restart. A
  // failed release, like a session that crashes mid-flight, leaves the claim
  // in the registry naming its owner; recovery is always explicit.
  const releaseWorkspace = (record) => {
    if (!sessionWorkspace) return;
    const sessionId = record?.sessionId;
    const resolved = typeof sessionId === "string" ? workspaces.get(sessionId) : undefined;
    if (typeof sessionId === "string") workspaces.delete(sessionId);
    if (!resolved) return; // never ensured — nothing was claimed
    try {
      sessionWorkspace.release(record, resolved);
    } catch (err) {
      console.error(
        `task-session-host: could not release the workspace claim of ${record?.taskKey ?? sessionId}: ${err?.message ?? err}`,
      );
    }
  };

  const managedSessionCount = () => store.list().length;

  // ── FOC-902 §D: autonomous pickup (opt-in) ────────────────────────────────
  // The overlay's taskSessions.autoPickup (deps.autoPickup wins, for tests
  // and embedders). When enabled, a timer ticks every pollSeconds (first tick
  // 10 s after start): candidates come from linear-query per configured
  // state, filtered to the owner scope, and every candidate whose task key
  // has NO row in the store is enqueued until queued + active >= maxActive —
  // the existing scheduler (claimNext) promotes as today. The host never
  // writes to Linear; the claim comment stays in triage.
  const autoPickup = normalizeAutoPickup(
    deps.autoPickup ?? readTaskSessionsSettings(baseEnv).autoPickup ?? {},
  );
  // The owner-scope module: deps.taskOwnership replaces it (tests — null
  // exercises the projects-map fallback through a real tick, FOC-1147);
  // undefined keeps the module-level try import.
  const ownership = deps.taskOwnership !== undefined ? deps.taskOwnership : taskOwnership;
  const pickupClock = {
    now: deps.now ?? (() => Date.now()),
    setInterval:
      deps.setInterval ??
      ((fn, ms) => {
        const t = setInterval(fn, ms);
        if (typeof t?.unref === "function") t.unref();
        return t;
      }),
    clearInterval: deps.clearInterval ?? ((t) => clearInterval(t)),
    setTimeout:
      deps.setTimeout ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        if (typeof t?.unref === "function") t.unref();
        return t;
      }),
    clearTimeout: deps.clearTimeout ?? ((t) => clearTimeout(t)),
  };
  const pickup = { lastTickAt: null, lastError: null, lastEnqueued: [] };
  let pickupInterval = null;
  let pickupKick = null;

  // The task-key workspace: the SHARED rule (task-sessions workspaceNameFor —
  // FENIX_WORK_WORKSPACE overrides it, "jointhubs" is the default; the same
  // rule work-routes' workWorkspace applies to dashboard starts),
  // overridable per autoPickup.workspace. FOC-1147: the old inline copy is
  // gone — one rule, one key space: a picked and a dashboard-started ticket
  // share the `<workspace>:` prefix.
  const pickupWorkspace = () => autoPickup.workspace || workspaceNameFor(baseEnv);

  // FOC-1147: the owner-scope rule behind the fallback (below) — the projects
  // map's workspace field → one distinct linearProject, failing closed with
  // the remedy. Exported as ownerProjectForWorkspace; tests drive it directly
  // and through a real tick via the deps.taskOwnership seam.
  const linearProjectForWorkspace = (workspace) => ownerProjectForWorkspace(baseEnv, workspace);

  // listCandidates: one `node linear-query.mjs issues --status <state>
  // [--label <l>] --json` per configured state (the offline env rules —
  // LA_LINEAR_NO_ENV_FILE — ride in via the inherited env), deduped, then
  // filtered to the owner scope. One failed state fails the whole tick: a
  // partial candidate list could silently skip tickets living in the state
  // that failed. When task-ownership's checkOwnership exists it replaces the
  // projects.json rule, one call per candidate (deps.taskOwnership replaces
  // the module for tests — undefined keeps the real module; null exercises
  // the projects-map fallback through a real tick).
  const listCandidates = deps.listCandidates ?? (async () => {
    const script = join(HERE, "linear-query.mjs");
    const runOne = (state) =>
      new Promise((resolve) => {
        const argv = [
          script,
          "issues",
          "--status",
          state,
          ...(autoPickup.label ? ["--label", autoPickup.label] : []),
          "--json",
        ];
        execFile(
          process.execPath,
          argv,
          { env: baseEnv, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
          (err, stdout) => {
            if (err) {
              resolve({ state, error: String(err?.message ?? err), issues: [] });
              return;
            }
            try {
              resolve({ state, error: null, issues: JSON.parse(stdout) });
            } catch (parseErr) {
              resolve({ state, error: `unparsable linear-query output: ${parseErr.message}`, issues: [] });
            }
          },
        );
      });
    const results = await Promise.all(autoPickup.states.map(runOne));
    const failed = results.find((r) => r?.error);
    if (failed) throw new Error(`linear-query issues --status ${failed.state}: ${failed.error}`);
    const seen = new Set();
    const issues = [];
    for (const r of results) {
      for (const issue of Array.isArray(r.issues) ? r.issues : []) {
        const key = issue?.identifier ?? issue?.id;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        issues.push(issue);
      }
    }
    if (typeof ownership?.checkOwnership === "function") {
      const { kept, verdicts } = ownershipKeeps(issues, ownership.checkOwnership);
      pickup.lastOwnership = verdicts;
      if (kept.length !== issues.length) {
        console.log(`auto-pickup: ownership kept ${kept.length} of ${issues.length} candidate(s) — ${JSON.stringify(verdicts)}`);
      }
      return kept;
    }
    // FOC-1147: the fallback scope resolves through the projects map (the
    // entries' workspace field) and fails closed WITH the remedy — the throw
    // lands in pickup.lastError through the tick's catch.
    const ownerProject = linearProjectForWorkspace(pickupWorkspace());
    return issues.filter((issue) => issue?.project?.name === ownerProject);
  });

  const pickupTick = async () => {
    if (!autoPickup.enabled) return null;
    pickup.lastTickAt = new Date(pickupClock.now()).toISOString();
    try {
      const candidates = (await listCandidates()) ?? [];
      // Priority first (urgent = 1 … low = 4, none/unknown last), then the
      // oldest candidate first — the order the queue would serve them in.
      const rank = (p) => (Number.isInteger(p) && p >= 1 && p <= 4 ? p : 1_000_000);
      const ordered = [...candidates].sort(
        (a, b) =>
          rank(a?.priority) - rank(b?.priority) ||
          String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? "")),
      );
      const workspace = pickupWorkspace();
      const enqueued = [];
      let skipped = 0;
      let active = store.list({ includeTerminal: false }).length;
      for (const issue of ordered) {
        if (active >= maxActive) break;
        // The task key's issue part is the display identifier — the value
        // every other store writer uses, keyed through the shared helper
        // `issuePartOf` (work-routes' taskKeyOf applies it to fetchIssue
        // results too). Preferring a uuid `id` would fork the key space and
        // the skip rule below would never see dashboard-started tickets.
        const issueId = issuePartOf(issue);
        let taskKey = null;
        try {
          taskKey = resolveTaskKey({ workspace, issueId });
        } catch {
          taskKey = null;
        }
        if (!taskKey) continue;
        // ANY row counts — queued, active and terminal alike. A completed or
        // failed ticket is never re-picked automatically.
        if (store.getByTask(taskKey)) {
          skipped++;
          continue;
        }
        const record = store.ensure({
          taskKey,
          taskId: issueId,
          workspace,
          issueId,
          title: typeof issue?.title === "string" ? issue.title.slice(0, 300) : undefined,
        });
        // FOC-1081 (second half): a queued session only starts once the pump
        // claims it, and the pump refuses a session without an ARMED durable
        // initial prompt. The dashboard start (POST /sessions) arms one; the
        // pickup never did, so every picked ticket sat `queued` forever. Arm
        // the same hand-off text the Work board shows (startText), once — a
        // prompt already on record is never overwritten — then pump below.
        const sessionHome = sessionHomePath(baseEnv, record.sessionId);
        if (!readPendingPrompt(sessionHome)) {
          armPendingPrompt(sessionHome, {
            sessionId: record.sessionId,
            taskKey: record.taskKey,
            text: startText(issue),
            armedAt: new Date().toISOString(),
            source: "auto-pickup",
          });
        }
        enqueued.push(record.taskKey);
        active++;
      }
      pickup.lastEnqueued = enqueued;
      pickup.lastError = null;
      console.log(
        `auto-pickup: ${ordered.length} candidates, ${enqueued.length} enqueued` +
          (skipped > 0 ? `, skipped ${skipped} (in store)` : ""),
      );
      // Hand the queue to the pump: claimNext promotes the oldest queued
      // sessions up to the cap and starts them. Fire-and-forget like the stop
      // path — the tick's result is about the queue, not about readiness.
      if (enqueued.length > 0) void pump();
      return { candidates: ordered.length, enqueued, skipped };
    } catch (err) {
      const reason = await redactOperatorText(String(err?.message ?? err));
      pickup.lastError = reason;
      console.error(`auto-pickup: tick failed (${reason})`);
      return { error: reason };
    }
  };

  const startPickupTimer = () => {
    if (!autoPickup.enabled || pickupInterval || pickupKick) return;
    pickupKick = pickupClock.setTimeout(() => {
      pickupKick = null;
      void pickupTick();
    }, PICKUP_FIRST_TICK_MS);
    pickupInterval = pickupClock.setInterval(() => void pickupTick(), autoPickup.pollSeconds * 1000);
  };
  const stopPickupTimer = () => {
    if (pickupKick) {
      pickupClock.clearTimeout(pickupKick);
      pickupKick = null;
    }
    if (pickupInterval) {
      pickupClock.clearInterval(pickupInterval);
      pickupInterval = null;
    }
  };
  if (autoPickup.enabled) startPickupTimer();

  // ── the queue pump ────────────────────────────────────────────────────────
  // Single-flight: claimNext() promotes the oldest queued session iff the cap
  // allows (inside SQLite, so it holds across processes). A claimed session
  // starts asynchronously — readiness and delivery never block a response.
  // In-flight starts are tracked so tests (and a future drain-on-shutdown)
  // can await the quiet point: settled() resolves when no start is running.
  const inflightStarts = new Set();
  const startSessionTracked = (record, pending) => {
    const p = startSession(record, pending).finally(() => { inflightStarts.delete(p); startById.delete(record.sessionId); });
    inflightStarts.add(p);
    startById.set(record.sessionId, p);
    return p;
  };
  const settled = () => Promise.allSettled([...inflightStarts]);
  let pumping = null;
  function pump() {
    if (pumping) return pumping;
    pumping = (async () => {
      for (;;) {
        const claimed = store.claimNext();
        if (!claimed) break;
        const pending = readPendingPrompt(sessionHomePath(baseEnv, claimed.sessionId));
        const resume = existsSync(join(sessionHomePath(baseEnv, claimed.sessionId), "resume-request.json"));
        if ((!pending || pending.state !== "armed") && !resume) {
          // Fail closed on uncertain delivery: without an ARMED durable
          // prompt we cannot prove the initial prompt was never sent — never
          // blindly resend, surface the reason instead. The failed status
          // releases the cap slot, so the next queued session is tried.
          store.update(claimed.sessionId, {
            status: "failed",
            lastError: !pending
              ? "no durable initial prompt on record; delivery cannot be proven undelivered — refusing to start or resend"
              : `initial prompt already '${pending.state}'; refusing to redeliver — re-attach via POST /sessions/:id/session and deliver manually`,
          });
          // A failed start releases the cap slot — it releases the workspace
          // claim with it (usually a no-op: a queued session never claimed).
          releaseWorkspace(claimed);
          continue;
        }
        void startSessionTracked(claimed, resume ? { resume: true } : pending);
      }
    })().finally(() => {
      pumping = null;
    });
    return pumping;
  }

  async function startSession(record, pending) {
    const sessionId = record.sessionId;
    try {
      const ctl = await controllerFor(sessionId);
      if (stopping.has(sessionId)) return;
      const ens = await ctl.host.ensureSession({});
      captureIdentity(record, ctl);
      if (stopping.has(sessionId)) return;
      if (!ens.ready) {
        // 'waiting' keeps the cap slot and the reason visible; an operator
        // re-issues POST /sessions/:id/session or stops the session.
        store.update(sessionId, { status: "waiting", lastError: `supervisor not ready: ${ens.reason}` });
        return;
      }
      if (pending.resume) {
        store.update(sessionId,{status:'running',lastError:null});
        // No prompt is replayed: native --continue restores only this history.
        return;
      }
      // The paste begins: from here delivery is UNCERTAIN until proven. If the
      // process dies between the mark and the proof, the state on disk says
      // so and the host never resends.
      markPendingPrompt(ctl.sessionHome, pending, { state: "delivering", deliveringAt: new Date().toISOString() });
      const sent = await ctl.host.sendMessage(pending.text);
      if (sent.status !== 200) {
        store.update(sessionId, {
          status: "waiting",
          lastError: `initial delivery failed (${sent.body?.error ?? sent.status}); prompt NOT resent — deliver manually`,
        });
        return;
      }
      if (sent.body?.sent === false) {
        // A 200 that pasted nothing (FOC-1111: the duplicate guard refused —
        // the same text is already queued in this pane) is NOT delivery
        // proof. The durable prompt stays 'delivering' (unproven, never
        // resent — the same fail-closed rule as every other unproven
        // delivery) and the reason is surfaced.
        store.update(sessionId, {
          status: "waiting",
          lastError: "initial prompt NOT pasted (refused as a duplicate of a queued copy); delivery unproven — NOT resent, deliver manually if the queued copy is lost",
        });
        return;
      }
      markPendingPrompt(ctl.sessionHome, { ...pending, state: "delivering" }, {
        state: "delivered",
        deliveredAt: new Date().toISOString(),
      });
      // Stamp the run id from the session-scoped pointer and the pane pid.
      const runRecord = readCurrentRun({ path: join(ctl.sessionHome, "current-run.json") });
      const state = ctl.host.getState();
      const current = store.get(sessionId);
      store.update(sessionId, {
        status: "running",
        runId: runRecord?.runId ?? current?.runId ?? null,
        pid: state.panePid ?? null,
        processStartedAt: processIdentity(state.panePid).identity,
        lastError: null,
      });
    } catch (err) {
      // A failed start no longer owns a live run: release the workspace claim
      // (the tree stays on disk — a later generation of the same task
      // re-claims the same branch deterministically) and surface the reason.
      releaseWorkspace(record);
      try {
        // FOC-1147: redacted — the resolution failure echoes the candidate
        // values it tried (a URL with userinfo, an api_key=… echo).
        store.update(sessionId, { status: "waiting", lastError: `start failed (${await redactOperatorText(`${err?.message ?? err}`)}); capacity reserved until scoped stop or recovery` });
      } catch {
        /* store gone — nothing more we can do */
      }
    }
  }

  // Persist an OS identity, not a wall-clock approximation of process start.
  function captureIdentity(record, ctl) {
    const state = ctl.host.getState();
    const observation = processIdentity(state.panePid);
    const pointer = readCurrentRun({ path: join(ctl.sessionHome, 'current-run.json') });
    if (pointer?.taskKey && pointer.taskKey !== record.taskKey) throw Error('run owner mismatch');
    store.update(record.sessionId, { pid: state.panePid, processStartedAt: observation.identity,
      ...(pointer?.runId ? { runId: pointer.runId } : {}) });
    return observation;
  }

  async function reconcile() {
    const active = store.list({ includeTerminal: false });
    for (const rec of active) {
      if (rec.status === 'queued') continue;
      let ctl;
      try {
        ctl = await controllerFor(rec.sessionId);
      } catch (err) {
        // FOC-1088: a workspace that cannot be re-ensured after a restart
        // (repository gone, claim held) must not crash the whole reconcile
        // pass — surface the reason on the record; capacity stays reserved
        // until an operator resolves it. FOC-1147: redacted — the resolution
        // error echoes the candidate values it tried.
        const reason = await redactOperatorText(`${err?.message ?? err}`);
        try {
          store.update(rec.sessionId, { status: 'waiting', lastError: `workspace unavailable: ${reason}` });
        } catch { /* record gone */ }
        continue;
      }
      const state = ctl.host.getState();
      const observation = processIdentity(rec.pid);
      const same = state.panePid === rec.pid && !state.paneDead && matchesProcess(rec, observation);
      const pending = readPendingPrompt(ctl.sessionHome);
      if (same) {
        uncertain.delete(rec.sessionId);
        store.update(rec.sessionId, { status: pending?.state === 'delivered' ? 'running' : 'waiting',
          lastError: pending?.state === 'delivered' ? null : 'initial delivery UNPROVEN; NOT resent — deliver manually' });
      } else {
        // A missing pane may still leave children. Keep the claim until stop
        // proves all owned processes have ended; PID reuse is never adopted.
        uncertain.add(rec.sessionId);
        store.update(rec.sessionId, { status: 'waiting', lastError: 'process identity unproven after restart; capacity reserved; use scoped stop' });
      }
    }
    await pump();
    return active.length;
  }

  // ── stop: THIS tmux session and THIS run's children only ──────────────────
  // The default stopChild shells out to the EXISTING per-child CLI (graceful →
  // force, marks the child stopped before the kill, never cleans the worktree).

  async function stopSession(record) {
    const sessionId = record.sessionId;
    stopping.add(sessionId);
    try {
      await startById.get(sessionId);
      record = store.get(sessionId);
      if (TERMINAL_STATUSES.includes(record.status)) {
        releaseWorkspace(record);
        return { stopped: true, runId: record.runId, children: [] };
      }
      if (record.status === 'queued') {
        // A queued session never started, so its claim (if any) was released
        // earlier; the release here is the idempotent no-op that keeps that
        // invariant true regardless of ordering.
        releaseWorkspace(record);
        store.update(sessionId, { status: 'stopped', lastError: null });
        return { stopped: true, runId: record.runId, children: [] };
      }
      const ctl = await controllerFor(sessionId);
      const state = ctl.host.getState();
      const ident = tmuxIdentity(ctl.env);
      const results = { stopped: false, tmux: null, children: [], runId: record.runId };
      if (state.session === 'absent' || state.paneDead) results.tmux = { ok: true };
      else {
        // An unknown/reused PID must not be killed merely because a record
        // still carries it. A process launched here was captured before use.
        if (!matchesProcess(record, processIdentity(state.panePid)) || record.pid !== state.panePid) {
          uncertain.add(sessionId);
          store.update(sessionId, { status: 'waiting', lastError: 'stop refused: process identity unproven; capacity remains reserved' });
          return results;
        }
        const killed = deps.stopTmux ? await deps.stopTmux(ident, ctl.env)
          : spawnSync(tmuxBin, ['-L', ident.socket, 'kill-session', '-t', ident.session], { encoding: 'utf8', env: ctl.env });
        results.tmux = { ok: killed?.status === 0 };
      }
      if (record.runId) {
        try {
          const lib = deps.lib ?? await loadLib();
          const registry = lib.readRegistry(record.runId);
          const children = Object.entries(registry.children || {}).map(([id, child]) => ({ ...child, childId: child.childId || id }));
          const liveIds = new Set(lib.liveChildren({ ...registry, children: Object.fromEntries(children.map(c => [c.childId, c])) }).map(c => c.childId));
          for (const child of children.filter(c => liveIds.has(c.childId))) {
            const result = deps.stopChild ? await deps.stopChild(record.runId, child.childId)
              : spawnSync(process.execPath, [join(HERE, 'supervisor-stop.mjs'), '--child', child.childId, '--run', record.runId], { encoding: 'utf8', env: ctl.env });
            results.children.push({ childId: child.childId, ok: result?.status === 0 });
          }
        } catch { results.registryError = 'children could not be verified stopped'; }
      }
      results.stopped = results.tmux?.ok === true && !results.registryError && results.children.every(c => c.ok);
      store.update(sessionId, { status: results.stopped ? 'stopped' : 'waiting', lastError: results.stopped ? null : 'stop incomplete; capacity remains reserved' });
      if (results.stopped) {
        // Full success ends this generation's ownership: drop the controller
        // and the uncertain mark, and release the claim against the session's
        // own memoized resolution — releaseWorkspace drops the memo with it
        // (the next generation must re-ensure and re-claim its branch); the
        // tree stays on disk.
        controllers.delete(sessionId);
        uncertain.delete(sessionId);
        releaseWorkspace(record);
      }
      return results;
    } finally { stopping.delete(sessionId); }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  const denyUpgrade = (socket, status, text) => {
    try {
      socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
    } catch {
      /* socket already gone */
    }
    socket.destroy();
  };

  // Operations that must not run against a session without a live claim.
  const opGuard = (record) => {
    if (stopping.has(record.sessionId) || uncertain.has(record.sessionId)) return { status: 409, body: { error: "session-recovery-required" } };
    if (record.status === "queued") {
      return {
        status: 409,
        body: { error: "queued", message: "the session is queued; it starts when the cap allows" },
      };
    }
    if (TERMINAL_STATUSES.includes(record.status)) {
      return {
        status: 409,
        body: { error: "session-terminal", status: record.status, message: "this generation is over; POST /sessions starts a new one" },
      };
    }
    return null;
  };

  const delegateRequest = (ctl, req, res, newPath) => {
    if (newPath !== undefined) {
      const url = new URL(req.url, "http://localhost");
      req.url = newPath + (url.search || "");
    }
    ctl.host.server.emit("request", req, res);
  };

  const validateStartPayload = (payload) => {
    for (const field of ["taskKey", "taskId", "workspace", "issueId"]) {
      if (typeof payload[field] !== "string" || !payload[field].trim()) {
        return { status: 400, body: { error: "bad-identity", message: `${field} must be a non-empty string` } };
      }
    }
    let resolved;
    try {
      resolved = resolveTaskKey({ workspace: payload.workspace, issueId: payload.issueId });
    } catch (err) {
      return { status: 400, body: { error: "bad-identity", message: err.message } };
    }
    if (payload.taskKey !== resolved) {
      return {
        status: 400,
        body: { error: "task-key-mismatch", message: `taskKey must be '${resolved}' (workspace:issueId)` },
      };
    }
    if (typeof payload.text !== "string" || !payload.text.trim()) {
      return { status: 400, body: { error: "empty", message: "text (the initial prompt) is required" } };
    }
    if (Buffer.byteLength(payload.text, "utf8") > MAX_MESSAGE_BYTES) {
      return { status: 400, body: { error: "too-long", message: `text is limited to ${MAX_MESSAGE_BYTES} bytes` } };
    }
    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title : undefined;
    return {
      values: {
        taskKey: resolved,
        taskId: payload.taskId,
        workspace: payload.workspace,
        issueId: payload.issueId,
        title,
        text: payload.text,
      },
    };
  };

  const handleSessionStart = async (req, res) => {
    const { body, over } = await readBody(req);
    if (over) {
      sendJSON(res, 413, { error: "body-too-large" });
      return;
    }
    const payload = parseJSON(body);
    if (payload === null) {
      sendJSON(res, 400, { error: "bad-json" });
      return;
    }
    const checked = validateStartPayload(payload);
    if (checked.status) {
      sendJSON(res, checked.status, checked.body);
      return;
    }
    // Idempotent: ensure returns the existing active owner for the task (a
    // duplicate start lands on the SAME session) or creates a new generation.
    let record;
    try {
      record = store.ensure(checked.values);
    } catch (err) {
      // e.g. a title beyond the store's bound — identity-shaped, so 400.
      sendJSON(res, 400, { error: "bad-identity", message: err.message });
      return;
    }
    // Arm the durable initial prompt exactly once — never overwrite: a
    // duplicate open (or a racing duplicate POST) keeps the FIRST text, so the
    // initial prompt can never be delivered twice.
    const sessionHome = sessionHomePath(baseEnv, record.sessionId);
    const pending = readPendingPrompt(sessionHome);
    if (!pending) {
      armPendingPrompt(sessionHome, {
        sessionId: record.sessionId,
        taskKey: record.taskKey,
        text: checked.values.text,
        armedAt: new Date().toISOString(),
      });
    }
    await pump();
    const fresh = store.get(record.sessionId);
    // Truthful by STATUS, not by controller bookkeeping: 'starting' means the
    // coordinator claimed it and the start is in flight; 'supervisor' means
    // the session already owns a live process (nothing was redelivered).
    const delivery = fresh.status === "queued" ? "queued" : fresh.status === "starting" ? "starting" : "supervisor";
    sendJSON(res, delivery === "supervisor" ? 200 : 202, { session: fresh, delivery });
  };

  const handleSessionStop = async (res, record) => {
    const results = await stopSession(record);
    void pump();
    sendJSON(res, results.stopped ? 200 : 409, { session: store.get(record.sessionId), ...results, ...(!results.stopped ? { error: "stop-incomplete" } : {}) });
  };

  const handleSessionEnsure = async (res, record, payload) => {
    const ctl = await controllerFor(record.sessionId);
    const guard = opGuard(store.get(record.sessionId));
    if (guard) { sendJSON(res, guard.status, guard.body); return; }
    const ens = await ctl.host.ensureSession({ fresh: payload.fresh === true });
    captureIdentity(record, ctl);
    if (!ens.ready) {
      sendJSON(res, 503, { error: "starting" });
      return;
    }
    // A valid owner re-attached or restarted in THIS process. Reflect
    // liveness — unless the initial prompt is still unproven, in which case
    // 'waiting' surfaces that it was NOT resent (the operator delivers it).
    const pending = readPendingPrompt(ctl.sessionHome);
    const unproven = !pending || pending.state !== "delivered";
    const current = store.get(record.sessionId);
    if (current && !TERMINAL_STATUSES.includes(current.status)) {
      store.update(record.sessionId, {
        status: unproven ? "waiting" : "running",
        lastError: unproven ? "initial delivery unproven; the prompt was not resent — deliver manually" : null,
      });
    }
    sendJSON(res, 200, { ready: true });
  };

  const route = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    } catch {
      sendJSON(res, 404, { error: "not-found" });
      return;
    }
    const method = req.method ?? "GET";
    const path = url.pathname;

    // Health: loopback only, no token, no store operation.
    if (path === "/healthz" && method === "GET") {
      if (!gate.loopback.has(req.socket?.remoteAddress ?? "")) {
        sendJSON(res, 403, { error: "forbidden-peer" });
        return;
      }
      const sessions = managedSessionCount();
      sendJSON(res, 200, sessions === 0 ? { ok: true, session: legacy.getState().session, managedSessions: 0 } : { ok: true, managedSessions: sessions });
      return;
    }

    // BOTH gates BEFORE any lookup or store operation.
    const denied = await gate.check(req);
    if (denied) {
      sendJSON(res, denied.status, denied.body);
      return;
    }

    if (path === "/alive" && method === "POST") {
      const { body, over } = await readBody(req);
      if (over) {
        sendJSON(res, 413, { error: "body-too-large" });
        return;
      }
      const payload = parseJSON(body);
      if (payload === null) {
        sendJSON(res, 400, { error: "bad-json" });
        return;
      }
      sendJSON(res, 200, legacy.alive(payload.pids));
      return;
    }

    if (path === "/sessions" && method === "GET") {
      sendJSON(res, 200, { sessions: store.list(), maxActive });
      return;
    }
    if (path === "/pickup" && method === "GET") {
      sendJSON(res, 200, {
        enabled: autoPickup.enabled,
        pollSeconds: autoPickup.pollSeconds,
        states: autoPickup.states,
        lastTickAt: pickup.lastTickAt,
        lastError: pickup.lastError,
        lastEnqueued: pickup.lastEnqueued,
      });
      return;
    }
    if (path === "/sessions" && method === "POST") {
      await handleSessionStart(req, res);
      return;
    }

    const sessionMatch = /^\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    if (sessionMatch) {
      let sessionId;
      try { sessionId = decodeURIComponent(sessionMatch[1]); } catch { sendJSON(res, 400, { error: "bad-session-id" }); return; }
      const sub = sessionMatch[2] ?? "";
      if (!validSessionId(sessionId)) {
        sendJSON(res, 400, { error: "bad-session-id", message: `sessionId must match ${SUPERVISOR_SESSION_ID_PATTERN}` });
        return;
      }
      const record = store.get(sessionId);
      if (!record) {
        sendJSON(res, 404, { error: "unknown-session" });
        return;
      }

      if (sub === "" || sub === "/") {
        sendJSON(res, 200, { session: record });
        return;
      }
      if (sub === "/state" && method === "GET") {
        const ctl = await controllerFor(sessionId);
        sendJSON(res, 200, { ...ctl.host.getState(), taskSession: record });
        return;
      }
      if (sub === '/profile-preview' && method === 'GET') {
        const after=resolveToolProfile({squad:'supervisor',role:'lead',env:baseEnv});
        let before=null;try{before=JSON.parse(readFileSync(join(sessionHomePath(baseEnv,sessionId),'claude','snapshot.json'),'utf8'));}catch{}
        const keys=['revision','tools','mcpServers'];
        const changes=keys.filter(k=>JSON.stringify(before?.[k])!==JSON.stringify(after[k])).map(path=>({path,before:before?.[path]??null,after:after[path]}));
        sendJSON(res,200,{revision:after.revision,changes});return;
      }
      if (sub === '/resume' && method === 'POST') {
        const {body,over}=await readBody(req);if(over){sendJSON(res,413,{error:'body-too-large'});return;}
        const payload=parseJSON(body);
        if(!payload || payload.confirm!=='resume-session'){sendJSON(res,400,{error:'resume-confirmation-required'});return;}
        const currentProfile=resolveToolProfile({squad:'supervisor',role:'lead',env:baseEnv});
        if(payload.expectedRevision!==currentProfile.revision){sendJSON(res,409,{error:'profile-changed'});return;}
        if(record.status!=='stopped'){sendJSON(res,409,{error:'session-not-stopped'});return;}
        // Stop verified process death before releasing this owner; no other
        // generation can be displaced by this explicit resume transaction.
        const home=sessionHomePath(baseEnv,sessionId);mkdirSync(home,{recursive:true});
        writeFileSync(join(home,'resume-request.json'),JSON.stringify({at:new Date().toISOString(),revision:currentProfile.revision}));
        try{store.resume(sessionId);}catch{sendJSON(res,409,{error:'task-already-owned'});return;}
        await pump();sendJSON(res,202,{session:store.get(sessionId)});return;
      }
      if (sub === "/session" && method === "POST") {
        if (record.status === "queued") {
          sendJSON(res, 409, { error: "queued", message: "the session is queued; it starts when the cap allows" });
          return;
        }
        if (TERMINAL_STATUSES.includes(record.status)) {
          sendJSON(res, 409, { error: "session-terminal", status: record.status, message: "this generation is over; POST /sessions starts a new one" });
          return;
        }
        const { body, over } = await readBody(req);
        if (over) {
          sendJSON(res, 413, { error: "body-too-large" });
          return;
        }
        const payload = parseJSON(body) ?? {};
        await handleSessionEnsure(res, record, payload);
        return;
      }
      if (sub === "/stop" && method === "POST") {
        await handleSessionStop(res, record);
        return;
      }

      const guard = opGuard(record);
      if (guard) {
        sendJSON(res, guard.status, guard.body);
        return;
      }
      const ctl = await controllerFor(sessionId);
      if (sub === "/message" && method === "POST") {
        delegateRequest(ctl, req, res, "/message");
        return;
      }
      // FOC-1112: the API forwards answers on SESSION_ANSWER_ROUTES (the
      // controller's own /dialog/answer and /dialog/ask). The older /ask and
      // POST /dialog spellings stay as aliases so nothing that used them breaks.
      if ((sub === SESSION_ANSWER_ROUTES.ask || sub === "/ask") && method === "POST") {
        delegateRequest(ctl, req, res, "/dialog/ask");
        return;
      }
      if (sub === "/dialog" && method === "GET") {
        delegateRequest(ctl, req, res, "/dialog");
        return;
      }
      if ((sub === SESSION_ANSWER_ROUTES.dialog || sub === "/dialog") && method === "POST") {
        delegateRequest(ctl, req, res, "/dialog/answer");
        return;
      }
      sendJSON(res, 404, { error: "not-found" });
      return;
    }

    // ── global legacy routes: only while NO managed session exists ──────────
    if (managedSessionCount() > 0) {
      sendJSON(res, 409, {
        error: "selection-required",
        message: "managed task sessions exist; address one explicitly: /sessions, /sessions/:id/…",
        sessions: store.list().map((s) => ({ sessionId: s.sessionId, taskKey: s.taskKey, status: s.status })),
      });
      return;
    }
    legacy.server.emit("request", req, res);
  };

  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      try {
        // Raw errors never leak — a generic body only.
        sendJSON(res, 500, { error: "internal" });
      } catch {
        /* response already gone */
      }
    });
  });

  const connections = new Set();
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  const close = () => { for (const socket of connections) socket.destroy(); server.close(); };

  // ── FOC-839: one-shot legacy run migration at serve start ─────────────────
  // Fires once, at the first server.listen — in the CLI serve path that is
  // after the store exists and restart reconciliation has run. Injectable via
  // deps.migrateLegacy for tests; `null` skips it entirely so existing host
  // tests are unaffected. Fire-and-forget: serving is never blocked by it
  // (per-run problems land in `skipped`, an outright failure only logs).
  const migrateLegacy = deps.migrateLegacy === undefined ? realMigrateLegacy : deps.migrateLegacy;
  if (migrateLegacy) {
    let legacyMigrated = false;
    const rawListen = server.listen.bind(server);
    server.listen = (...args) => {
      if (!legacyMigrated) {
        legacyMigrated = true;
        void (async () => {
          try {
            const result = await migrateLegacy({ env: baseEnv, apply: true });
            console.log(`legacy migration: attached ${result.attached.length}, read-only ${result.readOnly.length}, skipped ${result.skipped.length}`);
          } catch (err) {
            console.error(`legacy migration: failed (${err?.message ?? err})`);
          }
        })();
      }
      return rawListen(...args);
    };
  }

  // ── WebSocket terminal ────────────────────────────────────────────────────
  server.on("upgrade", (req, socket, head) => {
    // FIRST statement: the client can reset this raw socket at any moment and
    // an unhandled 'error' would crash the whole multiplexer (same rule as
    // supervisor-host.mjs).
    socket.on("error", () => socket.destroy());
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    void (async () => {
      // Gates BEFORE any lookup — the WS path enforces the same order.
      const denied = await gate.check(req);
      if (denied) {
        denyUpgrade(socket, denied.status, STATUS_TEXT[denied.status] ?? "Denied");
        return;
      }
      const sessionMatch = /^\/sessions\/([^/]+)\/terminal$/.exec(pathname);
      if (sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]);
        if (!validSessionId(sessionId)) {
          denyUpgrade(socket, 400, "Bad Request");
          return;
        }
        const record = store.get(sessionId);
        if (!record) {
          denyUpgrade(socket, 404, "Not Found");
          return;
        }
        const guard = opGuard(record);
        if (guard) {
          denyUpgrade(socket, 409, "Conflict");
          return;
        }
        const ctl = await controllerFor(sessionId);
        const url = new URL(req.url, "http://localhost");
        req.url = `/terminal${url.search}`;
        ctl.host.server.emit("upgrade", req, socket, head);
        return;
      }
      if (pathname !== "/terminal") {
        socket.destroy();
        return;
      }
      if (managedSessionCount() > 0) {
        denyUpgrade(socket, 409, "Conflict");
        return;
      }
      legacy.server.emit("upgrade", req, socket, head);
    })().catch(() => {
      socket.destroy();
    });
  });

  return {
    server,
    close,
    store,
    gate,
    maxActive,
    maxActiveSource,
    legacy,
    controllerFor,
    pump,
    reconcile,
    stopSession,
    settled,
    // FOC-902 §D: pickup surface for tests and embedders.
    pickupTick,
    pickupState: pickup,
    pickupStop: stopPickupTimer,
    autoPickup,
  };
}

// ── isolated Claude config dir (entrypoint helper) ───────────────────────────

// Seed ONLY prompt/settings/agents/skills from the global Supervisor config —
// NEVER .claude.json or projects/, which carry the native conversation history
// and project state of the shared config (a `--continue` there could
// cross-resume another task). Existing files are left untouched: resuming the
// same session keeps its history and its config.
const SEED_FILES = ["settings.json", "CLAUDE.md"];
const SEED_TREES = ["agents", "skills"];

export function seedSessionConfig(env, sessionId, opts = {}) {
  const sessionHome = sessionHomePath(env, sessionId);
  const configDir = join(sessionHome, "claude");
  if (opts.dryRun) return configDir;
  const globalDir = env.LA_SQUAD_HOME
    ? join(env.LA_SQUAD_HOME, "supervisor")
    : join(HERE, "..", "agents", "supervisor");
  mkdirSync(configDir, { recursive: true });
  for (const name of SEED_FILES) {
    const src = join(globalDir, name);
    const dest = join(configDir, name);
    if (existsSync(src) && !existsSync(dest)) copyFileSync(src, dest);
  }
  for (const name of SEED_TREES) {
    const src = join(globalDir, name);
    if (!existsSync(src)) continue;
    const dest = join(configDir, name);
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const from = join(src, entry.name);
      const to = join(dest, entry.name);
      if (existsSync(to)) continue;
      if (entry.isDirectory()) {
        mkdirSync(to, { recursive: true });
        for (const f of readdirSync(from, { withFileTypes: true })) {
          if (f.isFile()) copyFileSync(join(from, f.name), join(to, f.name));
        }
      } else if (entry.isFile()) {
        copyFileSync(from, to);
      }
    }
  }
  return configDir;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = [
  "Usage: node scripts/task-session-host.mjs <verb> [options]",
  "  serve                          start the session multiplexer on :7332 (writes the global host token)",
  "  session-home --session <id>    print the session's state home (validates the id)",
  "  config-dir --session <id>      create+seed the session's isolated Claude config dir; print its path",
  "  attach-target                  JSON: how `fenix attach` should attach (legacy | session | selection-required)",
].join("\n");

function parseSessionArg(rest) {
  const idx = rest.indexOf("--session");
  if (idx === -1) throw new Error("--session <id> is required");
  const id = rest[idx + 1];
  if (!id) throw new Error("--session requires a value");
  return id;
}

function attachTarget(sessionId = null) {
  const store = createTaskSessionStore({});
  const all = store.list();
  store.close();
  if (sessionId) {
    if (!validSessionId(sessionId)) throw Error("invalid session id");
    const chosen = all.find(s => s.sessionId === sessionId && OWNER_STATUSES.includes(s.status));
    if (!chosen) throw Error("unknown or terminal session");
    return { mode: "session", sessionId, taskKey: chosen.taskKey, status: chosen.status };
  }
  if (all.length === 0) return { mode: "legacy" };
  const active = all.filter((s) => OWNER_STATUSES.includes(s.status));
  if (active.length === 1) {
    return { mode: "session", sessionId: active[0].sessionId, taskKey: active[0].taskKey, status: active[0].status };
  }
  return {
    mode: "selection-required",
    message: "no single unambiguous task session to attach; pick one explicitly",
    sessions: all.map((s) => ({ sessionId: s.sessionId, taskKey: s.taskKey, status: s.status })),
  };
}

async function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === "serve") {
    writeHostToken();
    const collector = createRuntimeCollector();
    await new Promise((resolve, reject) => {collector.server.once('error',reject);collector.server.listen(4318,'127.0.0.1',resolve);});
    const host = createTaskSessionHost();
    console.log(`task-session-host: maxActive=${host.maxActive} (${host.maxActiveSource})`);
    if (host.autoPickup.enabled) {
      console.log(
        `task-session-host: auto-pickup on (every ${host.autoPickup.pollSeconds}s, states ${host.autoPickup.states.join(",")})`,
      );
    }
    const failed = await host.reconcile();
    if (failed > 0) {
      console.error(`task-session-host: reconciled ${failed} active session(s) after restart — none re-adopted automatically`);
    }
    const bind = process.env.FENIX_HOST_BIND || "0.0.0.0";
    const port = Number.parseInt(process.env.FENIX_HOST_PORT ?? "", 10) || 7332;
    host.server.listen(port, bind, () => {
      console.log(`task-session-host listening on ${bind}:${port} (token written to host.token)`);
    });
    host.server.on("error", (err) => {
      console.error(`task-session-host: ${err.message}`);
      process.exit(1);
    });
    const shutdown = () => {
      collector.server.close();
      host.server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    return 0;
  }
  if (verb === "session-home") {
    console.log(sessionHomePath(process.env, parseSessionArg(rest)));
    return 0;
  }
  if (verb === "config-dir") {
    console.log(seedSessionConfig(process.env, parseSessionArg(rest)));
    return 0;
  }
  if (verb === "attach-target") {
    console.log(JSON.stringify(attachTarget(rest.includes("--session") ? parseSessionArg(rest) : null)));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`task-session-host: ${err.message}`);
    process.exit(1);
  }
}
