---
name: delivery-loop
description: >
  Definition of Done for any code change in Mateusz's projects. Use AFTER implementing a
  feature/fix and BEFORE saying "gotowe/done/działa", and whenever the user asks "zrobiłeś
  rebuild?", "czy mogę testować?", "zdeployuj", "redeploy", "coś nie działa, przetestuj".
  Covers: self-verification, docker rebuild+redeploy, release packaging, ACCESS.md, and the
  final "jak przetestować" message.
---

<checklist>

- Zbuduj/uruchom to, co zmieniłeś.
   - Projekt dockerowy: `docker compose up -d --build <service>` (lub pełny rebuild, jeśli zmiana
     dotyka wielu serwisów). Zmiana w frontendzie z bundlerem = rebuild obrazu, nie tylko restart.
   - Skrypt/CLI: uruchom go naprawdę (z flagą --dry-run, jeśli istnieje).
- Zweryfikuj sam — zanim odda to użytkownik:
   - sprawdź logi kontenera/procesu z ostatnich minut (błędy startu, tracebacki),
   - strzel w endpoint (`curl`) albo przeklikaj flow w przeglądarce, jeśli masz narzędzia,
   - przetestuj DOKŁADNIE ścieżkę użytkownika, której dotyczyła zmiana (np. login przez
     Keycloak, upload dokumentu, streaming odpowiedzi) — nie tylko health-check.
   - Dla zmian w auth / nginx / Keycloak / OIDC / routingu / deployu sprawdź CAŁĄ ścieżkę
     żądania end-to-end: routes → zmienne env → ścieżki TLS → URL-e OIDC/redirect → tokeny →
     routing nginx (czy ruch idzie do właściwego serwisu, nie np. do React SPA zamiast backendu).
     Większość kaskadowych bugów wdrożeniowych była tu — sprawdź `office/docs/GOTCHAS.md`
     (znane pułapki projektu) i sekcję 13 w `office/CLAUDE.md` przed zgłoszeniem „działa".
- Jeśli projekt ma artefakt release (paczka zip, obraz do USB/airgap — np. office):
   zaktualizuj paczkę po zmianie kodu albo wprost powiedz, że paczka jest STARA.
- Jeśli zmieniłeś dostępy (użytkownik, hasło, port, URL, realm): zaktualizuj `docs/ACCESS.md`.
- Zaproponuj commit zgodnie ze skillem `git-checkpoint` (logiczne batche) — ale NIE commituj
   bez wyraźnego „commituj".
- Raport końcowy (krótko):
   - co zmienione (1-3 punkty),
   - co ZWERYFIKOWANE i jak (np. "curl /api/v1/search → 200, streaming działa token po tokenie"),
   - "Jak przetestować": dokładne kroki dla Mateusza (URL, login → skąd wziąć, co kliknąć),
   - co świadomie pominięte / znane ograniczenia.
</checklist>

<rules>
Zakazy:
- NIE mów "gotowe/działa", jeśli nie wykonałeś kroku 1 i 2. Jeśli nie możesz czegoś zweryfikować
  (brak narzędzia, brak dostępu) — napisz to wprost: "kod zmieniony, NIE zweryfikowałem X, bo Y".
- NIE każ użytkownikowi testować na starym buildzie. Najpierw rebuild, potem "możesz testować".
- NIE zostawiaj danych logowania w odpowiedzi czatu jako jedynym miejscu — zapisz do ACCESS.md.
</rules>