// scripts/supervisor-host-client.mjs — HTTP client for the Supervisor's session
// host (the fenix-supervisor container's :7332, FOC-783 plan §1).
//
// The client exists so the Cockpit routes (cockpit-routes.mjs) never talk to
// the host with bare fetch: two rules live here and nowhere else.
//
//   · The base URL comes from FENIX_SUPERVISOR_HOST (compose sets
//     http://fenix-supervisor:7332). Unset means NATIVE mode — the Supervisor
//     runs on this machine and there is no host to call; every route that needs
//     the host answers "docker-only" instead.
//   · The host token is read from hostTokenPath() on EVERY call, never cached:
//     a supervisor container restart rewrites /data/run/host.token (plan §1),
//     and a client holding the old token would 401 until restart.
//
// Every call resolves — never throws. Network failure, timeout and "no host"
// all come back as { status: 0, error }, so a route can distinguish them from
// the host's own HTTP answers by status alone.

import { readFileSync } from "node:fs";

import { hostTokenPath, SUPERVISOR_SESSION_ID_PATTERN } from "./fenix-paths.mjs";

/** The configured host base URL, or null in native mode (not in Docker). */
export function hostBase(env = process.env) {
  const raw = env.FENIX_SUPERVISOR_HOST;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim();
}

/**
 * The host path for one managed session's route: `/sessions/<sid>` plus an
 * optional suffix (`/state`, `/message`, `/terminal`, …). The session id is
 * validated against the strict pattern BEFORE it is ever composed into a
 * path — an unvalidated id must never reach a URL (or anything else a path is
 * built from). Throws on a malformed id; callers map that to 404/400.
 */
export function hostSessionPath(sessionId, suffix = "") {
  if (typeof sessionId !== "string" || !SUPERVISOR_SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError(`sessionId must match ${SUPERVISOR_SESSION_ID_PATTERN}`);
  }
  return `/sessions/${sessionId}${suffix}`;
}

/**
 * An env VIEW scoped to one managed session: the caller's env with
 * FENIX_SUPERVISOR_SESSION_ID set on the COPY. Global process.env is never
 * mutated — the fenix-paths session functions (supervisorSessionHome et al.)
 * read the session id from this view, so every scoped file path resolves
 * under <dataHome>/supervisor/sessions/<sid> for the duration of one call.
 * The id is validated exactly like hostSessionPath; throws on a malformed id.
 */
export function sessionScopedEnv(env, sessionId) {
  if (typeof sessionId !== "string" || !SUPERVISOR_SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError(`sessionId must match ${SUPERVISOR_SESSION_ID_PATTERN}`);
  }
  return { ...env, FENIX_SUPERVISOR_SESSION_ID: sessionId };
}

/**
 * The session record fields safe to expose to the dashboard — exactly the
 * host's record contract (sessionId/taskKey/taskId/workspace/issueId/title/
 * status/runId/pid/processStartedAt/createdAt/updatedAt/lastError), nothing
 * more. Unknown fields are dropped, absent fields stay absent; a non-object
 * reads as null. Shared by every route that passes a host session record
 * through (the sessions list, the Start flow) so the whitelist lives once.
 */
const SESSION_RECORD_FIELDS = [
  "sessionId",
  "taskKey",
  "taskId",
  "workspace",
  "issueId",
  "title",
  "status",
  "runId",
  "pid",
  "processStartedAt",
  "createdAt",
  "updatedAt",
  "lastError",
];

export function redactSessionRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const out = {};
  for (const field of SESSION_RECORD_FIELDS) {
    if (record[field] !== undefined) out[field] = record[field];
  }
  return out;
}

// The timeouts are the host's own budgets, not guesses: /state and /alive are
// answered from files and a pid probe (fast), while /session and /message
// ensure the tmux session and wait for proof of delivery (the host's own
// ensure can take 30 s) — 45 s leaves the client margin around that.
export const FAST_TIMEOUT_MS = 2_000;
export const SLOW_TIMEOUT_MS = 45_000;

/**
 * One request against the host. `body` (object) is sent as JSON; null sends no
 * body. Resolves { status, body } where body is the parsed JSON (falling back
 * to the raw text when the answer is not JSON), or { status: 0, error } on a
 * network error, a timeout, or a missing/unreadable token.
 */
export async function hostRequest(method, path, body = null, { timeoutMs = FAST_TIMEOUT_MS, env = process.env } = {}) {
  const base = hostBase(env);
  if (!base) return { status: 0, error: "no host configured (native mode)" };

  let token;
  try {
    token = readFileSync(hostTokenPath(env), "utf8").trim();
  } catch (err) {
    return { status: 0, error: `host token unreadable: ${err.message}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base.replace(/\/+$/, "") + path, {
      method,
      headers: {
        "content-type": "application/json",
        "x-fenix-host-token": token,
      },
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    const message = err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(err?.message ?? err);
    return { status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}
