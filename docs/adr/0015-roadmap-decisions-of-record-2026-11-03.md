# ADR-0015: Six documentation contradictions resolved with the 2026-11-03 ROADMAP rewrite

**Status:** Accepted

**Date:** 2026-11-03

## Context

The 1.0 recon (`docs/roadmap/2026-10-26-next-steps-proposal.md` §2) found six places where two documents gave two answers. FOC-1050 rewrites `docs/ROADMAP.md` and asks for one written answer per contradiction. The delivery owner decides under the standing authorisations Mateusz gave in chat (merge to `main` 2026-10-17, the Supervisor model 2026-11-02, REVIEW overlay FOC-1171); every answer below can be reversed by Mateusz with one line here.

## Decision

1. **Who merges to `main`: the delivery owner.** Authorised by Mateusz on 2026-10-17 ("masz zgodę na mergowanie"). The flow is: a child's branch → PR → green CI → the delivery owner merges with `gh pr merge --merge`, sets the ticket Done and records the delivery verdict. Mateusz still answers gates and approves tag pushes; the Supervisor never merges. `docs/HANDOFF.md` §5 and §8 point here; the registry label `branch → PR → Mateusz merges on GitHub` in `config/agent-state.json` is a UI string pinned by a test and is left for FOC-1224-style hygiene.
2. **Which dossier ships with 1.0: FOC-790's hand-written dossier** (`docs/releases/1.0.0/README.md`). FOC-724 is the 1.1 dossier generator, after M7, as ROADMAP said on 2026-10-12. The 1.0 PRD §8 P4 is corrected. The release README no longer says the acceptance run has not happened: FOC-789 part 1 ran 2026-10-21/22/25, part 2 on 2026-10-26, day 5 on 2026-10-27 (rc.9); day 6 on rc.10 is scheduled 2026-11-09 → 11-24.
3. **The Supervisor model of record: `z-ai/glm-5.3-flash`**, since 2026-11-02 (Mateusz: "przełącz model supervisora na glm 5.3"), set through the Settings overlay `routing.supervisor.lead`. The code fallback stays `xiaomi/mimo-v2.6-pro` (`scripts/squad-config.mjs`). History: grok-4.7 was tried 2026-10-20 (~12× the cost), mimo was the lead 2026-10-21 → 11-02. The remote-control PRD §7 is corrected. The REVIEW lead is `xiaomi/mimo-v2.6-pro` through `routing.review.lead` (FOC-1171, since 2026-11-02; false-pass checkpoints decide whether it stays).
4. **Squad models are routing v2** (FOC-964, `config/models.json` routing): `glm-5.3-flash` everywhere except PLAN lead / spec / spec_review / pl and CADENCE retro / pl on mimo, DEV multifile / hard, REVIEW security / deep and TEST root_cause on `z-ai/glm-5.3`, plus the REVIEW lead overlay above. The five squad PRDs and the `docs/agents/` mirrors are rewritten to these values; `config/models.json` is the source and the tables are snapshots dated 2026-11-03.
5. **FOC-965 arm list, picked once:** `glm-5.3-flash` (baseline = the model of record at campaign start), `mimo-v2.6-pro`, `claude-haiku-5.5`, `gemini-4-argon`, `muse-spark-1.3`, `claude-sonnet-5.5`. This is the PRD's list with `gpt-6.1-sol` dropped (the research doc rejects it on honesty and cache-write cost) and `claude-haiku-5.5` added (the research doc's candidate 1). Six arms, five tickets each, as the PRD sizes it.
6. **Autonomous pickup: off by default, opt-in behind a flag; not part of the 1.0 acceptance.** The 1.0 PRD decision D2 ("a human steers it") stands as the default. FOC-902's opt-in (`taskSessions.autoPickup.enabled`, default false) is a configuration the owner may switch on for their own scope, as the delivery session did for FOC-1055/1053/1068; FOC-789 runs with it off.

## Consequences

- **Positive:** one answer per question, each in the owning document, with this ADR as the record; ROADMAP.md stops contradicting HANDOFF.md and the PRDs.
- **Negative:** the squad PRD tables are snapshots and will drift again; FOC-718 (ROADMAP rendered from Linear) and FOC-1224 (STATE.md index) are the structural fixes.
- **Risks:** decision 3 moved twice in two weeks; the FOC-1171 checkpoints (reviewFalsePass by model) and the FOC-965 campaign are the evidence that may move it again.

## Alternatives Considered

1. **Resolve each contradiction only in the newer document** — leaves no record of why; the next recon finds the same six.
2. **Keep mimo as the Supervisor of record** — contradicts the running configuration since 2026-11-02 and Mateusz's instruction.
3. **Adopt the research doc's arm list verbatim** — it names only two candidates against a baseline; the PRD's six-arm design is what FOC-967 builds.
