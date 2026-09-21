# graph.json v2 — step-level design (FOC-396)

> **Data:** 2026-09-21
> **Kind:** design document — design ONLY, no runner code. The runner is FOC-397 and blocks on
> this document. REVIEW/TEST step decomposition is deferred to FOC-478 (M4) — see §1.
> **Context:** ADR-0012 as amended 2026-09-21 (FOC-473 — five kinds, D7 one-node contract, tier-2
> disabled), `docs/plans/jev-placement-map-2026-09-21.md` (the "where Jev" map),
> `docs/mcp-decision-steps-catalog.md` (FOC-401 catalog), `docs/research/telemetry-analysis-2026-09.md`
> (telemetry, 2.19× correction standing), `docs/plans/fenix-architecture-gaps-2026-09-19.md` (GAPS —
> prior art §3.3). **Status:** delivered; FOC-397 may start from §6 + §7.

Shorthands: **GAPS** = `docs/plans/fenix-architecture-gaps-2026-09-19.md`,
**MAP** = `docs/plans/jev-placement-map-2026-09-21.md`, **TEL** =
`docs/research/telemetry-analysis-2026-09.md`, **CAT** = `docs/mcp-decision-steps-catalog.md`.

## 1. Scope and deferral

- **Design only.** This document specifies the v2 graph shape, the PLAN step decomposition, the
  decide-edge bindings, the migration path and the cost estimate. No runner code; the runner is
  **FOC-397** and blocks on this document.
- **PLAN is decomposed fully** (AC1, §3). **REVIEW/TEST step decomposition is deferred to FOC-478
  (M4)** — stated explicitly, not silently skipped. Nothing in v2 forecloses it: the same `steps`
  nesting is available to every squad node; REVIEW/TEST keep their v1 contracts until FOC-478
  designs their splits.
- **FOC-474/FOC-475 context honored:** [G] generator nodes are encoded per the ADR-0012 amendment
  (§3, §4), and every node declares its minimal input fields — "context size is a design output,
  not an accident": each step's `reads` list IS that design output.
- ADR-0012 hands FOC-396 one open item: the per-[J] **minimum-tier pin field** (ruled Q5b: approved
  as a schema field; concept in D2, field spec deferred). The spec is §6.3.

## 2. Baseline — what v1 is and who reads it

`config/graph.json` (FOC-158) is a squad-granularity topology: 6 top-level nodes (plan, dev, review,
test, cadence, human), 10 typed edges (`handoff`/`return`/`escalate`/`gate`, 6 of them
`routable: true`), per-node `autonomy`/`concurrency`/`budget {stage, shareHint}`/`input`/`output`/
`completion`/`failure`/`gates`, `version: 1`, `entryNodes: ["plan","cadence"]`.

**Nine real consumers** (verified against the scripts; two recon corrections applied —
`supervisor-followup.mjs` IS a consumer, `supervisor-cleanup.mjs` is NOT):

| Consumer | What it reads |
|---|---|
| `scripts/graph-validate.mjs` | plain `JSON.parse` (`loadGraph`, no version awareness); `validateGraph` requires `input, output, completion, failure, budget` + `autonomy` on every top-level node; `emitHandoffRules` → `config/handoff-rules.json`; `emitPuml` → `docs/diagrams/07_squad_graph.puml` |
| `scripts/graph-route.mjs` | `handoffTargetFrom` filters `edges` on `type === "handoff"`, throws on >1 outgoing |
| `scripts/supervisor-lib.mjs` | `concurrencyFor` (nodes[squad].concurrency, absent → 1), `producerOf`/`consumerOf`, `allocateBudget` (reads `budgetPolicy.reserveShare` + every node's `budget.shareHint`; throws on `shareHint <= 0` and `hintTotal <= 0`) |
| `scripts/supervisor-budget.mjs` | `loadGraph` + `allocateBudget` for stage budgets |
| `scripts/supervisor-spawn.mjs` | `loadGraph` + concurrency limits for spawn |
| `scripts/supervisor-triage.mjs` | `emitHandoffRules`, `handoffTargetFrom`, `autonomy === "supervised"` → `requiresConfirmation` |
| `scripts/supervisor-verdict.mjs` | hardcoded `RETURN_EDGE_BY_SQUAD = { review: "review-to-dev-return" }`; `returnFlagFor` reads the return edge's `when.labels[0]` |
| `scripts/supervisor-followup.mjs` | `assertStageBudget` (stage budgets from squad-level shareHints) |
| `scripts/telemetry-viz-export.mjs` | direct `JSON.parse`; reads `budget.stage`/`shareHint` for plan/dev/review/test |

`scripts/supervisor-cleanup.mjs` mentions `config/graph.json` in comments only — **not a consumer**.
`ui/` has zero references. Tests pinning the v1 shape: `scripts/graph-validate.test.mjs` (exactly 6
routable rules; `handoff-rules.json` equivalence via deepStrictEqual; PUML byte-drift vs
`docs/diagrams/07_squad_graph.puml`; both return edges routable), `scripts/supervisor-budget.test.mjs`,
`scripts/supervisor-{semaphore,spawn,triage,verdict}.test.mjs`.

Migration-fragile specifics: the shareHint readers (supervisor-lib/budget/followup,
telemetry-viz-export), the return-edge id + `when.labels[0]` (supervisor-verdict), and the
`type === "handoff"` filter (graph-route).

## 3. PLAN step decomposition (AC1 + AC2)

The prior-art sketch (GAPS §3.3) is `plan.dor → plan.ac → plan.spec → plan.decompose → plan.push`.
v2 adopts it with two argued changes:

1. **The two v1 plan gates become explicit [H] steps in the chain** — the kickoff requires it, and
   a [G] node never decides a gate (ADR-0012 D1/D7). `plan.gate1` (plan-approval) sits after spec;
   `plan.gate2` (push-approval) sits before push — `config/graph.json` plan.failure already says
   "NEVER push to Linear without GATE 2 approval".
2. **v1's implicit "discovery" folds into `plan.spec`.** GAPS §4 names PLAN spec as the [A] step —
   [A] is the only kind allowed long context accumulation and `--resume`; discovery (reading the
   inbox entry, the repo, prior briefs) and spec drafting need the same tool loop, and splitting
   them would force an artificial state boundary through one agent session.

```
plan.dor [J] → plan.ac [G] → plan.spec [A] → plan.gate1 [H] → plan.decompose [J] → plan.gate2 [H] → plan.push [D]
```

Every step carries the full D7 contract (ADR-0012 D7); the concrete JSON is the worked example in
§3.9. Run-record namespaces used by `reads`: `inbox.*` (kickoff content), `repoState.pinned` (the
[D]-gathered pinned state, FOC-286 prologue), `features.*` (extraction output), `plan.<step>.*`
(each step's own written record), `gate.plan.gate{1,2}.*`. The run-record schema itself is
FOC-397's job; v2 declares only which fields each step reads.

### 3.1 plan.dor — [J]

DoR assessment ("criteria testable? scope clear? context sufficient?" — MAP §3A #3) is a single
bounded judgment with a typed answer — classic [J]. Not [G]: it generates no content. Not [A]: no
tool loop — the facts come from the [D] pinned-state prologue ("Kod zbiera fakty, Jev ocenia",
MAP §1). MAP #3 is `noul` × n — several one-question judgments composed in code.
**Contract:** reads `inbox.entry`, `repoState.pinned` → output `{ ready: boolean, gaps: string[]
(max 8) }`; tier D2 cascade, min pin 1 (§6.3); failure `escalate` (one rung up: tier → frontman →
Mateusz — the frontman's ONLY happy-path absence is exactly this design: he never sees a passing
DoR check, only a failing one); writes `run-record`. Registry: the DoR decision point is MAP #3,
filed under FOC-452 (MAP §7) — a step inside the plan node calling `decision-call.mjs` by registry
id, NOT one of the five decide-edges (§5).

### 3.2 plan.ac — [G]

Generates a small bounded structure (acceptance criteria + Definition of Done) in one model call —
ADR-0012's own [G] examples (D1 as amended: "PLAN's Definition of Done and acceptance criteria").
The full end-to-end walk-through is §4. Never decides a gate: AC quality is input material for
spec and review, never a verdict (D7: only [J]/[D]/[H] decide gates).
**Contract:** reads `inbox.entry`, `features.list` → bounded output `{ acs (1..12), definitionOfDone
(1..12) }` (schema in §3.9); tier `cheap`; failure `stop` (fail-closed — no unvalidated text flows
to spec); writes `run-record`. **Frontman: none** — a failed generation stops the chain at a typed
record; escalation policy is the runner's (FOC-397).

### 3.3 plan.spec — [A]

Discovery + brief/ADR drafting needs interactive tool use with side effects and context
accumulation across many turns — the [A] classification rule (ADR-0012 D1); GAPS §4 lists "PLAN
spec" as the [A] step. This is where the v1 plan node's LLM work genuinely belongs.
**Contract:** reads `inbox.entry`, `plan.ac.acs`, `plan.ac.definitionOfDone`, `repoState.pinned` →
output `{ briefs: string[] (paths, max 8), adr: string, summary: string (max 2000) }` — the typed
record carries paths, not prose (artifacts live on disk); tier `agent`; failure `escalate` (the
terminal behaviour after the runner's retry policy — the v1 two-strikes shape stays runner policy,
FOC-397); writes `run-record`. **Frontman:** none on the happy path (fresh-context child in its own
worktree); he stays in the loop only when the step escalates, or to compose gate1's question if the
typed record alone is insufficient context for Mateusz.

### 3.4 plan.gate1 — [H]

Plan approval is a human decision — the existing gate contract is untouched (GAPS §4: "czego nie
ruszać: kontraktu gate'ów"). This is v1's `plan.gate1`, now placed in the chain.
**Contract:** reads `plan.spec.record` → `{ approved: boolean }`; tier `null`; failure `stop` (no
approval → no decompose, no push); writes `graph-state` (gate record under
`.state/supervisor/<run>/gates/`, as today). **Frontman:** the supervisor relays the gate record
mechanically (`supervisor-gate.mjs`); **Mateusz decides** — the frontman's turn is emission, not
judgment, and a [G] node never decides this gate (its output is material the human reads, not an
answer to it).

### 3.5 plan.decompose — [J]

The epic/subtask split — which features group, per-task size, relations — is a bounded judgment
with a typed answer ([J]); its built analogue is the prompt-refinement family (CAT: size
classification + per-feature relations). The size → engagement mapping stays **[D] code**
(`squadsForSize` — CAT: "the size → squads map is code, not a model opinion"); numeric estimates
are [D]-derived from the size enum via a config table — zero arithmetic in the model (MAP §1).
**Contract:** reads `plan.spec.record`, `plan.ac.acs` → output `{ tasks: [{title, size:
small|medium|large, labels, relations}] (max 12) }`; tier D2 cascade, min pin 1; failure
`escalate`; writes `run-record`. **Frontman:** none on the happy path; escalation rung only.

### 3.6 plan.gate2 — [H]

Push approval — v1's `plan.gate2`; `config/graph.json` plan.failure already forbids pushing without
it. Human decision, gate contract untouched.
**Contract:** reads `plan.decompose.record`, `gate.plan.gate1.record` → `{ approved: boolean }`;
tier `null`; failure `stop`; writes `graph-state`. **Frontman:** relays mechanically; Mateusz
decides.

### 3.7 plan.push — [D]

Idempotent Linear push from the typed breakdown plus gate2 approval is fully determined by its
inputs — a pure script (v1 plan.completion: "Re-running must not duplicate issues"). This is the
D1 [D] rule: content-deterministic work executed by an LLM today (GAPS §3.2) must become code.
**Contract:** reads `plan.decompose.record`, `gate.plan.gate2.record` → output `{ epicId: string,
childrenIds: string[] (max 12), handoffCommentPosted: boolean }`; tier `null`; failure `stop`
(never push on a gate miss — fail-closed); writes `run-record` (the Linear side effects are the
record's content). **Frontman: none** — the push is code; its approval was human (gate2).

### 3.8 Frontman involvement — the per-step answer (AC2)

On the happy path the frontman runs **zero judgment turns** in PLAN: dor/ac/decompose are
cheap-tier model calls made by the runner, spec is an [A] child with fresh context, push is a
script, and both gates are human decisions relayed mechanically. He remains only for exceptions:
(a) the escalation rung under [J]/[A] failures and below-threshold confidence (D2's ladder ends at
the frontman, then Mateusz), (b) composing gate context when typed records are insufficient, (c)
post-push drift handling. That is AC2's "only for exceptions" target, per step above.

One honest scope note (GAPS §3.9): PLAN is ~1.7% of corrected token volume — the decomposition is a
**quality and legibility** lever, not a cost lever. The cost lever is §5's decide-edges and §8's
arithmetic.

### 3.9 Worked example — PLAN's steps as v2 JSON (complete, valid)

The block below is the **plan-node delta** to `config/graph.json` (Option A, §6.1): dev/review/
test/cadence/human and the top-level `edges` array stay v1-unchanged. Step objects carry exactly
the D7 field list (id = its key, kind, reads, output, tier, failure, writes) — nothing else.
Fields outside `steps`/`stepFlow` are the v1 squad contract, kept verbatim for the nine consumers.

```json
{
  "version": 2,
  "_doc": "Worked example (FOC-396): the plan node in the v2 additive shape - the other five nodes and the top-level edges array stay v1-unchanged. A step object carries exactly the D7 field list (id = its key, kind, reads, output, tier, failure, writes) and nothing else. Squad-node fields outside steps/stepFlow are the v1 contract kept verbatim for the nine consumers.",
  "nodes": {
    "plan": {
      "autonomy": "supervised",
      "concurrency": 1,
      "budget": { "stage": "discovery", "shareHint": 0.2 },
      "input": {
        "source": "planning/inbox/*.md",
        "description": "An entry in the planning inbox - voice memo, artefact, free-text idea. No Linear task exists yet, or a Draft does."
      },
      "output": {
        "linear": { "creates": "epic + subtasks", "labels": ["ai:planned", "type:*", "dor-ok"], "fields": ["estimate", "blockedBy relations"] },
        "artifacts": ["planning/briefs/{discovery,spec,plan}-*.md", "docs/adr/NNNN-*.md"]
      },
      "completion": "Idempotent push to Linear succeeded AND the hand-off comment is posted. Re-running must not duplicate issues.",
      "failure": "A HITL gate did not get its approval -> stop without pushing. NEVER push to Linear without GATE 2 approval.",
      "gates": ["plan.gate1", "plan.gate2"],
      "steps": {
        "plan.dor": {
          "kind": "J",
          "reads": ["inbox.entry", "repoState.pinned"],
          "output": { "type": "object", "required": ["ready", "gaps"], "additionalProperties": false, "properties": { "ready": { "type": "boolean" }, "gaps": { "type": "array", "maxItems": 8, "items": { "type": "string", "maxLength": 200 } } } },
          "tier": { "cascade": true, "min": 1 },
          "failure": "escalate",
          "writes": "run-record"
        },
        "plan.ac": {
          "kind": "G",
          "reads": ["inbox.entry", "features.list"],
          "output": {
            "type": "object",
            "required": ["acs", "definitionOfDone"],
            "additionalProperties": false,
            "properties": {
              "acs": {
                "type": "array", "minItems": 1, "maxItems": 12,
                "items": {
                  "type": "object",
                  "required": ["id", "text", "kind"],
                  "additionalProperties": false,
                  "properties": {
                    "id": { "type": "string", "pattern": "^AC-[0-9]{1,2}$" },
                    "text": { "type": "string", "minLength": 1, "maxLength": 300 },
                    "kind": { "enum": ["behaviour", "boundary", "verification"] }
                  }
                }
              },
              "definitionOfDone": {
                "type": "array", "minItems": 1, "maxItems": 12,
                "items": {
                  "type": "object",
                  "required": ["check", "kind", "bounded"],
                  "additionalProperties": false,
                  "properties": {
                    "check": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "kind": { "enum": ["test", "lint", "manual", "linear"] },
                    "bounded": { "type": "boolean" }
                  }
                }
              }
            }
          },
          "tier": "cheap",
          "failure": "stop",
          "writes": "run-record"
        },
        "plan.spec": {
          "kind": "A",
          "reads": ["inbox.entry", "plan.ac.acs", "plan.ac.definitionOfDone", "repoState.pinned"],
          "output": { "type": "object", "required": ["briefs", "adr", "summary"], "additionalProperties": false, "properties": { "briefs": { "type": "array", "maxItems": 8, "items": { "type": "string", "maxLength": 200 } }, "adr": { "type": "string", "maxLength": 200 }, "summary": { "type": "string", "maxLength": 2000 } } },
          "tier": "agent",
          "failure": "escalate",
          "writes": "run-record"
        },
        "plan.gate1": {
          "kind": "H",
          "reads": ["plan.spec.record"],
          "output": { "type": "object", "required": ["approved"], "additionalProperties": false, "properties": { "approved": { "type": "boolean" } } },
          "tier": null,
          "failure": "stop",
          "writes": "graph-state"
        },
        "plan.decompose": {
          "kind": "J",
          "reads": ["plan.spec.record", "plan.ac.acs"],
          "output": {
            "type": "object",
            "required": ["tasks"],
            "additionalProperties": false,
            "properties": {
              "tasks": {
                "type": "array", "minItems": 1, "maxItems": 12,
                "items": {
                  "type": "object",
                  "required": ["title", "size", "labels", "relations"],
                  "additionalProperties": false,
                  "properties": {
                    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "size": { "enum": ["small", "medium", "large"] },
                    "labels": { "type": "array", "maxItems": 8, "items": { "type": "string", "maxLength": 60 } },
                    "relations": { "type": "array", "maxItems": 8, "items": { "type": "string", "maxLength": 60 } }
                  }
                }
              }
            }
          },
          "tier": { "cascade": true, "min": 1 },
          "failure": "escalate",
          "writes": "run-record"
        },
        "plan.gate2": {
          "kind": "H",
          "reads": ["plan.decompose.record", "gate.plan.gate1.record"],
          "output": { "type": "object", "required": ["approved"], "additionalProperties": false, "properties": { "approved": { "type": "boolean" } } },
          "tier": null,
          "failure": "stop",
          "writes": "graph-state"
        },
        "plan.push": {
          "kind": "D",
          "reads": ["plan.decompose.record", "gate.plan.gate2.record"],
          "output": { "type": "object", "required": ["epicId", "childrenIds", "handoffCommentPosted"], "additionalProperties": false, "properties": { "epicId": { "type": "string", "maxLength": 20 }, "childrenIds": { "type": "array", "maxItems": 12, "items": { "type": "string", "maxLength": 20 } }, "handoffCommentPosted": { "type": "boolean" } } },
          "tier": null,
          "failure": "stop",
          "writes": "run-record"
        }
      },
      "stepFlow": [
        { "from": "plan.dor", "to": "plan.ac", "type": "sequence" },
        { "from": "plan.ac", "to": "plan.spec", "type": "sequence" },
        { "from": "plan.spec", "to": "plan.gate1", "type": "sequence" },
        { "from": "plan.gate1", "to": "plan.decompose", "type": "sequence" },
        { "from": "plan.decompose", "to": "plan.gate2", "type": "sequence" },
        { "from": "plan.gate2", "to": "plan.push", "type": "sequence" }
      ]
    }
  },
  "decisionEdges": [
    {
      "id": "decide-triage-node", "from": "*", "to": "*", "type": "decide",
      "registry": "intake.triage_node",
      "when": { "event": "run-start" },
      "why": "MAP #1: issue -> entry node (plan/dev/review/test/ask). Today the frontman's --confidence judgment in supervisor-triage.mjs. Registry id proposed - none exists in the catalog yet (FOC-448 owns the registry)."
    },
    {
      "id": "decide-task-size", "from": "*", "to": "*", "type": "decide",
      "registry": "intake.task_size",
      "when": { "event": "run-start", "after": "decide-triage-node" },
      "why": "MAP #2: size -> engagement path. Today the frontman; built analogue prompt-refinement (FOC-401), not wired."
    },
    {
      "id": "decide-review-depth", "from": "review", "to": "review", "type": "decide",
      "registry": "review.depth",
      "when": { "state": "In Review" },
      "why": "MAP #14: first-pass/deep/security. Today fixed config. from/to name the decision's scope, not a routable target."
    },
    {
      "id": "decide-next-step", "from": "*", "to": "*", "type": "decide",
      "registry": "orchestration.next_step",
      "when": { "event": "child-terminal" },
      "why": "MAP #16: wait/resume/advance/escalate/ask-Mateusz. Today a frontman turn - the cost lever behind the AC4 estimate."
    },
    {
      "id": "decide-child-state", "from": "*", "to": "*", "type": "decide",
      "registry": "monitor.child_state",
      "when": { "hook": ["PostToolUse", "Stop"] },
      "why": "MAP #17: stuck/working/waiting. Today the STALL_SILENCE_MS heuristic (supervisor-status.mjs). Discrepancy flagged: the map scopes decide-edges to #1/#2/#14/#16 and hooks #17 via PostToolUse/Stop, the kickoff requires an edge - bound here per the kickoff; resolution (edge vs hook-only) left to FOC-397/Mateusz."
    }
  ]
}
```

## 4. One [G] step end-to-end: plan.ac (AC/DoD generation)

- **One API call, no tool loop.** The step receives its declared inputs, makes exactly one model
  call, returns a typed structure. No repo access, no file reads; retry policy belongs to the
  runner, not the step.
- **Declared minimal inputs** ("context size is a design output"): `inbox.entry` (the dictated
  issue text) and `features.list` (extraction output already in the run record). Nothing else — no
  repo tree, no telemetry, no prior runs, no Linear comments; relevance drops with every
  irrelevant input (MAP §1: "krótki, przefiltrowany stan").
- **One question per field / zero arithmetic in the model:** the model neither counts nor computes —
  `acs` and `definitionOfDone` items are bounded declarative statements; sizes, counts and
  estimates belong to `plan.decompose` [J] plus [D] mapping, not here.
- **Concrete schema with explicit bounds** (§3.9, `plan.ac.output`): `acs` 1–12 items (`id`
  pattern-locked `AC-n`, `text` ≤ 300 chars, `kind` enum), `definitionOfDone` 1–12 items (`check`
  ≤ 200 chars, `kind` enum test/lint/manual/linear, `bounded` boolean). The size bound is what
  makes the output [G]-shaped — validated on write AND bounded (D7). Shape sources are the
  catalog's `acceptance-criteria` and `definition-of-done` entries (CAT); v2 merges both into one
  call because they consume the same declared inputs and the merged structure stays bounded — the
  catalog keeps the two shapes if a split is ever measured to be needed.
- **Cheap tier** (D7), provider-free: `"tier": "cheap"` is resolved through `config/models.json`
  by the runner (FOC-397).
- **Fail-closed:** output-schema validation happens before anything downstream sees the result; a
  schema-invalid or failed call becomes one typed failure record — the model never invents output,
  the chain stops (`"failure": "stop"`), no partial data flows onward. This mirrors the catalog's
  fail-closed envelope contract (CAT error codes:
  invalid_input/auth_missing/provider_error/unparseable_output/schema_invalid).
- **Output destination:** `run-record` — one named place (D7), appended as a typed event record
  (GAPS §3.4).
- **Why it never touches a gate:** D7 — only [J], [D] and [H] decide gates; [G] never does.
  `plan.ac`'s output feeds `plan.spec` as input material; `plan.gate1`/`plan.gate2` are [H] steps
  decided by Mateusz. Even a perfect AC list cannot approve anything.
- **"Jev nie pisze tekstu" reconciled:** the rule binds the DECISION model (Jev classifies, never
  authors); text authoring is exactly what [G] nodes, templates and [A] steps are for (MAP §1,
  ADR-0012 D1 [G]). `plan.ac` is the [G] author — inside a typed bounded structure.

## 5. decide: edges — binding the five non-deterministic transitions

**None of the five registry ids exists in the catalog today** (verified against CAT: zero matches —
the built entries are `extraction` and `prompt-refinement`, plus catalog-only entries). v2
therefore **proposes registering the five ids as new registry entries**; the catalog is intended to
become the FOC-448 decision registry (MAP §4 enabler 1: "Dzisiejszy katalog MCP staje się tym
rejestrem"; MAP §7: FOC-448 owns the registry and blocks, among others, FOC-397). Registry entry
shape per MAP §4: id + step; questions + criteria (versioned file); autonomy level (A0 advisory →
A1 gated → A2 autonomous — A2 is always Mateusz's edit, never self-granted); calibrated threshold;
fallback path; metrics. All hook points call `decision-call.mjs` by id.

| decide edge | registry id (proposed) | MAP anchor | Today | Fires | Fallback (registry-owned) | Start autonomy |
|---|---|---|---|---|---|---|
| `decide-triage-node` | `intake.triage_node` | #1 | frontman `--confidence` judgment (`supervisor-triage.mjs`) | run start | frontman triage (today's path) | A0 → A1 |
| `decide-task-size` | `intake.task_size` | #2 | frontman; built analogue `prompt-refinement` (FOC-401, not wired) | run start, after triage | supervisor-alone / frontman | A0 → A1 |
| `decide-review-depth` | `review.depth` | #14 | fixed config | review entry | the fixed config stands | A1 |
| `decide-next-step` | `orchestration.next_step` | #16 | a frontman turn | child terminal state | frontman turn (today's path) | A0 → A1 |
| `decide-child-state` | `monitor.child_state` | #17 | `STALL_SILENCE_MS` heuristic (`supervisor-status.mjs`) | PostToolUse / Stop hooks | the heuristic stands | A1 |

- **Deterministic transitions stay [D].** The label/state matcher transitions (e.g. Todo + dor-ok →
  dev handoff) remain [D] evaluation by `graph-route.mjs`; GAPS §3.2's "deterministic in content"
  list (DoR met → DEV; verdict pass → TEST; repeated fingerprint → escalate; TEST done + clean tree
  → cleanup) stays code — the transition is [D] given the typed record; only the JUDGMENT feeding
  it is [J]. decide-edges replace the frontman's judgment calls, not the matcher.
- **The child_state discrepancy — flagged, not resolved.** MAP §4 point 3 scopes decide-edges to
  #1/#2/#14/#16 and hooks #17/#18 via PostToolUse/Stop instead; the kickoff requires child_state as
  a decide-edge at minimum. v2 binds all five (kickoff compliance) and the schema supports both
  wirings (a decide-edge may carry `when.hook`; a registry entry can also serve a hook-only
  call-site without a graph edge). Which wiring wins is FOC-397's call with Mateusz — this document
  does not silently pick a side.
- **Autonomy honesty:** every decide-edge starts A0 (advisory — logged, nothing auto-fires) unless
  the MAP already assigns A1 (#14, #17). Promotion is per-decision-id, evidence-backed, Mateusz's
  edit — the same policy as `_autonomy` (MAP §4, GAPS §3.5). Until calibration (FOC-387) no
  threshold becomes policy (ADR-0012 D2).

## 6. Schema v2 proposal

### 6.1 The strategy fork — Option A picked

- **Option A — versioned key in place (ADDITIVE):** `config/graph.json` stays the one file;
  `version: 2`; squad nodes keep their v1 contract fields + autonomy; steps nest as sub-objects
  (`steps`, `stepFlow`); the top-level `edges` array is unchanged; the new `decide` edges live in
  an additive top-level `decisionEdges` array.
- **Option B — new file** (`config/graph.v2.json`; v1 untouched).

**Confirmed 2026-09-21 (Mateusz, via supervisor recommendation)** — both picks stand: (a) Option A,
versioned key in place, additive — the schema-versioning precedent FOC-397 builds on; (b) the
7-step PLAN split of §3 (plan.dor [J], plan.ac [G], plan.spec [A] with discovery folded in,
plan.gate1 [H], plan.decompose [J], plan.gate2 [H], plan.push [D]).

**Picked: Option A.** Defense, on the census evidence (§2):

1. `validateGraph` requires `CONTRACT_FIELDS` + `autonomy` on every **top-level** node — nested
   step objects are invisible to it, so v1 validation stays green with zero validator change.
   Sibling top-level step nodes would trip the validator or force fake `budget`/`completion`
   fields onto steps — contract pollution, rejected.
2. `allocateBudget` iterates every node carrying `budget` and **throws on `shareHint <= 0`** —
   step-level budget hints would skew stage allocation. Chosen: **budget stays at squad granularity
   in v2** (steps carry no `budget` field; D7's seven fields have no slot for one anyway). Per-step
   cost metering comes from the run event log (GAPS §3.4), not from shareHints; changing
   `allocateBudget` is FOC-397's option if ever needed — not v2's.
3. `graph-route.mjs` filters `type === "handoff"` from `edges` — keeping `edges` byte-identical
   leaves the matcher, `RETURN_EDGE_BY_SQUAD`, `handoff-rules.json` and the PUML byte-match
   untouched **by construction**. (Putting decide-edges inside `edges` would also be inert to the
   handoff filter, but would need `emitHandoffRules`/`emitPuml` re-verified against unknown types
   and risks the 6-routable-rule pin if any edge were marked routable; a separate array needs no
   re-verification.)
4. Against Option B: two files = two sources of truth for one topology. The repo already lived this
   pattern — `handoff-rules.json` is a generated parallel view with an equivalence test and a
   "retire together" plan (`config/graph.json` `_migration`); a second permanent parallel file
   would create a new drift bug class for zero benefit, since Option A's additive shape already
   achieves Option B's only advantage (v1 consumers untouched).
5. Versioning: v1 already carries `version: 1`; no consumer reads it today (`loadGraph` is a plain
   `JSON.parse`). v2 bumps to `version: 2`; `graph-validate.mjs` gains a version check + a
   step-schema check in FOC-397 (proposed, not landed with this document).

### 6.2 The seven fields (D7, verbatim binding)

A step object carries **exactly** the D7 field list — the ADR's binding sentence applies
literally: "graph.json v2 (FOC-396) encodes exactly these fields — the node schema and this
contract are the same list; a field outside it has no place in a node."

| D7 concept | Field | Value shape |
|---|---|---|
| id | the object's key under `steps` | string, unique in the graph (e.g. `plan.dor`) |
| kind | `kind` | `"D" \| "J" \| "A" \| "H" \| "G"` |
| declared input fields | `reads` | array of run-record field paths; nothing outside may be read |
| output schema | `output` | a JSON Schema object, validated on write; [G] additionally bounded in size |
| model tier | `tier` | see §6.3 |
| failure behaviour | `failure` | `"stop" \| "escalate"` — typed, fail-closed; a failed node never invents output, never silently passes. Retry counts are runner policy (FOC-397), not node schema: the field declares the terminal behaviour |
| output destination | `writes` | `"run-record" \| "envelope" \| "graph-state"` — one named place |

`stepFlow` (sequence edges) and `steps` live on the **squad node**, which keeps its full v1
contract — the D7 list binds step objects, not squad nodes (that is the Option-A migration
compromise, stated in §3.9's `_doc`).

### 6.3 The [J] minimum-tier pin field (ADR-0012 Q5b open item — the spec)

The `tier` field's value shape carries the pin:

- `[D]` / `[H]`: `"tier": null` — no model call.
- `[J]`: `"tier": { "cascade": true, "min": <1|2|3> }` — `min` is the **minimum-tier pin**: the
  lowest cascade tier the step may ever run on. The cascade (D2) may start at `min` and escalate
  UP (low confidence or error → one rung up, ending at the human — D2 fixes the direction; values
  follow calibration, FOC-387), but never below `min`. Default `min: 1` (full cascade). A step too
  nuanced for Jev pins `min: 3` (Claude, typed output, `confidence: null` — measured-sources-only
  rule intact). `min: 2` is well-defined while tier 2 is disabled (FOC-473: `FALLBACK_MODEL =
  null`): the cascade skips the dead tier and starts at 3 — the pin records intent honestly
  instead of pretending the tier exists.
- `[G]`: `"tier": "cheap"` — the cheap tier by default (D7), resolved via `config/models.json` by
  the runner.
- `[A]`: `"tier": "agent"`.

Pin edits are committed config changes by Mateusz, same policy as `_autonomy` (human-set only, on
evidence).

### 6.4 Edge types — v1 vs v2 reconciled

| Type | Lives in | v1/v2 | Notes |
|---|---|---|---|
| `handoff` | top-level `edges` | unchanged | graph-route's filter and the 6-routable pin depend on it |
| `return` | top-level `edges` | unchanged | supervisor-verdict hardcodes the review return id + `when.labels[0]` |
| `escalate`, `gate` | top-level `edges` | unchanged | declared non-routable; routing handled by the order-1 gate edge |
| `sequence` | node-local `stepFlow` | new | ordered step-to-step connectors inside a node; never matcher edges; step-level rendering (a PLAN pipeline diagram) is a new render target for FOC-397 |
| `decide` | top-level `decisionEdges` | new | never matched by graph-route (it reads `edges` only); `emitHandoffRules` filters `routable` from `edges` only — inert by construction; `from`/`to` name the scope where the decision applies, not a routable target; the registry entry owns autonomy, threshold, fallback and metrics |

Any routable-edge change in FOC-397 must regenerate `config/handoff-rules.json` + the PUML in the
same change (the equivalence and byte-drift tests fail otherwise).

## 7. Migration path (AC3) — nine consumers, one line each

| Consumer | v2 impact |
|---|---|
| `graph-validate.mjs` | `loadGraph` parses the same file (additive keys); `validateGraph`'s top-level CONTRACT_FIELDS loop untouched (steps are nested, invisible); proposed for FOC-397: version assert + step-schema validation |
| `graph-route.mjs` | `edges` unchanged → `handoffTargetFrom` and the matcher untouched; `decisionEdges` is invisible to it |
| `supervisor-lib.mjs` | squad nodes keep `concurrency`/handoff structure → `concurrencyFor`, `producerOf`, `consumerOf` unchanged; steps carry no `budget` → `allocateBudget` unchanged |
| `supervisor-budget.mjs` | consumes `allocateBudget` → unchanged (budget stays squad-granular) |
| `supervisor-spawn.mjs` | reads squad nodes for concurrency limits → unchanged |
| `supervisor-triage.mjs` | `emitHandoffRules` + `handoffTargetFrom` + `autonomy === "supervised"` all unchanged; the frontman `--confidence` judgment it encodes is what `decide-triage-node` replaces in FOC-397 (via `decision-call.mjs` by registry id) |
| `supervisor-verdict.mjs` | the review return edge keeps its id and `when.labels[0]` → `RETURN_EDGE_BY_SQUAD` unchanged |
| `supervisor-followup.mjs` | `assertStageBudget` reads squad-level stage hints → unchanged (steps carry no budget) |
| `telemetry-viz-export.mjs` | direct parse reading `budget.stage`/`shareHint` for plan/dev/review/test → unchanged (those fields stay) |

`supervisor-cleanup.mjs` — **not a consumer** (comments only), listed for completeness, excluded
from migration accounting.

**Landing order:**
1. This document (design) — done; FOC-397 blocks on it.
2. FOC-448 lands the decision registry (entries for the five ids + the DoR/size/relation family) —
   decide-edges have nothing to call without it (MAP §7: FOC-448 blocks FOC-397).
3. FOC-397 implements the runner: version + step-schema validation in `graph-validate.mjs`,
   `steps`/`stepFlow`/`decisionEdges` execution, [D] steps as code, [J]/[G] calls through
   `decision-call.mjs` by id, per-step typed records appended to the run event log (GAPS §3.4),
   escalation per D2. Any routable-edge change regenerates handoff-rules.json + PUML in the same
   change.
4. Shadow/replay evidence per step before any autonomy promotion (GAPS §3.5; `_autonomy` policy:
   Mateusz's edit, on evidence).

## 8. Frontman-share estimate (AC4)

**Measured anchors** (every factor labelled; source in brackets):

| Anchor | Value | Status |
|---|---|---|
| Corpus spend | $3,081.54 (2026-06-25 → 2026-09-10) | measured, raw — still **2.19× high** [TEL F2, F7.1b]; R7b has NOT landed — no post-correction absolute dollars exist |
| True corpus cost | ~$1,400 | the doc's own approximate reading [TEL F2 note] |
| Frontman share | $1,339 = **43.5%** of corpus; 2.5× all children combined | measured share; the over-count is proportional, so **shares survive the ÷2.19 correction** [TEL F2] |
| Corrected frontman share | **39.7%** (token shares) | measured [GAPS §2.9] — direction unchanged |
| ÷2.19 frontman absolute | $1,339 / 2.19 ≈ **$611 of ~$1,400** | **derived**, not a doc figure |
| `orchestration.next_step` ≈ 40% of frontman tokens | ~40% | **approximated by the placement map** (#16), NOT a telemetry measurement |
| Frontman turn shape | median 257 turns, p90 1,072, ~89k tokens/turn | measured [TEL F2/A3] |

**Reading caveat on the ~40%:** the map's wave-2 line attaches "~40% tokenów" to the frontman's
overall share ("frontman to ~40% tokenów; tu Jev zastępuje tury LLM-a"), consistent with GAPS §3.9
and the measured 43.5%; the #16 row carries the same figure as the decision's value. The kickoff's
reading — "#16 ≈ 40% of frontman tokens" — is used below as instructed, but the figure is doubly
unmeasured: its value AND its meaning. Flagged, not silently resolved.

**Conservative bound — only `orchestration.next_step` moves:**

- Reduction of corpus spend ≈ frontman share × next-step fraction = 0.435 × 0.40 ≈ **0.174 → ~17
  pp of corpus**.
- Raw dollars: 0.174 × $3,081 ≈ **$537** (derived; raw is 2.19× high). Corrected: $537 ÷ 2.19 ≈
  **$245 of ~$1,400** (derived).
- Frontman residual share ≈ 43.5% − 17.4 pp ≈ **~26% of corpus** (if nothing else moves).

**Broader bound — a larger unmeasured routine set moves** (next_step + child_state classification
+ report-completeness reads (MAP #18) + gate relaying/pre-screening (MAP #19) + triage judgments
(MAP #1/#2)):

- NO measurement exists for this set's share. Argued band: routine turns are **50–70%** of
  frontman turns (argument: the only measured anchor is next_step's ~40%; monitoring, gate
  relaying and completeness reads are additional frontman turn classes with no per-class counts).
- Reduction ≈ 0.435 × 0.50–0.70 ≈ **0.22–0.30 → ~22–30 pp of corpus**; frontman residual ≈
  **~13–21%**.

**Compounding, unquantified:** fewer frontman turns → less context growth per session (median 257
turns × ~89k tokens/turn is the measured shape) → cheaper per-turn inputs and cache. Direction
positive; magnitude unmeasured — no per-turn cost curve exists in the corpus.

**Absences — stated, never invented around:** no routine-vs-exception taxonomy of frontman turns;
no per-transition turn counts; no PLAN-stage per-transition breakdown (PLAN is only a squad total
— and ~1.7% of corrected volume, GAPS §2.9/§3.9); no measured projection of the share addressable
by decide-edges/[G]; no post-R7b absolute dollars. Until a routine/exception taxonomy of frontman
turns is measured (a natural FOC-461 telemetry ask), **~17–30 pp of corpus spend (frontman share
43.5% → ~13–26%) is the honest range, and only the low end has a named measured-ish factor.**

## 9. Collector notes (FOC-461)

Noticed while designing; bullets only, no diffs, all outside this task's paths:

- `docs/README.md` line 21 — "STATE.md — long-work diary, najnowsza aktualizacja 2026-07-26" is
  stale (STATE.md carries 2026-09-21 entries).
- `docs/mcp-decision-steps-catalog.md` — the "Tier cascade" section still presents tier 2 as live
  (non-thinking + logprobs); FOC-473 disabled it. Already recorded in the FOC-473 follow-ups; still
  open.
- ADR README index title still "four step kinds" (FOC-473 follow-up; still open).
- The ~40% figure ambiguity (§8's caveat) is worth a MAP errata line stating whether #16's value is
  "40% of frontman tokens" or "the frontman's overall share".

## 10. Open questions for FOC-397

1. **Step branching:** v2's `stepFlow` is linear per node; conditional step-branching is deferred
   (no measured need; the five decide-edges cover the judgment points). If FOC-397 needs branches,
   the schema grows in v2.1 — not by overloading `sequence`.
2. **Run-record schema ownership:** v2 declares `reads` paths against a namespace convention (§3
   preamble); the concrete record schema is FOC-397's.
3. **child_state wiring:** decide-edge with `when.hook` vs hook-only registry call (§5 discrepancy).
4. **Step-level diagram:** a PLAN pipeline render target (new emitter or a PUML section), so the
   step chain is drawable like the squad graph is today.
