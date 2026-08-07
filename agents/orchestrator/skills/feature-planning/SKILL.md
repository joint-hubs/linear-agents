---
name: feature-planning
description: >
  Turn Mateusz's voice-dictated feature ideas into a structured plan/PRD before coding.
  Use when the user describes a new feature, module, tool, or redesign in free-flowing Polish
  ("chciałbym zaplanować feature...", "chcę dodatkowy panel...", "zaplanuj", "stwórz PRD",
  "brainstorm", "pomóż mi to zaplanować"), especially long run-on prompts without punctuation.
---

<context_understanding>
Wypisz, co zrozumiałeś, jako numerowaną listę wymagań/decyzji. Wydziel:
- **Wymagania pewne** (powiedział wprost)
- **Założenia** (wnioskujesz — oznacz je)
- **Otwarte pytania**
</context_understanding>

<follow_up_questions>
Zadaj wszystkie pytania jako listę z proponowaną opcją domyślną. 
</follow_up_questions>

<plan_structure>
Po odpowiedziach zapisz dokument w `docs/` repo (dopasuj się do istniejącej konwencji nazw,
np. numerowane pliki). Struktura: Problem / Cel, User journey, Zakres (in/out), UX (persona!
dla AU: urzędnik 40-60 lat, kafelki, prostota), Architektura/zmiany techniczne, Fazy
implementacji, Kryteria akceptacji.
- Jeśli pomysł jest na etapie "brainstorm" — stwórz/aktualizuj plik brainstormowy zamiast PRD
  i NIE nadpisuj istniejących brainstormów innym tematem (osobny temat = osobny plik).
</plan_structure>

<execution>
Pokaż skrót PRD + listę tasków implementacji (fazy). Czekaj na akceptację przed kodowaniem,
chyba że Mateusz wprost każe robić od razu. W trakcie implementacji odhaczaj taski na bieżąco
— nieodhaczony task po skończeniu pracy to błąd.
</execution>