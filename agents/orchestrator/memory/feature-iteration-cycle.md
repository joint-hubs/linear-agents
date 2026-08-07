---
name: feature-iteration-cycle
description: "Pełny cykl tasku Linear → sync gita → branch → plan → implementacja (orkiestracja Flash) → weryfikacja runtime (guided) → PR → closure Linear. Powtarzalny schemat usprawniający pracę nad kodem. Czytaj na starcie każdego nowego taska z Linear."
metadata:
  type: workflow
---

# Cykl iteracji nad feature'm (Linear → merge)

To schemat, który sprawdził się w PISI-103 i podobnych. Powtarzaj go dla każdego nowego
taska z Linear. Pamięci pokrewne (nie dubluj): [[workflow]] (jak pracuje Mateusz),
[[github-pr-workflow]] (faza PR/review), [[orchestration]] (delegacja do Flash),
[[office-guided-verify-workflow]] (weryfikacja runtime), [[office-fetch-secrets-self-serve]].

## Faza 0 — start nowego taska (po merge poprzedniego)

Gdy Mateusz robi merge poprzedniego PR i przechodzimy do kolejnego taska:

1. **Sync z GitHubem na `dev`** (NIE `main` — to repo office ma `dev` jako gałąź roboczą):
   ```
   git checkout dev && git pull origin dev
   ```
   Sprawdź `git status` — musi być czysto.
2. **Pobierz task z Linear** przez Atlas: `search("linear workspaces")` → `read` →
   `run("tools/linear-tasks", "-w <ws> show <ISSUE>")` + `comments <ISSUE>`.
   - workspace **pisi** = browse-only; komentarze publikuj TYLKO na wyraźną prośbę.
   - Pamiętaj o `PYTHONUTF8=1` przy komentarzach (skrypt crashuje na znakach → na cp1250);
     obejście: wołaj `linear_api.py` bezpośrednio zamiast wrappera.
3. **Ustal UUID taska** (`get_issue(ID)` → `.id`) — potrzebne do `add_comment`/`update_issue`.
   Stany pisi różne od jointhubs (Done = `28a13463-...`, type=completed).

## Faza 1 — plan (zanim kod)

1. **Rekonesans kodu:** zleć 1–3 Explore agenty RÓWNOLEGLE (Plan mode Phase 1).
   Każdy zwraca ~150–180 linii streszczenia, NIE czytasz dużych plików sam.
2. **Plan do pliku** (`$LA_ROOT/agents/orchestrator/plans/<random>.md`): Context, scope plik-po-pliku,
   „nie ruszamy", decyzje, sekcja weryfikacji. To JEDYNY plik, który edytujesz w plan mode.
3. **Publikacja planu jako komentarz Linear** (gdy Mateusz prosi) — `add_comment(uuid, body)`.
4. **ExitPlanMode** → Mateusz approves „jedziemy".

## Faza 2 — implementacja (orkiestracja)

1. **Branch** z `dev`: `git checkout -b feat/<pisi-id>-<slug>` (lub `fix/...`).
2. **Tnij na najmniejsze niezależne kawałki** → `agent_spawn` ×N (model `flash`) równolegle.
   Kontrakt dla workera: pełny, precyzyjny, min tokenów/max info — ścieżka pliku, dokładna
   lokalizacja, wzorzec do mirror, constraints, acceptance, „nie commituj".
3. **Collect** każdego workera; **Pro recenzuje** Flash; **ostateczna weryfikacja Twoja**
   (integracja): niezależnie waliduj JSON/syntax/diff, nie ufaj relacjom workerów.
4. **Commit** w logicznych batchach (styl repo, BEZ `Co-Authored-By`). `git add`+`commit`
   dopiero na wyraźne „commituj". Patrz [[commit-message-style]].

## Faza 3 — weryfikacja runtime (guided)

Tryb: **Mateusz klika w UI, Ty czytasz logi/DB na VM.** Patrz [[office-guided-verify-workflow]].
1. **Deploy/preflight** na VM (Ty): dla office — sync plików `scp` (GCP to NIE git repo),
   uruchom bootstrap/rebuild wg potrzeby. Minimalizuj restarty (pułapka 502 edge).
2. **Potwierdź stan w bazie/logach ZANIM** poprosisz Mateusza o akcje.
3. **Daj Mateuszowi numerowaną listę akcji** w przeglądarce z DOKŁADNYMI danymi
   (URL, login, hasło testowe/świadomie-błędne). Hasła → wskaż secret-file, nie hardkoduj.
4. Mateusz robi akcje → pisze „kroki 1–N zrobione".
5. **Czytaj logi + DB** → tabela AC1..ACn z OK/fail.
6. Gdy błąd (np. login) — najpierw DIAGNOZA (jaki realm, konto, BOM?), potem poprawiona instrukcja.

**Lekcja PISI-103:** plik-instrukcja krok-po-kroku (`docs/<ISSUE>-verify-instructions.md`)
to dobry nośnik — wrzuć go do repo jako osobny commit.

## Faza 4 — PR + closure

1. `git push -u origin <branch>` + `gh pr create --base dev` (office: baza `dev`, NIE `main`).
2. **PR description** wymień WSZYSTKIE zmienione pliki (Copilot wyłapuje rozjazd „3 vs 4 pliki").
3. **Closure Linear:** komentarz z AC odznaczonymi `[x]` + tabela weryfikacji + commity +
   `update_issue(stateId=Done)`.
4. **Review Copilot** — patrz [[github-pr-workflow]]. Kopilot daje rundy (często 2–3);
   odpowiadaj na każdy wątek `gh api .../comments/<id>/replies`, linkuj do commita-fixu.
   Copilot Autofix może sam commitnąć na remote → `git pull --rebase` przed push.
5. **Resolve wątków** = Mateusz (mutation zablokowane u Ciebie).

## Lekcje twarde (z PISI-103 i pokrewnych)

- **Realm JSON nie wystarczy na istniejącej instalacji** — Keycloak `--import-realm` NIE
  nadpisuje istniejącego realmu. Dla już wdrożonych realmów potrzebna ścieżka bootstrap
  (PUT przez Admin API). Zawsze pytaj „czy realm już istnieje na VM" — decyduje o tym,
  czy realm JSON zadziała, czy trzeba hardening w runtime.
- **`docker exec $(docker ps --filter name=X ...)` jest niejednoznaczne** przy wielu
  stackach compose na hoście. Używaj `docker compose -p <proj> -f ... exec -T <svc>`
  z pełnym kontekstem. Runbook office używa zmiennej `$COMPOSE` — trzymaj się jej.
- **Kolumny DB Keycloak 26:** `event_entity.event_time` (epoch ms), `admin_event_entity.admin_event_time`
  — NIE `created_at`. Projekcja `to_timestamp(col/1000)`.
- **Konsola `/auth/admin` = realm `master`** — konta testowe `ci-*@example.com` żyją w
  `urzedowy-chat` i NIE zalogują się do konsoli admina. Do konsoli: konto `admin` z
  `~/.local-secrets/keycloak_admin_password`.
- **Hasła/sekrety:** NIE hardkoduj w docs. Wskaż secret-file + komendę (patrz
  [[office-fetch-secrets-self-serve]]). Klasyfikator blokuje agentowi `cat` sekretu.
- **CRLF w plikach office:** runbook ma CRLF, instrukcje mogą mieć LF. Edit tool nie trafia
  przez `\r\n` — wtedy edytuj przez Python script (split po `\r\n`, indeksy linii, write bytes).
- **BOM w sekretach** psuje logowanie — sprawdzaj `od -c` pierwszych 3 bajtów (`ef bb bf` = BOM).
- **Bind-mount vs obraz:** `keycloak-bootstrap` to `image: python:3.13-alpine` z bind-mountem
  `../keycloak:/bootstrap:ro` → zmiana `bootstrap_users.py` NIE wymaga rebuildu obrazu keycloak,
  wystarczy scp + restart jobu. Sprawdzaj compose, zanim każesz rebuildować.

## Higiena na koniec iteracji

- Odhacz wszystkie taski (TaskList) — żadnych nieodhaczonych.
- Jeśli wyszły fixy w trakcie → dopisz jako nowe taski, rozwiąż.
- Rozważ `docs/STATE.md` dla długiej pracy (zasada 7) — następna sesja startuje tanio.
- Nie commituj sam — przygotuj i ZAPROPONUJ; push/merge na wyraźne polecenie.
