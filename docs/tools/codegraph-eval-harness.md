# codegraph-eval-harness — report schema (FOC-627)

Consumer contract for FOC-621. Everything below is what one invocation of

```bash
node scripts/codegraph-eval-harness.mjs [--eval <path>] [--out <path>] [--db <path>] [--json]
```

emits — no need to read the implementation. The eval set itself is
`scripts/codegraph-eval-set.json` (frozen corpus of real recorded CodeGraph queries;
identifiers only, per the FOC-220 privacy rule).

## What the harness does

For each eval-set entry it replays the recorded trajectory: the `tool_facts` row named
by `tool_fact_id`, the later tool facts of the same `run_id` + `agent_key`, the tool
result and the assistant prose read from the transcript at the recorded
`source_path:source_offset`. Freshness and returned identifiers are derived with
`deriveCodegraphCapture` (via `captureFromRecord`); the outcome class is derived with
`attributeQueries` from `scripts/codegraph-trajectory.mjs` — the one implementation of
the vocabulary, never a forked copy. The harness does NOT read or write
`codegraph_query_facts`; it derives everything from `tool_facts` + transcripts, so it
works for queries recorded before FOC-624 capture started.

The telemetry DB is opened read-only (with a temp-copy fallback if a WAL-mode file
refuses a read-only open); the real invocation writes nothing to the live DB.

## Exit codes

| code | meaning |
|---|---|
| 0 | report produced |
| 2 | eval-set provenance violations (each listed on stderr with the offending entry id) or harness misuse |
| 3 | the telemetry DB could not be opened read-only and the temp-copy fallback failed |

## Report JSON (top level)

```jsonc
{
  "report": "codegraph-eval-harness",   // literal discriminator
  "schemaVersion": 1,
  "evalSet": "<path as passed to --eval>",  // traceability; not machine-dependent otherwise
  "evalSetDescription": "<the eval set's own description string>",
  "byOutcome":   { ... },               // see Aggregates
  "byTool":      { ... },               // see Aggregates
  "tokenUsage":  { ... },               // see Aggregates
  "queries":     [ ... ]                // one row per eval-set entry, in eval-set order
}
```

There is deliberately NO wall-clock field (no `generatedAt`, no elapsed time) and NO
collapsed success number (`successRate`, `score`, … are absent by contract): two runs
over an unchanged tree produce a byte-identical report, and the four outcome classes are
the deliverable, never their sum.

## `queries[]` — per-query fields

| field | type | meaning |
|---|---|---|
| `id` | string | the eval-set entry id (e.g. `q-explore-claude-command`) |
| `toolFactId` | string | the 40-hex provenance key naming exactly which recorded query this came from (= `tool_facts.tool_fact_id`) |
| `tool` | string | short tool name: `explore` \| `node` \| `impact` \| `files` \| `status` |
| `runId` | string | the recorded run the query belongs to |
| `agentKey` | string | `_lead` or the subagent key |
| `args` | object | the recorded query arguments, verbatim from `tool_facts.tool_input` |
| `grading` | object | `{ kind: "reference" \| "rubric", mustName: string[] }` — echo of the eval-set grading contract |
| `outcome` | string | `answered` \| `fallback` \| `unused` \| `unknown` — the trajectory's graded class (see below) |
| `freshness` | string | `fresh` \| `stale` \| `unknown` — index freshness AT QUERY TIME, as recorded semantics derive it |
| `graphAnswered` | boolean | whether the recorded result was a recognised CodeGraph answer with content |
| `returnedIdentifiers` | object | `{ files: string[], symbols: string[] }` — what the result returned (identifiers only, FOC-220) |
| `usedIdentifiers` | object | `{ files: string[], symbols: string[] }` — which of those were later named by a tool call or the turn's prose |
| `returnedCount` | number | `files + symbols` returned |
| `usedCount` | number | `files + symbols` used |
| `trajectoryToolCalls` | number | the query plus the tool facts that follow it in the same run+agent |
| `issuingTurnUsage` | object \| null | `{ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }` from the transcript's `message.usage` of the assistant turn that issued the query; `null` when the transcript records no usage block. FACT, not a metric: this is the issuing TURN's cost (context and all), not attributable to the query alone. |

### Outcome semantics (frozen, from `codegraph-trajectory.mjs attributeOne`)

Evidence-first, `answered` sticky:

- `answered` — at least one returned identifier was later named by a tool call or the
  turn's prose. Evidence of use wins outright.
- `fallback` — the graph produced no usable answer (`graphAnswered` false) and the agent
  went on to read files (a later Read/Edit/Write/Grep/Glob).
- `unused` — the agent kept working past the query but never named anything the result
  contained.
- `unknown` — nothing at all follows the query; "not used" would be a claim without
  evidence.

## Aggregates

`byOutcome` — counts per outcome class, always carrying all four keys
(`answered`/`fallback`/`unused`/`unknown`), even when zero.

`byTool` — sorted by tool name; each value is `{ count, byOutcome }` with the same
all-four-keys shape. The per-tool breakdowns are where the honest failures live (e.g.
node/impact queries currently grade `fallback`/`unused` because the FOC-624 capture
vocabulary recognises only the `explore` render).

`tokenUsage` — `{ entriesWithIssuingTurnUsage, note }`: how many entries carry a
recorded issuing-turn usage (the transcripts DO record `message.usage` per assistant
line), plus the scope caveat. No aggregate token number is computed — a sum over issuing
turns is not a query cost.

## Determinism

No wall-clock fields; entry order follows the eval set; `byTool` keys are sorted; SQL
reads are ordered (`ORDER BY source_offset, tool_index`). Two runs over an unchanged
tree and unchanged transcripts produce byte-identical output — verified by
`scripts/codegraph-eval-harness.test.mjs`.