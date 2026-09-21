// scripts/mcp-error-scrub.test.mjs — FOC-417: provider-originated text in a
// failure path is scrubbed of key-shaped material and capped before it reaches
// the caller, without changing the fail-closed contract.
//
// Every case here drives a REAL path — the runDecision catch-all, the Jev
// provider's transport catch, and the JSON-RPC parse branch of handleLine —
// through injected throwers, so no network and no process spawn are involved.
// The assertions test the shape of the output, never the captured secret:
// a failure prints the leak flag, not the value.
//
// Run: node scripts/mcp-error-scrub.test.mjs

import { runDecision, TypedError } from "./mcp/envelope.mjs";
import { EXTRACTION_STEP } from "./mcp/steps.mjs";
import { createExtractionServer } from "./mcp/server-extraction.mjs";
import { createJevProvider } from "./mcp/provider-jev.mjs";
import { scrub, MAX_ERROR_TEXT } from "./mcp/scrub.mjs";

// Hermetic by construction: the launcher env carries LA_RUN_ID (the telemetry
// gate in mcp/envelope.mjs), and a test run must never write telemetry.
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

// A key-shaped probe, assembled so the literal never sits in this file as a
// credential-looking string — the scrub is the leak guard, not the fixture.
const KEY_PROBE = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-");
const OPENER_PROBE = "Bearer " + ["abcdefghijklmnopqrstuvwxyz012345", "6789"].join("");

const run = (provider) => runDecision(EXTRACTION_STEP, { text: "kif i czeryf" }, { provider });

// One assertion, two rules: the probe must be gone AND the fail-closed shape
// must be intact. Returns the message so a case can assert on it further.
function assertScrubbed(envelope, probe, context) {
  if (envelope.ok !== false) fail(`${context}: expected ok:false, got ` + JSON.stringify(envelope.ok));
  if (typeof envelope.error?.code !== "string") fail(`${context}: error.code missing`);
  if (typeof envelope.error.message !== "string") fail(`${context}: error.message missing`);
  if (envelope.error.message.includes(probe)) fail(`${context}: key-shaped probe survived the scrub`);
  if ("decision" in envelope) fail(`${context}: a failed envelope must carry no decision`);
  if (envelope.error.message.length > MAX_ERROR_TEXT) fail(`${context}: message exceeds the cap (${envelope.error.message.length})`);
  return envelope.error.message;
}

console.log("\nscrub: the shared helper (mcp/scrub.mjs)");

await test("masks Bearer headers, tokenized params and sk-style keys", () => {
  const masked = scrub(`GET https://openrouter.ai/x?api_key=${KEY_PROBE} — header Authorization: ${OPENER_PROBE}`);
  if (masked.includes(KEY_PROBE)) fail("sk-style key survived");
  if (masked.includes(OPENER_PROBE)) fail("bearer value survived");
  if (!masked.includes("[REDACTED]")) fail("no mask marker in the output");
  if (!masked.includes("https://openrouter.ai/x")) fail("the URL host should stay readable");
});

await test("caps the result at MAX_ERROR_TEXT, masking applied first", () => {
  const long = "descendant ".repeat(40) + `token=${KEY_PROBE}`;
  const capped = scrub(long);
  if (capped.length > MAX_ERROR_TEXT) fail("cap not applied: " + capped.length);
  if (capped.includes(KEY_PROBE)) fail("a key must never be half-capped into the output");
  if (!capped.endsWith("...")) fail("truncation must be marked: " + capped.slice(-8));
});

await test("is deterministic and total for non-strings", () => {
  if (scrub("plain reason") !== "plain reason") fail("clean text must pass through unchanged");
  if (scrub(undefined) !== "" || scrub(null) !== "") fail("undefined/null must become an empty string");
  if (scrub(42) !== "42") fail("non-string must be stringified");
});

console.log("\nscrub: envelope catch-all (non-TypedError provider crash)");

await test("an unexpected crash is scrubbed and still provider_error", async () => {
  const message = assertScrubbed(
    await run({ decide: async () => { throw new Error(`connect ECONNREFUSED token=${KEY_PROBE}`); } }),
    KEY_PROBE,
    "crash",
  );
  if (!message.includes("[REDACTED]")) fail("no mask marker: " + message);
});

await test("a TypedError message is scrubbed too, code preserved", async () => {
  const envelope = await run({ decide: async () => { throw new TypedError("unparseable_output", `bad body: ${KEY_PROBE}`); } });
  assertScrubbed(envelope, KEY_PROBE, "typed");
  if (envelope.error.code !== "unparseable_output") fail("code changed: " + envelope.error.code);
});

await test("an oversized provider message is capped, not passed through", async () => {
  assertScrubbed(
    await run({ decide: async () => { throw new Error("E".repeat(500)); } }),
    "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    "oversize",
  );
});

console.log("\nscrub: Jev provider transport failure (injected fetch)");

await test("a network error is scrubbed, status-only path untouched", async () => {
  const provider = createJevProvider({
    apiKey: "k",
    fetchImpl: async () => { throw new Error(`fetch failed: ${OPENER_PROBE} at https://openrouter.ai/api/alpha/decisions`); },
  });
  const envelope = await runDecision(EXTRACTION_STEP, { text: "kif i czeryf" }, { provider });
  const message = assertScrubbed(envelope, OPENER_PROBE, "network");
  if (envelope.error.code !== "provider_error") fail("code: " + envelope.error.code);
  if (!message.includes("decisions call failed")) fail("reason lost: " + message);
});

await test("an HTTP error still carries the status only, never a body", async () => {
  const provider = createJevProvider({
    apiKey: "k",
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: `upstream echoed ${KEY_PROBE}` }),
    }),
  });
  const envelope = await runDecision(EXTRACTION_STEP, { text: "kif i czeryf" }, { provider });
  assertScrubbed(envelope, KEY_PROBE, "http");
  if (!envelope.error.message.includes("502")) fail("status missing: " + envelope.error.message);
});

console.log("\nscrub: JSON-RPC parse detail (malformed line)");

await test("a malformed line quotes the fragment scrubbed and capped", async () => {
  const server = createExtractionServer({});
  const line = await server.handleLine(`{"jsonrpc":"2.0","method":"tools/call",` + `"params":{"name":"${KEY_PROBE}"`);
  const response = JSON.parse(line);
  if (response.error?.code !== -32700) fail("code: " + response.error?.code);
  if (response.id !== null) fail("parse errors answer with a null id");
  const detail = response.error.data ?? "";
  if (detail.includes(KEY_PROBE)) fail("key-shaped probe survived in the parse detail");
  if (detail.length > MAX_ERROR_TEXT) fail("parse detail exceeds the cap: " + detail.length);
  if (!detail) fail("the parse detail should still explain the failure");
});

await test("a very long malformed line stays capped", async () => {
  const server = createExtractionServer({});
  const response = JSON.parse(await server.handleLine("{".repeat(400)));
  const detail = response.error?.data ?? "";
  if (detail.length > MAX_ERROR_TEXT) fail("cap not applied: " + detail.length);
});

console.log("\nscrub: schema-path summary (reject path, FOC-443)");

await test("a schema reject of a long key-shaped property is masked and capped", async () => {
  // The built steps use additionalProperties:false, whose violation reports
  // "(root)" — so a caller-named KEY only reaches the schema path where a
  // schema descends into named properties. This fixture models that shape;
  // the property name is long AND key-shaped, so both rules must fire.
  const step = {
    name: "scrub-schema-path-probe",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", minLength: 1 } },
      additionalProperties: { type: "string", maxLength: 2 },
    },
    outputSchema: { type: "object", required: ["decision"], properties: { decision: { type: "object" } } },
  };
  const name = `token_${"abcdefghijklmnopqrstuvwxyz012345".repeat(5)}`;
  const envelope = await runDecision(step, { text: "kif i czeryf", [name]: "w".repeat(24) }, {
    provider: { decide: async () => { throw new Error("provider must never be reached by a rejected input"); } },
  });
  if (envelope.ok !== false) fail("expected ok:false, got " + JSON.stringify(envelope.ok));
  if (envelope.error?.code !== "invalid_input") fail("code changed: " + envelope.error?.code);
  if (typeof envelope.error?.message !== "string") fail("error.message missing");
  if (envelope.error.message.includes(name)) fail("caller-named key survived in the schema path");
  if (!envelope.error.message.includes("[REDACTED]")) fail("no mask marker: " + envelope.error.message);
  if (envelope.error.message.length > MAX_ERROR_TEXT) fail("cap not applied: " + envelope.error.message.length);
  if ("decision" in envelope) fail("a failed envelope must carry no decision");
});

console.log("\n" + passed + " passed.");
if (failures.length > 0) {
  console.error(failures.length + " test(s) failed.");
  process.exit(1);
}