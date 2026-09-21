# ADR-0012: Decision-shaped steps and the four step kinds — step taxonomy, decision tier, MCP-hosted [J] pattern

**Status:** Accepted (2026-09-19)

**Date:** 2026-09-19 (co-designed with Mateusz via two HITL gate rounds; accepted on his review the same day)

**Amendment 2026-09-21 (FOC-473) — fifth kind [G], one node contract, tier-2 honesty.** Corrections from the 2026-09-21 review, recorded in place below with `**Amended 2026-09-21 (FOC-473):**` markers: the taxonomy gains a fifth kind, **[G] generate-shaped** (D1), for one-call generation of small typed structures; the [J] bullet's "hallucination … 'mathematically impossible'" claim (JEV §1) is corrected — a schema-validated typed output guarantees shape, not truth; a single node contract (D7) now binds every kind; and tier 2 of the decision cascade is **disabled** (`FALLBACK_MODEL = null` in `scripts/decision-call.mjs`) until a non-thinking model is measured — its "non-thinking" premise was never measured and is contradicted by this ADR's own probe record (D3.3).

## Context

The supervisor frontman (ADR-0009) runs all routine work — and pays for it. Measured on the deduplicated corpus (`docs/plans/fenix-architecture-gaps-2026-09-19.md` §2.1, below: **GAPS**): the frontman consumed $1,339 of $3,081 (43.5%), 2.5× all children combined; after the measurement corrections (GAPS §2.9 — amounts ~2.19× too high, per-squad shares not proportional) the corrected shares are supervisor 39.7%, dev 38.1%, review 11.4%, test 9.1%, plan 1.7%. Meanwhile a decisions model is cheap: Jev served 3 gate questions in 286–487 ms at ~$0.000023/call — "~0.3–0.5 s and ~$0.02 per 1,000 decisions" (GAPS §2.3), the "System One" economy.

Two further pressures shape this ADR:

- Steps that are deterministic in content are today executed by an LLM anyway (GAPS §3.2), and steps that need one bounded judgment are executed by full agents — both burn frontier-tier cost on work a typed, cheap tier could do.
- The Supervisor's context is a scarce resource: routine reasoning must not happen inside it. Work should run in processes whose only return to the caller is a final typed JSON (Mateusz, 2026-09-19: a model that "may think, but at the end must produce the concrete JSON … it is inside MCP so we do not pollute the Supervisor's context").

This ADR records: the five step kinds, the decision-model tier (cascade), the verified constraints from the measured probes, Path A/B, the MCP-hosted pattern for decision-shaped steps, and the one node contract for all kinds (D7). It deliberately does NOT spec the graph.json v2 step schema (FOC-396), the graph runner (FOC-397), or the gate auto-answer policy (ADR-0013 / FOC-384). **Amended 2026-09-21 (FOC-473):** "four" at acceptance — [G] generate-shaped is the fifth kind (D1).

Evidence shorthands used throughout: **GAPS** = `docs/plans/fenix-architecture-gaps-2026-09-19.md` (the audited correction; authoritative where it disagrees), **JEV** = `docs/plans/jev-mechanics-fenix-analysis-2026-09-19.md`, **VISION** = `docs/plans/mcp-pipeline-vision-analysis-2026-09-19.md`.

## Decision

### D1 — Five step kinds, with examples and classification rules

**Amended 2026-09-21 (FOC-473):** "Four" at acceptance; [G] generate-shaped below is the fifth kind.

Every step in a graph is exactly one of:

- **[D] deterministic** — the output is fully determined by the inputs; no model call.
  Example: filling a template from a schedule snapshot; the graph transitions that are "deterministic co do treści, a mimo to wykonuje je LLM" (GAPS §3.2); merge-authority, which is "logika 3 linii (deep > security > first-pass), nie comprehension" — "Nie budować merge-authority jako LLM (to 3 linie JS)" (VISION §4.2, §10.4).
  Classification rule: if the step can be written as a pure function/script with no judgment, it is [D] — and per this ADR it must be.
- **[J] decision-shaped** — unstructured state in, typed probabilistic decision out (JEV §1); the deterministic part of the work (regex/keyword/parser extraction) stays code, and the model only verifies/scores/classifies/routes (JEV §3.1). The model may think, but must END with a schema-validated typed JSON; the schema guarantees the output's SHAPE, not its truth — a well-formed answer can still be wrong, and correctness comes from the gates ([J]/[D]/[H]) and from calibration (FOC-387), never from the type system. **Amended 2026-09-21 (FOC-473):** this bullet previously quoted JEV §1's "hallucination … 'mathematically impossible'" reading; that is refuted — typing the output space constrains the form, it does not make the content true. JEV §1 is not edited; this ADR is the correction of record.
  Examples: findings/verdict severity; "AC mapped?"; "same error class as round N−1?"; "is this command irreversible?" (GAPS §4, §5); task-size classification (small/medium/large — feeds the ADR-0009 amendment); feature-relation and feature-size classification (Mateusz, 2026-09-19).
  Classification rule: a single bounded judgment with a typed, validated answer — not a tool loop, not open-ended generation. **Amended 2026-09-21 (FOC-473):** generating a small structure (a Definition of Done, acceptance criteria) is not a judgment — that is [G] below; generation stays out of [J].
- **[G] generate-shaped** — one model call, no tool loop, that produces a small typed structure: the output is JSON-schema-validated and bounded in size, the inputs are limited to the node's declared fields only, and the model tier is cheap by default (D7). **Amended 2026-09-21 (FOC-473):** new fifth kind from the 2026-09-21 review — the model never writes free prose here: templates, [G] nodes ("jedno wywołanie API z minimalnym kontekstem i schematem JSON") and [A] steps are what produce text (`docs/plans/jev-placement-map-2026-09-21.md`).
  Examples: PLAN's Definition of Done and acceptance criteria; the small typed structures of the MCP family catalog (FOC-401) that are generated rather than judged.
  Classification rule: the step GENERATES a small bounded structure instead of judging one — one call, no tool loop; and a [G] node never decides a gate — gates are [J], [D] or [H].
- **[A] agentic** — a full agent loop (Claude Code in its own worktree); the only place for long context accumulation and `--resume` (GAPS §4).
  Example: the DEV implementer phase (edit → build → test → commit).
  Classification rule: the step requires interactive tool use with side effects and context accumulation across many turns.
- **[H] HITL gate** — a human decides or approves; the existing gate contract is unchanged (GAPS §4: "Czego **nie** ruszać: kontraktu gate'ów").
  Examples: plan gates, push approval, question gates.
  Classification rule: the decision's owner is a human, whatever the content.

**Labeling (ruled 2026-09-19, gate round 2, Q3a):** labels are explicit per-step at graph authoring time; a [J] classifier may only PROPOSE a label — Mateusz approves. Node promotion follows the existing `_autonomy` policy: manual edit by Mateusz, on evidence (GAPS §3.5).

**Optimization coupling:** GEPA/DSPy-style prompt optimization applies to [J] steps only (GAPS §3.10); the tooling itself is FOC-398.

### D2 — The decision tier (cascade), two-phase

A [J] step's model is chosen by the cascade, cheapest first:

1. **Tier 1 — Jev** via the OpenRouter Decisions API. Served ONLY via `POST /api/alpha/decisions` (chat/completions returns 400); pin `typesafe/jev-1.13`, never a `~latest` alias. Native probabilities and confidence in the response; ~0.3–0.5 s, ~$0.02 per 1,000 decisions (GAPS §2.3).
2. **Tier 2 — a non-thinking model with logprobs + structured output.** Phase 1 (Path A): OpenRouter open models (e.g. qwen3-30b-a3b-instruct, non-thinking). Phase 2 (Path B): a **local Ollama** model. Tier 2 must stay non-thinking: logprobs are meaningful only on clean tokens. **Amended 2026-09-21 (FOC-473): tier 2 is DISABLED** (`FALLBACK_MODEL = null` in `scripts/decision-call.mjs`): this ADR's own probe (D3.3) measured z-ai/glm-5.3-flash as reasoning-mandatory — its reasoning cannot be turned off, ~910 reasoning tokens / ~11 s per yes/no — and no candidate holding a `config/models.json` pricing row is documented non-thinking (no such attribute exists on any row), while the example above, qwen3-30b-a3b-instruct, has no pricing row at all (config invariant: every used model needs one). Claiming "non-thinking" without measurement would repeat the dishonesty this amendment corrects. A tier-1 failure therefore fails closed straight to the relay/HITL path — the cascade runs with one fewer live tier. **Re-enable conditions:** a model MEASURED non-thinking, WITH a pricing row in `config/models.json`, and ADR quote and code agreeing (test-enforced — `scripts/decision-call.test.mjs` fails on divergence; see Open items).
3. **Tier 3 — Claude**, where typed output without confidence is enough (Claude exposes no logprobs — verified, see D3).

**Escalation tier:** frontier models sit at the top of the cascade, **below the human** (GAPS §3.6/§4: "niska pewność / błąd ──▶ wyższy szczebel ──▶ frontman ──▶ Ty").

**Two-phase confidence (ruled, round 2):** Phase 1 runs on the OpenRouter API with Jev; Phase 2 moves the logprobs source to a local Ollama. Path B entry is gated on a **measured Ollama logprobs probe** (ruled Q8a) — GAPS probed OpenRouter endpoints only, and Ollama's API has historically not exposed logprobs (llama.cpp server does); the probe, not the assumption, admits Path B.

**Escalation policy (ruled, Q4a):** this ADR fixes the escalation DIRECTION only — lower confidence or an error moves the call one rung up, ending at the human. Threshold VALUES are deferred until measured calibration (ECE/Brier on labeled [J] outputs). The 0.95/0.5/0.7 numbers floated in JEV §6.3 have no measured basis today (GAPS §2.3: `answerable_from_docs` measured 0.61–0.73 — three gate questions on one model, Jev, n=3; GAPS itself calls the sample an anecdote — at a 0.95 threshold nothing would ever auto-fire).

**Confidence source (FIXED; wording per review round 1):** confidence comes only from **measured sources** — tier-1 native Decisions-API probabilities or tier-2 logprobs; otherwise it is `null` — never estimated, never fabricated. (The original logprobs-only wording would have nulled every tier-1 answer, whose probabilities are native to the Decisions API rather than logprobs; the kept invariant is *measured — never estimated, never fabricated*.) **Amended 2026-09-21 (FOC-473):** tier-2 logprobs measure **format confidence** — the probability that the output is well-formed, NOT the probability that the decision is right; the field is labelled `formatConfidence` (envelope + shadow log), `confidence` at tier 2 stays `null`, and `formatConfidence` is never used for autonomy until calibrated (FOC-387). Tier-1 native probabilities keep their existing meaning as decision confidence.

### D3 — Verified constraints (recorded from the measured probes)

All from GAPS §2.2–§2.3 unless noted:

1. Claude exposes no logprobs — neither the Anthropic API nor `anthropic/*` on OpenRouter.
2. Tool-call arguments carry no logprobs on OpenAI-compatible endpoints ("logprobs obejmują treść, nie argumenty narzędzia").
3. glm-5.3-flash cannot turn reasoning off — `reasoning:{enabled:false}` → 400 "Reasoning is mandatory".
4. Jev is served ONLY via `POST /api/alpha/decisions` (chat/completions returns 400: "is a decisions model … Use the /api/alpha/decisions endpoint").
5. Pin `typesafe/jev-1.13`, never a `~latest` alias — the alias has no endpoint today; the pinned version is kept in the decision record.
6. Confidence comes only from **measured sources** — tier-1 native Decisions-API probabilities or tier-2 logprobs; otherwise `null` — never estimated or fabricated. **Amended 2026-09-21 (FOC-473):** tier-2 logprobs now feed `formatConfidence` (format, not decision correctness — see D2); `confidence` at tier 2 is `null`.

**Refutation note:** `docs/plans/jev-mechanics-fenix-analysis-2026-09-19.md` §4 (Path A) claims "Anthropic zwraca `top_logprobs`" as a confidence source. That claim is **refuted by the measured probes** (GAPS §2.2 — constraint 1 above; constraint 2 for tool-call arguments). Path A survives only in the tier-3 role (typed output without confidence). The evidence doc is not edited; this ADR is the correction of record.

### D4 — Path A now / Path B later

- **Path A (now):** API models — Jev, non-thinking+logprobs open models, and Claude, via OpenRouter / first-party APIs.
- **Path B (later):** open-weights served on a local Ollama, with xgrammar constrained decoding (FOC-359 Stage A reusable; FOC-399 owns the serving). xgrammar is Python: it runs inside the serving/MCP process, never inside the Node supervisor. The reading of "z Pydantic można jakoś używać xgrammar": the Pydantic model emits a JSON Schema, xgrammar compiles it into the decode-time grammar.
- **Trigger (ruled, Q7c — event criterion):** Path B activates when the alpha `/api/alpha/decisions` endpoint disappears or changes shape (GAPS §2.3: "endpoint jest **alpha** — format i trasa mogą się zmienić"), plus the Ollama logprobs probe as the entry condition (Q8a).

### D5 — Decision steps live inside graph nodes; the MCP-hosted [J] pattern

- There is **no `decision` node kind and no `decision` gate kind**. A decision-shaped step is a step inside a graph node (GAPS §3.3/§3.4 typed step record).
- The gate contract stays HITL-only; whether a gate may ever be auto-answered is ADR-0013 / FOC-384 territory — referenced, not specified here.
- One new gate kind IS approved (see D1 [H]): **`draft-approval`** — an [H] gate that submits a full artifact (e.g. an ADR draft, a squad-prompt draft) for human approve/reject, as opposed to `question`, which asks an open question. Approved 2026-09-19 (round 2, Q6c). Implementation lives in `supervisor-gate.mjs` (`KINDS` today: `plan.gate1`, `plan.gate2`, `question`, `push-approval`, `pr-approval`, `cleanup-approval`) — proposed as a small follow-up child, not this task.
- **MCP-hosted [J] pattern (ruled, round 2):** a decision-shaped step runs inside an MCP server; the model may think but must end with a schema-validated typed JSON; the caller (Supervisor or squad) receives only that final JSON — the Supervisor's context is never polluted by intermediate reasoning.
- **Validators per runtime (ruled, Q9a):** the requirement is a schema-validated typed JSON, not one library: **Pydantic** in Python MCP processes, **zod/ajv** in Node.

### D6 — Canonical first [J] family and the sizing scenarios it feeds

First [J] candidates (GAPS §2.8 deprioritizes the gate pre-screener; §5 lists the labeled data): findings/verdict severity (943 labels), AC mapping (155 labels), repeat-class ("same error class as round N−1?"), "is this command irreversible?" — plus the **task-size classifier** (this ADR): small & easy → Supervisor alone, no squads; medium/complicated → DEV + TEST squads; large & very complex → the full triage PLAN → DEV → REVIEW → TEST. In every scenario the Supervisor manages the Linear issue (comments, labels, status transitions) and the state files. The routing policy consuming the classifier is supervisor-runtime behavior and is recorded as an **amendment to ADR-0009** (ruled, Q10b), delivered with this ADR.

The wider MCP-hosted [J] family named by Mateusz — extraction/classification of the user's expected **features** into very short typed JSON; prompt refinement (also classifying how features relate and their size); repo-state recon (open: MCP server vs supervisor vs squad vs agent); definition-of-done; acceptance criteria; expected behaviors/features; risks; security requirements; security tests; QA; testing; out-of-scope — is ONE catalog+build child under FOC-380, filed as **FOC-401** (ruled, Q11a). ADR-0012 defines only the pattern (D5); the child owns the catalog and the build.

### D7 — One node contract for all kinds

**Amendment 2026-09-21 (FOC-473).** Every node of every kind carries exactly these fields, nothing more:

- **id** — unique within the graph.
- **kind** — exactly one of [D], [J], [A], [H], [G] (D1).
- **declared input fields** — an explicit subset of the run record; nothing outside it may be read.
- **output schema** — validated on write; a [G] node's output is additionally bounded in size.
- **model tier** — [D]/[H]: none; [J]: per the D2 cascade; [G]: cheap tier by default; [A]: the agent model.
- **failure behaviour** — typed and fail-closed: a failed node never invents output and never silently passes; only [J]/[D]/[H] decide gates ([G] never does).
- **output destination** — one named place per node: the run record, the envelope, or the graph state.

graph.json v2 (FOC-396) encodes exactly these fields — the node schema and this contract are the same list; a field outside it has no place in a node.

## Consequences

- **Positive:**
  - The frontman's 43.5% share has a defined escape route: [D] steps leave the LLM entirely, [J] steps drop to the cheap tiers, and only [A]/[H] keep the expensive shapes. **Amended 2026-09-21 (FOC-473):** [G] joins the cheap-tier set (D1).
  - The Supervisor's context stops absorbing routine reasoning — MCP-hosted steps return one typed JSON each.
  - Decisions carry measured confidence (tiers 1–2) instead of vibes; `null` is honest where no measurement exists. **Amended 2026-09-21 (FOC-473):** tier 2 is disabled (D2) — today only tier-1 decisions carry decision confidence, and `formatConfidence` is labelled separately (D2, confidence rule).
  - The explicit per-kind taxonomy unlocks per-kind tooling (GEPA on [J] only) and makes misclassification auditable.
- **Negative:**
  - Graph authoring requires explicit per-step labels and taxonomy discipline; the [J] classifier can propose but not decide.
  - The MCP [J] family is more processes to deploy, monitor and secure; more isolated models mean more provider-side failure modes (VISION §5.6: 22/38 bad turns were provider-side).
  - Thresholds are unusable as policy until the calibration task lands; until then tier-1 answers log but auto-fire nothing.
  - Ollama logprobs are an assumption until the probe runs.
- **Risks:**
  - The alpha Jev endpoint may change shape or disappear — mitigated by the pinned version, the decision-record requirement, and the Path B event trigger.
  - Tier 1 sends gate/step content to TypeSafe (a third party) — accepted at the current content sensitivity, named here so the trade-off stays visible.
  - A mislabeled step routes to the wrong tier (cost or quality); mitigation: explicit labels + [J]-proposes / human-approves.
  - Jev `answerable_from_docs` measured 0.61–0.73 (GAPS §2.3; n=3, one model — an anecdote) — until calibration, treat tier-1 answers as proposals, not verdicts.

## Alternatives Considered

1. **A `decision` node kind / `decision` gate kind** — rejected (FIXED, re-confirmed in co-design): decision steps live inside graph nodes; gates stay HITL.
2. **Adopting concrete thresholds now (0.95/0.5/0.7, JEV §6.3)** — rejected: no measured basis (GAPS §2.2); thresholds follow the ECE/Brier calibration.
3. **Calibrated probabilities from a tabular classifier (Platt/isotonic, JEV §4 Path C)** — deferred: too few labels today; revisit as calibration data accumulates. Not a substitute for the measured-sources-only rule (FIXED).
4. **Runtime heuristic classification of steps** — rejected (ruled Q3a): explicit author labels; a [J] classifier proposes only.
5. **Pydantic everywhere as the only validator standard** — rejected (ruled Q9a): the supervisor/squad runtime is Node; validator per runtime.
6. **`draft-approval` reusing the `question` kind** — rejected (ruled Q6c): carrying an artifact awaiting approve/reject is a different interaction from an open question; approved as its own kind.
7. **Sizing scenarios as a new child issue** — rejected (ruled Q10b): they amend ADR-0009, where the frontman runtime already lives.
8. **MCP [J] family as per-MCP issues or inside FOC-396/397** — rejected (ruled Q11a): one catalog+build child under FOC-380; this ADR defines only the pattern.

## Open items / deferred

- **FOC-396** — graph.json v2 step-level schema, including the per-[J] **minimum-tier pin field** (ruled Q5b: approved as a schema field; the concept is stated in D2, the field spec is deferred).
- **FOC-397** — the graph runner: escalation mechanics, per-step policy execution.
- **ADR-0013 / FOC-384** — gate auto-answer policy (referenced, not specified).
- **FOC-398** — DSPy/GEPA tooling on [J] steps.
- **FOC-399** — xgrammar / Path B serving, including the Ollama logprobs probe (the Path B entry condition).
- **Filed children** (by the Supervisor): the MCP [J] family catalog+build — **FOC-401**; the `draft-approval` kind implementation in `supervisor-gate.mjs` (small separate child, ruled Q4a).
- **Calibration task** — ECE/Brier on labeled [J] outputs before any threshold becomes policy.
- **Tier-2 re-enable (amendment 2026-09-21, FOC-473)** — find a model MEASURED non-thinking, give it a pricing row in `config/models.json`, restore `FALLBACK_MODEL` in `scripts/decision-call.mjs`, and update the ADR quote in the same change — the drift test fails while code and this ADR disagree.
