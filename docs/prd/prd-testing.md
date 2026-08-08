---
type: prd
status: active
maturity: v2
---

# PRD — TESTING

<goal>stage:testing → deploy (OpenRouter build → GCP VM, **health-check + auto-rollback mandatory**) → E2E (smoke + critical-path + security-lite on synthetic data) → PASS→`Done`(+URL) or FAIL→root-cause→`In Progress`. Assertions on VALUES; solo profile scope.</goal>

<squad_table>
| Role | Model |
|------|-------|
| lead | minimax-m3 |
| deploy | deepseek-v4-pro |
| scenario_gen | deepseek-v4-flash |
| runner | minimax-m3 |
| root_cause | glm-5.2 |
</squad_table>

<runtime>Full loop (deploy→health→E2E→verdict, synthetic data policy, flaky rules, loop-limit, rollback behavior): see `agents/test/CLAUDE.md`.</runtime>

<scope>
- Deploy: OpenRouter build → GCP VM (per `config/projects.json`); Ollama/GPU → Lambda fallback.
- Health-check: mandatory before E2E; fail → auto-rollback, abort, report FAIL.
- Scenarios: synthetic data only (no prod PII, RODO compliant); happy + 3–5 edge cases per AC.
- Runner: assertions on VALUES (not `toBeDefined`); flaky → diagnose root cause (no blind-retry); observability (logs/metrics post-deploy).
- Root-cause: GLM-5.2 on E2E failures; post findings, return to DEV In Progress.
</scope>

<build>
- Subagents: `agents/test/agents/{deployer,scenario_gen,runner,root_cause}.md` + lead `CLAUDE.md`.
- settings.json: Bash (docker, gcloud, ssh, curl, playwright) + Write + Linear MCP; deny `rm -rf`, git push.
- config/projects.json: GCP VM name + Lambda config.
- Smoke: `bin\agent.bat test deployer --dry-run`.
- Full squad: `bin\test.bat`.
</build>

<acceptance_criteria>
- [ ] Deploy OpenRouter build to GCP VM; health-check fail → auto-rollback.
- [ ] E2E tests on deployed app with synthetic data; assertions are value-based.
- [ ] PASS → Done (+ deploy URL); FAIL → root-cause diagnosis → In Progress.
- [ ] Ollama/GPU build paths wired to Lambda fallback.
</acceptance_criteria>

<launchers>
```bat
bin\test.bat                     :: full squad (deploy→scenario-gen→runner→root-cause)
bin\agent.bat test deploy
bin\agent.bat test scenario_gen
bin\agent.bat test runner
bin\agent.bat test root_cause
```
Refs: [`bin/test.bat`](../../bin/test.bat) · [`bin/agent.bat`](../../bin/agent.bat).
</launchers>
