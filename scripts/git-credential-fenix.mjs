// scripts/git-credential-fenix.mjs — FOC-788: the one-shot git credential helper.
//
// git invokes it as
//     git -c credential.helper= -c 'credential.helper=!node "<this file>"' <git-op>
// and speaks the standard credential protocol to it: key=value lines on stdin
// (`protocol=https`, `host=github.com`, …) for the `get` operation.
//
// THE HARD RULE: the token leaves this file on exactly one channel — the
// helper's stdout (the protocol's `password=` line), and only for a github.com
// host. It is never on argv, never in the environment, never in a log line, a
// stderr message or an error. `store` and `erase` are no-ops on purpose:
// nothing here ever persists a credential (no .git-credentials, no credential
// store) — the one-shot helper IS the storage story.
//
// The token is read from the compose secret at call time (FOC-788 decision 4):
// a mounted `github_token` file wins, and an EMPTY mounted file is a refusal,
// never a reason to fall back to GITHUB_TOKEN — the same fail-closed rule as
// mountedProviderKey in provider-resolve.mjs.
//
// Debugging hazard, documented because it is real: GIT_TRACE_CURL=1 makes git
// print request headers — including Authorization — to stderr. That is a flag
// an operator sets, not a channel this file opens.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// github.com and its subdomains (api/gist/…), nothing else: `github.com.evil`
// and `evilgithub.com` must not get an answer. A host the helper does not
// recognise gets NO credentials, so git fails closed instead of sending the
// token to a stranger.
const GITHUB_HOST_RE = /(^|\.)github\.com$/i;

const EMPTY_ANSWER = "";

/**
 * The GitHub token, read at call time.
 *
 * Precedence: a mounted secret file (`<LA_SECRETS_DIR>/github_token`, or
 * /run/secrets/github_token in the container) is authoritative — a file that
 * exists but is EMPTY refuses outright instead of resurrecting an inherited
 * GITHUB_TOKEN. Only when no secrets dir is configured does the env var count.
 *
 * @returns {{ok: true, token: string, source: "mounted"|"env"} | {ok: false, error: string}}
 */
export function readGithubToken(env = process.env, readFileSyncImpl = readFileSync) {
  const dir = env.LA_SECRETS_DIR || (env.FENIX_IN_CONTAINER === "1" ? "/run/secrets" : null);
  if (dir) {
    let mounted = false;
    try {
      const value = String(readFileSyncImpl(join(dir, "github_token"), "utf8")).trim();
      mounted = true;
      if (value) return { ok: true, token: value, source: "mounted" };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return { ok: false, error: "Cannot read the mounted github_token secret" };
      }
    }
    if (mounted) {
      return { ok: false, error: "the mounted github_token secret is empty (not falling back to GITHUB_TOKEN)" };
    }
  }
  const fromEnv = typeof env.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN.trim() : "";
  if (fromEnv) return { ok: true, token: fromEnv, source: "env" };
  return { ok: false, error: "no GitHub token (mount the github_token secret or set GITHUB_TOKEN)" };
}

/** The credential request git sends: key=value lines, blank-line terminated. */
function parseRequest(request) {
  const fields = new Map();
  for (const line of String(request ?? "").split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return fields;
}

/**
 * The whole helper, as a pure function: a credential request in, the protocol
 * answer out ("" = no answer). `get` only; `store`/`erase` return "" — this
 * helper never persists and never echoes anything it was handed.
 */
export function credentialAnswer({ op = "get", request = "" } = {}, env = process.env, readFileSyncImpl = readFileSync) {
  if (op !== "get") return EMPTY_ANSWER;
  const host = parseRequest(request).get("host") || "";
  if (!GITHUB_HOST_RE.test(host)) return EMPTY_ANSWER;
  const token = readGithubToken(env, readFileSyncImpl);
  if (!token.ok) return EMPTY_ANSWER;
  return `username=x-access-token\npassword=${token.token}\n\n`;
}

// ---------------------------------------------------------------------------
// Main — only when executed directly (git runs this file as the helper).
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const op = process.argv.slice(2).find((a) => /^(get|store|erase)$/.test(a)) || "get";
  const request = readFileSync(0, "utf8");
  process.stdout.write(credentialAnswer({ op, request }));
}
