// Tests for worker-tool-profiles.mjs — stamping the launch-owned agent markdown.
//
// The stamper rewrites ONLY the copies under <launchConfigDir>/agents/ — the
// running native definitions (the squad source dir) stay frozen. Per role:
//   · no tools line         → inherit squadTools[squad] ?? globalTools
//   · tools: []             → explicit none, never inherited
//   · mcp__thoughtmap__X    → renamed to the role's inline namespace
//                             mcp__thoughtmap_<role>__X so a lead's deny list
//                             on the canonical namespace cannot mask a tool
//                             explicitly selected for the worker; the inline
//                             mcpServers block is written only when the server
//                             is enabled in the same registry.
//
// All tests operate on fixtures in a temp directory, NEVER on real repo files.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = pathToFileURL(join(__dirname, "worker-tool-profiles.mjs")).href;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

function assertEq(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

// A registry that passes validateToolProfiles: all thoughtmap fields explicit,
// a non-loopback baseUrl, the fixed approved clusters mount.
const THOUGHTMAP_ENABLED = {
  enabled: true,
  baseUrl: "http://thoughtmap-app:8585",
  ollamaBaseUrl: "http://thoughtmap-ollama:11434",
  embeddingModel: "qwen3-embedding:8b",
  clustersPath: "/fenix-integrations/thoughtmap/clusters.json",
};

function writeRegistry(root, thoughtmap, extra = {}) {
  const mcp = { thoughtmap };
  writeFileSync(
    join(root, "tool-profiles.json"),
    JSON.stringify({ version: 1, revision: 3, mcp, ...extra }, null, 2) + "\n",
    "utf8"
  );
}

function stampEnv(root) {
  return { LA_TOOL_PROFILES_FILE: join(root, "tool-profiles.json") };
}

// One launch-owned config dir with agents/*.md roles. `sources` mirrors what
// the squad dir held before the launch copy, for the source-preservation test.
function buildFixture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "worker-tool-profiles-test-"));
  const configDir = join(root, "launch", "config");
  mkdirSync(join(configDir, "agents"), { recursive: true });
  mkdirSync(join(root, "source", "agents"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(configDir, "agents", `${name}.md`), text, "utf8");
    // The launch copy starts identical to the squad source.
    copyFileSync(join(configDir, "agents", `${name}.md`), join(root, "source", "agents", `${name}.md`));
  }
  return { root, configDir };
}

const FM = (body) => `---\n${body}\n---\nWorker body.\n`;

const FIXTURE_FILES = {
  impl: FM("name: impl\nmodel: z-ai/glm-5.2\ntools: Read, Bash"),
  notool: FM("name: notool\nmodel: z-ai/glm-5.2"),
  none: FM("name: none\ntools: []"),
  mcp: FM("name: mcp\ntools: Read, mcp__thoughtmap__search_thoughts"),
  "review-2": FM("name: review-2\ntools: mcp__thoughtmap__made_up_tool"),
  conflict: FM("name: conflict\ntools: mcp__thoughtmap__search_thoughts\nmcpServers: [{\"other\":{\"command\":\"x\"}}]"),
  nofm: "Just a body, no frontmatter.\n",
};

function stampedEntry(stamped, role) {
  return stamped.find((s) => s.role === role) ?? null;
}

/** The frontmatter `tools:` value of a stamped file, or null. */
function toolsLineOf(configDir, role) {
  const md = readFileSync(join(configDir, "agents", `${role}.md`), "utf8");
  const m = md.match(/^tools: (.*)$/m);
  return m ? m[1] : null;
}

/** The parsed inline mcpServers block of a stamped file, or null. */
function mcpServersOf(configDir, role) {
  const md = readFileSync(join(configDir, "agents", `${role}.md`), "utf8");
  const m = md.match(/^mcpServers: (.+)$/m);
  return m ? JSON.parse(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  const { stampWorkerToolProfiles } = await import(MODULE_PATH);

  // ---- Test 1: no agents dir → nothing stamped ----
  {
    const root = mkdtempSync(join(tmpdir(), "worker-tool-profiles-test-"));
    writeRegistry(root, THOUGHTMAP_ENABLED);
    const stamped = stampWorkerToolProfiles(join(root, "missing"), {
      squad: "dev",
      env: stampEnv(root),
    });
    assertEq(stamped.length, 0, "missing agents dir → empty stamped list");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 2: no tools line inherits squadTools ----
  {
    const { root, configDir } = buildFixture({ notool: FIXTURE_FILES.notool });
    writeRegistry(root, THOUGHTMAP_ENABLED, { squadTools: { dev: ["Read", "Grep"] } });
    const stamped = stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    const entry = stampedEntry(stamped, "notool");
    assert(entry !== null, "inherit: role without tools line is stamped");
    assertEq(
      JSON.stringify(entry?.tools),
      JSON.stringify(["Read", "Grep"]),
      "inherit: squadTools list inherited"
    );
    assertEq(entry?.server, null, "inherit: no thoughtmap selection → server null");
    assertEq(toolsLineOf(configDir, "notool"), "Read, Grep", "inherit: tools line written");
    assertEq(mcpServersOf(configDir, "notool"), null, "inherit: no mcpServers block");
    assert(
      readFileSync(join(configDir, "agents", "notool.md"), "utf8").includes("Worker body."),
      "inherit: body preserved"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 3: globalTools is the fallback when the squad has no list ----
  {
    const { root, configDir } = buildFixture({ notool: FIXTURE_FILES.notool });
    writeRegistry(root, THOUGHTMAP_ENABLED, { globalTools: ["Glob"] });
    const stamped = stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    assertEq(
      JSON.stringify(stampedEntry(stamped, "notool")?.tools),
      JSON.stringify(["Glob"]),
      "inherit: globalTools used when squadTools has no entry"
    );
    assertEq(toolsLineOf(configDir, "notool"), "Glob", "inherit: global tools line written");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 4: explicit tools: [] is explicit NONE, never inherited ----
  {
    const { root, configDir } = buildFixture({ none: FIXTURE_FILES.none });
    writeRegistry(root, THOUGHTMAP_ENABLED, { squadTools: { dev: ["Read", "Grep"] } });
    const stamped = stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    const entry = stampedEntry(stamped, "none");
    assert(entry !== null, "explicit []: role is stamped");
    assertEq(
      JSON.stringify(entry?.tools),
      JSON.stringify([]),
      "explicit []: no squad list inherited"
    );
    assertEq(toolsLineOf(configDir, "none"), "[]", "explicit []: line stays tools: []");
    assertEq(mcpServersOf(configDir, "none"), null, "explicit []: no mcpServers block");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 5: own tools line wins over inheritance ----
  {
    const { root, configDir } = buildFixture({ impl: FIXTURE_FILES.impl });
    writeRegistry(root, THOUGHTMAP_ENABLED, { squadTools: { dev: ["Grep"] } });
    const stamped = stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    assertEq(
      JSON.stringify(stampedEntry(stamped, "impl")?.tools),
      JSON.stringify(["Read", "Bash"]),
      "own line: frontmatter list beats squadTools"
    );
    assertEq(toolsLineOf(configDir, "impl"), "Read, Bash", "own line: written back verbatim");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 6: selected thoughtmap tool → renamed namespace + inline server ----
  {
    const { root, configDir } = buildFixture({ mcp: FIXTURE_FILES.mcp });
    writeRegistry(root, THOUGHTMAP_ENABLED);
    const stamped = stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    const entry = stampedEntry(stamped, "mcp");
    assertEq(
      JSON.stringify(entry?.tools),
      JSON.stringify(["Read", "mcp__thoughtmap__search_thoughts"]),
      "renamed: entry reports the canonical selection"
    );
    assertEq(entry?.server, "thoughtmap_mcp", "renamed: entry reports the role namespace");
    assertEq(
      toolsLineOf(configDir, "mcp"),
      "Read, mcp__thoughtmap_mcp__search_thoughts",
      "renamed: tools line uses the role namespace"
    );
    const servers = mcpServersOf(configDir, "mcp");
    assert(servers !== null, "renamed: inline mcpServers block written");
    assertEq(servers?.length, 1, "renamed: exactly one inline server");
    const cfg = servers?.[0]?.thoughtmap_mcp;
    assert(cfg !== undefined, "renamed: server keyed by the role namespace");
    assertEq(cfg?.command, "python", "renamed: stdio command is python");
    assert(
      typeof cfg?.args?.[0] === "string" && cfg.args[0].endsWith("server-thoughtmap.py"),
      "renamed: stdio args point at the thoughtmap adapter"
    );
    assertEq(cfg?.env?.THOUGHTMAP_API_URL, "http://thoughtmap-app:8585", "renamed: env carries the API URL");
    assertEq(
      cfg?.env?.THOUGHTMAP_CLUSTERS,
      "/fenix-integrations/thoughtmap/clusters.json",
      "renamed: env carries the approved clusters mount"
    );
    assertEq(cfg?.env?.OLLAMA_EMBEDDING_MODEL, "qwen3-embedding:8b", "renamed: env carries the embedding model");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 7: unknown thoughtmap tool preserved; role name sanitized ----
  {
    const { root, configDir } = buildFixture({ "review-2": FIXTURE_FILES["review-2"] });
    writeRegistry(root, THOUGHTMAP_ENABLED);
    const stamped = stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    const entry = stampedEntry(stamped, "review-2");
    assertEq(
      JSON.stringify(entry?.tools),
      JSON.stringify(["mcp__thoughtmap__made_up_tool"]),
      "unknown MCP: canonical unknown name preserved in the entry"
    );
    assertEq(
      toolsLineOf(configDir, "review-2"),
      "mcp__thoughtmap_review_2__made_up_tool",
      "unknown MCP: renamed under the sanitized role namespace (dash → underscore)"
    );
    assert(mcpServersOf(configDir, "review-2") !== null, "unknown MCP: inline server written");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 8: server disabled → rename still applied, NO inline server ----
  {
    const { root, configDir } = buildFixture({ mcp: FIXTURE_FILES.mcp });
    writeRegistry(root, { ...THOUGHTMAP_ENABLED, enabled: false });
    const stamped = stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    assertEq(
      toolsLineOf(configDir, "mcp"),
      "Read, mcp__thoughtmap_mcp__search_thoughts",
      "disabled: tools line renamed (nothing is granted — no server exists under it)"
    );
    assertEq(mcpServersOf(configDir, "mcp"), null, "disabled: no mcpServers block written");
    // The metadata must never name a server that was not attached: with the
    // server disabled no inline block exists, so the entry reports null.
    assertEq(stampedEntry(stamped, "mcp")?.server, null, "disabled: entry reports server null");
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 9: an existing worker MCP definition is refused, not merged ----
  {
    const { root, configDir } = buildFixture({ conflict: FIXTURE_FILES.conflict });
    writeRegistry(root, THOUGHTMAP_ENABLED);
    let error = null;
    try {
      stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    } catch (err) {
      error = err;
    }
    assert(error !== null, "conflict: ambiguous merge refused");
    assert(
      /already exists/.test(error?.message ?? ""),
      "conflict: error names the existing worker MCP definition"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 10: the squad source configs stay frozen ----
  {
    const { root, configDir } = buildFixture({ impl: FIXTURE_FILES.impl, mcp: FIXTURE_FILES.mcp });
    writeRegistry(root, THOUGHTMAP_ENABLED);
    stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    assertEq(
      readFileSync(join(root, "source", "agents", "impl.md"), "utf8"),
      FIXTURE_FILES.impl,
      "source: builtin-tools role untouched"
    );
    assertEq(
      readFileSync(join(root, "source", "agents", "mcp.md"), "utf8"),
      FIXTURE_FILES.mcp,
      "source: thoughtmap-selected role untouched"
    );
    assert(
      readFileSync(join(configDir, "agents", "mcp.md"), "utf8").includes("mcpServers:"),
      "source: the launch-owned copy DID change"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 11: no frontmatter → skipped, file untouched ----
  {
    const { root, configDir } = buildFixture({ nofm: FIXTURE_FILES.nofm });
    writeRegistry(root, THOUGHTMAP_ENABLED, { squadTools: { dev: ["Read"] } });
    const stamped = stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    assertEq(stamped.length, 0, "no frontmatter: not stamped");
    assertEq(
      readFileSync(join(configDir, "agents", "nofm.md"), "utf8"),
      FIXTURE_FILES.nofm,
      "no frontmatter: file byte-identical"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 12: nothing to inherit → file left untouched ----
  {
    const { root, configDir } = buildFixture({ notool: FIXTURE_FILES.notool });
    writeRegistry(root, { ...THOUGHTMAP_ENABLED, enabled: false }); // no globalTools, no squadTools
    const stamped = stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    assertEq(stamped.length, 0, "nothing to inherit: role not stamped");
    assertEq(
      readFileSync(join(configDir, "agents", "notool.md"), "utf8"),
      FIXTURE_FILES.notool,
      "nothing to inherit: file byte-identical"
    );
    rmSync(root, { recursive: true, force: true });
  }

  // ---- Test 13: only .md files are stamped ----
  {
    const root = mkdtempSync(join(tmpdir(), "worker-tool-profiles-test-"));
    const configDir = join(root, "launch", "config");
    mkdirSync(join(configDir, "agents"), { recursive: true });
    writeFileSync(join(configDir, "agents", "notes.txt"), "---\nname: notes\n---\n", "utf8");
    writeRegistry(root, THOUGHTMAP_ENABLED, { squadTools: { dev: ["Read"] } });
    const stamped = stampWorkerToolProfiles(configDir, { squad: "dev", env: stampEnv(root) });
    assertEq(stamped.length, 0, "non-md: ignored");
    assertEq(
      readFileSync(join(configDir, "agents", "notes.txt"), "utf8"),
      "---\nname: notes\n---\n",
      "non-md: file untouched"
    );
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("worker-tool-profiles tests\n");
  await runTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
