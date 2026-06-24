---
type: review
status: active
tags: [type/review, area/ai, topic/readiness, topic/kickoff]
created: 2026-06-23
maturity: review-v1
---

# Dev-readiness review — czy można zaczynać? (kickoff dla freestyle agenta)

## Werdykt (TL;DR)
**Tak — w 3 warstwach gotowości:**
- **Offline (od zaraz, 0 wejść):** logika/skrypty/testy, dry-run planowania, consistency linter, P0 jako kod.
- **Live z 1 kluczem (OpenRouter w `.env`):** spike mechanizmu subagentów + smoke launcherów.
- **Pełny pilot (po wejściach Mateusza):** Linear workspace/team + bot `@flow` + klucz Linear; GCP VM.

## Co zweryfikowane jako GOTOWE
- Wszystko **zacommitowane** (czysty working tree), 6 commitów.
- 5 squadów + 19 subagentów + leady + `settings.json`; `config/models.map` spójny z PRD.
- Config walidne (models/projects/labels/states + 4 issue templates); 4 skrypty przechodzą `node --check`.
- **Naprawiony bug:** slug Anthropic dla OpenRoutera był `claude-opus-4-8`/`-4-6` (myślnik = natywne API, NIE OpenRouter) → poprawione na `claude-opus-4.8`/`claude-sonnet-4.6` (zweryfikowane na `/models`). Bez tego `plan.bat` (lead=Opus) padał od razu.

## ⚠️ Ryzyka do de-ryzykowania PRZED masowym devem
1. **[KRYTYCZNE] Czy Claude Code honoruje `model: <openrouter-id>` we frontmatter subagenta?** Cały mechanizm „model per subagent" na tym stoi. Jeśli przyjmuje tylko `opus|sonnet|haiku|inherit` — 19 subagentów poleci na modelu sesji, nie na swoich. **Spike (10 min, 1 klucz OpenRouter):** `bin\plan.bat` → lead spawnuje 1 subagenta (`model: z-ai/glm-5.2`) → sprawdź `/status`/logi który model realnie poszedł. Jeśli nie działa → mechanizm = osobny `CLAUDE_CONFIG_DIR` per subagent (per-role) albo mapowanie na sloty opus/sonnet/haiku.
2. **Linear MCP** (`https://mcp.linear.app/sse`) — potwierdzić transport + auth (OAuth vs token) na żywo.
3. **Plan-mode + non-Anthropic main model** (GLM przez OpenRouter) — potwierdzić, że plan-mode działa.

## Blockery (wejścia od Mateusza)
- `.env`: **OPENROUTER_API_KEY** (minimum), Linear key, (Anthropic jeśli native).
- Linear: workspace/team (JOI? PISI?) + bot **`@flow`** (OAuth `actor=app` + webhooks).
- **GCP VM** (nazwa/projekt/zone) dla TEST. Lambda — deferred.

## Od czego zacząć (uporządkowane, offline-first)
- **S0 — spike (1 klucz OpenRouter):** ryzyko #1 (subagent model-pinning) + smoke każdego launchera (`/status` pokazuje właściwy model; Linear MCP odpowiada). **Decyduje o architekturze — rób najpierw.**
- **S1 — consistency linter + smoke (offline):** `scripts/check.mjs` — sprawdza: models.map ↔ frontmatter subagentów, każda rola ma plik, labelki użyte w promptach ⊆ `labels.json`, JSON schema configów. Zielony/czerwony sygnał = bramka jakości dla dev-agenta. Plus `bootstrap-linear.mjs --dry-run` i `cost-report.mjs` na mocku.
- **S2 — PLANNING dry-run (offline):** z `planning/inbox/sample.md` wyprodukuj parent+subtasks jako lokalny JSON (mock Linear), z **idempotencją + DoR/DoD walidacją**. Najwęższy pionowy plaster, testowalny bez kluczy — waliduje rdzeń (orkiestracja + metadane).
- **S3 — Linear live (klucz Linear):** `bootstrap-linear.mjs` → labelki/statusy/templates; potem `push` na żywo = milestone M3 (realny epik w Linear).
- **S4+ — DEV → REVIEW → TEST** (M4–M6 z build-planu).

## P0 jako kod (zanim cokolwiek autonomiczne+live) — wszystko offline-testowalne
cost guardrail kill-switch (dopiąć próg/stop do `cost-report.mjs`) · idempotency push · loop-limit licznik (rundy review).

## Rekomendacja
1. **Zacznij od S2 (plan dry-run)** — waliduje najwięcej bez blockerów, od razu pokazuje czy mechanizm subagentów działa (jeśli S0 jeszcze nie zrobiony, S2 i tak da sygnał).
2. **Trzymaj freestyle agenta na wąskich slice'ach z zielonym linterem (S1) jako bramką** — nie „zbuduj całość". Zgodne z filozofią (małe pionowe plastry + weryfikacja).
3. **Dogfooding:** gdy S0–S2 zielone i Linear wstanie — zdekomponuj resztę budowy `linear-agents` **przez sam workflow** i prowadź dalszy development systemem na nim samym. To najlepszy test end-to-end.
