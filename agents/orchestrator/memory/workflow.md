# Jak pracuje Mateusz (szczegóły)

**Esencja:** głosowe prompty → wymagania w punktach → pytania paczką → PRD → implementacja →
samodzielny test → rebuild/redeploy → instrukcja jak przetestować → git w logicznych batchach.

## Komunikacja
- Prompty z Wispr Flow: długie, potok myśli, bez interpunkcji. Najpierw sparafrazuj jako
  listę wymagań/decyzji; niejasności zbierz w JEDNĄ listę pytań (on odpowiada zbiorczo inline).
- Odpowiedzi krótkie i konkretne; frustruje go verbose i "śmieci".
- Wkleja screenshoty UI i surowe błędy (np. JSON z API) zamiast opisu — traktuj to jako bug report.

## Czego oczekuje, a o czym agent zapominał (z historii sesji)
1. Po zmianie kodu w projekcie dockerowym: **rebuild + redeploy bez pytania** — inaczej testuje starą wersję.
2. **Przetestuj sam** (logi kontenerów, curl na endpoint, login flow), zanim powiesz "działa".
3. Po skończonym etapie: **commit w logicznych batchach**, styl message dopasowany do historii repo; na koniec większej pracy zaproponuj PR.
4. Prowadź listę tasków i **odhaczaj na bieżąco** — zwraca uwagę na nieodhaczone.
5. Dane dostępowe (user/hasło dev, porty, URL-e) → `docs/ACCESS.md` w repo; aktualizuj gdy się zmieniają. Pytanie "jak się zalogować?" = porażka systemu.
6. Sesje często wypadają z kontekstu — przy dłuższej pracy utrzymuj krótki stan w `docs/STATE.md` (co zrobione / co w toku / jak uruchomić), żeby następna sesja startowała tanio.

## UX/produktowe stałe
- Użytkownicy końcowi AU: urzędnicy 40-60 lat → prosty UX, metafora kafelków/pulpitu Windows, duże ikony, pomoc rozwijana w aplikacji.
- Nigdy ciemny tekst na ciemnym tle; spójny kolor tła między podstronami.
- Konfiguracja aplikacji przez env/pliki dla DevOpsa, NIE przez panel admina w UI.
- Bezpieczeństwo: Keycloak/OIDC jako warstwa logowania we wszystkich produktach; osobne stacki = osobne compose.

## Narzędzia
- **graphify** (`$LA_ROOT/agents/orchestrator/skills/graphify/SKILL.md`) — zamienia dowolny input (kod, logi, opis) na graf wiedzy. Używaj gdy analizujesz dużą bazę kodu i chcesz precyzyjnie zobaczyć powiązania (np. „jakie funkcje wołają `_sse`", „co importuje `anonymization_service`"). Szczególnie przydatne przy refaktorach i audytach, gdzie zwykły Grep/Read nie wystarcza.
