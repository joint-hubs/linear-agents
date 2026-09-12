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
// FOC-220: equivalence at EVERY depth, not just the top level.
check("nested key order does not change the identity",
  normaliseArgs('{"a":{"c":1,"b":2},"d":[1,2]}') === normaliseArgs('{"d":[1,2],"a":{"b":2,"c":1}}'));
check("deeply nested key order does not change the identity",
  normaliseArgs('{"x":{"y":{"k":1,"j":2}}}') === normaliseArgs('{"x":{"y":{"j":2,"k":1}}}'));
check("nested VALUE changes still differ",
  normaliseArgs('{"a":{"b":1}}') !== normaliseArgs('{"a":{"b":2}}'));
check("array order is semantic and stays significant",
  normaliseArgs('{"a":[1,2]}') !== normaliseArgs('{"a":[2,1]}'));

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

// --- FOC-220: repeat categories, honest outcomes, stable ordering ----------
// Richer fixture: the fields the canonical view exposes after FOC-220. All are
// needed by the classifier, which must never fabricate a category without them.
const factRow = (over = {}) => ({
  run_id: "r1", agent_key: "a1", squad: "dev", model: "m1",
  tool_name_canon: "read_file", tool_input: '{"file_path":"x"}',
  tool_has_error: 0, tool_result_state: null, tool_result_id: null, tool_result_bytes: null,
  tool_input_id: null, tool_fact_id: null, observed_at: null,
  source_path: "/t.jsonl", source_offset: 0, tool_index: 0,
  ...over,
});
let seq = 0;
const at = (n) => `2026-09-12T10:00:${String(n).padStart(2, "0")}.000Z`;
const fact = (over = {}) =>
  factRow({ tool_fact_id: `f${++seq}`, source_offset: seq, observed_at: at(seq), ...over });

// Read → Edit(same file) → Read: the reread is justified, not waste.
let rows = [
  fact({ tool_name_canon: "read_file" }),
  fact({ tool_name_canon: "edit_file", tool_input: '{"file_path":"x"}' }),
  fact({ tool_name_canon: "read_file" }),
];
res = analyseToolCalls(rows);
check("Read→Edit→Read is reread_after_edit, not waste",
  res.totals.repeatCategories.reread_after_edit === 1 && res.totals.repeatCategories.unchanged === 0,
  JSON.stringify(res.totals.repeatCategories));
check("reread evidence names the intervening mutation",
  res.details.length === 1 && res.details[0].category === "reread_after_edit" &&
  res.details[0].evidence.mutatedBy?.tool_fact_id === "f2" && res.details[0].evidence.path === "x",
  JSON.stringify(res.details[0]));

// Test rerun after a code change: Bash twice, an Edit on ANOTHER file between.
rows = [
  fact({ tool_name_canon: "bash", tool_input: '{"command":"npm test"}' }),
  fact({ tool_name_canon: "edit_file", tool_input: '{"file_path":"code.js"}' }),
  fact({ tool_name_canon: "bash", tool_input: '{"command":"npm test"}' }),
];
res = analyseToolCalls(rows);
check("repeat after an intervening mutation is rerun_after_change",
  res.totals.repeatCategories.rerun_after_change === 1,
  JSON.stringify(res.totals.repeatCategories));

// An intervening mutation is the strongest evidence and wins even when the
// result digest happens to be equal: the agent re-ran after a change it could
// observe, so the repeat is justified whether or not the output moved.
rows = [
  fact({ tool_name_canon: "read_file", tool_result_id: "digest-1", tool_result_bytes: 10, tool_result_state: "ok" }),
  fact({ tool_name_canon: "edit_file", tool_input: '{"file_path":"other.js"}' }),
  fact({ tool_name_canon: "read_file", tool_result_id: "digest-1", tool_result_bytes: 10, tool_result_state: "ok" }),
];
res = analyseToolCalls(rows);
check("an intervening mutation outranks an equal result digest",
  res.totals.repeatCategories.rerun_after_change === 1 && res.totals.repeatCategories.unchanged === 0,
  JSON.stringify(res.totals.repeatCategories));

// Polling: no mutation, result digests differ → the world moved.
rows = [
  fact({ tool_name_canon: "bash", tool_input: '{"command":"git status"}', tool_result_id: "d1", tool_result_bytes: 100, tool_result_state: "ok" }),
  fact({ tool_name_canon: "bash", tool_input: '{"command":"git status"}', tool_result_id: "d2", tool_result_bytes: 130, tool_result_state: "ok" }),
];
res = analyseToolCalls(rows);
check("polling whose result changed is result_changed, not waste",
  res.totals.repeatCategories.result_changed === 1 && res.totals.repeatCategories.unchanged === 0,
  JSON.stringify(res.totals.repeatCategories));
check("result_changed evidence carries both sizes",
  res.details[0].evidence.priorBytes === 100 && res.details[0].evidence.bytes === 130,
  JSON.stringify(res.details[0].evidence));

// Same poll, byte-identical result, nothing in between → the ONE honest waste.
rows = [
  fact({ tool_name_canon: "bash", tool_input: '{"command":"git status"}', tool_result_id: "d1", tool_result_state: "ok" }),
  fact({ tool_name_canon: "bash", tool_input: '{"command":"git status"}', tool_result_id: "d1", tool_result_state: "ok" }),
];
res = analyseToolCalls(rows);
check("identical args + identical result + no mutation is unchanged",
  res.totals.repeatCategories.unchanged === 1, JSON.stringify(res.totals.repeatCategories));

// No result digests (pre-FOC-220 rows), no mutation → unknown, never guessed.
rows = [fact(), fact()];
res = analyseToolCalls(rows);
check("without evidence the category is unknown, not waste",
  res.totals.repeatCategories.unknown === 1 && res.totals.repeatCategories.unchanged === 0,
  JSON.stringify(res.totals.repeatCategories));
check("unknown evidence says why",
  typeof res.details[0].evidence.reason === "string", JSON.stringify(res.details[0]));

// A mutation observed between two digest-less repeats is still classifiable.
rows = [
  fact({ tool_name_canon: "read_file" }),
  fact({ tool_name_canon: "edit_file", tool_input: '{"file_path":"x"}' }),
  fact({ tool_name_canon: "read_file" }),
];
res = analyseToolCalls(rows);
check("mutation evidence works without result digests",
  res.totals.repeatCategories.reread_after_edit === 1, JSON.stringify(res.totals.repeatCategories));

// --- honest outcomes: missing/never-measured is not ok ---------------------
res = analyseToolCalls([
  fact({ tool_result_state: "ok" }),
  fact({ tool_result_state: "missing" }),
  fact(),                       // historical: state NULL, has_error 0
  fact({ tool_has_error: 1, tool_result_state: "error" }),
]);
check("outcome unknown counts missing and never-measured, not ok or error",
  res.totals.outcomeUnknown === 2 && res.totals.errors === 1,
  `unknown=${res.totals.outcomeUnknown} errors=${res.totals.errors}`);
check("outcome unknown reaches the dimension entries",
  res.byAgent.get("a1")?.outcomeUnknown === 2, `got ${res.byAgent.get("a1")?.outcomeUnknown}`);

// --- grouping on the full-input identity -----------------------------------
// Two calls sharing a 1000-char preview prefix but differing at the tail must
// NOT be grouped when identities exist (and must be, on preview fallback).
const longPrefix = JSON.stringify({ file_path: "/d/" + "x".repeat(1100) });
res = analyseToolCalls([
  fact({ tool_input: longPrefix.slice(0, 1000), tool_input_id: "id-A", source_offset: 1 }),
  fact({ tool_input: longPrefix.slice(0, 1000), tool_input_id: "id-B", source_offset: 2 }),
]);
check("distinct identities with an identical preview are not grouped",
  res.totals.repeats === 0, `repeats=${res.totals.repeats}`);
res = analyseToolCalls([
  fact({ tool_input: longPrefix.slice(0, 1000), tool_input_id: "id-A", source_offset: 1 }),
  fact({ tool_input: longPrefix.slice(0, 1000), tool_input_id: "id-A", source_offset: 2 }),
]);
check("same identity groups even when the preview is truncated",
  res.totals.repeats === 1, `repeats=${res.totals.repeats}`);

// --- stable TOTAL ordering, independent of input row order -----------------
// 8 rows across groups with distinct categories. Any permutation of the input
// must yield byte-identical aggregate AND detail output — that is what makes
// the details inspectable as an ordered artifact.
const orderingRows = [
  fact({ tool_name_canon: "read_file" }),                                        // f1
  fact({ tool_name_canon: "edit_file", tool_input: '{"file_path":"x"}' }),       // f2
  fact({ tool_name_canon: "read_file" }),                                        // f3 reread_after_edit
  fact({ tool_name_canon: "bash", tool_input: '{"command":"git status"}', tool_result_id: "d1", tool_result_state: "ok" }), // f4
  fact({ tool_name_canon: "bash", tool_input: '{"command":"git status"}', tool_result_id: "d2", tool_result_state: "ok" }), // f5 result_changed
  fact({ tool_name_canon: "bash", tool_input: '{"command":"npm test"}' }),       // f6
  fact({ tool_name_canon: "edit_file", tool_input: '{"file_path":"code.js"}' }), // f7
  fact({ tool_name_canon: "bash", tool_input: '{"command":"npm test"}' }),       // f8 rerun_after_change
];
const fingerprint = (result) => JSON.stringify({ totals: result.totals, details: result.details });
const baseline = fingerprint(analyseToolCalls(orderingRows));
let permutationsAgree = true;
for (let seed = 1; seed <= 5; seed++) {
  let state = seed * 7919;
  const rnd = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const shuffled = [...orderingRows];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  if (fingerprint(analyseToolCalls(shuffled)) !== baseline) permutationsAgree = false;
}
check("shuffled input rows produce identical output (totals + ordered details)", permutationsAgree);
check("details are listed in the stable fact order",
  [...analyseToolCalls(orderingRows).details].every((d, i, arr) =>
    i === 0 || `${arr[i - 1].observed_at}|${arr[i - 1].source_offset}` <= `${d.observed_at}|${d.source_offset}`),
  "details must be non-decreasing in (observed_at, source_offset)");
check("every repeat detail carries its category and evidence",
  analyseToolCalls(orderingRows).details.every((d) => d.kind === "repeat" && d.category && d.evidence && d.tool_fact_id),
  "kind/category/evidence/fact id are the inspection contract");

// The final key of the order is load-bearing on real data: two tool_use blocks
// in ONE transcript line share observed_at, source_path, source_offset and
// tool_index, and differ only by tool_fact_id. Every fixture above gives each
// row a distinct (observed_at, source_offset), so the tie is never exercised.
// Fed in REVERSE fact order, the order — not the input array or SQLite's
// return order — must decide which fact is the origin and which the repeat.
const tieAt = "2026-09-12T11:00:00.000Z";
const tieA = fact({ tool_fact_id: "f-tie-a", observed_at: tieAt, source_offset: 900, tool_result_id: "d-tie", tool_result_state: "ok" });
const tieB = fact({ tool_fact_id: "f-tie-b", observed_at: tieAt, source_offset: 900, tool_result_id: "d-tie", tool_result_state: "ok" });
res = analyseToolCalls([tieB, tieA]);
check("a full (observed_at, path, offset, index) tie is broken by tool_fact_id",
  res.totals.repeats === 1 && res.details.length === 1 &&
  res.details[0].tool_fact_id === "f-tie-b" &&
  res.details[0].evidence.comparedTo === "f-tie-a",
  JSON.stringify(res.details[0]));
check("tie output (totals + details) is invariant to input row order",
  fingerprint(analyseToolCalls([tieA, tieB])) === fingerprint(analyseToolCalls([tieB, tieA])),
  "the order must come from the row, not from the input array");

console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  process.exit(1);
}
