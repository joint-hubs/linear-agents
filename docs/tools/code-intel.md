<tool name="code-intel">

# code-intel — pytania o strukturę kodu bez czytania kodu

Opakowuje graf GitNexus (3399 symboli, 6500 relacji, 289 przepływów). Odpowiada na pytania
strukturalne **jednym wywołaniem**, zamiast wyprawy Grep + Read po kilkunastu plikach.

<when_to_use>

Zanim zaczniesz przeszukiwać repo, zadaj sobie pytanie: czy szukam **struktury** czy **treści**?

- struktura (gdzie to jest, co to woła, co od tego zależy) → **code-intel**
- treść (jaki dokładnie tekst jest w linii 40) → Grep/Read

Rola `recon` powinna zaczynać stąd. Przeczytanie piętnastu plików, żeby odpowiedzieć „gdzie
leży obsługa X", to najdroższy wzorzec w tym repo.

</when_to_use>

<commands>

```bash
node $LA_ROOT/scripts/code-intel.mjs find "obsługa promptów"    # przepływy wokół pojęcia
node $LA_ROOT/scripts/code-intel.mjs symbol writeSquadConfig    # kto woła, co woła, w jakich procesach
node $LA_ROOT/scripts/code-intel.mjs impact graphql             # co pęknie przy zmianie
node $LA_ROOT/scripts/code-intel.mjs path validateLaunch spawnLauncher   # najkrótsza ścieżka wywołań
node $LA_ROOT/scripts/code-intel.mjs cycles                     # cykle importów
node $LA_ROOT/scripts/code-intel.mjs status                     # czy indeks jest świeży
```

Flagi: `--json` (wynik maszynowy), `--repo <nazwa>` (gdy zaindeksowano wiele repo).

</commands>

<reading_the_output>

`impact` zwraca `risk` (HIGH/MEDIUM/LOW) i `impactedCount`. HIGH przy 20+ symbolach znaczy,
że zmiana dotyka szerokiej powierzchni — to sygnał, żeby najpierw napisać test, a nie żeby
się wycofać.

Gdy nazwa jest niejednoznaczna (`status: "ambiguous"`), narzędzie zwraca listę kandydatów
z osobnym promieniem rażenia dla każdego. Doprecyzuj przez `file_path`, nie zgaduj.

</reading_the_output>

<critical_limitation>

**Indeks bywa nieaktualny i wtedy kłamie w jedną stronę.**

Jest budowany przy `analyze` i nie odświeża się sam. Symbol dodany po ostatnim indeksowaniu
zwróci **„not found"** — czyli odpowiedź brzmiącą pewnie i będącą fałszem.

Narzędzie samo ostrzega na stderr, gdy indeks jest starszy niż HEAD. **Gdy zobaczysz to
ostrzeżenie, traktuj każdy negatywny wynik jako NIEWIADOMĄ, nie jako brak** — potwierdź
Grepem, zanim napiszesz w raporcie, że czegoś nie ma.

Odświeżenie (kilkadziesiąt sekund): `node .gitnexus/run.cjs analyze`

`.gitnexus/` jest gitignorowany, więc po świeżym klonie indeksu nie ma w ogóle — narzędzie
powie to wprost i wyjdzie z kodem 3.

</critical_limitation>

<example>

Zadanie: „sprawdź, czy da się bezpiecznie zmienić `graphql`".

```
$ node $LA_ROOT/scripts/code-intel.mjs impact graphql
{ "status": "ambiguous", "totalCandidates": 3,
  "message": "max 23 impacted at risk HIGH" ... }
```

Wniosek w jednym wywołaniu: są trzy różne `graphql`, największy ma 23 zależne symbole i
ryzyko HIGH. Bez tego trzeba by przeszukać repo i przeczytać kilka plików, żeby dojść do
tego samego.

</example>

</tool>
