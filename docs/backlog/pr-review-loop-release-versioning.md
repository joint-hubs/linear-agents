---
type: feature-brief
status: backlog
area: review + release/uat
applies-to: Fenix (workflow capability); pilot ground-truth = fenix (ręczne PR-y już tak prowadzone)
tags: [type/feature-brief, topic/linear, topic/pull-request, topic/copilot, topic/release, topic/uat]
created: 2026-06-23
source: notatka głosowa Mateusza
maturity: brief-v1
---

# Feature (backlog) — PR-driven iterative review + release versioning + UAT sign-off

> „Na później". Z notatki głosowej. Rozszerza obszary REVIEW i TEST o realny przepływ przez
> **Pull Requesty + GitHub Copilot** (iteracyjnie), z **człowiekiem jako sędzią**, oraz dokłada
> **wersjonowanie releasów per sesja QA/UAT** i **dual sign-off** (owner techniczny + biznesowy).
> Mateusz już robi to **ręcznie** w feniksie — stare PR-y są prowadzone dokładnie w ten sposób (ground truth).

## 1. Problem / cel
Dziś REVIEW = wewnętrzny squad. Realnie chcemy, żeby przejście **In Progress → In Review** uruchamiało
**PR**, a review toczyło się iteracyjnie z Copilotem aż do „czystego" PR-a, z Mateuszem jako arbitrem,
a gotowe rzeczy były **grupowane w wersje per sesja QA/UAT** i potwierdzane przez ownerów.

## 2. Pożądany przepływ (jak prowadzone ręcznie)
1. Agent twierdzi, że task zrobiony → **In Progress → In Review** ⇒ **tworzy PR** + opis (co/dlaczego/jak testować/AC).
2. PR ⇒ **GitHub Copilot review** (automat).
3. Agent czyta komentarze Copilota → **odpowiada poprawkami** → push ⇒ Copilot re-review ⇒ **pętla**, aż PR „czysty" (Copilot bez znaczących uwag) = mergeable.
4. **Mateusz = sędzia**: per uwaga Copilota decyduje **fix (z powrotem do developera)** albo **akceptuję trade-off**.
5. Po czystym/zmergowanym PR ⇒ Linear label **`QA candidate`** (labelka już istnieje).
6. **Wersjonowanie release**: tworzy się wersja; **feature'y wychodzące do jednej sesji QA/Q&A/UAT dostają tę samą labelkę wersji**.
7. **Dual sign-off**: **owner techniczny + owner biznesowy** potwierdzają „działa" (UAT) ⇒ dopiero wtedy domknięte/released.

## 3. Wymagania
- **R1** Auto-PR na In Progress→In Review (z opisem + link do Linear issue).
- **R2** Iteracyjna pętla Copilot↔agent aż do czystego PR-a (loop-limit + escalation jak w P0).
- **R3** Człowiek-sędzia nad uwagami Copilota (fix vs accept trade-off).
- **R4** Po merge → label `QA candidate`.
- **R5** Wersja per sesja QA/UAT — wspólna labelka wersji dla feature'ów z tej samej sesji.
- **R6** Dual sign-off (tech owner + biz owner) jako warunek „released".

## 4. Jak wpina się w obecny design
| Element | Zmiana |
|---|---|
| **DEV → REVIEW** | na handoffie: `gh pr create` (PR template, branch nazwany od issue → auto-link Linear) |
| **REVIEW squad** | nowy/rozszerzony przepływ PR-centryczny; **Copilot jako reviewer**; nowa rola **`pr-responder`** iterująca po komentarzach. Otwarte: jak komponować nasz wewnętrzny squad (first-pass/security/deep) z Copilotem (zamiast / przed / równolegle) |
| **HITL (sędzia)** | bramka `needs:decision` + emoji: fix → In Progress / accept → dalej |
| **Linear states/labels** | + `QA candidate`; grupa `version:`/`release:`; `signoff:tech` + `signoff:biz`; PR jako attachment na issue |
| **TEST squad** | deploy zasila sesję QA/UAT; zdeployowana wersja = nośnik labelki wersji |
| **Nowy etap RELEASE/UAT** | po TEST: grupowanie w wersję → UAT → dual sign-off → `Released`/`Done` |
| **Diagramy** | aktualizacja `04_review_test` (PR+Copilot loop + sędzia) i `01_state_machine` (QA candidate, version, sign-off); ew. nowy `07_pr_release_uat` |
| **Signaling protocol** | nowe labelki + `needs:decision`; emoji-arbitraż na komentarzach Copilota |

## 5. Nowe elementy Linear (do `config/linear/labels.json` + bootstrap)
- Label `QA candidate` (istnieje — zmapować).
- Grupa `version:` (np. `version:2026.07-uat1`) — wspólna dla feature'ów jednej sesji QA/UAT.
- Flagi `signoff:tech`, `signoff:biz` (oba ⇒ released).
- (opcjonalnie) stan `Released` lub label zamiast stanu (anty-over-engineering).

## 6. Otwarte pytania (decyzje na „później")
1. **Copilot vs wewnętrzny REVIEW squad** — Copilot zastępuje, uzupełnia, czy leci po naszym tanim first-pass?
2. **Schemat wersji** — semver? data? `version:<uat-session>`? Jak identyfikujemy „sesję QA/UAT" (Linear Cycle? Milestone? data?).
3. **Gdzie żyją wersje** — grupa labelek Linear vs Linear Releases/Projects vs git tags.
4. **Zapis sign-off** — 2 labelki + assignee, czy natywne approvals Linear; kto = tech owner, kto = biz owner (per projekt).
5. **Które projekty** — najpierw fenix (ground truth), potem inne; toggle per projekt w `config/projects.json`.
6. **Merge policy** — auto-merge po czystym PR + akceptacji sędziego, czy zawsze ręcznie; base branch; PR template.
7. **Kolejność** — PR clean → merge → `QA candidate` → deploy → UAT sign-off → Released? (potwierdzić).

## 7. Pierwsze kroki (gdy ruszymy)
1. Wyciągnąć 1–2 realne PR-y z fenixa (`gh pr list`) → odtworzyć dokładny wzorzec pętli Copilota jako kontrakt `pr-responder`.
2. Dodać labelki/grupy do `config/linear/labels.json` + `bootstrap-linear.mjs`.
3. Rola `pr-responder` + krok `gh pr create` (PR template, link do issue).
4. Bramka sędziego (`needs:decision`) + dual sign-off (oba `signoff:*` ⇒ Released).
5. Wersjonowanie: krok nadający `version:<sesja>` feature'om z danego okna QA/UAT.
6. Update diagramów (04, 01, +07) i PRD-review/PRD-testing.
