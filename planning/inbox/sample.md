# sample — WIP age w digeście CADENCE

## Transkrypt (dyktando Mateusza)

chciałbym żeby digest cadence pokazywał wiek zadań w WIP bo teraz nie wiem które taski wiszą za długo i retro nie ma danych żeby ocenić drift potrzebuję żeby collector zbierał datę utworzenia i ostatniej zmiany każdego taska który jest w In Progress albo Review potem w digeście ma być sekcja "aging WIP" z listą tasków które są w tym stanie dłużej niż 3 dni plus ich wiek w dniach i ewentualnie link do taska w Linear i żeby retro też to brał pod uwagę przy wykrywaniu driftu czyli flagował taski starsze niż 5 dni jako potencjalny problem no i fajnie jakby był mały warning w digeście jeśli średni wiek WIP rośnie tydzień do tygodnia to by pokazywało trend

## Artefakty

- `docs/prd/prd-cadence.md` — PRD CADENCE squad: collector zbiera stan (throughput, In Progress/Review, blocked, escalated, over-budget, aging WIP), retro wykrywa drift, digest raportuje.
- `agents/cadence/agents/collector.md` — obecny sub-agent collector: co zwraca, jakie pola z Linear czyta.
- `agents/cadence/agents/digest.md` — obecny sub-agent digest: format raportu, sekcje, target audience (Mateusz).
- `docs/agent-0-cadence.md` — spec koncepcyjna CADENCE: pętla, read-mostly, trigger.

## Kontekst

- **Produkt:** linear-agents — zestaw 5 squadów agentów (cadence/plan/dev/review/test) do automatyzacji cyklu dev przez Linear.
- **Repozytorium:** `C:\Users\mateu\Documents\GitHub\linear-agents`
- **Constrainty:** read-mostly (CADENCE nie zmienia scope bez Mateusza); 1 digest/tydzień; collector czyta przez Linear MCP (1M context MiniMax — tani); zmiany tylko w agentach CADENCE (collector, retro, digest), nie w innych squadach.
- **Timeline:** do zrobienia w tym sprintcie (przed następnym digestem).
- **Budżet:** tani — preferowany MiniMax M3/M3 do collectora i retro, DeepSeek V4 Flash do digestu.
