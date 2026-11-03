---
type: prd
status: active
maturity: v2
---

# PRD — CADENCE

<goal>Weekly retrospective: gather Linear state (throughput, WIP, drift, blockers, escalations), surface findings + action items, deliver Polish weekly digest to Mateusz. Read-mostly — no scope changes without approval.</goal>

<squad_table>
| Role | Model |
|------|-------|
| lead | glm-5.3-flash |
| collector | glm-5.3-flash |
| retro | mimo-v2.6-pro |
| digest | glm-5.3-flash |
</squad_table>

Models mirror `config/models.json` routing v2 (FOC-964) as of 2026-11-03 — the config is the source, this table is a snapshot; decisions of record: ADR-0015 §3–4.

<runtime>Full loop (orchestration, dispatch rules, HITL policy, safety constraints, gate rules): see `agents/cadence/CLAUDE.md`.</runtime>

<scope>
- Ingest flow-db (transcript metrics: step stats, bounces, repeats, failures).
- Collector: Linear queries (throughput, WIP counts, blocked/escalated/over-budget, aging WIP, unlinked tasks, stale `needs:*`).
- Retro: drift signals (no Initiative, stale needs, excess WIP); bounce analysis (`==2` vs `>2`); subagent cost share (target ≥40%).
- Digest: Polish; top priorities, blockers, action items, squad metrics.
</scope>

<build>
- Subagents: `agents/cadence/agents/{collector,retro,digest}.md` + lead `CLAUDE.md`.
- settings.json: Read/Write Linear MCP; deny Edit/push.
- Smoke: `bin\agent.bat cadence collector`; full squad: `bin\cadence.bat`.
</build>

<acceptance_criteria>
- [ ] Weekly digest (PL) includes throughput, blockers, drift, action items.
- [ ] Detects tasks without Initiative and stale `needs:*` labels.
- [ ] Reports bounce metrics (limit used vs. broken); subagent cost share.
- [ ] Proposes (never enforces) Now/Next/Later shifts.
</acceptance_criteria>

<launchers>
```bat
bin\cadence.bat                  :: full squad (collector→retro→digest)
bin\agent.bat cadence collector
bin\agent.bat cadence retro
bin\agent.bat cadence digest
```
Refs: [`bin/cadence.bat`](../../bin/cadence.bat) · [`bin/agent.bat`](../../bin/agent.bat).
</launchers>
