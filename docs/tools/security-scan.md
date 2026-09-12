<tool name="security-scan">

# security-scan — provisionowane skanery bezpieczeństwa dla REVIEW (FOC-285)

Jedno wywołanie, dwa typy skanerów: **secret scanning** (secretlint) i **SAST** (semgrep).
Naprawia finding **F-09** reviewa FOC-272: skanery były obiecane w regułach (`agents/review/agents/security.md`)
i na allow-liście (`agents/review/settings.json`), ale nigdy nie były provisionowane ani wywołane —
zero wywołań skanerów w całym korpusie. Reguła „security by tools" była nie do spełnienia, bo nie było czym.

<when_to_use>

- REVIEW pass `security` — **obowiązkowy pierwszy krok** przed analizą modelową (kontrakt: `agents/review/CLAUDE.md`).
- DEV — przed hand-offem zmiany, która mogła dotknąć sekrety albo SQL/shell (opcjonalne, ale tanie: ~10 s).
- Każdy, kto chce sprawdzić drzewo na wyciekłe sekrety.

Nie używaj do: skanowania zależności pod kątem CVE (SCA — narzędzie spoza tego provisioningu;
`docs/tools/README.md` nie ma jeszcze takiego narzędzia).

</when_to_use>

<invocation>

```bash
node scripts/security-scan.mjs                # cały git-tracked tree (tryb domyślny)
node scripts/security-scan.mjs --json         # czysty JSON na stdout (maszynowalny)
node scripts/security-scan.mjs --output .state/security-scan.json   # raport do pliku
node scripts/security-scan.mjs --root <dir>   # fixture mode: raw walk, bez gitignore
```

Exit: `0` czysto · `1` findings · `2` skaner niedostępny (dowody niekompletne) · `3` scope unavailable.

Wyjście: **file:line + rule id + severity — nigdy wartość trafienia**. Komunikaty secretlinta osadzają
dopasowany sekret, więc wrapper ich nie echo-uje; reviewer otwiera plik w cytowanej linii (AC4 FOC-285).
Skaner, który nie odpalił, dostaje wiersz `NOT SCANNED <tool>` i exit 2 — nigdy nie jest „czysto".

</invocation>

<provisioning>

Reprodukcja z czystego checkoutu (Windows-first; bez interaktywnego auth, bez credentiali):

```bash
npm install                      # secretlint (@secretlint/core, @secretlint/config-loader,
                                 # @secretlint/secretlint-rule-preset-recommend ^13.0.5) —
                                 # devDependencies z committed package-lock.json
pip install semgrep==1.172.0     # SAST; wersja pinned w tym dokumencie i w komunikacie błędu wrapperka
```

- **Kredentiale: brak.** Oba skanery pracują lokalnie; nic nie trafia do `docs/ACCESS.md`, bo nic nie potrzebuje dostępu.
- **Sieć:** wyłącznie istniejące założenia repo (npm registry, PyPI — ten sam kanał, z którego już korzysta
  `requirements.txt`). Reguły semgrep są **committed lokalnie** (`config/security/semgrep-rules.yml`) —
  wrapper nigdy nie woła `--config auto` ani registry (`p/...`), metryki off (`--metrics=off`,
  `SEMGREP_SEND_METRICS=off`). Po provisioning skan jest offline i deterministyczny.
- Weryfikacja instalacji: `node scripts/security-scan.mjs` z roota repo — `OK: N files, 2 scanners, 0 findings`.

Uwaga implementacyjna: wrapper steruje `@secretlint/core` bezpośrednio (ścieżka programistyczna), a nie CLI
`secretlint` — w v13.0.5 na Windows CLI ładuje preset bez rozwinięcia child-rules i **po cichu zwraca zero
trafień**, co jest gorsze niż błąd. Dlatego `secretlint` (CLI) nie jest w devDependencies.

</provisioning>

<tools_choice>

Wybrane: **secretlint** (sekrety) + **semgrep** (SAST). Oba działają natywnie na Windows headless,
bez auth, bez nowych założeń sieciowych.

Odrzucone:
- **gitleaks** — dedykowany, w branży standard, na allow-liście review (`Bash(gitleaks:*)`), ale
  provisioning na Windows = binary z GitHub releases albo menedżer pakietów (scoop/choco) — global/system
  install poza istniejącym toolchainem repo (npm/PyPI). To osobna decyzja; jeśli Mateusz woli gitleaks,
  wymiana sprowadza się do podmiany implementacji `scanSecrets()` w `scripts/security-scan.mjs`
  i aktualizacji tego dokumentu.
- **detect-secrets** (pip) — mocny alternatywny skaner sekretów, ale nieobecny na allow-liście review
  (wymagałby dopisania uprawnienia) i nie dodaje niczego wobec secretlint na tym stacku.
- **trivy** — SCA/vuln scanning, nie SAST/sekrety w rozumieniu F-09; dodatkowo binary install (poza npm).
- **snyk** — wymaga konta i credentials → ACCESS.md + gate; poza zakresem.
- **ruff** — linter Pythona; repo jest JS/TS (`.mjs`, `.jsx`) — zły instrument na SAST tutaj.

Preset secretlinta (`preset-recommend`) z jawnie włączonym `enableIDScanRule` dla reguły AWS
(domyślnie off, bo gołe wzorce AKIA false-positive'ują — tutaj świadomie włączamy: goły key ID bez
kontekstu to dokładnie to, co skaner ma łapać).

Ruleset semgrep: 7 reguł JS/TS pod klasy z kontraktu security pass — eval/`new Function`, command
injection (exec+concat, spawn shell:true), SQL injection (taint: `process.argv`/`req.*` → `prepare`/`exec`),
XSS (`dangerouslySetInnerHTML`), path traversal (`path.join` z `req.*`). Reguła SQL jest w trybie **taint**:
interpolacja stałych schematu (np. `ALTER TABLE ... ADD COLUMN ${name}` z `RUN_COLUMNS`) jest wzorcem
repo i nie jest flagowana — tylko przepływy z danych zewnętrznych.

</tools_choice>

<limitations>

- Scope domyślny = git-tracked pliki tekstowe (binaria >8 KiB z NUL i pliki >1 MiB są pomijane i policzone
  w raporcie). Gitignored content (`.env`, node_modules, `.state`) nigdy nie jest skanowany.
- semgrep w trybie git respektuje własną kaskadę ignorów (zbieżna z lint.mjs); w trybie `--root` jawnie ją
  wyłącza (`--no-git-ignore`), żeby fixture pod `.state/` dało się skanować.
- To nie jest diff-scan ani skan historii gita — skanuje stan drzewa. Historia (wycieki w starych
  commitach) jest poza zakresem tego provisioningu.
- sekrety testowe w `scripts/security-scan.test.mjs` są składane w runtime z rozbitych literałów,
  żeby plik testowy sam nie świecił na repo-wide skanie.

</limitations>

</tool>