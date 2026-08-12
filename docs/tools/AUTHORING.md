<tool_authoring>

# Jak dołożyć narzędzie

Masz prawo tworzyć narzędzia. Zauważyłeś, że ta sama kosztowna operacja powtarza się
w kółko — to jest właśnie sygnał, że czegoś brakuje. Ale narzędzie, o którym nikt nie wie,
jest gorsze niż jego brak: kosztowało czas, a następny skład i tak zrobi to ręcznie.

Stąd te zasady.

<trigger>

## Kiedy proponować

**Ta sama kosztowna operacja trzeci raz w jednym przebiegu.** Nie za pierwszym — raz to
przypadek, dwa to zbieg okoliczności, trzy to wzorzec.

Kosztowna = wielokrokowa pętla Grep+Read, powtarzana ręczna analiza, komenda składana za
każdym razem od nowa z tych samych klocków.

**Nie proponuj**, gdy: robi to już coś z [rejestru](README.md) · to jednorazowy skrypt do
jednego zadania · wystarczy alias albo jedna komenda.

</trigger>

<procedure>

## Co zrobić

**Nie dopisujesz narzędzia do repo w środku przebiegu.** Zgłaszasz je w hand-offie jako
propozycję i idziesz dalej ze swoim zadaniem.

Propozycja zawiera:

1. **Problem** — co się powtarzało i ile razy w tym przebiegu
2. **Kontrakt** — nazwa, wywołanie, wejście, wyjście
3. **Alternatywa** — dlaczego istniejące narzędzia nie wystarczą (sprawdź rejestr, zanim to napiszesz)
4. **Koszt** — ile mniej więcej kosztuje to bez narzędzia

Gdy Mateusz zatwierdzi, narzędzie powstaje jako **komplet czterech rzeczy** — nie mniej:

| Element | Gdzie | Po co |
|---|---|---|
| skrypt | `scripts/<nazwa>.mjs` | samo narzędzie |
| test | `scripts/<nazwa>.test.mjs` | konwencja repo: liczniki `assert`/`assertEq`, IIFE, `process.exit(failed>0?1:0)` |
| dokument | `docs/tools/<nazwa>.md` | kiedy używać, jak czytać wynik, **czego narzędzie NIE potrafi** |
| wpis w rejestrze | `docs/tools/README.md` | jedna linia w tabeli — bez tego nikt go nie znajdzie |

Wpis w rejestrze jest tym, co odróżnia narzędzie od skryptu, który ktoś kiedyś napisał.

</procedure>

<doc_requirements>

## Czego wymaga dokument

Sekcja **„czego narzędzie nie potrafi"** jest obowiązkowa i najważniejsza. Narzędzie, które
milczy o swoich granicach, produkuje pewne siebie błędne odpowiedzi — a te kosztują więcej
niż brak narzędzia.

Wzorzec: `code-intel.md` ma sekcję o nieaktualnym indeksie, bo nieaktualny indeks zwraca
„not found" dla czegoś, co istnieje. Bez tego ostrzeżenia agent zaraportowałby, że funkcji
nie ma.

</doc_requirements>

<hard_boundary>

## Granica, której nie przekraczasz

**Możesz tworzyć narzędzia. Nie zmieniasz własnych instrukcji.**

Skrypt w `scripts/` to przyrost możliwości: odwracalny, widoczny w diffie, pokryty testem.
Edycja własnego `CLAUDE.md` albo pliku roli to zmiana reguł przez tego, kogo one ograniczają —
i nie ma jak tego zrecenzować z zewnątrz, bo recenzent czyta już zmienione reguły.

Zmiany w `agents/**` proponujesz Mateuszowi. Zawsze.

</hard_boundary>

</tool_authoring>
