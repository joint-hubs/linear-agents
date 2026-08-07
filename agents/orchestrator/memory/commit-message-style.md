---
name: commit-message-style
description: Twarda zasada — commity MUSZĄ być suche (tylko co się zmieniło), bez "Co-Authored-By: Claude", bez dygresji, bez "verified", bez "sorry". Dotyczy WSZYSTKICH commitów które piszę (nie tylko w PRach).
metadata:
  type: feedback
---

<message_style>
- `<type>(<scope>): <subject>` (max ~50 znaków, imperative mood, lowercase)
- Body: suchy opis CO się zmieniło i DLACZEGO w sensie technicznym
  - Która funkcja/zmienna/plik, jaka zmiana, jaki edge case
  - Numer linii (np. `auth.py:42` — stary kod, `auth.py:45` — nowy kod)
  - Symbole techniczne (np. `with set -u, $FORCE` referenced an unbound variable`)
- Numeracja kroków: `# 1.`, `# 2.` jeśli zmiana ma wiele etapów w jednym pliku
- Listing zmienionych symboli/wartości (np. `--force → --force-ca --renew-leaf`)
</message_style>

<forbidden_text>
- `Co-Authored-By: Claude <noreply@anthropic.com>` trailer
- Jakiekolwiek wzmianki że AI/Mateusz/Claude naprawiło coś (np. "I fixed this", "Address Copilot review on PR #12", "AI-assisted")
- "Sorry", "Apologies", "Should have caught" — dygresje emocjonalne
- "Verified locally", "Tested manually", "Smoke-tested" — to nie jest opis zmiany, tylko dowód
- "Happy to follow up", "Open for discussion", "Out of scope for this PR" — CTA/akcje, nie opis zmiany
- "Note:", "Note that" — tagi informacyjne, lepiej wcielić w treść
- Cytaty z Copilot review (np. `> The script regenerates the root CA...`) — nie są twoje, nie powtarzaj ich
</forbidden_text>

<related>
- [[github-pr-workflow]] — cały cykl obsługi PR
- [[workflow]] — ogólny styl pracy z userem
</related>