<tool_registry>

# Rejestr narzędzi

Jedno miejsce, w którym każdy skład sprawdza, **co już istnieje**, zanim zacznie robić coś
drogo albo ręcznie. Ten plik jest krótki celowo — jedna linia na narzędzie. Szczegóły są
w `docs/tools/<nazwa>.md` i czytasz je dopiero, gdy narzędzie faktycznie bierzesz do ręki.

Zasada: **zanim napiszesz pętlę Grep+Read albo powtórzysz tę samą komendę trzeci raz —
sprawdź tutaj.**

<available_tools>

| Narzędzie | Do czego | Wywołanie | Szczegóły |
|---|---|---|---|
| **code-intel** | „gdzie jest X", „co woła Y", „co pęknie, jak zmienię Z" — z grafu kodu, zamiast przeszukiwania plików | `mcp__codegraph__codegraph_explore` lub `node $LA_ROOT/scripts/code-intel.mjs <explore\|symbol\|impact\|callers\|callees\|find\|files\|affected>` | [code-intel.md](code-intel.md) |
| **graphify** | dowolny zbiór materiałów (kod, notatki, dokumenty) → graf wiedzy + klastry tematyczne | moduł Pythona, patrz dokument | [graphify.md](graphify.md) |
| **linear-query** | odczyt z Linear (issues, issue, comments, search, team) | `node $LA_ROOT/scripts/linear-query.mjs ...` | `--help` |
| **linear-ops** | zapis do Linear (transition, label, comment) | `node $LA_ROOT/scripts/linear-ops.mjs ...` | `--help` |
| **dev-branch** | branch per task w repo zadania | `node $LA_ROOT/scripts/dev-branch.mjs ...` | `--help` |
| **flow-db** | historia przebiegów: trace per task, odbicia REVIEW→DEV, koszt per krok | `node $LA_ROOT/scripts/flow-db.mjs <ingest\|trace\|patterns>` | `--help` |
| **run-manifest** | rejestracja przebiegu w telemetrii | `node $LA_ROOT/scripts/run-manifest.mjs ...` | `--help` |
| **publish-linear-comment** | komentarz hand-off do Linear (idempotentny) | `node $LA_ROOT/scripts/publish-linear-comment.mjs ...` | `--help` |

</available_tools>

<adding_a_tool>

## Zauważyłeś, że czegoś brakuje?

Jeśli ta sama kosztowna operacja powtórzyła się **trzy razy w jednym przebiegu** — to sygnał,
że brakuje narzędzia. Nie dopisuj go po cichu do repo. **Zaproponuj je w hand-offie**, wg
[AUTHORING.md](AUTHORING.md).

Powód rozdzielenia: narzędzie, które powstaje w środku przebiegu, nie ma testu, nie ma
recenzji i nikt poza Tobą nie wie, że istnieje. Trzy takie i `scripts/` zmienia się w
cmentarz jednorazowych pomocników.

</adding_a_tool>

</tool_registry>
