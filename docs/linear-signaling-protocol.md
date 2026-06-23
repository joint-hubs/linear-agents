---
type: design-doc
status: active
tags: [type/design-doc, area/ai, topic/linear, topic/workflow, topic/communication, topic/labels]
created: 2026-06-22
updated: 2026-06-22
source: Linear docs (labels, estimates, relations, SLA, Agents) + research notes
maturity: design-v1
---

# Linear signaling protocol — komunikacja człowiek↔agent przez metadane

> Pomysł Mateusza: użyć **labelek / metadanych Lineara** jako kanału komunikacji.
> To mocna dźwignia — robi z Lineara **asynchroniczną, filtrowalną magistralę sygnałów**
> widoczną w UI (zero osobnego kanału). Bezpośrednio rozwiązuje **bottleneck HITL (W3)**
> i domyka kilka innych luk.
>
> **Zasada naczelna (z docs Lineara + `planning_tools` §11.4):** Linear jest opinionated —
> NIE odtwarzaj Jiry. Preferuj **pole natywne > labelka > komentarz**. Trzymaj ~5 grup
> labelek + kilka flag. Inaczej ludzie przestają stosować.

---

## 0. Fakty o Linearze (zweryfikowane 2026)

| Mechanizm | Status | Użycie w protokole |
|---|---|---|
| **Label groups** (single-select, `Type:Bug`, opisy, SLA/Triage rules) | ✅ | typowane sygnały (type/needs/risk) |
| **Estimate** (skala konfigurowalna, m.in. **t-shirt**) | ✅ | rozmiar (W1), XL→re-decompose |
| **Priority** (Urgent/High/Med/Low) | ✅ | kolejność wyboru dev |
| **Relations** (blocked by / relates / duplicate) | ✅ | zależności (C4) |
| **Assignee** (+ **bot user** dla agenta) | ✅ | handoff/ownership, „czyja kolej" |
| **Project / Initiative** | ✅ | repo + outcome/theme (M3) |
| **Sub-issues / parent** | ✅ | parent=kontekst, child=delta (W8) |
| **Comments + @mention** | ✅ | właściwy dialog |
| **Emoji reactions** (✅👀👍🚫🔁) | ✅ | ultra-lekki ack/approve (1 klik) |
| **Linear Agents** (OAuth `actor=app`, webhooks: mention/assign/react/comment, `app:assignable`/`app:mentionable`) | ✅ | event-driven backbone |
| **Custom fields / properties** | ❌ NIE MA | → używamy labelek, nie custom fields |

---

## 1. Mapowanie potrzeby → właściwy prymityw (preferuj natywne)

| Potrzeba komunikacyjna | Prymityw | Dlaczego nie labelka |
|---|---|---|
| Etap pracy | **Status** (Todo→In Progress→In Review→Done) | natywne, jest |
| Kolejność wyboru dev | **Priority** | natywne sortowanie |
| Rozmiar / estymata | **Estimate (t-shirt)** | natywne pole, XL widać |
| Zależności | **Relation `blocked by`** | natywne, dev pomija blokady |
| Kto teraz działa | **Assignee** (bot `@flow` vs Mateusz) | reassign = handoff |
| Outcome / theme | **Initiative** | natywne grupowanie |
| Repo | **Project** | natywne |
| Kontekst vs delta | **parent / sub-issue** | natywna hierarchia |
| Dialog | **Comment + @mention** | natywne, źródło prawdy |
| Szybki ack/approve | **Emoji reaction** | 1 klik, zero szumu |

**Dopiero to, czego nie ma w polach natywnych → labelki.**

---

## 2. Labelki — minimalny zestaw (5 grup + kilka flag)

### Grupy (single-select)
| Grupa | Wartości | Kierunek | Znaczenie |
|---|---|---|---|
| **`type:`** | `feature` · `bug` · `spike` · `tech` | plan→wszyscy | routing zachowania (spike→ADR bez deploy; tech→technical-criteria) |
| **`needs:`** | `answer` · `approval` · `decision` · `access` | **agent→człowiek** | „czekam na Ciebie i na CO" — to jest Twoja kolejka |
| **`risk:`** | `high` | agent→człowiek | ryzykowna zmiana → głębszy review (`review` §3C risk-tiered) |
| **`ai:`** | `planned` · `coded` · `reviewed` (multi) | proweniencja | AI-tknięte → wyższy sampling review |
| **`stage:`** *(opcjonalnie)* | `testing` | agent | pod-faza In Review (zamiast osobnego statusu, W2) |

### Flagi (boolean, używane rzadko)
`dor-ok` · `dod-ok` (bramki M4) · `escalated` (loop-limit W4) · `over-budget` (cost W6) ·
`transcript-uncertain` (niepewna transkrypcja C5) · `blocked` (+ relacja co blokuje).

> Każda labelka ma **opis** (hover) — protokół jest samodokumentujący się w UI.
> `needs:answer` może mieć **SLA** (np. nudge po 24h).

---

## 3. Emoji jako mikro-dialog (na komentarzu agenta)

| Emoji | Kto | Znaczenie |
|---|---|---|
| 👀 | agent | „odebrane, myślę/pracuję" (ack) |
| ✅ / 👍 | człowiek | „approve / leć" (zastępuje labelkę, 1 klik) |
| 🚫 | człowiek | „nie / zmiany" |
| 🔁 | człowiek | „przerób" |

**Efekt:** plan-mode approve = reakcja ✅ na komentarz z planem → webhook → dev koduje. Zero pisania.

---

## 4. Backbone event-driven (Linear Agent `@flow`)

1. Rejestrujemy OAuth app **`@flow`** (`actor=app`, `app:assignable`, `app:mentionable`, webhooks).
2. Zdarzenia, które budzą agenta (webhook): **@mention `@flow`**, **assign do `@flow`**, **reaction**, **nowy komentarz**.
3. Wzorzec pętli:
   - Agent kończy etap → ustawia `needs:answer` + komentarz z pytaniem (PL, MiniMax M3) + @Mateusz → **idzie spać** (nie blokuje).
   - Mateusz w jednym „approval slot" przegląda widok **🔔 My input** → odpowiada: reakcja ✅ albo `@flow <odpowiedź>` albo toggluje `needs:` off.
   - Webhook budzi właściwego agenta → czyta kontekst → zdejmuje `needs:` → kontynuuje.
   - Agent reaguje 👀 = „mam, działam".

> To jest właściwe rozwiązanie **W3 (HITL bottleneck)**: w pełni async, batchowane, 1-klik.
> `.bat` launchery zostają dla ręcznego/explicit odpalenia; webhook to ścieżka automatyczna.

---

## 5. Widoki Mateusza (control plane = zapisane filtry)

| Widok | Filtr | Po co |
|---|---|---|
| **🔔 My input** | `needs:*` OR assignee=me | kolejka HITL (batch) |
| **🤖 Agent working** | assignee=`@flow` AND status=In Progress | co się dzieje |
| **⚠️ Attention** | `risk:high` OR `escalated` OR `over-budget` OR `transcript-uncertain` | gdzie zerknąć |
| **🚧 Blocked** | `blocked` OR has `blocked by` | odblokowania |
| **🧪 Review/Test** | status=In Review | gotowe do akceptacji |

---

## 6. Jak to domyka luki z design-review

| Luka | Domknięcie przez metadane |
|---|---|
| **W3** HITL bottleneck | `needs:*` + widok 🔔 + emoji-approve = async batch, 1-klik |
| **W1** estymacja | natywne **Estimate (t-shirt)** |
| **W2** za dużo statusów | 4 statusy; „Ready"=`dor-ok`, „Testing"=`stage:testing` |
| **W4** escalation | flaga `escalated` + reassign do Mateusza |
| **W6** cost | flaga `over-budget` + widok ⚠️ |
| **C1/C2** task typing | grupa `type:` |
| **C4** zależności | natywne **relations `blocked by`** |
| **C5** transkrypcja | flaga `transcript-uncertain` |
| **M3** outcome | natywne **Initiative** |
| **M4** DoR/DoD | flagi `dor-ok` / `dod-ok` |
| AI-proweniencja → review sampling | grupa `ai:` |
| risk-tiered review | `risk:high` → review na GLM-5.2, głębiej |

---

## 7. Czego NIE robić (anty-over-engineering)
- ❌ > ~5 grup labelek / zagnieżdżone labelki à la `Awaiting-Review-by-Team-A`.
- ❌ Labelka tam, gdzie jest pole natywne (status/priority/estimate/relation/assignee).
- ❌ Custom fields (Linear ich nie ma — nie udawaj).
- ❌ Status per mikro-stan — użyj label/flag.
- ✅ Rewizja zestawu co kwartał; usuwaj nieużywane (archiwizacja zachowuje historię).
