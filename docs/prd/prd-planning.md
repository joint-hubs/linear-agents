---
type: prd
status: active
maturity: v2
---

# PRD — PLANNING

<goal>Inbox item → Linear decomposition (parent epic + 3–15 subtasks with type, estimate, AC/DoD, blockedBy relations). Sync HITL gates (GATE 1: approve brief; GATE 2: approve sample subtasks). Idempotent push + rollback.</goal>

<squad_table>
| Role | Model |
|------|-------|
| lead | opus |
| discovery | minimax-m3 |
| dor_gate | deepseek-v4-flash |
| spec | glm-5.2 |
| spec_review | minimax-m3 |
| decompose | minimax-m3 |
| push | deepseek-v4-flash |
</squad_table>

<runtime>Full loop (gates, dispatch, idempotence, rollback policy, DRY-RUN auto-approve): see `agents/plan/CLAUDE.md`.</runtime>

<scope>
- Discovery: echo-back + brief ≤1 page (problem, outcome, open Q).
- DoR gate: Why + AC + scope-out + deps.
- Spec: tech design + ADR (on non-trivial decisions).
- Spec-review: adversarial skeptic (≤2 loops).
- Decompose: INVEST vertical slices, t-shirt estimate, AC (Given/When/Then), DoD checklist, link to parent (no copy).
- Push: idempotent create (check `externalId`, rollback on >1 fail), label `ai:planned` + `type:*`.
</scope>

<build>
- Subagents: `agents/plan/agents/{discovery,dor_gate,spec,spec_review,decompose,push}.md` + lead `CLAUDE.md`.
- settings.json: Read/Write Linear MCP; config/linear labels/statuses.
- Smoke: `bin\agent.bat plan discovery` on sample inbox item.
- Full squad: `bin\plan.bat` end-to-end → Linear.
</build>

<acceptance_criteria>
- [ ] Inbox item → brief ≤1 page + open questions; `transcript-uncertain` flag if needed.
- [ ] After GATE 1 ✅: parent (Initiative) + 3–15 subtasks in Todo, each with `type:*`, Estimate, AC/DoD, blockedBy.
- [ ] Rerun idempotent (no duplicates).
- [ ] Polish text to Mateusz; ADR/spec in English.
</acceptance_criteria>

<launchers>
```bat
bin\plan.bat                     :: full squad (discovery→dor→spec→spec-review→decompose→push)
bin\agent.bat plan discovery
bin\agent.bat plan spec
bin\agent.bat plan spec_review
bin\agent.bat plan decompose
bin\agent.bat plan push
```
Refs: [`bin/plan.bat`](../../bin/plan.bat) · [`bin/agent.bat`](../../bin/agent.bat).
</launchers>
