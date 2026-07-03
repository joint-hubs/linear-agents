---
type: brainstorm
status: draft-v1 (2026-07-03)
audience: Mateusz (iteracja) → potem PLAN squad (dekompozycja jako Draft w Linear)
topic: "scheduled learning" — mining transkryptów → playbooki → wyspecjalizowani sub-orkiestratorzy (MiniMax) nad workerami (DeepSeek Pro)
related: ../decisions/cost-optimization.md (delegacja P0, worker/flash), brainstorm-autonomous-dispatch.md (konsument kandydatów)
---

# Brainstorm B — warstwa specjalizacji uczona z historii (Fenix v3 kandydat)

## Wizja (słowami Mateusza, uporządkowana)
Cykliczny algorytm indeksuje historyczne sesje, grupuje pracę orkiestratora w chunki i wykrywa
POWTARZALNE obszary. Z powtarzalności powstaje specjalista (MiniMax) — sub-orkiestrator tematu:
następnym razem lead nie robi tematu sam, tylko oddaje go specjaliście, a ten wypuszcza tanich
workerów (DeepSeek Pro) i wraca z wynikiem. Najmocniejsze modele „dysponują porządkiem",
nie działają we wszystkim.

## Twarde ograniczenie techniczne (kształtuje cały design)
**Subagent w Claude Code nie może spawnować subagentów** (sidechainy się nie zagnieżdżają).
„MiniMax orkiestruje DeepSeeki" wewnątrz jednej sesji nie zadziała dosłownie. Dwa realne wzorce:

- **(a) Domenowy planista** *(default, tani)*: lead → Task(`<domena>-specialist`, MiniMax) →
  specjalista zwraca **mikro-plan**: listę samowystarczalnych briefów dla workerów → lead
  MECHANICZNIE (bez myślenia, krótkie tury) wystrzeliwuje `Task(worker/deepseek)` per brief →
  surowe wyniki wracają do specjalisty do scalenia → lead dostaje gotowy pakiet.
  Hierarchia logiczna w jednej sesji; lead płaci tylko za pętlę dispatch.
- **(b) Sub-squad procesowy** *(cięższe tematy)*: specjalista dostaje WŁASNĄ sesję headless
  (`/api/launch` — dispatcher z brainstormu A umie to odpalić) z własnym CLAUDE.md i własnymi
  subagentami; komunikacja przez Linear/pliki. Hierarchia na poziomie procesów — bez limitu głębokości.

## Pipeline uczenia (schedulowany, np. co tydzień)
```
transcripts (mamy 160+; parseTranscript już wyciąga turny/briefy/sidechains per rola)
  → 1. chunk-ekstrakcja: sekwencje [brief → tool-calle → wynik] per temat, per rola
  → 2. klastrowanie (embeddingi) + metryki: częstość, koszt łączny, % udziału leada, powtarzalność
  → 3. RAPORT KANDYDATÓW: "temat X wystąpił N razy, kosztował $Y, lead robił go sam w Z%"
  → 4. kandydat ≥3 wystąpień → destylacja PLAYBOOKA (procedura krok-po-kroku z realnych sesji)
  → 5. propozycja jako DRAFT w Linearze (konsumuje brainstorm A!) → Mateusz zatwierdza labelką
  → 6. materializacja: playbook do prompta istniejącej roli ALBO nowy agents/<squad>/agents/<domena>.md
       (MiniMax, wzorzec a) + wpis w models.json
```
**Żadnego auto-deployu agentów/promptów bez zatwierdzenia** — spójnie z bramkami-labelkami z A.

## Kolejność dojrzewania (założenie przyjęte: playbooki-first)
1. **S1 — Miner + raport** (read-only): tygodniowy raport powtarzalności do `.state/learning/<ISO-week>.md`
   + sekcja w digeście CADENCE. Zero zmian w agentach. AC: raport wskazuje ≥3 sensownych kandydatów
   z realnych danych (np. „provisioning labelek", „telemetry smoke-test", „Conventional Comments merge").
2. **S2 — Playbooki**: destylat kandydata dopisany do istniejącej roli (worker/rola squadu) jako
   procedura; mierzymy: koszt tematu przed/po. AC: pierwszy playbook obniża koszt powtórki ≥30%.
3. **S3 — Specjaliści (wzorzec a)**: playbook, który powtórzył się 3+ razy → `<domena>-specialist.md`
   (MiniMax) zwracający mikro-plany; lead uczy się w CLAUDE.md routingu „temat X → specjalista X".
4. **S4 — Sub-squady (wzorzec b)**: tylko dla tematów, gdzie (a) nie wystarcza (długie, wielofazowe).

## Otwarte punkty (do 2. rundy brainstormu)
- Embeddingi czym: OpenRouter embeddings / lokalny model / reuse podejścia z thoughtmap? (tanie, offline-friendly)
- Granulacja chunków: per Task-tool brief (naturalna jednostka delegacji) vs per sekwencja narzędzi leada?
  (propozycja: briefy jako pierwsza klasa — są już samowystarczalne z definicji Polityki delegacji)
- Czy raport S1 liczy też ANTY-wzorce (lead robił sam coś, co miało rolę) — tak, to wprost metryka
  egzekwowania Polityki delegacji (≥40%).
- Utrzymanie: playbooki się starzeją — data ważności / re-walidacja przy zmianie kontraktów?

## Zależności
- Dane: im więcej runów przez dispatcher (A) i pilot (Fenix v2 poz. 5), tym lepszy sygnał — S1 ma sens
  po ~2 tyg. pracy squadów na nowej Polityce delegacji (briefy będą czystsze).
- S3 wymaga działającej Polityki delegacji (lead umie mechanicznie dispatchować wg mikro-planu).
