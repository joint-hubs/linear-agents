#!/usr/bin/env node
/**
 * scripts/key-check.mjs — Live key validation for the Settings key wizard.
 *
 * FOC-778 (slice B). Each check performs a minimal request with the candidate
 * key and classifies the response into `{ ok, reason, details }` — the reason
 * is what the wizard shows the user, so it must be actionable without ever
 * echoing the credential.
 *
 * THE HARD RULE: no function here ever returns, logs or throws a message
 * containing the key. Every reason, warning and detail value passes through
 * scrubSecret() before leaving a check — occurrences of the key itself and of
 * well-known key shapes (sk-ant-…, sk-or-…, ghp_/gho_/ghu_/ghs_/ghr_…,
 * github_pat_…) are replaced with "[redacted]". Network errors name the host
 * only, never headers or the full URL.
 *
 * Zero npm deps, Node 18+ global fetch. Callers may inject `fetchImpl` and
 * (for Linear / GitHub / the OpenRouter key endpoint) `endpoints` so tests can
 * run against a local fake server. The CLI reads the key from stdin — NEVER
 * argv.
 */

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { resolveProvider } from "./provider-resolve.mjs";

const REDACTED = "[redacted]";

/** Well-known secret shapes, scrubbed even when the exact key is not repeated. */
const KEY_SHAPE_RE =
  /(sk-ant-[A-Za-z0-9_-]{10,}|sk-or-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/g;

/**
 * Replace every occurrence of `secret` (and any key-shaped token) with
 * "[redacted]". Uses split/join so regex metacharacters in the secret are
 * matched literally.
 */
export function scrubSecret(text, secret) {
  let out = text == null ? "" : String(text);
  if (secret) out = out.split(secret).join(REDACTED);
  return out.replace(KEY_SHAPE_RE, REDACTED);
}

/** Deep-scrub a value built from network data (details objects, arrays). */
function scrubValue(value, secret) {
  if (typeof value === "string") return scrubSecret(value, secret);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, secret));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, secret);
    return out;
  }
  return value;
}

/** Final gate: scrub reason/warning/details before a result leaves a check. */
function finish(result, secret) {
  const out = { ...result };
  if ("reason" in out) out.reason = scrubSecret(out.reason, secret);
  if ("warning" in out) out.warning = scrubSecret(out.warning, secret);
  if (out.details) out.details = scrubValue(out.details, secret);
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Error code for a network failure; aborts map to TIMEOUT. */
function errorCode(err) {
  const name = err?.name;
  if (name === "AbortError" || name === "TimeoutError") return "TIMEOUT";
  return err?.cause?.code || err?.code || "ERROR";
}

/** fetch with an abort-based timeout; parse the body as JSON when possible. */
async function requestJson(url, options, { fetchImpl, timeoutMs }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...options, signal: ctl.signal });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { res, text, body };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Provider (any Anthropic-compatible endpoint; OpenRouter has key metadata)
// ---------------------------------------------------------------------------

/**
 * Check a provider API key with one POST <baseUrl>/v1/messages (max_tokens 1).
 * OpenRouter base URLs first GET /api/v1/key for label/limit/usage and skip
 * the messages call when no model is given.
 */
export async function checkProviderKey({
  baseUrl,
  authStyle = "token",
  key,
  model,
  fetchImpl = fetch,
  timeoutMs = 15000,
  endpoints = {},
}) {
  if (!key) return finish({ ok: false, reason: "no key provided" }, key);
  const host = hostOf(baseUrl);
  if (!host) return finish({ ok: false, reason: "invalid base URL" }, key);

  const ctx = { fetchImpl, timeoutMs };
  const details = {};

  // OpenRouter: the key-metadata endpoint answers first and pins the details.
  if (host.includes("openrouter.ai")) {
    const keyUrl = endpoints.openrouterKey || "https://openrouter.ai/api/v1/key";
    try {
      const { res, body } = await requestJson(
        keyUrl,
        { method: "GET", headers: { Authorization: `Bearer ${key}` } },
        ctx,
      );
      if (res.status !== 200) {
        return finish({ ok: false, reason: `key rejected (HTTP ${res.status})`, details }, key);
      }
      const data = body?.data || body || {};
      for (const field of ["label", "limit", "usage"]) {
        const v = data[field];
        if (typeof v === "number" || typeof v === "string") details[field] = v;
      }
      if (!model) return finish({ ok: true, reason: "key accepted (HTTP 200)", details }, key);
    } catch (err) {
      return finish(
        { ok: false, reason: `cannot reach ${hostOf(keyUrl)}: ${errorCode(err)}`, details },
        key,
      );
    }
  }

  const url = `${String(baseUrl).replace(/\/+$/, "")}/v1/messages`;
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (authStyle === "apikey") headers["x-api-key"] = key;
  else headers.Authorization = `Bearer ${key}`;
  const payload = { model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };

  try {
    const { res, body } = await requestJson(
      url,
      { method: "POST", headers, body: JSON.stringify(payload) },
      ctx,
    );
    const status = res.status;
    if (status === 200) {
      if (model) details.model = model;
      return finish({ ok: true, reason: "key accepted (HTTP 200)", details }, key);
    }
    let reason = `HTTP ${status}`;
    if (status === 401 || status === 403) reason = `key rejected (HTTP ${status})`;
    else if (status === 404)
      reason = "endpoint or model not found (HTTP 404) — check the base URL and model";
    else if (status === 400) {
      const msg = body?.error?.message;
      if (typeof msg === "string" && msg) reason = `invalid request (HTTP 400): ${msg}`;
    } else if (status === 402) reason = "insufficient credit (HTTP 402)";
    else if (status === 429) reason = "rate limited (HTTP 429) — the key is probably valid";
    return finish({ ok: false, reason, details }, key);
  } catch (err) {
    return finish({ ok: false, reason: `cannot reach ${host}: ${errorCode(err)}`, details }, key);
  }
}

// ---------------------------------------------------------------------------
// Linear (GraphQL; auth matches scripts/linear-client.mjs — raw key, no Bearer)
// ---------------------------------------------------------------------------

const LINEAR_QUERY = `query {
  viewer { id name }
  teams(first: 50) { nodes { key name } }
}`;

/**
 * Check a Linear API key: viewer presence + (optionally) visibility of a team.
 */
export async function checkLinearKey({
  key,
  teamKey,
  fetchImpl = fetch,
  timeoutMs = 15000,
  endpoints = {},
}) {
  if (!key) return finish({ ok: false, reason: "no key provided" }, key);
  const url = endpoints.linear || "https://api.linear.app/graphql";
  const ctx = { fetchImpl, timeoutMs };
  const headers = { "Content-Type": "application/json", Authorization: key };
  try {
    const { res, body } = await requestJson(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ query: LINEAR_QUERY, variables: {} }),
      },
      ctx,
    );
    if (res.status === 401) return finish({ ok: false, reason: "key rejected (HTTP 401)" }, key);
    if (!res.ok) return finish({ ok: false, reason: `HTTP ${res.status}` }, key);
    const errs = body?.errors;
    if (Array.isArray(errs) && errs.length) {
      const msgs =
        errs
          .map((e) => e?.message)
          .filter(Boolean)
          .join("; ") || JSON.stringify(errs[0]);
      return finish({ ok: false, reason: `GraphQL error: ${msgs}` }, key);
    }
    const data = body?.data || {};
    if (!data.viewer) {
      return finish({ ok: false, reason: "key rejected (no viewer in response)" }, key);
    }
    const teams = data.teams?.nodes || [];
    const teamKeys = teams.map((t) => t?.key).filter(Boolean);
    if (teamKey) {
      const found = teamKeys.some((k) => k.toUpperCase() === teamKey.toUpperCase());
      if (!found) {
        return finish(
          {
            ok: false,
            reason: `team ${teamKey} not visible to this key (visible: ${
              teamKeys.join(", ") || "none"
            })`,
          },
          key,
        );
      }
      return finish(
        {
          ok: true,
          reason: "key accepted",
          details: { viewer: data.viewer.name, teams: teamKeys, team: teamKey },
        },
        key,
      );
    }
    return finish(
      {
        ok: true,
        reason: "key accepted",
        details: { viewer: data.viewer.name, teams: teamKeys, team: null },
      },
      key,
    );
  } catch (err) {
    return finish({ ok: false, reason: `cannot reach ${hostOf(url)}: ${errorCode(err)}` }, key);
  }
}

// ---------------------------------------------------------------------------
// GitHub (personal access tokens)
// ---------------------------------------------------------------------------

/**
 * Check a GitHub token against /user and classify classic vs fine-grained
 * from X-OAuth-Scopes / token-expiration headers / the github_pat_ prefix.
 * A classic token without the `repo` scope is accepted but warned about.
 */
export async function checkGithubToken({
  token,
  fetchImpl = fetch,
  timeoutMs = 15000,
  endpoints = {},
}) {
  if (!token) return finish({ ok: false, reason: "no token provided" }, token);
  const url = endpoints.github || "https://api.github.com/user";
  const ctx = { fetchImpl, timeoutMs };
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "fenix",
    Accept: "application/vnd.github+json",
  };
  try {
    const { res, body } = await requestJson(url, { method: "GET", headers }, ctx);
    if (res.status === 401) return finish({ ok: false, reason: "token rejected (HTTP 401)" }, token);
    if (!res.ok) return finish({ ok: false, reason: `HTTP ${res.status}` }, token);
    const scopesHeader = res.headers.get("X-OAuth-Scopes");
    const expiryHeader = res.headers.get("github-authentication-token-expiration");
    let tokenType = "unknown";
    let scopes = [];
    if (scopesHeader !== null) {
      tokenType = "classic";
      scopes = scopesHeader
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (expiryHeader !== null || String(token).startsWith("github_pat_")) {
      tokenType = "fine-grained";
    }
    const result = {
      ok: true,
      reason: "token accepted",
      details: { login: body?.login ?? "", tokenType, scopes },
    };
    if (tokenType === "classic" && !scopes.includes("repo")) {
      result.warning = "token lacks the repo scope — pushes will fail";
    }
    return finish(result, token);
  } catch (err) {
    return finish({ ok: false, reason: `cannot reach ${hostOf(url)}: ${errorCode(err)}` }, token);
  }
}

// ---------------------------------------------------------------------------
// CLI — key comes from stdin (never argv), the rest from flags
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function readStdinKey() {
  return new Promise((resolveRead, rejectRead) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveRead(data.trim()));
    process.stdin.on("error", rejectRead);
  });
}

function usage() {
  console.error("Usage: node scripts/key-check.mjs provider|linear|github [flags]");
  console.error("  The key/token is read from stdin — NEVER pass it on the command line.");
  console.error("  provider: --provider <name> (resolve baseUrl/auth style/model from");
  console.error("            config/models.json + the settings overlay) or explicit");
  console.error("            --base-url <url> --auth-style token|apikey --model <model>");
  console.error("            [--timeout-ms <n>]");
  console.error("  linear:   --team <TEAM_KEY>");
  console.error("  github:   (no extra flags)");
  console.error("  One JSON line { ok, reason, details } on stdout; exit 0 ok, 1 rejected,");
  console.error("  2 usage.");
}

/**
 * Resolve the provider check parameters: explicit flags win, otherwise the
 * named provider resolves via provider-resolve (config/models.json + the
 * settings overlay) and the model defaults to the cheapest tier (haiku or
 * smallFast), falling back to the provider's defaultModel.
 */
function resolveProviderFlags(flags) {
  let baseUrl = flags["base-url"];
  let authStyle = flags["auth-style"] === "apikey" ? "apikey" : "token";
  let model = flags.model || undefined;
  if (!flags.provider) {
    return { baseUrl, authStyle, model };
  }
  const resolved = resolveProvider(String(flags.provider));
  baseUrl = flags["base-url"] || resolved.baseUrl;
  if (flags["auth-style"] === "apikey" || flags["auth-style"] === "token") {
    authStyle = flags["auth-style"];
  } else {
    authStyle = resolved.authStyle || "token";
  }
  model =
    flags.model || resolved.tiers?.haiku || resolved.tiers?.smallFast || resolved.defaultModel || undefined;
  return { baseUrl, authStyle, model };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const key = await readStdinKey();
  let result;
  if (cmd === "provider") {
    if (!flags.provider && !flags["base-url"]) {
      usage();
      process.exit(2);
    }
    let params;
    try {
      params = resolveProviderFlags(flags);
    } catch (err) {
      console.log(JSON.stringify({ ok: false, reason: scrubSecret(err?.message || String(err), key) }));
      process.exit(1);
    }
    result = await checkProviderKey({
      baseUrl: params.baseUrl,
      authStyle: params.authStyle,
      key,
      model: params.model,
      timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined,
    });
  } else if (cmd === "linear") {
    result = await checkLinearKey({ key, teamKey: flags.team });
  } else if (cmd === "github") {
    result = await checkGithubToken({ token: key });
  } else {
    usage();
    process.exit(2);
  }
  // One JSON line — the shell wizard parses the reason out of it with sed.
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}

// Guard: only run main() when called directly (not when imported as module)
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolvePath(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(e?.message || String(e));
    process.exit(1);
  });
}
