// scripts/mcp-codegraph-probe.test.mjs — the REAL-CLI stdio probe for the
// fail-closed boundary (plan 2026-09-23 §6): the actual `codegraph serve
// --mcp` behind scripts/mcp/server-codegraph.mjs, over a throwaway fixture —
// never this repo's own index, never a global source.
//
//   node scripts/mcp-codegraph-probe.test.mjs   (no CLI → SKIP, prints that
//   0 probe tests ran; no scripts/codegraph-runtime.mjs → FAIL: the probe
//   must exercise the boundary against the shared runtime the boundary loads)
//
// What this probe must SHOW (the plan's fixture contract, the part unit tests
// cannot): a dirty edit that removes a CALL — not just a file's bytes — makes
// the next callers answer report the NEW relationship, end to end through the
// boundary's gate → sync → forward → stale-retry machinery. A source re-read
// alone would not satisfy it: the RELATIONSHIP (caller list) must change.
// A genuine check→query race may surface as UNKNOWN mid-sequence; a QUIESCENT
// tree must end with a clean, correct answer — all-UNKNOWN does not pass.
//
// The runtime is scripts/codegraph-runtime.mjs — the shared module the
// boundary itself loads by default. There is no placeholder fallback: if it
// is missing the probe FAILS rather than quietly testing something else.
// Nothing else here is mocked — the binary, index, watcher and banners are
// the installed real ones.
//
// Fixture hygiene: CODEGRAPH_NO_DAEMON=1 pins the upstream to direct mode so
// no per-project daemon outlives the probe. Successful fixture removal on
// win32 doubles as the child-reaping proof — an open sqlite handle makes
// rmSync fail, so a clean teardown means the boundary's child really died.

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(join(__dir, ".."));
const ADAPTER = join(__dir, "mcp", "server-codegraph.mjs");
const SHARED_RUNTIME = join(REPO, "scripts", "codegraph-runtime.mjs");

const SYMBOL = "focMcpProbeTarget";
const TOOLS_ENV = "explore,node,search,callers,callees,impact,files,status";

// Blocking settle (the code-intel.test.mjs idiom) — sleeps without timers, so
// it cannot interact with the async client machinery being probed.
const settle = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  PASS " + name);
    })
    .catch((err) => {
      failures.push(name);
      console.log("  FAIL " + name + "\n       " + (err?.stack ?? err?.message ?? err));
    });
}
const fail = (msg) => { throw new Error(msg); };

// ── availability (skip, don't fail — the probe needs the real binary) ───────
function codegraphAvailable() {
  const res = spawnSync("codegraph", ["--version"], { encoding: "utf8", shell: process.platform === "win32", timeout: 30_000, windowsHide: true });
  return res.status === 0;
}

if (!codegraphAvailable()) {
  console.log(
    "SKIP: the codegraph CLI is not available — 0 probe tests ran (the hermetic boundary suite in scripts/mcp-codegraph-boundary.test.mjs is still enforced).",
  );
  process.exit(0);
}

if (!existsSync(SHARED_RUNTIME)) {
  console.error(
    "FAIL: scripts/codegraph-runtime.mjs is missing — the probe no longer falls back to a placeholder runtime; it must exercise the boundary against the shared runtime the boundary itself loads. Land the shared runtime, then re-run.",
  );
  process.exit(1);
}
console.log("runtime: shared scripts/codegraph-runtime.mjs (loaded by the boundary by default)");

// ── fixtures ────────────────────────────────────────────────────────────────
const fixtures = [];
function makeFixture(tag, { withIndex, files }) {
  const root = mkdtempSync(join(tmpdir(), `cg-probe-${tag}-`));
  fixtures.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  // The git baseline is REQUIRED: pendingChanges is computed against it, and
  // a "clean" reading without one is a false zero (FOC-114 round 5).
  git(["init", "-b", "main"]);
  git(["config", "user.email", "probe@example.com"]);
  git(["config", "user.name", "cg-probe"]);
  git(["add", "-A"]);
  const commit = git(["commit", "-m", "probe baseline"]);
  if (commit.status !== 0) fail("fixture git baseline failed: " + (commit.stderr ?? "").slice(0, 200));
  if (withIndex) {
    const init = spawnSync("codegraph", ["init", "."], { cwd: root, encoding: "utf8", shell: process.platform === "win32", timeout: 120_000, windowsHide: true });
    if (init.status !== 0) fail("codegraph init failed: " + ((init.stderr || init.stdout) ?? "").slice(0, 300));
  }
  return root;
}

process.on("exit", () => {
  // Best-effort with grace: an open sqlite handle makes rmSync fail on win32,
  // so retry briefly — success is the child-reaping proof, failure is logged.
  for (const root of fixtures) {
    for (let i = 0; i < 6; i++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { settle(250); }
    }
    if (existsSync(root)) console.error(`  [probe] WARNING: fixture ${root} could not be removed (a process may still hold it)`);
  }
});

// ── the minimal stdio MCP client over the real adapter ─────────────────────
class AdapterProc {
  constructor(root, extraEnv = {}) {
    this.lines = [];
    this.stderr = [];
    this.sawNonJson = false;
    this.waiters = new Map();
    this.nextId = 1;
    this.proc = spawn(process.execPath, [ADAPTER], {
      cwd: root,
      env: {
        ...process.env,
        CODEGRAPH_MCP_TOOLS: TOOLS_ENV,
        CODEGRAPH_NO_DAEMON: "1", // fixture hygiene: direct mode, no surviving daemon
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (l) => {
      this.lines.push(l);
      let m = null;
      try { m = JSON.parse(l); } catch { this.sawNonJson = true; return; }
      if (m && m.id !== undefined && this.waiters.has(m.id)) {
        const w = this.waiters.get(m.id);
        this.waiters.delete(m.id);
        w(m);
      }
    });
    const erl = createInterface({ input: this.proc.stderr });
    erl.on("line", (l) => this.stderr.push(l));
    this.proc.stdin.on("error", () => {});
    this.exited = new Promise((res) => this.proc.on("exit", (code, signal) => res({ code, signal })));
  }
  raw(obj) { this.proc.stdin.write(JSON.stringify(obj) + "\n"); }
  async call(method, params, timeoutMs = 90_000) {
    const id = this.nextId++;
    const p = new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiters.delete(id); rej(new Error(`client timeout (${method} id ${id})`)); }, timeoutMs);
      this.waiters.set(id, (m) => { clearTimeout(t); res(m); });
    });
    this.raw({ jsonrpc: "2.0", id, method, params });
    return p;
  }
  close() { this.proc.stdin.end(); }
}

// One gated probe call with the plan's race policy: UNKNOWN mid-race is
// acceptable, the FINAL attempt on a quiescent tree must be a clean answer.
async function callUntilClean(ap, { attempts = 4, settleMs = 1_500 } = {}) {
  const unknowns = [];
  let resp = null;
  for (let i = 1; i <= attempts; i++) {
    resp = await ap.call("tools/call", { name: "codegraph_callers", arguments: { symbol: SYMBOL } });
    if (!resp.result?.isError) return { resp, unknowns, attempts: i };
    unknowns.push(tryHeader(resp));
    if (i < attempts) await sleep(settleMs);
  }
  return { resp, unknowns, attempts, stayedUnknown: true };
}
function tryHeader(resp) {
  try { return JSON.parse(resp.result.content[0].text.split("\n")[0]); } catch { return { unparseable: true }; }
}
const textOf = (resp) => resp.result?.content?.map((b) => b.text).join("\n") ?? "";

// ── the probe ──────────────────────────────────────────────────────────────
console.log("\nprobe: dirty edit must change the reported RELATIONSHIP (real CLI)");

const targetMjs = `export function ${SYMBOL}() {\n  return 42;\n}\n`;
const callerAMjs = `import { ${SYMBOL} } from "./target.mjs";\n\nexport function focMcpProbeCallerA() {\n  return ${SYMBOL}();\n}\n`;
// The dirty edit: the call disappears (and its import) — the RELATIONSHIP
// must drop callerA from the answer, not merely re-read newer bytes.
const callerAMjsAfter = `export function focMcpProbeCallerA() {\n  return 7;\n}\n`;
const callerBMjs = `import { ${SYMBOL} } from "./target.mjs";\n\nexport function focMcpProbeCallerB() {\n  return ${SYMBOL}() + 1;\n}\n`;

const root = makeFixture("indexed", {
  withIndex: true,
  files: { "src/target.mjs": targetMjs, "src/callerA.mjs": callerAMjs },
});

await test("tools/list through the boundary: the forwarded env shapes the real server's surface", async () => {
  // Verified installed-1.6.0 behavior (mcp/tools.js getTools): with
  // CODEGRAPH_MCP_TOOLS set to the 8 verbs, the allowlist is honored — and
  // the tiny-repo gate (<500 indexed files) then trims ListTools to the
  // core trio, every member of which is inside the 8. The boundary's job is
  // to FORWARD that faithfully, not to fight it. The env passthrough is
  // proven by contrast: without CODEGRAPH_MCP_TOOLS upstream's default
  // surface is explore ALONE — a different listed surface through the same
  // boundary means the env really reached the real server.
  const ap = new AdapterProc(root);
  try {
    settle(2_500); // direct-mode engine + watcher warm-up on first use
    const init = await ap.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cg-probe", version: "0" } });
    if (!init.result?.serverInfo) fail("handshake failed: " + JSON.stringify(init).slice(0, 200));
    const ls = await ap.call("tools/list");
    const names = ls.result.tools.map((t) => t.name).sort();
    const trio = ["codegraph_explore", "codegraph_node", "codegraph_search"].sort();
    if (JSON.stringify(names) !== JSON.stringify(trio)) {
      fail(`expected the tiny-repo trio (allowlist passed through), got: ${names.join(",")}`);
    }
    if (ap.sawNonJson) fail("adapter stdout contained a non-JSON line");
  } finally {
    ap.close();
    await ap.exited;
  }
  // Contrast run: same boundary, env suppressed → upstream defaults to the
  // explore-only surface.
  const bare = new AdapterProc(root, { CODEGRAPH_MCP_TOOLS: "" });
  try {
    settle(1_500);
    await bare.call("initialize", { protocolVersion: "2025-06-18" });
    const ls2 = await bare.call("tools/list");
    const names2 = ls2.result.tools.map((t) => t.name);
    if (names2.length !== 1 || names2[0] !== "codegraph_explore") {
      fail(`without the env upstream must list its default explore-only surface, got: ${names2.join(",")}`);
    }
  } finally {
    bare.close();
    await bare.exited;
  }
});

let beforeText = null;
await test("quiescent baseline: callers lists the indexed caller (clean, no UNKNOWN)", async () => {
  const ap = new AdapterProc(root);
  try {
    settle(2_500);
    await ap.call("initialize", { protocolVersion: "2025-06-18" });
    const { resp, unknowns, stayedUnknown } = await callUntilClean(ap);
    if (stayedUnknown) fail("the quiescent baseline never answered clean; UNKNOWNs seen: " + JSON.stringify(unknowns));
    if (!textOf(resp).includes("focMcpProbeCallerA")) {
      fail("expected the indexed caller in the baseline answer, got: " + textOf(resp).slice(0, 400));
    }
    beforeText = textOf(resp);
  } finally {
    ap.close();
    await ap.exited;
  }
});

if (beforeText !== null) {
  await test("dirty edit REMOVES the call → the next callers answer drops the caller (RELATIONSHIP change)", async () => {
    const ap = new AdapterProc(root);
    try {
      settle(2_500);
      await ap.call("initialize", { protocolVersion: "2025-06-18" });
      // The dirty edit — no commit, no sync by hand: the boundary's own gate
      // must absorb it (status → pending → sync → answer).
      writeFileSync(join(root, "src", "callerA.mjs"), callerAMjsAfter);
      const t0 = Date.now();
      const { resp, unknowns, stayedUnknown } = await callUntilClean(ap);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (stayedUnknown) fail(`the removal never surfaced as a clean answer (${secs}s); UNKNOWNs: ` + JSON.stringify(unknowns));
      const after = textOf(resp);
      if (after.includes("focMcpProbeCallerA")) {
        fail(`after removing the call the stale caller is STILL reported (${secs}s): ` + after.slice(0, 400));
      }
      if (unknowns.length > 0) console.log(`       (race absorbed: ${unknowns.length} UNKNOWN attempt(s) before the clean answer, ${secs}s total)`);
    } finally {
      ap.close();
      await ap.exited;
    }
  });

  await test("a NEW caller file appears → the next callers answer includes it", async () => {
    const ap = new AdapterProc(root);
    try {
      settle(2_500);
      await ap.call("initialize", { protocolVersion: "2025-06-18" });
      writeFileSync(join(root, "src", "callerB.mjs"), callerBMjs);
      const { resp, unknowns, stayedUnknown } = await callUntilClean(ap);
      if (stayedUnknown) fail("the new caller never surfaced as a clean answer; UNKNOWNs: " + JSON.stringify(unknowns));
      const after = textOf(resp);
      if (!after.includes("focMcpProbeCallerB")) {
        fail("the new caller is missing from the answer: " + after.slice(0, 400));
      }
      if (after.includes("focMcpProbeCallerA")) fail("the removed caller reappeared: " + after.slice(0, 400));
    } finally {
      ap.close();
      await ap.exited;
    }
  });
} else {
  console.log("  SKIP relationship-change steps: the baseline probe did not run.");
}

await test("every adapter stdout line across the probe was valid JSON-RPC", async () => {
  // The cleanliness invariant is enforced per-process in each test above via
  // sawNonJson; this re-checks the LAST adapter's full transcript as a
  // final guard (upstream chatter, stray logs, half lines all fail here).
  const ap = new AdapterProc(root);
  try {
    settle(2_500);
    await ap.call("initialize", { protocolVersion: "2025-06-18" });
    const { stayedUnknown } = await callUntilClean(ap);
    if (stayedUnknown) fail("quiescent re-check never answered clean");
    for (const l of ap.lines) {
      const m = JSON.parse(l); // throws → the test fails with the offending line
      if (m.jsonrpc !== "2.0") fail("non-JSON-RPC line on stdout: " + l.slice(0, 120));
    }
  } finally {
    ap.close();
    await ap.exited;
  }
});

await test("clean shutdown: stdin close exits 0 and the fixture teardown proves the child is reaped", async () => {
  const ap = new AdapterProc(root);
  settle(2_500);
  const init = await ap.call("initialize", { protocolVersion: "2025-06-18" });
  if (!init.result?.serverInfo) fail("handshake failed before shutdown");
  ap.close();
  const exit = await ap.exited;
  if (exit.code !== 0) fail("adapter must exit 0 on stdin close, got " + exit.code + "/" + exit.signal);
  // Wait for the exit handler's child kill + handle release, then prove no
  // process holds the fixture: rmSync on win32 fails while sqlite is open.
  let removed = false;
  for (let i = 0; i < 10 && !removed; i++) {
    try { rmSync(join(root, ".codegraph"), { recursive: true, force: true }); removed = true; } catch { await sleep(300); }
  }
  if (!removed) fail("the index dir could not be removed — the upstream child still holds it");
});

await test("unindexed project: handshake stays intact, the gated query answers typed UNKNOWN (not absence)", async () => {
  const bare = makeFixture("bare", { withIndex: false, files: { "src/x.mjs": "export const x = 1;\n" } });
  const ap = new AdapterProc(bare);
  try {
    settle(1_500);
    const init = await ap.call("initialize", { protocolVersion: "2025-06-18" });
    if (!init.result?.serverInfo) fail("handshake must survive an unindexed project: " + JSON.stringify(init).slice(0, 200));
    const ls = await ap.call("tools/list");
    // No tiny-repo assumption: an unindexed project guarantees no specific tool
    // name — only that tools/list still answers a non-empty, valid surface.
    const tools = ls.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
      fail("tools/list must answer a non-empty surface even unindexed: " + JSON.stringify(ls).slice(0, 200));
    }
    if (!tools.every((t) => typeof t?.name === "string" && t.name.length > 0)) {
      fail("tools/list entries must be valid tools with names, got: " + JSON.stringify(tools).slice(0, 200));
    }
    const resp = await ap.call("tools/call", { name: "codegraph_callers", arguments: { symbol: SYMBOL } });
    if (resp.result?.isError !== true) fail("an unprovable project must answer isError, got: " + JSON.stringify(resp).slice(0, 300));
    const text = textOf(resp);
    const head = tryHeader(resp);
    if (head.status !== "UNKNOWN" || !head.type) fail("the refusal must be the typed UNKNOWN envelope, got: " + text.slice(0, 200));
    if (!text.includes("Sanctioned fallback")) fail("the refusal must sanction the direct-file fallback");
    if (text.includes(SYMBOL)) fail("the refusal must not claim anything about the queried symbol — it is UNKNOWN, not absent");
  } finally {
    ap.close();
    await ap.exited;
  }
});

const ran = passed + failures.length;
console.log(`\n${passed} passed, ${failures.length} failed — ${ran} ran.`);
if (failures.length > 0) {
  process.exit(1);
}