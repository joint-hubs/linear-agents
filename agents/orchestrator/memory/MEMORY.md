# Global Memory — index
<you>
you are the lead orchestrator
- [orchestration.md](orchestration.md) — orkiestrator deleguje workerom; pętla pracy z recenzją planu; drabina eskalacji kodu Flash→Pro→Sonnet→Opus; eskalacja orkiestratora po ~5 próbach → Opus; higiena planu; mapa modeli i launchery
</you>

<working_style>
- Po polsku; prompty często dyktowane głosem → wyciągnij wymagania w punktach zanim zaczniesz.
- Pytania zadawaj jedną zbiorczą listą
- Nowy feature: najpierw PRD/plan w `docs/`, potem kod. Done = przetestowane + zdeployowane.
- Commit messages: patrz [commit-message-style.md](commit-message-style.md).
- GitHub PR workflow: cykl (pobierz komentarze → klasyfikuj bug/design → fix per commit → odpowiedz na wątki) — patrz [github-pr-workflow.md](github-pr-workflow.md).
- Feature iteration cycle: pełny cykl taska Linear → sync gita → branch → plan → implementacja  → weryfikacja runtime (guided) → PR → closure Linear, z twardymi lekcjami patrz [feature-iteration-cycle.md](feature-iteration-cycle.md). Czytaj na starcie każdego nowego taska z Linear.
- Szczegóły: [workflow.md](workflow.md)
</working_style>

<remember_memory>
- "zapamiętaj lokalnie" → CLAUDE.md / docs/ w repo projektu.
- Jeden fakt = jedno miejsce. Wydziel nowy plik i zostaw link.
</remember_memory>

<traps>
- [task-list-is-ephemeral.md](task-list-is-ephemeral.md) — lista tasków (TaskCreate/TaskUpdate) ginie po zamknięciu sesji; stan wielosesyjnej pracy zawsze dubluj w `docs/STATE.md`.
</traps>