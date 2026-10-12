// scripts/fenix-git-identity.mjs — FOC-776: give the container a git identity
// so commits from squads work out of the box.
//
//   node scripts/fenix-git-identity.mjs
//
// Already has user.email → done. No GITHUB_TOKEN → warn and leave it to the
// user. Otherwise derive the identity from the GitHub /user API (noreply
// email, so the real address never lands in a commit log). Any failure —
// HTTP status, network error, timeout — warns and exits 0: this must never
// fail the container start. The token is never printed, in any form.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const defaultRunGit = (args) => spawnSync("git", args, { encoding: "utf8", shell: false });

/**
 * Ensure git config --global user.name/user.email.
 *
 * @param {object} [opts]
 * @param {object}   [opts.env]      - Environment (default process.env).
 * @param {Function} [opts.runGit]   - spawnSync("git", args)-shaped wrapper.
 * @param {Function} [opts.fetchImpl]- fetch-shaped (default global fetch).
 * @returns {Promise<{status: string, name?: string, email?: string}>}
 */
export async function ensureGitIdentity({ env = process.env, runGit = defaultRunGit, fetchImpl = fetch } = {}) {
  const existing = runGit(["config", "--global", "user.email"]);
  if (existing.status === 0 && String(existing.stdout || "").trim()) {
    console.log("git identity: already set");
    return { status: "already-set" };
  }
  const token = env.GITHUB_TOKEN;
  if (!token) {
    console.log("WARN git identity: no GitHub token — set user.name/user.email by hand");
    return { status: "no-token" };
  }
  let json;
  try {
    const res = await fetchImpl("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "fenix",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status !== 200) {
      console.log(`WARN git identity: GitHub /user returned ${res.status} — set user.name/user.email by hand`);
      return { status: "http-error" };
    }
    json = await res.json();
  } catch (err) {
    const code = err?.cause?.code || err?.code || err?.name || "error";
    console.log(`WARN git identity: GitHub /user returned ${code} — set user.name/user.email by hand`);
    return { status: "fetch-error" };
  }
  const name = json.name || json.login;
  const email = `${json.id}+${json.login}@users.noreply.github.com`;
  runGit(["config", "--global", "user.name", name]);
  runGit(["config", "--global", "user.email", email]);
  console.log(`git identity: ${name} ${email}`);
  return { status: "ok", name, email };
}

// ---------------------------------------------------------------------------
// Main — only when executed directly (not when imported for the helper).
// ---------------------------------------------------------------------------
const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await ensureGitIdentity();
}
