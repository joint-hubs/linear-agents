---
name: git-checkpoint
description: >
  Commit hygiene for Mateusz's repos: logical batches, messages matching repo history style,
  proactive checkpoints after each finished stage. Use when the user says "uporządkuj gita",
  "zakomituj", "zrób porządek z gitem", "przygotuj PR", or when you finish a coherent chunk
  of work (feature phase, fix, doc) and the working tree is dirty.
---

<git_cleaning>
1. `git status` + `git diff --stat` — zobacz CO jest brudne. `git log --oneline -15` — zobacz
   STYL message'y w tym repo (język, prefiksy typu `feat:`/`fix:`, długość) i się dopasuj.
2. Pogrupuj zmiany w logiczne batche — jeden commit = jedna spójna rzecz:
   - osobno: feature, fix, refaktor, dokumentacja, konfiguracja/infra,
   - NIE mieszaj niezwiązanych plików w jednym commicie,
   - NIE rób jednego wielkiego "WIP/changes" na 40 plików. 
3. Zaproponuj plan commitów — wypisz batche (jakie pliki → jaki message) i pokaż Mateuszowi.
   Stage + commit (`git add <konkretne pliki>`, nie `git add -A` na ślepo) wykonaj DOPIERO po
   jego „commituj". Bez wyraźnej zgody nie uruchamiaj `git add/commit/push`.
4. Przed commitem sprawdź, czy nie commitujesz śmieci: sekrety/.env, pliki tymczasowe,
   artefakty buildów, duże binaria. Jeśli czegoś brakuje w `.gitignore` — dopisz.
5. Po większej pracy: zaproponuj/przygotuj PR (tytuł + opis: co, po co, jak przetestować) —
   również po akceptacji. Jeśli Copilot/reviewer zostawił komentarze — przejdź po nich i odnieś
   się do każdego.
</git_cleaning>

<proactive_timing>
- Po zakończeniu fazy z planu/PRD.
- Przed ryzykownym refaktorem (checkpoint do powrotu).
- Przed końcem sesji, jeśli working tree jest brudny — przypomnij, nie zostawiaj cicho.
W każdym z tych przypadków: zaproponuj batche i czekaj na „commituj".
</proactive_timing>

<rules>
- Nie commituj/pushuj bez wyraźnego polecenia (to najważniejszy zakaz).
- Nie pushuj force, nie zmieniaj historii opublikowanych branchy.
- Nie commituj wygenerowanych paczek release, jeśli repo ich dotąd nie trzymało.
</rules>