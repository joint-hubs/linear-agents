---
type: design-doc
status: active
tags: [type/design-doc, area/ai, topic/linear, topic/agent, topic/testing, topic/deploy]
created: 2026-06-22
updated: 2026-06-22
maturity: design-v2
---

# Agent 4 — TEST (deploy + testy zdeployowanej apki)

> Deployuje i testuje **działającą aplikację** (nie tylko kod). Lekko (solo profile): smoke +
> critical-path + security-scan, nie pełna piramida. Launcher: `bin/test.bat`
> (`CLAUDE_CONFIG_DIR=configs/test`). Diagram: [04_review_test](diagrams/04_review_test.puml).

## Trigger
Task po approve review (`stage:testing`). Ręczne odpalenie lub webhook.

## Routing modeli
| Krok | Model | Czemu |
|---|---|---|
| Deploy orchestration | **DeepSeek V4 Pro** | szybki tool-call; multimodal = screenshoty UI |
| Test scenario gen (bulk) | **DeepSeek V4 Flash** | najtańszy bulk |
| Run + analiza | **MiniMax M3** (multimodal) | ogląda zrzuty zdeployowanej apki |
| Root-cause failów | **GLM-5.2** | hard-debug |
| Terminal-heavy deploy debug | **GPT-5.5** (opcjonalnie) | Terminal-Bench 82.7 |

## Cel deployu (z `config/projects.json`)
- **OpenRouter build → GCP VM** (skonfigurowana nazwa instancji) — domyślnie.
- **Ollama/GPU build → Lambda AI** (GPU) — alternatywna ścieżka.

## Kroki
1. **Pre-deploy.** Pull merged; build (delivery-loop: rebuild+redeploy). Wersja = OpenRouter (nie Ollama, chyba że projekt wymaga GPU → Lambda).
2. **Deploy z safety.** Wgranie na **GCP VM**; **health-check** (endpoint/sanity). Fail → **auto-rollback** do poprzedniej wersji + komentarz (C8). Ryzykowne → canary (opcjonalnie).
3. **Scenario gen (DeepSeek).** Happy path + 3–5 edge cases z AC; **synthetic data, nigdy prod PII** (C9).
4. **Run (MiniMax).** Testy E2E smoke + critical-path na zdeployowanej apce; security DAST-lite; (multimodal: zrzuty UI). Asercje na **wartości**, nie `toBeDefined` (C10).
5. **Observability check.** Logi/metryki/błędy po deployu na miejscu? (`testing` §6).
6. **Verdykt:**
   - **Pass** → `Done` + komentarz (link deploy, co przetestowano).
   - **Fail** → root-cause (GLM-5.2) → komentarz → `In Progress` + ewentualnie `risk:high`.

## Metadane Linear
Status `stage:testing→Done|In Progress` · komentarz z URL deployu + wynikami · `ai:reviewed` zachowane.

## Safeguards (P0)
- **Health-check + rollback** obowiązkowe (C8). Synthetic data (C9, RODO).
- Cost guardrail. Flaky → fix, nie retry w nieskończoność (C10).
- Loop-limit z DEV (wspólny licznik) → `escalated`.

## Output
Zdeployowana, przetestowana wersja na GCP (lub Lambda dla GPU) · task `Done` lub zwrot do DEV z root-cause.

## Failure handling
Deploy fail → rollback + `escalated` + @Mateusz. Brak observability → `needs:access`. Powtarzalny fail → `escalated`.
