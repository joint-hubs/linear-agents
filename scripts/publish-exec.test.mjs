// scripts/publish-exec.test.mjs — FOC-788, slice S2.
//
// Local fixtures only: a bare "origin" and a clone/worktree under one mkdtemp,
// fake token files under another, a captured git seam and a fake fetch. The
// network is never touched — no real GitHub call, no Linear post, and the
// telemetry store stays out because every sink is injected.
//
// The leak canary is the design under test: the fake token may appear ONLY in
// the credential helper's stdout and the PR request's Authorization header.
// argv, env, logs, errors and the audit record must all be free of it.
//
// Run: node --test scripts/publish-exec.test.mjs

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiBaseFor,
  buildPublishRecord,
  composeCommentBody,
  composePrBody,
  composePrTitle,
  createPullRequest,
  defaultJsonlSink,
  diffLine,
  parseRemoteRepo,
  pushBranch,
  recordPublishAction,
} from "./publish-exec.mjs";
import { credentialAnswer, readGithubToken } from "./git-credential-fenix.mjs";
import { assertEgressClean } from "./egress-screen.mjs";

const CANARY = "ghp_0123456789abcdefghijklmnopqrst";
const git = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).replace(/\r\n/g, "\n").trimEnd();

// ── fixtures ─────────────────────────────────────────────────────────────────

const ROOT = mkdtempSync(join(tmpdir(), "publish-exec-test-"));
const SECRETS = join(ROOT, "secrets");
mkdirSync(SECRETS, { recursive: true });
writeFileSync(join(SECRETS, "github_token"), `${CANARY}\n`);
const SEC_ENV = { LA_SECRETS_DIR: SECRETS };

// origin.git (bare) → clone → la-wt/<dev branch> with one commit on top of main
const SEED = join(ROOT, "seed");
const ORIGIN = join(ROOT, "origin.git");
const CLONE = join(ROOT, "clone");
const WT = join(ROOT, "la-wt");
const DEV_BRANCH = "foc-123-dev-abc123def456";

git(["init", "-b", "main", SEED]);
git(["config", "user.name", "Fixture"], SEED);
git(["config", "user.email", "fixture@example.invalid"], SEED);
writeFileSync(join(SEED, "README.md"), "seed\n");
git(["add", "README.md"], SEED);
git(["commit", "-m", "seed"], SEED);

git(["init", "--bare", ORIGIN]);
git(["symbolic-ref", "HEAD", "refs/heads/main"], ORIGIN);
git(["remote", "add", "origin", ORIGIN], SEED);
git(["push", "origin", "main"], SEED);

git(["clone", ORIGIN, CLONE]);
git(["config", "user.name", "Fixture"], CLONE);
git(["config", "user.email", "fixture@example.invalid"], CLONE);

git(["worktree", "add", "-b", DEV_BRANCH, join(WT, DEV_BRANCH), "main"], CLONE);
writeFileSync(join(WT, DEV_BRANCH, "feature.txt"), "feature\n");
git(["add", "feature.txt"], join(WT, DEV_BRANCH));
git(["commit", "-m", "dev work"], join(WT, DEV_BRANCH));
const DEV_HEAD = git(["rev-parse", "HEAD"], join(WT, DEV_BRANCH));

const localCheckout = {
  branch: DEV_BRANCH,
  worktree: join(WT, DEV_BRANCH),
  remote: "origin",
  remoteUrl: ORIGIN,
  base: "main",
  head: DEV_HEAD,
};
const httpsCheckout = {
  ...localCheckout,
  remoteUrl: "https://github.com/joint-hubs/linear-agents",
};
const DIFF = { commits: 1, files: 2, insertions: 3, deletions: 1, commitSubjects: ["dev work"], dirty: false };

after(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

// ── readGithubToken ──────────────────────────────────────────────────────────

test("readGithubToken: the mounted secret wins, and an empty one refuses instead of resurrecting GITHUB_TOKEN", () => {
  const mounted = readGithubToken({ ...SEC_ENV, GITHUB_TOKEN: "tok-env" });
  assert.equal(mounted.ok, true);
  assert.equal(mounted.token, CANARY);
  assert.equal(mounted.source, "mounted");

  const emptyDir = join(ROOT, "secrets-empty");
  mkdirSync(emptyDir, { recursive: true });
  writeFileSync(join(emptyDir, "github_token"), "  \n");
  const empty = readGithubToken({ LA_SECRETS_DIR: emptyDir, GITHUB_TOKEN: "tok-env" });
  assert.equal(empty.ok, false, "an empty mounted file must not fall back to env");
  assert.ok(!empty.error.includes("tok-env"));

  const envOnly = readGithubToken({ GITHUB_TOKEN: "tok-env" });
  assert.equal(envOnly.ok, true);
  assert.equal(envOnly.token, "tok-env");
  assert.equal(envOnly.source, "env");

  const missing = readGithubToken({ LA_SECRETS_DIR: join(ROOT, "no-such-dir"), GITHUB_TOKEN: "tok-env" });
  assert.equal(missing.ok, true, "no file at all falls back to env (only an empty file refuses)");
  assert.equal(missing.token, "tok-env");

  const none = readGithubToken({});
  assert.equal(none.ok, false);
});

// ── credential helper ────────────────────────────────────────────────────────

test("the helper answers only for a github.com host, only on get, only on stdout", () => {
  const request = "protocol=https\nhost=github.com\n\n";
  const answer = credentialAnswer({ request }, SEC_ENV);
  assert.ok(answer.includes("username=x-access-token"));
  assert.ok(answer.includes(`password=${CANARY}`));

  assert.ok(credentialAnswer({ request: "protocol=https\nhost=api.github.com\n\n" }, SEC_ENV).includes("password="));
  assert.equal(credentialAnswer({ request: "protocol=https\nhost=github.com.evil.example.com\n\n" }, SEC_ENV), "");
  assert.equal(credentialAnswer({ request: "protocol=https\nhost=evilgithub.com\n\n" }, SEC_ENV), "");
  assert.equal(credentialAnswer({ request: "protocol=https\n\n" }, SEC_ENV), "", "no host → no answer");
  assert.equal(credentialAnswer({ op: "store", request }, SEC_ENV), "", "store/erase never persist or echo");
  assert.equal(credentialAnswer({ op: "erase", request }, SEC_ENV), "");
});

test("the real git credential wiring leaks the token nowhere but the protocol", () => {
  // The helper string is the one pushBranch builds — extract it and run it for
  // real: git -c credential.helper= -c 'credential.helper=!node "<path>"'.
  const captured = [];
  const r = pushBranch({
    checkout: httpsCheckout,
    runGit: (args, cwd, env) => {
      captured.push({ args, cwd, env });
      return "";
    },
    env: SEC_ENV,
  });
  assert.equal(r.ok, true);
  const helperArg = captured[0].args.find((a) => a.startsWith("credential.helper=!"));
  const helperPath = helperArg.match(/!node "(.+)"/)[1];

  const fill = spawnSync(
    "git",
    ["-c", "credential.helper=", "-c", `credential.helper=!node "${helperPath}"`, "credential", "fill"],
    {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      env: { ...process.env, ...SEC_ENV, GIT_TERMINAL_PROMPT: "0", GIT_TRACE: "1" },
    },
  );
  assert.equal(fill.status, 0, fill.stderr);
  assert.ok(fill.stdout.includes(`password=${CANARY}`), "the designed channel: the helper's protocol answer");
  assert.ok(!String(fill.stderr).includes(CANARY), "GIT_TRACE must not carry the token");
});

// ── pushBranch ───────────────────────────────────────────────────────────────

test("pushBranch pushes the exact refspec — no force, no tags, no secret in argv or env", () => {
  const captured = [];
  const r = pushBranch({
    checkout: httpsCheckout,
    runGit: (args, cwd, env) => {
      captured.push({ args, cwd, env });
      return "To https://github.com/joint-hubs/linear-agents\n";
    },
    env: SEC_ENV,
  });
  assert.equal(r.ok, true);
  assert.equal(r.refspec, `${DEV_BRANCH}:${DEV_BRANCH}`);

  const { args, cwd, env } = captured[0];
  assert.equal(cwd, httpsCheckout.worktree);
  assert.equal(args.at(-3), "push");
  assert.equal(args.at(-2), "origin");
  assert.equal(args.at(-1), `${DEV_BRANCH}:${DEV_BRANCH}`);
  for (const forbidden of ["--force", "--tags", "--all", "--mirror"]) {
    assert.ok(!args.includes(forbidden), `${forbidden} must never be in a publish push`);
  }
  assert.deepEqual([args[0], args[1]], ["-c", "credential.helper="], "inherited helpers are cleared first");
  const helperArg = args.find((a) => a.startsWith("credential.helper=!"));
  assert.match(helperArg, /^credential\.helper=!node ".+[\\/]git-credential-fenix\.mjs"$/);
  assert.deepEqual(env, { GIT_TERMINAL_PROMPT: "0" }, "a service fails; it never hangs on a prompt");

  const asText = JSON.stringify([args, env]);
  assert.ok(!asText.includes(CANARY), "the token leaked into argv/env");
});

test("pushBranch really pushes to a local bare remote — and refuses to force over divergence", () => {
  // Local path remote → no credentials involved at all (env is empty on purpose).
  const first = pushBranch({ checkout: localCheckout, env: {} });
  assert.equal(first.ok, true);
  assert.equal(git(["ls-remote", "origin", `refs/heads/${DEV_BRANCH}`], join(WT, DEV_BRANCH)).split("\t")[0], DEV_HEAD);

  // Advance origin's branch past our head (a fast-forward from the fixture's
  // side), then try the same push again: non-fast-forward must be refused and
  // the remote ref must be exactly where the divergence left it — the proof
  // that no --force snuck in.
  const tree = git(["rev-parse", `${DEV_HEAD}^{tree}`], CLONE);
  const bump = git(["commit-tree", tree, "-p", DEV_HEAD, "-m", "bump"], CLONE);
  git(["push", "origin", `${bump}:refs/heads/${DEV_BRANCH}`], CLONE);

  const second = pushBranch({ checkout: localCheckout, env: {} });
  assert.equal(second.ok, false);
  assert.equal(second.error, "push-refused");
  assert.ok(second.detail.length > 0);
  assert.equal(
    git(["ls-remote", "origin", `refs/heads/${DEV_BRANCH}`], join(WT, DEV_BRANCH)).split("\t")[0],
    bump,
    "the remote ref must be untouched after a refused push",
  );
});

test("pushBranch refuses before running git when there is no token, and scrubs tokens out of git errors", () => {
  let ran = 0;
  const noToken = pushBranch({
    checkout: httpsCheckout,
    runGit: () => {
      ran += 1;
      return "";
    },
    env: {},
  });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.error, "push-refused");
  assert.match(noToken.detail, /token/i);
  assert.equal(ran, 0, "nothing runs against the network without credentials");

  const throwing = pushBranch({
    checkout: httpsCheckout,
    runGit: () => {
      const error = new Error(`Command failed: git push\nremote: use ${CANARY} instead\n`);
      error.stderr = `fatal: unable to access: could not read Password for 'https://x'\nremote: ${CANARY}\n`;
      throw error;
    },
    env: SEC_ENV,
  });
  assert.equal(throwing.ok, false);
  assert.ok(!throwing.detail.includes(CANARY), "the token survived in the error text");

  const shaped = pushBranch({
    checkout: httpsCheckout,
    runGit: () => {
      const error = new Error("failed");
      error.stderr = "remote: gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
      throw error;
    },
    env: SEC_ENV,
  });
  assert.equal(shaped.ok, false);
  assert.ok(!/gho_AAAA/.test(shaped.detail), "key-shaped runs are scrubbed even when they are not our token");
});

// ── remote shape ─────────────────────────────────────────────────────────────

test("parseRemoteRepo and apiBaseFor read every remote spelling and guess nothing", () => {
  assert.deepEqual(parseRemoteRepo("https://github.com/joint-hubs/linear-agents"), { owner: "joint-hubs", repo: "linear-agents" });
  assert.deepEqual(parseRemoteRepo("https://github.com/joint-hubs/linear-agents.git"), { owner: "joint-hubs", repo: "linear-agents" });
  assert.deepEqual(parseRemoteRepo("git@github.com:joint-hubs/linear-agents.git"), { owner: "joint-hubs", repo: "linear-agents" });
  assert.equal(parseRemoteRepo("https://github.com/joint-hubs/linear-agents/pulls"), null);
  assert.equal(parseRemoteRepo(ORIGIN), null, "a local path is not a GitHub repo");

  assert.equal(apiBaseFor("https://github.com/joint-hubs/linear-agents"), "https://api.github.com");
  assert.equal(apiBaseFor("https://git.example.com/joint-hubs/linear-agents"), "https://git.example.com/api/v3");
  assert.equal(apiBaseFor("not a url"), null);
});

// ── createPullRequest ────────────────────────────────────────────────────────

test("createPullRequest posts exactly the PR shape, and the token only in the Authorization header", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return {
      status: 201,
      text: async () => JSON.stringify({ html_url: "https://github.com/joint-hubs/linear-agents/pull/42", number: 42 }),
    };
  };
  const title = composePrTitle({ ticket: "FOC-123", title: "Human push and open PR", head: DEV_HEAD });
  const body = composePrBody({
    ticket: "FOC-123",
    head: DEV_HEAD,
    base: "main",
    diff: DIFF,
    actor: "human",
    actorId: "mateusz",
  });
  const r = await createPullRequest({ checkout: httpsCheckout, title, body, fetchImpl, env: SEC_ENV });
  assert.equal(r.ok, true);
  assert.equal(r.prUrl, "https://github.com/joint-hubs/linear-agents/pull/42");
  assert.equal(r.number, 42);
  assert.equal(r.head, DEV_BRANCH);
  assert.equal(r.base, "main");
  assert.ok(!JSON.stringify(r).includes(CANARY), "the response we return is token-free");

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.github.com/repos/joint-hubs/linear-agents/pulls");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${CANARY}`, "the designed channel: the API header");
  const sent = JSON.parse(seen[0].init.body);
  assert.equal(sent.title, "FOC-123: Human push and open PR");
  assert.equal(sent.head, DEV_BRANCH);
  assert.equal(sent.base, "main");
  assert.equal(sent.body, body);
  assert.ok(!body.includes(DEV_BRANCH), "screened text names the head sha, never the raw ref");
});

test("createPullRequest fails closed: scrubbed API errors, and an egress hit never reaches the network", async () => {
  const failing = await createPullRequest({
    checkout: httpsCheckout,
    title: "FOC-123: x",
    body: "body",
    fetchImpl: async () => ({
      status: 422,
      text: async () => JSON.stringify({ message: `Validation failed: use ${CANARY}` }),
    }),
    env: SEC_ENV,
  });
  assert.equal(failing.ok, false);
  assert.equal(failing.error, "pr-failed");
  assert.ok(failing.detail.includes("422"));
  assert.ok(!failing.detail.includes(CANARY), "the API error text leaked the token");

  let seen = 0;
  const blocked = await createPullRequest({
    checkout: httpsCheckout,
    title: "FOC-123: x",
    body: "leak sk-or-v1-abcdef0123456789abcdef here",
    fetchImpl: async () => {
      seen += 1;
      return { status: 201, text: async () => "{}" };
    },
    env: SEC_ENV,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "pr-failed");
  assert.match(blocked.detail, /egress|blocked/i);
  assert.equal(seen, 0, "a screened body is a refusal, never a partial post");
});

// ── composed text ────────────────────────────────────────────────────────────

test("the composed comment names the branch under the managed-ref exemption; the PR body stays sha-identified", () => {
  // The realistic spawn shape: a long slug + attempt hash trips the entropy
  // family as a token, so naming it in posted text rides egress-screen's
  // FOC-788 managed-ref exemption (Mateusz, 2026-10-15: "tak w komentarzu
  // linear podaj tez nazwe galezi"). Everything still passes the screen at use.
  const longBranch = "foc-788-push-pr-from-dashboard-1a2b3c4d5e6f";
  const checkout = { ...httpsCheckout, branch: longBranch };
  const record = buildPublishRecord({
    ticket: "FOC-788",
    action: "push",
    checkout,
    diff: DIFF,
    actor: "human",
    actorId: "mateusz",
    confirmToken: "a".repeat(64),
    ok: true,
  });
  const comment = composeCommentBody(record);
  assert.ok(comment.includes(DEV_HEAD));
  assert.ok(comment.includes(longBranch), "the comment names the branch it published");
  assert.ok(comment.includes("1 commit, 2 files, +3/-1"));
  assert.ok(comment.includes("human (mateusz)"));
  assertEgressClean(comment, "test comment body");

  const prBody = composePrBody({
    ticket: "FOC-788",
    head: DEV_HEAD,
    base: "main",
    diff: DIFF,
    actor: "ai",
    actorId: "sup-1234",
  });
  assert.ok(!prBody.includes(longBranch), "the PR body stays sha-identified (the PR's head field carries the ref)");
  assertEgressClean(prBody, "test pr body");

  assert.equal(diffLine({ commits: 1, files: 1, insertions: 1, deletions: 0 }), "1 commit, 1 file, +1/-0");
  assert.equal(diffLine({}), "0 commits, 0 files, +0/-0");
  assert.equal(composePrTitle({ ticket: "FOC-123", head: DEV_HEAD }), `FOC-123: publish ${DEV_HEAD.slice(0, 7)}`);
});

// ── the record and its sinks ─────────────────────────────────────────────────

test("buildPublishRecord carries exactly the plan's fields and refuses an unknown action", () => {
  const record = buildPublishRecord({
    ticket: "FOC-123",
    action: "pr",
    checkout: httpsCheckout,
    diff: DIFF,
    actor: "human",
    actorId: "mateusz",
    confirmToken: "t".repeat(64),
    ok: true,
    prUrl: "https://github.com/joint-hubs/linear-agents/pull/42",
  });
  assert.deepEqual(Object.keys(record), [
    "ts", "ticket", "action", "branch", "head", "base", "target",
    "actor", "actorId", "confirmToken", "ok", "prUrl", "diff",
  ]);
  assert.equal(record.target, "main", "a PR writes to its base branch");
  const pushRecord = buildPublishRecord({
    ticket: "FOC-123",
    action: "push",
    checkout: httpsCheckout,
    diff: DIFF,
    actor: "ai",
    actorId: "sup-1",
    confirmToken: "t".repeat(64),
    ok: false,
    error: "push-refused",
  });
  assert.equal(pushRecord.target, "origin");
  assert.equal(pushRecord.error, "push-refused");
  assert.ok(!("prUrl" in pushRecord));

  assert.throws(() => buildPublishRecord({ action: "merge", checkout: httpsCheckout }), /bad-action/);
});

test("recordPublishAction writes all three sinks, comments only success, and reports a failing sink", async () => {
  const record = buildPublishRecord({
    ticket: "FOC-123",
    action: "push",
    checkout: httpsCheckout,
    diff: DIFF,
    actor: "human",
    actorId: "mateusz",
    confirmToken: "t".repeat(64),
    ok: true,
  });
  const seen = { jsonl: [], telemetry: [], comment: [] };
  const { audit } = await recordPublishAction({
    record,
    jsonlSink: (r) => seen.jsonl.push(r),
    telemetrySink: (r) => seen.telemetry.push(r),
    commentSink: (c) => seen.comment.push(c),
  });
  assert.equal(seen.jsonl.length, 1);
  assert.equal(seen.telemetry.length, 1);
  assert.equal(seen.comment.length, 1);
  assert.equal(seen.comment[0].ticket, "FOC-123");
  assert.equal(seen.comment[0].tag, `publish-push-${DEV_HEAD.slice(0, 7)}`);
  assert.ok(seen.comment[0].body.includes("Pushed to `origin`"));
  assert.ok(audit.jsonl.ok && audit.telemetry.ok && audit.comment.ok);

  const failed = { ...record, ok: false, error: "push-refused" };
  const after2 = await recordPublishAction({
    record: failed,
    jsonlSink: () => ({}),
    telemetrySink: () => ({}),
    commentSink: () => {
      throw new Error("must not be called for a failed action");
    },
  });
  assert.equal(after2.audit.comment, null, "a failed attempt is recorded, not commented");

  const partial = await recordPublishAction({
    record,
    jsonlSink: () => {
      throw new Error("disk full");
    },
    telemetrySink: () => ({ ingested: true }),
    commentSink: () => ({}),
  });
  assert.equal(partial.audit.jsonl.ok, false);
  assert.equal(partial.audit.jsonl.error, "disk full");
  assert.equal(partial.audit.telemetry.ok, true, "sinks never rescue each other — and never block each other");
  assert.equal(partial.audit.comment.ok, true);
});

test("defaultJsonlSink appends one line per record — the record of plan §4.3.1", () => {
  const state = join(ROOT, "state");
  const record = buildPublishRecord({
    ticket: "FOC-123",
    action: "push",
    checkout: httpsCheckout,
    diff: DIFF,
    actor: "human",
    actorId: "mateusz",
    confirmToken: "t".repeat(64),
    ok: true,
  });
  const { path } = defaultJsonlSink(record, { env: { LA_STATE_ROOT: state } });
  defaultJsonlSink({ ...record, ok: false, error: "x" }, { env: { LA_STATE_ROOT: state } });
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 2, "append-only: the second write never rewrites the first");
  assert.equal(JSON.parse(lines[0]).head, DEV_HEAD);
  assert.equal(JSON.parse(lines[1]).ok, false);
  assert.ok(existsSync(path));
});
