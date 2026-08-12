---
type: prd
status: active
maturity: v2
---

# PRD — REVIEW

<goal>In Review task → parallel 3-pass (first-pass, security, deep) → merge findings into Conventional Comments → max 2 dev↔review bounces → hand to TEST (`stage:testing` + `ai:reviewed`) or escalate. Merge authority: deep (correctness/arch) > security (auth/secrets) > first-pass (lint/style).</goal>

<squad_table>
| Role | Model |
|------|-------|
| lead | glm-5.2 |
| first-pass | deepseek-v4-pro |
| security | kimi-k2.7-code |
| deep | glm-5.2 |
</squad_table>

<runtime>Full loop (parallel dispatch, merge authority, Conventional Comments format, round tracking, escalation at round 3): see `agents/review/CLAUDE.md`.</runtime>

<scope>
- **first-pass**: lint, style, obvious bugs, missing tests.
- **security**: SAST/SCA/secret-scan (Semgrep, Snyk, Trivy, GitGuardian) — tools + model.
- **deep**: correctness, architecture, edge cases, business logic.
- Merge: deduplicate by file+line, keep highest severity; apply merge authority on conflict.
- Verdict: `issue:` findings only block; `nitpick:`/`suggestion:`/`praise:`/`question:` are advisory.
</scope>

<build>
- Subagents: `agents/review/agents/{first-pass,security,deep}.md` + lead `CLAUDE.md`.
- settings.json: Read + Bash (git diff, security tools) + Linear MCP; **deny Edit/Write/git push/commit**.
- Smoke: `bin\agent.bat review deep` on real diff.
- Full squad: `bin\review.bat` → verdict.
</build>

<acceptance_criteria>
- [ ] 3 passes run in parallel; findings merged into Conventional Comments.
- [ ] `issue:` findings → In Progress (round++); clean → stage:testing + ai:reviewed.
- [ ] After 2 dev↔review bounces, no convergence → escalated + needs:answer.
- [ ] SAST/secret-scan executed (not model-only).
</acceptance_criteria>

<launchers>
```bat
bin\review.bat                   :: full squad (first-pass ∥ security ∥ deep)
bin\agent.bat review first-pass
bin\agent.bat review security
bin\agent.bat review deep
```
Refs: [`bin/review.bat`](../../bin/review.bat) · [`bin/agent.bat`](../../bin/agent.bat).
</launchers>
