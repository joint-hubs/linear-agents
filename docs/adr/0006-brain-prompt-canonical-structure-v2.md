# ADR-0006: Canonical structure v2 for squad brain prompts (semantic/topological pass — FOC-72 Wave E)

**Status:** Proposed

**Date:** 2026-08-09

## Context

FOC-72 "[FENIX] prompt optimization" has so far delivered **Waves A–D**: a *mechanical* pass
(Z1–Z7: XML tags, EN/PL split, dedup, few-shot examples, `doubt_defaults`, `precedence_policy`)
across the six "brain" files — `agents/{orchestrator,plan,dev,review,test,cadence}/CLAUDE.md` —
plus all subagent prompts and the docs mirrors (`docs/agents/agent-*.md`, `docs/prd/prd-*.md`).

The mechanical pass fixed *form* (lean, tagged, deduplicated) but not *semantics/topology*:
**where** a rule sits in the file, **how much emphasis** it carries, and **whether the model
understands why** a rule exists. A prompt-engineering consultation (2026-08, answers recorded
verbatim in `docs/prd/foc-72-fala-e-migration-spec.md` §2) produced four findings that drive
this decision:

1. **Recency effect** — instructions near the end of a prompt (just before the model transitions
   to action generation) measurably improve compliance; `doubt_defaults` belongs *after* the loop
   logic, not before it.
2. **Lost-in-the-middle is real even at ~170 lines (~1.5–2.5k tokens)** — structure always matters
   when a prompt mixes instructions, data, and examples. Critical rules should NOT be duplicated
   verbatim; instead use the **"Frame" strategy**: define the rule once in `<hard_rules>` near the
   top, and add a short technical reminder (1–3 lines) at the very bottom, immediately before the
   final trigger.
3. **Examples anchor best right before the action point** — after all rules, directly before the
   final trigger/reminder, not as a detached appendix.
4. Recommended section order: `<context>` (paths/PRD) → `<instructions>` (loop logic, identity) →
   `<doubt_defaults>` → `<examples>` → final trigger / critical reminder.

Mateusz (product owner) approved decisions R1–R5 on 2026-08-09; R3–R5 are consequences of the
same analysis and are marked **recommended** here. This revision also incorporates the
spec-review adversarial pass (2026-08-09): DoD executability, section-order consistency for
domain extras, guardrail classification for deploy mutation, catch-all primacy, and line-budget
realism. The final round (same day) records Mateusz's closing decisions: the orchestrator line
cap (≤68), the unified bounded-growth budget rule (no ≤baseline requirement), the TEST dry-run
scope expansion, and the reduced review Frame.

This ADR defines the canonical v2 structure; the per-file migration plan (full section-by-section
mapping, WHY candidates, emphasis audit, line ledger, behavioral smoke scenarios) lives in
`docs/prd/foc-72-fala-e-migration-spec.md`, which `decompose` will translate into one Linear
subtask per brain (+ one docs-sync task) under the FOC-72 epic.

## Decision

### D1 — Canonical section order (v2)

Every squad brain follows this order (the orchestrator brain adapts it, see migration spec §4.1):

| # | Section | Role |
|---|---------|------|
| 1 | Header + persona (1 line, incl. spec refs) | identity + `<context>` anchor |
| 2 | `<precedence_policy>` | **file fuse** — top-level, right after persona (R1) |
| 3 | `<xxx_linear_tools>` | context: environment/tooling constraints |
| 4 | `<xxx_squad>` | context: delegation roster |
| 5 | `<xxx_delegation_policy>` | cost instructions (+ R5 bullet) |
| 6 | `<xxx_tools>` | tool registry (compact pointer block, see D3) |
| 7 | `<xxx_loop>` | main instructions (WHY annotations on critical steps, R2) |
| 8 | `<xxx_hard_rules>` | guardrails (WHY annotations, R2; emphasis per R3; + R4 and the D9 catch-all line) |
| 9 | Domain extras (`<xxx_file_writes>`, `<xxx_types>`, `<xxx_dry_run>`, `<xxx_comment_helpers>`) | operational appendices |
| 10 | `<doubt_defaults>` | **moved after all instructions** (recency, expert finding 1) |
| 11 | `<examples>` | anchor immediately before the action phase (expert finding 3) |
| 12 | `<final_reminders>` | **new** — the "Frame": 1–3 short NEVER/ALWAYS lines (expert finding 2, D7) |

This maps 1:1 to the expert's recommendation: sections 1–6 = context, 7–9 = instructions,
10 = doubt_defaults, 11 = examples, 12 = final trigger/critical reminder.

**Domain-extras rule (fixed, no per-brain variants):** `<xxx_hard_rules>` ALWAYS precedes the
domain extras in every brain. Rationale: hard rules are guardrails (safety boundaries); extras
are operational detail. A model reading top-down must hit the guardrails before any appendix.
Consequence: today review and cadence have `file_writes` before `hard_rules`, and dev has
`types` before `hard_rules` — all three are reordered (migration spec §4.3/4.4/4.6). No brain may
keep an extras-before-hard_rules layout.

The migration spec's from→to tables cover **every** section of every brain (not only
`doubt_defaults`/`precedence_policy`), so reorders like the above cannot be silently skipped.

### D2 — R1 (approved): `<precedence_policy>` becomes a top-level file fuse

`precedence_policy` is the file's conflict-of-instructions arbiter ("this file wins; flag the
conflict to Mateusz"), not an operational detail of the loop. It moves **out of `<xxx_loop>` to
top level, immediately after the header/persona**, so the model reads it before anything else.
Brains without one today (review, test, cadence, orchestrator) get one created from the template
in the migration spec.

### D3 — R2 (approved): WHY annotations under the most important rules, with a realistic budget

Add a one-sentence **WHY** (format: trade-off / limit / cost) under the top 3–5 rules of
`<hard_rules>` and the critical steps of `<xxx_loop>`. Goal: the model generalizes rules to edge
cases that are not literally described. Candidates per brain are pre-selected in the migration
spec by real risk/cost (not arbitrarily), with draft wording.

**Length budget (revised for realism — supersedes the original R2 absolute target):**
The original R2 text targeted ~100 lines/file (tolerated ~115–120). Current baselines are
146–198 lines; shrinking to ≤120 would require content rewrites that are **out of Wave E scope**
(Wave E restructures and annotates; it does not re-author). The binding budget is ONE unified
rule for all brains — **bounded growth with a justified ledger** (Mateusz's final decision; the
earlier "must land ≤baseline" requirement is withdrawn):

1. Every brain ships a complete **line ledger** (`+lines` / `−lines` with named cuts); net growth
   ≤ **+15%** of baseline (hard cap +20%).
2. Brains > 150 lines must include compensatory cuts in the ledger (no pure-addition migration).
   Where legitimate cuts exist (plan/dev/review) the result lands at or below baseline; where
   legitimate cuts are scarce (test, cadence) bounded growth up to the cap is acceptable —
   landing ≤baseline is an *outcome* of available cuts, not a requirement.
3. Very small brains: percentage budgets are meaningless at tiny sizes, so the orchestrator
   (47 lines) uses an absolute cap instead — **≤68 lines** (Mateusz's decision: the new safety
   sections are the highest-value content; no artificial cuts).
4. Concrete cuts (migration spec §4): a uniform **compact `<xxx_tools>` pointer block** (the
   19-line registry boilerplate is identical in all five squad brains → ~6-line pointer to
   `docs/tools/README.md`, −13 each), plan's DRAFT-JSON schema deduplicated against
   `agents/plan/agents/decomposer.md` (schema confirmed present there), plan comment-helper bash
   fences collapsed, dev/review example bash deduplicated against loop commands.
5. Per-brain post-migration targets: plan ≤185 (from 198), dev ≤187 (195), review ≤191 (195),
   test ≤165 (from 146 — includes the new `TEST_DRY_RUN` section), cadence ≤191 (185),
   orchestrator ≤68 (47).

WHY lines replace emphasis as the carrier of rule weight (see D4).

### D4 — R3 (recommended): de-escalate emphasis to true safety guardrails

`MANDATORY` / CAPS / `**bold**` are reserved for **true safety guardrails**. The classification
checklist below is mandatory for every emphasis change in every subtask:

> "Does this rule prevent a **destructive, irreversible, security, compliance, human-control,
> or shared/deployed-environment-mutating** loss? **yes → keep CAPS/NEVER.**
> no → downgrade to plain text (add WHY if it is a top rule)."

The **"mutates shared/deployed environment"** category was added by spec-review: e.g. TEST's
auto-rollback mutates the deploy environment and blocks false-PASS→Done — it is a safety
guardrail, not style, and KEEPS its emphasis (migration spec §4.5). Environment requirements and
ordinary limits (e.g. "mcp tools don't work headless", "max 2 rounds", "run passes in parallel")
become plain text.

Each subtask DoD includes a diff-level review of all emphasis changes against this checklist, so
a true guardrail cannot be downgraded by accident.

### D5 — R4 (recommended): explicit "no-speculate-about-unread-files" rule

One hard rule in all six brains: *never describe or quote the content of a file you have not read
yourself or received as a subagent summary — report "unknown / not read" instead.* Orchestrator
leads work from subagent summaries; fabricating file content is the highest-cost hallucination
class in this system (it poisons downstream briefs, AC, and reviews).

### D6 — R5 (recommended): context-budget awareness in orchestrators

New bullet in the delegation policy of every orchestrator (all five squad leads + top-level
orchestrator): *when the turn approaches ~70% of the context window, write
`.state/<squad>-wip.json` (current step, state, next action) before continuing — cheap restart if
the session drops.* This is a **checkpoint, not async walk-away**: HITL gates remain synchronous
(the PLAN brain's "no walk-away between gates" rule is explicitly preserved; the migration spec
carries reconciliation wording).

### D7 — The "Frame": `<final_reminders>` (new last section)

Per expert finding 2, each brain gains a 1–3 line reminder block after `<examples>`, echoing the
single most dangerous rule(s) in short technical form (e.g. "Reminder: NEVER push to Linear
without GATE 2 ✅."). Constraints:

- A reminder **echoes a rule that already exists in full form in `<hard_rules>`** (or loop +
  hard_rules). The Frame is never the sole statement of a rule — it is a recency anchor for an
  already-defined guardrail. Rules whose full form lives only in a domain extra (e.g. review's
  no-product-code-modification rule in `<review_file_writes>`) are NOT echoed in the Frame
  (Mateusz's final decision, migration spec §4.4.1).
- Never a verbatim copy; max 3 lines; phrased as `Reminder: NEVER …` / `Reminder: ALWAYS …`.

Draft texts per brain are in the migration spec.

### D8 — Content principles (from the expert consultation; guide wording work)

1. **Chain-of-thought on demand.** For steps that require reasoning (review merge of 3 passes,
   PLAN gate verdicts, decompose estimation), the wording explicitly says "think through X before
   answering/writing", not just the final-output instruction. Applied where the *lead* reasons;
   subagent prompts that estimate/compute get it in their own files (follow-up, out of Wave E).
2. **Neutral HITL phrasing.** Questions to Mateusz (GATE 1 / GATE 2, destructive-op approvals)
   must not suggest the answer ("what are the pros and cons / risks?", never "isn't this a great
   plan?") — anti-sycophancy.
3. **Instructions do not add skills.** If a step needs counting/estimation, give it a
   tool/script output, not an instruction to "compute correctly". (Already largely satisfied:
   cadence consumes `flow-db.mjs patterns` JSON; recorded as a principle for future edits.)

### D9 — Catch-all promotion: "destructive/irreversible → ask Mateusz" in hard_rules of every brain

Today the catch-all lives **only** in `<doubt_defaults>` (plan: push to Linear/delete; dev:
push/force/delete; review: push/force/fetch/labels-status outside verdict path; test:
rollback/prod touch; cadence: scope/status/labels/re-priorities). The recency move of
`doubt_defaults` to position 10 would leave this rule without a primacy-position statement.
Therefore **every brain gains one hard_rules line**:

> "Unlisted destructive/irreversible action → ask Mateusz first (default when unsure)."

(TEST variant notes the pre-authorized unhealthy-deploy auto-rollback exception.)
`doubt_defaults` at position 10 keeps the elaborated per-domain examples — the rule then exists
at both primacy (hard_rules) and recency (doubt_defaults) positions. The migration spec audits,
per brain, which `doubt_defaults` items are safety-adjacent and where they are echoed in
hard_rules (spec §4, "doubt_defaults safety audit").

## Alternatives Considered

1. **Stop at Waves A–D (mechanical pass only).** Rejected: fixes form, not semantics. The expert
   findings show lost-in-the-middle already applies at current file sizes (146–198 lines); rule
   placement and emphasis discipline are the remaining levers.
2. **Verbatim duplication of critical rules at the bottom.** Rejected (expert finding 2): bloats
   the file against the D3 budget and dilutes the original; the short "Frame" reminder gets the
   recency benefit at ~3 lines.
3. **Keep `precedence_policy` nested inside `<xxx_loop>`.** Rejected: the fuse is a file-level
   arbiter; burying it in loop detail means the model may hit conflicting instructions (spec refs
   are declared in line 1 "read them before answering") before ever reading the arbiter.
4. **Keep emphasis everywhere.** Rejected: when everything is MANDATORY, nothing is. Reserving
   CAPS/NEVER for true safety guardrails restores their signal value; WHY annotations carry the
   weight of important-but-not-safety rules.
5. **Examples as a detached appendix after all other content.** Rejected: examples anchor best
   immediately before the action point; the new `<final_reminders>` must be the last section, so
   examples move from "file end" to "just before the reminders" (a relative, not absolute, move).
6. **One big rewrite commit for all six brains.** Rejected: per-brain subtasks (one Linear child
   each) keep risk isolated, allow parallel execution, and give each brain its own re-review and
   dry-run pilot.
7. **Per-brain variant ordering of domain extras (e.g. keep review/cadence `file_writes` before
   `hard_rules`).** Rejected: a single fixed rule (hard_rules before extras, D1) is cheaper to
   lint, review, and teach to future squads than case-by-case justification; guardrails outrank
   operational appendices in every brain.
8. **Keep the original R2 absolute budget (≤115–120 lines/file).** Rejected as infeasible at
   146–198-line baselines without content rewrites (out of Wave E scope); replaced by the
   unified bounded-growth + line-ledger budget of D3. Revisit absolute shrink as a separate
   future wave.
9. **Force the orchestrator into the +12-line cap with artificial cuts.** Rejected (Mateusz's
   decision): at 47 lines the new safety sections (precedence fuse, doubt_defaults, catch-all,
   reminders) ARE the highest-value content; cutting them to hit a percentage target would
   defeat the wave's purpose. Absolute cap raised to ≤68 instead.

## Consequences

- **Positive:**
  - Better rule generalization to unlisted edge cases (WHY annotations).
  - Higher compliance on the most dangerous rules (recency of `doubt_defaults` + final Frame;
    catch-all now at both primacy and recency positions, D9).
  - The conflict fuse is visible before any other instruction (R1).
  - Emphasis becomes a meaningful signal again; future guardrails get reserved styling.
  - Uniform v2 topology across all brains → cheaper future edits, one template for new squads.
  - Side benefit of the TEST scope expansion: TEST gains the same dry-run safety net the other
    four squads have had since F0/F1–F3 (launcher + fixture + mode section).
- **Negative:**
  - All six brains need re-review and behavioral smoke verification after migration (per-brain
    scenarios in migration spec §4). Entry-point reality: `plan/dev/review/cadence` have
    `*-dry.bat`; **TEST has no dry-run at all today** (no launcher, no `TEST_DRY_RUN` section,
    no fixture) — subtask s5 delivers it in full (spec §4.5.7); **orchestrator has no dry-run**
    and uses structural + transcript checks.
  - **The TEST subtask (s5) is larger in scope than the other five** (estimate L vs S/M): besides
    the v2 rewrite it delivers new functionality — `TEST_DRY_RUN` section, healthy/unhealthy
    fixtures, and `bin\test-dry.bat` wiring — per Mateusz's decision expanding Wave E scope so
    the unhealthy-deploy smoke scenario is reproducible in dry-run.
  - Docs mirrors (`docs/agents/agent-*.md`, `docs/prd/prd-*.md`) drift until the docs-sync
    subtask lands.
  - Plan/dev/review must execute the listed cuts — a migration that adds WHY without cutting the
    listed overlaps violates the budget and fails DoD.
- **Risks:**
  - *Regression in existing safeguards if R3 downgrades a true guardrail by accident.* Mitigation:
    the D4 checklist (incl. the mutates-environment category) is mandatory per emphasis change;
    each subtask DoD includes an emphasis-diff review; per-brain smoke scenarios verify no
    `git push` / `mcp__linear` / unauthorized-write / unconsented-mutation attempts.
  - *Frame duplication bloat or orphan rules.* Mitigation: D7 — max 3 lines, never verbatim, and
    every reminder must trace to a full-form hard_rules statement (checked in spec review).
  - *Catch-all loses primacy after the recency move.* Mitigation: D9 hard_rules line in every
    brain + per-brain safety-adjacency audit in the migration spec.
  - *R5 checkpoint confused with async walk-away (PLAN).* Mitigation: reconciliation wording in
    the migration spec keeps "HITL gates are synchronous" intact.
  - *Lint breakage.* `scripts/check.mjs` validates Linear-label tokens inside brain files — the
    migration must keep all label references valid; DoD includes `node scripts/check.mjs` green.
    The new `bin\test-dry.bat` is auto-covered by the existing glob lint (every `bin/*-dry.bat`
    must set `*_DRY_RUN=1`) — no check.mjs change needed.
