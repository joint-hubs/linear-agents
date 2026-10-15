// scripts/fenix-repos.test.mjs — FOC-786 slice D: the repository inventory
// behind Settings → Repositories.
//
// Pins, against real git (local bare repos and file:// URLs only — never the
// network):
//
// - listRepos over a temp GITHUB_ROOT: clean/dirty clones, an extra worktree
//   under `la-wt` (which is skipped by name), a `.codegraph` index marker,
//   a non-git dir skipped, a project mapping per row, and one broken repo
//   (emptied .git/objects — discovery still works, `git status` fails) that
//   becomes an error row instead of throwing for the whole listing.
// - stripCredentials / repoNameFromUrl / validateRepoUrl tables (the same
//   naming the entrypoint's repo-add uses; file:// and absolute local paths
//   only with allowLocal).
// - startClone: success (cloning → done, progress text, project mapped as the
//   ${GITHUB_ROOT}/<name> template), failure (partial dir removed), an
//   existing target refused, and the MAX_CONCURRENT_CLONES ceiling (extra
//   clone refused; a finished job frees the slot) via the spawnGit test seam.
// - unmapRepo: removes every mapping pointing at the repo (template, full
//   path or bare name) and never touches the repo's files.
// - fenix-projects removeProject / removeByRepo / repoRefName / the `remove`
//   CLI, including top-level metadata (_doc/default/platforms/unknown)
//   surviving both remove paths.
//
// Job status is polled with a small async wait loop (50 ms steps, 20 s
// overall deadline) — no fixed sleeps.
//
// Run: node --test scripts/fenix-repos.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dataHome } from "./fenix-paths.mjs";
import {
  MAX_CONCURRENT_CLONES,
  reposRoot,
  stripCredentials,
  repoNameFromUrl,
  validateRepoUrl,
  listRepos,
  getCloneJob,
  listCloneJobs,
  resetCloneJobs,
  startClone,
  unmapRepo,
} from "./fenix-repos.mjs";
import { addProject, listProjects, removeByRepo, removeProject, repoRefName } from "./fenix-projects.mjs";

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- helpers ---------------------------------------------------------------

const GIT_CFG = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

/** `git <args>` in cwd; throws with stderr on failure. */
async function git(cwd, args) {
  return (await execFileP("git", args, { cwd, windowsHide: true, env: process.env })).stdout;
}

async function gitOk(cwd, args) {
  await execFileP("git", args, { cwd, windowsHide: true, env: process.env });
}

/** A bare repo with one empty commit — a clonable, file://-friendly source. */
async function makeSeedBare(scratch, name) {
  const src = path.join(scratch, `${name}-src`);
  await gitOk(scratch, ["init", "-q", "-b", "main", `${name}-src`]);
  await gitOk(src, [...GIT_CFG, "commit", "--allow-empty", "-m", "seed"]);
  const bare = path.join(scratch, `${name}.git`);
  await gitOk(scratch, ["clone", "-q", "--bare", src, bare]);
  return bare;
}

/** rmSync with retries — git objects are written read-only on Windows. */
function rmRf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* a temp dir left behind is not worth failing the suite over */
  }
}

/** Polls `probe()` every `stepMs` until truthy or `timeoutMs` (default 20 s). */
async function waitFor(label, probe, { timeoutMs = 20000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fenix-repos-${label}-`));
}

// --- shared fixtures -------------------------------------------------------

// Built once: one GITHUB_ROOT with two healthy clones (dirty / worktree +
// .codegraph), a non-git dir, a broken clone, and a projects file mapping.
const ROOT = tmpRoot("root");
const SCRATCH = tmpRoot("scratch"); // bare sources live outside GITHUB_ROOT
const PROJECTS_FILE = path.join(SCRATCH, "projects.json");
const ROOTS_TO_CLEAN = [ROOT, SCRATCH];

test("fixtures: build the shared clone inventory", async () => {
  const seed = await makeSeedBare(SCRATCH, "seed");
  const seedUrl = pathToFileURL(seed).href;

  // clone-a: clean clone, then made dirty by an untracked file.
  await gitOk(ROOT, ["clone", "-q", seedUrl, "clone-a"]);
  fs.writeFileSync(path.join(ROOT, "clone-a", "notes.txt"), "dirty\n");

  // clone-b: clean clone with an extra worktree under la-wt + a .codegraph dir.
  await gitOk(ROOT, ["clone", "-q", seedUrl, "clone-b"]);
  await gitOk(path.join(ROOT, "clone-b"), ["worktree", "add", path.join(ROOT, "la-wt", "clone-b-wt")]);
  fs.mkdirSync(path.join(ROOT, "clone-b", ".codegraph"));

  // broken: discovery-grade .git, but the commit object is gone → status fails.
  await gitOk(ROOT, ["clone", "-q", seedUrl, "broken"]);
  rmRf(path.join(ROOT, "broken", ".git", "objects"));
  fs.mkdirSync(path.join(ROOT, "broken", ".git", "objects"));

  // A non-git dir must be skipped; la-wt must be skipped even with a .git in it.
  fs.mkdirSync(path.join(ROOT, "plain-dir"));
  fs.writeFileSync(path.join(ROOT, "plain-dir", "hello.txt"), "not a repo\n");
  fs.mkdirSync(path.join(ROOT, "la-wt", ".git"), { recursive: true });

  // Project mappings in all three ref styles the library claims to match.
  addProject(PROJECTS_FILE, { linearProject: "Proj A", workspace: "joi", repo: "${GITHUB_ROOT}/clone-a", deploy: { type: "none" } });
  addProject(PROJECTS_FILE, { linearProject: "Proj B", workspace: "joi", repo: path.join(ROOT, "clone-b"), deploy: { type: "none" } });

  assert.ok(fs.existsSync(path.join(ROOT, "clone-a", ".git")), "clone-a is a real clone");
});

// --- reposRoot -------------------------------------------------------------

test("reposRoot: GITHUB_ROOT wins, else the data home's workspaces dir", () => {
  const pinned = path.join("x", "ws");
  assert.equal(reposRoot({ GITHUB_ROOT: pinned }), path.resolve(pinned));
  assert.equal(reposRoot({}), path.join(dataHome({}), "workspaces"));
});

// --- stripCredentials ------------------------------------------------------

test("stripCredentials: userinfo removed, everything else untouched", () => {
  assert.equal(stripCredentials("https://user:tok@github.com/x/y"), "https://github.com/x/y");
  assert.equal(stripCredentials("https://tok@github.com/x/y"), "https://github.com/x/y");
  assert.equal(stripCredentials("https://github.com/x/y"), "https://github.com/x/y");
  // scp-like remotes have no userinfo part and are not valid URLs — unchanged.
  assert.equal(stripCredentials("git@github.com:x/y"), "git@github.com:x/y");
  assert.equal(stripCredentials(null), null);
  assert.equal(stripCredentials(""), "", "empty string returned unchanged (only null/undefined → null)");
});

// --- repoNameFromUrl -------------------------------------------------------

test("repoNameFromUrl: last path segment without .git, byte-identical to the entrypoint", () => {
  const table = [
    ["https://github.com/owner/repo", "repo"],
    ["https://github.com/owner/repo.git", "repo"],
    ["https://github.com/owner/repo/", "repo"],
    ["git@github.com:owner/repo.git", "repo"],
    ["owner/repo", "repo"],
    ["file:///data/workspaces/foo", "foo"],
    ["/data/workspaces/foo.git", "foo"],
    ["C:\\data\\workspaces\\foo.git", "foo"],
    ["  https://github.com/owner/repo  ", "repo"],
    ["", null],
    ["   ", null],
    [null, null],
  ];
  for (const [url, expected] of table) {
    assert.equal(repoNameFromUrl(url), expected, `repoNameFromUrl(${JSON.stringify(url)})`);
  }
});

// --- validateRepoUrl -------------------------------------------------------

test("validateRepoUrl: accepted forms (https github, scp-like, shorthand, local with allowLocal)", () => {
  const table = [
    ["https://github.com/owner/repo", "repo", "https://github.com/owner/repo"],
    ["https://github.com/owner/repo.git", "repo", "https://github.com/owner/repo.git"],
    ["https://github.com/owner/repo/", "repo", "https://github.com/owner/repo/"],
    ["git@github.com:owner/repo", "repo", "git@github.com:owner/repo"],
    ["git@github.com:owner/repo.git", "repo", "git@github.com:owner/repo.git"],
  ];
  for (const [url, name, expectedUrl] of table) {
    const res = validateRepoUrl(url);
    assert.equal(res.ok, true, `validateRepoUrl(${url}) is ok`);
    assert.equal(res.name, name, `validateRepoUrl(${url}) name`);
    assert.equal(res.url, expectedUrl, `validateRepoUrl(${url}) url`);
  }

  const short = validateRepoUrl("owner/repo");
  assert.equal(short.ok, true);
  assert.equal(short.url, "https://github.com/owner/repo.git");
  assert.equal(short.name, "repo");

  // Local paths only with allowLocal.
  const fileUrl = pathToFileURL(path.join(SCRATCH, "seed.git")).href;
  const noLocal = validateRepoUrl(fileUrl);
  assert.equal(noLocal.ok, false);
  assert.match(noLocal.reason, /FENIX_REPOS_ALLOW_LOCAL/);

  const withLocal = validateRepoUrl(fileUrl, { allowLocal: true });
  assert.equal(withLocal.ok, true);
  assert.equal(withLocal.url, path.join(SCRATCH, "seed.git"));
  assert.equal(withLocal.name, "seed");

  const absPath = validateRepoUrl(path.join(SCRATCH, "seed.git"), { allowLocal: true });
  assert.equal(absPath.ok, true);
  assert.equal(absPath.name, "seed");

  if (process.platform === "win32") {
    const drive = validateRepoUrl("C:\\tmp\\x\\repo", { allowLocal: true });
    assert.equal(drive.ok, true);
    assert.equal(drive.name, "repo");
    assert.equal(validateRepoUrl("C:\\tmp\\x\\repo").ok, false);
  }
});

test("validateRepoUrl: refused forms", () => {
  const refused = [
    "-owner/repo", // would look like a git flag
    "http://github.com/o/r", // wrong scheme
    "ssh://git@github.com/o/r",
    "git://github.com/o/r",
    "https://gitlab.com/o/r", // wrong host
    "https://user:tok@github.com/o/r", // embedded credentials
    "https://github.com/o/r/extra", // deeper path
    "",
    "   ",
    null,
  ];
  for (const url of refused) {
    const res = validateRepoUrl(url);
    assert.equal(res.ok, false, `expected refusal of ${JSON.stringify(url)}, got ${JSON.stringify(res)}`);
    assert.ok(typeof res.reason === "string" && res.reason.length > 0, `a reason is given for ${JSON.stringify(url)}`);
  }
  assert.match(validateRepoUrl("-x/y").reason, /-/);
  assert.match(validateRepoUrl("https://user:tok@github.com/o/r").reason, /credential/);
});

// --- listRepos -------------------------------------------------------------

test("listRepos: one row per clone, skipped dirs skipped, broken repo is an error row", async () => {
  const rows = await listRepos({ root: ROOT, projectsFile: PROJECTS_FILE });
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

  assert.deepEqual(rows.map((r) => r.name), ["broken", "clone-a", "clone-b"]);
  assert.equal("plain-dir" in byName, false, "non-git dir skipped");
  assert.equal("la-wt" in byName, false, "la-wt skipped by name even with a .git inside");

  const a = byName["clone-a"];
  assert.equal(a.branch, "main");
  assert.match(a.head, /^[0-9a-f]+$/);
  assert.equal(a.dirty, true, "untracked file → dirty");
  assert.equal(a.worktrees, 0);
  assert.equal(a.index, "missing");
  assert.equal(a.project, "Proj A");
  assert.equal(a.origin, pathToFileURL(path.join(SCRATCH, "seed.git")).href, "origin is the file:// URL, credentials already absent");
  assert.equal(a.path, path.join(ROOT, "clone-a"));

  const b = byName["clone-b"];
  assert.equal(b.dirty, false);
  assert.equal(b.worktrees, 1, "extra worktree counted, main excluded");
  assert.equal(b.index, "ready", ".codegraph present");
  assert.equal(b.project, "Proj B", "full-path repo ref matches too");

  const broken = byName["broken"];
  assert.equal(typeof broken.error, "string");
  assert.ok(broken.error.length > 0, "broken repo → error row, not a throw");
  assert.equal(broken.branch, undefined, "error row carries no healthy fields");
});

test("listRepos: projectsFile: null → project null even for a mapped repo", async () => {
  const rows = await listRepos({ root: ROOT, projectsFile: null });
  assert.equal(rows.find((r) => r.name === "clone-a").project, null);
});

// --- startClone ------------------------------------------------------------

test("startClone: local bare repo → cloning → done, progress set, project mapped", async () => {
  resetCloneJobs();
  const root = tmpRoot("clone-ok");
  ROOTS_TO_CLEAN.push(root);
  const projectsFile = path.join(root, "projects.json");
  const bare = await makeSeedBare(SCRATCH, "alpha");
  const srcUrl = pathToFileURL(bare).href;

  const res = startClone({ url: srcUrl, project: "Proj Alpha", root, allowLocal: true, projectsFile });
  assert.ok(res.jobId, `expected a jobId, got ${JSON.stringify(res)}`);
  const job = getCloneJob(res.jobId);
  assert.equal(job.status, "cloning");
  assert.equal(job.name, "alpha");
  assert.equal(job.url, bare, "file:// is normalized to a local path before git sees it");

  await waitFor("clone job done", () => getCloneJob(res.jobId).status !== "cloning");
  assert.equal(job.status, "done");
  assert.equal(job.error, null);
  assert.ok(job.endedAt, "endedAt set");
  assert.equal(typeof job.progress, "string");
  assert.ok(job.progress.length > 0, `progress text set, got ${JSON.stringify(job.progress)}`);

  assert.ok(fs.existsSync(path.join(root, "alpha")), "clone landed in the root");
  assert.deepEqual(listProjects(projectsFile), [
    { linearProject: "Proj Alpha", workspace: "joi", repo: "${GITHUB_ROOT}/alpha", deploy: { type: "none" } },
  ]);
});

test("first clone writes a missing user map instead of the curated fleet config", async () => {
  const root = fs.mkdtempSync(path.join(SCRATCH, "first-user-map-"));
  const seed = await makeSeedBare(root, "first-map-source");
  const repos = path.join(root, "repos"); fs.mkdirSync(repos);
  const userMap = path.join(root, "user-config", "projects.json");
  const curated = path.join(HERE, "..", "config", "projects.json");
  const before = fs.readFileSync(curated, "utf8");
  const old = process.env.LA_PROJECTS_FILE;
  process.env.LA_PROJECTS_FILE = userMap;
  try {
    const res = startClone({url: pathToFileURL(seed).href, project: "First user project", root: repos, allowLocal: true});
    let job;
    const deadline = Date.now() + 20000;
    do { job = getCloneJob(res.jobId); if (job?.status === "done" || job?.status === "error") break; await new Promise(r => setTimeout(r,50)); } while (Date.now() < deadline);
    assert.equal(job?.status, "done", JSON.stringify(job));
    assert.equal(listProjects(userMap)[0]?.linearProject, "First user project");
    assert.equal(fs.readFileSync(curated, "utf8"), before);
    assert.deepEqual(unmapRepo("first-map-source").removed, ["First user project"]);
    assert.equal(fs.readFileSync(curated, "utf8"), before);
  } finally {
    if (old === undefined) delete process.env.LA_PROJECTS_FILE; else process.env.LA_PROJECTS_FILE = old;
  }
});

test("startClone: bad source → status error, no partial dir left", async () => {
  resetCloneJobs();
  const root = tmpRoot("clone-fail");
  ROOTS_TO_CLEAN.push(root);
  const badUrl = pathToFileURL(path.join(SCRATCH, "nope.git")).href;

  const res = startClone({ url: badUrl, root, allowLocal: true });
  assert.ok(res.jobId);
  const job = getCloneJob(res.jobId);
  await waitFor("clone job error", () => getCloneJob(res.jobId).status !== "cloning");
  assert.equal(job.status, "error");
  assert.equal(typeof job.error, "string");
  assert.ok(job.error.length > 0, "stderr tail recorded");
  assert.ok(job.endedAt);
  assert.equal(fs.existsSync(path.join(root, "nope")), false, "partial clone dir removed");
});

test("startClone: existing target refused, invalid URL refused", () => {
  resetCloneJobs();
  const root = tmpRoot("clone-refused");
  ROOTS_TO_CLEAN.push(root);
  // The target dir name comes from the URL (seed.git → "seed") — pre-create it
  // so the existing-dir check fires before any git runs.
  fs.mkdirSync(path.join(root, "seed"));

  const res = startClone({ url: pathToFileURL(path.join(SCRATCH, "seed.git")).href, root, allowLocal: true });
  assert.equal(res.jobId, undefined);
  assert.match(res.error, /already cloned/);
  assert.equal(listCloneJobs().length, 0, "refusal creates no job");

  const bad = startClone({ url: "http://github.com/o/r", root });
  assert.equal(bad.jobId, undefined);
  assert.equal(typeof bad.error, "string");
  assert.equal(listCloneJobs().length, 0);
});

test(`startClone: at most MAX_CONCURRENT_CLONES (${MAX_CONCURRENT_CLONES}) at once, finished job frees a slot`, () => {
  assert.equal(MAX_CONCURRENT_CLONES, 2);
  resetCloneJobs();
  const root = tmpRoot("clone-limit");
  ROOTS_TO_CLEAN.push(root);

  // Fake spawn: jobs never end until the test closes them — no real git runs.
  const closers = [];
  const fakeSpawn = () => ({
    stderr: { on() {} },
    on(event, cb) {
      if (event === "close") closers.push(cb);
    },
  });
  const opts = { root, allowLocal: true, spawnGit: fakeSpawn };
  const url = (n) => pathToFileURL(path.join(SCRATCH, `c${n}.git`)).href;

  const first = startClone({ url: url(1), ...opts });
  const second = startClone({ url: url(2), ...opts });
  assert.ok(first.jobId && second.jobId, "two clones start fine");
  assert.equal(listCloneJobs().filter((j) => j.status === "cloning").length, 2);

  const third = startClone({ url: url(3), ...opts });
  assert.equal(third.jobId, undefined);
  assert.match(third.error, /clone limit reached — at most 2 concurrent clones/);

  closers[0](0); // first job finishes ok → slot freed
  assert.equal(getCloneJob(first.jobId).status, "done");
  const fourth = startClone({ url: url(4), ...opts });
  assert.ok(fourth.jobId, "after a job finishes a new clone is accepted");
});

// --- unmapRepo -------------------------------------------------------------

test("unmapRepo: removes every mapping for the repo (template, path, bare name), files stay", () => {
  const file = path.join(SCRATCH, "unmap-projects.json");
  const entries = [
    { linearProject: "P-template", workspace: "joi", repo: "${GITHUB_ROOT}/alpha", deploy: { type: "none" } },
    { linearProject: "P-path", workspace: "joi", repo: path.join(os.tmpdir(), "some", "alpha.git"), deploy: { type: "none" } },
    { linearProject: "P-bare", workspace: "joi", repo: "alpha", deploy: { type: "none" } },
    { linearProject: "P-other", workspace: "joi", repo: "${GITHUB_ROOT}/beta", deploy: { type: "none" } },
    { linearProject: "P-empty-repo", workspace: "joi", repo: "", deploy: { type: "none" } },
  ];
  for (const e of entries) addProject(file, e);

  // The repo's own files exist and must survive the unmap.
  const repoDir = path.join(SCRATCH, "alpha");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "keep.txt"), "repo files\n");

  const res = unmapRepo("alpha", { projectsFile: file });
  assert.deepEqual(res.removed, ["P-template", "P-path", "P-bare"]);
  assert.deepEqual(
    listProjects(file).map((p) => p.linearProject),
    ["P-other", "P-empty-repo"],
  );
  assert.ok(fs.existsSync(path.join(repoDir, "keep.txt")), "repo dir untouched");
  assert.ok(fs.existsSync(file), "projects file still there");

  // Idempotent: a second unmap removes nothing and rewrites nothing's entries.
  assert.deepEqual(unmapRepo("alpha", { projectsFile: file }).removed, []);
  assert.deepEqual(
    listProjects(file).map((p) => p.linearProject),
    ["P-other", "P-empty-repo"],
  );
});

// --- fenix-projects remove / repoRefName -----------------------------------

test("fenix-projects repoRefName: template, full path or bare name → the repo dir name", () => {
  const table = [
    ["${GITHUB_ROOT}/alpha", "alpha"],
    ["/data/workspaces/alpha.git", "alpha"],
    ["C:\\data\\workspaces\\alpha", "alpha"],
    ["alpha", "alpha"],
    ["", null],
    ["   ", null],
    [null, null],
    [undefined, null],
  ];
  for (const [repo, expected] of table) {
    assert.equal(repoRefName(repo), expected, `repoRefName(${JSON.stringify(repo)})`);
  }
});

test("fenix-projects removeProject: deletes by linearProject (case-sensitive), [] when none matched", () => {
  const file = path.join(SCRATCH, "remove-projects.json");
  addProject(file, { linearProject: "Keep", workspace: "joi", repo: "${GITHUB_ROOT}/a", deploy: { type: "none" } });
  addProject(file, { linearProject: "Drop", workspace: "joi", repo: "${GITHUB_ROOT}/b", deploy: { type: "none" } });

  assert.deepEqual(removeProject(file, "drop"), [], "case-sensitive: no match");
  assert.deepEqual(removeProject(file, "Drop"), ["Drop"]);
  assert.deepEqual(listProjects(file).map((p) => p.linearProject), ["Keep"]);
  assert.deepEqual(removeProject(file, "Drop"), [], "already gone → empty result");
});

test("fenix-projects removeProject / removeByRepo: top-level metadata and unknown entry fields survive", () => {
  const file = path.join(SCRATCH, "remove-metadata-projects.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      _doc: "scratch metadata",
      default: { deploy: { type: "gcp-vm" } },
      platforms: { "lambda-gpu": { status: "deferred" } },
      extra: { bespoke: true },
      projects: [
        { linearProject: "Meta Keep", workspace: "joi", repo: "${GITHUB_ROOT}/a", deploy: { type: "none" }, teamKey: "${TEAM}" },
        { linearProject: "Meta Drop", workspace: "joi", repo: "${GITHUB_ROOT}/b", deploy: { type: "none" } },
      ],
    }),
  );

  removeProject(file, "Meta Drop");
  let data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data._doc, "scratch metadata", "_doc survives removeProject");
  assert.deepEqual(data.default, { deploy: { type: "gcp-vm" } }, "default survives removeProject");
  assert.deepEqual(data.platforms, { "lambda-gpu": { status: "deferred" } }, "platforms survive removeProject");
  assert.deepEqual(data.extra, { bespoke: true }, "unknown top-level fields survive removeProject");
  assert.deepEqual(data.projects.map((p) => p.linearProject), ["Meta Keep"]);
  assert.equal(data.projects[0].teamKey, "${TEAM}", "unknown entry fields survive removeProject");

  removeByRepo(file, "a");
  data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data._doc, "scratch metadata", "_doc survives removeByRepo");
  assert.deepEqual(data.default, { deploy: { type: "gcp-vm" } }, "default survives removeByRepo");
  assert.deepEqual(data.platforms, { "lambda-gpu": { status: "deferred" } }, "platforms survive removeByRepo");
  assert.deepEqual(data.extra, { bespoke: true }, "unknown top-level fields survive removeByRepo");
  assert.deepEqual(data.projects, [], "the last entry is gone");
});

// The subprocess only touches the temp projects file — no network, no repo state.
test("fenix-projects remove CLI: removes the entry, reports none for a miss, usage error without an arg", async () => {
  const file = path.join(SCRATCH, "cli-projects.json");
  const script = path.join(HERE, "fenix-projects.mjs");
  const env = { ...process.env, LA_PROJECTS_FILE: file };
  const run = (args) => execFileP(process.execPath, [script, ...args], { env, encoding: "utf8", windowsHide: true });

  addProject(file, { linearProject: "P1", workspace: "joi", repo: "${GITHUB_ROOT}/a", deploy: { type: "none" } });
  addProject(file, { linearProject: "P2", workspace: "joi", repo: "${GITHUB_ROOT}/b", deploy: { type: "none" } });

  const { stdout } = await run(["remove", "P1"]);
  assert.match(stdout, /projects: removed P1/);
  assert.deepEqual(listProjects(file).map((p) => p.linearProject), ["P2"]);

  const miss = await run(["remove", "Nope"]);
  assert.match(miss.stdout, /projects: no entry for Nope/);
  assert.deepEqual(listProjects(file).map((p) => p.linearProject), ["P2"]);

  await assert.rejects(
    run(["remove"]),
    (err) => err.code === 1 && /usage: node scripts\/fenix-projects\.mjs remove <linear-project>/.test(err.stderr),
    "no argument → usage on stderr, exit 1",
  );
});

// --- cleanup ---------------------------------------------------------------

test("cleanup: temp roots removed", () => {
  for (const dir of ROOTS_TO_CLEAN) rmRf(dir);
  assert.ok(true);
});
