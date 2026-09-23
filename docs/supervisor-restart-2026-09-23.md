# Restart supervisora — 2026-09-23

> Zweryfikowane: 84/84 pliki testowe, lint i graf poprawne. Commity implementacji: `dbce3fe` i `482f74a`; szczegóły w raporcie dostawy.

Jesteś nowym supervisorem w **linear-agents**: jawna NOWA sesja, absolutna ścieżka `C:/Users/mateu/Documents/GitHub/linear-agents` (root checkout, nie worktree). Nie wznawiaj automatycznie starego runu. Kontynuuj pracę rzeczywistych squadów Fenixa autonomicznie, w ramach istniejących bramek — sesja robocza, nie diagnostyczna. Implementacja i commity są już upoważnione; nie zatrzymuj się na rutynowe pozwolenia.

Czytaj po kolei:
1. `agents/supervisor/CLAUDE.md` — kontrakt roli.
2. `docs/reviews/2026-09-23-prompt-codegraph-delivery.md` — kompaktowy raport dostawy (stan, kontrakt CodeGraph, metryki, diagnostyki, co dalej).
3. `docs/STATE.md` — tylko najnowszą sekcję, w razie potrzeby.
4. Sekcje konfiguracji i dokumentacji potrzebne do zadania — bez obowiązkowego wczytywania całych PRD i audytów na start.

Squady mają zaczynać nawigację kodu od CodeGraph. Zapytanie dotyczy worktree zadania; `LA_ROOT` wskazuje tylko skrypty. Korzystaj z guarded MCP, a poza jego konfiguracją z wrappera CLI z `--project-root <worktree-zadania>`. Guard sprawdza świeżość przed zapytaniem i synchronizuje warunkowo. UNKNOWN oznacza jawny fallback do plików, nie dowód braku symbolu.

Atlas i squady Fenixa to osobne mechanizmy. Używaj przepływu supervisora oraz squadów z tego repo, nie zastępuj ich workerami Atlasa.

Start: `git status` + `git log --oneline -3`. Origin/main zweryfikowany bezpośrednio przez `ls-remote` (`e2f76f7`): baseline `70e40a4` realnie wyprzedza origin o 32 commity — to nie artefakt cache'a; bez fetch/push. Untracked settings/dokumenty audytowe i stash w main zachowane.

Bramki bez zmian: bramy H użytkownika; routing modelowy `config/models.json`; review/test na przypiętym kandydacie DEV; bez auto-push; bez sprzątania niezwiązanego z zadaniem.

FOC-475 (In Progress; stan w raporcie zgodny z faktami) — NIE domykaj bezwarunkowo: najpierw porównaj AC/DoD z aktualnym stanem w Linear; spełnione → opublikuj dowód i domknij zgodnie z rolą; braki → wskaż je. Nie odtwarzaj scalonej pracy od nowa.

Dalej: FOC-476 to następna integracja, ale najpierw realne blokery — FOC-450 (egress) przed publish, FOC-381 (dedup telemetrii) przed kalibracją kosztów. Bez reguły „M1 przed M2"; niezależne zadania dozwolone; priorytet: safety w M1.
