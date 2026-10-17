// scripts/artifact-registry.test.mjs — FOC-779: the artifact registry contract.
// Pins: registry validation, the content-based source digest (touch ≠ change,
// a fresh copy digests identically), the status vocabulary
// (missing/stale/fresh/external + the delegated codegraph verdict), refresh
// (fake generator, dry-run, one failure never blocks the others, --only,
// in-container skip), the real gen-model-map.mjs end-to-end in a temp git
// repo, and the CLI exit codes through spawn.
//
// Everything runs against mkdtemp git fixtures (git init + one local commit)
// — never the real repo tree, never the network, never the live manifest.
//
// Run: node scripts/artifact-registry.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  artifactStatus,
  artifactStatuses,
  currentHead,
  manifestPath,
  readManifest,
  readRegistry,
  refreshArtifacts,
  refreshArtifactsViaCli,
  sourceDigest,
} from "./artifact-registry.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const GEN_MODEL_MAP = join(SCRIPTS_DIR, "gen-model-map.mjs");

// A minimal config/models.json the real gen-model-map.mjs accepts: one routing
// area + one id is enough for it to emit two deterministic lines.
const MODELS_JSON = JSON.stringify(
  { ids: { testmodel: "vendor/test-model" }, routing: { plan: { discovery: "testmodel" } } },
  null,
  2,
);

function tempDir(prefix = "foc-779-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

// A temp git repo with one commit — the minimum currentHead() needs — plus a
// config/models.json and a test registry with one managed entry over it.
function makeTempRepo({ registry } = {}) {
  const root = tempDir("foc-779-git-");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "models.json"), MODELS_JSON, "utf8");
  writeRegistry(root, registry);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["-C", root, "config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["-C", root, "add", "-A"], { cwd: root });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], { cwd: root });
  return root;
}

function writeRegistry(root, registry) {
  const entries = registry ?? [
    {
      id: "alpha",
      title: "Test artifact",
      output: "config/out.map",
      sources: ["config/models.json"],
      generator: { cmd: ["node", "gen-fixture.mjs"] },
      refresh: "watch",
      committed: false,
      inContainer: true,
      notes: "test entry",
    },
  ];
  writeFileSync(join(root, "config", "artifacts.json"), JSON.stringify({ version: 1, artifacts: entries }, null, 2));
}

// The fake generator the unit tests point entry "alpha" at: copies the source
// into the output — deterministic bytes, no network, nothing outside root.
function writeFakeGenerator(root) {
  writeFileSync(
    join(root, "gen-fixture.mjs"),
    [
      'import { copyFileSync } from "node:fs";',
      'copyFileSync("config/models.json", "config/out.map");',
      'console.log("fake generator ran");',
    ].join("\n"),
    "utf8",
  );
}

function manifestFile(dir) {
  return join(dir, "artifacts-manifest.json");
}

test("readRegistry: the committed config/artifacts.json is valid and has the six entries", () => {
  const repoRoot = join(SCRIPTS_DIR, "..");
  const { artifacts } = readRegistry({ root: repoRoot });
  const ids = artifacts.map((a) => a.id);
  assert.deepEqual(ids, [
    "models-map",
    "ui-dist",
    "atlas-mcp",
    "diagrams-png",
    "codegraph-index",
    "analysis-cache",
  ]);
  const modelsMap = artifacts.find((a) => a.id === "models-map");
  assert.equal(modelsMap.output, "config/models.map");
  assert.equal(modelsMap.refresh, "watch");
  assert.equal(modelsMap.committed, false);
  assert.deepEqual(modelsMap.generator.cmd, ["node", "scripts/gen-model-map.mjs"]);
  const ui = artifacts.find((a) => a.id === "ui-dist");
  assert.equal(ui.inContainer, false); // the image ships ui/dist prebuilt
  const diagrams = artifacts.find((a) => a.id === "diagrams-png");
  assert.equal(diagrams.committed, true); // the documented exception
});

test("readRegistry: an unknown refresh value throws with the path in the message", () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, "config"));
    writeRegistry(root, [
      {
        id: "x",
        title: "X",
        output: "out.bin",
        sources: [],
        generator: null,
        refresh: "sometimes",
        committed: false,
        inContainer: true,
        notes: "bad",
      },
    ]);
    assert.throws(() => readRegistry({ root }), (err) => err.message.includes("refresh") && err.message.includes("artifacts.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readRegistry: duplicate ids and a malformed generator throw", () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, "config"));
    const base = { title: "X", output: "out.bin", sources: [], generator: null, committed: false, inContainer: true, notes: "n" };
    writeRegistry(root, [{ id: "dup", ...base, refresh: "start" }, { id: "dup", ...base, refresh: "watch" }]);
    assert.throws(() => readRegistry({ root }), /duplicate entry id/);
    writeRegistry(root, [{ id: "bad", ...base, refresh: "start", generator: { cmd: [] } }]);
    assert.throws(() => readRegistry({ root }), /generator/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sourceDigest: content-based — touch keeps it, a content change moves it, a fresh copy matches", () => {
  const root = makeTempRepo();
  const entry = { id: "alpha", sources: ["config/models.json"] };
  try {
    const before = sourceDigest(entry, { root }).digest;
    assert.match(before, /^[0-9a-f]{64}$/);

    // touch without content change → same digest
    const path = join(root, "config", "models.json");
    const future = new Date(Date.now() + 90_000);
    utimesSync(path, future, future);
    assert.equal(sourceDigest(entry, { root }).digest, before);

    // content change → different digest
    writeFileSync(path, MODELS_JSON + "\n", "utf8");
    assert.notEqual(sourceDigest(entry, { root }).digest, before);

    // a fresh copy of the same content elsewhere → the ORIGINAL digest again
    const root2 = tempDir();
    try {
      mkdirSync(join(root2, "config"));
      writeFileSync(join(root2, "config", "models.json"), MODELS_JSON, "utf8");
      assert.equal(sourceDigest(entry, { root: root2 }).digest, before);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sourceDigest: missing sources are reported, not thrown; `**` and `*` match recursively", () => {
  const root = makeTempRepo();
  try {
    mkdirSync(join(root, "config", "sub"), { recursive: true });
    writeFileSync(join(root, "config", "sub", "extra.txt"), "e", "utf8");

    const missing = sourceDigest({ id: "m", sources: ["config/nope.json"] }, { root });
    assert.equal(missing.digest, null);
    assert.deepEqual(missing.missingSources, ["config/nope.json"]);

    const globbed = sourceDigest({ id: "g", sources: ["config/**/*.txt"] }, { root });
    assert.match(globbed.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(globbed.missingSources, []);

    const none = sourceDigest({ id: "n", sources: [] }, { root });
    assert.equal(none.digest, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("currentHead: the temp fixture's HEAD sha; null for a non-repo", () => {
  const root = makeTempRepo();
  try {
    const head = currentHead({ root });
    assert.match(head, /^[0-9a-f]{40}$/);
    const bare = tempDir();
    try {
      assert.equal(currentHead({ root: bare }), null);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifestPath: LA_ARTIFACTS_MANIFEST wins over the dataHome default", () => {
  const seam = manifestPath({ LA_ARTIFACTS_MANIFEST: join(tmpdir(), "foc-779-seam", "m.json") });
  assert.equal(seam, resolve(seam)); // normalized to an absolute path
  assert.match(seam, /m\.json$/);
  assert.match(manifestPath({}), /artifacts-manifest\.json$/); // dataHome default resolves too
});

test("artifactStatus: missing → stale-with-no-manifest vs missing-output; fresh after refresh; stale after a source change", () => {
  const root = makeTempRepo();
  writeFakeGenerator(root);
  try {
    const entry = readRegistry({ root }).artifacts[0];

    // nothing on disk, no manifest → missing
    const st0 = artifactStatus(entry, { root, manifest: null, head: currentHead({ root }) });
    assert.equal(st0.state, "missing");
    assert.equal(st0.reason, "output missing");

    // output present, no manifest entry → stale ("never refreshed")
    copyFileSync(join(root, "config", "models.json"), join(root, "config", "out.map"));
    const st1 = artifactStatus(entry, { root, manifest: null, head: currentHead({ root }) });
    assert.equal(st1.state, "stale");
    assert.match(st1.reason, /no manifest entry/);

    // refresh → fresh, with the manifest recording head + digest + generatedAt
    const mp = manifestFile(tempDir());
    const now = Date.now();
    const res = refreshArtifacts({ root, manifestPath: mp, now });
    assert.deepEqual(res.failed, []);
    assert.equal(res.refreshed.length, 1);
    assert.equal(res.refreshed[0].id, "alpha");

    const manifest = readManifest({ manifestPath: mp });
    const manEntry = manifest.artifacts.alpha;
    assert.equal(manEntry.head, currentHead({ root }));
    assert.match(manEntry.digest, /^[0-9a-f]{64}$/);
    assert.equal(manEntry.generatedAt, new Date(now).toISOString());
    assert.equal(manEntry.generator, "node gen-fixture.mjs");

    const st2 = artifactStatus(entry, { root, manifest, head: currentHead({ root }) });
    assert.equal(st2.state, "fresh");
    assert.equal(st2.manifest.digest, st2.digest);

    // a source change flips it stale with the reason
    writeFileSync(join(root, "config", "models.json"), MODELS_JSON.replace("test-model", "other-model"), "utf8");
    const st3 = artifactStatus(entry, { root, manifest, head: currentHead({ root }) });
    assert.equal(st3.state, "stale");
    assert.match(st3.reason, /source digest changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifactStatus: external and launcher entries report exists/age and are never managed", () => {
  const root = makeTempRepo();
  try {
    writeRegistry(root, [
      { id: "ext", title: "E", output: "config", sources: ["config/models.json"], generator: null, refresh: "external", committed: true, inContainer: true, notes: "" },
      { id: "lch", title: "L", output: "config/models.json", sources: ["config/models.json"], generator: null, refresh: "launcher", committed: false, inContainer: true, notes: "" },
      { id: "absent", title: "A", output: "nope/gone.bin", sources: [], generator: null, refresh: "external", committed: false, inContainer: true, notes: "" },
    ]);
    const { artifacts } = readRegistry({ root });
    const head = currentHead({ root });
    const ext = artifactStatus(artifacts[0], { root, manifest: null, head });
    assert.equal(ext.state, "external");
    assert.equal(ext.exists, true);
    assert.ok(Number.isFinite(ext.age));
    const lch = artifactStatus(artifacts[1], { root, manifest: null, head });
    assert.equal(lch.state, "external");
    const absent = artifactStatus(artifacts[2], { root, manifest: null, head });
    assert.equal(absent.state, "external");
    assert.equal(absent.exists, false);
    assert.equal(absent.age, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifactStatus: the codegraph entry delegates its verdict to code-intel status (UNKNOWN in a bare temp repo)", () => {
  const root = makeTempRepo();
  try {
    writeRegistry(root, [
      { id: "codegraph-index", title: "C", output: ".codegraph", sources: [], generator: null, refresh: "external", committed: false, inContainer: true, notes: "" },
    ]);
    const entry = readRegistry({ root }).artifacts[0];
    const st = artifactStatus(entry, { root, manifest: null, head: currentHead({ root }) });
    assert.equal(st.state, "external");
    // No .codegraph in the fixture → the wrapper refuses (exit 3, UNKNOWN):
    // a missing index is never reported as fresh.
    assert.equal(st.verdict, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshArtifacts: a failing generator lands in `failed` and the other entry is still refreshed", () => {
  const root = makeTempRepo();
  try {
    // "bad" fails on purpose; "good" writes its output.
    writeRegistry(root, [
      { id: "bad", title: "B", output: "config/bad.out", sources: ["config/models.json"], generator: { cmd: ["node", "-e", "process.exit(3)"] }, refresh: "start", committed: false, inContainer: true, notes: "" },
      { id: "good", title: "G", output: "config/good.out", sources: ["config/models.json"], generator: { cmd: ["node", "-e", "require('fs').writeFileSync('config/good.out','ok')"] }, refresh: "start", committed: false, inContainer: true, notes: "" },
    ]);
    const mp = manifestFile(tempDir());
    const res = refreshArtifacts({ root, manifestPath: mp });
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].id, "bad");
    assert.match(res.failed[0].error, /exit 3/);
    assert.deepEqual(res.refreshed.map((r) => r.id), ["good"]);
    assert.ok(existsSync(join(root, "config", "good.out")));
    assert.ok(!existsSync(join(root, "config", "bad.out")));
    // The failed entry got no manifest record, the refreshed one did.
    const manifest = readManifest({ manifestPath: mp });
    assert.ok(manifest.artifacts.good);
    assert.ok(!manifest.artifacts.bad);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshArtifacts: dry-run writes nothing; fresh entries are skipped; --only narrows; not-in-container skips", () => {
  const root = makeTempRepo();
  writeFakeGenerator(root);
  try {
    // dry-run: a stale entry is listed but neither output nor manifest appears
    copyFileSync(join(root, "config", "models.json"), join(root, "config", "out.map"));
    const mp = manifestFile(tempDir());
    const res = refreshArtifacts({ root, manifestPath: mp, dryRun: true });
    assert.deepEqual(res.refreshed, []);
    assert.equal(res.skipped[0].id, "alpha");
    assert.match(res.skipped[0].reason, /dry-run/);
    assert.ok(!existsSync(mp));

    // fresh: refresh twice — the second pass skips the entry as fresh
    refreshArtifacts({ root, manifestPath: mp });
    const second = refreshArtifacts({ root, manifestPath: mp });
    assert.deepEqual(second.refreshed, []);
    assert.deepEqual(second.skipped, [{ id: "alpha", reason: "fresh" }]);

    // --only narrows to one entry; the other is skipped as not selected
    writeRegistry(root, [
      { id: "one", title: "1", output: "config/one.out", sources: ["config/models.json"], generator: { cmd: ["node", "-e", "require('fs').writeFileSync('config/one.out','1')"] }, refresh: "watch", committed: false, inContainer: true, notes: "" },
      { id: "two", title: "2", output: "config/two.out", sources: ["config/models.json"], generator: { cmd: ["node", "-e", "require('fs').writeFileSync('config/two.out','2')"] }, refresh: "start", committed: false, inContainer: true, notes: "" },
    ]);
    const mp2 = manifestFile(tempDir());
    const onlyOne = refreshArtifacts({ root, manifestPath: mp2, only: "one" });
    assert.deepEqual(onlyOne.refreshed.map((r) => r.id), ["one"]);
    assert.deepEqual(onlyOne.skipped.map((s) => s.id), ["two"]);
    assert.ok(existsSync(join(root, "config", "one.out")));
    assert.ok(!existsSync(join(root, "config", "two.out")));

    // inContainer:true + entry.inContainer:false → skipped "not-in-container"
    writeRegistry(root, [
      { id: "hostonly", title: "H", output: "config/h.out", sources: ["config/models.json"], generator: { cmd: ["node", "-e", "require('fs').writeFileSync('config/h.out','h')"] }, refresh: "watch", committed: false, inContainer: false, notes: "" },
    ]);
    const mp3 = manifestFile(tempDir());
    const inContainer = refreshArtifacts({ root, manifestPath: mp3, inContainer: true });
    assert.deepEqual(inContainer.refreshed, []);
    assert.deepEqual(inContainer.skipped, [{ id: "hostonly", reason: "not-in-container" }]);
    assert.ok(!existsSync(join(root, "config", "h.out")));
    // ...and the same entry refreshes fine without the flag
    const onHost = refreshArtifacts({ root, manifestPath: mp3 });
    assert.deepEqual(onHost.refreshed.map((r) => r.id), ["hostonly"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshArtifacts: launcher and external entries are never run", () => {
  const root = makeTempRepo();
  try {
    writeRegistry(root, [
      { id: "ext", title: "E", output: "config/x.out", sources: ["config/models.json"], generator: { cmd: ["node", "-e", "require('fs').writeFileSync('config/x.out','x')"] }, refresh: "external", committed: true, inContainer: true, notes: "" },
      { id: "lch", title: "L", output: "config/y.out", sources: ["config/models.json"], generator: null, refresh: "launcher", committed: false, inContainer: true, notes: "" },
    ]);
    const mp = manifestFile(tempDir());
    const res = refreshArtifacts({ root, manifestPath: mp });
    assert.deepEqual(res.refreshed, []);
    assert.equal(res.skipped.every((s) => /not managed here/.test(s.reason)), true);
    assert.ok(!existsSync(mp));
    assert.ok(!existsSync(join(root, "config", "x.out")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end: the real gen-model-map.mjs generates models.map; edit → stale → refresh → fresh", () => {
  const root = makeTempRepo();
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(GEN_MODEL_MAP, join(root, "scripts", "gen-model-map.mjs"));
    writeRegistry(root, [
      { id: "models-map", title: "Model routing map", output: "config/models.map", sources: ["config/models.json"], generator: { cmd: ["node", "scripts/gen-model-map.mjs"] }, refresh: "watch", committed: false, inContainer: true, notes: "" },
    ]);
    const mp = manifestFile(tempDir());

    // first refresh (missing → generated), then status fresh for every watch entry
    const first = refreshArtifacts({ root, manifestPath: mp });
    assert.deepEqual(first.failed, []);
    const mapText = readFileSync(join(root, "config", "models.map"), "utf8");
    assert.match(mapText, /^plan\.discovery=vendor\/test-model$/m);

    const { artifacts } = readRegistry({ root });
    let manifest = readManifest({ manifestPath: mp });
    let st = artifactStatus(artifacts[0], { root, manifest, head: currentHead({ root }) });
    assert.equal(st.state, "fresh");

    // edit the source → stale with the reason
    writeFileSync(
      join(root, "config", "models.json"),
      MODELS_JSON.replace("vendor/test-model", "vendor/other-model"),
      "utf8",
    );
    st = artifactStatus(artifacts[0], { root, manifest, head: currentHead({ root }) });
    assert.equal(st.state, "stale");
    assert.match(st.reason, /source digest changed/);

    // refresh again → fresh, and the map carries the new content
    const second = refreshArtifacts({ root, manifestPath: mp });
    assert.deepEqual(second.failed, []);
    assert.deepEqual(second.refreshed.map((r) => r.id), ["models-map"]);
    assert.match(readFileSync(join(root, "config", "models.map"), "utf8"), /vendor\/other-model/);
    manifest = readManifest({ manifestPath: mp });
    st = artifactStatus(artifacts[0], { root, manifest, head: currentHead({ root }) });
    assert.equal(st.state, "fresh");

    // artifactStatuses agrees, one shared manifest/head read for all entries
    const all = artifactStatuses({ root, manifestPath: mp });
    assert.deepEqual(
      all.artifacts.map((a) => a.state),
      ["fresh"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── CLI through spawn ────────────────────────────────────────────────────────

const CLI = join(SCRIPTS_DIR, "artifact-registry.mjs");

function runCli(args, { root, manifest, expectError = false } = {}) {
  const env = { ...process.env };
  if (manifest) env.LA_ARTIFACTS_MANIFEST = manifest;
  else delete env.LA_ARTIFACTS_MANIFEST;
  const res = execFileSync(process.execPath, [CLI, ...args, "--root", root], {
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  return res;
}

function runCliExpectExit(args, code, { root, manifest } = {}) {
  const env = { ...process.env };
  if (manifest) env.LA_ARTIFACTS_MANIFEST = manifest;
  else delete env.LA_ARTIFACTS_MANIFEST;
  try {
    const out = execFileSync(process.execPath, [CLI, ...args, "--root", root], { env, encoding: "utf8", windowsHide: true });
    // execFileSync throws on non-zero exit; reaching here means exit 0.
    assert.equal(code, 0, `expected exit ${code}, got 0 with stdout: ${out}`);
    return { code: 0, stdout: out, stderr: "" };
  } catch (err) {
    assert.equal(err.status, code, `expected exit ${code}, got ${err.status}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`);
    return { code: err.status, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

test("CLI: status --json parses; status prints the human table; unknown command exits 2", () => {
  const root = makeTempRepo();
  const mp = manifestFile(tempDir());
  try {
    const out = runCli(["status", "--json"], { root, manifest: mp });
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.artifacts.map((a) => a.id), ["alpha"]);
    assert.equal(parsed.artifacts[0].state, "missing");

    const table = runCli(["status"], { root, manifest: mp });
    assert.match(table, /^id\s+state\s+age\s+head\s+digest\s+reason/m);
    assert.match(table, /alpha\s+missing\s/);

    runCliExpectExit(["nonsense"], 2, { root });
    runCliExpectExit([], 2, { root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: refresh exits 0 when everything refreshes, 1 when a generator fails, honors --only and --dry-run", () => {
  const root = makeTempRepo();
  writeFakeGenerator(root);
  try {
    const mp = manifestFile(tempDir());
    const ok = runCliExpectExit(["refresh"], 0, { root, manifest: mp });
    assert.match(ok.stdout, /refreshed alpha/);
    assert.match(ok.stdout, /1 refreshed, 0 skipped, 0 failed/);

    // dry-run on a fresh entry: nothing done, exit 0
    runCliExpectExit(["refresh", "--dry-run"], 0, { root, manifest: mp });
    assert.equal(readManifest({ manifestPath: mp }).artifacts.alpha.digest, sourceDigest(readRegistry({ root }).artifacts[0], { root }).digest);

    // --only an unselected id refreshes nothing
    const only = runCli(["refresh", "--only", "alpha"], { root, manifest: mp });
    assert.match(only, /skipped alpha \(fresh\)/);

    // a failing generator → exit 1
    writeRegistry(root, [
      { id: "boom", title: "B", output: "config/boom.out", sources: ["config/models.json"], generator: { cmd: ["node", "-e", "process.exit(5)"] }, refresh: "start", committed: false, inContainer: true, notes: "" },
    ]);
    const fail = runCliExpectExit(["refresh"], 1, { root, manifest: mp });
    assert.match(fail.stderr, /failed boom/);

    // --in-container skips an inContainer:false entry, exit 0
    writeRegistry(root, [
      { id: "hostonly", title: "H", output: "config/h.out", sources: ["config/models.json"], generator: { cmd: ["node", "-e", "require('fs').writeFileSync('config/h.out','h')"] }, refresh: "watch", committed: false, inContainer: false, notes: "" },
    ]);
    const container = runCliExpectExit(["refresh", "--in-container"], 0, { root, manifest: mp });
    assert.match(container.stdout, /skipped hostonly \(not-in-container\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the win32 cmd.exe launcher path ──────────────────────────────────────────

// On win32 npm/npx are .cmd shims that Node refuses to spawn without a shell
// (CVE-2024-27980 mitigation → EINVAL). The registry's own ui-dist entry runs
// `npm --prefix ui run build`, so this is the regression test for the live
// acceptance-server failure. Non-win32: skipped with a note — the direct
// spawn there never had the problem.

test("refreshArtifacts (win32 only, non-win32 has no .cmd problem): an npm generator succeeds through the cmd.exe launcher", (t) => {
  if (process.platform !== "win32") {
    t.skip("npm/npx are not .cmd shims on this platform — the direct spawn path covers them");
    return;
  }
  const root = makeTempRepo();
  try {
    // output = the source file itself: npm --version succeeds but writes
    // nothing, and refreshArtifacts requires the output to exist afterwards.
    writeRegistry(root, [
      {
        id: "npmversion",
        title: "npm via the launcher",
        output: "config/models.json",
        sources: ["config/models.json"],
        generator: { cmd: ["npm", "--version"] },
        refresh: "start",
        committed: false,
        inContainer: true,
        notes: "",
      },
    ]);
    const mp = manifestFile(tempDir());
    const res = refreshArtifacts({ root, manifestPath: mp });
    assert.deepEqual(res.failed, [], "no EINVAL, no ENOENT — npm ran");
    assert.deepEqual(res.refreshed.map((r) => r.id), ["npmversion"]);
    const manifest = readManifest({ manifestPath: mp });
    assert.equal(manifest.artifacts.npmversion.generator, "npm --version");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unmangled arguments: a generator argument with a space, parentheses and quotes survives verbatim (both platforms)", () => {
  const root = makeTempRepo();
  const WEIRD = 'say "hi" (now, please)';
  try {
    // -e script: argv[1] is the first argument after the script — write it to
    // the output file so the exact bytes can be asserted after the refresh.
    writeRegistry(root, [
      {
        id: "argcheck",
        title: "Argument survives",
        output: "config/arg.out",
        sources: ["config/models.json"],
        generator: {
          cmd: ["node", "-e", "require('fs').writeFileSync('config/arg.out', process.argv[1])", WEIRD],
        },
        refresh: "watch",
        committed: false,
        inContainer: true,
        notes: "",
      },
    ]);
    const mp = manifestFile(tempDir());
    const res = refreshArtifacts({ root, manifestPath: mp });
    assert.deepEqual(res.failed, [], "the argument must not be split, mangled or dropped");
    assert.equal(readFileSync(join(root, "config", "arg.out"), "utf8"), WEIRD);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the server-side refresh (async child) ────────────────────────────────────

// A spawn stub with the EventEmitter shape async spawn produces: captures
// file/argv/opts and emits a scripted child behaviour on a microtask.
function stubSpawn(script) {
  const calls = [];
  const spawnImpl = (file, argv, opts) => {
    calls.push({ file, argv, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (script.error) {
        child.emit("error", script.error);
        return;
      }
      if (script.stdout !== undefined) child.stdout.emit("data", script.stdout);
      if (script.stderr !== undefined) child.stderr.emit("data", script.stderr);
      child.emit("close", script.code ?? 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

test("refreshArtifactsViaCli: spawns this registry as a child (argv/env via the injectable spawnImpl) and resolves the parsed --json result", async () => {
  const RESULT = {
    refreshed: [{ id: "alpha", digest: "c".repeat(64), generatedAt: "x" }],
    skipped: [],
    failed: [],
    manifestPath: "M:/state/artifacts-manifest.json",
    head: null,
  };
  const out = JSON.stringify(RESULT, null, 2) + "\n";
  const { spawnImpl, calls } = stubSpawn({ stdout: out });
  const res = await refreshArtifactsViaCli({
    root: "R:/repo",
    manifestPath: "M:/state/artifacts-manifest.json",
    only: "alpha",
    spawnImpl,
  });
  assert.deepEqual(res, RESULT, "the child's --json document is the resolved value");
  assert.equal(calls.length, 1);
  const { file, argv, opts } = calls[0];
  assert.equal(file, process.execPath);
  assert.match(argv[0], /artifact-registry\.mjs$/, "the child is the registry script itself");
  assert.deepEqual(argv.slice(1), ["refresh", "--only", "alpha", "--root", "R:/repo", "--json"]);
  assert.equal(opts.cwd, "R:/repo");
  assert.equal(opts.env.LA_ARTIFACTS_MANIFEST, "M:/state/artifacts-manifest.json", "the manifest seam travels in the child env");
});

test("refreshArtifactsViaCli: --in-container is forwarded; a spawn failure and an unparseable stdout reject", async () => {
  const argvs = [];
  const spawning = (stdoutData) => (file, argv) => {
    argvs.push(argv);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdoutData !== undefined) child.stdout.emit("data", stdoutData);
      child.emit("close", 0);
    });
    return child;
  };

  await refreshArtifactsViaCli({ root: "R", only: "x", inContainer: true, spawnImpl: spawning("{}") });
  assert.ok(argvs[0].includes("--in-container"), "the container flag reaches the child CLI");

  const failingChild = (emit) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(emit ? () => emit(child) : () => child.emit("close", 0));
    return child;
  };

  await assert.rejects(
    refreshArtifactsViaCli({
      root: "R",
      only: "x",
      spawnImpl: failingChild((child) => child.emit("error", Object.assign(new Error("boom"), { code: "ENOENT" }))),
    }),
    /spawn failed.*boom/,
  );
  await assert.rejects(
    refreshArtifactsViaCli({
      root: "R",
      only: "x",
      spawnImpl: failingChild((child) => {
        child.stderr.emit("data", "usage error");
        child.emit("close", 2);
      }),
    }),
    /no parseable result.*exit 2/u,
  );
});

// ── the cross-process lock file (<manifest>.lock) ────────────────────────────

test("refreshArtifacts: a lock held by a live process skips the refresh (locked) and runs no generator", () => {
  const root = makeTempRepo();
  writeFakeGenerator(root);
  const dir = tempDir();
  try {
    const mp = manifestFile(dir);
    const lockPath = `${mp}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ids: ["alpha"] }),
      "utf8",
    );
    const res = refreshArtifacts({ root, manifestPath: mp });
    assert.equal(res.locked, true);
    assert.deepEqual(res.refreshed, []);
    assert.deepEqual(res.failed, []);
    assert.deepEqual(res.skipped, [{ id: "alpha", reason: `locked by pid ${process.pid}` }]);
    assert.ok(!existsSync(join(root, "config", "out.map")), "no generator ran");
    assert.ok(existsSync(lockPath), "a live lock is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshArtifacts: a stale-by-age lock (older than 15 minutes) is replaced and the refresh proceeds", () => {
  const root = makeTempRepo();
  writeFakeGenerator(root);
  const dir = tempDir();
  try {
    const mp = manifestFile(dir);
    const lockPath = `${mp}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 16 * 60_000).toISOString(), ids: ["alpha"] }),
      "utf8",
    );
    const res = refreshArtifacts({ root, manifestPath: mp });
    assert.equal(res.locked, undefined, "a stale lock was taken over, not honoured");
    assert.deepEqual(res.refreshed.map((r) => r.id), ["alpha"]);
    assert.ok(!existsSync(lockPath), "the lock is gone after the call");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshArtifacts: a lock whose pid is dead is replaced and the refresh proceeds", () => {
  const root = makeTempRepo();
  writeFakeGenerator(root);
  const dir = tempDir();
  try {
    const mp = manifestFile(dir);
    const lockPath = `${mp}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), ids: ["alpha"] }),
      "utf8",
    );
    const res = refreshArtifacts({ root, manifestPath: mp, isPidAlive: () => false });
    assert.equal(res.locked, undefined);
    assert.deepEqual(res.refreshed.map((r) => r.id), ["alpha"]);
    assert.ok(!existsSync(lockPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("refreshArtifacts: the lock spans the generator run and is gone after — also when the generator fails", () => {
  const root = makeTempRepo();
  const dir = tempDir();
  try {
    const mp = manifestFile(dir);
    const lockPath = `${mp}.lock`;
    let lockDuringRun = null;
    const res = refreshArtifacts({
      root,
      manifestPath: mp,
      runGenerator: (entry, { root: r }) => {
        lockDuringRun = existsSync(lockPath);
        writeFileSync(join(r, "config", "out.map"), "ok", "utf8");
        return { ok: true };
      },
    });
    assert.deepEqual(res.refreshed.map((r) => r.id), ["alpha"]);
    assert.equal(lockDuringRun, true, "the lock was held while the generator ran");
    assert.ok(!existsSync(lockPath), "and was released in the finally");

    writeRegistry(root, [
      { id: "boom", title: "B", output: "config/boom.out", sources: ["config/models.json"], generator: { cmd: ["node", "-e", "process.exit(5)"] }, refresh: "watch", committed: false, inContainer: true, notes: "" },
    ]);
    const failing = refreshArtifacts({ root, manifestPath: mp });
    assert.equal(failing.failed.length, 1);
    assert.ok(!existsSync(lockPath), "a generator failure also releases the lock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
