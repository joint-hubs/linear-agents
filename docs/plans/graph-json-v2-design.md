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
- **FOC-474/FOC-475/FOC-476 context honored:** [G] generator nodes are encoded per the ADR-0012
  amendment (§3, §4) — now split so `plan.dod` and `plan.ac` each make exactly one call (§3) — and
  `plan.ready` [J] adds the retry-then-escalate check before gate1 (§3.5). Every node declares its
  minimal input fields — "context size is a design output, not an accident": each step's `reads`
  list IS that design output.
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

> **Revision note (2026-09-22, FOC-396):** this revision supersedes the 7-step PLAN slice currently
> in `config/graph.json` (landed by FOC-397): FOC-474 lands `plan.dod` [G], FOC-475 lands `plan.ac`
> [G] (replacing the merged config step), FOC-476 lands `plan.ready` [J] + the retry-then-escalate
> edge — nothing else in config moves. Pre-existing drift, **not** this revision's: config already
> carries a sixth top-level decision edge (`decide-has-acceptance-criteria`, FOC-451) that the
> §3.11 example does not show.

> **Revision note (2026-10-01, FOC-517):** the intent conversation lands. The chain below is the
> one FOC-516 left in `config/graph.json` — 11 steps / 10 sequence edges:
> `plan.dor → plan.intent → plan.intent.select → plan.gate1 → plan.dod → plan.ac → plan.spec →
> plan.decompose → plan.render → plan.gate2 → plan.push`; `plan.gate1` already sits before any
> spend (FOC-516 moved it in the same change that inserted `plan.intent.select`), so this revision
> does NOT reposition it. What FOC-517 adds: (1) the gate1 → plan.intent **re-entry edge** — the
> second edge type in `stepFlow` besides `sequence` (§6.4), implementing the ≤3-round conversation
> of §3.6; (2) the gate1 conversation contract (display, accepted answers, the `gate.plan.gate1`
> record fields, the typed `intent_not_settled` stop); (3) the **`plan.intent.confirmed`** record —
> the final map + answers, written by [D] code at the gate1 confirmation — and the read rewiring:
> `plan.dod`/`plan.ac` read it instead of `inbox.entry`, `plan.spec` reads it plus `inbox.entry`,
> and `plan.gate2` additionally reads `plan.spec.record` (§3.8). `plan.ready` [J] in the older
> diagram below is FOC-476's deliverable (this issue BLOCKS FOC-476) — decided there, not here;
> `plan.decompose` is already [J] as the diagram requires. Why gate1 sits before any spend: the
> FOC-474 eval scored 2 pass / 9 partial / 0 fail, with a large share of the partial misses being
> scope/boundary details the dictated text never stated — `plan.dod`/`plan.ac` [G] calls generated
> from an unconfirmed reading. A quick confirmed conversation first (Mateusz, 2026-09-23: PLAN must
> hold a quick conversation to make sure it knows what he wants — reading the Linear text alone can
> misread it) is cheaper than regenerating downstream artefacts from a misreading.

The prior-art sketch (GAPS §3.3) is `plan.dor → plan.ac → plan.spec → plan.decompose → plan.push`.
v2 adopts it with four argued changes:

1. **The two v1 plan gates become explicit [H] steps in the chain** — the kickoff requires it, and
   a [G] node never decides a gate (ADR-0012 D1/D7). `plan.gate1` (plan-approval) sits after spec;
   `plan.gate2` (push-approval) sits before push — `config/graph.json` plan.failure already says
   "NEVER push to Linear without GATE 2 approval".
2. **v1's implicit "discovery" folds into `plan.spec`.** GAPS §4 names PLAN spec as the [A] step —
   [A] is the only kind allowed long context accumulation and `--resume`; discovery (reading the
   inbox entry, the repo, prior briefs) and spec drafting need the same tool loop, and splitting
   them would force an artificial state boundary through one agent session.
3. **The merged AC/DoD [G] call splits into two one-call generators (FOC-474, FOC-475).** The
   original draft carried acceptance criteria and Definition of Done in a single plan.ac call; v2
   runs `plan.dod` [G] (DoD only) and `plan.ac` [G] (ACs only) as separate steps, each with its own
   contract. Each contract names ONLY the fields it reads — the second call must NOT silently
   receive the first call's inputs unless its own contract names them; the runner wires `reads`
   literally.
4. **`plan.ready` [J] sits between spec and gate1 (FOC-476).** A retry-then-escalate readiness
   check, NOT a second [H] gate: a `ready: false` answer returns to the step that failed, carrying
   the reason; a second failure escalates (§3.5).

```
plan.dor [J] → plan.dod [G] → plan.ac [G] → plan.spec [A] → plan.ready [J] → plan.gate1 [H] → plan.decompose [J] → plan.gate2 [H] → plan.push [D]
```

Every step carries the full D7 contract (ADR-0012 D7); the concrete JSON is the worked example in
§3.11. Run-record namespaces used by `reads`: `inbox.*` (kickoff content), `repoState.pinned` (the
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
id, NOT one of the six decide-edges (§5).

### 3.2 plan.dod — [G]

Generates the Definition of Done in one model call — the completion-check half the original draft
carried inside the merged plan.ac call (FOC-474; §3.3 has the AC half). ADR-0012's own [G]
examples (D1 as amended: "PLAN's Definition of Done and acceptance criteria"). Never decides a
gate: DoD quality is input material for spec and the gates, never a verdict (D7: only
[J]/[D]/[H] decide gates).
**Contract:** reads `inbox.entry` (the dictated issue text — the DoD derives from the issue's own
scope) → bounded output `{ definitionOfDone (1..12) }` (schema in §3.11); tier `cheap`; failure
`stop` (fail-closed — no unvalidated text flows to spec); writes `run-record`. It does NOT read
`features.list` — that input belongs to plan.ac's contract; a [G] call never silently receives a
sibling call's inputs unless its own contract names them (§3 argued change 3). **Frontman: none**
— a failed generation stops the chain at a typed record; escalation policy is the runner's
(FOC-397).

### 3.3 plan.ac — [G]

Generates acceptance criteria in one model call — the DoD half moved to `plan.dod` (§3.2, FOC-474);
this is the acceptance-criteria half (FOC-475). ADR-0012's own [G] examples (D1 as amended: "PLAN's
acceptance criteria"). The full end-to-end walk-through is §4. Never decides a gate: AC quality is
input material for spec and review, never a verdict (D7: only [J]/[D]/[H] decide gates).
**Contract:** reads `inbox.entry`, `features.list` → bounded output `{ acs (1..12) }` — each
criterion `{id, text, kind, evidence}`, where `evidence` (enum `test | command_output | file_state |
human_check`) names what would demonstrate the criterion (schema in §3.11); tier `cheap`; failure
`stop` (fail-closed — no unvalidated text flows to spec); writes `run-record`. **Frontman: none**
— a failed generation stops the chain at a typed record; escalation policy is the runner's
(FOC-397). **Node-internal testable gate (FOC-452 carry, FOC-475):** the generated criteria are
scored by the node itself, right after the generation call, through the `plan.ac.testable` registry
entry — one `noul` per criterion served via the seam's instances channel (`{state, decisionId,
instances}`), verdict p ≥ 0.5. Any criterion below the verdict triggers exactly ONE regeneration
whose inputs carry the failing criteria and the gate's reasons, after which ALL criteria are
re-scored; still below → the step fails closed with a typed escalation record (per-criterion
verdicts, reasons, attempt count). The loop is node-internal — not a decision edge, and no graph
edge is added (the graph-level retry edge is FOC-476's); the stepFlow and the 8-step chain are
unchanged.

### 3.4 plan.spec — [A]

Discovery + brief/ADR drafting needs interactive tool use with side effects and context
accumulation across many turns — the [A] classification rule (ADR-0012 D1); GAPS §4 lists "PLAN
spec" as the [A] step. This is where the v1 plan node's LLM work genuinely belongs.
**Contract:** reads `inbox.entry`, `plan.dod.definitionOfDone`, `plan.ac.acs`, `repoState.pinned` →
output `{ briefs: string[] (paths, max 8), adr: string, summary: string (max 2000) }` — the typed
record carries paths, not prose (artifacts live on disk); tier `agent`; failure `escalate` (the
terminal behaviour after the runner's retry policy — the v1 two-strikes shape stays runner policy,
FOC-397); writes `run-record`. **Frontman:** none on the happy path (fresh-context child in its own
worktree); he stays in the loop only when the step escalates, or to compose gate1's question if the
typed record alone is insufficient context for Mateusz.

### 3.5 plan.ready — [J]

A pre-gate readiness check on the produced plan artifacts: is the assembled plan (DoD, ACs, spec)
complete and internally coherent enough to put in front of Mateusz? A bounded judgment with a
typed answer — classic [J], and a sibling of plan.dor (§3.1), NOT a duplicate: plan.dor assesses
the raw inbox entry before any work starts, plan.ready assesses what the steps produced, after
spec and before gate1 (FOC-476).
It is a retry-then-escalate [J], not an [H] gate: the answer is never a human decision. A
`ready: false` answer routes back — via the step-level decide edge (§5, §6.4) — to the step named
in `failedStep`, carrying `reason`; that step re-runs on its own declared inputs and the chain
reaches plan.ready again. A SECOND `ready: false` from the same step escalates — the terminal
rung, not a third loop.
**Contract:** reads `plan.dod.record`, `plan.ac.record`, `plan.spec.record` → output
`{ ready: boolean, failedStep: plan.dod|plan.ac|plan.spec|none, reason: string (max 300, set when
ready=false) }`; tier
D2 cascade, min pin 1 (§6.3); failure `escalate` — the terminal behaviour only: the first
`ready: false` is not a step failure, it is the retry edge; a second no from the same step, or a
failed call, escalates; writes `run-record`. **Frontman:** none on the happy path (`ready: true`
is a runner-side cheap call); he enters only on the second-failure escalation rung, or to compose
gate1's context if the retry exhausted and the typed record alone is insufficient for Mateusz.

### 3.6 plan.gate1 — [H] — the intent conversation (FOC-517)

Plan approval here is the intent conversation: ≤3 quick rounds BEFORE any spec is written —
"czy dobrze rozumiem?" (Mateusz, 2026-09-23). The gate stays a human decision relayed mechanically
(GAPS §4: "czego nie ruszać: kontraktu gate'ów" — the KINDS list is untouched; only position and
reads changed).

**Display ([D] code, from FOC-516's selection).** Polish, ≤14 lines, header
`Czy dobrze rozumiem? (runda n/3)`, three blocks rendered from `plan.intent.select.record` +
`plan.intent.record` (the map supplies the quotes):

- **"Rozumiem tak"** — the selection's `understood` items, each with its quoted fragment;
- **"Założyłem — popraw, jeśli źle"** — lettered (a, b, …): the `confirmations` and `assumptions`;
- **"Pytania"** — numbered (1, 2, …), each with lettered options (a, b, …), the recommended one
  marked — the selection's `questions`.

The 4-question selection cap bounds block 3; when the 14-line budget runs out the renderer omits
the lowest-priority items with an explicit `… (+N w rekordzie)` marker — omitted items are NOT
presented (never answerable, never confirmed by `ok`) and reappear in the next round's selection
(the FOC-516 dedupe only drops answered claims). The exact items shown are persisted as
`presented[round]` on the gate record — the answer contract's ground truth.

**Accepted answers** (free text relayed from the gate; parsed by [D] code against
`presented[round]`):

- `ok` — accepts everything plus the recommended options;
- `B nie, …` — corrects one lettered assumption/confirmation item (a correction);
- `1b 2a` — picks options for the numbered questions;
- free dictated text (voice) — not deterministically parseable: the `plan.intent.reply` [J]
  classifier annotates it (A0), the annotation is shown to the frontman next to the raw answer, and
  the round is settled by the frontman's decision — nothing is auto-acted until calibrated (M3).

**Round mechanics.** `confirmed` = no corrections AND every presented question answered (`ok`
answers all with the recommended options). Not confirmed → the runner re-enters `plan.intent`
(the re-entry edge) with the round's answers/corrections folded — the map regenerates (§3.12),
select re-asks only what is unanswered, gate1 shows round n+1. After 3 rounds without confirmation
the chain stops with a typed **`intent_not_settled`** record — it never plans on an unconfirmed
intent.

**Contract:** reads `plan.intent.select.record`, `plan.intent.record` → output
`{ approved: boolean, answer?: string (≤2000), confirmed?: boolean, round?: integer (1..3),
answers?: […], corrections?: […], presented?: {…} }` — the deciding agent's resolution writes only
`{approved, answer}`; the runner computes the rest from the immutable stores and REFUSES a
resolution whose self-carried copies disagree (fail-closed, same trust model as `about`).
`approved: false` stays gate-rejected (terminal — the conversation is killed, not continued).
tier `null`; failure `stop`; writes `graph-state`. On confirmation the runner appends the derived
**`plan.intent.confirmed`** record = the final map + answers (§3.12) — `plan.dod`/`plan.ac` read it
instead of `inbox.entry`. **Frontman:** relays mechanically; for free-text answers he also sees the
`plan.intent.reply` annotation next to the raw answer and settles the round — the frontman's only
per-round turn, and an A0-posture one (the classification is recorded, never acted on its own).
**Mateusz decides** what the answer meant; a [G] node never decides this gate.

### 3.7 plan.decompose — [J]

The epic/subtask split — which features group, per-task size, relations — is a bounded judgment
with a typed answer ([J]); its built analogue is the prompt-refinement family (CAT: size
classification + per-feature relations). The size → engagement mapping stays **[D] code**
(`squadsForSize` — CAT: "the size → squads map is code, not a model opinion"); numeric estimates
are [D]-derived from the size enum via a config table — zero arithmetic in the model (MAP §1).
**Contract:** reads `plan.spec.record`, `plan.ac.acs` → output `{ tasks: [{title, size:
small|medium|large, labels, relations}] (max 12) }`; tier D2 cascade, min pin 1; failure
`escalate`; writes `run-record`. **Frontman:** none on the happy path; escalation rung only.

### 3.8 plan.gate2 — [H]

Push approval — v1's `plan.gate2`; `config/graph.json` plan.failure already forbids pushing without
it. Human decision, gate contract untouched. **FOC-517:** gate2 is the ONE final approval of plan +
tasks before push, so it also reads the confirmed intent's downstream artefacts:
**Contract:** reads `plan.spec.record`, `plan.decompose.record`, `gate.plan.gate1.record` (which
carries the conversation's `confirmed`/`round`/`new_scope` annotations, if any) and
`plan.render.issueText` (the rendered text — what the gate shows is what would be pushed) →
`{ approved: boolean }`; tier `null`; failure `stop`; writes `graph-state`. **Frontman:** relays
mechanically; Mateusz decides.

### 3.9 plan.push — [D]

Idempotent Linear push from the typed breakdown plus gate2 approval is fully determined by its
inputs — a pure script (v1 plan.completion: "Re-running must not duplicate issues"). This is the
D1 [D] rule: content-deterministic work executed by an LLM today (GAPS §3.2) must become code.
**Contract:** reads `plan.decompose.record`, `gate.plan.gate2.record` → output `{ epicId: string,
childrenIds: string[] (max 12), handoffCommentPosted: boolean }`; tier `null`; failure `stop`
(never push on a gate miss — fail-closed); writes `run-record` (the Linear side effects are the
record's content). **Frontman: none** — the push is code; its approval was human (gate2).

### 3.10 Frontman involvement — the per-step answer (AC2)

On the happy path the frontman runs **zero judgment turns** in PLAN: dod and ac are cheap-tier [G]
calls, dor/decompose/ready are cheap-tier [J] calls — all made by the runner; spec is an [A] child
with fresh context; push is a script; and both gates are human decisions relayed mechanically. He
remains only for exceptions: (a) the escalation rung under [J]/[A] failures — including plan.ready's
second no (§3.5) — and below-threshold confidence (D2's ladder ends at the frontman, then
Mateusz), (b) composing gate context when typed records are insufficient, (c) post-push drift
handling. That is AC2's "only for exceptions" target, per step above.

One honest scope note (GAPS §3.9): PLAN is ~1.7% of corrected token volume — the decomposition is a
**quality and legibility** lever, not a cost lever. The cost lever is §5's decide-edges and §8's
arithmetic.

### 3.11 Worked example — PLAN's steps as v2 JSON (complete, valid)

The block below is the **plan-node delta** to `config/graph.json` (Option A, §6.1): dev/review/
test/cadence/human and the top-level `edges` array stay v1-unchanged. Step objects carry exactly
the D7 field list (id = its key, kind, reads, output, tier, failure, writes) — nothing else.
**Revision (FOC-517, 2026-10-01):** the block below is generated verbatim from the committed
`config/graph.json` — 11 steps; `stepFlow` = 10 `sequence` edges plus ONE `reentry` edge
(`plan.gate1 → plan.intent`, the intent conversation's loop, §3.6) — the first reentry edge of its
kind in the schema (§6.4). plan.ready and its step-level decide edge are FOC-476's deliverable
(this issue blocks FOC-476) and are NOT shown. Fields outside `steps`/`stepFlow` are the v1 squad
contract, kept verbatim for the nine consumers.

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
          "reads": [
            "inbox.entry",
            "repoState.pinned"
          ],
          "output": {
            "type": "object",
            "required": [
              "ready",
              "gaps"
            ],
            "additionalProperties": false,
            "properties": {
              "ready": {
                "type": "boolean"
              },
              "gaps": {
                "type": "array",
                "maxItems": 8,
                "items": {
                  "type": "string",
                  "maxLength": 200
                }
              }
            }
          },
          "tier": {
            "cascade": true,
            "min": 1
          },
          "failure": "escalate",
          "writes": "run-record"
        },
        "plan.intent": {
          "kind": "G",
          "reads": [
            "inbox.entry",
            "plan.dor.gaps",
            "intake.taskType",
            "gate.plan.gate1.answers",
            "gate.plan.gate1.corrections"
          ],
          "output": {
            "type": "object",
            "required": [
              "goal",
              "why",
              "mapVersion",
              "interpretations"
            ],
            "additionalProperties": false,
            "properties": {
              "goal": {
                "type": "string",
                "minLength": 1,
                "maxLength": 300
              },
              "why": {
                "type": "string",
                "minLength": 1,
                "maxLength": 300
              },
              "mapVersion": {
                "type": "integer",
                "minimum": 1
              },
              "idMap": {
                "type": "object",
                "maxProperties": 12,
                "additionalProperties": false,
                "propertyNames": {
                  "pattern": "^IN-([1-9]|1[0-2])$"
                },
                "patternProperties": {
                  "^IN-([1-9]|1[0-2])$": {
                    "type": "string",
                    "pattern": "^IN-([1-9]|1[0-2])$"
                  }
                }
              },
              "interpretations": {
                "type": "array",
                "minItems": 1,
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "required": [
                    "id",
                    "perspective",
                    "claim",
                    "source",
                    "alternatives",
                    "covers"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^IN-([1-9]|1[0-2])$"
                    },
                    "perspective": {
                      "enum": [
                        "goal",
                        "user",
                        "scope",
                        "success",
                        "constraints",
                        "risk",
                        "priority",
                        "terms"
                      ]
                    },
                    "claim": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "source": {
                      "enum": [
                        "stated",
                        "inferred",
                        "unknown"
                      ]
                    },
                    "quote": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 150
                    },
                    "alternatives": {
                      "type": "array",
                      "maxItems": 3,
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      }
                    },
                    "covers": {
                      "type": "array",
                      "maxItems": 3,
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      }
                    },
                    "options": {
                      "type": "array",
                      "minItems": 2,
                      "maxItems": 4,
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "recommended"
                        ],
                        "additionalProperties": false,
                        "properties": {
                          "text": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          },
                          "recommended": {
                            "type": "boolean"
                          },
                          "reason": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 150
                          }
                        }
                      }
                    }
                  },
                  "allOf": [
                    {
                      "if": {
                        "properties": {
                          "source": {
                            "const": "stated"
                          }
                        },
                        "required": [
                          "source"
                        ]
                      },
                      "then": {
                        "required": [
                          "quote"
                        ],
                        "properties": {
                          "quote": {
                            "type": "string",
                            "minLength": 1
                          }
                        }
                      }
                    },
                    {
                      "if": {
                        "properties": {
                          "source": {
                            "const": "unknown"
                          }
                        },
                        "required": [
                          "source"
                        ]
                      },
                      "then": {
                        "required": [
                          "options"
                        ],
                        "not": {
                          "required": [
                            "quote"
                          ]
                        }
                      }
                    },
                    {
                      "if": {
                        "properties": {
                          "source": {
                            "enum": [
                              "stated",
                              "inferred"
                            ]
                          }
                        },
                        "required": [
                          "source"
                        ]
                      },
                      "then": {
                        "not": {
                          "required": [
                            "options"
                          ]
                        }
                      }
                    }
                  ]
                }
              }
            }
          },
          "tier": "cheap",
          "failure": "stop",
          "writes": "run-record"
        },
        "plan.intent.select": {
          "kind": "G",
          "reads": [
            "plan.intent.record",
            "gate.plan.gate1.answers",
            "gate.plan.gate1.corrections"
          ],
          "output": {
            "type": "object",
            "required": [
              "mapVersion",
              "questions",
              "confirmations",
              "understood",
              "assumptions"
            ],
            "additionalProperties": false,
            "properties": {
              "mapVersion": {
                "type": "integer",
                "minimum": 1
              },
              "questions": {
                "type": "array",
                "maxItems": 4,
                "items": {
                  "type": "object",
                  "required": [
                    "id",
                    "claim",
                    "options",
                    "impactProbability"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^IN-([1-9]|1[0-2])$"
                    },
                    "claim": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "options": {
                      "type": "array",
                      "minItems": 2,
                      "maxItems": 4,
                      "items": {
                        "type": "object",
                        "required": [
                          "text",
                          "recommended"
                        ],
                        "additionalProperties": false,
                        "properties": {
                          "text": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          },
                          "recommended": {
                            "type": "boolean"
                          },
                          "reason": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 150
                          }
                        }
                      }
                    },
                    "impactProbability": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 1
                    }
                  }
                }
              },
              "confirmations": {
                "type": "array",
                "maxItems": 4,
                "items": {
                  "type": "object",
                  "required": [
                    "id",
                    "claim",
                    "impactProbability"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^IN-([1-9]|1[0-2])$"
                    },
                    "claim": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "impactProbability": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 1
                    }
                  }
                }
              },
              "understood": {
                "type": "array",
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "required": [
                    "id",
                    "claim",
                    "groundedProbability"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^IN-([1-9]|1[0-2])$"
                    },
                    "claim": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "groundedProbability": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 1
                    }
                  }
                }
              },
              "assumptions": {
                "type": "array",
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "required": [
                    "id",
                    "claim",
                    "impactProbability",
                    "reason"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^IN-([1-9]|1[0-2])$"
                    },
                    "claim": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "impactProbability": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 1
                    },
                    "reason": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    }
                  }
                }
              }
            }
          },
          "tier": "cheap",
          "failure": "stop",
          "writes": "run-record"
        },
        "plan.dod": {
          "kind": "G",
          "reads": [
            "plan.intent.confirmed"
          ],
          "output": {
            "type": "object",
            "required": [
              "definitionOfDone"
            ],
            "additionalProperties": false,
            "properties": {
              "definitionOfDone": {
                "type": "array",
                "minItems": 1,
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "required": [
                    "check",
                    "kind",
                    "bounded"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "check": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "kind": {
                      "enum": [
                        "test",
                        "lint",
                        "manual",
                        "linear"
                      ]
                    },
                    "bounded": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          },
          "tier": "cheap",
          "failure": "stop",
          "writes": "run-record"
        },
        "plan.ac": {
          "kind": "G",
          "reads": [
            "plan.intent.confirmed",
            "features.list"
          ],
          "output": {
            "type": "object",
            "required": [
              "acs"
            ],
            "additionalProperties": false,
            "properties": {
              "acs": {
                "type": "array",
                "minItems": 1,
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "required": [
                    "id",
                    "text",
                    "kind",
                    "evidence"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "id": {
                      "type": "string",
                      "pattern": "^AC-[0-9]{1,2}$"
                    },
                    "text": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 300
                    },
                    "kind": {
                      "enum": [
                        "behaviour",
                        "boundary",
                        "verification"
                      ]
                    },
                    "evidence": {
                      "type": "string",
                      "enum": [
                        "test",
                        "command_output",
                        "file_state",
                        "human_check"
                      ]
                    }
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
          "reads": [
            "plan.intent.confirmed",
            "inbox.entry",
            "plan.dod.definitionOfDone",
            "plan.ac.acs",
            "repoState.pinned"
          ],
          "output": {
            "type": "object",
            "required": [
              "briefs",
              "adr",
              "summary"
            ],
            "additionalProperties": false,
            "properties": {
              "briefs": {
                "type": "array",
                "maxItems": 8,
                "items": {
                  "type": "string",
                  "maxLength": 200
                }
              },
              "adr": {
                "type": "string",
                "maxLength": 200
              },
              "summary": {
                "type": "string",
                "maxLength": 2000
              }
            }
          },
          "tier": "agent",
          "failure": "escalate",
          "writes": "run-record"
        },
        "plan.gate1": {
          "kind": "H",
          "reads": [
            "plan.intent.select.record",
            "plan.intent.record"
          ],
          "output": {
            "type": "object",
            "required": [
              "approved"
            ],
            "additionalProperties": false,
            "properties": {
              "approved": {
                "type": "boolean"
              },
              "answer": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "confirmed": {
                "type": "boolean"
              },
              "round": {
                "type": "integer",
                "minimum": 1,
                "maximum": 3
              },
              "answers": {
                "type": "array",
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "required": [
                    "round",
                    "mapVersion",
                    "interpretationId"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "round": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 3
                    },
                    "mapVersion": {
                      "type": "integer",
                      "minimum": 1
                    },
                    "interpretationId": {
                      "type": "string",
                      "pattern": "^IN-([1-9]|1[0-2])$"
                    },
                    "about": {
                      "type": "object",
                      "required": [
                        "claim"
                      ],
                      "additionalProperties": false,
                      "properties": {
                        "claim": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200
                        },
                        "option": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200
                        }
                      }
                    },
                    "answer": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000
                    },
                    "acceptedOptions": {
                      "type": "array",
                      "maxItems": 4,
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 200
                      }
                    }
                  }
                }
              },
              "corrections": {
                "type": "array",
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "required": [
                    "round",
                    "mapVersion",
                    "interpretationId",
                    "corrected"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "round": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 3
                    },
                    "mapVersion": {
                      "type": "integer",
                      "minimum": 1
                    },
                    "interpretationId": {
                      "type": "string",
                      "pattern": "^IN-([1-9]|1[0-2])$"
                    },
                    "about": {
                      "type": "object",
                      "required": [
                        "claim"
                      ],
                      "additionalProperties": false,
                      "properties": {
                        "claim": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 200
                        }
                      }
                    },
                    "corrected": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 2000
                    }
                  }
                }
              },
              "presented": {
                "type": "object",
                "minProperties": 1,
                "maxProperties": 3,
                "propertyNames": {
                  "pattern": "^[123]$"
                },
                "additionalProperties": {
                  "type": "object",
                  "required": [
                    "mapVersion"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "mapVersion": {
                      "type": "integer",
                      "minimum": 1
                    },
                    "understood": {
                      "type": "array",
                      "maxItems": 12,
                      "items": {
                        "type": "object",
                        "required": [
                          "id",
                          "claim"
                        ],
                        "additionalProperties": false,
                        "properties": {
                          "id": {
                            "type": "string",
                            "pattern": "^IN-([1-9]|1[0-2])$"
                          },
                          "claim": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          }
                        }
                      }
                    },
                    "confirmations": {
                      "type": "array",
                      "maxItems": 12,
                      "items": {
                        "type": "object",
                        "required": [
                          "id",
                          "claim"
                        ],
                        "additionalProperties": false,
                        "properties": {
                          "id": {
                            "type": "string",
                            "pattern": "^IN-([1-9]|1[0-2])$"
                          },
                          "claim": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          }
                        }
                      }
                    },
                    "assumptions": {
                      "type": "array",
                      "maxItems": 12,
                      "items": {
                        "type": "object",
                        "required": [
                          "id",
                          "claim"
                        ],
                        "additionalProperties": false,
                        "properties": {
                          "id": {
                            "type": "string",
                            "pattern": "^IN-([1-9]|1[0-2])$"
                          },
                          "claim": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          }
                        }
                      }
                    },
                    "questions": {
                      "type": "array",
                      "maxItems": 4,
                      "items": {
                        "type": "object",
                        "required": [
                          "id",
                          "claim",
                          "options"
                        ],
                        "additionalProperties": false,
                        "properties": {
                          "id": {
                            "type": "string",
                            "pattern": "^IN-([1-9]|1[0-2])$"
                          },
                          "claim": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 200
                          },
                          "options": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 4,
                            "items": {
                              "type": "object",
                              "required": [
                                "text",
                                "recommended"
                              ],
                              "additionalProperties": false,
                              "properties": {
                                "text": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 200
                                },
                                "recommended": {
                                  "type": "boolean"
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            "allOf": [
              {
                "if": {
                  "properties": {
                    "approved": {
                      "const": true
                    }
                  },
                  "required": [
                    "approved"
                  ]
                },
                "then": {
                  "required": [
                    "answer"
                  ]
                }
              }
            ]
          },
          "tier": null,
          "failure": "stop",
          "writes": "graph-state"
        },
        "plan.decompose": {
          "kind": "J",
          "reads": [
            "plan.spec.record",
            "plan.ac.acs"
          ],
          "output": {
            "type": "object",
            "required": [
              "tasks"
            ],
            "additionalProperties": false,
            "properties": {
              "tasks": {
                "type": "array",
                "minItems": 1,
                "maxItems": 12,
                "items": {
                  "type": "object",
                  "required": [
                    "title",
                    "size",
                    "labels",
                    "relations"
                  ],
                  "additionalProperties": false,
                  "properties": {
                    "title": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    },
                    "size": {
                      "enum": [
                        "small",
                        "medium",
                        "large"
                      ]
                    },
                    "labels": {
                      "type": "array",
                      "maxItems": 8,
                      "items": {
                        "type": "string",
                        "maxLength": 60
                      }
                    },
                    "relations": {
                      "type": "array",
                      "maxItems": 8,
                      "items": {
                        "type": "string",
                        "maxLength": 60
                      }
                    }
                  }
                }
              }
            }
          },
          "tier": {
            "cascade": true,
            "min": 1
          },
          "failure": "escalate",
          "writes": "run-record"
        },
        "plan.render": {
          "kind": "D",
          "reads": [
            "plan.dod.definitionOfDone",
            "plan.ac.acs",
            "plan.spec.summary",
            "plan.decompose.record"
          ],
          "output": {
            "type": "object",
            "required": [
              "issueText"
            ],
            "additionalProperties": false,
            "properties": {
              "issueText": {
                "type": "string",
                "minLength": 1,
                "maxLength": 30000
              }
            }
          },
          "tier": null,
          "failure": "stop",
          "writes": "run-record"
        },
        "plan.gate2": {
          "kind": "H",
          "reads": [
            "plan.spec.record",
            "plan.decompose.record",
            "gate.plan.gate1.record",
            "plan.render.issueText"
          ],
          "output": {
            "type": "object",
            "required": [
              "approved"
            ],
            "additionalProperties": false,
            "properties": {
              "approved": {
                "type": "boolean"
              }
            }
          },
          "tier": null,
          "failure": "stop",
          "writes": "graph-state"
        },
        "plan.push": {
          "kind": "D",
          "reads": [
            "plan.decompose.record",
            "plan.render.issueText",
            "gate.plan.gate2.record"
          ],
          "output": {
            "type": "object",
            "required": [
              "epicId",
              "childrenIds",
              "handoffCommentPosted"
            ],
            "additionalProperties": false,
            "properties": {
              "epicId": {
                "type": "string",
                "maxLength": 20
              },
              "childrenIds": {
                "type": "array",
                "maxItems": 12,
                "items": {
                  "type": "string",
                  "maxLength": 20
                }
              },
              "handoffCommentPosted": {
                "type": "boolean"
              }
            }
          },
          "tier": null,
          "failure": "stop",
          "writes": "run-record"
        }
      },
      "stepFlow": [
        {
          "from": "plan.dor",
          "to": "plan.intent",
          "type": "sequence"
        },
        {
          "from": "plan.intent",
          "to": "plan.intent.select",
          "type": "sequence"
        },
        {
          "from": "plan.intent.select",
          "to": "plan.gate1",
          "type": "sequence"
        },
        {
          "from": "plan.gate1",
          "to": "plan.dod",
          "type": "sequence"
        },
        {
          "from": "plan.gate1",
          "to": "plan.intent",
          "type": "reentry",
          "why": "FOC-517 intent conversation: a round answered without confirmation (corrections, or presented questions left unanswered) re-enters plan.intent — the map regenerates with the round's answers/corrections folded, plan.intent.select re-asks only what is unanswered, plan.gate1 shows round n+1 of 3. Three rounds without confirmation stop the chain typed (intent_not_settled) — the plan is never built on an unconfirmed intent."
        },
        {
          "from": "plan.dod",
          "to": "plan.ac",
          "type": "sequence"
        },
        {
          "from": "plan.ac",
          "to": "plan.spec",
          "type": "sequence"
        },
        {
          "from": "plan.spec",
          "to": "plan.decompose",
          "type": "sequence"
        },
        {
          "from": "plan.decompose",
          "to": "plan.render",
          "type": "sequence"
        },
        {
          "from": "plan.render",
          "to": "plan.gate2",
          "type": "sequence"
        },
        {
          "from": "plan.gate2",
          "to": "plan.push",
          "type": "sequence"
        }
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

### 3.12 plan.intent — [G] — the interpretation map (FOC-515)

One bounded model call that writes the **interpretation map** — what PLAN understood from the
inbox entry, from where (stated, inferred or unknown), and what it does not know — before anything
is put to Mateusz. Chain position: between `plan.dor` (§3.1) and `plan.intent.select` (FOC-516,
designed separately) — dor assesses readiness and lists gaps, intent turns the entry into a typed
map of readings, select scores that map into gate questions. The node does NOT write questions;
which interpretations become questions is entirely FOC-516's — selection by significance and
uncertainty. **Flagged, not silently resolved:** for two points only, this section supersedes the
§3 preamble's argued changes 1–2 — `plan.gate1` moves from after spec to after the intent steps
(the chain runs `plan.dor → plan.intent → plan.intent.select → plan.gate1 → plan.dod → …`), and the
interpretation work change 2 folded into `plan.spec` moves out into `plan.intent` (spec keeps
drafting, not first-reading). §3.11's worked example predates this node — extending its JSON block
is follow-up; the preamble is not edited here.

**Perspective catalogue.** The map's coverage grid — eight readings PLAN must pin down per entry,
each weighted (per FOC-515) for the task types where it earns its keep:

| perspective | what PLAN must pin down | weighted for |
|---|---|---|
| goal | what should change for Mateusz, and why | all |
| user | who uses the result | feature |
| scope | what is in, what is explicitly out | all |
| success | how he will recognise it works (feeds DoD/AC) | all |
| constraints | what must not change: compatibility, cost, time | feature, refactor, research |
| risk | data, secrets, external systems, irreversible steps | all (required via base) |
| priority | quick MVP vs thorough; what matters most if time runs out | feature, research |
| terms | uncertain words from voice dictation (v1 transcript-uncertain) | all |

**Decision (2026-09-24) — one rule for `risk`:** required in the internal map for every task type
(via the `base` set, see the table below) and NO obligation to ask a question. The row's former
"weighted for" emphasis guidance is REMOVED as ambiguous — this single rule is the whole policy.

**Task-type → perspectives ([D] config).** Which perspectives a given task requires is a
configuration table read by check (b) — not a model opinion at call time. The taxonomy is
`config/linear/labels.json` → `type.labels` = `["feature", "bug", "spike", "tech", "docs", "test",
"chore"]` — the same seven keys `plan.labels.type` pins. The catalogue's "all" set is
{goal, scope, success, terms}; the **base** set is "all" plus `risk` — **Decision (2026-09-24):
`risk` is required in the internal map for EVERY task type**, and its presence obliges no question
to Mateusz (FOC-516 selects questions by significance and uncertainty). The weighting vocabulary
maps onto the repo taxonomy as feature → feature, refactor → tech, research → spike (**Decision
(2026-09-24)** — confirmed; docs/test/chore have no row in the issue's weighting):

| task type | required perspectives | why |
|---|---|---|
| feature | base + user + constraints + priority | user-facing change; compatibility and the MVP/thorough trade-off matter |
| bug | base | a fix must not break data, secrets or external systems |
| spike | base + constraints + priority | timeboxed research — cost and the quick-vs-thorough call are the point |
| tech | base + constraints | refactor/infra — nothing may change observably, irreversible steps lurk |
| docs | base | documentation scope and success are the whole task |
| test | base | coverage intent and success definition are the whole task |
| chore | base | maintenance scope and success definition are the whole task |

The table lives in config — proposed `config/intent-perspectives.json`; the exact location is the
implementation phase's call — and is read by check (b).
**Decision (2026-09-24) — mapping (formerly F3):** the issue's weighting vocabulary
(feature/refactor/research) maps onto the repo's seven labels as tabulated (refactor → tech,
research → spike); re-drawing it is a committed config edit, not a prompt change.
**Decision (2026-09-24) — risk trigger (formerly F4):** there is NO phrase-trigger detector and none
will be built — the read surface carries no such signal at all. `risk` is covered by requiring it
in every type row via the `base` set.

**Output schema.** The bounded Polish output contract — the same shape discipline as
`plan.dod`/`plan.ac` (§3.11): one object, `additionalProperties: false`, every string bounded:

```json
{
  "type": "object", "required": ["goal", "why", "mapVersion", "interpretations"], "additionalProperties": false,
  "properties": {
    "goal": { "type": "string", "minLength": 1, "maxLength": 300 },
    "why": { "type": "string", "minLength": 1, "maxLength": 300 },
    "mapVersion": { "type": "integer", "minimum": 1 },
    "idMap": {
      "type": "object", "maxProperties": 12, "additionalProperties": false,
      "propertyNames": { "pattern": "^IN-([1-9]|1[0-2])$" },
      "patternProperties": { "^IN-([1-9]|1[0-2])$": { "type": "string", "pattern": "^IN-([1-9]|1[0-2])$" } }
    },
    "interpretations": {
      "type": "array", "minItems": 1, "maxItems": 12,
      "items": {
        "type": "object", "required": ["id", "perspective", "claim", "source", "alternatives", "covers"],
        "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "pattern": "^IN-([1-9]|1[0-2])$" },
          "perspective": { "enum": ["goal", "user", "scope", "success", "constraints", "risk", "priority", "terms"] },
          "claim": { "type": "string", "minLength": 1, "maxLength": 200 },
          "source": { "enum": ["stated", "inferred", "unknown"] },
          "quote": { "type": "string", "minLength": 1, "maxLength": 150 },
          "alternatives": { "type": "array", "maxItems": 3, "items": { "type": "string", "minLength": 1, "maxLength": 200 } },
          "covers": { "type": "array", "maxItems": 3, "items": { "type": "string", "minLength": 1, "maxLength": 200 } },
          "options": {
            "type": "array", "minItems": 2, "maxItems": 4,
            "items": {
              "type": "object", "required": ["text", "recommended"], "additionalProperties": false,
              "properties": {
                "text": { "type": "string", "minLength": 1, "maxLength": 200 },
                "recommended": { "type": "boolean" },
                "reason": { "type": "string", "minLength": 1, "maxLength": 150 }
              }
            }
          }
        },
        "allOf": [
          { "if": { "properties": { "source": { "const": "stated" } }, "required": ["source"] }, "then": { "required": ["quote"], "properties": { "quote": { "minLength": 1 } } } },
          { "if": { "properties": { "source": { "const": "unknown" } }, "required": ["source"] }, "then": { "required": ["options"], "not": { "required": ["quote"] } } },
          { "if": { "properties": { "source": { "enum": ["stated", "inferred"] } }, "required": ["source"] }, "then": { "not": { "required": ["options"] } } }
        ]
      }
    }
  }
}
```

| field | bound | note |
|---|---|---|
| `goal` / `why` | strings ≤300, Polish | what should change for Mateusz / why it should change |
| `mapVersion` | integer ≥1, always present | identifies exactly ONE persisted map snapshot — allocated/validated by code at persist time, monotonic, never reused for another map (Decision 2026-09-24); the generator's hint is `1 +` the highest `mapVersion` the gate fields referenced (1 when none) |
| `idMap` | 0..12 × `IN-n` → `IN-n` | present only when ids were RENUMBERED between map versions — verbatim-identical content only (pure id translation; never a content change, never a carrier of confirmation — Decision 2026-09-24) |
| `interpretations` | 1..12 items per map version | the cap binds the ACTIVE map (each version is 1..12); rounds continue past a full 12-slot map (Decision 2026-09-24) |
| `id` | pattern `^IN-([1-9]|1[0-2])$` | mirrors plan.ac's `^AC-…`; no leading-zero aliases, capped at 12 PER MAP VERSION — identity is the pair (`mapVersion`, `id`) |
| `claim` | ≤200, Polish, first person "Rozumiem, że …" | for `source: unknown` it must name what is not established ("Rozumiem, że z opisu nie wynika, …") |
| `quote` | ≤150 | REQUIRED and non-empty when `source: stated`; optional for `inferred`; omitted for `unknown` (Decision 2026-09-24) |
| `alternatives` | 0..3 × ≤200 | other plausible readings |
| `covers` | 0..3 × ≤200, each verbatim-EQUAL to one entry of `plan.dor.gaps` | ADDED field (not in the AC's field list) so check (a) is computable in code — **Decision (2026-09-24): stays** (formerly F1); the check confirms the formal linkage, its semantic quality is judged in the eval |
| `options` | 2..4 × `{ text ≤200, recommended: bool, reason ≤150 }` | REQUIRED iff `source: unknown`, absent otherwise; EXACTLY one `recommended: true`; `reason` required iff `recommended` |

Four rules the schema cannot express and the [D] validation code enforces: exactly-one-
`recommended: true` per `options`; `reason` present iff `recommended`; every `id` EXACTLY ONCE
within `interpretations` (answers/corrections are keyed by `IN-` id — a duplicate or alias would
corrupt the round-2 fold); no empty strings anywhere in the output. The `covers` field exists
because `plan.dor.gaps` entries are plain strings without ids (§3.1's output
`{ready, gaps[≤8 × ≤200]}`) — a reference must carry the gap text itself, not an id. One compact
`stated` example: `{ "id": "IN-3", "perspective": "scope", "claim": "Rozumiem, że zmiana
dotyczy wyłącznie walidatora grafu.", "source": "stated", "quote": "squad nodes keep their v1
contract fields", "alternatives": ["Rozumiem, że cały plik przechodzi przegląd."], "covers": [] }`.

**Read surface.** **Contract:** reads `inbox.entry`, `plan.dor.gaps`, `<task type from intake>`,
`gate.plan.gate1.answers`, `gate.plan.gate1.corrections` → bounded output
`{ goal, why, mapVersion, idMap?, interpretations (1..12) }` (schema above); tier `cheap`; failure
`stop`; writes `run-record`. The task type is delivered as `intake.taskType` — **Decision
(2026-09-24) (formerly F6):** the name is accepted; the CONTRACT OWNER is the intake / input
adapter (the FOC-397 intake side), which supplies the type from task metadata and supplies an
EXPLICIT `unknown` when it cannot be determined. The field does not exist yet (a grep of
`config/graph.json` and `config/decisions.json` for intake outputs finds the three landed [J] intake
decisions but NO run-record output path carrying a task type) — a contract to be implemented on the
intake side, not a ready integration. **Anything answerable from the repo is NOT a question — it
belongs to the [D] pinned state or to plan.spec** (conventions and repo-derivable facts included).
Rounds: round 1 reads only `inbox.entry`, `plan.dor.gaps` and the task type; from round 2 the two
gate fields join — the map is re-generated per gate1 round. The steps stay separate `G → J/D → H`,
with `plan.intent` re-invoked in the next round (**Decision (2026-09-24) (formerly F7)**: the whole
conversation is NOT closed inside one [G] step); the conversation mechanics and the `≤3 rounds`
limit are FOC-517's. The gate1 → plan.intent re-entry (round 2+) rode §6.4's edge types as a
RESOLVED flag: FOC-517 landed the `reentry` edge type there (one instance, fixed target, round-cap
bounded — see §6.4's table); this section's former "no representation" flag is closed.
**Decision (2026-09-24) (formerly F5):** `gate.plan.gate1.answers` / `.corrections` do not exist in
the run-record contract yet (§3.6: plan.gate1's output is `{approved}` only) — their write side is
FOC-517's (the gate1 fields are in FOC-517's existing scope); §3.12 pins their read shape in the
answer contract below and treats the §3.6 contract update as FOC-517 follow-up.

**Answer contract (closed 2026-09-24; cross-round consistency tightened by decision the same
day).** What the two gate fields must satisfy — FOC-517's gate1 fields implement it; it is closed
here before implementation:

- **Reference triple.** Every answer/correction record carries the `round`, the `mapVersion` and the
  `interpretationId` (`IN-n`) it answers;
- **Validation source: the persisted map and the presented options (Decision 2026-09-24).** The
  validator reads its ground truth from two immutable run-record stores, never from the answer's own
  copy: (1) `run-record.plan.intent.maps[mapVersion]` — the map exactly as generated and persisted
  for that version (claim/option texts included), and (2)
  `run-record.gate.plan.gate1.presented[round]` — the exact items and option texts actually put to
  the user in that round. Their write side is FOC-517's (the gate1 fields plus the §3.6 contract
  update). An answer whose `mapVersion` names no persisted map, or whose round has no presented
  record, is STALE. The maps store is append-only per conversation — a persisted version is
  immutable once written;
- **Preserved content (`about` is a cross-check, not the source).** Each record still carries the
  `about` snapshot — the claim text (≤200) it answered, and the option text (≤200) when it answered
  an option — plus the answer text (a correction also carries the corrected content). `about` must
  MATCH the persisted texts verbatim, but `about` alone never validates anything (Decision
  2026-09-24);
- **Anchor for `stated` (Decision 2026-09-24).** Anchor text for a `quote` may sit in
  `inbox.entry`, in the user's actual answer, or in an explicitly ACCEPTED option from an earlier
  round. The model's own proposal never becomes `stated` by being offered. `quote` is REQUIRED for
  `stated`, OPTIONAL for `inferred`, ABSENT for `unknown` — non-empty whenever present. A user
  correction supersedes the earlier reading it answers (precedence);
- **Renumbering only (`idMap`).** `IN-` ids are stable across rounds; when ids are renumbered between
  two map versions the new map declares `idMap` (old → new). An `idMap` entry is legal ONLY between
  items whose content is verbatim-identical (same claim, same options where present) — it is pure id
  translation. An entry whose target content differs is CONTRACT-ILLEGAL: the fold rejects it and
  the reference is stale. `idMap` NEVER carries a user's confirmation onto a changed claim or option
  (Decision 2026-09-24). `mapVersion` identifies exactly one persisted map — allocated and validated
  by code at persist time, monotonic within the conversation, never reused for a different map; an
  old reference resolves only through its own persisted map and its `idMap` chain, never into
  another map. (`mapVersion`/`idMap` remain decision-mandated schema additions, like `covers`);
- **The 12 cap binds the ACTIVE map (Decision 2026-09-24).** Interpretation identity is the pair
  (`mapVersion`, `interpretationId`): `IN-` numbers are scoped to their map version and may recur in
  a later version (every reference pins its version, so nothing collides). Every round writes a NEW
  map of 1..12 items, so the conversation continues even when the first map used all 12 slots: a
  content change takes a fresh identity in the new map (no `idMap` link), the superseded item leaves
  the active map, and its own persisted version keeps the history. There is no conversation-level id
  pool to exhaust — the 12-item limit and the "content change needs a new identity" rule no longer
  conflict;
- **No re-binding, no inherited confirmation (Decision 2026-09-24).** A content change makes a
  different reading: NO earlier answer or confirmation attaches to it, and it reappears as
  `unknown`/`inferred`. The user's correction (`gate.plan.gate1.corrections`) is the separate,
  explicit source of such a change — and of any confirmation over the changed item. Renumbering
  never stands in for a correction;
- **Stale/unknown references are detected, never silently applied.** At fold time each reference
  must resolve (round ≤ current; `mapVersion` present in the persisted maps store, reachable through
  the `idMap` chain where renumbered; `interpretationId` present in that map) AND its `about`
  content must match the persisted claim/option verbatim. Otherwise it is STALE: detected, recorded
  in the `run-record` log, NOT applied, and the affected point must reappear as `unknown`/`inferred`
  in the new map (check (a) still covers it).

**[D] checks (fail closed).** Three checks in code, each REJECTING the node's output — never a
warning:

- **(a) coverage** — every entry of `plan.dor.gaps` is `covers`-referenced by at least one
  COUNTING interpretation: an interpretation counts when (i) its `source` is `unknown` or
  `inferred`, or (ii) it is round ≥2 and `stated` with its `quote` anchored per the answer contract
  (the resolved case). Explicitly: round 1 counts only `unknown`/`inferred` items — a `stated`
  item's `covers` is ignored by this check; from round 2, gate-anchored `stated` items count too;
- **(b) presence** — every perspective the task-type table requires for this task (the type row;
  `risk` is in every row via `base`) appears in at least one interpretation. Fail-closed on task
  type: an absent type, the explicit `unknown`, or a value outside the seven keys requires ALL EIGHT
  perspectives (the union of every type row);
- **(c) quote fidelity** — every `quote` occurs verbatim in the round's anchor text (answer
  contract): `inbox.entry` alone in round 1; from round 2 `inbox.entry` plus the user's actual
  answers and explicitly accepted options. Extended to any present `quote` — an `inferred` quote,
  when present, is verbatim too (the AC words the check for `stated` only; this deviation stands by
  Decision 2026-09-24).

**Decision (2026-09-24) (formerly F2) — anchor and quote presence:** the anchor set is the one
above (the AC words check (c) against `inbox.entry` only — the expansion to user answers and
accepted options stands by decision, and a model proposal is never anchor text). `quote` is
non-empty whenever present (schema-pinned `minLength 1`, re-checked in code) — the earlier
"non-empty iff stated" wording is REMOVED as contradictory. Sub-check: each `covers` entry equals a
`plan.dor.gaps` entry verbatim. The fold validation of the answer contract runs BEFORE these checks
on round ≥2 inputs and is fail-closed in the same sense. **Decision (2026-09-24) (formerly F1):
check (a) confirms the formal linkage only** — the semantic quality of each `covers` linkage is
judged in the eval, not in code. Failure behaviour: a rejected output is ONE retry, then the step
fails (`failure: "stop"`) — never a partial map.

**Latency and cost.** Budget measured ON THE EVAL SET: p90 ≤ 30 s, ≤ $0.01 per call — demonstrable
ONLY by that measurement (**Decision (2026-09-24)**: the arithmetic and the item-count bound below
are a hypothesis and a lever, never proof of p90). One call, no tools, bounded JSON. Proposed
model/tier: `tier: "cheap"` (D7), routed `routing.plan.intent: "glm53flash"` =
`z-ai/glm-5.3-flash` — the same tier as every other `routing.plan` role in `config/models.json`,
whose pricing row reads `"input": 0.075, "output": 0.25, "cacheRead": 0.015` (USD per 1M tokens).
Cost arithmetic (estimate): a typical call (~6k in, ~2.5k out) ≈ $0.001; the schema's worst case
(~15k in, ~7.5k out) ≈ $0.003 — 3× under the cap (cache reads only lower it). Latency arithmetic
(hypothesis): plan.dod's worst measured call on this model was 299.2 s for 16,348 output tokens
≈ 55 tok/s — at that rate a ~2.5k-out call takes ≈ 45 s, so p90 ≤ 30 s would require p90 output
≲ 1.5k tokens. The lever committed UPFRONT, not "if the eval misses": the node's prompt contract
asks for the smallest sufficient map (~8 items typical; up to 12 only when the required-perspectives
set demands it). The eval records, per call: latency, in/out tokens, cost, AND retries and errors —
the budget claim stands only over that table. No automatic tier switch (**Decision (2026-09-24)**):
`deepseek/deepseek-v4-flash` (pricing row `"input": 0.08554, "output": 0.17108`) is named as an
option for discussion only; when the measurement fails, the procedure is to publish the numbers and
propose the next step — Mateusz's decision, never a silent fallback. Registry note (nothing edited
in this phase): the `config/decisions.json` entry follows the existing field convention — the list
actually found on the landed entries (`plan.dod`, `plan.ac`, the intake [J]s) is `id, kind, owner,
hookPoint, autonomy, threshold, fallback, metrics, criteriaVersion, reads, output, tier, failure,
writes` (the [G] entries additionally carry `prompt`). For plan.intent: `kind: "G"`, `autonomy:
null`, `threshold: null` — never invent numbers. `metrics`: the landed `plan.dod`/`plan.ac` entries
use `["durationMs", "inputTokens", "outputTokens", "cost"]` — plan.intent's entry uses the same
four (`confidence` is the [J] entries' fifth metric, not a [G] one).

**Eval design.** `docs/benchmark/plan-intent-eval.md` — written in a later phase; §3.12 designs it
here. It mirrors `docs/benchmark/plan-dod-eval.md`'s structure: title
`# plan.intent [G] — interpretation-map eval (FOC-515)` → intro + bullets (harness / transport /
model / re-run) → `## Input partition` → `## Where the [G] answers land` →
`## Rubric (human-graded — the harness ships outputs, not grades)` → `## Results` (two per-case
tables) → `## Findings` → `## Notes` — the rubric human-graded, stated as such: no LLM judge, no
automated grade. Input partition = the 12 FOC-474 cases: FOC-406, 416, 417, 441, 443, 448, 449,
451, 452, 473, 397, 396. Per case, four measurements (Decision 2026-09-24):

- **coverage** — the significant ambiguities and boundaries THAT ARISE FROM THE INPUT (derived from
  that case's input at grading time): does the map surface each as an `inferred`/`unknown` item?
  Exact details hidden in the reference DoD are NOT required — an item asserting one as `stated`
  counts as invented, not covered. The semantic quality of each item's `covers` linkage is judged
  here too (code checks only the formal linkage);
- **pointless items** ("zbędne pytania") — no decision value at gate1, INCLUDING items whose content
  is repo-derivable or a known convention (those are never questions to Mateusz) — ids + count;
- **invented requirements** ("wymyślone wymagania") — requirements or facts asserted but not
  grounded in the input (a GT-hidden detail claimed as `stated` above all) — ids + count;
- verdict `pass | partial | fail` + one-line reason, mirroring the sibling rubric — a FAIL is a
  measurement, not an error.

No prompt tuning to benchmark answers: the eval measures; the prompt is never fitted to the 12
cases. Per-case coverage targets are classified three ways against `docs/benchmark/
plan-dod-eval.md`'s "Input partition" section and Findings (what the inputs carried vs what was
GT-only): (i) input-arising → coverage target; (ii) hidden in the reference GT / not derivable from
the input → NOT required (asserting it = invented); (iii) output-side artefact of the sibling's DoD
generation (the wrong-id halves) → N/A, behavioural notes only. Where the sibling does not settle
(i) vs (ii), the row is marked "verify at grading time":

| case | known miss | classification |
|---|---|---|
| FOC-416 | "diff limited to scripts/mcp/**" boundary / commit item naming FOC-401 | verify at grading time / (iii) N/A — output-side artefact |
| FOC-417 | `npm ci` prep + exact commit-message form / wrong id | verify at grading time / (iii) N/A |
| FOC-473 | "accepted by Mateusz" + "comment on the epic" | (ii) NOT required — both GT-only; asserting either as `stated` is invented |
| FOC-448 | test-count guard + J2 decision-log item + sub-epic comment | (ii) GT-only template item / verify at grading time / (ii) convention |
| FOC-449 | guard not derivable / wrong id (FOC-386) | (ii) NOT required / (iii) N/A |
| FOC-397 | guard not derivable / wrong id (FOC-380) | (ii) NOT required / (iii) N/A |
| FOC-451 | guard + STATE.md + sub-epic comment | (ii) / (ii) repo convention / (ii) convention |
| FOC-452 | the scope inversion ("candidates … via Linear search") | (i) TARGET — the input states Linear search is out of scope |
| FOC-396 | the merge action + epic-comment link | verify at grading time / (ii) convention |

FOC-441/443 are clean (nothing to cover); FOC-406 has no ground truth. Results carry two per-case
tables — the mechanical record first:

| id | items | stated/inferred/unknown | latency | in/out tok | cost USD | retries | errors |
|---|---|---|---|---|---|---|---|

(latency = measured call duration; cost provider-metered via `usage`, joined per issue — no second
meter, no estimate.) Then the rubric table:

| id | input-arising target | covered by (IN- id) | pointless items | invented items | verdict |
|---|---|---|---|---|---|

Aggregated over the 12 cases with FOC-406's coverage recorded UNKNOWN and excluded from the
completeness aggregate (never score a fake pass); the sibling plan.dod eval's aggregate is 2 pass
/ 9 partial / 0 fail over the 11 cases with ground truth (3/9/0 including FOC-406's pass).

**What §3.12 does not decide.** **Which interpretations become questions is FOC-516**
(`plan.intent.select` [J] scoring + [D] selection policy — by significance and uncertainty);
plan.intent only writes the interpretation map, and a `risk` item obliges no question. **FOC-517's
existing scope is likewise outside this section:** the gate1 fields (implementing the answer
contract above), `plan.intent.confirmed` (the confirmed-intent record), plan.dod/plan.ac reading the
confirmed intent, the real answer/resume test, the conversation mechanics and the `≤3 rounds`
limit. **Answer-contract tests required of FOC-517 (Mateusz, 2026-09-24):** (1) a full 12-slot map
plus a user correction — the next round proceeds and the cap binds only the active map; (2) an
answer referencing an older `mapVersion` — detected STALE, recorded in the `run-record` log, never
applied; (3) a content change that does NOT inherit the superseded item's confirmation
(renumbering never carries a confirmation). Also not decided here: question phrasing; the §6.4
re-entry edge representation (FOC-517 follow-up — the one flag this section still carries); spec
content; the perspectives config file's location.

## 4. One [G] step end-to-end: plan.ac (AC generation)

- **One API call, no tool loop.** The step receives its declared inputs, makes exactly one model
  call, returns a typed structure. No repo access, no file reads; retry policy belongs to the
  runner, not the step.
- **Declared minimal inputs** ("context size is a design output"): `inbox.entry` (the dictated
  issue text) and `features.list` (extraction output already in the run record). Nothing else — no
  repo tree, no telemetry, no prior runs, no Linear comments; relevance drops with every
  irrelevant input (MAP §1: "krótki, przefiltrowany stan"). `plan.dod`'s input is the smaller half
  of the same partition — `inbox.entry` only (§3.2, FOC-474); neither call silently receives a
  sibling call's inputs.
- **One question per field / zero arithmetic in the model:** the model neither counts nor computes —
  `acs` items are bounded declarative statements; sizes, counts and estimates belong to
  `plan.decompose` [J] plus [D] mapping, not here (plan.dod owns the matching rule for its
  `definitionOfDone` checks, §3.2).
- **Concrete schema with explicit bounds** (§3.11, `plan.ac.output`): `acs` 1–12 items (`id`
  pattern-locked `AC-n`, `text` ≤ 300 chars, `kind` enum). The size bound is what makes the output
  [G]-shaped — validated on write AND bounded (D7). Shape source is the catalog's
  `acceptance-criteria` entry (CAT). **The split:** the original draft merged ACs and DoD into one
  call because they consumed the same declared inputs and the merged structure stayed bounded; this
  revision splits it — `plan.dod` (FOC-474) and `plan.ac` (FOC-475) each make exactly one generator
  call on their own declared inputs, and each bounded shape maps one-to-one onto its catalog entry
  (`definition-of-done` there, `acceptance-criteria` here). DoD generation lives in plan.dod
  (§3.2, FOC-474).
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

## 5. decide: edges — binding the six non-deterministic transitions

**None of the six registry ids exists in the catalog today** (verified against CAT: zero matches —
the built entries are `extraction` and `prompt-refinement`, plus catalog-only entries). v2
therefore **proposes registering the six ids as new registry entries**; the catalog is intended to
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
| `decide-plan-ready` | `plan.readiness` | — (new; FOC-476) | none — new [J] step (§3.5) | plan.ready answers `ready=false` | first no → the stepFlow retry edge returns to `failedStep` with `reason`; second no from the same step → escalate | A0 → A1 |

The sixth edge is different in kind: the other table rows are top-level edges in `decisionEdges`;
`decide-plan-ready` is the FIRST STEP-LEVEL decide edge — it lives in the plan node's `stepFlow`
(§3.11), and its runtime return target is dynamic (the answer's `failedStep`; the edge enumerates
the possible targets). The registry entry owns autonomy, threshold, fallback and metrics exactly
as for a top-level edge.

- **Deterministic transitions stay [D].** The label/state matcher transitions (e.g. Todo + dor-ok →
  dev handoff) remain [D] evaluation by `graph-route.mjs`; GAPS §3.2's "deterministic in content"
  list (DoR met → DEV; verdict pass → TEST; repeated fingerprint → escalate; TEST done + clean tree
  → cleanup) stays code — the transition is [D] given the typed record; only the JUDGMENT feeding
  it is [J]. decide-edges replace the frontman's judgment calls, not the matcher.
- **The child_state discrepancy — flagged, not resolved.** MAP §4 point 3 scopes decide-edges to
  #1/#2/#14/#16 and hooks #17/#18 via PostToolUse/Stop instead; the kickoff requires child_state as
  a decide-edge at minimum. v2 binds all six — five top-level, one step-level (kickoff compliance) —
  and the schema supports both wirings (a decide-edge may carry `when.hook`; a registry entry can
  also serve a hook-only
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
versioned key in place, additive — the schema-versioning precedent FOC-397 builds on; (b) ~~the
7-step PLAN split of §3 (plan.dor [J], plan.ac [G], plan.spec [A] with discovery folded in,
plan.gate1 [H], plan.decompose [J], plan.gate2 [H], plan.push [D])~~ — **superseded 2026-09-22 by
the FOC-396 revision** (the 9-step split: plan.dod/plan.ac separated, plan.ready added — see the
revision note at §3).

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

`stepFlow` (sequence edges, the gate1 → plan.intent `reentry` — §6.4 — and plan.ready's step-level
decide edge) and `steps` live on the
**squad node**, which keeps its full v1 contract — the D7 list binds step objects, not squad nodes
(that is the Option-A migration compromise, stated in §3.11's `_doc`).

plan.ready's retry-then-escalate (§3.5, FOC-476) does not contradict the `failure` field: the
first `ready: false` is a flow event — the step-level decide edge in `stepFlow` (§6.4) — while
`failure` still declares the terminal behaviour (a second no from the same step escalates, as does
a failed call). Retry counts remain runner/registry policy (FOC-397, FOC-476), not node schema.

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
| `sequence` | node-local `stepFlow` | new | ordered step-to-step connectors inside a node; never matcher edges; step-level edges are sequence-only EXCEPT the two named exceptions below; step-level rendering (a PLAN pipeline diagram) is a new render target for FOC-397 |
| `reentry` | node-local `stepFlow` (one instance: plan.gate1 → plan.intent, §3.6) | new (FOC-517) | the loop-capped conversation edge: a gate round answered without confirmation re-enters the step that feeds the gate, with the round's answers/corrections folded; a fixed `why`-carrying target (never an enumerated array), bounded by the gate's own round cap (3) — a third kind of step-level edge beside `sequence` and the step-level `decide` |
| `decide` | top-level `decisionEdges`; one step-level instance in node-local `stepFlow` (plan.ready, §5) | new | never matched by graph-route (it reads `edges` only); `emitHandoffRules` filters `routable` from `edges` only — inert by construction; `from`/`to` name the scope where the decision applies, not a routable target; the registry entry owns autonomy, threshold, fallback and metrics. The step-level instance (plan.ready) may enumerate candidate return targets in `to`; the registry answer picks the runtime target (`failedStep`) |

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
2. FOC-448 lands the decision registry (entries for the six ids + the DoR/size/relation family) —
   decide-edges have nothing to call without it (MAP §7: FOC-448 blocks FOC-397).
3. FOC-397 implements the runner: version + step-schema validation in `graph-validate.mjs`,
   `steps`/`stepFlow`/`decisionEdges` execution (including the step-level decide edge, §5), [D]
   steps as code, [J]/[G] calls through `decision-call.mjs` by id, per-step typed records appended
   to the run event log (GAPS §3.4), escalation per D2. Any routable-edge change regenerates
   handoff-rules.json + PUML in the same change. Config catch-up of the superseded PLAN slice runs
   through FOC-474 (plan.dod), FOC-475 (plan.ac) and FOC-476 (plan.ready + the retry-then-escalate
   edge) — §3's revision note.
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

**Revision delta (FOC-396, 2026-09-22):** the §3 split adds per plan run one more runner-side [G]
call (plan.dod) and one more runner-side [J] call (plan.ready), plus the conditional re-run of the
step plan.ready names (§3.5) — a [G] target (plan.dod/plan.ac) re-runs cheap-tier, the plan.spec
target re-runs as an [A] agent-tier child; all are runner-side, on the happy path's zero-frontman
side, so none of them touches a frontman turn class. Within PLAN's ~1.7% envelope
of corrected volume the extra calls are noise at corpus scale; the frontman-share arithmetic above
(frontman share 43.5%, bands ~17–30 pp, residuals ~26% / ~13–21%) stands unchanged to the
rounding level this section's own units support, and no band shifts. Should plan.ready's
second-failure escalations become routine, they ADD frontman turns (the escalation rung, §3.10) —
a frequency the corpus does not measure; flagged, not quantified.

**Revision delta (FOC-517, 2026-10-01):** gate1 moved ahead of any spec/DoD/AC spend (FOC-516) and
became the intent conversation (≤3 rounds, §3.6). Frontman turns per plan run: gate1 goes from one
relay turn to at most three (the confirmed round plus up to two unconfirmed ones), each carrying a
short dictated answer instead of a read-and-approve — and a round that fails parseability also
carries an A0 `plan.intent.reply` annotation, which costs the [J] seam a cheap call, not the
frontman a turn. The compensating saving is the one the AC sits on: a misreading no longer
generates a wasted [A] plan.spec child + decompose + render before anyone notices — the misread is
caught at gate1 for the price of one cheap [G] map regeneration. PLAN stays ~1.7% of corrected
corpus volume; the frontman-share arithmetic above (43.5%, bands ~17–30 pp, residuals ~26% /
~13–21%) stands unchanged to the rounding level this section's own units support. The ≤2 extra
relay turns per plan run are real but unmeasured at corpus scale — flagged, not quantified.

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

1. **Step branching:** v2's `stepFlow` is linear per node, with exactly TWO named exceptions: the
   step-level decide edge (plan.ready, §3.11, §5, FOC-476), which branches back to the step named
   in its answer, and the reentry edge (plan.gate1 → plan.intent, §3.6, FOC-517), which loops to a
   FIXED target under a hard round cap. General conditional step-branching beyond these two edges
   is deferred (no measured need; the decide-edges cover the judgment points). If FOC-397 needs
   more branches, the schema grows in v2.1 — not by overloading `sequence`.
2. **plan.ready retry semantics (FOC-476):** the decide edge returns to `failedStep`, but the
   open items are which inputs re-feed that step (does plan.spec re-run on the same `plan.*`
   records, or on fresh ones?), who owns the retry counter (the runner's step-state machine vs
   the registry entry) and whether a retried step's new record supersedes or appends in the run
   event log (GAPS §3.4).
3. **Run-record schema ownership:** v2 declares `reads` paths against a namespace convention (§3
   preamble); the concrete record schema is FOC-397's.
4. **child_state wiring:** decide-edge with `when.hook` vs hook-only registry call (§5 discrepancy).
5. **Step-level diagram:** a PLAN pipeline render target (new emitter or a PUML section), so the
   step chain is drawable like the squad graph is today.
