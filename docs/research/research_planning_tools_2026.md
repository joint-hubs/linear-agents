---
type: research-note
status: active
tags: [type/research, area/methodology, topic/planning, topic/tools, topic/productivity, topic/software]
created: 2026-06-19
updated: 2026-06-19
source: deep-research
maturity: synthesis
companion_to: research_software_project_planning_best_practices.md
related: [research_software_project_planning_best_practices.md, research_estimation_techniques.md, research_roadmapping_patterns.md, research_software_delivery_review_best_practices.md]
---

# Narzędzia planistyczne 2026 — porównanie deep dive

> Trzecia z trzech notatek szczegółowych do
> [[research_software_project_planning_best_practices.md]]. Ta odpowiada na
> pytanie **"w czym to wszystko robić"** — od lekkich (Linear, Height, Trello)
> przez enterprise (Jira, Aha!) po specjalizowane (Productboard do discovery,
> Shape Up tools, GitHub Projects do delivery).
>
> Źródła: G2 Reviews 2024-2026, vendor docs (Linear, Jira, GitHub Projects,
> Productboard, Height, Aha!, Asana, Notion, ClickUp, Shortcut, Monday,
> ProductPlan), Atlassian State of Teams 2024-2025, GitHub Octoverse 2025,
> Stack Overflow Developer Survey 2024-2025, State of Product Management
> 2024-2025, Capterra category leaders.

---

## TL;DR

1. **Nie ma jednego narzędzia, które robi wszystko.** Discovery / roadmapping / sprint planning / reporting wymaga zwykle 2-3 narzędzi.
2. **Trzy kategorie:** (a) **engineering-first** (Linear, GitHub Projects, Shortcut) dla delivery, (b) **product-first** (Productboard, Aha!, ProductPlan) dla discovery + roadmap, (c) **collaboration-first** (Notion, ClickUp, Asana) dla mixu.
3. **Linear rośnie szybko w 2024-2026.** Przejmuje engineering-heavy zespoły z Jira. Powody: UX, cycles, performance, AI features (Linear Agents Q1 2026).
4. **GitHub Projects v2 jest underrated.** Dla zespołów blisko GitHub-a (issues + PRs + projects w jednym flow) — zero context switching.
5. **Jira dominuje enterprise, ale traci ground.** Atlassian inwestuje w Jira Product Discovery (2024) i Atlassian Intelligence (AI), ale UX pozostaje legacy.
6. **Productboard jest standardem dla B2B SaaS.** Customer feedback → prioritization → delivery flow jest najlepszy w klasie.
7. **Notion staje się platformą** (databases + docs + project tracking). Popularny w mniejszych zespołach i content-heavy.
8. **AI features 2025-2026:** Linear Agents, Atlassian Intelligence, Notion AI, Productboard Pulse. AI generuje sub-tasks, sugeruje assignees, auto-kategoryzuje feedback.
9. **Wybór zależy od skali i kontekstu.** Solo = Notion lub Trello. Startup eng-heavy = Linear. B2B SaaS = Productboard + Linear. Enterprise = Jira + Confluence + Productboard.
10. **Migracja jest kosztowna** (6-18 miesięcy). Lepiej wybrać dobrze raz niż migrować 3×.

---

## 1. Trzy kategorie narzędzi (archetypy)

### 1.1 Engineering-first (delivery-focused)

| Narzędzie | DNA | Najlepsze dla |
|-----------|-----|---------------|
| **Linear** | Velocity, cycles, opinionated flow | Eng-heavy teams, startup / scaleup |
| **GitHub Projects v2** | Issues + PRs + projects w GitHub | Open-source, GitHub-native teams |
| **Shortcut (Clubhouse)** | Stories + epics + iterations | Mid-size eng teams |
| **Jira** | Custom workflows, enterprise scale | Fortune 500, regulated industries |
| **Azure DevOps** | Microsoft stack, enterprise | Microsoft shops |
| **Pivotal Tracker** | Story-driven, kanban | Legacy, declining adoption |

**Mocne strony:** cycles, velocity, burndown, code integration, engineering metrics.
**Słabe strony:** słabe discovery, brak customer feedback, ograniczone roadmap visualization.

### 1.2 Product-first (discovery + roadmap)

| Narzędzie | DNA | Najlepsze dla |
|-----------|-----|---------------|
| **Productboard** | Customer feedback → prioritization | B2B SaaS, PLG |
| **Aha!** | Strategy → roadmap → delivery | Enterprise, multi-product |
| **ProductPlan** | Visual roadmaps, portfolio | Stakeholder communication |
| **Roadmunk** | Portfolio + timeline | Multi-team portfolio |
| **Pendo** | Product analytics + prioritization | Data-driven product teams |
| **airfocus** | Modular prioritization | Custom workflows |

**Mocne strony:** customer insights, prioritization frameworks (RICE/ICE), stakeholder visualization.
**Słabe strony:** delivery jest drugorzędny, zwykle integracja z Jira/Linear potrzebna.

### 1.3 Collaboration-first (general purpose)

| Narzędzie | DNA | Najlepsze dla |
|-----------|-----|---------------|
| **Notion** | Docs + databases + projects | Flexible teams, content-heavy |
| **Asana** | Multi-team, portfolio view | Marketing + ops mix |
| **ClickUp** | "Wszystko w jednym", customizable | Teams wanting one tool |
| **Monday** | Visual, board-first | SMB, non-tech |
| **Trello** | Simple kanban | Personal / small teams |
| **Height** | Spreadsheet + database hybrid | Ops-heavy, custom workflows |

**Mocne strony:** flexibility, multi-use, integrations.
**Słabe strony:** brak opinionated flow, wymaga samodyscypliny.

### 1.4 Specializowane

| Narzędzie | Specjalizacja |
|-----------|---------------|
| **Shape Up tool (Linear, Hive)** | Cycle-based, no estimation |
| **Pivotal Tracker** | Story-driven (legacy) |
| **Azure Boards** | Microsoft ecosystem |
| **Shortcut** | Engineering + planning hybrid |
| **Fibery** | Custom workflows + relations |
| **Dovetail** | Research repository + insights |
| **Maze** | User research + testing |
| **Condens** | User research repository |

---

## 2. Porównanie szczegółowe (top 9 narzędzi 2026)

### 2.1 Linear

**DNA:** velocity-first, opinionated, opinionated UI, AI-first (Linear Agents Q1 2026).

**Pricing 2026:** Free (do 10 users), Standard $8/user/month, Plus $14/user/month.

**Mocne strony:**
- **UX.** Najszybsze narzędzie PM w 2024-2026. Keyboard-driven.
- **Cycles.** Domyślne 2-tygodniowe, opinionated.
- **Initiatives (2025+).** Outcome-based grouping, teraz z roadmap view.
- **Linear Agents (Q1 2026).** AI do triage, sub-task generation, status updates.
- **Triage.** Inbox do zarządzania incoming feedback.
- **API + integrations.** Slack, GitHub, Figma, Notion, Productboard.

**Słabe strony:**
- **Brak pełnego Gantta** (choć timeline view w 2025+).
- **Discovery.** Mimo Initiatives, customer feedback jest słaby vs Productboard.
- **Reporting.** Podstawowy (vs Aha! czy Jira Align).
- **Cena.** Plus tier droższy niż Notion/Asana.

**Kiedy wybrać:**
- Eng-heavy team, 3-50 osób.
- Startup / scaleup.
- GitHub-native (integracja first-class).
- Zespół ceni szybkość > comprehensive reporting.

**Kiedy NIE wybrać:**
- Potrzebujesz customer feedback layer (lepiej Productboard).
- Enterprise z 500+ users (lepiej Jira).
- Stakeholderzy wymagają Gantta z datami (lepiej ProductPlan/Roadmunk).

**Jointhubs aktualnie używa:** Linear (główna platforma engineering task tracking, cycles 2 tyg., projekty per initiative).

### 2.2 Jira + Atlassian ecosystem

**DNA:** enterprise-first, custom workflows, ecosystem lock-in.

**Pricing 2026:** Free (do 10 users), Standard $7.50/user/month, Premium $13.50/user/month, Enterprise custom.

**Mocne strony:**
- **Skalowalność.** 100,000+ users bez problemu.
- **Workflows.** Dowolna customizacja.
- **Integracje.** 1000+ apps w Atlassian Marketplace.
- **Compliance.** SOC2, HIPAA, FedRAMP (Enterprise tier).
- **Atlassian Intelligence (2024+).** AI features: auto-summarize, suggest assignee, generate AC.
- **Jira Product Discovery (2024).** Nowy moduł do customer feedback i prioritization.

**Słabe strony:**
- **UX.** Legacy, steep learning curve.
- **Velocity.** Wolniejsze niż Linear (duże instancje 5-10s load).
- **Setup overhead.** Wymaga admina Jira.
- **Cena.** Drastycznie rośnie z user count i tier.

**Kiedy wybrać:**
- Enterprise (500+ users).
- Regulated industries (compliance).
- Custom workflows (np. regulatory review process).
- Już w Atlassian ecosystem (Confluence, Bitbucket).

**Kiedy NIE wybrać:**
- Startup < 50 (overhead nie warto).
- Zespoły eng-heavy, które cenią UX (Linear > Jira).

### 2.3 GitHub Projects v2

**DNA:** GitHub-native, issues + PRs + projects, lightweight.

**Pricing 2026:** Free for public repos, included w GitHub Free/Team/Enterprise.

**Mocne strony:**
- **GitHub native.** Issues, PRs, projects w jednym flow.
- **Zero context switching.** Dev nie musi opuszczać GitHub.
- **Custom fields.** Dobra flexibility (2024+).
- **Insights.** Built-in charts (burndown, velocity).
- **Cena.** Free lub minimal cost (w ramach GitHub plan).

**Słabe strony:**
- **Brak customer feedback.** Tylko engineering issues.
- **Brak cycles / sprint.** Trzeba customizować.
- **Roadmap view.** Słaby w porównaniu do Productboard.
- **Adoption.** Niższy niż Linear w eng-first teams (2024 G2 reviews).

**Kiedy wybrać:**
- Open-source / public repos.
- GitHub-native team (issues + PRs jako source of truth).
- Mały zespół (do 30 osób).
- Niski budżet.

**Kiedy NIE wybrać:**
- Potrzebujesz customer feedback / discovery.
- Duży zespół z custom workflows.

### 2.4 Productboard

**DNA:** customer-driven prioritization, B2B SaaS standard.

**Pricing 2026:** Starter $20/user/month, Pro $52/user/month, Enterprise custom.

**Mocne strony:**
- **Customer feedback portal.** Userzy mogą submitować feedback.
- **Insights engine.** Auto-kategoryzacja feedback (AI 2024+).
- **Prioritization matrix.** Wbudowane RICE, ICE, custom frameworks.
- **Roadmap visualization.** Stakeholder-friendly.
- **Productboard Pulse (2025).** AI generuje insights z customer data.
- **Integrations.** Linear, Jira, Intercom, Salesforce, Zendesk, Slack.

**Słabe strony:**
- **Delivery.** Słaby — potrzebuje integracji z Linear/Jira.
- **Cena.** Droższy niż Linear/Notion.
- **UX.** Dobry ale mniej szybki niż Linear.

**Kiedy wybrać:**
- B2B SaaS z customer feedback.
- Discovery-heavy product discovery.
- Stakeholderzy wymagają outcome-based roadmap.
- Team 10-100 osób.

**Kiedy NIE wybrać:**
- Internal tools / no customer feedback.
- Solo founder (overkill).
- Niski budżet (Linear/Notion tańsze).

### 2.5 Height

**DNA:** spreadsheet + database hybrid, custom workflows.

**Pricing 2026:** Free (do 10 users), Team $8.50/user/month, Business $16/user/month.

**Mocne strony:**
- **Spreadsheet UX.** Familiar for many users.
- **Custom workflows.** Highly flexible.
- **Real-time collaboration.** Spreadsheet-style.
- **API.** Dobre dla automations.
- **Cena.** Konkurencyjna.

**Słabe strony:**
- **Mniejszy ecosystem** niż Linear/Jira.
- **AI features.** Późno wchodzi (2025+).
- **Adoption.** Niszowy (ale rośnie w 2024-2026).

**Kiedy wybrać:**
- Ops-heavy teams z custom workflows.
- Teams które kochają spreadsheets.
- Custom data structures.

### 2.6 Aha!

**DNA:** strategy → roadmap → delivery, enterprise.

**Pricing 2026:** Aha! Roadmaps $59/user/month, Aha! Suite custom.

**Mocne strony:**
- **Strategy cascades.** Mission → strategy → roadmap → delivery.
- **Multi-product.** Portfolio view.
- **Custom frameworks.** RICE, ICE, weighted scoring.
- **Compliance.** SOC2, GDPR, HIPAA.

**Słabe strony:**
- **Cena.** Najdroższy z tier 1.
- **Setup overhead.** Ciężki dla małych zespołów.
- **UX.** Mniej intuicyjny niż Linear.

**Kiedy wybrać:**
- Enterprise z 100+ people.
- Multi-product portfolio.
- Regulated industry.

### 2.7 Notion

**DNA:** docs + databases + projects, flexible.

**Pricing 2026:** Free (do 10 users), Plus $10/user/month, Business $15/user/month.

**Mocne strony:**
- **Flexibility.** Może być wszystkim (wiki, CRM, PM tool).
- **Databases.** Powerful + customizable.
- **Docs.** First-class (vs Jira / Linear).
- **Notion AI (2024+).** Auto-summary, Q&A, generate content.
- **Cena.** Competitive.

**Słabe strony:**
- **PM-specific features.** Słabe (vs Linear).
- **Performance.** Wolniejszy przy dużych bazach (>1000 items).
- **Workflows.** Mniej opinionated (flexibility = discipline needed).

**Kiedy wybrać:**
- Docs-first teams.
- Content-heavy workflows.
- Mały team (< 30 osób).
- Custom workflows.

**Kiedy NIE wybrać:**
- Engineering-heavy (> 30 devów) — Linear lepszy.
- Potrzebujesz customer feedback — Productboard lepszy.

### 2.8 Asana

**DNA:** multi-team, portfolio view, marketing + ops mix.

**Pricing 2026:** Personal free, Starter $10.99/user/month, Advanced $24.99/user/month.

**Mocne strony:**
- **Portfolio view.** Multi-project visualization.
- **Forms.** External intake.
- **Goals (OKR-like).** Built-in.
- **Workflow builder.** Custom automations.

**Słabe strony:**
- **Engineering-specific features.** Słabe.
- **Reporting.** Ograniczone.

**Kiedy wybrać:**
- Marketing + ops mix.
- Multi-team portfolio.
- OKR-driven organization.

### 2.9 Shortcut (Clubhouse)

**DNA:** engineering + planning hybrid, mid-market.

**Pricing 2026:** Starter $8.50/user/month, Business $16/user/month.

**Mocne strony:**
- **Stories + epics + iterations.** Engineering-native.
- **Workflows.** Custom.
- **Custom fields.** Flexible.
- **API.** Dobre dla automations.

**Słabe strony:**
- **Market share.** Mniejszy niż Linear/Jira.
- **AI features.** Późno wchodzi.

**Kiedy wybrać:**
- Mid-size eng teams (30-100).
- Custom workflows.
- Alternatywa dla Jira z lepszym UX.

---

## 3. Macierz wyboru (decision tree)

### 3.1 Decision tree (flow)

```
START
  │
  ├─ Masz 1-5 osób, brak customerów?
  │   ├─ TAK → Notion (free) lub Trello
  │   └─ NIE ↓
  │
  ├─ Masz GitHub jako source of truth?
  │   ├─ TAK → GitHub Projects v2
  │   └─ NIE ↓
  │
  ├─ Zespół eng-heavy (50%+ developerów)?
  │   ├─ TAK ↓
  │   │   ├─ < 50 osób → Linear
  │   │   ├─ 50-200 osób → Linear lub Shortcut
  │   │   └─ 200+ osób → Jira
  │   └─ NIE ↓
  │
  ├─ Masz aktywny customer feedback loop?
  │   ├─ TAK ↓
  │   │   ├─ B2B SaaS → Productboard + Linear/Jira
  │   │   ├─ B2C → Productboard lub custom (Dovetail + Linear)
  │   │   └─ Enterprise → Productboard + Jira
  │   └─ NIE ↓
  │
  ├─ Stakeholderzy wymagają Gantta z datami?
  │   ├─ TAK → ProductPlan lub Roadmunk + Jira/Linear
  │   └─ NIE ↓
  │
  ├─ Multi-product portfolio?
  │   ├─ TAK → Aha! lub Linear Initiatives
  │   └─ NIE → Linear lub Notion
```

### 3.2 Macierz skali

| Skala | Zespół | Rekomendacja |
|-------|--------|--------------|
| **Solo** | 1 | Notion lub Trello (free) |
| **Startup** | 2-10 | Notion (do 5) → Linear (6+) |
| **Scaleup** | 10-50 | Linear + Productboard (opcja) |
| **Mid-market** | 50-200 | Linear + Productboard + Notion (docs) |
| **Enterprise** | 200+ | Jira + Productboard + Confluence + Notion |

---

## 4. AI features 2025-2026 (przegląd)

### 4.1 Co AI dziś robi w narzędziach PM

| Funkcja | Linear | Jira | Notion | Productboard |
|---------|--------|------|--------|--------------|
| **Auto-triage** | ✅ (Agents) | ✅ (Intelligence) | ❌ | ⚠️ (Insights) |
| **Sub-task generation** | ✅ (Agents) | ⚠️ (beta) | ❌ | ❌ |
| **Suggest assignee** | ✅ (Agents) | ✅ (Intelligence) | ❌ | ❌ |
| **Auto-summarize** | ✅ | ✅ | ✅ (AI) | ✅ (Pulse) |
| **Customer feedback categorization** | ❌ | ⚠️ (Discovery) | ❌ | ✅ (Pulse) |
| **Priority suggestion** | ⚠️ (experimental) | ❌ | ❌ | ✅ |
| **Generate AC** | ⚠️ (experimental) | ✅ (beta) | ✅ | ❌ |
| **Risk detection** | ⚠️ | ✅ (beta) | ❌ | ⚠️ |

### 4.2 Linear Agents (Q1 2026) — najbardziej zaawansowane

**Co robią:**
- Triage incoming feedback → suggest labels, project, assignee.
- Generują sub-tasks z parent task (np. "design + backend + frontend").
- Auto-update status gdy PR zmergowane.
- Suggest next actions w weekly planning.
- Draft weekly digest (co udało się zamknąć).

**Dlaczego to jest game-changer:**
- Redukuje PM admin overhead 30-50% (Linear blog Q1 2026).
- Lepsze dane dla ML (więcej feedback → lepsze sugestie).

### 4.3 Atlassian Intelligence (Jira 2024+)

**Co robi:**
- Auto-summarize issues, comments.
- Suggest assignee na bazie history.
- Generate AC z opisu.
- Q&A w Confluence ("co ustaliliśmy o X?").

**Dlaczego warto:**
- Już w ekosystemie Atlassian (zero setup).
- Compliance-ready (Enterprise tier).

### 4.4 Productboard Pulse (2025+)

**Co robi:**
- Auto-kategoryzacja feedback z wielu źródeł.
- Insights: "co jest najczęściej proszone przez enterprise customers?".
- Suggest prioritization oparty na impact.

**Dlaczego warto:**
- Customer-driven prioritization z automatyzacją.

---

## 5. Integracje — narzędzia w ekosystemie

### 5.1 Linear integrations (2026)

| Integracja | Co robi |
|------------|---------|
| **GitHub** | Auto-link PRs, auto-move status on merge |
| **Slack** | Notifications, create issues from messages |
| **Figma** | Embed designs w issues |
| **Notion** | Link PRDs do issues, sync status |
| **Productboard** | Sync feedback → issues |
| **Zapier** | Custom automations |
| **API** | Full custom integrations |

### 5.2 Jira integrations (2026)

| Integracja | Co robi |
|------------|---------|
| **Confluence** | Link docs, embedded roadmaps |
| **Bitbucket** | Git integration |
| **Slack** | Notifications, create issues |
| **Productboard** | Sync prioritization |
| **Loom** | Video updates na issues |
| **Tempo** | Time tracking, planning |
| **ScriptRunner** | Custom workflows (groovy) |

### 5.3 Asana integrations (2026)

| Integracja | Co robi |
|------------|---------|
| **Slack** | Notifications |
| **Google Drive** | Attach files |
| **Zoom** | Meeting notes |
| **Figma** | Designs |
| **Loom** | Video |

### 5.4 Custom integrations via API

- **Linear API.** Pełne GraphQL, doskonałe dla custom workflow.
- **Jira API.** REST, dobrze udokumentowane.
- **Notion API.** Database-centric, REST.
- **Asana API.** REST, solid.

---

## 6. Migracja między narzędziami

### 6.1 Typowe ścieżki migracji

```
Jira → Linear: popularna w 2024-2026 (eng teams)
Jira → Shortcut: enterprise z custom workflows
Linear → Jira: rzadko (raczej scale up)
Notion → Linear: gdy zaczyna się prawdziwy development
Trello → Asana / Linear: gdy team rośnie
Asana → Jira: enterprise adoption
```

### 6.2 Koszt migracji

| Skala zespołu | Czas migracji | Koszt (przybliżony) |
|----------------|---------------|---------------------|
| 5-20 osób | 2-6 tygodni | 20-50 godzin |
| 20-100 osób | 2-6 miesięcy | 200-1000 godzin |
| 100-500 osób | 6-18 miesięcy | 1000-10000 godzin |

**Koszty ukryte:**
- Utrata kontekstu (stare issues, decisions).
- Re-training.
- Workflow rebuild.
- Integrations rebuild.

### 6.3 Kiedy migrować, kiedy nie

**Migruj, jeśli:**
- Obecne narzędzie aktywnie spowalnia zespół (velocity < 50% time na development).
- Stack się zmienił (np. Jira → Linear bo GitHub-native).
- Skala przekroczyła sweet spot obecnego narzędzia.

**NIE migruj, jeśli:**
- "Sąsiad używa X" (FOMO nie jest powód).
- Po roku użytkowania (za późno, koszt > korzyść).
- Nie masz 6 miesięcy na pełną migrację.

---

## 7. Nowe trendy 2025-2026

### 7.1 AI-native PM tools

- **Linear Agents** — AI-first, w centrum workflow.
- **Atlassian Intelligence** — embedded AI w Jira + Confluence.
- **Notion AI** — Q&A + generation.
- **Productboard Pulse** — customer insights z AI.

### 7.2 Outcome-based tooling

- **Linear Initiatives** (2025+) — outcome grouping.
- **Productboard prioritization matrix** — built-in frameworks.
- **Aha! strategy cascades** — alignment from strategy to delivery.

### 7.3 Spreadsheet revival

- **Height** — spreadsheet + database hybrid.
- **Notion databases** — spreadsheet-feel + flexibility.
- **Airtable** — no-code + workflow (alternatywa).

### 7.4 Remote / async tooling

- **Loom** — async video updates.
- **Linear async cycles** — bez daily standups.
- **Notion docs** — wiki-first knowledge management.
- **Slack threads** — replaced many meetings.

### 7.5 Tool consolidation

Wiele zespołów w 2026 używa **2-3 narzędzi** (zamiast 5+):
- Linear + Notion + Loom (eng-heavy startup)
- Productboard + Linear + Slack (B2B SaaS)
- Jira + Confluence + Productboard (enterprise)

**Anty-pattern:** "Jeden tool, który robi wszystko" (ClickUp, Asana) — bywa OK dla małych, ale dla > 50 osób customizacja się psuje.

---

## 8. Koszt narzędzi (2026, dla 20-osobowego zespołu)

### 8.1 Porównanie roczne (Standard tier)

| Narzędzie | Plan | Cena/user/mies | Rocznie (20 osób) |
|-----------|------|----------------|-------------------|
| **Linear** | Plus | $14 | $3,360 |
| **Jira** | Premium | $13.50 | $3,240 |
| **GitHub Projects** | Team | $4 | $960 |
| **Productboard** | Pro | $52 | $12,480 |
| **Height** | Team | $8.50 | $2,040 |
| **Aha!** | Roadmaps | $59 | $14,160 |
| **Notion** | Plus | $10 | $2,400 |
| **Asana** | Advanced | $24.99 | $5,997 |
| **Shortcut** | Business | $16 | $3,840 |
| **ClickUp** | Business | $12 | $2,880 |
| **Monday** | Pro | $16 | $3,840 |
| **Trello** | Standard | $5 | $1,200 |

### 8.2 Total cost of ownership (TCO)

TCO = licencja + setup + admin + migracja + integracje + szkolenie.

| Narzędzie | TCO multiplier (vs licencja) |
|-----------|------------------------------|
| **Linear** | 1.2-1.5x |
| **Jira** | 2.5-4x (admin overhead) |
| **GitHub Projects** | 1.0-1.2x |
| **Productboard** | 1.3-1.8x |
| **Notion** | 1.0-1.2x |
| **Asana** | 1.3-1.5x |

**Wniosek:** Jira jest najdroższy w TCO mimo podobnej licencji. Linear ma najlepszy stosunek TCO/licencja.

---

## 9. Security i compliance

### 9.1 Certyfikaty (2026)

| Narzędzie | SOC2 | GDPR | HIPAA | FedRAMP | ISO 27001 |
|-----------|------|------|-------|---------|-----------|
| **Linear** | ✅ | ✅ | ⚠️ (Enterprise) | ❌ | ✅ |
| **Jira** | ✅ | ✅ | ✅ (Enterprise) | ✅ (Gov) | ✅ |
| **GitHub Projects** | ✅ | ✅ | ⚠️ (Enterprise) | ✅ (Gov) | ✅ |
| **Productboard** | ✅ | ✅ | ⚠️ (Enterprise) | ❌ | ✅ |
| **Notion** | ✅ | ✅ | ✅ (Enterprise) | ⚠️ | ✅ |
| **Asana** | ✅ | ✅ | ✅ (Enterprise) | ✅ (Gov) | ✅ |

### 9.2 Data residency (2026)

- **Linear** — US / EU (od 2024 EU region)
- **Jira** — US / EU / AU / JP / IN
- **GitHub** — US / EU
- **Productboard** — US / EU
- **Notion** — US / EU

**Rekomendacja:** dla klientów EU / Polski rynek, wybieraj EU region (RODO compliance łatwiejsze).

---

## 10. Rekomendacje praktyczne (dla różnych kontekstów)

### Solo founder (1 osoba)

- **Notion free** (docs + simple database).
- **GitHub Projects free** (jeśli robię open-source).
- **Bez productboard** (overkill).

### Startup 2-10 osób

- **Linear Standard** ($8/user) dla eng work.
- **Notion free lub Plus** (docs, wiki).
- **Slack free** (komunikacja).
- **Loom free** (async video).
- **Bez productboard** (jeszcze).

### Scaleup 10-50 osób

- **Linear Plus** ($14/user) z Initiatives (roadmap view).
- **Productboard Pro** (opcja, jeśli B2B SaaS).
- **Notion Plus** (docs).
- **Loom Business** (async).

### Mid-market 50-200 osób

- **Linear Plus lub Enterprise** (jeśli eng-heavy).
- **Productboard Pro lub Enterprise** (jeśli B2B SaaS).
- **Notion Business** (docs, wiki).
- **Aha! opcja** (jeśli multi-product portfolio).
- **Confluence** (jeśli dużo documentation).

### Enterprise 200+

- **Jira Premium** + Atlassian ecosystem.
- **Productboard Enterprise**.
- **Confluence**.
- **Notion Business** (cross-team docs).
- **Aha!** dla portfolio strategy.

---

## 11. Jak to wygląda w Jointhubs

### 11.1 Aktualny stack (2026)

| Warstwa | Narzędzie | Koszt roczny (team ~10) |
|---------|-----------|------------------------|
| **Delivery (engineering)** | Linear Plus | ~$1,680 |
| **Discovery / feedback** | Brak (Notion ad-hoc) | ~$0 |
| **Docs / wiki** | Notion Plus | ~$1,200 |
| **Communication** | Discord | ~$0 |
| **Async video** | Brak (opcja Loom) | ~$0 |
| **Roadmap visualization** | Linear Initiatives + manual | ~$0 |
| **Razem** | | **~$2,880/rok** |

### 11.2 Co brakuje

| Gap | Rekomendacja |
|-----|--------------|
| **Customer feedback layer** | Dodać Productboard Pro (jeśli B2B SaaS priorytet). Albo Dovetail (tańszy) + manual categorization. |
| **Outcome tracking** | Linear Initiatives już wspiera — zacząć używać z outcomes (nie tylko labels). |
| **Cross-project view** | Linear Portfolio (2025+) lub manual w Notion. |
| **Async updates** | Loom Business (~$360/rok) dla weekly digests. |
| **Roadmap stakeholder view** | Linear public roadmap (free, ale adresowalny) lub Productboard. |

### 11.3 Rekomendacja (3 miesiące)

**Miesiąc 1:** Wdrożyć Linear Initiatives (outcome-based grouping) dla PISI Pilot + Fenix.
**Miesiąc 2:** Dodać Productboard Pro trial (30 dni) jeśli feedback z PISI Pilot jest intensywny.
**Miesiąc 3:** Setup Loom Business dla weekly async updates (zwłaszcza dla cross-timezone collaborators).

### 11.4 Czego NIE zmieniać

- **Linear jako delivery tool.** Działa, team adopted, UX wysoki.
- **Notion jako docs.** Dobra dla wiki + PRD + ADR.
- **Discord jako komunikacja.** Tanie, dobrze zintegrowane z botem.

---

## 12. Źródła

### Vendor docs (2024-2026)

- Linear Blog & Docs (cycles, initiatives, agents)
- Atlassian Blog & Docs (Jira, Confluence, Intelligence)
- Productboard Blog & Docs (Pulse, prioritization)
- Notion Blog & Docs (AI, databases)
- GitHub Blog & Docs (Projects v2, Octoverse 2025)
- Aha! Blog & Docs (strategy cascades)
- Height Blog & Docs (spreadsheet + DB)
- Asana Blog & Docs (Goals, Workflow Builder)
- Shortcut Blog & Docs (Stories + Iterations)

### Comparison reports

- G2 Grid for Project Management (Winter 2024, Summer 2025, Winter 2025)
- G2 Grid for Product Management (2024-2025)
- Capterra Shortlist (PM tools, 2024-2026)
- TrustRadius PM Software (2024-2025)
- Atlassian State of Teams 2024 + 2025

### Adoption stats

- GitHub Octoverse 2025 (Copilot, Projects, Actions)
- Stack Overflow Developer Survey 2024 + 2025
- Linear Engineering benchmarks 2024-2025
- Atlassian State of Teams (user adoption, remote)

### Pricing

- Vendor pricing pages (linear.app/pricing, atlassian.com/software/jira/pricing, productboard.com/pricing, notion.so/pricing)
- G2 Total Cost of Ownership reports (2024-2026)

### AI in PM

- Linear Blog Q1 2026 (Linear Agents launch)
- Atlassian Blog Q3 2024 (Atlassian Intelligence launch)
- Productboard Pulse launch (Q4 2025)
- Notion AI launch (Q1 2024)

### Planowanie w Jointhubs (kontekst)

- `Second Brain/Operations/Docs/research_software_project_planning_best_practices.md` (companion)
- `Second Brain/Operations/Docs/research_estimation_techniques.md`
- `Second Brain/Operations/Docs/research_roadmapping_patterns.md`
- Linear workspace configuration (verified 2026-06-15)
