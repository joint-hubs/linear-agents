# Fenix after 1.0 — recon and a proposal for the next steps (2026-10-26)

Status: proposal for Mateusz's decision. Sources: `docs/ROADMAP.md` (stale since 2026-10-17), `docs/roadmap/taxonomy.json`,
`docs/HANDOFF.md`, the PRDs under `docs/prd/`, `docs/plans/`, `docs/decisions/`, the FOC-789 run log, Linear (team FOC),
the CodeGraph index and `docs/reviews/2026-10-26-code-quality-and-suite.md`. Goals as stated by Mateusz: better delivered
quality, better code, lower cost, easier to use, faster — and a Fenix that learns from its own runs without him editing it.

## 1. Where we are (facts, not plans)

- **1.0 gate.** rc.5 on the VM; FOC-988/990/1000 Done; FOC-1047/1048/1049 merged (#152) and waiting for rc.6; FOC-789 part 2
  (two task sessions, push from the dashboard) not run; S1–S30 not yet filed; FOC-790 dossier a skeleton. Target 2026-12-03.
- **Cost profile** (1.0 PRD §3, `cost-optimization.md`, `context-attribution-2026-08-26.md`): the Supervisor is **72 % of spend,
  ≈ $4.90 per ticket**; children p50 $0.36 / p80 $1.15. Inside a lead, ~85 % of cost is cache re-reads of its own context
  (11:1 cache-read to fresh input); the fixed context floor is 34.6 % of the bill; Bash output 11.7 %; harness-injected text
  14.2 % (not ours). Trimming prompts was measured to be the wrong lever.
- **Quality profile:** 68 % of tickets needed follow-up turns, 20 % more than one REVIEW child (1.0 PRD). The first-time-right
  metric exists on Costs & quality; no target is set. The two serious 1.0 findings were the Supervisor working around tooling
  (FOC-988, FOC-1001), now closed by deny rules + manifest.
- **Learning profile:** the data exists — `runs/<id>/decisions.jsonl` holds every registry-backed decision with its answer AND
  its observed label; delegation outcomes join verdicts to the delegations that produced the code; the reward ledger; cost per
  ticket; the FOC-789 snag list. **Nothing consumes it automatically.** Every consumer is a dashboard panel
  (`telemetry-server.mjs`, `cockpit-routes.mjs`, `work-routes.mjs`) and every design puts a human between measurement and
  change (rewards spec: "no XP-driven unlock"; agent-intelligence: "no automatic prompt editing"; model-experiments:
  "promotion of the winner is a human decision"). Routing lives in `config/models.json` + the settings overlay, prompts in
  `agents/*`, the pipeline in `config/graph.json`; no process writes to them from evidence.
- **Speed/ease:** suite 18 → 6 min on Windows (#153); the auto-mode classifier is the recurring friction (documented answer:
  exact-name MCP tools); unattended runs stop at the first permission prompt (FOC-920 In Review); plan.intent p90 ≥ 600 s
  (FOC-691); the quickstart has never been followed by anyone but Mateusz (FOC-781).
- **Code:** clean import graph, 77 % docstrings, but 16 files > 1000 lines, four ~1000-line factories, 77 CLI mains in
  `scripts/`, ~60 duplicated helpers, 213 exports nobody imports, line-based lint only.

## 2. What the docs already plan (and what is stale)

| Track | Planned | State |
|---|---|---|
| M8 1.0.0 | FOC-789 → 781 → 790 | gate open, see above |
| M2 graph engine | FOC-477 (10 counted arm-A runs) → go/no-go → FOC-712 | attempt 7 not run; M2 target 11-20 at risk; M3/M4 sequencing waits on it |
| M4 delivery loop as graph | FOC-478 → 382 → 390 → 617 → 622 → 456 → 393 → 453 | backlog; this is the **quality** track |
| M3 Jev at the gates | FOC-391 → 387 → 410 → 384 → 392 | backlog; calibration (FOC-387) before any auto-answer |
| M5 slim DEV/Supervisor | FOC-731, rest of FOC-621 | after the tag |
| M6 optimisation & learning | FOC-110/222/223/224 (F5–F8), Harness² FOC-944–947, GEPA FOC-398, FT FOC-273/281/282/625 | "data first; no scheduled work" |
| M7 release discipline | FOC-715 → … → 724 | after the tag |
| Remote control | FOC-957 phases C–E | backlog; A/B done |
| Model campaign | FOC-965 via FOC-967 | PRD draft awaiting acceptance |
| Precedent index | ADR-0014, F0 spike done (recall OK, cost prediction failed) | go/no-go T0.8 pending since 09-29, no tickets, code uncommitted |

Stale: `ROADMAP.md` dates (FOC-789 "11-17→11-27"), missing FOC-957/965/967/944–947, JOI-era NOW/NEXT/LATER tail; who merges
(ROADMAP vs HANDOFF); which dossier ships with 1.0 (FOC-724 vs FOC-790); Supervisor model (grok vs mimo across PRDs); squad
PRDs name pre-routing-v2 models; `docs/releases/1.0.0/README.md` says the acceptance run has not happened.

## 3. Proposal — order of work

Principle: **measure → cheapen → harden → learn.** Do not build a learning loop over metrics that do not yet have a target or a
frozen eval set; the docs already say this ("data first") and the precedent-index spike proved it (retrieval fine, cost
prediction useless).

### Phase 0 — close 1.0 (before anything else; 1–2 weeks)
1. rc.6, three cleanup gates answered, FOC-789 part 2, S1–S30 filed, FOC-790 dossier, tag `v1.0.0`.
2. `ROADMAP.md` rewritten from this document + taxonomy; the contradictions in §2 resolved in one PR.

### Phase 1 — measure (2–3 weeks after the tag) — *speed, ease, code*
3. **Targets on the board:** first-time-right (REVIEW pass on round 1), cost per ticket by size, operator interventions per
   ticket, wall time per ticket. Each as a number with a target line on Costs & quality; the weekly CADENCE digest reports the
   deltas. Without this, nothing in Phase 4 can be judged.
4. **Cost truth:** cache-read cost measured, not derived (FOC-419); Bash output cap after measuring the distribution (11.7 % of
   the bill, recommended in the context-attribution study, never done).
5. **Code change cost:** ESLint (no-unused-vars, no-undef, import/no-cycle), `scripts/lib/cli.mjs` + `format.mjs` for the
   ~60 duplicated helpers, `test-run --affected` on top of `code-intel affected`, `--prove-isolation` in the Linux CI job,
   jobs from `os.availableParallelism()`.
6. **Operator friction:** S1–S30 triaged into "fix now" (S2 null provider, S5 first-run hold, S21 `fenix restart`, S29 doctor
   crash) and "later"; FOC-920 finished (unattended policy); FOC-781 walked by someone else.

### Phase 2 — cheapen the Supervisor (the 72 %) — *cost*
7. **FOC-967 → FOC-965:** per-ticket model arms with sticky assignment and the report; accept the PRD, pick the arm list once
   (the two docs disagree today). This is the only lever that can move the $4.90 by a factor, not a percent.
8. **FOC-283 handoff compressor** (taxonomy: "the biggest cost lever"; stage 1 promising, n=16) and **FOC-457 tier per node**
   — both reduce what the Supervisor re-reads, which is where 85 % of its cost sits.
9. **On-demand VM** (FOC-957 phase D, $7–8 vs $50–55 a month) — cheap, independent, and it is what lets runs happen when the
   laptop is closed.

### Phase 3 — harden the delivery loop — *quality*
10. The M4 chain in the order the docs give, but starting with the three that attack the 68 % rework directly:
    **FOC-456 AC coverage gate** (no "done" without every AC touched), **FOC-390 REVIEW finding verifier** (a finding must
    cite an artefact that exists), **FOC-393 repeat-round classifier** (stop loops that repeat, not loops that move).
11. **FOC-387 decision calibration** on the recorded labels — the prerequisite for any gate auto-answer (M3), and the first
    place the decision log is *used*.

### Phase 4 — self-improvement v1 — *the loop Mateusz asked for*
Design it as **proposals, not mutations.** The docs' consensus (Harness², precedent index, agent-intelligence, F8) is the
same loop; it has simply never been built end to end:

```
observe  — decisions.jsonl (answer + label), verdict rounds, cost per ticket, snags, tool_facts
reflect  — a weekly CADENCE child on a cheap model: "what went wrong, what kept repeating, what did the model
           answer differently from what happened" → lessons per domain (Harness² FOC-944/945)
propose  — one PR per proposal, with evidence links and a dry-run delta on the frozen eval set:
           prompt/skill edit · lane/routing change · graph step · missing tool · budget change
gate     — human promotion (FOC-946 harness-promotion gate); Mateusz vetoes in the PR, never in a chat
promote  — merge; the change is a normal commit with provenance
measure  — the Phase 1 targets before/after; a proposal that does not move its metric is reverted by the next reflect
```

Concrete first slice (one ticket, 1–2 weeks): the reflect step over the last 20 runs producing a markdown "lessons" file
and at most three proposal PRs per week, limited to **prompt and skill edits** (the only artefacts with a prompt-edit
checklist precedent). Second slice: **lane/routing proposals** from delegation outcomes + model arms (Phase 2 data).
Third: **tool gaps** — the `unknowns[]` and refused calls in the decision log name the tools children wanted.
The precedent index (go, narrowed) plugs in as the retrieval side of "reflect" once T0.8 is decided; fine-tuning stays out
until a corpus exists (the verdict-parser pilot showed why).

Guardrails that make this safe: proposals can only touch `agents/**`, `config/graph.json`, `config/models.json`,
`scripts/test-lanes.json`; every PR runs the eval set; the Supervisor itself never imports lessons the gate has not promoted
(FOC-988's deny rules already keep it out of `/opt/fenix`).

## 4. Decisions needed from Mateusz

1. Phase order as above (close 1.0 first, nothing new before the tag) — yes/no.
2. FOC-477 campaign: finish attempt 7 and the 10 runs (M2 verdict) or park it and let M4 proceed on the squad pipeline?
3. Precedent index T0.8: "go, narrowed" (retrieval only, as the reflect step's memory) or drop.
4. FOC-965/967 model campaign: accept the PRD; which arm list (PRD vs research doc)?
5. Self-improvement v1 scope: prompts/skills first (recommended) or routing first?
6. Code hygiene: ESLint + helper extraction as one ticket in Phase 1 — yes/no.
7. Who merges to `main` going forward (ROADMAP says delivery owner since 10-17, HANDOFF says Mateusz).

## 5. What this does not cover
Remote-control phases C and E (phone steering) and GEPA/FT are deferred by the docs themselves; nothing here contradicts that.
No headline release metrics exist yet (1.0 PRD "not now") — Phase 1 item 3 is where they would come from.
