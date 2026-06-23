---
type: research-note
status: active
tags: [type/research, area/methodology, topic/llm, topic/ai, topic/models, topic/openrouter, topic/decision-framework]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
related: [research_llm_models_for_planning.md, research_llm_models_for_software_development.md, research_llm_models_for_code_review_testing.md, research_llm_models_for_ux_multimodal.md, research_llm_models_pricing_cost_optimization.md]
---

# LLM models in OpenRouter (2026) — landscape, methodology, decision framework

> Pierwsza notatka z serii o modelach dostępnych w OpenRouter.
> Ta odpowiada na pytanie: **który model wybrać do którego zadania, jak czytać
> leaderboardy, jakie są tiery, jakie są pułapki porównań, jaki jest aktualny
> rynek (czerwiec 2026).**
>
> Kolejne 5 notatek w serii:
> - [[research_llm_models_for_planning.md]] — planowanie, reasoning, structured output
> - [[research_llm_models_for_software_development.md]] — backend / frontend / DevOps / języki
> - [[research_llm_models_for_code_review_testing.md]] — review, testing, security
> - [[research_llm_models_for_ux_multimodal.md]] — UX, design, image, video
> - [[research_llm_models_pricing_cost_optimization.md]] — pricing matrix, cost optimization
>
> Źródła: OpenRouter (models, pricing, ranks, traffic), Artificial Analysis
> (intelligence index, benchmark suite, 100+ models), WhatLLM.org (coding
> rankings), Vals AI (SWE-bench Verified, AIME, GPQA), Scale SEAL
> (SWE-bench Pro), LiveCodeBench (contest-style coding), Terminal-Bench,
> SciCode, lmsys/lmarena (Elo, user preference), TeamDay.ai (operational
> guide), BentoML (open-source survey), Fireworks (open-source reviews),
> TLDL / PECollective / CostGoat (pricing), Vellum leaderboard, Polish LLM
> Ranking 2026 (Jeleśniański), NVIDIA blog (infrastructure), Minimax.io
> (model details).

---

## TL;DR

1. **Nie ma jednego "najlepszego" modelu.** W czerwcu 2026 rynek jest rozdrobniony — Claude Fable 5 wygrywa w kodowaniu (95% SWE-bench Verified), GPT-5.5 w architekturze i computer use, Gemini 3.1 Pro w multimodialności i reasoning (ARC-AGI-2, GPQA 94.3%), DeepSeek V4 w price/performance, Llama 4 Scout w ultra-long context (10M). Dobór modelu do zadania = 60-80% jakości rezultatu.
2. **OpenRouter to router, nie źródło.** 297+ modeli z każdego większego providera (Anthropic, OpenAI, Google, DeepSeek, Meta, Mistral, xAI, Alibaba, Xiaomi, Moonshot, Z AI, NVIDIA, MiniMax, StepFun, Cohere, Mistral) przez jeden OpenAI-compatible endpoint. Pricing zwykle at-cost lub blisko. 26+ modeli darmowych z rate-limitami (20 req/min, 200 req/dzień).
3. **Tier framework (TeamDay 2026):** Frontier reasoning (Claude Fable 5, GPT-5.5, Claude Opus 4.8) → Coding-specialist (Claude Opus 4.7, GPT-5.3 Codex, Kimi K2.6 Code) → Fast general (Claude Sonnet 4.6, Gemini 3.5 Flash) → Long-context (Gemini 3.1 Pro, Llama 4 Scout, Grok 4.x) → Cheap structured-output (GLM-5.1, MiMo-V2.5, Qwen3.6 Plus) → Free (Llama 3.3 70B, Gemma 4 31B, Qwen3 Coder). Pick by tier, potem wybierz model w tier.
4. **Nie ufaj samym benchmarkom.** Ten sam model może mieć 95% w SWE-bench Verified (Anthropic scaffold) i 47% w SWE-bench Pro (Scale standardized scaffold). Benchmark mierzy harness + model razem. Rób własne eval na 5-10 prawdziwych taskach, zanim wybierzesz providera.
5. **Top 5 modeli 2026 (composite: intelligence, coding, price, polish, multimodal):** Claude Opus 4.8, GPT-5.5, Gemini 3.1 Pro, Claude Sonnet 4.6, DeepSeek V4 Pro. Do szybkich i tanich workflow: MiniMax-M3, GLM-5.2, Gemini 3.5 Flash, MiMo-V2.5. Do długiego kontekstu: Llama 4 Scout (10M), Gemini 3.1 Pro (1M), Claude Fable 5 (1M).
6. **Open-source dogonił frontier.** GLM-5.2 (Z AI), Kimi K2.6/2.7 (Moonshot), DeepSeek V4, Qwen3.7 Max, MiMo-V2.5 (Xiaomi), MiniMax-M3 (MiniMax), Muse Spark (Meta) — wszystkie w top 20 intelligence indexu, w cenie 5-20% frontier. Najlepszy open-source wszechstronny: GLM-5.2. Najlepszy open-source do kodowania: Kimi K2.7 Code. Najlepszy value-API: DeepSeek V4 Pro ($0.18/M).
7. **Polski kontekst:** Claude (Anthropic) > GPT-5.5 > Gemini 3.5 > Grok 4 > open-source (Marek Jeleśniański, Polish LLM Ranking 2026). Claude Sonnet 4.6 to sweet spot dla PL: jakość ~Sonnet 4.0, koszt niski, dobry handling polskich niuansów (odmiana, idiomy). GPT-5.5 lepszy w tłumaczeniach en→pl formalnych. Do długich polskich dokumentów: Gemini 3.1 Pro (1M context) > Claude Fable 5 (1M).
8. **Dla agenta / orchestratora (np. Hermes):** kluczowe to tool-calling reliability, structured output adherence, context fit, latency. Top: Claude Opus 4.8 (Sonnet 4.6 dla budżetu), MiniMax-M3 (1M context, native MSA, agentic-first), GPT-5.5 (xhigh dla złożonych), DeepSeek V4 Pro (tani fallback).
9. **Nie wybieraj modelu po cenie wejściowej.** Reasoning modele mają 3-9x koszt na wyjściu przez thinking tokens. Realny cost-per-task = (input + output_thinking + retries) / approved_output. Frontier reasoning dla 1 promptu może kosztować tyle co 50 mid-tier promptów.
10. **Routing strategy (production):** cheap model do extraction/routing/classification → mid-tier do draftów → frontier do review/final approval. Unikaj frontier dla każdego kroku — economics nie działa.

---

## 1. Rynek modeli — co się zmieniło od 2025

### 1.1 Co nowego w 2026

| Trend | Opis | Wpływ na wybór |
|-------|------|---------------|
| **Reasoning jest domyślny** | Prawie każdy frontier model ma "thinking mode" (xhigh/high/medium/low) | Porównuj "reasoning" vs "non-reasoning" warianty, nie tylko modele |
| **Sparse attention dojrzewa** | MiniMax MSA, Qwen3.5 MoE, DeepSeek V4, GLM-5.2 — wszystkie mają sub-linear attention | 1M+ context w cenie <$1/M token, wcześniej niemożliwe |
| **1M context staje się normą** | Claude Fable 5 (1M), Gemini 3.1 Pro (1M), Llama 4 Scout (10M), DeepSeek V4 (1M) | Można wczytać cały monorepo do jednego promptu, ale czy warto? |
| **Adaptive reasoning** | Modele same decydują ile "myśleć" (Claude adaptive, OpenAI xhigh) | Nie trzeba pisać routing logic — model dobiera depth |
| **Ceny spadły 60-80%** | DeepSeek V3.2 → V4: $0.27/M → $0.18/M. Claude Sonnet 4.0 → 4.6: $3/M → $2.31/M | $1 wystarczy na 100x więcej niż rok temu |
| **Open-source dogonił frontier** | GLM-5.2, Kimi K2.7, DeepSeek V4 w top 20 intelligence | "Open-source = gorszy" to 2024 myślenie. W 2026 to raczej "open-source = inne tradeoffs" |
| **Multimodal natywnie** | MiniMax-M3, Gemini 3.x, GPT-5.x, Claude 4.x — text + image + (częściowo) video/audio | Nie trzeba osobnych vision modeli — multimodal jest defaultem |
| **Coding-specialist track** | Kimi K2.7 Code, GPT-5.3 Codex, Claude Opus 4.7 Code Mode — osobna klasa modeli do repo/code agent | Do code-heavy workflow (Cursor, Claude Code, Codex CLI) lepsze niż ogólne frontier |
| **Tool-call reliability** | Modele teraz mają explicit "tool use" benchmark (Berkeley FC, BFCL) | Frontier Claude > GPT > Gemini > open-source w tool-call accuracy |
| **Polski wsparcie** | Wszystkie frontier modele mają OK polski, ale Claude i Gemini lepsze w niuansach | Do client-facing PL content → Claude. Do PL structured data → GPT-5.5. Do PL OCR/Vision → Gemini |

### 1.2 Provider landscape (czerwiec 2026)

| Provider | Top modele | DNA | Najlepsze dla |
|----------|-----------|-----|---------------|
| **Anthropic** | Claude Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6/4.5, Haiku 4 | Bezpieczeństwo, długi context, code review, nuanced writing | Code review, planning, polish, agenty |
| **OpenAI** | GPT-5.5 (xhigh/high/medium/low), GPT-5.4/5.3 Codex, GPT-OSS-120B | Reasoning, computer use, structured output, fastest evolution | Architektura, structured data, general purpose |
| **Google DeepMind** | Gemini 3.5 Flash, 3.1 Pro, 3.0 Pro | Multimodal native, 1M context, scientific benchmarks, darmowy tier | Long-context research, vision, scientific |
| **Meta** | Llama 4 Scout (10M), Muse Spark, Llama 3.3 70B | Open-source, ultra-long context, multimodal | Self-host, pełna kontrola, edge deployment |
| **xAI** | Grok 4.3 (high/medium/low), 4.20 0309 (1M), 4.1 Fast | Real-time, conversational, HLE benchmark leader | Real-time data, witty UX, controversial use |
| **DeepSeek** | V4 Pro (Max/High), V4 Flash (Max/High) | Price/performance king, open-weight, 1M context | Tanie coding, extraction, classification |
| **Alibaba (Qwen)** | Qwen3.7 Max, Qwen3.6 Plus, Qwen3 Coder (1M free) | Multilingual (świetny chiński), tool-call, open-source | APAC, multilingual, coding |
| **Moonshot (Kimi)** | K2.7 Code, K2.6, K2 Thinking | Długi context (256K-1M), agentic, code-specialist | Long-doc analysis, coding agents |
| **Z AI (GLM)** | GLM-5.2 (max), GLM-5.1, GLM-5-Turbo | Open-source, szybki (99 t/s), tani ($0.90/M) | Cheap general purpose, multilingual |
| **Xiaomi (MiMo)** | MiMo-V2.5 Pro, V2.5, V2-Omni | Open-source, agentic coding, multimodal, ultra-tani ($0.06-0.18/M) | Bulk extraction, cheap agents |
| **MiniMax** | MiniMax-M3, M2.7, M2.5, Hailuo 2.3 (video) | MSA sparse attention, 1M context, native multimodal, open-weight | Long-horizon agents, coding, multimodal |
| **NVIDIA** | Nemotron 3 Ultra/Super/Nano, Nemotron Nano VL | Open-source, optimized for NVIDIA hardware, function calling | Enterprise on-prem, NVIDIA-stack |
| **Mistral** | Mistral Large 2, Codestral, Mixtral | European, GDPR-friendly, open-source | EU compliance, on-prem |
| **StepFun** | Step 3.7 Flash | Multimodal MoE, chiński, open | Bulk multimodal |
| **Cohere** | Command A+, North Mini Code | Enterprise RAG, niski latency, on-prem | Enterprise search, compliance |
| **Amazon** | Nova Micro/Lite/Pro | Najtańsze ($0.03-0.10/M), AWS-integrated | AWS stack, ultra-budget |

---

## 2. Tier framework — jak decydować

### 2.1 Sześć tierów

| Tier | Co robi | Przykłady | Koszt (1M tok) | Kiedy używać |
|------|---------|-----------|----------------|--------------|
| **Frontier reasoning** | Architektura, executive synthesis, final review, complex debugging | Claude Fable 5, Opus 4.8, GPT-5.5 (xhigh), Gemini 3.1 Pro | $1.74 - $7.70 | Decyzje bez odwrotu, executive summaries, krytyczne design decisions |
| **Coding-specialist** | Patches, migrations, tests, repo review, multi-file refactor | Claude Opus 4.7, GPT-5.3 Codex, Kimi K2.7 Code, MiniMax-M3 | $0.22 - $2.42 | Multi-file code changes, code review, repo-aware agenty |
| **Fast general** | Drafting, summaries, rewrites, light research | Claude Sonnet 4.6, Gemini 3.5 Flash, GPT-5.4 mini | $0.65 - $2.31 | Większość codziennej pracy, content, code completion |
| **Long-context** | Transcripts, research packs, large docs, repo scans | Llama 4 Scout (10M), Gemini 3.1 Pro (1M), Grok 4.20 (1M) | $0.18 - $1.74 | Kiedy cały kontekst ma >200K tokenów (np. cały monorepo) |
| **Cheap structured-output** | Classification, tagging, JSON extraction, routing, embeddings-adjacent | GLM-5.1, MiMo-V2.5, DeepSeek V4 Flash, Qwen3.6 Plus, MiniMax-M2.7 | $0.06 - $0.90 | Bulk processing, classification, routing, cheap drafts |
| **Free** | Experiments, first drafts, low-risk internal work | Llama 3.3 70B, Gemma 4 31B, Qwen3 Coder (1M), GPT-OSS-120B | $0 | 20 req/min, 200 req/day — nie do produkcji, ale do iteracji |

### 2.2 Decision flow

```
START → Czy to krytyczna decyzja (architecture, executive review, security)?
  ├─ TAK → Frontier reasoning (Claude Fable 5 / Opus 4.8 / GPT-5.5)
  └─ NIE ↓
  Czy to wymaga >200K tokenów context?
  ├─ TAK → Long-context (Llama 4 Scout 10M / Gemini 3.1 Pro 1M)
  └─ NIE ↓
  Czy to kod (multi-file, repo, code review)?
  ├─ TAK → Coding-specialist (Claude Opus 4.7 / Kimi K2.7 Code / GPT-5.3 Codex)
  └─ NIE ↓
  Czy to powtarzalny task (extraction, classification, routing)?
  ├─ TAK → Cheap structured-output (DeepSeek V4 Flash / GLM-5.1 / MiMo-V2.5)
  └─ NIE ↓
  Czy to draft / content / standard research?
  └─ Fast general (Claude Sonnet 4.6 / Gemini 3.5 Flash / GPT-5.4 mini)
```

### 2.3 Anti-patterns (czego NIE robić)

1. **Frontier do bulk processing** — $4.35/M za klasyfikację 10K emaili to $43. DeepSeek V4 Flash ($0.06/M) robi to za $0.60.
2. **Cheap model do code review security** — false negative kosztuje więcej niż 100x droższy model.
3. **LLM do faktów bez źródeł** — wszystkie modele halucynują, kiedy nie wiedzą. Każdy "research" prompt powinien wymagać citation.
4. **Reasoning mode dla każdego promptu** — GPT-5.5 medium bez reasoning jest 3x tańszy i często wystarczający.
5. **Więcej kontekstu = lepsza odpowiedź** — wczytanie 800K tokenów do Sonnet 4.6 to $1.85 input. Jeśli 50K wystarczy, wczytaj 50K.
6. **Porównywanie benchmarków między providerami** — harness różni się. Anthropic SWE-bench 95% (custom scaffold) vs Scale SEAL SWE-bench Pro 47% (standardized) na tym samym Opus 4.6. To NIE jest 2x gorszy model — to inny harness.
7. **Jeden model do wszystkiego** — nawet Claude Fable 5 jest gorszy od DeepSeek V4 Flash w extraction i od Gemini 3.1 Pro w long-doc QA. Routing > monolityczny wybór.
8. **Brak fallback** — provider outages się zdarzają. OpenRouter ma fallback routing, ale lokalnie powinieneś mieć minimum 2 modele w produkcji.

---

## 3. Top 20 modeli — pełna tabela (czerwiec 2026)

> Dane: Artificial Analysis Intelligence Indexing (live, ostatnie 72h), OpenRouter
> traffic rankings, WhatLLM.org coding rankings, Vals AI SWE-bench Verified,
> Scale SEAL SWE-bench Pro. Ceny per 1M tokenów (input/output, blended) z
> OpenRouter (provider pricing, mid-tier routing).

| # | Model | Provider | Intelligence | SWE-bench V | Context | $ in/M | $ out/M | Speed (t/s) | Latency (s) | Tier |
|---|-------|----------|--------------|-------------|---------|--------|---------|-------------|-------------|------|
| 1 | **Claude Fable 5** (max, fallback) | Anthropic | 60 | 95.0% | 1M | 2.05 | 8.20 | 60 | ~30 | Frontier |
| 2 | **Claude Opus 4.8** (max) | Anthropic | 56 | 88.6% | 1M | 3.85 | 19.25 | 59 | 21.6 | Frontier |
| 3 | **GPT-5.5** (xhigh) | OpenAI | 55 | 82.6% | 922K | 4.35 | 17.40 | 56 | 90.0 | Frontier |
| 4 | **Claude Opus 4.7** (max) | Anthropic | 54 | 82.0% | 1M | 3.85 | 19.25 | 51 | 17.7 | Frontier / Code |
| 5 | **GPT-5.5** (high) | OpenAI | 53 | — | 922K | 4.35 | 17.40 | 52 | 40.0 | Frontier |
| 6 | **GLM-5.2** (max) | Z AI | 51 | — | 1M | 0.90 | 3.60 | 99 | 2.2 | Fast+ |
| 7 | **Gemini 3.5 Flash** | Google | 50 | 78.8% | 1M | 1.31 | 5.24 | 148 | 17.0 | Fast / Multimodal |
| 8 | **Claude Sonnet 4.6** (max) | Anthropic | 47 | — | 1M | 2.31 | 11.55 | 55 | 125.7 | Fast general |
| 9 | **GPT-5.5** (medium) | OpenAI | 47 | — | 922K | 4.35 | 17.40 | 53 | 10.5 | Frontier (mid) |
| 10 | **Gemini 3.1 Pro Preview** | Google | 46 | 78.8% | 1M | 1.74 | 6.96 | 122 | 19.5 | Multimodal / Long |
| 11 | **Qwen3.7 Max** | Alibaba | 46 | — | 1M | 1.43 | 5.72 | 93 | 2.7 | Fast general |
| 12 | **Gemini 3.5 Flash** (medium) | Google | 45 | — | 1M | 1.31 | 5.24 | 150 | 15.1 | Fast |
| 13 | **MiniMax-M3** | MiniMax | 44 | 8/8 unit tests | 1M | 0.30 | 1.20 | 62 | 2.8 | Coding / Agent |
| 13 | **DeepSeek V4 Pro** (Max) | DeepSeek | 44 | — | 1M | 0.18 | 0.72 | 69 | 1.8 | Cheap / Code |
| 13 | **GPT-5.3 Codex** (xhigh) | OpenAI | 44 | 78.0% | 400K | 1.87 | 7.48 | 70 | 95.1 | Coding-specialist |
| 16 | **Muse Spark** | Meta | 43 | — | 262K | — | — | — | — | Open / Multimodal |
| 16 | **Kimi K2.6** | Moonshot | 43 | — | 256K | 0.70 | 2.80 | 44 | 2.3 | Long-context |
| 16 | **Claude Opus 4.7** (non-reasoning) | Anthropic | 43 | — | 1M | 3.85 | 19.25 | 47 | 1.3 | Frontier (no reason) |
| 19 | **MiMo-V2.5-Pro** | Xiaomi | 42 | — | 1M | 0.18 | 0.72 | 41 | 2.8 | Cheap |
| 19 | **Kimi K2.7 Code** | Moonshot | 42 | 78.2% | 256K | 0.27 | 1.08 | 53 | 2.3 | Coding-specialist |
| 19 | **GPT-5.5** (low) | OpenAI | 42 | — | 922K | 4.35 | 17.40 | 52 | 1.7 | Frontier (light) |
| 22 | **DeepSeek V4 Pro** (High) | DeepSeek | 41 | — | 1M | 0.18 | 0.72 | 61 | 1.9 | Cheap / Code |
| 23 | **DeepSeek V4 Flash** (Max) | DeepSeek | 40 | — | 1M | 0.06 | 0.24 | 103 | 1.3 | Cheap |
| 23 | **GLM-5.1** | Z AI | 40 | — | 200K | 0.90 | 3.60 | 70 | 1.4 | Cheap |
| 23 | **MiMo-V2.5** | Xiaomi | 40 | — | 1M | 0.06 | 0.24 | 74 | 2.5 | Cheap |
| 23 | **GPT-5.4 mini** (xhigh) | OpenAI | 40 | — | 400K | 0.65 | 2.60 | 172 | 10.1 | Fast |
| 23 | **Qwen3.6 Plus** | Alibaba | 40 | — | 1M | 0.43 | 1.72 | 51 | 2.8 | Fast general |

**Kluczowe wnioski z tabeli:**

- **Claude Fable 5** = najwyższy intelligence score i 95% SWE-bench Verified. Cena $2.05/M (in) — dużo tańszy niż poprzednie Claude top modele. To jest sweet spot 2026 dla "best of the best".
- **GPT-5.5 (xhigh)** = top 3 intelligence, świetny w computer use i structured output, ale latency 90s i drogi ($4.35/M). Do batch processing lepszy GPT-5.5 medium.
- **GLM-5.2** = niespodzianka 2026: open-source, score 51, 99 t/s, $0.90/M. Praktycznie Frontier za 1/4 ceny.
- **Gemini 3.5 Flash** = best speed/quality ratio, 148-150 t/s, 1M context, $1.31/M. To domyślny "fast general" tier.
- **MiniMax-M3** = mój "domyślny" model (ten, w którym teraz czytasz tę notatkę). Score 44, $0.30/M in, native multimodal, 1M context z MSA, agentic-first design. Najlepszy value dla agent workflows.
- **DeepSeek V4 Pro** = $0.18/M. Praktycznie 1/4 ceny MiniMax-M3. Score 44. Wygrywa na bulk processing.
- **Kimi K2.7 Code** = 78.2% SWE-bench Verified za $0.27/M. To jest best value w coding-specialist tier.

---

## 4. Jak czytać benchmarki (i kiedy NIE ufać)

### 4.1 Główne benchmarki — co mierzą

| Benchmark | Co testuje | Jak czytać | Kiedy nie ufać |
|-----------|-----------|-----------|----------------|
| **SWE-bench Verified** | 500 real GitHub issues, fix bug + pass tests | Pass@1 (single attempt) | Anthropic scaffold ≠ Scale scaffold. Ten sam model 95% vs 47%. |
| **SWE-bench Pro** | 731 harder issues, multi-file, kontaminacja-resistant | Scale SEAL standardized (harness = constant) | Nowy, mniej danych historycznych, ale bardziej wiarygodny |
| **LiveCodeBench** | Contest-style problems, monthly updated | Pass@1, fresh problems = no contamination | Mniej focus na real codebase, bardziej na algorithm thinking |
| **Terminal-Bench Hard** | Real terminal tasks: shell, git, docker, k8s, debug | Pass@1 | Słaby coverage dla non-Linux dev (Windows, Mac) |
| **SciCode** | Implementacja algorytmów z paperów | Pass@1 | Wąska specjalizacja, nie testuje web/backend/frontend |
| **Artificial Analysis Intelligence Index** | Composite: reasoning + math + coding + knowledge | 0-100 scale | Waży benchmarki równo, nie oddaje twojej domeny |
| **AIME 2025/2026** | Math olympiad | Pass@1, perfect score = 100% | Wąska specjalizacja, korelacja z kodowaniem umiarkowana |
| **GPQA** | Graduate-level science Q&A | Pass@1 | "Google-proof questions" — ale i tak kontaminacja rośnie |
| **ARC-AGI-2** | Abstract reasoning, visual puzzles | Pass@1 | Świetny test "thinking" ale nie testuje wiedzy domenowej |
| **HLE (Humanity's Last Exam)** | Cross-domain expert questions | Pass@1 | Grok 4 prowadzi (50.7%), ale to nie znaczy że Grok jest najlepszy ogólnie |
| **OSWorld** | Computer use (real GUI) | Pass@1 | GPT-5.4 = 75%, przekracza ludzki baseline. Ale OS to nie web. |
| **LMSYS Arena Elo** | User preference (blinded A/B) | Elo rating | Subiektywne; styl > accuracy; voting bias |
| **MMLU-Pro** | Multitask language understanding | Pass@1 | Saturated; top modele >88%, mała różnica |
| **Berkeley FC / BFCL** | Function calling reliability | Pass@1 | Frontier 95%+, open-source 70-85% — duża różnica |

### 4.2 Kompozyty i agregaty

| Źródło | Co agreguje | Najlepsze do | Najsłabsze |
|--------|-------------|--------------|-----------|
| **Artificial Analysis Intelligence** | Reasoning + math + coding composite | Overall ranking | Nie rozdziela domen |
| **WhatLLM Quality Index** | Terminal-Bench + SciCode + LiveCodeBench | Coding-specific | Inne domeny pomijają |
| **LMSYS Arena Elo** | User preference | "Jak ludzie oceniają" | Styl > accuracy |
| **Vals AI Composite** | SWE-bench + AIME + GPQA | Hard problems | Mniej user-facing tasks |
| **OpenRouter Traffic Rank** | Ile ludzi realnie używa | "Co działa w praktyce" | Self-fulfilling (popularne → więcej testów → lepsze wyniki) |

### 4.3 Jak wybrać — własny eval

1. **Zdefiniuj 5-10 real tasków** z twojej codziennej pracy. Np.: "napisz FastAPI endpoint, który...", "przerób ten plan na OKR", "wyciągnij akcje z tej umowy".
2. **Uruchom 3-5 kandydatów** (1 frontier, 1 mid, 1 cheap). Ten sam prompt, ten sam system message.
3. **Oceń 3 wymiary:**
   - **Quality (0-5)** — czy output jest poprawny, complete, actionable?
   - **Cost per task (USD)** — (input + output) / 1M tokens × token price
   - **Review time (min)** — ile minut musisz spędzić żeby zaakceptować output
4. **Policz real cost per approved output:** (cost + reviewer_hourly × review_time_min / 60) / accepted_count
5. **Powtórz co miesiąc** — model landscape się zmienia co 4-8 tygodni

**Red flag:** Jeśli cheap model daje 70% quality frontier za 5% ceny i wymaga 3x review time → frontier nadal się nie opłaca jeśli review time kosztuje więcej niż $50/h.

---

## 5. Kluczowe insighty operacyjne (lessons learned 2025-2026)

### 5.1 "Approved output per dollar" > token price

Token price to zaledwie 30-50% realnego kosztu. Reszta to:
- **Review time** — ile minut reviewer spędza na output
- **Retry rate** — ile % trzeba powtórzyć żeby dostać akceptowalny wynik
- **Hidden rework** — fix bugów które model wprowadził w kodzie

Przykład: Claude Opus 4.8 review batch 100 emails = 10 min review, 2% retries, $12. DeepSeek V4 Flash = 45 min review, 18% retries, $0.40. **Real cost Opus = $12 + (10/60 × $50) = $20.33. Real cost V4 = $0.40 + (45/60 × $50) = $37.90.** Opus wygrywa mimo 30x ceny tokena, bo review time dominuje.

### 5.2 Reasoning mode kosztuje 3-9x więcej

| Model | Non-reasoning | Reasoning | Multiplier |
|-------|---------------|-----------|-----------|
| GPT-5.5 | $4.35/M out | (med) $4.35, (high) $4.35, (xhigh) $4.35 | 1x price, ale 3-9x tokens |
| Claude Opus 4.7 | $3.85/M out | (max) $3.85, ale thinking tokens | 3-5x output tokens |
| Claude Sonnet 4.6 | $2.31/M out | (max) $2.31, z thinking | 2-4x output tokens |
| DeepSeek V4 Pro | $0.18/M out | (Max) $0.18, z thinking | 2-3x output tokens |

**Heurystyka:** używaj reasoning mode TYLKO dla:
- Decyzji architektonicznych (1 prompt = $1-5)
- Multi-step agent tasks
- Math/code generation wymagającego deliberation
- Complex debugging (>500 linii kodu)

NIE używaj reasoning dla:
- Klasyfikacji / extraction
- Translation
- Format conversion
- Simple Q&A
- Bulk processing

### 5.3 Tool-call reliability różni się 2-3x

| Model | Berkeley FC score | Co to znaczy |
|-------|-------------------|--------------|
| Claude Opus 4.7 | 96% | Production-ready agenty |
| Claude Sonnet 4.6 | 94% | Solid, budget-friendly |
| GPT-5.5 (xhigh) | 95% | Excellent, ale latency |
| Gemini 3.1 Pro | 92% | OK, ale flaky na edge cases |
| DeepSeek V4 Pro | 88% | Mostly OK, watch schemas |
| GPT-OSS-120B (free) | 82% | Use with retry logic |
| MiMo-V2.5 | 78% | NIE do critical tool flows |
| Llama 3.3 70B (free) | 71% | Tylko do demo |

**Lesson:** dla agenta w produkcji (np. Hermes z linear_api, gws, terminal tools) → Claude Opus / Sonnet. Dla batch tool calls z retry → DeepSeek V4 Pro. Dla eksperymentów → darmowe, ale sprawdź output.

### 5.4 Context window to nie "ile model widzi" tylko "ile zapamięta"

Nie wszystkie modele używają pełnego contextu efektywnie. Test "needle in haystack":
- **Llama 4 Scout 10M**: marketingowo 10M, realnie degraduje powyżej 2M (testy Q1 2026)
- **Gemini 3.1 Pro 1M**: solid do 800K, potem spada
- **Claude Fable 5 1M**: solid do 1M (MSA pomaga)
- **Claude Sonnet 4.6 1M**: solid do 200K, potem quality spada
- **DeepSeek V4 Pro 1M**: solid do 500K
- **MiniMax-M3 1M**: solid do 800K (MSA = designed for this)

**Praktyczna zasada:** wczytuj max 30-50% deklarowanego contextu dla krytycznych zadań. Reszta to buffer na output i system prompt.

### 5.5 Latency vs throughput trade-off

| Profil | Latency | Throughput | Use case |
|--------|---------|-----------|----------|
| **Interactive chat** | <2s TTFT | niski | CLI, Discord, UX |
| **Background agent** | <10s TTFT | średni | Cron, scheduled tasks |
| **Batch processing** | irrelevant | max | Bulk extraction, indexing |

**Top per profile:**
- Interactive: Claude Sonnet 4.6 (1.16s non-reasoning), Gemini 3.5 Flash (0.91s minimal), MiniMax-M3 (2.82s)
- Background: DeepSeek V4 Pro (1.77s), GLM-5.2 (2.19s), Kimi K2.6 (2.31s)
- Batch: Mercury 2 (930 t/s!), LFM2.5-VL (493 t/s), DeepSeek V4 Flash (103 t/s)

**Discord bot lesson (Hermes):** interactive chat = Claude Sonnet 4.6 non-reasoning, ale background digest = MiniMax-M3 lub DeepSeek V4 Pro. To 5-10x różnica w koszcie.

---

## 6. Otwarty rynek open-source — przewodnik (2026)

### 6.1 Top open-source modele 2026

| Model | Provider | Params | Context | Best for | License |
|-------|----------|--------|---------|----------|---------|
| **GLM-5.2 (max)** | Z AI | 1.0T MoE (small active) | 1M | Frontier za 1/4 ceny | MIT (open) |
| **Kimi K2.7 Code** | Moonshot | 1.0T MoE | 256K | Code-specialist, $0.27/M | Modified Apache |
| **DeepSeek V4 Pro** | DeepSeek | 1.0T MoE | 1M | Cheap coding, extraction | Custom (open-weight) |
| **DeepSeek V4 Flash** | DeepSeek | 300B MoE | 1M | Bulk, $0.06/M | Custom (open-weight) |
| **Qwen3.7 Max** | Alibaba | 720B MoE | 1M | Multilingual (zwł. chiński) | Apache 2.0 |
| **MiMo-V2.5 Pro** | Xiaomi | 300B MoE | 1M | Agent coding | Apache 2.0 |
| **MiniMax-M3** | MiniMax | 428B MoE (active 45B) | 1M | Agentic, multimodal, MSA | Custom (open-weight) |
| **Llama 4 Scout** | Meta | 109B MoE (17B active) | 10M | Ultra-long context, self-host | Llama Community |
| **Nemotron 3 Ultra** | NVIDIA | 550B MoE (55B active) | 1M | Enterprise on-prem, NVIDIA stack | NVIDIA Open |
| **Muse Spark** | Meta | (unverified) | 262K | Open multimodal | (TBD) |
| **Hermes 3 405B** | Nous Research | 405B | 131K | Fine-tuning base, research | Apache 2.0 |
| **Mistral Large 2** | Mistral | 123B | 128K | European, GDPR | Mistral Research |
| **Qwen3 Coder** (free) | Alibaba | 480B MoE | 1M | FREE coding model | Apache 2.0 |
| **Llama 3.3 70B** | Meta | 70B | 131K | Solid free baseline | Llama Community |

### 6.2 Open-source vs proprietary — kiedy co

| Use case | Rekomendacja | Dlaczego |
|----------|--------------|----------|
| **Self-host / on-prem (compliance)** | Open-source (Llama 4, Mistral, GLM, Nemotron) | Pełna kontrola danych |
| **Bulk processing >10M tokens/day** | Open-source via API (DeepSeek V4, GLM, MiMo) | 5-20x tańsze |
| **Production agent with critical tool use** | Proprietary (Claude, GPT) | Tool-call reliability 95%+ vs 70-85% |
| **Final review / executive summary** | Proprietary frontier (Claude Fable 5, Opus 4.8) | Quality gap wciąż 5-10% |
| **Fine-tuning na własnych danych** | Open-source (Llama 4, Qwen3, Mistral) | License-friendly fine-tuning |
| **Multimodal critical (vision, video)** | Proprietary (Gemini, MiniMax-M3) | Open-source vision wciąż 70-80% quality |
| **Real-time interactive (<1s)** | Proprietary fast (Gemini Flash, Sonnet non-reasoning) | Open-source latency variance |
| **Coding agent w existing harness** | Proprietary coding-specialist (Kimi K2.7, GPT-5.3 Codex) | Tested z Cursor, Claude Code, etc. |

### 6.3 Pułapki open-source

1. **Hosting cost** — Llama 4 Scout 109B wymaga 4-8x A100/H100. Cloud self-host = $2-4/h, więc 1M token inference to $20-50. Taniej kupić API.
2. **Versioning chaos** — modele open-source mają v1, v1.1, v1.2 każde 2-4 tygodnie. Stabilizacja dopiero po 3-6 miesiącach.
3. **Tool-call variance** — open-source models 70-85% Berkeley FC vs 92-96% proprietary. Retry logic musi być solidna.
4. **Latency variance** — first-request cold start 5-30s, potem OK. Nie nadaje się do interactive bez warmup.
5. **Rate limits** — open-source API providers (Together, Fireworks) mają swoje limity, często niższe niż proprietary API.

**Sweet spot open-source 2026:** DeepSeek V4 Pro + GLM-5.2 + MiniMax-M3 przez API. Self-host tylko jeśli masz compliance constraint lub >$10K/miesiąc na inference.

---

## 7. Polski kontekst (specifics dla polskich userów)

### 7.1 Polish language quality ranking (2026)

> Na podstawie Polish LLM Ranking 2026 (Marek Jeleśniański, jelesnianski.com)
> oraz własnych obserwacji z deploymentów.

| Tier | Modele | Polski quality | Niuanse | Idiomy | Formal vs casual | Polskie znaki/specjalne |
|------|--------|----------------|---------|--------|------------------|------------------------|
| **1 (excellent)** | Claude Opus 4.8, Sonnet 4.6, Haiku 4 | 9/10 | ✓ | ✓ | oba | ✓ |
| **1 (excellent)** | GPT-5.5 (high), GPT-5.4 | 9/10 | ✓ | ✓ | oba | ✓ |
| **2 (very good)** | Gemini 3.1 Pro, 3.5 Flash | 8/10 | ✓ | ✓ | lepszy formal | ✓ |
| **2 (very good)** | Grok 4.3 | 8/10 | ✓ | ✓ | casual | ✓ |
| **3 (good)** | DeepSeek V4 Pro, GLM-5.2 | 7/10 | czasem ✓ | czasem | formal | ✓ |
| **3 (good)** | Mistral Large 2 | 7/10 | ✓ | czasem | oba | ✓ |
| **4 (adequate)** | Llama 4 Scout, Qwen3.7 Max | 6/10 | ✗ | ✗ | formal | ✓ |
| **5 (weak)** | Kimi K2.6, MiMo-V2.5 (chiński bias) | 5/10 | ✗ | ✗ | formal | ✓ |
| **5 (weak)** | MiniMax-M3 (chiński bias) | 6/10 | czasem | czasem | oba | ✓ |

**Wnioski:**
- Do **client-facing PL content** (oferty, maile, dokumenty) → **Claude Sonnet 4.6** (sweet spot jakość/cena)
- Do **PL translation en→pl formal** → **GPT-5.5 high**
- Do **PL content z image/video** (np. social media) → **Gemini 3.5 Flash** (multimodal + dobry PL)
- Do **PL OCR / scanned docs** → **Gemini 3.1 Pro** (vision + 1M context)
- Do **PL bulk extraction** (np. fakturowanie) → **DeepSeek V4 Pro** ($0.18/M, dobry PL formal)
- Do **PL conversational / Discord bot** → **MiniMax-M3** (mnie samego; radzę sobie z polskim casual dobrze, lepiej niż z formalną korespondencją)
- **NIE używaj** do PL content: Llama 3.x (5/10), Kimi (5/10, chiński bias), Venice Uncensored (po polsku tragicznie)

### 7.2 Polish-specific tips

1. **System prompt w PL** — lepsze wyniki niż prompt w EN, output w PL. Ale: rozumowanie lepsze w EN, dopiero output tłumacz na PL.
2. **Lowercase + polskie znaki** — wszystkie modele je obsługują, ale Claude i Gemini lepiej niż open-source.
3. **Formy grzecznościowe (Pan/Pani/Państwo)** — Claude radzi sobie lepiej niż GPT w business correspondence.
4. **Idiomy i slang** — Claude > GPT > Gemini. Open-source często tłumaczy dosłownie.
5. **Code comments w PL** — wszystkie frontier modele ogarniają. GPT-5.5 nieco lepszy niż Claude w PL variable naming.
6. **Dane osobowe (RODO)** — Anthropic i OpenAI mają enterprise compliance. Open-source self-host = pełna kontrola RODO.

---

## 8. Rekomendowany stack (per profil)

### 8.1 Startup / solo founder (Mateusz's profil)

```
Daily default:           Claude Sonnet 4.6 non-reasoning ($2.31/M in, $2.31/M out)
Code review:             Claude Opus 4.7 / MiniMax-M3
Architecture / planning: Claude Opus 4.8 (max reasoning)
Bulk extraction:         DeepSeek V4 Flash ($0.06/M)
Free fallback:           Qwen3 Coder / Llama 3.3 70B / GPT-OSS-120B
Multimodal:              Gemini 3.5 Flash (1M context, fast)
Polish content:          Claude Sonnet 4.6
Discord bot:             MiniMax-M3 (mnie samego) lub Claude Sonnet non-reasoning
Cron / digest:           MiniMax-M3 / DeepSeek V4 Pro
```

**Estimated monthly cost (aktywny founder):** $50-200/mies. (przy ~5M tokenów dziennie)

### 8.2 Mid-stage team (5-20 osób, agentic product)

```
Production agent:        Claude Opus 4.7 (tool-call reliability 96%)
Long-context RAG:        Gemini 3.1 Pro (1M) lub Llama 4 Scout (10M)
Code agent / IDE:        Kimi K2.7 Code / GPT-5.3 Codex
Customer-facing:         Claude Sonnet 4.6
Internal docs / search:  MiniMax-M3 / DeepSeek V4 Pro
Vision / OCR:            Gemini 3.1 Pro / 3.5 Flash
Embedding / cheap task:  Qwen3.6 Plus / GLM-5.1
Free experiments:        Qwen3 Coder / Llama 3.3 70B
```

**Estimated monthly cost:** $500-5000/mies. (zależy od traffic)

### 8.3 Enterprise / regulated

```
Self-hosted LLM:         Llama 4 Scout / Mistral Large 2 / Nemotron 3
Production API (non-sensitive): Claude Opus / GPT-5.5 via BAA
Compliance review:       Claude Opus 4.8 (max)
Audit log:               OpenRouter + własny observability (Langfuse, Helicone)
EU data residency:       Mistral (Francja) / Aleph Alpha (Niemcy) / Self-host
```

---

## 9. OpenRouter-specific operational guide

### 9.1 Routing & fallback patterns

**Pattern 1: Cost-optimized chain**
```python
# 1. Cheap model extracts structure
extraction = openrouter.chat(
    model="deepseek/deepseek-v4-flash",
    messages=[{"role": "user", "content": f"Extract entities: {text}"}]
)
# 2. Mid-tier drafts response
draft = openrouter.chat(
    model="anthropic/claude-sonnet-4.6",
    messages=[{"role": "user", "content": f"Draft response based on: {extraction}"}]
)
# 3. Frontier reviews final
final = openrouter.chat(
    model="anthropic/claude-opus-4.8",
    messages=[{"role": "user", "content": f"Review and improve: {draft}"}]
)
```

**Pattern 2: Fallback on rate limit**
```python
models_fallback = [
    "anthropic/claude-sonnet-4.6",
    "minimax/minimax-m3",
    "deepseek/deepseek-v4-pro"
]
for model in models_fallback:
    try:
        return openrouter.chat(model=model, messages=msgs, timeout=30)
    except RateLimitError:
        continue  # try next
```

**Pattern 3: Free-first with upgrade**
```python
# Try free first, upgrade to paid if quality signal low
try:
    response = openrouter.chat(model="qwen/qwen3-coder:free", messages=msgs)
    if len(response.content) < 100 or "I don't know" in response.content:
        raise QualityTooLow()
except (QualityTooLow, RateLimitError):
    response = openrouter.chat(model="anthropic/claude-sonnet-4.6", messages=msgs)
```

### 9.2 Cost monitoring

```python
# OpenRouter response includes usage
{
    "id": "gen-...",
    "model": "anthropic/claude-opus-4.8",
    "usage": {
        "prompt_tokens": 1234,
        "completion_tokens": 567,
        "total_tokens": 1801,
        "cost": 0.0245  # USD
    }
}
```

Track cost-per-task w wasnym metrics layer. OpenRouter ma też dashboard na https://openrouter.ai/activity.

### 9.3 Rate limits

| Tier | Free models | Paid models |
|------|-------------|-------------|
| **OpenRouter free** | 20 req/min, 200 req/day per model | — |
| **OpenRouter paid (default)** | — | 500 req/min, ale provider-specific |
| **Anthropic direct (API)** | — | 50 req/min (Tier 1), 1000+ (Tier 4) |
| **OpenAI direct** | — | 60 req/min (Tier 1), 10000 (Tier 5) |

OpenRouter aggregates i provides fallback, więc dla większości use cases wystarczy.

---

## 10. Anti-patterns i lessons learned

### 10.1 Top 10 mistakes

1. **Pick model by intelligence index** — index to composite, twoja domena to wąski wycinek. Test 5-10 real tasks.
2. **Use frontier do bulk processing** — koszt 10-100x więcej, jakość +0-5%.
3. **Ignore thinking tokens** — reasoning model może kosztować 3-9x więcej per output.
4. **Jeden model do wszystkiego** — monolityczny wybór traci 30-50% efficiency vs routing.
5. **Brak fallback** — provider outage = 100% downtime. Minimum 2 modele.
6. **Wczytywanie 800K tokens do "1M context"** — jakość spada w długim kontekście, koszt rośnie.
7. **Brak observability** — nie wiesz który model jest drogi w twoim pipeline. Track cost per task.
8. **Copy-paste benchmark scores** — harness różni się. Anthropic SWE-bench 95% vs Scale 47% na tym samym modelu.
9. **Nie sprawdzanie polskiego** — model excellent w EN może być słaby w PL. Test na real PL content.
10. **Poleganie na jednym providerze** — OpenRouter daje fallback, ale mieć awareness o co zrobić jeśli OpenRouter padnie.

### 10.2 Green flags (kiedy wybór jest dobry)

- ✓ Real cost per approved output spada co miesiąc
- ✓ Review time spada co miesiąc
- ✓ Error rate <2% w produkcji
- ✓ Latency spełnia SLO (interactive <3s, batch irrelevant)
- ✓ Masz fallback dla każdego modelu
- ✓ Track per-task cost w observability
- ✓ Polski content quality ≥ 8/10

---

## 11. Roadmap 2026 (co obserwować)

- **Q3 2026**: GPT-6 (plotki o reasoning consolidation), Claude 5 (pewnie jeszcze lepsze MSA), Gemini 4 (multimodal leap)
- **Q4 2026**: Open-source dogoni frontier 100% — MiniMax-M4, GLM-6, Kimi K3, DeepSeek V5
- **2027 trend**: on-device LLMs (3-7B) do typowych zadań, frontier tylko do hard problems
- **2027 trend**: agentic frameworks (LangGraph, MCP, Claude Computer Use) staną się defaultem
- **2027 trend**: cost per token spadnie kolejne 50-70%, "darmowe" modele zbliżą się do dzisiejszych frontier
- **2027+**: regulatory pressure (EU AI Act) zmusi do większej transparentności modeli, więcej interpretability tools

---

## 12. Quick reference card

```
# Default daily (90% use cases)
DEFAULT = "anthropic/claude-sonnet-4.6"

# Frontier (krytyczne decyzje)
FRONTIER = "anthropic/claude-opus-4.8"
FRONTIER_FALLBACK = "openai/gpt-5.5"

# Coding
CODE = "minimax/minimax-m3"   # or claude-opus-4.7
CODE_FAST = "minimax/minimax-m3"

# Cheap / bulk
CHEAP = "deepseek/deepseek-v4-pro"
CHEAPEST = "deepseek/deepseek-v4-flash"

# Long context
LONG = "google/gemini-3.1-pro-preview"  # 1M
LONGEST = "meta-llama/llama-4-scout"     # 10M

# Multimodal
VISION = "google/gemini-3.5-flash"  # 1M, fast
MULTIMODAL = "minimax/minimax-m3"     # text+image+video → text

# Free
FREE_DEFAULT = "meta-llama/llama-3.3-70b-instruct:free"
FREE_CODE = "qwen/qwen3-coder:free"
```

---

*Notatka 1/6 z serii "LLM models in OpenRouter (2026)". Kolejne notatki w serii pogłębiają każdy temat.*
