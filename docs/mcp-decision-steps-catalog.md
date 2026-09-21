---
type: design-doc
status: active
audience: Mateusz, supervisor/plan developers, kontrybutorzy
tags: [type/design-doc, area/ai, topic/mcp, topic/decisions, topic/supervisor, topic/cost]
created: 2026-09-19
source: ADR-0012 (D1–D6), ADR-0009 amendment 2026-09-19 (task-size scenarios), docs/plans/fenix-architecture-gaps-2026-09-19.md (GAPS), scripts/mcp/*.mjs, scripts/mcp-shadow-run.test.mjs
---

# MCP decision-step family — catalog and build status (FOC-401)

ADR-0012 D6 filed this catalog+build child under the FOC-380 epic. The pattern it implements is
ADR-0012 D5: a decision-shaped **[J]** step runs inside an MCP server; the model may think but must
end with a schema-validated typed JSON; **the caller receives only that final JSON** — intermediate
reasoning never reaches the Supervisor's context. Two of the family's steps are **built** here
(`extraction`, `prompt-refinement`); the rest are **catalog-only** entries with draft schemas, tier
assignments and integration points, ready to be pulled into build children one by one.

Built code (the executable source of truth for the two built steps):
`scripts/mcp/steps.mjs` (schemas + Jev mapping), `scripts/mcp/envelope.mjs` (fail-closed envelope),
`scripts/mcp/provider-jev.mjs` (tier-1 transport + strict parsers), `scripts/mcp/provider-offline.mjs`
(deterministic path), `scripts/mcp/jsonrpc.mjs` (minimal MCP surface), `scripts/mcp/server-*.mjs`
(the two servers), `scripts/mcp/shadow-run.mjs` (evidence run).

## How to read a catalog entry

Every step below carries the same four fields — **input schema (JSON Schema), output schema (JSON
Schema), model tier, where it plugs into the supervisor flow** — because those are the four things a
build child needs and the four things the graph.json v2 step schema (FOC-396) will reference.

- **The [J] shape (ADR-0012 D1/D5).** The deterministic part of the work stays code; the model only
  verifies/scores/classifies/routes (GAPS §3.2). The model may think, but the step ends with
  schema-validated typed JSON, and outputs stay SHORT.
- **Fail-closed.** Every call validates its input against the step's input schema, then validates
  the model's result against the step's output schema BEFORE returning. A provider error, an
  unparseable response, or a schema-invalid result becomes one typed error envelope — never a silent
  degrade, never partial data. The HITL/relay path is the CALLER's fallback; the server's job ends
  at the typed error.
- **Confidence rule (ADR-0012 D3.6, FIXED).** Confidence comes only from measured sources — tier-1
  native Decisions-API probabilities or tier-2 logprobs; otherwise `null`. Never estimated, never
  fabricated. A `null` confidence is an honest answer, not a failure.
- **Validators per runtime (ADR-0012 D5/Q9a).** Pydantic in Python MCP processes; **zod/ajv in
  Node**. This repo validates with **ajv ^8.20.0** — promoted from a transitive lockfile entry to a
  declared dependency in `package.json` (the only new dependency of FOC-401). No JSON-Schema
  validator is hand-rolled, and `@modelcontextprotocol/sdk` is deliberately NOT adopted: the MCP
  surface a decision server needs is `initialize` / `tools/list` / `tools/call` over newline-delimited
  stdio JSON-RPC 2.0 — hand-rolled in `scripts/mcp/jsonrpc.mjs` (~120 lines, zero new deps).
- **Tier cascade (ADR-0012 D2).** Tier 1 = Jev via `POST /api/alpha/decisions` (pinned
  `typesafe/jev-1.13`, never a `~latest` alias); tier 2 = non-thinking model with logprobs +
  structured output; tier 3 = Claude, where typed output without confidence suffices (Claude exposes
  no logprobs — GAPS §2.2). Escalation direction is fixed (lower confidence or error → one rung up →
  the human); threshold VALUES stay deferred until the ECE/Brier calibration task lands.

### Measured alpha contract (live probes, 2026-09-19) — the shape changed the same day

GAPS §2.3 recorded the Decisions API with `questions`/`answers` as ARRAYS on the morning of
2026-09-19. The same day's live probes against `typesafe/jev-1.13` measured the contract as RECORDS:

- request `questions`: a record keyed by question id — `{q0: {type, instructions, criteria}}`;
  an array is rejected with HTTP 400 ("expected record, received array");
- `criteria`: a record of label → description; a `noul` question's labels are exactly
  `"true"` / `"false"`;
- response `answers`: a record keyed by the same ids — a noul answer is
  `{type:"noul", noul: <probability>}`; a choice answer is
  `{type:"choice", choice, probabilities: {...}, confidence}`;
- the response names the resolved model build (`typesafe/jev-1.13-20260917` at probe time), plus
  `usage.cost` and the provider name.

This is precisely the "endpoint jest **alpha** — format i trasa mogą się zmienić" risk ADR-0012
D4/Q7c names as the **Path B trigger**, observed in the wild on day one. The mapping therefore
fail-closes on ANY shape mismatch (typed `unparseable_output`), the old array shape has a regression
test in `scripts/mcp-extraction.test.mjs` and `scripts/mcp-prompt-refinement.test.mjs`, and the
resolved build is carried in the envelope's `model` field (the pinned version stays in the decision
record, per ADR-0012 D3.5). Latency/cost measured in GAPS §2.3 still holds: ~0.3–0.5 s, ~$0.02 per
1,000 decisions.

## Shared envelope and error codes

Every decision call returns one envelope — the ONLY thing that crosses the MCP boundary
(`scripts/mcp/envelope.mjs`):

```
{ ok:true,  step, tier, model, mode:"live"|"offline", decision, confidence, measuredAt, durationMs }
{ ok:false, step, tier, model, mode, error:{ code, message }, measuredAt, durationMs }
```

Error messages carry schema paths and statuses, never provider or prompt content — inputs and
outputs may carry user-dictated text, so nothing of it may leak through the error path. Every
piece of provider-originated (or caller-copied) text that reaches an error message goes through
`scripts/mcp/scrub.mjs` first: key-shaped material (Authorization/Bearer values, tokenized URL
params, `sk-` keys) is masked and the result is capped at `MAX_ERROR_TEXT` (120 chars). That
covers provider TypedError messages, the catch-all echo of an unexpected provider crash, a
transport/fetch failure reason, the JSON-RPC parse detail for a malformed line, and — since
FOC-443 — the schema-path summaries of `invalid_input` and `schema_invalid`, whose paths quote
caller-named keys verbatim. Messages composed entirely in the repo (`unknown tool`, HTTP
status-only reasons, timeouts) are not provider text; the status-only trigger of `provider_error`
stays untouched by design. Scrubbing only removes text; the error codes and the envelope shape
are unchanged (FOC-417, FOC-443).

| code | meaning | typical trigger |
|---|---|---|
| `invalid_input` | the caller's arguments failed the step's input schema | missing/empty/oversized fields, unknown properties |
| `auth_missing` | provider credentials absent from the environment | `OPENROUTER_API_KEY` unset on a live call |
| `provider_error` | the provider call failed | network error, timeout (30 s), non-2xx status — status only, never the body |
| `unparseable_output` | the provider response could not be parsed into the expected shape | alpha shape change, missing `noul` probability, unknown choice label |
| `schema_invalid` | the parsed result failed the step's output schema | the model's JSON violates the typed output contract |

Over the MCP protocol boundary (`scripts/mcp/jsonrpc.mjs`) an `ok:false` envelope becomes a
`tools/call` result with `isError: true` whose text IS the typed error — the fail-closed contract
survives the transport. `confidence` outside [0,1] normalizes to `null` (measured-or-nothing).

## extraction — BUILD

Dictated free text in (dictation corrupts words: the kickoff's own sample is *"kif i czeryf"* for
*feature*), a short typed JSON of expected features out.

- **Where it plugs in:** the very first [J] step of a supervised run — the Supervisor feeds the
  user's dictated kickoff text and receives the typed feature list BEFORE triage
  (`scripts/supervisor-triage.mjs` consumes typed inputs), instead of re-reading raw prose into its
  own context (the 39.7%-share context, GAPS §2.9). **Not wired yet** — the wiring point is the
  graph runner (FOC-397); this child ships the server only.
- **Tier:** tier-1 Jev, one `noul` question per code-split candidate; measured confidence per
  verified feature; envelope confidence = min over per-answer certainty, where the certainty of a
  binary verdict is `max(p, 1−p)` — a confident rejection carries high confidence, so a bare
  `min(p)` over all answers would report the rejection's probability-of-wrongness as confidence.
- **[D] half:** the candidate split is deterministic code (`splitCandidates` — newline / semicolon /
  comma / common PL+EN conjunctions, duplicate-neighbour collapse, cap 12). It is deliberately naive
  and replaceable: the model's per-candidate verification absorbs the splitter's noise, per
  Jev §3.1 "the deterministic part stays code".
- **Confidence reading caveat:** `p > 0.5` is the coin-flip reading of the native probability, NOT a
  calibrated threshold — auto-fire thresholds stay deferred until calibration (ADR-0012 D2, Q4a;
  GAPS §2.3 measured `answerable_from_docs` 0.61–0.73, an anecdote). Consumers treat the decision as
  a proposal carrying its measurement.

Input schema (JSON Schema; executable copy in `scripts/mcp/steps.mjs`):

```json
{
  "type": "object",
  "required": ["text"],
  "additionalProperties": false,
  "properties": {
    "text": { "type": "string", "minLength": 1, "maxLength": 8000 },
    "language": { "type": "string", "enum": ["pl", "en", "auto"] }
  }
}
```

Output schema (JSON Schema):

```json
{
  "type": "object",
  "required": ["features"],
  "additionalProperties": false,
  "properties": {
    "features": {
      "type": "array", "minItems": 0, "maxItems": 12,
      "items": {
        "type": "object",
        "required": ["name", "kind"],
        "additionalProperties": false,
        "properties": {
          "name": { "type": "string", "minLength": 1, "maxLength": 120 },
          "kind": { "enum": ["feature"] },
          "confidence": { "type": ["number", "null"], "minimum": 0, "maximum": 1 }
        }
      }
    },
    "notes": { "type": ["string", "null"], "maxLength": 300 }
  }
}
```

Offline path (no key, no model call): the [D] split's candidates are returned as unverified
features, `mode: "offline"`, confidence `null` — and the record says so (`notes` carries the
offline label). An offline record is never presented as a model answer.

## prompt-refinement — BUILD

A drafted squad prompt (plus optional per-feature sizes) in; the ADR-0009 amendment's engagement
size, the derived squad engagement and per-feature relations out.

- **Where it plugs in:** immediately after extraction, feeding the ADR-0009 amendment routing
  (2026-09-19, FOC-383): the classified size picks the engagement depth. **Not wired yet** — the
  consumer is supervisor-runtime routing (FOC-397); this child ships the server only.
- **Tier:** tier-1 Jev — one `choice` question for the size, one `choice` per feature relation;
  measured confidences; envelope confidence = min over measured answers.
- **[D] half:** the size → squads map is code, not a model opinion (`squadsForSize`):

| classified size | engagement (ADR-0009 amendment) |
|---|---|
| small | no squads — the Supervisor does the work itself |
| medium | DEV + TEST |
| large | full triage PLAN → DEV → REVIEW → TEST |

In every scenario the Supervisor keeps its standing duties (overseeing the run, Linear issue
management, state files).

- **`rationale` stays `null`:** the Decisions API returns measured choices, not prose — a synthesized
  rationale would be fabricated text (D3.6 spirit). If a rationale is ever needed it must come from a
  measured source or a different tier.

Input schema (JSON Schema; executable copy in `scripts/mcp/steps.mjs`):

```json
{
  "type": "object",
  "required": ["prompt"],
  "additionalProperties": false,
  "properties": {
    "prompt": { "type": "string", "minLength": 1, "maxLength": 8000 },
    "features": {
      "type": "array", "maxItems": 8,
      "items": {
        "type": "object",
        "required": ["name"],
        "additionalProperties": false,
        "properties": {
          "name": { "type": "string", "minLength": 1, "maxLength": 120 },
          "size": { "enum": ["small", "medium", "large"] }
        }
      }
    }
  }
}
```

Output schema (JSON Schema):

```json
{
  "type": "object",
  "required": ["size", "squads"],
  "additionalProperties": false,
  "properties": {
    "size": { "enum": ["small", "medium", "large"] },
    "squads": {
      "type": "array", "maxItems": 4, "uniqueItems": true,
      "items": { "enum": ["plan", "dev", "review", "test"] }
    },
    "relations": {
      "type": "array", "maxItems": 8,
      "items": {
        "type": "object",
        "required": ["name", "relation"],
        "additionalProperties": false,
        "properties": {
          "name": { "type": "string", "minLength": 1, "maxLength": 120 },
          "relation": { "enum": ["standalone", "extension", "alternative"] }
        }
      }
    },
    "rationale": { "type": ["string", "null"], "maxLength": 300 },
    "confidence": { "type": ["number", "null"], "minimum": 0, "maximum": 1 }
  }
}
```

## repo-state recon — CATALOG ONLY, OPEN QUESTION (documented, not resolved)

Recon before spawn: which repo, which branch, what dirty state, which risks. Part of it is already
solved deterministically: the FOC-286 pinned-state prologue verifies worktree/branch/base-revision/
tree-state at spawn and pins them into the kickoff (FOC-272 measured 37% of child sessions
re-deriving that state). What remains is the JUDGMENT part — "what in this diff area is risky",
"which files does this issue actually touch". Who runs that judgment is an **open question**; a
documented open question IS this entry's deliverable, and nothing downstream may gate on it yet.

Candidate answers, with their costs:

1. **MCP decision server (same pattern as these two).** Strongest context isolation (D5), cheapest
   per call at tier 1 (~$0.02/1,000, GAPS §2.3). BUT a decision server has no repo access — it only
   sees what the caller sends — so the repo READING (git status, diff, file tree) must stay with the
   caller; the server would only classify a supplied summary. That splits recon into [D] gathering
   (scriptable) + [J] judging (server) — clean, but more moving parts and a new [D] gatherer to
   build and keep honest.
2. **Supervisor inline (the frontman reads the repo itself).** Zero new infrastructure — and exactly
   the cost shape this family exists to kill: routine reasoning inside the Supervisor's context, the
   39.7% token share (GAPS §2.9, corrected; $1,339/43.5% raw in ADR-0012 Context). Cheapest to
   build, most expensive to run; contradicts ADR-0012's stated goal.
3. **Squad agent (a [A] child in its own worktree, e.g. DEV recon).** Full tool access and fresh
   context per call; but the [A] shape is the expensive one (agent loop, GAPS §4) and DEV already
   carries a 38.1% corrected token share (GAPS §2.9) — recon is part of what built that. Also the
   slowest (process spawn + agent turns, seconds to minutes vs 0.3–0.5 s at tier 1).

Costs cite ADR-0012 Context/§D2 and GAPS §2.2–§2.3, §2.9. Recommendation-neutral by design: the
question goes back to Mateusz (or a later ADR) with the measured costs, not resolved here.

## Catalog-only family (no build in FOC-401)

Each entry below is a planned [J] step with a draft schema pair, tier and integration point —
build-ready briefs, not code. All inherit the shared envelope, fail-closed contract and confidence
rule above. "Tier 3" marks steps whose output is typed but whose confidence would be `null`
(Claude, no logprobs — GAPS §2.2).

### definition-of-done
Typed checklist of what "done" means for the issue, each item machine-checkable where possible.
- Input: `{ issue: {title, body}, features[] (from extraction) }` → Output:
  `{ criteria: [{check, kind: "test"|"lint"|"manual"|"linear", bounded: bool}], maxItems: 12 }`.
- Tier: 1 (classify/checklist-shape), tier 3 fallback for long-issue nuance. Plugs in: PLAN
  decomposition (agent-1-planner), consumed by TEST's done-assertion and the DEV hand-off.

### acceptance-criteria
Typed AC extraction with mapping targets, the shape the verdict record already carries
(`acMapping` — GAPS §2.5: 155 labeled mappings exist).
- Input: `{ issue: {title, body, comments?}, changedFiles[] }` → Output:
  `{ acs: [{id, text, mappedTo: "commit"|"test"|"artifact"|"none", evidence: string|null}], maxItems: 12 }`.
- Tier: 1 first (the 155-label dataset is the labeled base GAPS §5 calls for), calibration before
  any auto-fire. Plugs in: REVIEW verdict contract (already typed there — this step moves its
  creation earlier, at PLAN time).

### expected-behaviors
Expected behaviors/features as test-ready typed scenarios (happy path + named error cases).
- Input: `{ features[] (extraction output), issue: {body} }` → Output:
  `{ behaviors: [{given, when, then, kind: "happy"|"error"|"edge"}], maxItems: 16 }`.
- Tier: 1 for classification of pre-split candidates ([D] candidate split first, like extraction);
  tier 3 if generation beats classification here — measured before pinning. Plugs in: TEST
  scenario authoring (agent-4-test) and DEV's test-writing briefs.

### risks
Typed risk register per issue, severity-classified (feeds the 943-finding severity dataset, GAPS §5).
- Input: `{ issue: {title, body}, diffSummary, touchedAreas[] }` → Output:
  `{ risks: [{risk, severity: "blocking"|"major"|"nit", area, mitigation: string|null}], maxItems: 12 }`.
- Tier: 1 (severity classification is the family's best-labeled [J] — 943 labels). Plugs in: REVIEW
  findings triage and the escalation ladder (D2: low confidence → one rung up).

### security-requirements
Typed security requirements/controls for the change (auth surface, secrets handling, input
validation) — the REVIEW security pass's input contract.
- Input: `{ issue: {body}, changedFiles[], touches: ["auth"|"secrets"|"input"|"fs"|"network"|"shell"] }`
  → Output: `{ requirements: [{requirement, control, mandatory: bool}], maxItems: 12 }`.
- Tier: 3 (nuanced, low volume, typed-without-confidence acceptable); tier 1 only for the `touches`
  classification. Plugs in: REVIEW security pass briefing; the checklist AI-safety gates.

### security-tests
Typed test plan for the security requirements above — which test proves which control.
- Input: `{ requirements[] (security-requirements output) }` → Output:
  `{ tests: [{target, attack, expected: "reject"|"sanitize"|"contain", kind: "unit"|"e2e"}], maxItems: 12 }`.
- Tier: 3 (depends on the tier-3 requirements output). Plugs in: TEST squad's security scenarios.

### qa
Typed QA plan: what to verify, how, and what evidence each check leaves.
- Input: `{ features[], behaviors[], constraints[] }` → Output:
  `{ checks: [{what, how: "test"|"curl"|"ui"|"deploy", evidence, owner: "dev"|"test"|"mateusz"}], maxItems: 16 }`.
- Tier: 1 over code-split candidates, tier 3 for the whole-plan variant. Plugs in: the
  `delivery-loop` checklist (CLAUDE.md core behavior 2) as a typed record instead of prose.

### testing
Typed test-scope decision: which suites/runs a change requires — the counter-sin to running the
whole ~7-minute suite when `code-intel affected` names two files.
- Input: `{ changedFiles[], suites: [{name, runtimeSec, covers}] }` → Output:
  `{ run: [{suite, reason: "touches"|"contract"|"flaky-watch"}], skip: [{suite, reason}], maxItems: 24 }`.
- Tier: 1 (classification over a supplied suite inventory — the inventory itself is [D], produced by
  `code-intel affected`). Plugs in: DEV verify phase and the CI gate.

### out-of-scope
Typed boundary declaration: what the issue deliberately does NOT touch, so REVIEW's blast-radius
check has a machine-comparable claim.
- Input: `{ issue: {title, body}, plannedPaths[] }` → Output:
  `{ outOfScope: [{area, reason}], mustNotTouch: string[], maxItems: 12 }`.
- Tier: 1. Plugs in: REVIEW's diff-vs-`allowedPaths` audit (ADR-0009 §B records the paths; this adds
  the typed negative claim).

## Pricing-row findings (`config/models.json` untouched, by constraint)

Every model a server might route to needs a pricing row in `config/models.json`; missing rows are
findings to fix in a config child, NOT something these servers work around. Verified against
`config/models.json` `pricing.openrouter` on 2026-09-19:

1. **`typesafe/jev-1.13` — pricing row EXISTS (hand-pinned)** (tier 1, the family's primary tier).
   No row existed when this catalog was written (2026-09-19); FOC-386 added one on 2026-09-20
   (`config/models.json` `pricing.openrouter`: input 0.042, output 0, cacheRead 0 — matching the
   GAPS §2.3 economics of ~$0.042/M input, $0 output; ~$0.00002/call), so cost accounting through
   `config/models.json` prices tier-1 decision calls today (re-verified 2026-09-21). The row stays
   hand-pinned by necessity: the model is absent from the public `/api/v1/models` list (GAPS §2.3),
   so `scripts/price-check.mjs` cannot see it — a future price change must be edited by hand.
2. **`qwen3-30b-a3b-instruct` — NO pricing row** (tier-2 non-thinking+logprobs candidate, ADR-0012
   D2; measured live in GAPS §2.2: 0.9 s, 14 output tokens, saturated p=1.0000 on the easy probe).
3. **`anthropic/*` — rows EXIST** (claude-opus-5, claude-sonnet-4.6, claude-sonnet-5,
   claude-haiku-4.5 and the dated haiku variant all carry input/output/cacheRead): tier 3 is
   cost-accountable today.

## Shadow run evidence

`node scripts/mcp/shadow-run.mjs [--mode auto|live|offline]` runs BOTH servers end-to-end on
realistic dictated fixtures — through the real MCP message path (initialize → tools/list →
tools/call), no supervisor wiring — and writes `docs/mcp-decision-steps-shadow-run.json`.
`auto` goes live when `OPENROUTER_API_KEY` is set and offline otherwise; `live` without a key is
REFUSED (never faked); every record states its path explicitly, and an offline record is never
presented as a model answer. The committed evidence from 2026-09-19 is the **live** path:
3/3 calls ok at tier 1 (resolved build `typesafe/jev-1.13-20260917`), ~0.3–0.7 s per call — the
extraction fixtures verified the real Polish fragments and rejected the corrupted-dictation
fragments ("kif", "czeryf") with high certainty (envelope confidence 0.80 / 0.61, the min over
per-answer `max(p, 1−p)`), the refinement fixture classified with min-measured confidence 0.44.
Fixture content is synthetic; no real issue or conversation content is sent.

## Security notes

- **Auth is env-only** (`OPENROUTER_API_KEY`, per `config/models.json` providers.openrouter.authEnv);
  no key is ever logged, echoed into an error message, or written into evidence (the record carries
  only `present`/`absent`). Every message that carries provider-originated text goes through
  `scripts/mcp/scrub.mjs`, which masks key-shaped material and caps the text at 120 chars (FOC-417):
  a transport/fetch failure reason, the catch-all echo of an unexpected provider crash, the
  JSON-RPC parse detail, and — since FOC-443 — the schema-path summaries of `invalid_input` and
  `schema_invalid`, whose paths quote caller-named keys verbatim. Messages composed entirely in
  the repo (HTTP status-only reasons, timeouts, `unknown tool`) carry no provider text and are not
  scrubbed.
- **No prompt content in errors or telemetry.** Error messages carry schema paths and statuses;
  telemetry (`mcp.decision.recorded`, written only when `LA_RUN_ID` is set) carries step name, ok,
  mode, tier, model, confidence, error code, duration — no prompt, no decision payload. Telemetry is
  best-effort by contract: a telemetry failure can never fail or degrade a decision call.
- **State carries step content to TypeSafe by design** (the tier's purpose) — an accepted trade-off
  named in ADR-0012 Risks: tier-1 content sensitivity stays visible. Fixtures stay synthetic.
- **Enum-shaped outputs bound prompt injection** (GAPS §3.7): issue/review content can shift a
  classification, but it cannot "write" a command — the output space is typed and schema-validated
  before anything downstream sees it.
- **Fail-closed everywhere:** unknown tool → JSON-RPC -32602; unknown method → -32601; malformed
  line → -32700 with the stream left usable; every provider/parse/schema failure → typed error
  envelope, `isError: true`.

## Out of scope of FOC-401

The graph.json v2 step-level schema and the minimum-tier pin field (FOC-396); the graph runner and
escalation mechanics (FOC-397); gate auto-answer policy (ADR-0013 / FOC-384); the `decision` node
kind — which deliberately does NOT exist (ADR-0012 D5: steps live inside graph nodes, gates stay
HITL); GEPA/DSPy tooling (FOC-398); Path B serving and the Ollama logprobs probe (FOC-399); the
calibration task that must precede any threshold becoming policy; wiring these servers into any
supervisor flow; adding the missing pricing rows (config child).
