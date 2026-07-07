---
type: brainstorm
status: approved-v3 (decyzje rund 1–2 wiążące, 2026-07-03) — gotowe do dekompozycji
audience: Mateusz (iteracja) → potem PLAN squad (dekompozycja jako Draft w Linear)
topic: "scheduled learning" — mining transkryptów → playbooki → wyspecjalizowani sub-orkiestratorzy (MiniMax) nad workerami (DeepSeek)
related: ../decisions/cost-optimization.md (delegacja P0, worker/flash), brainstorm-autonomous-dispatch.md (konsument Draftów i bramek)
---

# Brainstorm B (v2) — warstwa specjalizacji uczona z historii

## Wizja
Cykliczny algorytm indeksuje historyczne sesje, grupuje pracę w powtarzalne TEMATY. Z tematu
powstaje najpierw **playbook** (destylowana procedura), a po sprawdzeniu — **specjalista**
(MiniMax) = sub-orkiestrator tematu, który rozpisuje robotę na tanich workerów (DeepSeek).
Mocne modele dysponują porządkiem; wykonanie schodzi w dół drabiny cenowej.

## Twarde ograniczenie (kształtuje design)
Subagent w Claude Code **nie spawnuje subagentów**. Wzorce hierarchii:
- **(a) Domenowy planista** *(default)*: lead → `Task(<domena>-specialist)` → specjalista zwraca
  **mikro-plan** (kontrakt niżej) → lead MECHANICZNIE wystrzeliwuje workerów per krok → surowe
  wyniki wracają do specjalisty (drugi Task: „scal") → lead dostaje pakiet. Lead płaci tylko za dispatch.
- **(b) Sub-squad procesowy** *(ciężkie tematy)*: specjalista dostaje własną sesję headless przez
  `/api/launch` (dispatcher z brainstormu A), z własnym CLAUDE.md i subagentami; komunikacja
  przez Linear/pliki.

## 1. Jednostka wiedzy: CHUNK (schemat)
Naturalną jednostką jest **brief delegacji** — z definicji Polityki delegacji samowystarczalny:
```json
{
  "chunkId": "run:<runId>:task:<n>",
  "squad": "dev", "role": "implementer", "model": "z-ai/glm-5.2",
  "brief": "<input Task toola — pełny prompt subagenta>",
  "resultSummary": "<pierwsze ~500 znaków odpowiedzi końcowej>",
  "toolsUsed": ["Read","Edit","Bash"], "turns": 14,
  "costUSD": 0.42, "ok": true,
  "taskId": "JOI-64", "ts": "..."
}
```
Źródło: transkrypty — tool_use `Task` (brief) + sidechain (przebieg, koszt per `agentId` — ledger
już to atrybuuje). Drugi typ chunka (v2+): **sekwencje leada** (co lead robił SAM między delegacjami)
— to jest kopalnia anty-wzorców (praca, która powinna była mieć rolę).

## 2. Miner — pipeline konkretnie (`scripts/learning-miner.mjs`, schedulowany co tydzień)
1. **Ekstrakcja**: przejdź transkrypty (parseTranscript + tool_use Task) → chunki → `.state/learning/chunks.jsonl` (append, idempotentnie po chunkId).
2. **Grupowanie**: start BEZ embeddingów — `flash`/`worker` (tani model) dostaje partie briefów
   i etykietuje tematami (taksonomia rośnie inkrementalnie: „linear-provisioning",
   „telemetry-smoke", „conventional-comments-merge"…). Embeddingi dopiero >500 chunków
   (wtedy: tanie embeddingi OR + próg kosinusowy jako pre-grupowanie, LLM tylko nazywa).
3. **Scoring**: per temat → `wystąpienia × koszt łączny × %-udziału-leada` (im wyżej, tym lepszy
   kandydat na playbook). Osobno: **anty-wzorce** (lead robił sam temat, który miał rolę) = audyt
   Polityki delegacji.
4. **Raport**: `.state/learning/<ISO-week>.md` — top-10 kandydatów z przykładami + trend kosztu
   tematów już pokrytych playbookami; sekcja w digeście CADENCE.
5. **Propozycja**: kandydat ≥3 wystąpień → miner destyluje DRAFT playbooka (flash: procedura
   krok-po-kroku z 3 realnych przebiegów, wspólne pułapki, format wyniku) → **Draft w Linearze**
   → Twoja labelka `go` (bramka z A) → materializacja.

## 3. Playbooki — pliki ON-DEMAND, nie balast kontekstu
**Zasada: playbook NIE wchodzi do CLAUDE.md** (to by tuczyło każdą sesję). Format:
- Plik: `agents/<squad>/playbooks/<slug>.md` — nagłówek (kiedy stosować, trigger-frazy),
  procedura kroków, znane pułapki, format wyniku, `staleAfter: <data>` (domyślnie +60 dni).
- W CLAUDE.md leada TYLKO indeks (1 linia/playbook): `- <slug>: <kiedy> → przeczytaj agents/<squad>/playbooks/<slug>.md`.
- Rola używająca playbooka drukuje marker **`##PLAYBOOK <slug>`** → mierzalność (grep w transkryptach:
  hit-rate, koszt tematu przed/po).
- Higiena P0: destylat **nigdy nie zawiera sekretów/wartości env** (miner skrubuje: wzorce kluczy,
  tokenów, URL-i z credencjałami); playbook po `staleAfter` → miner flaguje do re-walidacji.

## 4. Kontrakt mikro-planu (interfejs lead ↔ specjalista, wzorzec a)
Specjalista zwraca WYŁĄCZNIE JSON:
```json
{
  "theme": "telemetry-smoke",
  "steps": [
    { "id": "s1", "role": "flash",       "brief": "<samowystarczalny>", "expects": "<format wyniku>", "dependsOn": [] },
    { "id": "s2", "role": "worker",      "brief": "...",                "expects": "...",             "dependsOn": ["s1"] },
    { "id": "s3", "role": "debugger",    "brief": "...",                "expects": "...",             "dependsOn": ["s2"] }
  ],
  "mergeInstruction": "<jak specjalista ma scalić wyniki w pakiet dla leada>"
}
```
- `role` = ISTNIEJĄCE role squadu (worker/flash/implementer/debugger/…) — zero nowej hydrauliki;
  „więcej DeepSeeka" realizuje się przez role deepseek_pro/flash w krokach.
- Lead wykonuje kroki wg `dependsOn` (równolegle gdzie można), NIE czyta treści wyników — przekazuje
  je do specjalisty krokiem „scal wg mergeInstruction". Lead = tania pętla.
- Fail kroku → jedna powtórka → eskalacja do specjalisty (redesign kroku) → dopiero potem lead/eskalacja.

## 5. Specjalista — szablon materializacji
`agents/<squad>/agents/<domena>-specialist.md`: frontmatter `model: minimax/minimax-m3`,
`description:` trigger-frazy tematu (z klastra — to steruje wyborem przez Task tool);
body = wdestylowany playbook + twardy wymóg „odpowiadasz TYLKO kontraktem mikro-planu / scaleniem".
Wpis w `config/models.json` routing. **Powstaje wyłącznie z playbooka, który powtórzył się 3+ razy
z markerem `##PLAYBOOK`** — nie prosto z klastra.

## 6. Pętla pomiaru (czy uczenie działa)
- Miner co tydzień klasyfikuje NOWE runy do znanych tematów → trend $/temat (przed/po playbooku).
- Hit-rate playbooków (markery) i delegacja ≥40% (byAgent) w digeście CADENCE.
- Kryterium sukcesu S2: pierwszy playbook tnie koszt powtórki tematu o ≥30%.
- Kryterium S3: specjalista przejmuje temat end-to-end, udział leada w koszcie tematu <20%.

## 7. Dane wejściowe — jakość
- Miner uczy się z runów **zakończonych sukcesem** (exitCode 0 / task dowieziony); faile idą do
  osobnej sekcji „pułapki" (materiał do `znane pułapki` w playbookach, nie do procedur).
- Dane sprzed Polityki delegacji (do 2026-07-03) są zgrubne (briefów mało, lead mielił sam) —
  nadal wartościowe jako anty-wzorce i kalibracja taksonomii.

## 8. Fazy
| Faza | Zakres | AC |
|---|---|---|
| S1 miner+raport | chunks.jsonl + grupowanie flash + scoring + raport tygodniowy (read-only) | raport z ≥3 sensownymi kandydatami na realnych danych; zero zmian w agentach |
| S2 playbooki | destylacja → Draft→`go`→plik playbooka + indeks + marker `##PLAYBOOK` | pierwszy playbook: koszt powtórki tematu −30% |
| S3 specjaliści (a) | szablon specjalisty + kontrakt mikro-planu + routing w CLAUDE.md leada | temat obsłużony przez specjalistę; lead <20% kosztu tematu |
| S4 sub-squady (b) | ciężkie tematy przez /api/launch (wymaga dispatchera z A) | 1 temat wielofazowy end-to-end w osobnej sesji |

## 9. Decyzje rundy 2 (Mateusz 2026-07-03 — WIĄŻĄCE)
1. ✅ Grupowanie startowo **bez embeddingów** — flash etykietuje tematy; embeddingi dopiero >500 chunków.
2. ✅ Playbooki jako **osobne pliki on-demand** + 1-liniowy indeks w CLAUDE.md leada.
3. ✅ Zatwierdzanie: nowy playbook = Draft + labelka `go` → miner commituje plik; KAŻDA zmiana
   w `agents/` (specjalista) = normalny pipeline dev→review (pliki agentów to kod).
4. ✅ Pierwszy przebieg S1 od razu na obecnych 160+ transkryptach (kalibracja) + powtórka po 2 tyg.
