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

import { hostTokenPath } from "./fenix-paths.mjs";

/** The configured host base URL, or null in native mode (not in Docker). */
export function hostBase(env = process.env) {
  const raw = env.FENIX_SUPERVISOR_HOST;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim();
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
