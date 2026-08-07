---
name: memory-nav
description: >
  Central memory system mechanics for Mateusz's multi-project work. Use when the user says
  "zapamiętaj", "zapamiętaj globalnie", "zapamiętaj lokalnie", "zapisz w pamięci", asks what
  you remember about a project, or at session start in a known project repo (office,
  joint-flows, fenix*) to load the right context with minimal reading.
---

# Memory Nav — drzewo pamięci (jak Obsidian)

Cel: agent czyta JAK NAJMNIEJ kontekstu, ale zawsze wie, GDZIE jest pogłębienie.
Struktura: korzeń → plik projektu → CLAUDE.md/docs w repo. Linki = ścieżki plików.

## Mapa
```
$LA_ROOT/agents/orchestrator/CLAUDE.md                    <- zasady core (ładowane zawsze, NIE dopisuj tu faktów)
$LA_ROOT/agents/orchestrator/memory/MEMORY.md             <- index: kim jest Mateusz, lista projektów (1 ekran)
$LA_ROOT/agents/orchestrator/memory/workflow.md           <- jak pracuje (szczegóły stylu współpracy)
$LA_ROOT/agents/orchestrator/memory/projects/au.md        <- AU/office: esencja + linki w głąb
$LA_ROOT/agents/orchestrator/memory/projects/neo.md       <- Neo/joint-flows
$LA_ROOT/agents/orchestrator/memory/projects/fenix.md     <- Fenix
<repo>/CLAUDE.md, <repo>/docs/...      <- wiedza lokalna projektu (najgłębszy poziom)
```

## Odczyt (na starcie sesji w projekcie)
1. Globalny CLAUDE.md masz zawsze. 
2. Jesteś w repo projektu z listy → przeczytaj jego plik `memory/projects/<x>.md` (≤1 ekran).
3. Głębiej (CLAUDE.md repo, docs/, STATE.md) wchodź dopiero, gdy zadanie tego dotyczy.
NIE czytaj całego drzewa prewencyjnie.

## Zapis — rozstrzyganie "gdzie"
| Sygnał | Miejsce |
|---|---|
| "zapamiętaj globalnie" / fakt przydatny w wielu projektach (styl pracy, decyzja strategiczna, relacja między projektami) | `$LA_ROOT/agents/orchestrator/memory/` — workflow.md albo plik projektu |
| "zapamiętaj (lokalnie)" / fakt techniczny jednego repo (komenda, port, konwencja kodu) | `<repo>/CLAUDE.md` lub `<repo>/docs/` |
| dane dostępowe dev | `<repo>/docs/ACCESS.md` (nigdy sekretów w global memory) |
| stan bieżącej dłuższej pracy | `<repo>/docs/STATE.md` |

## Reguły higieny (ważne dla spójności)
1. **Jeden fakt = jedno miejsce.** Zanim dopiszesz — sprawdź, czy już nie istnieje; aktualizuj zamiast duplikować. Fakt nieaktualny → usuń.
2. **Esencja na górze.** Każdy plik zaczyna się 3-5 liniami podsumowania; szczegóły niżej; linki na dno.
3. **Limit rozmiaru.** Plik projektu > ~60 linii → wydziel pod-plik (`projects/au-deploy.md` itp.) i zostaw 1-linijkowy link.
4. **Nowy plik = wpis w MEMORY.md** (index musi znać każdy węzeł).
5. **Nowy ważny projekt** (Mateusz mówi "to mój kluczowy projekt") → utwórz `projects/<nazwa>.md` z szablonem: Esencja / Stack / Kluczowe fakty / Schodzenie głębiej / Decyzje globalne.
6. Daty zapisuj absolutnie (2026-06-11, nie "dzisiaj").
