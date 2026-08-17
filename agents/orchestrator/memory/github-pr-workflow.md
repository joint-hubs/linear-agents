---
name: github-pr-workflow
description: Powtarzalny cykl pracy z GitHub PR — pobierz komentarze, klasyfikuj, fix w commitach, odpowiedz na wątki. Zawiera przydatne `gh` CLI patterns (inline body, fetch po ID, filtry jq, diagnostykę pustej listy). Dotyczy każdej sesji, w której user mówi "pojawiły się nowe komentarze" / "sprawdź review" / "przygotuj PR do dev".
metadata:
  type: workflow
---

# GitHub PR workflow (powtarzalny cykl)

Używany gdy user zgłasza nowe komentarze na PR albo prosi o przygotowanie PR do review/merge. Kluczowe założenia:

- `gh` CLI jest zalogowany na konto z uprawnieniami `repo` (sprawdź `gh auth status` na starcie)
- Na Windows `%TEMP%` to `%LOCALAPPDATA%\Temp\` — `gh api -F "body=@..."` rozwija `/tmp/...` do tej lokalizacji, ale NIE zapisuje tam plików. Ścieżki do plików z `body@` MUSZĄ być w stylu Windows (`/c/Users/.../AppData/Local/Temp/...`) albo użyj `body="..."` inline (kruche przy wielolinijkowych treściach)
- Pliki na GCP to rozpakowany tarball — NIE jest git repo. Sync plików po zmianie kodu przez `scp` (NIE `git pull`), z zachowaniem katalogu docelowego

## Kroki cyklu

1. **Pobierz komentarze** — trzema API:
   - `gh api repos/{owner}/{repo}/pulls/{n}/comments` — inline review (z `path` i `line`)
   - `gh api repos/{owner}/{repo}/issues/{n}/comments` — top-level issue comments (zwykle puste dla PRów)
   - `gh api repos/{owner}/{repo}/pulls/{n}/reviews` — review z `state` (APPROVED/CHANGES_REQUESTED/COMMENTED)

2. **Sklasyfikuj każdy komentarz**:
   - **Prawdziwy bug** — faktyczny defekt wymagający fixu w kodzie
   - **Kruchy kod / proaktywny fix** — działa teraz ale może się zepsuć (np. eksperymentalny syntax)
   - **Design decision** — uzasadniona rozbieżność z opinia recenzenta (świadoma decyzja w naszym kodzie)
   - **Powtórzenie** — ten sam feedback który już zaadresowaliśmy (odsyłaj do poprzedniej odpowiedzi)

3. **Zapytaj usera o scope** jeśli mieszane (np. "Fix 1-3 w tym PR + acknowledgement 4-5"). Nie rób wszystkich fixów bez pytania — user decyduje czy scope roszerzyć.

4. **Fix per logiczna jednostka = 1 commit** (styl repo: `refactor(...)`, `feat(...)`, `fix(...)`, `chore(...)`, `docs(...)`). NIE jeden commit "wszystko".

5. **Push** po każdym fixnie (albo grupą po temacie), bo Copilot Reviewer może dać nowe komentarze do istniejącego kodu.

6. **Odpowiedz na GitHubie** na każdy oryginalny komentarz (nie na swoje własne reply) przez `gh api -X POST repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies -F "body=@<file>"`. Numeracja: `n = comment_id - first_comment_id + 1` (1-based, offset od pierwszego). Pliki z treścią zapisuj w `%TEMP%`, bo `gh` nie znajduje ich w `/tmp`.

7. **Dla powtórzeń** — w odpowiedzi wskaż na poprzednią odpowiedź w tym samym PR.

8. **Ostatni krok** — podaj userowi link do PR + listę commitów + status (`OPEN` / gotowe do merge).

## Wzorce

- Reviewer Copilot często daje 6 komentarzy w jednej rundzie (1 PR overview + 5 inline). Klasyfikacja: bug/kruchy/design. Typowa proporcja to 2-3 bugi, 1-2 kruche, 1-2 design/powtórzenia.
- Po fixach Copilot może dać **drugą rundę** komentarzy — bo widzi zaktualizowany diff. To normalne. Powtarzaj cykl.
- Jeśli `set -u` jest w skrypcie bash, **każda** niezdefiniowana zmienna wybuchnie — sprawdź po każdym refactorze nazw zmiennych.
- MSYS path mangling na Git Bash for Windows: argumenty zaczynające się od `/` są zamieniane na ścieżki Windows (np. `/CN=foo` → `C:/Program Files/Git/CN=foo`). Fix: `export MSYS_NO_PATHCONV=1` na początku skryptu, bez efektu na Linux.

## Nie rób

- NIE commituj `Co-Authored-By: Claude` trailer (patrz: [[commit-message-style]]).
- NIE pisz "Address Copilot review on PR #N" w commit body (to nie jest opis zmiany).
- NIE wstawiaj "Sorry", "Happy to follow up", "Verified locally" w commit body — to nie jest opis zmiany.
- NIE mieszaj wielu logicznych fixów w jeden commit (chyba że user wyraźnie chce 1).
- NIE rób deploy na GCP dla commitów które zmieniają tylko host-side / build-time pliki (np. `bootstrap-local-secrets.*`, `generate-internal-tls-ca.*`, `vite.config.ts`) — działający stack się nie zmienia. Commity są proaktywne.

## Przydatne `gh` CLI patterns (powstały z praktyki sesji 2026-06-16)

### Inline body w odpowiedzi (zamiast `-F "body=@<plik>"`)

Dla krótkich odpowiedzi (1-2 zdania) inline `-f body="..."` działa stabilnie
na Windows i nie wymaga pisania pliku do `%TEMP%`:

```bash
gh api -X POST repos/{owner}/{repo}/pulls/{n}/comments/{comment_id}/replies \
  -f body="Fixed in commit <sha>. <co się zmieniło, technicznie>."
```

Dla dłuższych treści (>3 zdania albo z backtickami/kodem) bezpieczniej jest
nadal zapisać do pliku i użyć `-F "body=@<plik>"` ze ścieżką Windows
(`/c/Users/.../AppData/Local/Temp/...`), bo inline potrafi mieć problemy
z escapowaniem.

### Komentarze zakotwiczone na starym commicie

Czasem komentarz nie pojawia się w `pulls/{n}/comments` (np. filtr po `path`
zwraca pustkę), ale istnieje — zakotwiczony do commita, który nie jest już
HEAD. Wtedy:

```bash
gh api repos/{owner}/{repo}/pulls/comments/{comment_id}
```

To zwraca pełny obiekt komentarza (`path`, `line`, `body`, `commit_id`,
`pull_request_review_id`). Niezbędne do:
- zweryfikowania, że komentarz istnieje i czego dotyczy,
- zacytowania go w commicie / odpowiedzi,
- wygenerowania odpowiedzi przez `POST .../comments/{comment_id}/replies`.

Nawet jeśli diff_hunk w odpowiedzi pokazuje stary kod, reply nadal trafia
do właściwego wątku i GitHub UI wyświetla go obok oryginału.

### Filtrowanie listy komentarzy `jq`

Listing dużego PR (50+ komentarzy) jest nieczytelny. Wzorce filtrujące:

```bash
# po ścieżce pliku
gh api repos/{owner}/{repo}/pulls/{n}/comments \
  --jq '.[] | select(.path == "backend/app/services/foo.py") | {id, line, body: (.body | .[0:200])}'

# po fragmencie treści (case-insensitive przez test("..."; "i"))
gh api repos/{owner}/{repo}/pulls/{n}/comments \
  --jq '.[] | select(.body | test("timezone|NTP|Warsaw"; "i")) | {id, path, line, body: (.body | .[0:200])}'

# po wielu ścieżkach
gh api repos/{owner}/{repo}/pulls/{n}/comments \
  --jq '.[] | select(.path | test("requirements.txt|staztysta"; "i")) | {id, path, body: (.body | .[0:150])}'
```

`(.|.[0:N])` obcina body do N znaków — wystarczające żeby rozpoznać
o czym jest komentarz, bez wczytywania pełnych treści do kontekstu.

### Diagnostyka "pustej listy"

Jeśli `pulls/{n}/comments` zwraca `[]`, ale user mówi "są nowe komentarze":
1. sprawdź `pulls/{n}/reviews` — może komentarze są w osobnym review
   (Copilot grupuje je w jedno review per runda);
2. sprawdź `issues/{n}/comments` — top-level issue comments (rzadko dla PRów);
3. fetchuj pojedynczo po ID jeśli user poda — komentarze na starym commicie
   mogą nie pojawiać się w listingu.

### Numeracja i thread

Komentarz Copilota ma `pull_request_review_id` i swój własny `id`.
Reply przez `POST .../comments/{comment_id}/replies` trafia do tego samego
wątku (anchor na ten sam `path`/`line`). Nie trzeba znać review_id.

### Minimalny reply template

```text
Fixed in commit <sha>. <co się zmieniło, technicznie, 1-3 zdania>.
```

Bez "Happy to follow up", "Let me know", "Thanks for catching this" — to szum
w wątku review. Suchy, techniczny, link do commita.
