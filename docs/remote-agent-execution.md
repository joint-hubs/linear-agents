---
type: design-doc
status: active
tags: [type/design-doc, area/devops, topic/agents, topic/github-actions, topic/headless, topic/vm]
created: 2026-06-23
maturity: design-v1
---

# Remote agent execution — spawn agentów z GitHub Actions na VM (headless)

> Cel: z GitHub Actions (ręcznie, `workflow_dispatch`) **odpalić agenta lub cały stack** (np. planowy)
> **na VM-ce GCP**, z wybraną konfiguracją (projekt, basis = link do taska / nazwa featura). Agent
> headless wczytuje basis (np. task z brainstormem + załącznikami) i pracuje wg swojego CLAUDE.md.
> Komplementarne do `docs/ci-cd.md` (deploy): razem = **GitHub Actions = manualny control-plane (deploy + spawn agentów)**.

## 1. Dwie twarde konsekwencje (zmieniają design — przeczytaj)
1. **Headless = brak interaktywnego plan-mode.** Agent na VM nie ma TUI do „✅ approve plan". HITL musi iść **w pełni async przez Linear** (agent: post planu w komentarzu + `needs:approval` → checkpoint/sleep → wznowienie po ✅/webhooku). To dokładnie po to powstał signaling-protocol — tu się spłaca. DEV: plan-mode → zastąpione bramką Linear.
2. **Subskrypcja Anthropic NIE działa dobrze headless na VM** (login OAuth subskrypcji jest interaktywny, związany z maszyną/sesją). ⇒ **agenci na VM = OpenRouter** (token). Profil **native/subskrypcja = tylko lokalne interaktywne odpalenia** (zgodne z ADR-0001: native lane = local). VM dziedziczy „openrouter" routing z `models.map`.

## 2. Architektura
```
Mateusz → GitHub Actions (workflow_dispatch: stack, project, basis) 
        → runner self-hosted NA VM (GCP)  [rekomendacja]
        → bin/run-agent.sh <stack> <project> --issue <id> --mode <...>
        → claude headless (Agent SDK / `claude -p`), CLAUDE_CONFIG_DIR=agents/<stack>, detached (tmux/systemd-run)
        → agent czyta basis (Linear issue + załączniki / feature) → pracuje → pisze do Linear (needs:* / komentarze / stany)
Mateusz monitoruje: Linear (signal views) + Control-panel UI + log na VM/artifact.
```
- **Runner:** **self-hosted GitHub Actions runner zainstalowany na VM** (rekomendacja — proste, job ma FS VM, agent może żyć długo jako proces detached). Alternatywa: runner GitHub-hosted + SSH do VM + `nohup`/tmux (gorsze przy długich sesjach).
- **Headless launcher:** `bin/run-agent.sh` = linuksowy odpowiednik `.bat` (ustawia `CLAUDE_CONFIG_DIR`, provider OpenRouter, klucze, `LINEAR_WORKSPACE`, `PROJECT`, `BASIS`) → odpala agenta nieinteraktywnie (`claude -p "<kickoff>"` lub Agent SDK), detached, log do pliku.
- **Współdzielone:** definicje agentów (CLAUDE.md, subagenci, `models.map`) są te same co lokalnie — różni się tylko wrapper (lokalny `.bat` interaktywny vs VM `run-agent.sh` headless).

## 3. Inputs workflow (`spawn-agent.yml`)
| Input | Typ | Uwaga |
|---|---|---|
| `stack` | choice: plan / dev / review / test / cadence | który squad odpalić (lead + subagenci) |
| `project` | choice: neo / au / fenix / pisi | → repo + workspace Linear (`projects.json`) |
| `linear_issue` | string (opcjonalnie) | **basis** — task z brainstormem/opisem/załącznikami; agent go wczytuje |
| `feature` | string (opcjonalnie) | basis ad-hoc, gdy brak issue |
| `ref` | string (default main) | branch repo |
| `mode` | choice: autonomous / dry-run | dry-run = bez zapisu do Linear/kodu |

- **Wzorzec „task = brainstorm":** najczęstszy flow dla PLAN — `linear_issue` wskazuje task z opisem+załącznikami; agent ładuje treść + komentarze + attachments z Linear (przez MCP) i z tego planuje. Dla DEV: `linear_issue` = konkretny task, albo brak → bierze z `Todo` (dep-aware, WIP).

## 4. Prerequisity (P0 — zanim włączysz `autonomous` na VM)
- **Cost guardrail / kill-switch** (T-A5) — agent na VM działa bez nadzoru; bez limitu spali budżet. **Wymagane.**
- **Idempotency + resume** (T-A6) — VM/job może paść; wznawianie z `STATE.md`/Linear bez duplikatów.
- **Async-HITL** zamiast plan-mode (patrz §1.1).
- **Claim/WIP** — `assignee=@flow` + `In Progress` zanim agent zacznie (żeby dwa spawny nie wzięły tego samego).

## 5. Provisioning VM jako „agent-runner" (GCP)
VM musi mieć: Claude Code CLI (na PATH), Node 20+, Docker (+compose) do env-check/build, `git`, склонowane `linear-agents` + repo zarządzanych projektów (lub clone on-demand), zarejestrowany **self-hosted runner**, klucze z GitHub Secrets (wstrzykiwane do env joba, nie zapisywane na stałe). Skrypt provisioningu = task w backlogu.

## 6. Reference YAML (szkielet — dev finalizuje)
```yaml
name: spawn-agent
on:
  workflow_dispatch:
    inputs:
      stack:        { type: choice, options: [plan, dev, review, test, cadence], required: true }
      project:      { type: choice, options: [neo, au, fenix, pisi], required: true }
      linear_issue: { type: string, required: false, description: "Basis: task (brainstorm/opis/załączniki)" }
      feature:      { type: string, required: false, description: "Basis ad-hoc (gdy brak issue)" }
      ref:          { type: string, default: main }
      mode:         { type: choice, options: [autonomous, dry-run], default: dry-run }
jobs:
  spawn:
    runs-on: [self-hosted, gcp-vm]      # runner zainstalowany na VM
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${{ inputs.ref }} }
      - name: Spawn agent (headless, detached)
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          LINEAR_API_KEY:     ${{ secrets.LINEAR_API_KEY }}
          PROJECT:            ${{ inputs.project }}
          BASIS_ISSUE:        ${{ inputs.linear_issue }}
          BASIS_FEATURE:      ${{ inputs.feature }}
          RUN_MODE:           ${{ inputs.mode }}
        run: |
          chmod +x bin/run-agent.sh
          tmux new-session -d -s "agent-${{ inputs.stack }}-$GITHUB_RUN_ID" \
            "bin/run-agent.sh ${{ inputs.stack }} ${{ inputs.project }} 2>&1 | tee logs/agent-$GITHUB_RUN_ID.log"
      - name: Handle
        run: echo "Spawned ${{ inputs.stack }} @ ${{ inputs.project }} (mode=${{ inputs.mode }}). Log: logs/agent-$GITHUB_RUN_ID.log"
```
`bin/run-agent.sh` (do napisania): ustawia `CLAUDE_CONFIG_DIR=agents/<stack>`, provider OpenRouter (`ANTHROPIC_BASE_URL`+token), `LINEAR_WORKSPACE` z `projects.json`, i odpala `claude -p "Działaj jako lead obszaru <stack>. Basis: issue=$BASIS_ISSUE / feature=$BASIS_FEATURE. Tryb=$RUN_MODE. Stosuj agents/<stack>/CLAUDE.md."` (lub Agent SDK).

## 7. Security
Klucze tylko z GitHub Secrets → env joba (nie commit, nie persist na VM). Self-hosted runner: prywatne repo / ograniczone uprawnienia (self-hosted runnery na public repo = ryzyko — repo jest prywatne ✓). VM: minimal scope SA, firewall.

## 8. Otwarte pytania
- Self-hosted runner na VM vs SSH z GitHub-hosted? (rekomendacja: self-hosted na VM dla długich sesji).
- Jeden runner/VM dla wszystkich stacków czy per-projekt? (start: jeden, potem skala).
- `claude -p` (one-shot) wystarczy, czy Agent SDK (multi-turn, lepsze sterowanie pętlą)? (do spike'a przy implementacji).
- Streaming logów do Linear/UI (komentarz „agent wystartował + link do logu") — tak, przez `notify-linear`.

## 9. Build tasks → BUILD-BACKLOG (Faza G)
T-G1 provisioning VM agent-runner (+ self-hosted runner); T-G2 `bin/run-agent.sh` (headless launcher, parytet z `.bat`); T-G3 `spawn-agent.yml`; T-G4 async-HITL zamiast plan-mode dla trybu headless (DEV); T-G5 spike: `claude -p` vs Agent SDK. **Prereq: T-A5 (cost), T-A6 (idempotency).**
