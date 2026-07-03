---
type: prd
status: active
area: review
tags: [type/prd, area/ai, topic/linear, topic/agents, topic/code-review]
created: 2026-06-23
maturity: prd-v1
---

# PRD — REVIEW squad

> Obszar REVIEW jako zestaw agentów (lead + 3 subagentów) + narzędzia security.
> Spec: [agent-3-review](../agents/agent-3-review.md). Launchery — na końcu.

## 1. Cel
Task w `In Review` zrecenzować: równolegle tani first-pass + security tooling + głęboki review (GLM-5.2),
scalić w **Conventional Comments**, max 2 rundy → approve (`stage:testing`) lub zwrot do `In Progress`.

## 2. Zestaw agentów
| Sub-agent | Model | Odpowiedzialność |
|---|---|---|
| **lead** (`review`) | GLM-5.2 | risk-tiering, scalanie uwag, licznik rund, verdykt |
| **first-pass** | DeepSeek V4 Pro | lint/style/oczywiste bugi, brakujące testy |
| **security** | Kimi K2.7 Code + narzędzia | SAST/SCA/secret-scan (Semgrep/Snyk/Trivy/GitGuardian) |
| **deep** | GLM-5.2 | correctness / architektura / edge / logika biznesowa |

## 3. Jak zbudować
- Pliki: `agents/review/agents/{first-pass,security,deep}.md` + lead `CLAUDE.md`.
- **lead**: risk-tiering (`risk:high`/`type:tech`/auth-payments → głębiej); odpala 3 passy równolegle; scala → Conventional Comments (`praise/nitpick/suggestion/issue/question`; tylko `issue:` blokuje); pilnuje licznika rund.
- **security**: model + narzędzia CLI (read-only na repo); zwraca CVE/sekrety/podatności.
- **deep**: GLM-5.2 — correctness / architektura / edge cases / logika biznesowa.
- **Nie edytuje kodu** (settings deny Edit/Write); tylko komentarze. Komentarz do Mateusza PL.

## 4. Safeguards (P0)
**Max 2 rundy** dev↔review → `escalated` + @Mateusz. Security zawsze narzędziami (model łapie 60–80%). Zero „LGTM bez czytania". Cost guardrail.

## 5. Acceptance criteria
- [ ] 3 passy lecą równolegle; uwagi scalone w Conventional Comments.
- [ ] Issues → `In Progress` (round++); clean → `stage:testing` + `ai:reviewed`.
- [ ] Po 2 rundach bez zbieżności → `escalated`.
- [ ] SAST/secret-scan wykonane (nie tylko model).

## 6. Build steps
1. Subagenci `agents/review/agents/*.md` + lead CLAUDE.md.
2. settings.json: Read + Bash(security tools, git diff) + Linear MCP; **deny Edit/Write/git push/commit**.
3. Smoke: `bin\agent.bat review deep` na realnym diff.
4. Cały squad: `bin\review.bat` → verdykt.

## 7. Launchery (funkcjonalne)
```bat
bin\review.bat                   :: cały zestaw review (first-pass ∥ security ∥ deep)
bin\agent.bat review first-pass
bin\agent.bat review security
bin\agent.bat review deep
```
Pliki: [`bin/review.bat`](../../bin/review.bat) · [`bin/agent.bat`](../../bin/agent.bat).
