// scripts/tool-profiles.test.mjs — the tool-profile registry contract (P2
// backend slice). Pins: defaults on a missing file, strict schema (unknown
// keys, secrets, URL/credential guards, clusters-path containment), the
// revision CAS, lead/squad scoping, worker-role frontmatter preservation,
// the merged catalog, and the snapshot's two-file no-secret shape.
//
// Run: node --test scripts/tool-profiles.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  emptyToolProfiles,
  getToolCatalog,
  readToolProfiles,
  resolveToolProfile,
  snapshotToolProfile,
  toolProfilesPath,
  writeToolProfiles,
} from "./tool-profiles.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "tool-profiles-"));
}

/** Standard test options: an explicit registry path (never the real data home). */
function opts(dir) {
  return { path: join(dir, "tool-profiles.json") };
}

const VALID_THOUGHTMAP = {
  enabled: true,
  baseUrl: "http://thoughtmap-app:8585",
  ollamaBaseUrl: "http://thoughtmap-ollama:11434",
  embeddingModel: "qwen3-embedding:8b",
  clustersPath: "/fenix-integrations/thoughtmap/clusters.json",
};

// ---------------------------------------------------------------------------
// readToolProfiles — defaults + failure modes
// ---------------------------------------------------------------------------

test("readToolProfiles: missing file → the defaults (disabled, container URLs)", () => {
  const dir = tempDir();
  try {
    assert.deepEqual(readToolProfiles(opts(dir)), {
      version: 1,
      revision: 0,
      mcp: {
        thoughtmap: {
          enabled: false,
          baseUrl: "http://thoughtmap-app:8585",
          ollamaBaseUrl: "http://thoughtmap-ollama:11434",
          embeddingModel: "qwen3-embedding:8b",
          clustersPath: "/fenix-integrations/thoughtmap/clusters.json",
        },
      },
      leadTools: {},
      globalTools: null,
      squadTools: {},
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readToolProfiles: invalid JSON throws with the path in the message", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "tool-profiles.json"), "{ not json", "utf8");
    assert.throws(
      () => readToolProfiles(opts(dir)),
      (err) => err.message.includes("not valid JSON") && err.message.includes(dir),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readToolProfiles: an invalid stored registry throws (never silently ignored)", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "tool-profiles.json"), JSON.stringify({ sneaky: true }), "utf8");
    assert.throws(() => readToolProfiles(opts(dir)), /unknown top-level key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("toolProfilesPath: the env override wins over the data home", () => {
  const seam = join(tempDir(), "custom.json");
  try {
    assert.equal(toolProfilesPath({ LA_TOOL_PROFILES_FILE: seam }), seam);
    assert.ok(toolProfilesPath({}).endsWith(join("settings", "tool-profiles.json")));
  } finally {
    rmSync(seam, { force: true });
  }
});

// ---------------------------------------------------------------------------
// writeToolProfiles — merge, revision, CAS, atomicity
// ---------------------------------------------------------------------------

test("writeToolProfiles: merges into the defaults, bumps the revision, persists", () => {
  const dir = tempDir();
  try {
    const { config, changes } = writeToolProfiles(
      { mcp: { thoughtmap: { enabled: true } }, leadTools: { dev: ["Read"] } },
      opts(dir),
    );
    assert.equal(config.revision, 1);
    assert.equal(config.mcp.thoughtmap.enabled, true);
    assert.deepEqual(config.leadTools.dev, ["Read"]);
    const onDisk = readToolProfiles(opts(dir));
    assert.equal(onDisk.revision, 1);
    assert.equal(onDisk.mcp.thoughtmap.baseUrl, "http://thoughtmap-app:8585");
    assert.ok(changes.some((c) => c.path === "revision" && c.before === 0 && c.after === 1));
    assert.ok(changes.some((c) => c.path === "mcp.thoughtmap.enabled"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeToolProfiles: second write bumps 1→2; dryRun previews without writing", () => {
  const dir = tempDir();
  try {
    writeToolProfiles({ leadTools: { dev: ["Read"] } }, opts(dir));
    const before = readFileSync(join(dir, "tool-profiles.json"), "utf8");
    const preview = writeToolProfiles({ leadTools: { dev: ["Grep"] } }, { ...opts(dir), dryRun: true });
    assert.equal(preview.config.revision, 2);
    assert.equal(readFileSync(join(dir, "tool-profiles.json"), "utf8"), before);
    assert.deepEqual(readdirSync(dir), ["tool-profiles.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeToolProfiles: CAS on revision — a stale writer is refused, a fresh one lands", () => {
  const dir = tempDir();
  try {
    writeToolProfiles({ leadTools: { dev: ["Read"] } }, opts(dir)); // revision 1
    assert.throws(
      () => writeToolProfiles({ leadTools: { dev: ["Grep"] } }, { ...opts(dir), expectedRevision: 0 }),
      /revision conflict/,
    );
    // The refused write changed nothing.
    assert.equal(readToolProfiles(opts(dir)).leadTools.dev[0], "Read");
    writeToolProfiles({ leadTools: { dev: ["Grep"] } }, { ...opts(dir), expectedRevision: 1 });
    assert.deepEqual(readToolProfiles(opts(dir)).leadTools.dev, ["Grep"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeToolProfiles: revision/version cannot be patched directly", () => {
  const dir = tempDir();
  try {
    assert.throws(() => writeToolProfiles({ revision: 99 }, opts(dir)), /managed automatically/);
    assert.throws(() => writeToolProfiles({ version: 2 }, opts(dir)), /managed automatically/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeToolProfiles: atomic write leaves only the registry file behind", () => {
  const dir = tempDir();
  try {
    writeToolProfiles({}, opts(dir));
    assert.deepEqual(readdirSync(dir), ["tool-profiles.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Schema strictness — unknown keys, secrets, URL guards, bounded values
// ---------------------------------------------------------------------------

test("unknown keys are refused at every level", () => {
  const dir = tempDir();
  try {
    assert.throws(() => writeToolProfiles({ sneaky: true }, opts(dir)), /sneaky: unknown top-level key/);
    assert.throws(
      () => writeToolProfiles({ mcp: { thoughtmap: { enabled: true, extra: 1 } } }, opts(dir)),
      /mcp.thoughtmap.extra: unknown key/,
    );
    assert.throws(
      () => writeToolProfiles({ mcp: { otherserver: { enabled: true } } }, opts(dir)),
      /unknown MCP server/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret-shaped values are refused anywhere in the registry", () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => writeToolProfiles({ mcp: { thoughtmap: { baseUrl: "https://sk-or-v1-0123456789abcdef@x" } } }, opts(dir)),
      /must not contain secrets/,
    );
    assert.throws(
      () => writeToolProfiles({ leadTools: { dev: ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ"] } }, opts(dir)),
      /must not contain secrets/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("URL guards: protocol, credentials, query string and the localhost trap", () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => writeToolProfiles({ mcp: { thoughtmap: { baseUrl: "ftp://thoughtmap-app:8585" } } }, opts(dir)),
      /http\(s\)/,
    );
    assert.throws(
      () => writeToolProfiles({ mcp: { thoughtmap: { baseUrl: "http://user:pass@thoughtmap-app:8585" } } }, opts(dir)),
      /must not embed credentials/,
    );
    assert.throws(
      () => writeToolProfiles({ mcp: { thoughtmap: { baseUrl: "http://thoughtmap-app:8585/?key=x" } } }, opts(dir)),
      /query string/,
    );
    // The Fenix trap: localhost inside the container is Fenix itself.
    for (const bad of ["http://localhost:8585", "http://127.0.0.1:8585"]) {
      assert.throws(
        () => writeToolProfiles({ mcp: { thoughtmap: { baseUrl: bad } } }, opts(dir)),
        /must not point at localhost/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clustersPath: the fixed mount is always valid; anything else needs the approved env root", () => {
  const dir = tempDir();
  try {
    // Default mount — valid with no env root at all.
    writeToolProfiles({ mcp: { thoughtmap: { clustersPath: "/fenix-integrations/thoughtmap/clusters.json" } } }, opts(dir));
    // No env root: any other path is refused.
    assert.throws(
      () => writeToolProfiles({ mcp: { thoughtmap: { clustersPath: "C:\\some\\where\\clusters.json" } } }, opts(dir)),
      /FENIX_INTEGRATIONS_ROOT/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clustersPath: with FENIX_INTEGRATIONS_ROOT set, only paths inside it are valid", () => {
  const dir = tempDir();
  const root = tempDir();
  const prev = process.env.FENIX_INTEGRATIONS_ROOT;
  process.env.FENIX_INTEGRATIONS_ROOT = root;
  try {
    writeToolProfiles({ mcp: { thoughtmap: { clustersPath: join(root, "thoughtmap", "clusters.json") } } }, opts(dir));
    assert.throws(
      () => writeToolProfiles({ mcp: { thoughtmap: { clustersPath: join(root, "..", "elsewhere.json") } } }, opts(dir)),
      /must stay inside FENIX_INTEGRATIONS_ROOT/,
    );
    assert.throws(
      () => writeToolProfiles({ mcp: { thoughtmap: { clustersPath: "relative/clusters.json" } } }, opts(dir)),
      /absolute path/,
    );
    assert.throws(
      () => writeToolProfiles({ mcp: { thoughtmap: { clustersPath: join(root, "artifact.txt") } } }, opts(dir)),
      /\.json artifact/,
    );
  } finally {
    if (prev === undefined) delete process.env.FENIX_INTEGRATIONS_ROOT;
    else process.env.FENIX_INTEGRATIONS_ROOT = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("embeddingModel is bounded (charset + 64 chars)", () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => writeToolProfiles({ mcp: { thoughtmap: { embeddingModel: "a".repeat(65) } } }, opts(dir)),
      /embeddingModel/,
    );
    assert.throws(
      () => writeToolProfiles({ mcp: { thoughtmap: { embeddingModel: "bad model; rm -rf" } } }, opts(dir)),
      /embeddingModel/,
    );
    writeToolProfiles({ mcp: { thoughtmap: { embeddingModel: "nomic-embed-text:v1.5" } } }, opts(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// leadTools / roleOverrides — squad scoping, MCP-enable rule
// ---------------------------------------------------------------------------

test("leadTools: squad names validated (regex + real squad set)", () => {
  const dir = tempDir();
  try {
    assert.throws(() => writeToolProfiles({ leadTools: { "Bad Squad": ["Read"] } }, opts(dir)), /squad name/);
    assert.throws(() => writeToolProfiles({ leadTools: { "zzz-unknown": ["Read"] } }, opts(dir)), /not a configured squad/);
    writeToolProfiles({ leadTools: { dev: ["Read"] } }, opts(dir));
    // supervisor (the Supervisor lead) is a real squad and must be editable too.
    writeToolProfiles({ leadTools: { supervisor: null } }, opts(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leadTools: MCP tools require the server enabled in the SAME change", () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => writeToolProfiles({ leadTools: { dev: ["mcp__thoughtmap__search_thoughts"] } }, opts(dir)),
      /requires mcp.thoughtmap.enabled=true/,
    );
    // Enabled + the tool in one patch — accepted.
    writeToolProfiles(
      { mcp: { thoughtmap: { enabled: true } }, leadTools: { dev: ["mcp__thoughtmap__search_thoughts"] } },
      opts(dir),
    );
    // Other MCP servers never register.
    assert.throws(
      () => writeToolProfiles(
        { mcp: { thoughtmap: { enabled: true } }, leadTools: { dev: ["mcp__workspace__search"] } },
        opts(dir),
      ),
      /only thoughtmap/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leadTools/roleOverrides: list shape bounded, empty list and null allowed", () => {
  const dir = tempDir();
  try {
    assert.throws(() => writeToolProfiles({ leadTools: { dev: "Read" } }, opts(dir)), /array of tool names or null/);
    assert.throws(
      () => writeToolProfiles({ leadTools: { dev: Array.from({ length: 65 }, () => "Read") } }, opts(dir)),
      /at most 64/,
    );
    assert.throws(
      () => writeToolProfiles({ leadTools: { dev: ["bad name with space"] } }, opts(dir)),
      /tool names must match/,
    );
    writeToolProfiles({ leadTools: { dev: [] } }, opts(dir)); // explicit none — not an error
    assert.throws(() => writeToolProfiles({ roleOverrides: { dev: { researcher: ["Read", "Grep"] } } }, opts(dir)), /unknown top-level key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveToolProfile — tools null/[]/list, MCP servers, worker frontmatter
// ---------------------------------------------------------------------------

test("resolveToolProfile: disabled server → tools null, no MCP servers", () => {
  const dir = tempDir();
  try {
    const profile = resolveToolProfile({ squad: "dev" }, opts(dir));
    assert.equal(profile.revision, 0);
    assert.equal(profile.tools, null);
    assert.deepEqual(profile.mcpServers, {});
    assert.deepEqual(profile.unavailable, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enabling a server alone never grants tools to a role', () => {
 const dir=tempDir(); try {
  writeToolProfiles({mcp:{thoughtmap:{enabled:true}}},opts(dir));
  assert.deepEqual(resolveToolProfile({squad:'dev'},opts(dir)).mcpServers,{});
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test("resolveToolProfile: explicit [] is none; explicit list without MCP tools excludes the server", () => {
  const dir = tempDir();
  try {
    writeToolProfiles({ mcp: { thoughtmap: { enabled: true } }, leadTools: { dev: [] } }, opts(dir));
    assert.deepEqual(resolveToolProfile({ squad: "dev" }, opts(dir)).mcpServers, {});
    writeToolProfiles({ leadTools: { dev: ["Read", "Grep"] } }, opts(dir));
    const profile = resolveToolProfile({ squad: "dev" }, opts(dir));
    assert.deepEqual(profile.tools, ["Read", "Grep"]);
    assert.deepEqual(profile.mcpServers, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveToolProfile: unknown tool names are preserved but marked unavailable, never granted", () => {
  const dir = tempDir();
  try {
    writeToolProfiles(
      { mcp: { thoughtmap: { enabled: true } }, leadTools: { dev: ["Read", "mcp__thoughtmap__time_travel"] } },
      opts(dir),
    );
    const profile = resolveToolProfile({ squad: "dev" }, opts(dir));
    assert.deepEqual(profile.tools, ["Read", "mcp__thoughtmap__time_travel"]);
    assert.deepEqual(profile.unavailable, ["mcp__thoughtmap__time_travel"]);
    assert.equal(profile.mcpServers.thoughtmap !== undefined, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveToolProfile: worker role reads the authoritative frontmatter; roleOverrides override it", () => {
  const dir = tempDir();
  const agentsHome = tempDir();
  const prev = process.env.LA_SQUAD_HOME;
  process.env.LA_SQUAD_HOME = agentsHome;
  try {
    mkdirSync(join(agentsHome, "dev", "agents"), { recursive: true });
    writeFileSync(
      join(agentsHome, "dev", "agents", "researcher.md"),
      "---\nmodel: z-ai/glm-5.3-flash\ntools: Read, Grep\n---\nbody",
      "utf8",
    );
    // No override → the frontmatter is the truth (never duplicated, never written).
    const native = resolveToolProfile({ squad: "dev", role: "researcher" }, opts(dir));
    assert.deepEqual(native.nativeTools, ["Read", "Grep"]);
    assert.deepEqual(native.tools, ["Read", "Grep"]);
    // An explicit roleOverride wins at launch time; frontmatter untouched.
    writeToolProfiles({ globalTools: ["Read"] }, opts(dir));
    const overridden = resolveToolProfile({ squad: "dev", role: "researcher" }, opts(dir));
    assert.deepEqual(overridden.tools, ["Read", "Grep"]);
    const onDiskFrontmatter = readFileSync(join(agentsHome, "dev", "agents", "researcher.md"), "utf8");
    assert.ok(onDiskFrontmatter.includes("tools: Read, Grep"));
  } finally {
    if (prev === undefined) delete process.env.LA_SQUAD_HOME;
    else process.env.LA_SQUAD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(agentsHome, { recursive: true, force: true });
  }
});

test("resolveToolProfile: bad squad / role names are refused", () => {
  const dir = tempDir();
  try {
    assert.throws(() => resolveToolProfile({ squad: "BAD SQUAD" }, opts(dir)), /squad must match/);
    assert.throws(() => resolveToolProfile({ squad: "dev", role: "LEAD!" }, opts(dir)), /role must be/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// getToolCatalog — merged, honest
// ---------------------------------------------------------------------------

test("getToolCatalog: builtin tools + the five thoughtmap tools, no fake availability", () => {
  const dir = tempDir();
  try {
    const catalog = getToolCatalog(opts(dir));
    assert.equal(catalog.tools.Read.risk, "safe");
    for (const name of [
      "mcp__thoughtmap__search_thoughts",
      "mcp__thoughtmap__list_clusters",
      "mcp__thoughtmap__get_cluster",
      "mcp__thoughtmap__cluster_distances",
      "mcp__thoughtmap__text_distance",
    ]) {
      assert.equal(catalog.tools[name].risk, "safe");
      assert.equal(catalog.tools[name].readOnly, true);
      assert.equal(catalog.tools[name].source, "mcp");
      assert.equal(catalog.tools[name].verified, null); // only the test route verifies
      assert.equal("available" in catalog.tools[name], false); // availability is never faked
    }
    assert.equal(catalog.tools.mcp__thoughtmap__search_thoughts.serverEnabled, false);
    assert.equal(catalog.servers.thoughtmap.readOnly, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getToolCatalog: serverEnabled follows the registry, not a hardcode", () => {
  const dir = tempDir();
  try {
    writeToolProfiles({ mcp: { thoughtmap: { enabled: true } } }, opts(dir));
    const catalog = getToolCatalog(opts(dir));
    assert.equal(catalog.tools.mcp__thoughtmap__search_thoughts.serverEnabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// snapshotToolProfile — two safe files, --tools (never --allowedTools)
// ---------------------------------------------------------------------------

test("snapshotToolProfile: refuses a missing outputDir", () => {
  const dir = tempDir();
  const missing = join(dir, "nope");
  try {
    assert.throws(() => snapshotToolProfile({ squad: "dev", outputDir: missing }, opts(dir)), /must be an existing directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotToolProfile: writes ONLY snapshot.json + mcp.json, with --tools and no secrets", () => {
  const dir = tempDir();
  const out = tempDir();
  try {
    writeToolProfiles(
      {
        mcp: { thoughtmap: { enabled: true } },
        leadTools: { dev: ["Read", "Grep", "mcp__thoughtmap__search_thoughts"] },
      },
      opts(dir),
    );
    const result = snapshotToolProfile({ squad: "dev", outputDir: out }, opts(dir));
    assert.deepEqual(readdirSync(out).sort(), ["mcp.json", "snapshot.json"]);
    assert.deepEqual(result.cliArgs.slice(0, 2), ["--tools", "Read,Grep"]);
    assert.ok(!result.cliArgs.includes("--disallowedTools"));
    assert.deepEqual(JSON.parse(result.profile.mcpServers.thoughtmap.env.THOUGHTMAP_ALLOWED_TOOLS), ["search_thoughts"]);
    const snapshot = JSON.parse(readFileSync(join(out, "snapshot.json"), "utf8"));
    assert.equal(snapshot.squad, "dev");
    assert.equal(snapshot.role, "lead");
    assert.deepEqual(snapshot.tools, ["Read", "Grep", "mcp__thoughtmap__search_thoughts"]);
    const mcpConfig = JSON.parse(readFileSync(join(out, "mcp.json"), "utf8"));
    assert.equal(mcpConfig.mcpServers.thoughtmap.command, "python");
    assert.ok(mcpConfig.mcpServers.thoughtmap.args[0].startsWith("C:\\") || mcpConfig.mcpServers.thoughtmap.args[0].startsWith("/"));
    assert.deepEqual(Object.keys(mcpConfig.mcpServers.thoughtmap.env).sort(), [
      "OLLAMA_BASE_URL",
      "OLLAMA_EMBEDDING_MODEL",
      "THOUGHTMAP_ALLOWED_TOOLS",
      "THOUGHTMAP_API_URL",
      "THOUGHTMAP_CLUSTERS",
    ]);
    // The restriction flag is --tools; --allowedTools (auto-approve only) and
    // --strict-mcp-config (would wipe the project's existing MCP guards) never appear.
    const flat = JSON.stringify({ snapshot, mcpConfig, cliArgs: result.cliArgs });
    assert.ok(flat.includes('"--tools"'));
    assert.equal(result.cliArgs.includes("--allowedTools"), false);
    assert.equal(flat.includes("strict-mcp-config"), false);
    assert.deepEqual(result.env.THOUGHTMAP_API_URL, "http://thoughtmap-app:8585");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("snapshotToolProfile: worker role gets cliArgs [] and its frontmatter tools in the snapshot", () => {
  const dir = tempDir();
  const out = tempDir();
  const agentsHome = tempDir();
  const prev = process.env.LA_SQUAD_HOME;
  process.env.LA_SQUAD_HOME = agentsHome;
  try {
    mkdirSync(join(agentsHome, "dev", "agents"), { recursive: true });
    writeFileSync(
      join(agentsHome, "dev", "agents", "researcher.md"),
      "---\nmodel: m\ntools: Read, Grep\n---\nbody",
      "utf8",
    );
    const result = snapshotToolProfile({ squad: "dev", role: "researcher", outputDir: out }, opts(dir));
    assert.deepEqual(result.cliArgs, []); // frontmatter governs workers, not CLI flags
    const snapshot = JSON.parse(readFileSync(join(out, "snapshot.json"), "utf8"));
    assert.deepEqual(snapshot.nativeTools, ["Read", "Grep"]);
  } finally {
    if (prev === undefined) delete process.env.LA_SQUAD_HOME;
    else process.env.LA_SQUAD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
    rmSync(agentsHome, { recursive: true, force: true });
  }
});

test("snapshotToolProfile: empty mcp.json when nothing is enabled", () => {
  const dir = tempDir();
  const out = tempDir();
  try {
    snapshotToolProfile({ squad: "dev", outputDir: out }, opts(dir));
    const mcpConfig = JSON.parse(readFileSync(join(out, "mcp.json"), "utf8"));
    assert.deepEqual(mcpConfig, { mcpServers: {} });
    assert.deepEqual(readToolProfiles(opts(dir)).mcp, emptyToolProfiles().mcp);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});


test('global and squad inheritance preserves explicit none at launch', () => {
 const dir=tempDir(),out=tempDir();try {
  writeToolProfiles({globalTools:['Read','Grep']},opts(dir));
  assert.deepEqual(resolveToolProfile({squad:'dev'},opts(dir)).tools,['Read','Grep']);
  writeToolProfiles({squadTools:{dev:['Read']}},opts(dir));
  assert.deepEqual(resolveToolProfile({squad:'dev'},opts(dir)).tools,['Read']);
  writeToolProfiles({leadTools:{dev:[]}},opts(dir));
  assert.deepEqual(snapshotToolProfile({squad:'dev',outputDir:out},opts(dir)).cliArgs.slice(0,2),['--tools','']);
  writeToolProfiles({leadTools:{dev:null}},opts(dir));
  assert.deepEqual(resolveToolProfile({squad:'dev'},opts(dir)).tools,['Read']);
 } finally {rmSync(dir,{recursive:true,force:true});rmSync(out,{recursive:true,force:true})}
});
