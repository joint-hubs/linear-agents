// scripts/publish-exec.mjs — FOC-788, slice S2 (plan §4.2–4.3): the publish
// executors and the audit record behind the dashboard's Push branch / Open PR.
//
// Two executors, both fail-closed and never automatic:
//   pushBranch          exact refspec `git push <remote> <branch>:<branch>`, no
//                       --force, no tags, no --all. Auth via the one-shot
//                       credential helper (git-credential-fenix.mjs) so the
//                       token never lands in argv, env, a URL or .git/config.
//   createPullRequest   POST /repos/{owner}/{repo}/pulls with head=<branch>,
//                       base=main. Never a merge call — the merge endpoint is
//                       not in this file and does not get added to it.
//
// One audit record, three sinks (decision 3), all injectable: an append-only
// JSONL line, a telemetry fact row (the existing store — no second analytics
// store), and a Linear comment on the issue. Sinks never rescue each other and
// never throw out of recordPublishAction — a failed sink is reported in the
// audit result, not lied about.
//
// Egress posture (decided 2026-10-15, plan §4.3/§7): the Linear audit comment
// names the branch it published — Mateusz's call ("tak w komentarzu linear
// podaj tez nazwe galezi"). A managed branch name is long and mixed-class
// (`foc-788-push-pr-from-dashboard-1a2b3c4d5e6f`, 43 chars, 4.2 bits/char) and
// trips egress-screen's high-entropy family as a token shape, so the comment
// ships under egress-screen's managed-ref exemption (FOC-788: spawn-shaped
// `<teamKey>-<n>-<slug>-<hash12>` refs are identifiers, not secrets — see that
// module for the gate and its documented residual). The PR title/body stay
// sha-identified: the PR's `head` field already carries the branch as protocol
// data, and every screened string still passes `assertEgressClean` at use.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULT_BASE, PUBLISH_ACTIONS, PUBLISH_REMOTE, defaultRunGit } from "./publish-actions.mjs";
import { readGithubToken } from "./git-credential-fenix.mjs";
import { assertEgressClean } from "./egress-screen.mjs";
import { scrubSecret } from "./key-check.mjs";
import { makeEvent, emitEvent } from "./telemetry-store.mjs";
import { stateRoot } from "./fenix-paths.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

/** The credential helper, quoted for the `!` shell git runs helpers through. */
const HELPER_SCRIPT = join(__dir, "git-credential-fenix.mjs");

const shQuote = (path) => `"${String(path).replace(/\\/g, "/").replace(/[$"`\\]/g, (m) => `\\${m}`)}"`;

const norm = (out) => String(out ?? "").replace(/\r\n/g, "\n").trimEnd();

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "+1 commit, 12 files, +101/-2" — the one line every sink shows. */
export function diffLine(diff = {}) {
  const commits = plural(diff.commits ?? 0, "commit", "commits");
  const files = plural(diff.files ?? 0, "file", "files");
  return `${commits}, ${files}, +${diff.insertions ?? 0}/-${diff.deletions ?? 0}`;
}

const actorLine = (actor, actorId) => (actorId ? `${actor} (${actorId})` : String(actor ?? ""));

// ── remote shape ─────────────────────────────────────────────────────────────

/**
 * `{owner, repo}` from a remote URL — https (with or without .git) and the ssh
 * form both, since the discovery layer hands us whatever `remote get-url` said.
 * Anything unrecognised → null (never a guess).
 */
export function parseRemoteRepo(url) {
  const raw = String(url ?? "").trim();
  let owner = null;
  let repo = null;
  const https = raw.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  const ssh = raw.match(/^(?:[^@/]+@)?[^:]+:([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) {
    owner = https[1];
    repo = https[2];
  } else if (ssh) {
    owner = ssh[1];
    repo = ssh[2];
  }
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** GitHub.com speaks api.github.com; a GitHub Enterprise host speaks /api/v3. */
export function apiBaseFor(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  } catch {
    return null;
  }
}

const isHttpsRemote = (url) => /^https:\/\//i.test(String(url ?? ""));

// ── pushBranch ───────────────────────────────────────────────────────────────

/**
 * `git push <remote> <branch>:<branch>` — the exact refspec (plan §4.2). No
 * --force, no tags, no --all: divergence is reported as the git error and force
 * is never offered. HTTPS remotes authenticate through the one-shot credential
 * helper; the token is read by the helper itself, so it is not on this
 * process's argv or env either. GIT_TERMINAL_PROMPT=0 — a service must fail
 * with a named reason, never hang on a username prompt.
 *
 * @returns {{ok: true, refspec, remote, head, output} | {ok: false, error: "push-refused", detail}}
 */
export function pushBranch({ checkout, runGit = defaultRunGit, env = process.env, helperScript = HELPER_SCRIPT } = {}) {
  const branch = checkout?.branch;
  const worktree = checkout?.worktree;
  const remote = checkout?.remote || PUBLISH_REMOTE;
  if (!branch || !worktree) {
    return { ok: false, error: "push-refused", detail: "checkout without a branch or worktree" };
  }
  const refspec = `${branch}:${branch}`;
  const args = [];
  let token = null;

  if (isHttpsRemote(checkout.remoteUrl)) {
    // Plain http would put the token on the wire in the clear — refuse rather
    // than authenticate over it.
    if (!String(checkout.remoteUrl).toLowerCase().startsWith("https://")) {
      return { ok: false, error: "push-refused", detail: "refusing to authenticate over plain http (use https or ssh)" };
    }
    token = readGithubToken(env);
    if (!token.ok) return { ok: false, error: "push-refused", detail: token.error };
    args.push("-c", "credential.helper=", "-c", `credential.helper=!node ${shQuote(helperScript)}`);
  }

  args.push("push", remote, refspec);
  try {
    const output = runGit(args, worktree, { GIT_TERMINAL_PROMPT: "0" });
    return { ok: true, refspec, remote, head: checkout.head ?? null, output: norm(output) };
  } catch (error) {
    const raw = `${error?.stderr ?? ""}\n${error?.message ?? String(error)}`;
    return {
      ok: false,
      error: "push-refused",
      detail: scrubSecret(norm(raw) || "git push failed without output", token?.token ?? ""),
    };
  }
}

// ── createPullRequest ────────────────────────────────────────────────────────

/**
 * POST /repos/{owner}/{repo}/pulls with head=<branch>, base=main (decision 1).
 * The generated title and body pass the egress screen BEFORE any network call —
 * a blocked body is a refusal, never a partial post. The token travels only in
 * the Authorization header; every returned field and every error text is
 * scrubbed of it.
 *
 * @returns {Promise<{ok: true, prUrl, number, head, base} | {ok: false, error: "pr-failed", detail}>}
 */
export async function createPullRequest({
  checkout,
  title,
  body,
  fetchImpl = fetch,
  env = process.env,
  timeoutMs = 15000,
} = {}) {
  const base = checkout?.base || DEFAULT_BASE;
  const repo = parseRemoteRepo(checkout?.remoteUrl);
  if (!repo) {
    return { ok: false, error: "pr-failed", detail: "cannot determine owner/repo from the remote URL" };
  }
  const apiBase = apiBaseFor(checkout.remoteUrl);
  if (!apiBase) return { ok: false, error: "pr-failed", detail: "cannot determine the API host from the remote URL" };

  const token = readGithubToken(env);
  if (!token.ok) return { ok: false, error: "pr-failed", detail: token.error };

  try {
    assertEgressClean(`${title}\n\n${body}`, "publish PR title+body");
  } catch (error) {
    return { ok: false, error: "pr-failed", detail: scrubSecret(error?.message || String(error), token.token) };
  }

  const url = `${apiBase}/repos/${repo.owner}/${repo.repo}/pulls`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "fenix-dashboard",
      },
      body: JSON.stringify({ title, head: checkout.branch, base, body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: "pr-failed", detail: scrubSecret(error?.message || String(error), token.token) };
  }

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.status || res.status < 200 || res.status > 299) {
    const detail = `GitHub ${res.status ?? "error"}: ${json?.message || norm(text).slice(0, 300) || "no message"}`;
    return { ok: false, error: "pr-failed", detail: scrubSecret(detail, token.token) };
  }
  return {
    ok: true,
    prUrl: json?.html_url ?? null,
    number: json?.number ?? null,
    head: checkout.branch,
    base,
  };
}

// ── composed text (all screen-safe by construction, screened again at use) ───

/** PR title: the ticket's own title when known, else the published head. */
export function composePrTitle({ ticket, title, head }) {
  const what = typeof title === "string" && title.trim()
    ? title.trim()
    : `publish ${String(head ?? "").slice(0, 7)}`;
  return `${ticket}: ${what}`.slice(0, 240);
}

/** PR body — head sha and counts; the PR page itself shows the branch and commits. */
export function composePrBody({ ticket, head, base, diff, actor, actorId }) {
  return [
    `## Publish — ${ticket}`,
    "",
    `Head \`${head}\` → \`${base}\``,
    "",
    diffLine(diff),
    "",
    `Confirmed by: ${actorLine(actor, actorId)} from the Work dashboard.`,
  ].join("\n");
}

/**
 * The Linear audit comment (plan §4.3): what was published (the diff), the
 * branch and the head sha, who confirmed, the PR URL when there is one. No
 * secrets, no token, no file content. The branch name rides the managed-ref
 * exemption (egress-screen.mjs, FOC-788) and is screened again at every use —
 * a ref that does not fit the managed shape refuses the comment, fail-closed,
 * and the refusal lands in the audit result rather than the issue stream.
 */
export function composeCommentBody(record) {
  const verb = record.action === "pr" ? `Opened a PR to \`${record.base}\`` : `Pushed to \`${record.target}\``;
  const lines = [
    `### Publish · ${record.action} · ${record.ticket}`,
    "",
    `- ${verb}`,
    `- Branch: \`${record.branch}\``,
    `- Head: \`${record.head}\` · base: \`${record.base}\``,
    `- Diff: ${diffLine(record.diff)}`,
    `- Confirmed by: ${actorLine(record.actor, record.actorId)}`,
  ];
  if (record.prUrl) lines.push(`- PR: ${record.prUrl}`);
  return lines.join("\n");
}

// ── the audit record and its three sinks ─────────────────────────────────────

/**
 * The one logical record (plan §4.3). `target` is what the action writes to:
 * the remote for a push, the base branch for a PR.
 */
export function buildPublishRecord({
  ticket,
  action,
  checkout,
  diff,
  actor,
  actorId,
  confirmToken,
  ok,
  error = null,
  prUrl = null,
  ts = new Date().toISOString(),
}) {
  if (!PUBLISH_ACTIONS.includes(action)) throw new Error(`bad-action: ${action}`);
  return {
    ts,
    ticket,
    action,
    branch: checkout.branch,
    head: checkout.head,
    base: checkout.base,
    target: action === "pr" ? checkout.base : checkout.remote || PUBLISH_REMOTE,
    actor,
    actorId,
    confirmToken,
    ok,
    ...(error ? { error } : {}),
    ...(prUrl ? { prUrl } : {}),
    diff,
  };
}

/** Sink 1 — append-only JSONL, the record of plan §4.3.1. */
export function defaultJsonlSink(record, { env = process.env, fileName = "publish-actions.jsonl" } = {}) {
  const path = join(stateRoot(env), fileName);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return { path };
}

/** Sink 2 — one fact row in the existing telemetry store (plan §4.3.2). */
export function defaultTelemetrySink(record) {
  const result = emitEvent(
    makeEvent("publish.action", {
      ticket: record.ticket,
      action: record.action,
      branch: record.branch,
      head: record.head,
      base: record.base,
      target: record.target,
      actor: record.actor,
      actorId: record.actorId,
      ok: record.ok,
      error: record.error ?? null,
      prUrl: record.prUrl ?? null,
      commits: record.diff?.commits ?? 0,
      files: record.diff?.files ?? 0,
    }),
  );
  if (!result?.ingested && !result?.pending) {
    throw new Error(result?.error || "telemetry refused the event");
  }
  return { ingested: !!result.ingested, pending: !!result.pending };
}

/**
 * Sink 3 — the Linear comment (plan §4.3.3), through the existing chokepoint
 * (`linear-ops comment` re-screens and dedups). Success records only: a failed
 * attempt changed nothing on GitHub and belongs in the record, not in the
 * issue's comment stream. The dedup tag makes a retried publish idempotent.
 */
export function defaultCommentSink({ ticket, body, tag }) {
  const dir = mkdtempSync(join(tmpdir(), "publish-comment-"));
  const file = join(dir, "body.md");
  writeFileSync(file, body, "utf8");
  try {
    const result = spawnSync(
      "node",
      [join(__dir, "linear-ops.mjs"), "comment", ticket, "--body-file", file, "--dedup-tag", tag],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exitCode = result.status === null ? 3 : result.status;
    if (exitCode !== 0) {
      throw new Error(norm(result.stderr || result.stdout) || `linear-ops comment exited ${exitCode}`);
    }
    return { exitCode: 0, output: norm(result.stdout).slice(0, 200) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function trySink(fn) {
  try {
    const result = await fn();
    return { ok: true, ...(result && typeof result === "object" ? result : {}) };
  } catch (error) {
    return { ok: false, error: scrubSecret(error?.message || String(error), "") };
  }
}

/**
 * Write the record to all three sinks before the success response returns
 * (plan §4.3). Sinks are independent: one failing never blocks the others and
 * never throws at the caller — the audit result says what landed.
 */
export async function recordPublishAction({
  record,
  jsonlSink = defaultJsonlSink,
  telemetrySink = defaultTelemetrySink,
  commentSink = defaultCommentSink,
  env = process.env,
}) {
  const audit = {
    jsonl: await trySink(() => jsonlSink(record, { env })),
    telemetry: await trySink(() => telemetrySink(record, { env })),
    comment: null,
  };
  if (record.ok) {
    let body;
    try {
      body = composeCommentBody(record);
      assertEgressClean(body, "publish audit comment");
    } catch (error) {
      audit.comment = { ok: false, error: scrubSecret(error?.message || String(error), "") };
      return { audit };
    }
    audit.comment = await trySink(() =>
      commentSink({ ticket: record.ticket, body, tag: `publish-${record.action}-${String(record.head).slice(0, 7)}` }),
    );
  }
  return { audit };
}
