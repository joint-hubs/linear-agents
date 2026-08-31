<tool name="graphify">

# graphify — dowolny materiał → graf wiedzy

Bierze zbiór wejść (kod, notatki, dokumenty, transkrypty) i buduje z nich graf wiedzy
z klastrami tematycznymi. Odpowiada na pytanie **„co się z czym łączy, o czym nie wiedziałem"**
— nie na „gdzie jest funkcja X" (do tego jest [code-intel](code-intel.md)).

<when_to_use>

- PLAN: przed dekompozycją dużego tematu — pokazuje, które obszary faktycznie się zazębiają
- CADENCE: przegląd korpusu notatek/dokumentów za okres, szukanie powtarzających się wątków
- REVIEW: mapa zależności tematycznych w dużej zmianie obejmującej wiele obszarów

Nie używaj do pytań o pojedynczy symbol albo plik. To narzędzie do **całych korpusów**,
kosztuje minuty, nie sekundy.

</when_to_use>

<invocation>

Graphify to **moduł Pythona**, nie CLI — wywołuje się go przez `python -c`. Pełna instrukcja
z gotowymi wywołaniami: `agents/orchestrator/skills/graphify/SKILL.md` (1225 linii, czytaj
dopiero gdy narzędzie faktycznie odpalasz).

Sprawdzenie dostępności:
```bash
python -c "import graphify" 2>NUL && echo OK
```

Zakres korpusu ustala `.graphifyignore` w korzeniu repo (semantyka jak gitignore, dodatkowo
dopasowuje pojedyncze segmenty ścieżki — samo `plugins` wycina każdą ścieżkę z segmentem
`plugins/`). Wyniki lądują w `graphify-out/<data>/` i **są gitignorowane** — to artefakt do
odtworzenia, nie do commitowania.

</invocation>

<cost_warning>

Przebieg na całym repo to minuty i realny koszt tokenów, jeśli włączysz warstwę LLM.
Zanim odpalisz: zawęź korpus w `.graphifyignore` i sprawdź, czy odpowiedzi nie da się
uzyskać z `code-intel` / `codegraph_explore` (sekundy) albo `flow-db patterns` (sekundy).

</cost_warning>

<availability>

Skill jest w `agents/orchestrator/skills/graphify/` — czyli w kontekście **orkiestratora**.
Składy (`plan`/`dev`/`review`/`test`/`cadence`) mają własny `CLAUDE_CONFIG_DIR` i tego
katalogu nie widzą, a do tego **nie mają narzędzia `Skill`**.

Praktycznie: skład z Bashem może odpalić graphify komendą, ale nie dostanie
auto-podpowiedzi ze skilla. Dlatego ten plik istnieje — żeby narzędzie dało się znaleźć
przez rejestr, a nie tylko przez przypadek.

</availability>

</tool>
