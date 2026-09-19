// scripts/mcp-shadow-run.test.mjs — FOC-401: the shadow run's offline path
// end to end. The evidence record must state which path ran, both servers
// must be exercised through their real MCP message path, and every offline
// call must carry confidence null (ADR-0012 D3.6 — measured sources only).
//
// Hermetic by contract: tests force offline or refuse to run — they never
// make a live call and never require a network or an API key.
//
// Run: node scripts/mcp-shadow-run.test.mjs

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShadowRun, DEFAULT_OUT } from "./mcp/shadow-run.mjs";

// Hermetic by construction: close the LA_RUN_ID telemetry gate before any
// decision call (see mcp-extraction.test.mjs).
delete process.env.LA_RUN_ID;

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
      console.log("  FAIL " + name + "\n       " + err.message);
    });
}

const fail = (msg) => { throw new Error(msg); };

console.log("\nshadow-run: offline path end to end");

await test("offline run drives both servers through initialize/tools/list/tools/call", async () => {
  const evidence = await runShadowRun({ mode: "offline", write: false });
  if (evidence.path !== "offline") fail("path: " + evidence.path);
  if (evidence.servers.length !== 2) fail("servers: " + evidence.servers.length);
  for (const server of evidence.servers) {
    if (server.handshake.initialize !== "ok") fail(`${server.server}: initialize ${server.handshake.initialize}`);
    if (server.handshake.toolsList !== "ok") fail(`${server.server}: toolsList ${server.handshake.toolsList}`);
    if (server.calls.length < 1) fail(`${server.server}: no calls`);
  }
});

await test("every offline call is ok with confidence null and path offline", async () => {
  const evidence = await runShadowRun({ mode: "offline", write: false });
  for (const server of evidence.servers) {
    for (const call of server.calls) {
      if (call.path !== "offline") fail("call path: " + call.path);
      const envelope = call.envelope;
      if (envelope?.ok !== true) fail(`${server.tool} [${call.fixture}]: ${JSON.stringify(envelope).slice(0, 120)}`);
      if (envelope.confidence !== null) fail(`${server.tool}: offline confidence must be null`);
      if (envelope.mode !== "offline") fail("envelope mode: " + envelope.mode);
    }
  }
});

await test("fixtures are realistic dictated samples including the Polish 'kif i czeryf' one", async () => {
  const evidence = await runShadowRun({ mode: "offline", write: false });
  const extraction = evidence.servers.find((s) => s.tool === "extract_features");
  const fixtures = extraction.calls.map((c) => c.fixture);
  if (!fixtures.includes("dictated-pl-kif-czeryf")) fail("missing the Polish dictation fixture: " + JSON.stringify(fixtures));
  if (!fixtures.includes("dictated-en")) fail("missing the English dictation fixture");
  const refinement = evidence.servers.find((s) => s.tool === "refine_prompt");
  if (!refinement.calls.length) fail("prompt-refinement has no fixture calls");
});

await test("the evidence is written as parseable JSON to the requested path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-shadow-"));
  try {
    const outPath = join(dir, "evidence.json");
    const evidence = await runShadowRun({ mode: "offline", write: true, outPath });
    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    if (parsed.runAt !== evidence.runAt) fail("written evidence differs from the returned one");
    if (!parsed._doc || !parsed._doc.includes("never presented as a live result")) fail("_doc missing the honest-path statement");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("the committed evidence file matches the offline contract", () => {
  // The committed docs/mcp-decision-steps-shadow-run.json is evidence: it must
  // exist at its default path and state its path explicitly.
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(DEFAULT_OUT, "utf8"));
  } catch {
    fail("committed evidence missing at " + DEFAULT_OUT);
  }
  if (evidence.path !== "live" && evidence.path !== "offline") fail("evidence path: " + evidence.path);
  if (evidence.servers.length !== 2) fail("committed evidence covers " + evidence.servers.length + " servers");
});

await test("live mode without a key is refused, never faked", async () => {
  let refused = null;
  try {
    await runShadowRun({ mode: "live", apiKey: "", write: false });
  } catch (err) {
    refused = err;
  }
  if (!refused) fail("live without a key must be refused");
  if (!refused.message.includes("refusing to fake a live call")) fail("refusal: " + refused.message);
});

await test("unknown mode is rejected", async () => {
  let rejected = null;
  try {
    await runShadowRun({ mode: "telepathy", write: false });
  } catch (err) {
    rejected = err;
  }
  if (!rejected) fail("unknown mode must be rejected");
});

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}
