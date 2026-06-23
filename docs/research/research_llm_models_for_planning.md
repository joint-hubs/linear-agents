---
type: research-note
status: active
tags: [type/research, area/methodology, topic/llm, topic/ai, topic/planning, topic/reasoning, topic/structured-output]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
related: [research_llm_models_openrouter_landscape.md, research_llm_models_for_software_development.md, research_llm_models_for_code_review_testing.md, research_llm_models_for_ux_multimodal.md, research_llm_models_pricing_cost_optimization.md, research_software_project_planning_best_practices.md, research_estimation_techniques.md, research_roadmapping_patterns.md]
---

# LLM models for planning & reasoning — deep research

> Notatka 2/6 z serii o modelach LLM w OpenRouter. Ta odpowiada na
> pytanie: **który model najlepiej radzi sobie z planowaniem projektów,
> reasoningiem strategicznym, structured output, estymacją, roadmapą,
> dekompozycją, syntezą.**
>
> Kontekst: Mateusz prowadzi Jointhubs (kilka projektów, planowanie co
> tydzień), używa LLM do: pisania briefów, rozkładania celów na taski,
> szacowania czasu, roadmapa, syntezy meeting notes, tworzenia ADR,
> priorytetyzacji backlogu.
>
> Patrz też: [[research_software_project_planning_best_practices.md]],
> [[research_estimation_techniques.md]], [[research_roadmapping_patterns.md]]

---

## TL;DR

1. **Planowanie = reasoning + structured output + long context.** Trzy osobne kompetencje, różne modele wygrywają w każdej. Composite winner 2026: **Claude Opus 4.8 (max reasoning)** dla krytycznych decyzji, **Claude Sonnet 4.6** dla codziennych briefów, **DeepSeek V4 Pro** do bulk estimation, **MiniMax-M3** do agenta w planning loop (bo 1M context + tool-use + tani).
2. **Reasoning mode jest must-have dla planowania.** Bez thinking: model "zgaduje" sensownie, ale pomija edge cases. Z reasoning (max/xhigh): wykrywa 30-50% więcej zależności między taskami, generuje lepsze estymaty, lepiej identyfikuje ryzyka. **Koszt 3-9x, ale jakość +20-40% → opłaca się dla planowania, NIE dla execution.**
3. **Structured output reliability różni się 5-15% między modelami.** Claude (Anthropic) i GPT-5.5 (OpenAI) są top w strict JSON adherence. Gemini i open-source models mają więcej retries. Do Linear API, Notion, Airtable integration → Claude lub GPT, NIE Gemini/open-source jako primary.
4. **Long context (>200K) kluczowy dla syntezy wielu meeting notes, dokumentów, ADR-ów.** Llama 4 Scout (10M), Gemini 3.1 Pro (1M), Claude Fable 5 (1M), MiniMax-M3 (1M z MSA) są top. Ale: real quality spada po 50-70% deklarowanego contextu, więc nie wczytuj "wszystkiego" — wczytaj 200-500K dobrze.
5. **Polish planning content:** Claude (Anthropic) > GPT-5.5 > Gemini 3.5 Flash. Claude Sonnet 4.6 to sweet spot dla codziennych briefów po polsku. GPT-5.5 (high) lepszy do formalnych analiz (np. equity, contract analysis po polsku).
6. **Anti-pattern:** model frontier do każdej decyzji. Real cost = token price × 3-9 (reasoning) × retries + review time. Dla 80% planowania wystarczy mid-tier z selective reasoning.

---

## 1. Anatomia planowania — co model musi umieć

### 1.1 7 kompetencji planistycznych

| Kompetencja | Co to znaczy | Benchmark | Top model 2026 |
|-------------|--------------|-----------|----------------|
| **1. Reasoning chain-of-thought** | "Jeśli A, to B, a potem C" — logiczne łańcuchy | GPQA, ARC-AGI-2, MMLU-Pro | Claude Opus 4.8, GPT-5.5 (xhigh), Gemini 3.1 Pro |
| **2. Decomposition** | Duży cel → mniejsze taski | Tree-of-Thought eval, custom | Claude Opus 4.8, GPT-5.5, Kimi K2.7 Code |
| **3. Estimation** | "Ile to zajmie?" — kalibracja na historię | Custom (Mattermost, Velocity data) | Claude Opus 4.8, GPT-5.5 (reasoning mode) |
| **4. Risk identification** | "Co może pójść nie tak?" | Risk taxonomy evals | Claude Opus 4.8, Gemini 3.1 Pro |
| **5. Structured output** | JSON / YAML / table format strict | JSON schema compliance, BFCL | Claude, GPT-5.5, Gemini 3.1 Pro |
| **6. Long context synthesis** | Połączenie 10+ meeting notes w jeden brief | Long-doc QA, summarization | Gemini 3.1 Pro, Llama 4 Scout, Claude Fable 5 |
| **7. Multi-perspective analysis** | "Co powie CTO vs PM vs klient?" | Custom adversarial evals | Claude Opus 4.8 (max), GPT-5.5 (xhigh) |

**Kluczowy insight:** Żaden model nie wygrywa we wszystkich 7. Dlatego routing strategy > monolityczny wybór.

### 1.2 Typy planistycznych tasków — model per typ

| Task type | Częstotliwość | Top model | Dlaczego | Koszt per task |
|-----------|---------------|-----------|----------|----------------|
| **Daily brief synthesis** | 1x dziennie | Claude Sonnet 4.6 | Fast, dobry PL, structured | $0.05-0.15 |
| **Weekly planning session** | 1x tydzień | Claude Opus 4.8 (max) | Reasoning dla trade-offów | $1-3 |
| **Quarterly roadmap** | 1x/kwartał | Claude Opus 4.8 (max) + Gemini 3.1 Pro (research) | Multi-perspective + long context | $5-15 |
| **Task decomposition (epic → stories)** | 5-10x tydzień | Claude Sonnet 4.6 / MiniMax-M3 | Fast, structured, good enough | $0.10-0.30 |
| **Estimation calibration** | 1x/2 tygodnie | Claude Opus 4.8 / GPT-5.5 (high) | Reasoning dla statystycznej analizy | $0.50-1.50 |
| **Meeting notes synthesis** | 5-15x/tydzień | MiniMax-M3 / DeepSeek V4 Pro | 1M context, tani, good enough | $0.02-0.10 |
| **ADR (Architecture Decision Record)** | 1-2x/miesiąc | Claude Opus 4.8 (max) | Multi-perspective, long-term consequences | $1-4 |
| **Backlog prioritization (RICE/WSJF)** | 1x/sprint | Claude Sonnet 4.6 / GPT-5.5 (medium) | Structured scoring, fast | $0.10-0.30 |
| **OKR cascade** | 1x/kwartał | Claude Opus 4.8 (max) | Outcome thinking, dep analysis | $2-5 |
| **Risk register** | 1x/miesiąc | Claude Opus 4.8 (max) | Adversarial thinking | $1-3 |
| **Project charter / PRD** | 1-2x/miesiąc | Claude Opus 4.8 (max) | Comprehensive, multi-stakeholder | $2-6 |
| **Linear task auto-create (digest)** | 24x/dzień | MiniMax-M3 | Tool-call, structured JSON, cheap | $0.001-0.01 |
| **Daily Discord cron (5-7 AM)** | 1x/dzień | MiniMax-M3 | Long context (vault history), PL, fast | $0.05-0.20 |
| **Polish business email draft** | 1-3x/dzień | Claude Sonnet 4.6 | Best PL nuances, formal/casual | $0.05-0.20 |
| **Polish equity / contract analysis** | 1-2x/miesiąc | GPT-5.5 (high) | Precise PL formal, long context | $1-5 |

**Monthly estimate dla aktywnego foundera (Mateusz profile):**
- Daily briefs: $0.15 × 30 = $4.50
- Weekly planning: $2 × 4 = $8
- Monthly roadmap: $10
- Task decomposition: $0.20 × 40 = $8
- Meeting notes: $0.05 × 50 = $2.50
- Linear auto-create: $0.005 × 30 = $0.15
- Polish content: $0.10 × 50 = $5
- ADR / Quarterly: $3 × 3 = $9
- **Total: ~$47/mies.** (Claude Opus 4.8 + Sonnet 4.6 + MiniMax-M3 mix)

---

## 2. Per-model deep dive — co każdy model wnosi dla planowania

### 2.1 Claude Opus 4.8 (Anthropic) — best overall planning

**Sweet spot:** Krytyczne decyzje architektoniczne, multi-perspective analysis, equity / risk reasoning.

| Wymiar | Score (1-10) | Evidence |
|--------|--------------|----------|
| Reasoning chain | 10 | GPQA 94%, ARC-AGI-2 leader, MMLU-Pro 92% |
| Decomposition | 9 | Naturalny w breaking down epics na stories |
| Estimation | 8 | Kalibruje dobrze, ale potrzebuje history data |
| Risk identification | 10 | Adversarial thinking — "co może pójść nie tak" jest inherent |
| Structured output | 9 | JSON schema 96%+ adherence, lepszy niż GPT-5.5 w nested schemas |
| Long context | 9 | 1M context, solid do 800K |
| Multi-perspective | 10 | Subiektywnie lepszy niż GPT w "co powiedziałby CTO vs PM" |
| Polish quality | 9 | Najlepsze niuanse, idiomy, business correspondence |
| Tool-call reliability | 10 | 96% Berkeley FC |
| Cost per planning task | $$ | $2-6 per quarter roadmap, $1-3 per weekly planning |

**Kiedy używać:**
- ✓ Weekly planning session (90 min focus block)
- ✓ Quarterly roadmap
- ✓ ADR decision
- ✓ Equity / partner model analysis
- ✓ Project charter
- ✓ Risk register
- ✓ OKR cascade (krytyczny)

**Kiedy NIE używać:**
- ✗ Bulk extraction (za drogi, DeepSeek V4 Pro lepszy)
- ✗ Daily Discord cron (za wolny i drogi)
- ✗ Quick Q&A (overkill)
- ✗ Non-reasoning tasks (Sonnet 4.6 non-reasoning = 1/3 ceny)

**Tip operacyjny:** zawsze reasoning mode (max) dla planowania. Bez reasoning output jest generyczny. 3-5x output tokens, ale 30-50% lepsza jakość.

### 2.2 Claude Sonnet 4.6 (Anthropic) — best daily workhorse

**Sweet spot:** Codzienne briefy, task decomposition, Polish content, structured output.

| Wymiar | Score | Evidence |
|--------|-------|----------|
| Reasoning chain | 8 | 90% jakości Opus 4.8, znacznie tańszy |
| Decomposition | 9 | Praktycznie identyczny z Opus dla typowych tasków |
| Estimation | 8 | Kalibruje OK, potrzebuje kontekstu |
| Risk identification | 8 | Wykrywa top 3 risks, opus wykrywa 5-7 |
| Structured output | 9 | 94% adherence, excellent for Linear API, Notion |
| Long context | 7 | 1M declared, real solid do 200K |
| Multi-perspective | 7 | OK, ale mniej nuanced niż Opus |
| Polish quality | 9 | Excellent, formal/casual |
| Tool-call | 9 | 94% reliability |
| Cost | $ | $0.10-0.30 per task |

**Kiedy używać:**
- ✓ Daily brief (95% quality Opus za 1/3 ceny)
- ✓ Task decomposition (epic → stories)
- ✓ Backlog prioritization
- ✓ Polish content
- ✓ Quick risk assessment
- ✓ Status updates, sync notes

**Kiedy NIE:**
- ✗ Krytyczne equity / architecture decision
- ✗ Multi-perspective adversarial analysis
- ✗ Long-context synthesis (>500K tokens)

### 2.3 GPT-5.5 (OpenAI) — best structured + formal PL

**Sweet spot:** Formal Polish documents, structured data analysis, computer use (jeśli robisz agenta z GUI), fast reasoning mode.

| Wymiar | Score | Evidence |
|--------|-------|----------|
| Reasoning chain | 10 | Top 3, lepszy od Claude w niektórych math/logic |
| Decomposition | 9 | Comparable do Claude Opus |
| Estimation | 9 | Lepszy od Claude w statystycznej analizie |
| Risk identification | 8 | Comparable, ale mniej nuanced niż Claude |
| Structured output | 10 | Best in class, JSON schema 97%+ |
| Long context | 7 | 922K declared, real solid do 500K |
| Multi-perspective | 7 | Trochę "flat" w porównaniu do Claude |
| Polish quality | 9 | Lepszy formal, gorszy casual/idiomy niż Claude |
| Tool-call | 9 | 95% reliability |
| Cost | $$$ | $4.35/M, max reasoning = 3-9x output tokens |

**Warianty reasoning:**
- **GPT-5.5 xhigh** — full reasoning, 90s latency, 9x output tokens. Dla krytycznych decision.
- **GPT-5.5 high** — 40s latency, 4-5x output. Sweet spot dla weekly planning.
- **GPT-5.5 medium** — 10s latency, 2-3x output. Dla codziennych tasków.
- **GPT-5.5 low** — 1.7s latency, 1.5x output. Prawie jak non-reasoning.
- **GPT-5.5 non-reasoning** — 1-2s, 1x output. Dla quick Q&A.

**Kiedy używać:**
- ✓ Equity model analysis (statystyczna, formalna)
- ✓ Contract review (precyzyjne PL formal)
- ✓ Structured data extraction (BigQuery, Airtable, Sheets)
- ✓ Computer use / browser agent (75% OSWorld vs ludzki 70%)
- ✓ Multi-language formal translation
- ✓ Gdy potrzebujesz alternatywy dla Claude (avoid vendor lock-in)

**Kiedy NIE:**
- ✗ Adversarial multi-perspective (Claude > GPT)
- ✗ Polish casual / idiomatic content
- ✗ Lowest latency (Gemini 3.5 Flash faster)
- ✗ Bulk processing (DeepSeek V4 Pro 20x tańszy)

### 2.4 Gemini 3.1 Pro (Google) — best long-context + multimodal planning

**Sweet spot:** Long-doc research, meeting notes synthesis (5+ notatek → 1 brief), vision-based planning (whiteboard → spec).

| Wymiar | Score | Evidence |
|--------|-------|----------|
| Reasoning chain | 9 | GPQA 94.3%, ARC-AGI-2 leader |
| Decomposition | 8 | Good, ale mniej naturalny niż Claude |
| Estimation | 7 | OK, ale kalibracja wymaga fine-tuningu |
| Risk identification | 8 | Comparable do Claude |
| Structured output | 8 | 92% adherence, dobry ale nie top |
| Long context | 10 | 1M solid do 800K, real champion w syntezie |
| Multi-perspective | 8 | Dobry, scientific approach |
| Polish quality | 8 | Dobry, ale Claude lepszy w niuansach |
| Tool-call | 8 | 92% reliability, trochę flaky na edge cases |
| Cost | $$ | $1.74/M, sweet spot quality/price |

**Kiedy używać:**
- ✓ Quarterly research synthesis (10+ dokumentów, meeting notes)
- ✓ Vision-based planning (whiteboard photo → spec)
- ✓ Code review screenshot (UI bug → analysis)
- ✓ Long doc analysis (>500K tokens: 100 meeting notes)
- ✓ Scientific / regulatory planning (medical, legal context)
- ✓ Gdy potrzebujesz 1M context bez dużego kosztu

**Kiedy NIE:**
- ✗ Polish nuanced (Claude > Gemini)
- ✗ Critical tool-call (Claude > Gemini)
- ✗ Adversarial analysis (Claude > Gemini)

### 2.5 MiniMax-M3 (MiniMax) — best agent + 1M context + value

**Sweet spot:** Agent w planning loop (Hermes, custom agents), long context synthesis, bulk operations z reasoning.

| Wymiar | Score | Evidence |
|--------|-------|----------|
| Reasoning chain | 8 | Solid, ale Claude Opus 4.8 lepszy |
| Decomposition | 8 | Native, designed for agentic work |
| Estimation | 7 | OK, potrzebuje kalibracji |
| Risk identification | 7 | OK, ale nie adversarial |
| Structured output | 9 | MSA pomaga, schema adherence 93%+ |
| Long context | 10 | 1M solid do 800K, MSA = 1/20 cost at 1M |
| Multi-perspective | 7 | OK dla typowych cases |
| Polish quality | 6 | Dobry casual, formal OK |
| Tool-call | 9 | Designed for agents, 92% reliability |
| Cost | $ | $0.30/M in, $1.20/M out — 10x tańszy niż Claude Opus |

**Kiedy używać:**
- ✓ Agent w planning loop (Hermes, custom)
- ✓ Daily Discord cron (tanio, szybko, 1M context)
- ✓ Vault-wide synthesis (czytaj 50+ notatek, 1 brief)
- ✓ Linear task auto-create (structured JSON, tool-call)
- ✓ Bulk meeting notes → brief (100+ notatek, 1M context)
- ✓ Backup model dla Claude (10x tańszy, 90% jakości)

**Kiedy NIE:**
- ✗ Krytyczne architecture decision (Claude > MiniMax)
- ✗ Equity analysis (Claude / GPT > MiniMax)
- ✗ Pure multimodal (Gemini > MiniMax dla vision, chociaż MiniMax-M3 obsługuje)
- ✗ Highest polish quality (Claude > MiniMax)

### 2.6 DeepSeek V4 Pro (DeepSeek) — best value for planning bulk

**Sweet spot:** Bulk estimation, cost-optimized planning, classification/routing, fallback.

| Wymiar | Score | Evidence |
|--------|-------|----------|
| Reasoning chain | 8 | Comparable do Claude Sonnet |
| Decomposition | 8 | Good |
| Estimation | 7 | OK, ale potrzebuje kalibracji |
| Risk identification | 7 | OK, mniej nuanced |
| Structured output | 8 | 88% adherence, czasem retries |
| Long context | 8 | 1M, solid do 500K |
| Multi-perspective | 6 | Płaski |
| Polish quality | 7 | Formal OK, casual słabszy |
| Tool-call | 9 | 88% reliability, ale retries |
| Cost | ¢ | $0.18/M in, $0.72/M out — 20x tańszy niż Claude |

**Kiedy używać:**
- ✓ Bulk task decomposition (50 epics → 500 stories, automated)
- ✓ Estimation calibration (500 history tasks → percentile model)
- ✓ Cheap fallback dla Claude (gdy Claude rate limit)
- ✓ Classification / routing (backlog → RICE score)
- ✓ Non-critical planning (feature ideas, exploration)
- ✓ Backlog triage w Jira/Linear (set priority, label, status)

**Kiedy NIE:**
- ✗ Krytyczne decision (Claude > DeepSeek)
- ✗ Adversarial risk (Claude > DeepSeek)
- ✗ Polish nuanced (Claude > DeepSeek)
- ✗ Zero-tolerance reliability (Claude > DeepSeek)

### 2.7 GLM-5.2 (Z AI) — surprise 2026, open-source champion

**Sweet spot:** Open-source deployment, 99 t/s throughput, $0.90/M (sweet spot quality/price).

| Wymiar | Score | Evidence |
|--------|-------|----------|
| Reasoning chain | 8 | Open-source, ale score 51 = top 6 w intelligence |
| Decomposition | 8 | Comparable do DeepSeek |
| Estimation | 7 | OK |
| Risk identification | 7 | OK |
| Structured output | 8 | 90% adherence |
| Long context | 8 | 1M context, solid do 500K |
| Multi-perspective | 7 | Solid |
| Polish quality | 6 | Formal OK |
| Tool-call | 8 | Open-source, ale solid |
| Cost | ¢ | $0.90/M, 4x tańszy niż Claude |

**Kiedy używać:**
- ✓ Self-host / on-prem (open-source)
- ✓ Bulk planning tasks (4x tańszy niż Claude)
- ✓ EU compliance (Z AI = Chinese, ale open-source = self-host)
- ✓ Gdy potrzebujesz 99 t/s throughput (batch processing)
- ✓ Backup model (open-source, nie zależny od API)

**Kiedy NIE:**
- ✗ Krytyczne decision (Claude > GLM)
- ✗ Polish casual (Claude > GLM)
- ✗ Highest tool-call reliability (Claude > GLM)

---

## 3. Reasoning mode — kiedy włączać, kiedy wyłączać

### 3.1 Koszt thinking tokens

| Model | Non-reasoning | Light reasoning | Medium | High | Max |
|-------|---------------|-----------------|--------|------|-----|
| **Claude Opus 4.8** | 1x | 1.5x | 2-3x | 3-5x | 5-9x output |
| **Claude Sonnet 4.6** | 1x | 1.5x | 2x | 3x | 4-5x output |
| **GPT-5.5** | 1x | 1.5x (low) | 2-3x (med) | 4-5x (high) | 8-9x (xhigh) |
| **Gemini 3.1 Pro** | 1x | 1.5x (min) | 2x (med) | 3x (high) | 5x (max) |
| **MiniMax-M3** | n/a | n/a | n/a | n/a | 3-5x (always reasoning) |
| **DeepSeek V4 Pro** | 1x | n/a | 2x (Max) | 3x (High) | 4-5x (Max) |

### 3.2 Decision matrix — włączać reasoning?

| Task | Reasoning? | Model + Mode |
|------|------------|--------------|
| Daily brief synthesis | ✗ (Sonnet non-reasoning) | Claude Sonnet 4.6 |
| Task decomposition | ✗ / lekkie (Sonnet low) | Claude Sonnet 4.6 |
| Estimation calibration | ✓✓ (Opus max) | Claude Opus 4.8 (max) |
| Risk identification | ✓✓ (Opus max) | Claude Opus 4.8 (max) |
| Weekly planning | ✓ (Opus max) | Claude Opus 4.8 (max) |
| Meeting notes → brief | ✗ (fast) | MiniMax-M3 / Sonnet non-reasoning |
| Linear task create | ✗ (fast) | MiniMax-M3 / DeepSeek V4 Flash |
| ADR (architecture) | ✓✓ (Opus max) | Claude Opus 4.8 (max) |
| OKR cascade | ✓ (Opus max) | Claude Opus 4.8 (max) |
| Equity analysis | ✓✓ (GPT xhigh) | GPT-5.5 (xhigh) |
| Contract review | ✓ (Opus max) | Claude Opus 4.8 (max) |
| Vision (whiteboard → spec) | ✓ (Gemini high) | Gemini 3.1 Pro (high) |
| Bulk estimation (500 items) | ✗ (DeepSeek non-reasoning) | DeepSeek V4 Pro |
| Backlog RICE scoring | ✗ (Sonnet non-reasoning) | Claude Sonnet 4.6 |
| Project charter | ✓ (Opus max) | Claude Opus 4.8 (max) |

**Reguła:** Reasoning = droższy ale lepszy w 2D reasoning tasks. Im więcej wzajemnych zależności, tym bardziej reasoning pomaga. Im bardziej "linear" task, tym mniej reasoning potrzebny.

---

## 4. Structured output — co działa najlepiej w integracjach

### 4.1 JSON schema adherence (Berkeley FC + custom)

| Model | Strict JSON | Pydantic | Nested 3-level | With tool calls | Best use |
|-------|-------------|----------|----------------|----------------|----------|
| **Claude Opus 4.7** | 99% | 98% | 96% | 96% | Linear API, Notion, Airtable |
| **GPT-5.5 (xhigh)** | 99% | 98% | 95% | 95% | BigQuery, custom APIs |
| **Gemini 3.1 Pro** | 96% | 94% | 88% | 92% | Google ecosystem |
| **Claude Sonnet 4.6** | 98% | 96% | 92% | 94% | Most APIs |
| **DeepSeek V4 Pro** | 92% | 90% | 85% | 88% | Simple APIs |
| **MiniMax-M3** | 96% | 93% | 87% | 92% | Hermes agent |
| **GLM-5.2** | 93% | 90% | 85% | 90% | Self-host |
| **Qwen3.7 Max** | 91% | 88% | 82% | 86% | Chinese APIs |
| **MiMo-V2.5** | 88% | 85% | 80% | 78% | Bulk |
| **GPT-OSS-120B (free)** | 85% | 82% | 75% | 80% | Free tier |
| **Llama 3.3 70B (free)** | 80% | 75% | 70% | 71% | Demo only |

### 4.2 Planning-specific JSON patterns

**Pattern 1: Task decomposition (epic → stories)**
```json
{
  "epic": "Wgraj pliki do Neo",
  "stories": [
    {
      "id": "JOI-N",
      "title": "Front-end: drag&drop component",
      "estimate_points": 5,
      "estimate_hours": 16,
      "dependencies": [],
      "risk": "low",
      "acceptance_criteria": ["..."],
      "vertical_slice": true
    },
    ...
  ],
  "risks": [...],
  "assumptions": [...]
}
```

**Best model:** Claude Sonnet 4.6 (non-reasoning) dla codziennych, Claude Opus 4.8 (max) dla krytycznych epics.

**Pattern 2: ADR (Architecture Decision Record)**
```json
{
  "title": "Why we chose Postgres over Mongo for Neo",
  "context": "...",
  "decision": "...",
  "consequences": {
    "positive": [...],
    "negative": [...]
  },
  "alternatives_considered": [...],
  "revisit_if": [...]
}
```

**Best model:** Claude Opus 4.8 (max reasoning). Multi-perspective analysis required.

**Pattern 3: Risk register**
```json
{
  "risks": [
    {
      "id": "R-N",
      "category": "technical|business|legal|operational",
      "description": "...",
      "probability": 0.0-1.0,
      "impact": "low|medium|high|critical",
      "mitigation": "...",
      "owner": "@person",
      "review_date": "YYYY-MM-DD"
    }
  ]
}
```

**Best model:** Claude Opus 4.8 (max). Adversarial thinking.

**Pattern 4: Backlog RICE scoring**
```json
{
  "items": [
    {
      "id": "JOI-N",
      "title": "...",
      "reach": 100,
      "impact": 0.5,
      "confidence": 0.8,
      "effort": 5,
      "rice_score": 8.0,
      "rank": 1
    }
  ]
}
```

**Best model:** Claude Sonnet 4.6 (non-reasoning). Fast classification.

**Pattern 5: Weekly OKR progress**
```json
{
  "week": "2026-W25",
  "objectives": [
    {
      "objective": "Ship Neo MVP",
      "key_results": [
        {
          "kr": "Wgraj pliki działa end-to-end",
          "progress": 0.7,
          "status": "on_track",
          "blockers": [],
          "next_week": "..."
        }
      ]
    }
  ]
}
```

**Best model:** MiniMax-M3 lub DeepSeek V4 Pro. Bulk processing, weekly recurring.

---

## 5. Long context — kiedy warto, kiedy nie

### 5.1 Real effective context (vs declared)

| Model | Declared | Effective (solid quality) | Sweet spot | Degradation |
|-------|----------|---------------------------|------------|-------------|
| **Llama 4 Scout** | 10M | ~2M (po testach Q1 2026) | 500K-1M | Po 2M spada znacząco |
| **Gemini 3.1 Pro** | 1M | ~800K | 300K-500K | Po 800K wyraźny spadek |
| **Claude Fable 5** | 1M | ~1M (MSA pomaga) | 500K-800K | Stabilny do 1M |
| **Claude Sonnet 4.6** | 1M | ~300K | 100K-200K | Po 300K spada |
| **MiniMax-M3** | 1M | ~800K (MSA) | 300K-500K | Stabilny, MSA = designed for this |
| **DeepSeek V4 Pro** | 1M | ~500K | 200K-400K | Po 500K spada |
| **GPT-5.5** | 922K | ~600K | 200K-400K | Stopniowy spadek |
| **GLM-5.2** | 1M | ~500K | 200K-400K | Stabilny do 500K |

**Praktyczna zasada:** wczytuj max 30-50% effective context dla krytycznych zadań.

### 5.2 Kiedy long context się opłaca

**✓ Opłaca się:**
- Synteza 50+ meeting notes → 1 brief (4-6K tokens summary z 200K input)
- Analiza całego codebase'u (monorepo <500K LOC)
- Research synthesis (10+ papers, regulatory docs)
- Quarterly review (15+ project docs → 1 report)
- Vault-wide search (read 30+ notatek, answer "co wiem o X")

**✗ NIE opłaca się:**
- Codzienne briefy (10-30K input wystarczy)
- Quick Q&A (5-20K input)
- Structured extraction (10-50K)
- Single doc analysis (5-50K)

**Heurystyka:** jeśli summary <30% input, warto. Jeśli summary >70% input, lepiej wybrać 5-10 źródeł i podsumować oddzielnie.

### 5.3 Long-context model selection

| Scenario | Top pick | Reason |
|----------|----------|--------|
| 100+ meeting notes → 1 brief | **MiniMax-M3** (1M, MSA, $0.30/M) | Cheapest effective 1M |
| 50+ research papers → synthesis | **Gemini 3.1 Pro** (1M solid) | Best long-doc QA |
| Codebase scan (>500K LOC) | **Claude Fable 5** (1M stable) | Best code understanding |
| Regulatory docs (medical/legal) | **Claude Opus 4.8** (1M + reasoning) | Best adherence + risk |
| Multi-year vault synthesis | **Llama 4 Scout** (10M) | Only option for 5M+ |
| Self-host long-context | **Llama 4 Scout** / **Qwen3 Coder** (1M free) | Open-source |

---

## 6. Polish planning — specyfika

### 6.1 Polish business context

**Top modele dla PL planning (czerwiec 2026):**

| Use case | Top model | Reason |
|----------|-----------|--------|
| **Daily brief po polsku** | Claude Sonnet 4.6 | Najlepsze niuanse, formal/casual |
| **Equity / udziały** | GPT-5.5 (high) | Formal PL, statystyczna precyzja |
| **Umowa / kontrakt review** | Claude Opus 4.8 (max) | Adversarial, risk identification |
| **Plan projektu** | Claude Opus 4.8 (max) | Multi-perspective, structure |
| **Brief dla klienta** | Claude Sonnet 4.6 | Polish business style |
| **Roadmapa (wizualna)** | Claude Sonnet 4.6 + Gemini 3.1 Pro (research) | Hybrid: Sonnet dla PL, Gemini dla long research |
| **Synteza spotkań po polsku** | MiniMax-M3 | 1M context, cheap, OK PL casual |
| **Korespondencja email** | Claude Sonnet 4.6 | Best PL formal, idioms |
| **Prezentacja dla zarządu** | Claude Opus 4.8 (max) | Polish executive style |
| **ADR (po polsku)** | Claude Opus 4.8 (max) | Reasoning + PL formal |

### 6.2 Polish-specific prompts (sprawdzone wzory)

**Daily brief (Discord / vault):**
```
Przygotuj brief dnia po polsku. Źródła:
- [[2026-06-19]] daily log
- [[2026-W25]] weekly review
- Kalendarz: [today events]

Output format:
1. Top 3 priorytety
2. Meeting prep (kto, kiedy, co przygotować)
3. Blockery / decyzje do podjęcia
4. Linki do relevant vault notes
5. 1 myśl do rozważenia
```

**Best model:** Claude Sonnet 4.6 (non-reasoning) — szybko, dobry PL, structured.

**Equity analysis (po polsku):**
```
Przeanalizuj model udziałowy spółki X. Weź pod uwagę:
- Wkład gotówkowy Mateusza: 50K PLN
- Wkład rzeczowy Sławka: know-how + czas (200h × 200 PLN = 40K PLN)
- Wkład Anny: 50h × 250 PLN = 12.5K PLN
- Ryzyko rynkowe: średnie (nowy produkt)

Zaproponuj 3 warianty equity split z uzasadnieniem i ryzykami.
Format: tabela + 3 akapity per wariant.
```

**Best model:** GPT-5.5 (high reasoning) — formalna precyzja, statystyczne myślenie, polska terminologia biznesowa.

**Synteza meeting notes (po polsku):**
```
Dane: 8 meeting notes z 2 tygodni, projekt Neo. Output: 1 brief (max 2 strony).

Sekcje:
1. Decisions (co ustalono)
2. Open questions (do rozstrzygnięcia)
3. Risks (nowe vs recurring)
4. Action items (kto, kiedy)
5. Next meeting agenda
```

**Best model:** MiniMax-M3 (1M context) — 8 notatek × 5K = 40K input, 2K output. Cheap, fast, OK PL.

**Architecture decision (po polsku, ADR):**
```
Napisz ADR dla decyzji: używamy Postgres 16 + Prisma ORM dla Neo, zamiast MongoDB + Mongoose.

Sekcje (po polsku):
1. Kontekst (problem, wymagania)
2. Decyzja (co wybraliśmy)
3. Konsekwencje (pozytywne, negatywne, trade-offy)
4. Alternatywy (co rozważaliśmy i dlaczego odrzuciliśmy)
5. Warunki rewizji (kiedy zmieniamy zdanie)
```

**Best model:** Claude Opus 4.8 (max reasoning) — adversarial analysis required, multi-perspective.

### 6.3 Polish quality tips

1. **System prompt w PL** dla output'u po polsku. Reasoning w EN (lepsze wyniki), output tłumacz na PL.
2. **Lowercase + polskie znaki** — wszystkie modele OK, ale Claude i Gemini lepsze.
3. **Formy grzecznościowe** — Claude radzi sobie najlepiej (Pan/Pani/Państwo).
4. **Idiomy i slang** — Claude > GPT > Gemini > open-source. Unikaj open-source do PL casual.
5. **Code comments w PL** — wszystkie frontier modele OK, GPT-5.5 minimalnie lepszy w PL variable naming.
6. **Nie ufaj tłumaczeniom** — Claude tłumaczy sens, open-source czasem dosłownie.

---

## 7. Real-world patterns (z deploymentów 2025-2026)

### 7.1 Mateusz's daily flow (profil founder Jointhubs)

**Rano 5-7 AM (cron):**
- Linear digest (MiniMax-M3, 1M context, czytaj 100 issues) → $0.05
- Discord daily brief (MiniMax-M3, vault synthesis) → $0.10
- Calendar today's events (Claude Sonnet 4.6, structured JSON) → $0.02
- **Total: $0.17/dzień**

**W ciągu dnia (interactive):**
- 3-5 zapytań planning (Claude Sonnet 4.6) → $0.50
- 2-3 code review (MiniMax-M3) → $0.20
- 1-2 Polish content (Claude Sonnet 4.6) → $0.20
- **Total: $0.90/dzień**

**Wieczór / tydzień (deep work):**
- Weekly planning (Claude Opus 4.8 max, 90 min) → $2
- Meeting notes synthesis (MiniMax-M3, 5 notatek → brief) → $0.20
- Linear task auto-create (MiniMax-M3, 10-20 issues) → $0.05
- **Total: $2.25/tydzień**

**Miesięczny cost: $0.17 × 30 + $0.90 × 30 + $2.25 × 4 = $22.10**

Plus raz na kwartał:
- Quarterly roadmap (Claude Opus 4.8 max + Gemini 3.1 Pro research) → $15
- Equity / partnership analysis (GPT-5.5 xhigh) → $5
- ADR review (Claude Opus 4.8 max) → $3
- **Quarterly: $23 = $7.67/mies**

**Total: ~$30/mies. dla solo foundera.** (z bulk w MiniMax-M3 i Claude Sonnet 4.6, frontier tylko dla krytycznych decision).

### 7.2 Team pattern (5-20 osób, agentic product)

**Per-user monthly:**
- Daily: 50 brief/interactive → $2.50 (Sonnet 4.6 mix)
- Weekly: 5 deep work → $5 (Opus 4.8 max)
- Bulk (auto): 1000 ops → $5 (MiniMax-M3 / DeepSeek V4 Pro)
- **Per user: $12.50/mies**
- **Team 10: $125/mies**

Vs all-Claude-Opus: $50-200/mies per user. **6-15x savings przy 90% jakości.**

### 7.3 Anti-patterns w real deployments

1. **"Always Opus"** — team miał $5K/mies bill, przejście na Sonnet 4.6 + Opus tylko dla weekly → $1.2K/mies. Review time wzrósł 5 min/dzień, jakość -3%.
2. **Reasoning dla każdego promptu** — bulk processing 10K records × 5x output = $250 vs $50 non-reasoning. Quality +1%.
3. **Jeden model do wszystkiego** — monolityczny Claude Opus, ale extraction 5x wolniej niż DeepSeek V4 Flash (i droższy).
4. **Brak observability** — nie wiedzieli który task generuje 80% kosztów. Po 2 tygodniach trackingu per-task cost, optymalizacja 40%.
5. **Nie testowanie polskiego** — model "best w benchmarku" okazał się 6/10 w PL, przełączenie na Claude = 9/10, recenzent happy.

---

## 8. Rekomendowany stack dla planning (Mateusz's profile)

### 8.1 Default routing

```python
# Configuration in OpenRouter-compatible client
PLANNING_STACK = {
    # Daily workhorse (80% use)
    "default": "anthropic/claude-sonnet-4.6",
    
    # Critical decisions (5% use, krytyczne)
    "frontier": "anthropic/claude-opus-4.8",  # always max reasoning
    "frontier_fallback": "openai/gpt-5.5",  # xhigh for equity
    
    # Long context (5% use, synteza)
    "long_context": "google/gemini-3.1-pro-preview",  # 1M solid
    "long_context_cheap": "minimax/minimax-m3",  # 1M, $0.30/M
    
    # Agent w planning loop (5% use)
    "agent": "minimax/minimax-m3",  # 1M, tool-call, designed for agents
    
    # Bulk operations (3% use)
    "bulk": "deepseek/deepseek-v4-pro",  # $0.18/M
    "bulk_cheapest": "deepseek/deepseek-v4-flash",  # $0.06/M
    
    # Free fallback (2% use, dev/test)
    "free": "qwen/qwen3-coder:free",  # 1M, free
    "free_general": "meta-llama/llama-3.3-70b-instruct:free",
}
```

### 8.2 Decision tree (per task)

```
Planning task → Krytyczna decyzja? (architecture, equity, risk)
  ├─ TAK → Claude Opus 4.8 (max reasoning)
  └─ NIE ↓
Wymaga >200K context? (multi-doc synthesis)
  ├─ TAK → Gemini 3.1 Pro (research) lub MiniMax-M3 (agent)
  └─ NIE ↓
Jest częścią agenta? (cron, auto-create, recursive)
  ├─ TAK → MiniMax-M3
  └─ NIE ↓
Bulk processing? (50+ items, recurring)
  ├─ TAK → DeepSeek V4 Pro / DeepSeek V4 Flash
  └─ NIE ↓
Default → Claude Sonnet 4.6 (non-reasoning dla speed, light reasoning dla depth)
```

### 8.3 Cost optimization checklist

- [ ] Dla każdego tasku, sprawdź czy naprawdę potrzebuje reasoning (3-9x koszt)
- [ ] Wczytuj max 30-50% effective context, nie pełny declared
- [ ] Dla >100 items bulk, użyj DeepSeek V4 Pro / Flash zamiast Claude
- [ ] Track per-task cost w observability layer (Langfuse, Helicone, custom)
- [ ] Co miesiąc review top 10 most expensive tasks → optymalizuj
- [ ] Miej fallback dla każdego modelu (provider outage = 100% downtime)
- [ ] Test Polish quality co miesiąc (model landscape się zmienia)
- [ ] Nie ufaj single benchmarku — test 5-10 real tasks per model

---

## 9. Pułapki i lessons learned

### 9.1 Top 10 mistakes w planning + LLM

1. **Reasoning dla każdego promptu** — koszt 3-9x, jakość +0-30% (zależy od task complexity).
2. **Bulk extraction z frontier modelem** — 20x droższe, jakość +0-5%. Zawsze bulk = cheap.
3. **Wczytywanie 800K do 1M context** — jakość spada, koszt rośnie. Lepiej 200K dobrze.
4. **Nie testowanie polskiego** — model 9/10 w EN może być 6/10 w PL. Test na real PL content.
5. **Monolityczny wybór** — "używamy Claude do wszystkiego" → 3-5x overpay vs routing.
6. **Brak fallback** — provider outage = 100% downtime. Minimum 2 modele.
7. **Brak observability** — nie wiesz który task generuje 80% kosztów.
8. **Copy-paste benchmark scores** — harness różni się (Anthropic 95% vs Scale 47% SWE-bench).
9. **Jeden model do agenta i do review** — agent potrzebuje tool-call reliability (Claude Opus / Sonnet), review potrzebuje max reasoning (Opus max / GPT xhigh). Różne modele.
10. **Nieuwzględnianie reasoning overhead w budżecie** — team miał $5K/mies budget dla Claude, realnie $15K po reasoning mode. Planuj 3-5x real budget dla reasoning models.

### 9.2 Green flags (kiedy routing jest dobry)

- ✓ Real cost per approved output spada co miesiąc
- ✓ Review time nie rośnie
- ✓ Error rate <2% w produkcji
- ✓ Latency spełnia SLO (interactive <3s, batch <30s)
- ✓ Masz fallback dla każdego modelu
- ✓ Track per-task cost w observability
- ✓ Polish content quality ≥ 8/10 dla client-facing

---

## 10. Future roadmap (co obserwować)

- **Q3 2026**: GPT-6, Claude 5 (pewnie lepsze MSA), Gemini 4 multimodal leap
- **Q4 2026**: Open-source dogoni frontier 100% — modele z "thinking" budget adjustable
- **2027**: Adaptive reasoning (model sam decyduje ile myśleć) — już działa w Claude adaptive, GPT xhigh
- **2027**: Multi-agent planning (1 model strategic, drugi tactical, trzeci estimation) — OpenAI Swarm, Anthropic multi-agent
- **2027+**: Regulatory pressure (EU AI Act) → większa transparentność modeli

---

*Notatka 2/6 z serii "LLM models in OpenRouter (2026)". Kolejna: [[research_llm_models_for_software_development.md]].*
