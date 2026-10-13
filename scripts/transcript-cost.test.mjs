// scripts/transcript-cost.test.mjs — tests for transcript-cost.mjs (FOC-760).
//
// Everything runs in temp dirs (mkdtempSync) — never a real telemetry store or
// .state/ data. Pricing is injected and deterministic; the default pricingSnapshot
// path is not exercised here.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  childTranscriptPaths,
  priceChildTranscripts,
  priceTranscripts,
  subagentTranscriptPaths,
} from "./transcript-cost.mjs";
import { cwdToHashName } from "./ledger.mjs";

// Deterministic price table: $1/M input, $2/M output, $0.5/M cache read,
// $1/M cache write — and null for any model outside the table.
const RATES = {
  "claude-x": { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
  "claude-y": { input: 10, output: 20, cacheRead: 5, cacheWrite: 10 },
};
const priceOne = (usage, model) => {
  const rate = RATES[model];
  if (!rate) return null;
  return (
    (usage.inputTokens * rate.input +
      usage.outputTokens * rate.output +
      usage.cacheReadTokens * rate.cacheRead +
      usage.cacheCreationTokens * rate.cacheWrite) /
    1_000_000
  );
};
const thresholdOne = (model) => (model === "gpt-big" ? { minPromptTokens: 1000 } : null);

const assistant = (id, usage, model = "claude-x") => ({
  type: "assistant",
  message: { id, model, usage },
});
const usage = (input, output, cacheRead = 0, cacheCreation = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreation,
});

function tempRoot(label) {
  return mkdtempSync(join(tmpdir(), `transcript-cost-${label}-`));
}

function writeJsonl(path, lines) {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return path;
}

// The projects layout childTranscriptPaths resolves: <configDir>/projects/<hash>/<sessionId>.jsonl
function sessionDir(configDir, cwd, sessionId) {
  const dir = join(configDir, "projects", cwdToHashName(cwd));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("one message written as 3 lines with the same id counts once, MAX per counter", () => {
  const root = tempRoot("merge");
  const file = writeJsonl(join(root, "lead.jsonl"), [
    // zero-usage line of the same message — must not create a second message
    assistant("msg_1", usage(0, 0)),
    assistant("msg_1", usage(5, 10)),
    // output grew by the last line of the same message (streamed re-emission)
    assistant("msg_1", usage(5, 20, 100, 7)),
  ]);
  const result = priceTranscripts([file], { priceOne, thresholdOne });
  assert.equal(result.messages, 1);
  assert.equal(result.files, 1);
  // MAX: input 5, output 20, cacheRead 100, cacheCreation 7 → (5*1 + 20*2 + 100*0.5 + 7*1)/1e6
  assert.equal(result.costUsd, (5 + 40 + 50 + 7) / 1_000_000);
  assert.equal(result.knownUsd, (5 + 40 + 50 + 7) / 1_000_000);
  assert.deepEqual(result.unpricedModels, []);
  assert.deepEqual(result.byModel["claude-x"], { messages: 1, usd: (5 + 40 + 50 + 7) / 1_000_000 });
});

test("lines without a message id count per line", () => {
  const root = tempRoot("idless");
  const file = writeJsonl(join(root, "lead.jsonl"), [
    { type: "assistant", message: { model: "claude-x", usage: usage(10, 0) } },
    { type: "assistant", message: { model: "claude-x", usage: usage(10, 0) } },
  ]);
  const result = priceTranscripts([file], { priceOne, thresholdOne });
  assert.equal(result.messages, 2);
  assert.equal(result.costUsd, 2 * (10 / 1_000_000));
});

test("lead plus session-named subagents directory merges into one pricing", () => {
  const root = tempRoot("subagents-session");
  const lead = writeJsonl(join(root, "sess-1.jsonl"), [assistant("msg_1", usage(10, 10))]);
  const subagentsDir = join(root, "sess-1", "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  writeJsonl(join(subagentsDir, "agent-a.jsonl"), [assistant("msg_2", usage(20, 0), "claude-y")]);
  // sidecars and non-agent files are ignored
  writeJsonl(join(subagentsDir, "agent-b.jsonl.meta.json"), [{ type: "assistant", message: { id: "msg_9", usage: usage(9, 9) } }]);
  writeJsonl(join(subagentsDir, "notes.jsonl"), [assistant("msg_8", usage(8, 8))]);

  assert.deepEqual(subagentTranscriptPaths(lead), [join(subagentsDir, "agent-a.jsonl")]);
  const result = priceTranscripts([lead, ...subagentTranscriptPaths(lead)], { priceOne, thresholdOne });
  assert.equal(result.messages, 2);
  assert.equal(result.files, 2);
  assert.equal(result.costUsd, (10 + 20) / 1_000_000 + (200 + 0) / 1_000_000);
});

test("flat subagents directory is the fallback when no session-named dir exists", () => {
  const root = tempRoot("subagents-flat");
  const lead = writeJsonl(join(root, "sess-2.jsonl"), [assistant("msg_1", usage(10, 0))]);
  const subagentsDir = join(root, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  const agentFile = writeJsonl(join(subagentsDir, "agent-a.jsonl"), [assistant("msg_2", usage(1, 1))]);
  assert.deepEqual(subagentTranscriptPaths(lead), [agentFile]);
  const result = priceTranscripts([lead, ...subagentTranscriptPaths(lead)], { priceOne, thresholdOne });
  assert.equal(result.messages, 2);
});

test("subagentTranscriptPaths returns [] when no subagents directory exists", () => {
  const root = tempRoot("no-subagents");
  const lead = writeJsonl(join(root, "sess-3.jsonl"), [assistant("msg_1", usage(1, 1))]);
  assert.deepEqual(subagentTranscriptPaths(lead), []);
});

test("two models are priced with their own rates and byModel splits them", () => {
  const root = tempRoot("two-models");
  const file = writeJsonl(join(root, "lead.jsonl"), [
    assistant("msg_a", usage(10, 0), "claude-x"),
    assistant("msg_b", usage(10, 0), "claude-y"),
  ]);
  const result = priceTranscripts([file], { priceOne, thresholdOne });
  assert.equal(result.messages, 2);
  assert.equal(result.costUsd, 10 / 1_000_000 + 100 / 1_000_000);
  assert.deepEqual(result.byModel["claude-x"], { messages: 1, usd: 10 / 1_000_000 });
  assert.deepEqual(result.byModel["claude-y"], { messages: 1, usd: 100 / 1_000_000 });
  assert.deepEqual(result.unpricedModels, []);
});

test("tokens on an unpriceable model make costUsd null but knownUsd keeps the priced part", () => {
  const root = tempRoot("unpriced");
  const file = writeJsonl(join(root, "lead.jsonl"), [
    assistant("msg_a", usage(10, 0), "claude-x"),
    assistant("msg_b", usage(500, 100), "mystery"),
  ]);
  const result = priceTranscripts([file], { priceOne, thresholdOne });
  assert.equal(result.costUsd, null);
  assert.equal(result.knownUsd, 10 / 1_000_000);
  assert.deepEqual(result.unpricedModels, ["mystery"]);
  assert.deepEqual(result.byModel["claude-x"], { messages: 1, usd: 10 / 1_000_000 });
  assert.deepEqual(result.byModel["mystery"], { messages: 1, usd: null });
});

test("a declared prompt-token threshold names the unpriced model with the qualifier", () => {
  const root = tempRoot("threshold");
  const file = writeJsonl(join(root, "lead.jsonl"), [
    assistant("msg_a", usage(2000, 0), "gpt-big"),
  ]);
  const result = priceTranscripts([file], { priceOne, thresholdOne });
  assert.equal(result.costUsd, null);
  assert.deepEqual(result.unpricedModels, ["gpt-big (unsupported above 1000 prompt tokens)"]);
});

test("below the threshold the qualifier is not applied — plain model name", () => {
  const root = tempRoot("threshold-below");
  const file = writeJsonl(join(root, "lead.jsonl"), [
    assistant("msg_a", usage(999, 0), "gpt-big"),
  ]);
  const result = priceTranscripts([file], { priceOne, thresholdOne });
  assert.equal(result.costUsd, null);
  assert.deepEqual(result.unpricedModels, ["gpt-big"]);
});

test("a zero-token message on an unpriced model costs 0 and keeps costUsd non-null", () => {
  const root = tempRoot("zero-unpriced");
  const file = writeJsonl(join(root, "lead.jsonl"), [
    assistant("msg_a", usage(10, 0), "claude-x"),
    assistant("msg_b", usage(0, 0, 0, 0), "mystery"),
  ]);
  const result = priceTranscripts([file], { priceOne, thresholdOne });
  assert.equal(result.messages, 2);
  assert.equal(result.costUsd, 10 / 1_000_000);
  assert.deepEqual(result.unpricedModels, []);
  assert.deepEqual(result.byModel["mystery"], { messages: 1, usd: 0 });
});

test("a null model is priced as 'unknown' and named so when unpriced", () => {
  const root = tempRoot("null-model");
  const file = writeJsonl(join(root, "lead.jsonl"), [
    { type: "assistant", message: { id: "msg_a", model: null, usage: usage(10, 10) } },
  ]);
  const result = priceTranscripts([file], { priceOne, thresholdOne });
  assert.equal(result.costUsd, null);
  assert.deepEqual(result.unpricedModels, ["unknown"]);
  assert.deepEqual(result.byModel.unknown, { messages: 1, usd: null });
});

test("malformed and empty lines are skipped", () => {
  const root = tempRoot("malformed");
  const path = join(root, "lead.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify(assistant("msg_a", usage(10, 0))),
      "{not json",
      "",
      "   ",
      JSON.stringify({ type: "assistant", message: { id: "msg_b" } }), // no usage
      JSON.stringify(assistant("msg_c", usage(5, 0))),
    ].join("\n") + "\n",
    "utf8",
  );
  const result = priceTranscripts([path], { priceOne, thresholdOne });
  assert.equal(result.messages, 2);
  assert.ok(Math.abs(result.costUsd - 15 / 1_000_000) < 1e-12);
});

test("missing files are skipped and not counted", () => {
  const root = tempRoot("missing");
  const file = writeJsonl(join(root, "lead.jsonl"), [assistant("msg_a", usage(10, 0))]);
  const result = priceTranscripts([file, join(root, "nope.jsonl")], { priceOne, thresholdOne });
  assert.equal(result.files, 1);
  assert.equal(result.costUsd, 10 / 1_000_000);
});

test("the first non-null model wins across a message's lines", () => {
  const root = tempRoot("model-merge");
  const file = writeJsonl(join(root, "lead.jsonl"), [
    { type: "assistant", message: { id: "msg_a", model: null, usage: usage(0, 0) } },
    assistant("msg_a", usage(10, 0), "claude-y"),
    assistant("msg_a", usage(10, 5), "claude-x"),
  ]);
  const result = priceTranscripts([file], { priceOne, thresholdOne });
  assert.equal(result.messages, 1);
  // model = claude-y (first non-null), MAX output = 5 → 10*10 + 5*20
  assert.equal(result.costUsd, (100 + 100) / 1_000_000);
  assert.ok(result.byModel["claude-y"]);
  assert.equal(result.byModel["claude-x"], undefined);
});

test("childTranscriptPaths resolves the exact cwd-hash directory", () => {
  const configDir = tempRoot("cfg-exact");
  const cwd = tempRoot("cwd-exact");
  mkdirSync(join(configDir, "projects"), { recursive: true });
  const dir = sessionDir(configDir, cwd, "sess-9");
  const lead = writeJsonl(join(dir, "sess-9.jsonl"), [assistant("msg_1", usage(1, 1))]);
  assert.deepEqual(childTranscriptPaths({ configDir, cwd, sessionId: "sess-9" }), {
    lead,
    subagents: [],
  });
});

test("childTranscriptPaths falls back to scanning projects/*", () => {
  const configDir = tempRoot("cfg-scan");
  const cwd = tempRoot("cwd-scan");
  mkdirSync(join(configDir, "projects", "some-other-app"), { recursive: true });
  const lead = writeJsonl(join(configDir, "projects", "some-other-app", "sess-7.jsonl"), [
    assistant("msg_1", usage(1, 1)),
  ]);
  assert.deepEqual(childTranscriptPaths({ configDir, cwd, sessionId: "sess-7" }), {
    lead,
    subagents: [],
  });
});

test("childTranscriptPaths returns null without sessionId and when nothing is found", () => {
  const configDir = tempRoot("cfg-null");
  const cwd = tempRoot("cwd-null");
  mkdirSync(join(configDir, "projects"), { recursive: true });
  assert.equal(childTranscriptPaths({ configDir, cwd }), null);
  assert.equal(childTranscriptPaths({ configDir, cwd, sessionId: "absent" }), null);
  assert.equal(childTranscriptPaths({ sessionId: "sess-1" }), null);
});

test("priceChildTranscripts prices lead + subagents and reports transcriptPath", () => {
  const configDir = tempRoot("cfg-child");
  const cwd = tempRoot("cwd-child");
  const dir = sessionDir(configDir, cwd, "sess-5");
  const lead = writeJsonl(join(dir, "sess-5.jsonl"), [assistant("msg_1", usage(10, 10))]);
  const subagentsDir = join(dir, "sess-5", "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  writeJsonl(join(subagentsDir, "agent-a.jsonl"), [assistant("msg_2", usage(20, 0), "claude-y")]);

  const result = priceChildTranscripts({ configDir, cwd, sessionId: "sess-5" }, { priceOne, thresholdOne });
  assert.equal(result.transcriptPath, lead);
  assert.deepEqual(result.transcriptPaths, [lead]);
  assert.equal(result.messages, 2);
  assert.equal(result.files, 2);
  assert.equal(result.costUsd, (10 + 20) / 1_000_000 + 200 / 1_000_000);
});

test("priceChildTranscripts returns null when no transcript exists", () => {
  const configDir = tempRoot("cfg-child-null");
  const cwd = tempRoot("cwd-child-null");
  mkdirSync(join(configDir, "projects"), { recursive: true });
  assert.equal(priceChildTranscripts({ configDir, cwd, sessionId: "absent" }, { priceOne, thresholdOne }), null);
  assert.equal(priceChildTranscripts({ configDir, cwd, sessionIds: ["absent"] }, { priceOne, thresholdOne }), null);
});

test("sessionIds: both session files are priced together, a shared message id counts once", () => {
  const configDir = tempRoot("cfg-two-sessions");
  const cwd = tempRoot("cwd-two-sessions");
  const dir = sessionDir(configDir, cwd, "sess-lead");
  // A resume that forked a new session id: the lead file and the resumed file
  // share one message id (the resumed turn re-emits it) and each carries its
  // own message the other does not have.
  const leadA = writeJsonl(join(dir, "sess-lead.jsonl"), [
    assistant("msg_A1", usage(10, 10)),
    assistant("msg_shared", usage(100, 0)),
  ]);
  const leadB = writeJsonl(join(dir, "sess-resumed.jsonl"), [
    assistant("msg_shared", usage(100, 0)), // same id, same counters — MAX merge
    assistant("msg_B1", usage(0, 50)),
  ]);

  const result = priceChildTranscripts(
    { configDir, cwd, sessionId: "sess-lead", sessionIds: ["sess-resumed"] },
    { priceOne, thresholdOne },
  );
  assert.equal(result.files, 2, "both files were read");
  assert.equal(result.messages, 3, "the shared message id merged into ONE message");
  // msg_A1 (10*1 + 10*2) + msg_shared once (100*1) + msg_B1 (50*2)
  assert.equal(result.costUsd, (10 + 20 + 100 + 100) / 1_000_000);
  assert.equal(result.transcriptPath, leadA, "the FIRST id's lead names transcriptPath");
  assert.deepEqual(result.transcriptPaths, [leadA, leadB]);
});

test("sessionIds: duplicates between sessionId and sessionIds dedupe to one lookup", () => {
  const configDir = tempRoot("cfg-dup-ids");
  const cwd = tempRoot("cwd-dup-ids");
  const dir = sessionDir(configDir, cwd, "sess-dup");
  const lead = writeJsonl(join(dir, "sess-dup.jsonl"), [assistant("msg_1", usage(10, 0))]);

  const result = priceChildTranscripts(
    { configDir, cwd, sessionId: "sess-dup", sessionIds: ["sess-dup"] },
    { priceOne, thresholdOne },
  );
  // The same file priced twice would double-count the idless-line case — and
  // here would report files: 2.
  assert.equal(result.files, 1);
  assert.equal(result.costUsd, 10 / 1_000_000);
  assert.deepEqual(result.transcriptPaths, [lead]);
});
