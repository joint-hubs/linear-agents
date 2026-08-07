# Slajdy prezentacyjne (Projector Global Community)

Pięć grafik 16:9 (1600×900) gotowych do wrzucenia na slajd. Każda w dwóch formatach:
`.svg` (edytowalny, ostry w każdej skali) i `.png` (2× = 3200×1800, pewny import do Canvy).

| Plik | Slajd | Kiedy w talku |
|---|---|---|
| `00-hook-koszt-commita` | Ile kosztowała mnie jedna zmiana w kodzie | **otwarcie — przed przedstawieniem się** |
| `0-o-mnie` | Kim jestem | zaraz po hooku |
| `4-warstwy-zaufania` | Zaufanie = warstwy weryfikacji | po historii Lebombo→pismo→algorytmy, przed demo |
| `1-anatomia-skladu` | Anatomia składu + rachunek kosztów | wprowadzenie do demo |
| `2-zycie-taska` | Życie jednego taska (swimlane) | tuż przed demo — mapa tego, co zaraz zobaczą |
| `3-handoff-przez-linear` | Handoff przez Linear, nie przez czat | po demo, jako wyjaśnienie „dlaczego to się nie rozsypuje” |

Wersje techniczne tych samych treści (do repo, nie na scenę):
`docs/diagrams/07_squad_anatomy.puml`, `08_task_lifecycle.puml`,
`09_linear_handoff.puml`, `10_trust_layers.puml` (+ wyrenderowane `.png`).

---

## Slajd „o mnie" — skrypt mówiony (~75 sekund)

> Nazywam się Mateusz Stachowicz. Z wykształcenia jestem statystykiem — matematyka,
> statystyka, programowanie w R. Przez osiem lat przeszedłem całą drogę: analiza biznesowa,
> data science, modele uczenia maszynowego, wdrażanie ich na produkcję, MLOps, DevOps,
> czasem nawet specyfikacja sprzętu. Około pięciuset proof of conceptów. Ponad dziesięć
> aplikacji produkcyjnych — od takich z jednym użytkownikiem po takie z tysiącami.
>
> Robiłem to dla Roche, gdzie zaczynałem jako inżynier R, a skończyłem wdrażając modele
> na produkcję. Dla Hitachi pracuję nad aplikacją AI-native w sektorze kolejowym — nad
> agentami, o szczegółach nie mogę mówić. Z WSKM w Koninie budujemy AI Lab.
>
> A teraz rzecz, której zwykle się nie mówi ze sceny. Python jest lepszym narzędziem do
> budowy oprogramowania niż R, w którym wyrosłem. Proof of concept napiszę sam. Ale kodu
> produkcyjnego na poziomie zawodowego programisty — dopiero się uczę. I zamiast udawać,
> że tej luki nie ma, zrobiłem coś innego: zbudowałem system, który tę pracę weryfikuje
> za mnie. Nie musiałem stać się seniorem w Pythonie. Musiałem stać się właścicielem
> weryfikacji. O tym jest cała dzisiejsza prezentacja.
>
> Ostatnia rzecz, dla uczciwości. jointhubs przez kilka lat generował wyłącznie koszty —
> umowy zlecenie, narzędzia, chmura, zero przychodu. Dopiero w tym roku ruszyło pierwsze
> wdrożenie, w urzędzie w Lublińcu. Czyli po raz pierwszy zwrot z tej inwestycji jest
> większy od zera. Dzisiaj pokażę wam stack, na którym to powstaje.

### Warianty długości

- **30 s:** akapit pierwszy (skrót do dwóch zdań) + akapit trzeci. Luka i weryfikacja to
  jedyna rzecz, która musi wybrzmieć — reszta to kontekst.
- **2 min:** dołóż konkret z Roche (co dokładnie wdrażałeś) i jedno zdanie o tym, po co
  powstał Asystent Urzędnika.

### Czego na tym slajdzie świadomie nie ma

- Kwot wydatków w złotówkach — „kilka lat samych kosztów" niesie ten sam przekaz i nie
  otwiera dyskusji o cudzych budżetach.
- Nazwy ELMIKO i szczegółów tradingu — to rozmowy w toku, nie wyniki. Jeśli padnie pytanie
  z sali, wtedy powiedz, że neurohubs jest w rozmowach komercjalizacyjnych.
- Czegokolwiek objętego NDA po stronie Hitachi.
