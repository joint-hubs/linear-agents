---
type: research-note
status: active
tags: [type/research, area/methodology, topic/llm, topic/ai, topic/software-development, topic/backend, topic/frontend, topic/devops, topic/programming-languages]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
related: [research_llm_models_openrouter_landscape.md, research_llm_models_for_planning.md, research_llm_models_for_code_review_testing.md, research_llm_models_for_ux_multimodal.md, research_llm_models_pricing_cost_optimization.md, research_software_delivery_review_best_practices.md, research_software_delivery_testing_best_practices.md]
---

# LLM models for software development — deep research

> Notatka 3/6 z serii o modelach LLM w OpenRouter. Ta odpowiada na
> pytanie: **który model najlepiej radzi sobie z software development —
> backend, frontend, DevOps, różne języki programowania, monorepo
> understanding, code generation, refactoring, debugging.**
>
> Kontekst: Mateusz używa LLM do: pisania kodu (Python, FastAPI, JS, TS,
> vanilla), code review w PRach, refactoring, debugging, DevOps
> (Terraform, GitHub Actions, Docker), scrapingu (Python + Playwright),
> full-stack web apps (FastAPI + vanilla JS + HTMX + Tailwind).
>
> Patrz też: [[research_software_delivery_review_best_practices.md]],
> [[research_software_delivery_testing_best_practices.md]].

---

## TL;DR

1. **Nie ma jednego "najlepszego modelu do kodowania".** Top coding modele 2026: **Claude Fable 5** (95% SWE-bench Verified, najwyższy score), **Claude Opus 4.8** (88.6% SWE-bench, best for code review i multi-file), **GPT-5.5** (top LiveCodeBench, computer use leader), **Kimi K2.7 Code** (78.2% SWE-bench za $0.27/M — best value coding-specialist), **MiniMax-M3** ($0.30/M, MSA 1M context, designed for code agents), **DeepSeek V4 Pro** ($0.18/M, decent coding).
2. **Backend vs Frontend vs DevOps — różne modele wygrywają.** Backend (Python, Go, Rust, Java): Claude Opus 4.8 > GPT-5.5 > DeepSeek V4 Pro. Frontend (TS, React, Vue, CSS, HTML): GPT-5.5 ≈ Claude Opus 4.8 > Gemini 3.5 Flash (multimodal). DevOps (Terraform, K8s, Docker, CI/CD): Claude Opus 4.8 > GPT-5.5 > DeepSeek V4 Pro. Full-stack: Claude Opus 4.8 / Sonnet 4.6 sweet spot.
3. **Język programowania ma znaczenie, ale mniejsze niż w 2024.** Frontier modele (Claude, GPT, Gemini) mają porównywalną jakość w Python, JS, TS, Java, Go, Rust, C++. Różnice: **Python** = top we wszystkich (najwięcej training data). **TypeScript** = GPT-5.5 minimalnie lepszy od Claude (type inference). **Rust** = Claude Opus 4.8 lepszy (borrow checker help). **Go** = porównywalne. **Legacy (PHP, Perl, COBOL)** = Gemini Flash 3.5 z long-context, bo mniej training data.
4. **Code agent (Cursor, Claude Code, Codex CLI, Aider) = inna klasa problemu.** Wymaga: tool-call reliability, multi-file awareness, context fit, long context. Top: **Claude Opus 4.7** (96% tool-call, designed for code agents), **Claude Sonnet 4.6** (94% tool-call, budget-friendly), **GPT-5.3 Codex** (78% SWE-bench + 95% tool-call), **Kimi K2.7 Code** (78.2% SWE-bench, 256K context, $0.27/M), **MiniMax-M3** (1M context MSA, $0.30/M, agentic-first).
5. **Scraping, ETL, data engineering (Python + Playwright, pandas, SQL):** Top to **DeepSeek V4 Pro** ($0.18/M, dobry Python, structured output 88%) + **Claude Sonnet 4.6** dla non-trivial logic. Do SQL generation: GPT-5.5 (xhigh) lepszy w complex joins.
6. **DevOps (Terraform, K8s YAML, GitHub Actions, Docker):** **Claude Opus 4.8** = top dla review, **DeepSeek V4 Pro** = best for generation (dużo powtarzalnych templates), **GPT-5.5** = best for K8s troubleshooting. HCL/YAML structured output: Claude > GPT > DeepSeek.
7. **Anti-pattern:** model frontier do "code completion" (szybkie uzupełnianie kodu w IDE). To powinno być local model (Qwen3 Coder 480B via Ollama, DeepSeek Coder V2 16B) albo fast API (Gemini 3.5 Flash $1.31/M). Frontier do "complete this function" = overpay 10-30x.

---

## 1. Anatomia software development — co model musi umieć

### 1.1 9 kompetencji developerskich

| Kompetencja | Co to znaczy | Benchmark | Top model 2026 |
|-------------|--------------|-----------|----------------|
| **1. Code generation** | "Napisz funkcję X" | LiveCodeBench, HumanEval, MBPP | Claude Fable 5, GPT-5.5, Claude Opus 4.8 |
| **2. Multi-file refactoring** | "Przenieś auth z A do B w 5 plikach" | SWE-bench Verified/Pro | Claude Opus 4.8, Claude Opus 4.7, GPT-5.3 Codex |
| **3. Code review** | "Sprawdź ten PR, złóż komentarze" | Custom (reviewer acceptance) | Claude Opus 4.8, Claude Sonnet 4.6 |
| **4. Debugging** | "Ten test failuje, dlaczego?" | SWE-bench, custom | Claude Opus 4.8, GPT-5.5 (xhigh) |
| **5. Test generation** | "Napisz unit testy dla tej klasy" | TestGen eval | Claude Sonnet 4.6, GPT-5.5, DeepSeek V4 Pro |
| **6. Documentation** | "Wygeneruj docstring / README / OpenAPI" | DocBench | Claude Sonnet 4.6 (best PL docs) |
| **7. Architecture decisions** | "MVC vs hexagonal, kiedy co" | Custom adversarial | Claude Opus 4.8 (max), GPT-5.5 (xhigh) |
| **8. Language-specific idioms** | "Pythonic / idiomatic Go / modern TS" | Custom (community feedback) | Claude Opus 4.8, GPT-5.5 |
| **9. DevOps (IaC, CI/CD, K8s)** | "Terraform dla AWS, GitHub Actions workflow" | Custom, AWS/GCP well-architected | Claude Opus 4.8, GPT-5.5, DeepSeek V4 Pro |

### 1.2 Typy SDLC tasks — model per typ

| Task type | Częstotliwość | Top model | Dlaczego | Koszt per task |
|-----------|---------------|-----------|----------|----------------|
| **Code completion (IDE)** | 50-200x/dzień | **Gemini 3.5 Flash** / **Qwen3 Coder** (local) | Fast, 100+ t/s, OK quality | $0.001-0.01 |
| **Function generation** | 10-30x/dzień | **Claude Sonnet 4.6** | Solid, non-reasoning, fast | $0.05-0.20 |
| **Multi-file refactor** | 1-3x/dzień | **Claude Opus 4.7** / **MiniMax-M3** | Tool-call, multi-file awareness | $0.50-2.00 |
| **Code review (PR)** | 5-15x/dzień | **Claude Sonnet 4.6** / **MiniMax-M3** | Fast, structured, good PL comments | $0.10-0.50 |
| **Debugging (non-trivial)** | 2-5x/dzień | **Claude Opus 4.8 (max)** | Reasoning dla root cause | $1-3 |
| **Test generation** | 5-10x/dzień | **DeepSeek V4 Pro** / **Claude Sonnet 4.6** | Bulk, structured, fast | $0.05-0.20 |
| **Documentation (README, docstring)** | 3-5x/tydzień | **Claude Sonnet 4.6** | Best PL docs, formal/casual | $0.10-0.30 |
| **Architecture decision** | 1-2x/tydzień | **Claude Opus 4.8 (max)** | Multi-perspective, long-term consequences | $2-5 |
| **Scrape / ETL script** | 2-5x/tydzień | **DeepSeek V4 Pro** | Python, structured, cheap | $0.05-0.20 |
| **Terraform / K8s YAML** | 2-5x/tydzień | **Claude Sonnet 4.6** / **DeepSeek V4 Pro** | Structured HCL/YAML, fast | $0.10-0.50 |
| **CI/CD pipeline** | 1-2x/tydzień | **Claude Opus 4.7** | Complex YAML, multi-step | $0.30-1.00 |
| **Legacy code (PHP, COBOL)** | rzadko | **Gemini 3.5 Flash** (1M context) | Long context, mniej training data | $0.50-2.00 |
| **Codebase scan (>500K LOC)** | 1-2x/miesiąc | **Llama 4 Scout** (10M) / **Claude Fable 5** (1M) | Only option for whole-monorepo | $2-10 |
| **Multi-language i18n** | 1-2x/miesiąc | **Claude Opus 4.8 (max)** | Best PL idioms, multi-language | $1-3 |

---

## 2. Backend — Python, Node, Go, Rust, Java

### 2.1 Python (najpopularniejszy, najlepiej wspierany)

| Framework | Top model | Dlaczego | Cena per 1K LOC |
|-----------|-----------|----------|-----------------|
| **FastAPI** | Claude Sonnet 4.6 / MiniMax-M3 | Pydantic, async, type hints — Claude lepszy w type inference | $0.50-1.50 |
| **Django** | Claude Opus 4.8 (max) | Complex ORM, signals, middleware — reasoning pomaga | $1-3 |
| **Flask** | Claude Sonnet 4.6 | Prosty, mało reasoning | $0.30-1.00 |
| **SQLAlchemy** | Claude Sonnet 4.6 / DeepSeek V4 Pro | Async, complex queries | $0.30-1.00 |
| **pandas / NumPy** | DeepSeek V4 Pro | Data wrangling, bulk processing | $0.10-0.50 |
| **Playwright (scraping)** | DeepSeek V4 Pro / Claude Sonnet 4.6 | Async, structured, fast | $0.20-0.80 |
| **LangChain / LangGraph** | Claude Opus 4.8 (max) | Complex agentic, requires reasoning | $1-4 |
| **Pydantic v2** | Claude Sonnet 4.6 | Type validation, schema generation | $0.20-0.50 |
| **pytest** | DeepSeek V4 Pro | Test generation, bulk | $0.10-0.30 |

**Python-specific tips:**
- **Type hints:** Claude > GPT > open-source. Type inference jest kluczowy w modern Python.
- **Async/await:** Claude Sonnet 4.6 = best. Open-source ma problemy z async reasoning.
- **Decorators / metaclasses:** Claude Opus 4.8 (max). Complex Python.
- **Pandas/NumPy vectorization:** DeepSeek V4 Pro. Szybko, tanio, wystarczająco.
- **Async scraping (Playwright):** DeepSeek V4 Pro / Claude Sonnet 4.6. Tanie, structured.

### 2.2 JavaScript / TypeScript

| Framework | Top model | Dlaczego | Cena per 1K LOC |
|-----------|-----------|----------|-----------------|
| **Vanilla JS + HTMX** | Claude Sonnet 4.6 | Prosty, fast | $0.20-0.60 |
| **React (Next.js)** | GPT-5.5 (high) | Type inference, hooks, complex state | $0.50-1.50 |
| **Vue 3** | Claude Sonnet 4.6 | Composition API, reactivity | $0.30-1.00 |
| **Svelte / SvelteKit** | Claude Opus 4.7 | Nowy, mniej training data | $0.50-1.50 |
| **TypeScript strict mode** | GPT-5.5 (xhigh) | Type inference jest kluczowy | $0.50-1.50 |
| **Node.js + Express** | Claude Sonnet 4.6 | Async, simple | $0.30-1.00 |
| **Node.js + Fastify** | Claude Sonnet 4.6 | Fast, structured | $0.30-1.00 |
| **NestJS** | Claude Opus 4.7 | Complex DI, decorators | $0.50-1.50 |
| **Webpack / Vite config** | DeepSeek V4 Pro | Bulk, repetitive | $0.10-0.30 |
| **Tailwind CSS** | Claude Sonnet 4.6 | Utility classes, design sense | $0.20-0.50 |
| **Storybook** | Claude Sonnet 4.6 / MiniMax-M3 | Component stories | $0.20-0.50 |

**JS/TS-specific tips:**
- **Type inference (TS):** GPT-5.5 (xhigh) > Claude > open-source. To jest differentiator.
- **Async/Promise:** Porównywalne we wszystkich frontier. Open-source ma problemy z edge cases.
- **React hooks:** GPT-5.5 i Claude porównywalne. Open-source czasem gubi dependency array.
- **Vue 3 reactivity:** Claude Sonnet 4.6 = best. Open-source ma problemy.
- **Modern features (top-level await, decorators):** Claude > GPT > open-source.
- **Legacy JS (ES5, callback hell):** Claude Opus 4.8 (max). Complex refactoring.

### 2.3 Go, Rust, Java, C++

| Język | Top model | Dlaczego | Uwagi |
|-------|-----------|----------|-------|
| **Go** | Claude Sonnet 4.6 / DeepSeek V4 Pro | Prosty język, mało reasoning | $0.20-0.80 |
| **Rust** | Claude Opus 4.8 (max) | Borrow checker, lifetimes — reasoning pomaga | $1-3 |
| **Java (Spring)** | Claude Opus 4.7 | Complex DI, generics | $0.50-1.50 |
| **C++** | Claude Opus 4.8 (max) | Memory management, templates | $1-4 |
| **C# (.NET)** | Claude Sonnet 4.6 / GPT-5.5 | LINQ, async/await | $0.30-1.00 |
| **Kotlin** | Claude Sonnet 4.6 | Coroutines, DSL | $0.30-1.00 |
| **Swift** | Claude Sonnet 4.6 | iOS-specific, ARC | $0.30-1.00 |

**Rust tip:** Claude Opus 4.8 (max) jest _wyraźnie_ lepszy od GPT-5.5 w Rust. Borrow checker help, lifetime annotations, async traits — Claude reasoning daje 30-50% lepsze wyniki.

**C++ tip:** Tylko frontier (Claude Opus 4.8 max, GPT-5.5 xhigh) radzi sobie z template metaprogramming. Open-source = katastrofa.

### 2.4 Legacy / niche languages

| Język | Top model | Dlaczego | Uwagi |
|-------|-----------|----------|-------|
| **PHP (Laravel, WordPress)** | Claude Sonnet 4.6 | Dużo training data | $0.30-0.80 |
| **Perl** | Gemini 3.5 Flash (1M context) | Mniej data, long context pomaga | $0.50-2.00 |
| **Ruby (Rails)** | Claude Sonnet 4.6 | Convention over configuration | $0.30-1.00 |
| **Elixir / Phoenix** | Claude Opus 4.7 | OTP, processes | $0.50-1.50 |
| **Clojure** | Claude Opus 4.8 (max) | Lisp syntax, complex | $1-3 |
| **Haskell** | Claude Opus 4.8 (max) | Pure FP, monads | $1-3 |
| **COBOL / Fortran** | Gemini 3.5 Flash (1M) | Very old, long context | $1-3 |
| **Bash / Shell** | DeepSeek V4 Pro | Simple, repetitive | $0.05-0.20 |
| **PowerShell** | Claude Sonnet 4.6 | Windows-specific | $0.20-0.50 |

---

## 3. Frontend — UI/UX implementation

### 3.1 Framework-tier comparison

| Framework | Top model 2026 | Score (1-10) | Best use case |
|-----------|----------------|--------------|---------------|
| **Vanilla JS + HTMX** | Claude Sonnet 4.6 | 9 | Edu apps, simple UX (Mateusz's profil) |
| **React + Next.js** | GPT-5.5 (high) / Claude Opus 4.8 | 9 | B2C, dashboards |
| **Vue 3 + Nuxt** | Claude Sonnet 4.6 | 9 | Mid-complexity apps |
| **Svelte / SvelteKit** | Claude Opus 4.7 | 7 | Nowy, mniej data |
| **Astro** | Claude Sonnet 4.6 | 8 | Static + islands |
| **Solid.js** | Claude Sonnet 4.6 | 7 | Fine-grained reactivity |
| **Qwik** | Claude Opus 4.7 | 6 | Resumability, nowy |

### 3.2 CSS / styling

| Task | Top model | Dlaczego |
|------|-----------|----------|
| **Tailwind CSS utility classes** | Claude Sonnet 4.6 | Design sense, fast iteration |
| **CSS Grid / Flexbox** | Claude Sonnet 4.6 | Solid, well-known |
| **CSS animations** | Claude Sonnet 4.6 / GPT-5.5 | Mid-complexity |
| **Responsive design** | Claude Sonnet 4.6 | Media queries, mobile-first |
| **Design system tokens** | Claude Opus 4.7 (max) | Multi-file, architecture |
| **SCSS / Less** | Claude Sonnet 4.6 | Prosty |
| **CSS-in-JS (styled-components)** | GPT-5.5 (high) | Type inference, complex types |
| **Component library (MUI, Chakra)** | Claude Sonnet 4.6 | API patterns, prop types |

### 3.3 Frontend-specific challenges

**1. Accessibility (WCAG 2.1/2.2):**
- Top: **Claude Opus 4.8 (max)** — adversarial review, edge cases
- Tip: explicit prompt "review for WCAG 2.2 AA compliance, list violations + fixes"
- Output: structured JSON with severity, location, fix

**2. Performance (Core Web Vitals):**
- Top: **Claude Sonnet 4.6** + **Lighthouse CI**
- Tip: prompt "review for LCP, FID, CLS issues, suggest fixes"
- Output: prioritized list with effort estimate

**3. Cross-browser compatibility:**
- Top: **Claude Sonnet 4.6** — well-trained on caniuse data
- Tip: explicit "support Chrome 90+, Safari 14+, Firefox 90+"

**4. Responsive design:**
- Top: **Claude Sonnet 4.6** — mobile-first thinking
- Tip: include "design for 320px, 768px, 1024px, 1440px breakpoints"

**5. Internationalization (i18n):**
- Top: **Claude Opus 4.8 (max)** + **GPT-5.5 (xhigh)**
- Tip: "extract all strings, generate i18n keys, handle pluralization, RTL support"

**6. Form validation:**
- Top: **DeepSeek V4 Pro** (simple) / **Claude Sonnet 4.6** (complex)
- Tip: use Zod / Yup / Pydantic schemas

**7. Animation / motion:**
- Top: **Claude Opus 4.7** — Framer Motion, GSAP, complex sequences
- Tip: explicit "respect prefers-reduced-motion"

---

## 4. DevOps — Infrastructure as Code, CI/CD, K8s

### 4.1 IaC (Terraform, Pulumi, CloudFormation)

| Tool | Top model | Dlaczego | Cena per 100 LOC |
|------|-----------|----------|------------------|
| **Terraform (HCL)** | Claude Sonnet 4.6 | Structured HCL, modules | $0.30-0.80 |
| **Pulumi (TypeScript)** | Claude Sonnet 4.6 / GPT-5.5 | TS-based, type inference | $0.30-1.00 |
| **CloudFormation (YAML)** | Claude Sonnet 4.6 | YAML, AWS-specific | $0.20-0.60 |
| **AWS CDK** | Claude Sonnet 4.6 | TypeScript, complex | $0.30-1.00 |
| **Ansible** | DeepSeek V4 Pro | YAML, repetitive | $0.10-0.30 |
| **Puppet / Chef** | Claude Sonnet 4.6 | Ruby-based | $0.20-0.50 |

**Terraform tip:** Claude Sonnet 4.6 = best dla review (well-architected framework). DeepSeek V4 Pro = best dla generation (bulk templates).

**Multi-cloud pattern (2026):**
- 87% DevOps jobs wymaga K8s (SwitchToDevOps 2026)
- Średnio 2.6 cloud providers (vs 1.9 w 2023)
- AI-driven drift detection = must-have (Claude + GitLab CI pattern)
- IaC reviews: Claude Opus 4.8 (max) — adversarial, security-focused

### 4.2 CI/CD (GitHub Actions, GitLab CI, Jenkins)

| Tool | Top model | Dlaczego |
|------|-----------|----------|
| **GitHub Actions (YAML)** | Claude Sonnet 4.6 | Best YAML, GitHub API |
| **GitLab CI** | Claude Sonnet 4.6 | YAML, GitLab API |
| **CircleCI** | Claude Sonnet 4.6 | YAML, orbs |
| **Jenkins (Groovy)** | Claude Opus 4.7 | Complex DSL, plugins |
| **Buildkite** | Claude Sonnet 4.6 | YAML, simple |
| **Drone CI** | DeepSeek V4 Pro | YAML, repetitive |
| **ArgoCD (GitOps)** | Claude Opus 4.7 | K8s manifests, complex |
| **Flux (GitOps)** | Claude Opus 4.7 | K8s, advanced |

**CI/CD tip:** Claude = best dla complex multi-step pipelines. DeepSeek V4 Pro = best dla repetitive single-job.

**Example: GitHub Actions workflow**
- Claude Sonnet 4.6: 90% quality, 1-2 retries, $0.20
- DeepSeek V4 Pro: 80% quality, 3-4 retries, $0.05
- Real cost: Claude $0.20 + 5 min review = $4.20; DeepSeek $0.05 + 15 min review = $12.55
- **Winner: Claude** dla non-trivial, DeepSeek dla simple

### 4.3 Kubernetes (YAML manifests, Helm, Operators)

| Task | Top model | Dlaczego | Cena |
|------|-----------|----------|------|
| **K8s YAML manifests** | Claude Sonnet 4.6 | Structured, well-known | $0.20-0.50 |
| **Helm charts** | Claude Opus 4.7 | Templating, values | $0.50-1.00 |
| **Kustomize** | Claude Sonnet 4.6 | Patches, overlays | $0.20-0.50 |
| **Operators (CRDs, controllers)** | Claude Opus 4.8 (max) | Complex, Go-based | $1-3 |
| **K8s troubleshooting** | GPT-5.5 (xhigh) | Diagnostic reasoning | $0.50-1.50 |
| **kubectl / k9s** | DeepSeek V4 Pro | Simple commands | $0.05-0.20 |
| **Cluster autoscaling** | Claude Opus 4.7 | Complex config | $0.50-1.50 |
| **Service mesh (Istio, Linkerd)** | Claude Opus 4.8 (max) | Complex, security | $1-3 |
| **Observability (Prometheus, Grafana)** | Claude Sonnet 4.6 | PromQL, dashboards | $0.30-0.80 |

**K8s tip:** Claude Opus 4.8 (max reasoning) jest wyraźnie lepszy w troubleshooting niż GPT-5.5. Rozumie implicit dependencies, suggest root cause.

### 4.4 Docker & containers

| Task | Top model | Dlaczego |
|------|-----------|----------|
| **Dockerfile** | DeepSeek V4 Pro / Claude Sonnet 4.6 | Repetitive, multi-stage |
| **docker-compose.yml** | Claude Sonnet 4.6 | Services, networks, volumes |
| **Multi-stage builds** | Claude Sonnet 4.6 | Optimization, layer caching |
| **Image security scanning** | Claude Opus 4.8 (max) | CVE, best practices |
| **Container orchestration** | Claude Opus 4.7 | K8s, Swarm, Nomad |
| **Registry management** | DeepSeek V4 Pro | Simple configs |

**Docker tip:** DeepSeek V4 Pro = 95% jakości Claude za 1/4 ceny dla typowych Dockerfile. Claude Sonnet 4.6 lepszy w multi-stage optimization.

### 4.5 Monitoring & observability

| Tool | Top model | Dlaczego |
|------|-----------|----------|
| **Prometheus (PromQL)** | Claude Sonnet 4.6 | Query language, well-known |
| **Grafana dashboards** | Claude Sonnet 4.6 | JSON/YAML, viz |
| **Datadog / New Relic config** | Claude Sonnet 4.6 | API patterns |
| **OpenTelemetry** | Claude Opus 4.7 | Complex, multi-language |
| **ELK stack** | Claude Sonnet 4.6 | Log queries, Kibana |
| **SLO/SLI definition** | Claude Opus 4.8 (max) | Business metrics, reasoning |
| **Incident postmortem** | Claude Opus 4.8 (max) | Adversarial analysis |
| **Alert tuning** | Claude Sonnet 4.6 | Reduce noise |

---

## 5. Code agent (Cursor, Claude Code, Codex CLI, Aider)

### 5.1 Co wyróżnia code agent

Code agent to LLM w executable harness (Cursor, Claude Code, Codex CLI, Aider, Cline, Continue). Wymaga:

1. **Tool-call reliability** — wywołuje Read/Write/Edit/Bash tools poprawnie
2. **Multi-file awareness** — rozumie zmiany w jednym pliku w kontekście całego repo
3. **Context fit** — codebase'y są duże, model musi umieć nawigować
4. **Long context** — min 100K, idealne 500K+ dla dużych repo
5. **Latency** — interactive coding wymaga <3s TTFT

### 5.2 Top code agents 2026

| Model | Tool-call (Berkeley FC) | SWE-bench V | Context | $ in/M | Best for |
|-------|------------------------|-------------|---------|--------|----------|
| **Claude Opus 4.7** | 96% | 82.0% | 1M | 3.85 | Production agent, complex |
| **Claude Sonnet 4.6** | 94% | (good) | 1M | 2.31 | Budget-friendly agent |
| **GPT-5.3 Codex** | 95% | 78.0% | 400K | 1.87 | Codex CLI, simple agent |
| **Kimi K2.7 Code** | (good) | 78.2% | 256K | 0.27 | Best value code agent |
| **MiniMax-M3** | 92% | 8/8 unit tests | 1M | 0.30 | MSA long-context, Hermes-like |
| **DeepSeek V4 Pro** | 88% | (decent) | 1M | 0.18 | Cheap agent, high tolerance for retries |
| **Gemini 3.5 Flash** | 92% | 78.8% | 1M | 1.31 | Fast, multimodal |
| **Qwen3 Coder** (free) | (mid) | (decent) | 1M | 0.00 | Experimentation only |
| **GLM-5.2** | 90% | (decent) | 1M | 0.90 | Open-source, fast |

### 5.3 Code agent routing strategy

**Wzorzec (Mateusz's profil):**

```python
# Tier 1: Default daily agent (80% use)
agent_default = "anthropic/claude-sonnet-4.6"  # $2.31/M, 94% tool-call, solid

# Tier 2: Complex agent task (15% use, multi-file refactor)
agent_complex = "anthropic/claude-opus-4.7"  # $3.85/M, 96% tool-call, 82% SWE-bench

# Tier 3: Cheap bulk agent (5% use, exploration, refactor pass)
agent_cheap = "minimax/minimax-m3"  # $0.30/M, 92% tool-call, 1M MSA context

# Fallback chain
fallback_chain = [
    "anthropic/claude-sonnet-4.6",
    "minimax/minimax-m3",
    "deepseek/deepseek-v4-pro"
]
```

**Kiedy co:**
- **Cursor tab completion (szybkie uzupełnianie):** Gemini 3.5 Flash (148 t/s, $1.31/M) lub local Qwen3 Coder
- **Cursor agent (multi-step):** Claude Sonnet 4.6
- **Claude Code (złożone zadania):** Claude Opus 4.7
- **Codex CLI (OpenAI ecosystem):** GPT-5.3 Codex
- **Aider (open-source, local):** DeepSeek V4 Pro (przez OpenRouter) lub local Qwen3
- **Hermes-style custom agent (Discord, cron):** MiniMax-M3 (1M MSA, $0.30/M)

### 5.4 Code agent pitfalls

1. **Latency variance** — Claude Opus 4.7 max reasoning = 17-126s. Nie nadaje się do interactive bez warmup.
2. **Context overflow** — wczytanie 800K do Sonnet 4.6 powoduje quality degradation. Lepiej użyj Claude Fable 5 (1M stable) lub MiniMax-M3 (MSA).
3. **Tool-call retries** — open-source 70-85% reliability vs proprietary 92-96%. Budget na retries.
4. **Cost compounding** — agent wywołuje 10-30 tool calls per task. Każdy call to 1K-50K tokens. Total cost: $0.50-5 per task.
5. **Hallucinated APIs** — modele czasem "wymyślają" funkcje, które nie istnieją. Zawsze test output.

---

## 6. Per-language specific recommendations

### 6.1 Python — best practices 2026

**Default stack:**
- **Code completion (IDE):** Qwen3 Coder (local) or Gemini 3.5 Flash (API)
- **Function generation:** Claude Sonnet 4.6
- **Multi-file refactor:** Claude Opus 4.7
- **Debugging:** Claude Opus 4.8 (max)
- **Test generation:** DeepSeek V4 Pro
- **Architecture:** Claude Opus 4.8 (max)

**Python-specific tools integration:**
- **Pydantic v2:** Claude Sonnet 4.6 — schema generation, validation
- **SQLAlchemy 2.0 async:** Claude Sonnet 4.6 — type hints, async patterns
- **FastAPI:** Claude Sonnet 4.6 — dependency injection, OpenAPI
- **pytest + fixtures:** DeepSeek V4 Pro — bulk, repetitive
- **pandas / NumPy:** DeepSeek V4 Pro — vectorization, data wrangling
- **LangChain / LangGraph:** Claude Opus 4.8 (max) — complex agentic
- **Playwright (scraping):** DeepSeek V4 Pro — async, structured

**Python anti-patterns:**
- ❌ Nieużywanie type hints (Claude je generuje, ale musi mieć sygnal)
- ❌ Mutable default arguments (model czasem generuje, review must catch)
- ❌ Bare `except:` (Claude Sonnet 4.6 łapie, open-source nie zawsze)
- ❌ f-strings w logging (lazy evaluation, security issue)

### 6.2 TypeScript / JavaScript — best practices 2026

**Default stack:**
- **Code completion (IDE):** Gemini 3.5 Flash or local Qwen3 Coder
- **Function generation:** GPT-5.5 (high) — type inference edge
- **Multi-file refactor:** Claude Opus 4.7
- **Debugging:** Claude Opus 4.8 (max)
- **Test generation (Jest, Vitest):** DeepSeek V4 Pro
- **Architecture:** Claude Opus 4.8 (max)

**TS-specific tips:**
- **strict mode:** GPT-5.5 (xhigh) — best type inference
- **Discriminated unions:** Claude Opus 4.7 — pattern matching
- **Generics:** GPT-5.5 (high) — type-level programming
- **Async/await:** Porównywalne
- **React hooks:** GPT-5.5 i Claude porównywalne
- **Node.js streams:** Claude Sonnet 4.6

**JS/TS anti-patterns:**
- ❌ `any` type (model czasem używa, review must catch)
- ❌ `==` zamiast `===` (Claude łapie, open-source nie)
- ❌ Mutacja props w React (Claude Sonnet 4.6 łapie)
- ❌ Memory leak z event listenerów (Claude Opus 4.7 reasoning)

### 6.3 Go — best practices 2026

**Default stack:**
- **Function generation:** Claude Sonnet 4.6
- **Concurrency (goroutines, channels):** Claude Opus 4.7
- **Error handling:** Claude Sonnet 4.6
- **Testing (table-driven):** DeepSeek V4 Pro
- **Architecture:** Claude Opus 4.8 (max)

**Go-specific tips:**
- **Idiomatic Go:** Claude Sonnet 4.6 = best. Accept interfaces, return structs.
- **Error wrapping (Go 1.13+):** Claude Sonnet 4.6 = excellent.
- **Generics (Go 1.18+):** Claude Opus 4.7. Complex.
- **Context propagation:** Claude Sonnet 4.6 = solid.
- **Testing patterns:** DeepSeek V4 Pro, table-driven tests.

**Go anti-patterns:**
- ❌ Ignoring errors (`_ = someFunc()`) — Claude łapie
- ❌ Goroutine leaks — Claude Opus 4.7 reasoning
- ❌ Missing `defer` for cleanup — Claude Sonnet 4.6 łapie

### 6.4 Rust — best practices 2026

**Default stack:**
- **Function generation:** Claude Opus 4.8 (max) — borrow checker
- **Lifetimes, traits:** Claude Opus 4.8 (max) — reasoning kluczowy
- **Async (Tokio):** Claude Opus 4.7
- **Testing:** DeepSeek V4 Pro
- **Architecture (unsafe blocks):** Claude Opus 4.8 (max) + manual review

**Rust-specific tips:**
- **Borrow checker help:** Claude Opus 4.8 (max) jest _wyraźnie_ lepszy od GPT-5.5
- **Lifetime annotations:** Claude Opus 4.8 (max) = best
- **Trait bounds:** Claude Opus 4.7
- **Macros:** Claude Opus 4.8 (max) + manual review
- **Unsafe blocks:** ZAWSZE manual review, model pomaga z `#[repr(C)]`, FFI bounds

**Rust anti-patterns:**
- ❌ Unnecessary `clone()` — Claude Sonnet 4.6 łapie, open-source nie
- ❌ `unwrap()` everywhere — Claude Sonnet 4.6 łapie
- ❌ Missing lifetime annotations — Claude Opus 4.8 (max) = essential
- ❌ Blocking async — Claude Opus 4.7 reasoning

### 6.5 SQL (PostgreSQL, MySQL, BigQuery)

**Default stack:**
- **Query generation:** Claude Sonnet 4.6 (readable SQL)
- **Complex joins, CTEs:** GPT-5.5 (xhigh) — statistical reasoning
- **Query optimization (EXPLAIN):** Claude Opus 4.8 (max)
- **Schema design:** Claude Opus 4.8 (max)
- **Migration scripts:** DeepSeek V4 Pro — repetitive

**SQL-specific tips:**
- **Window functions:** Claude Sonnet 4.6 = best
- **Recursive CTEs:** Claude Opus 4.7
- **JSONB operations:** Claude Sonnet 4.6 (Postgres)
- **Query hints (BigQuery, Snowflake):** Claude Opus 4.8 (max)
- **Index recommendations:** Claude Opus 4.8 (max) — EXPLAIN ANALYZE

**SQL anti-patterns:**
- ❌ `SELECT *` — Claude łapie
- ❌ Missing indexes on WHERE/JOIN — Claude Opus 4.8 (max) reasoning
- ❌ N+1 queries — Claude Sonnet 4.6 reasoning
- ❌ Implicit type casts — Claude Opus 4.7

---

## 7. Code review — model-specific (szczegóły w [[research_llm_models_for_code_review_testing.md]])

| Review type | Top model | Dlaczego |
|-------------|-----------|----------|
| **Style / lint (eslint, ruff)** | DeepSeek V4 Pro | Bulk, fast, 90% quality |
| **Bug detection** | Claude Opus 4.8 (max) | Adversarial, edge cases |
| **Security review** | Claude Opus 4.8 (max) | OWASP, threat modeling |
| **Performance review** | Claude Opus 4.8 (max) | Big-O, allocations, I/O |
| **Architecture review** | Claude Opus 4.8 (max) | Multi-perspective |
| **Test coverage review** | Claude Sonnet 4.6 | Coverage gaps, edge cases |
| **Documentation review** | Claude Sonnet 4.6 | Best PL docs, clarity |
| **i18n / a11y review** | Claude Opus 4.8 (max) | Multi-perspective |
| **Dependency audit (CVE)** | DeepSeek V4 Pro + manual | Bulk CVE check |
| **License compliance** | Claude Sonnet 4.6 | SPDX, copyleft detection |

**Tip:** W CI/CD pipeline użyj dwóch modeli:
1. **DeepSeek V4 Pro** do szybkiego first-pass (style, lint, obvious bugs)
2. **Claude Opus 4.8 (max)** do deep review (security, architecture, edge cases)

Total: $0.50 per PR, 95% quality.

---

## 8. Anti-patterns w SD + LLM

### 8.1 Top 10 mistakes

1. **Frontier do code completion (IDE)** — 10-30x overpay. Użyj fast model (Gemini Flash / Qwen3 Coder local).
2. **Reasoning dla każdego code promptu** — 3-9x koszt, jakość +0-20% (zależy od complexity).
3. **Jeden model do wszystkiego** — monolityczny Claude Opus, ale data wrangling 5x wolniej niż DeepSeek.
4. **Nie testowanie języka** — model excellent w Python może być słaby w Rust. Test per-language.
5. **Bulk test generation z frontier** — 20x droższe, jakość +0-5%. Zawsze bulk = cheap.
6. **Wczytywanie 800K do 1M context** — quality spada, koszt rośnie. Lepiej 200K dobrze.
7. **Brak fallback w code agent** — provider outage = 100% downtime agenta. Minimum 2 modele.
8. **Nie walidacja output (hallucinated APIs)** — model "wymyśla" funkcje, które nie istnieją. Zawsze test.
9. **Copy-paste benchmark scores** — SWE-bench harness różni się. Anthropic 95% vs Scale 47% na tym samym modelu.
10. **Poleganie na modelu do security review** — model łapie 60-80% issues, ale krytyczne 20-40% wymaga manual review + SAST/DAST tools.

### 8.2 Green flags (kiedy SD + LLM workflow jest dobry)

- ✓ Real cost per approved PR <$2
- ✓ Review time <15 min per PR
- ✓ Defect escape rate <5% (bugs które przeszły do produkcji)
- ✓ Latency interactive <3s, batch <30s
- ✓ Mature fallback chain (2-3 modele)
- ✓ Track per-task cost w observability
- ✓ Language-specific model selection (Rust ≠ Python ≠ JS)

---

## 9. Rekomendowany stack dla SD (Mateusz's profil)

### 9.1 Default routing

```python
SD_STACK = {
    # Code completion (IDE) - 60% use
    "completion": "google/gemini-3.5-flash",  # 148 t/s, $1.31/M
    
    # Function / class generation - 20% use
    "generation": "anthropic/claude-sonnet-4.6",  # $2.31/M, non-reasoning
    
    # Multi-file refactor / code agent - 10% use
    "agent": "anthropic/claude-opus-4.7",  # $3.85/M, 96% tool-call, 82% SWE-bench
    "agent_budget": "minimax/minimax-m3",  # $0.30/M, 92% tool-call, 1M MSA
    
    # Code review - 5% use
    "review_fast": "deepseek/deepseek-v4-pro",  # $0.18/M, first-pass
    "review_deep": "anthropic/claude-opus-4.8",  # $7.70/M blended, security + arch
    
    # Debugging - 2% use, krytyczne
    "debug": "anthropic/claude-opus-4.8",  # max reasoning
    
    # Test generation - bulk
    "test_gen": "deepseek/deepseek-v4-pro",  # $0.18/M, repetitive
    
    # Architecture decision - 1% use, krytyczne
    "architecture": "anthropic/claude-opus-4.8",  # max reasoning
    "architecture_alt": "openai/gpt-5.5",  # xhigh for stats reasoning
    
    # Free fallback - dev/test only
    "free": "qwen/qwen3-coder:free",  # 1M, free
    
    # DevOps / IaC
    "devops_gen": "deepseek/deepseek-v4-pro",  # $0.18/M, bulk
    "devops_review": "anthropic/claude-sonnet-4.6",  # well-architected
}
```

### 9.2 Decision tree (per task)

```
SD task → Code completion w IDE? (szybkie, powtarzalne)
  ├─ TAK → Gemini 3.5 Flash (lub Qwen3 Coder local)
  └─ NIE ↓
Krytyczny bug / security / arch?
  ├─ TAK → Claude Opus 4.8 (max reasoning)
  └─ NIE ↓
Multi-file refactor / code agent?
  ├─ TAK → Claude Opus 4.7 (production) lub MiniMax-M3 (budget)
  └─ NIE ↓
Bulk (test gen, scraping, ETL, Terraform templates)?
  ├─ TAK → DeepSeek V4 Pro ($0.18/M)
  └─ NIE ↓
Standard function generation / code review?
  └─ Claude Sonnet 4.6 (non-reasoning)
```

### 9.3 Cost optimization

- [ ] Code completion (60% volume) = fast model (Gemini Flash), nie frontier
- [ ] Test generation, Terraform templates, scraping = DeepSeek V4 Pro (20x tańszy)
- [ ] Function generation (20% volume) = Claude Sonnet 4.6 non-reasoning (1/3 ceny Opus)
- [ ] Multi-file refactor, code agent (10% volume) = Claude Opus 4.7 / MiniMax-M3
- [ ] Krytyczne (debug, security, arch, 2-5% volume) = Claude Opus 4.8 max / GPT-5.5 xhigh
- [ ] Track per-PR cost w observability
- [ ] Review w CI: 2-model pipeline (cheap first-pass + deep review)
- [ ] Test per-language co miesiąc (model landscape się zmienia)

---

## 10. Future trends (co obserwować)

- **Q3-Q4 2026**: agentic SWE agents (AutoCodeRover, OpenHands, SWE-Agent) coraz lepsze, 70%+ SWE-bench resolved autonomously
- **2026 H2**: computer use (Claude, GPT-5) lepsze, agent może sam klikać IDE, testować w browser
- **2027**: open-source dogoni frontier 100% w SD (Kimi K3, MiniMax-M4, DeepSeek V5)
- **2027**: modele treningowo fine-tunowane na code review (Anthropic, GitHub Copilot, Cursor custom)
- **2027+**: regulatory pressure (EU AI Act Art. 6) → wymóg "human-in-the-loop" dla krytycznych kodu (auth, payments, security)

---

*Notatka 3/6 z serii "LLM models in OpenRouter (2026)". Kolejna: [[research_llm_models_for_code_review_testing.md]].*
