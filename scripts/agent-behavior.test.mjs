// Contract test for the behavioural metrics.
//
// The whole point of this module is that "the same call twice" is detected
// despite JSON key order, and that repeats are scoped to one agent inside one
// run. Both are easy to get subtly wrong in a way that still produces a
// plausible-looking percentage, so they are asserted directly.

import { analyseToolCalls, normaliseArgs } from "./agent-behavior.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) { passed++; return; }
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// --- normaliseArgs -------------------------------------------------------
check("key order does not change the identity",
  normaliseArgs('{"limit":1,"offset":608}') === normaliseArgs('{"offset":608,"limit":1}'));
check("different values stay different",
  normaliseArgs('{"offset":608}') !== normaliseArgs('{"offset":609}'));
check("non-JSON input survives", normaliseArgs("not json") === "not json");
check("empty input is empty", normaliseArgs("") === "" && normaliseArgs(null) === "");

// --- analyseToolCalls ----------------------------------------------------
const row = (over = {}) => ({
  run_id: "r1", agent_key: "a1", squad: "dev", model: "m1",
  tool_name_canon: "read_file", tool_input: '{"file_path":"x"}', tool_has_error: 0, ...over,
});

// Three identical calls by one agent = two repeats.
let res = analyseToolCalls([row(), row(), row()]);
check("three identical calls yield two repeats", res.totals.repeats === 2, `got ${res.totals.repeats}`);
check("call count is preserved", res.totals.calls === 3, `got ${res.totals.calls}`);

// Same call, but written with keys in the other order — still a repeat.
res = analyseToolCalls([row(), row({ tool_input: '{"file_path":"x"}' }), row({ tool_input: '{ "file_path" : "x" }' })]);
check("reordered/whitespaced JSON counts as the same call", res.totals.repeats === 2, `got ${res.totals.repeats}`);

// Two DIFFERENT agents making the same call is collaboration, not a loop.
res = analyseToolCalls([row(), row({ agent_key: "a2" })]);
check("same call by two agents is not a repeat", res.totals.repeats === 0, `got ${res.totals.repeats}`);

// The same agent making the same call in two different runs is not a loop.
res = analyseToolCalls([row(), row({ run_id: "r2" })]);
check("same call across two runs is not a repeat", res.totals.repeats === 0, `got ${res.totals.repeats}`);

// Different arguments are different work.
res = analyseToolCalls([row(), row({ tool_input: '{"file_path":"y"}' })]);
check("different arguments are not repeats", res.totals.repeats === 0, `got ${res.totals.repeats}`);

// Errors count per call, not per group — three identical failing calls are three errors.
res = analyseToolCalls([row({ tool_has_error: 1 }), row({ tool_has_error: 1 }), row({ tool_has_error: 1 })]);
check("errors count every call, not every group", res.totals.errors === 3, `got ${res.totals.errors}`);
check("error attribution reaches the model dimension",
  res.byModel.get("m1")?.errors === 3, `got ${res.byModel.get("m1")?.errors}`);

// Dimensions carry both counters. All three calls are identical, so they form
// ONE group spanning two models — model is not part of the grouping key,
// because switching model mid-loop does not make it stop being a loop.
res = analyseToolCalls([row(), row(), row({ model: "m2", tool_has_error: 1 })]);
check("model dimension splits calls", res.byModel.get("m1").calls === 2 && res.byModel.get("m2").calls === 1);
// The 2nd and 3rd calls are both repeats; the 3rd ran on m2, so m2 owns it.
// Attributing the whole group to its first row would hide m2's wasted call.
check("each repeat is charged to the model that made it",
  res.byModel.get("m1").repeats === 1 && res.byModel.get("m2").repeats === 1,
  `m1=${res.byModel.get("m1").repeats} m2=${res.byModel.get("m2").repeats}`);
check("squad dimension aggregates across models", res.bySquad.get("dev").calls === 3);

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
