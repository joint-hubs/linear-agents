---
type: design-doc
status: active
tags: [type/design-doc, area/devops, topic/ci-cd, topic/deploy, topic/github-actions]
created: 2026-06-23
maturity: design-v1
---

# CI/CD — deploy VM + Lambda (manual, parameterized) + integracja z agentem TEST

> Zasada: **deploy = GitHub Action odpalany RĘCZNIE przez Mateusza** (`workflow_dispatch`) z parametrami.
> Agent TEST nie deployuje sam po SSH — **przygotowuje**, prosi Mateusza o uruchomienie workflow, potem
> **testuje zdeployowaną apkę** i raportuje. To domyka pętlę „CI/CD razem z agentem test".

## 1. Decyzje
- **Trigger:** wyłącznie `workflow_dispatch` (manual, człowiek). Brak `on: push` (świadomie — Ty decydujesz kiedy).
- **Dwa workflowy** (czyste inputy per cel): `deploy-vm.yml` (GCP VM, build OpenRouter) i `deploy-lambda.yml` (Lambda GPU, build Ollama). *(Alternatywa: jeden `deploy.yml` z `target` choice — odrzucone, bo Lambda ma wymagane IP, VM nie.)*
- **Parametry (inputs):** wspólne `project` (choice), `ref` (branch/tag/sha), `linear_issue` (opcjonalnie, do powiadomienia). **Lambda dodatkowo: `instance_ip` (REQUIRED)** — bo instancje GPU tworzą się od nowa i mają nowe IP za każdym razem.
- **Health-check + rollback:** w workflow (VM: redeploy poprzedniego obrazu/tagu na fail; Lambda: raport fail, instancja efemeryczna).
- **Powiadomienie Linear:** krok `notify-linear` (gdy podano `linear_issue`) → status deployu + URL wraca do taska, żeby agent TEST wiedział, że deploy gotowy.

## 2. Współpraca z agentem TEST (boundary)
1. Task → `stage:testing`. Agent TEST (`deployer`) sprawdza build green, czyta `config/projects.json` (cel: gcp-vm / lambda).
2. Agent **nie odpala deployu sam** — komentuje w Linear (PL) + `needs:approval`:
   - VM: „Gotowe do deployu — odpal **deploy-vm** (project=neo, ref=<branch>)."
   - Lambda: „Odpal **deploy-lambda** (project=neo, ref=<branch>, **instance_ip=<wpisz nowe IP>**)."
3. **Mateusz uruchamia workflow ręcznie** (Actions → Run workflow → wypełnia inputy / `gh workflow run`).
4. Workflow: build → deploy → health-check → (VM) rollback na fail → `notify-linear` (status+URL).
5. Agent TEST (`runner`/`scenario-gen`) testuje apkę pod URL (synthetic data) → raport → przesuwa stan (Done / In Progress); `root-cause` diagnozuje faile.

> Zmiana vs `../prd/prd-testing.md`/`../agents/agent-4-test.md`: rola `deployer` = **przygotuj + poproś o trigger + zweryfikuj deploy**, nie bezpośredni SSH-deploy. Do zaktualizowania w PRD (patrz backlog task).

## 3. Inputs — szczegóły
| Input | deploy-vm | deploy-lambda | Uwaga |
|---|---|---|---|
| `project` | ✅ choice neo/au/fenix/pisi | ✅ | mapuje repo+cel z `projects.json` |
| `ref` | ✅ string (default main) | ✅ | branch/tag/sha |
| `instance_ip` | — | ✅ **required** | nowe IP instancji Lambda GPU |
| `ssh_user` | — | ✅ (default ubuntu) | |
| `linear_issue` | opcjonalnie | opcjonalnie | np. NEO-142 → powiadomienie |

## 4. Secrets (Mateusz konfiguruje w GitHub → Settings → Secrets/Environments)
- **VM:** `GCP_SA_KEY` (lub Workload Identity), `GCP_PROJECT`, `GCP_ZONE`, `GCP_VM_NAME` (lub z `projects.json`), ew. `VM_SSH_KEY`.
- **Lambda:** `LAMBDA_SSH_KEY` (klucz prywatny SSH), ew. registry creds.
- **Linear notify:** `LINEAR_API_KEY` (do `notify-linear`).
- (Klucze modeli NIE tu — to dla agentów, nie deployu.)

## 5. Reference YAML (szkielet — dev/GLM finalizuje, NIE wgrywać dopóki secrets nie ustawione)

### `.github/workflows/deploy-lambda.yml`
```yaml
name: deploy-lambda
on:
  workflow_dispatch:
    inputs:
      project:     { description: Projekt, type: choice, options: [neo, au, fenix, pisi], required: true }
      ref:         { description: Branch/tag/SHA, type: string, default: main }
      instance_ip: { description: "IP nowej instancji Lambda (GPU) — wpisz aktualne", type: string, required: true }
      ssh_user:    { description: SSH user, type: string, default: ubuntu }
      linear_issue:{ description: "Linear issue (np. NEO-142, opcjonalnie)", type: string, required: false }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: lambda
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${{ inputs.ref }} }
      - name: SSH setup
        run: |
          mkdir -p ~/.ssh && echo "${{ secrets.LAMBDA_SSH_KEY }}" > ~/.ssh/id && chmod 600 ~/.ssh/id
          ssh-keyscan -H "${{ inputs.instance_ip }}" >> ~/.ssh/known_hosts
      - name: Deploy (Ollama/GPU build)
        run: ssh -i ~/.ssh/id ${{ inputs.ssh_user }}@${{ inputs.instance_ip }} 'cd app && git fetch && git checkout ${{ inputs.ref }} && docker compose --profile gpu up -d --build'
      - name: Health-check
        run: curl -fsS --retry 12 --retry-delay 5 "http://${{ inputs.instance_ip }}:8000/health"
      - name: Notify Linear
        if: ${{ always() && inputs.linear_issue != '' }}
        run: node scripts/notify-linear.mjs --issue "${{ inputs.linear_issue }}" --status "${{ job.status }}" --url "http://${{ inputs.instance_ip }}:8000"
        env: { LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }} }
```

### `.github/workflows/deploy-vm.yml`
```yaml
name: deploy-vm
on:
  workflow_dispatch:
    inputs:
      project:     { description: Projekt, type: choice, options: [neo, au, fenix, pisi], required: true }
      ref:         { description: Branch/tag/SHA, type: string, default: main }
      linear_issue:{ description: "Linear issue (opcjonalnie)", type: string, required: false }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: gcp-vm
    steps:
      - uses: actions/checkout@v4
        with: { ref: ${{ inputs.ref }} }
      - uses: google-github-actions/auth@v2
        with: { credentials_json: ${{ secrets.GCP_SA_KEY }} }
      - name: Deploy (OpenRouter build) + capture previous tag for rollback
        run: |
          gcloud compute ssh "${{ secrets.GCP_VM_NAME }}" --zone "${{ secrets.GCP_ZONE }}" --command \
            'cd app && docker compose images -q > /tmp/prev.tag; git fetch && git checkout ${{ inputs.ref }} && docker compose up -d --build'
      - name: Health-check
        id: hc
        run: gcloud compute ssh "${{ secrets.GCP_VM_NAME }}" --zone "${{ secrets.GCP_ZONE }}" --command 'curl -fsS --retry 12 --retry-delay 5 http://localhost:8000/health'
      - name: Rollback on failure
        if: ${{ failure() && steps.hc.conclusion == 'failure' }}
        run: gcloud compute ssh "${{ secrets.GCP_VM_NAME }}" --zone "${{ secrets.GCP_ZONE }}" --command 'cd app && docker compose down && docker run -d $(cat /tmp/prev.tag)'
      - name: Notify Linear
        if: ${{ always() && inputs.linear_issue != '' }}
        run: node scripts/notify-linear.mjs --issue "${{ inputs.linear_issue }}" --status "${{ job.status }}"
        env: { LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }} }
```

## 6. Otwarte pytania (dla Mateusza / dev)
- Port health-check (`/health`, 8000?) per projekt → do `projects.json`.
- Deploy VM: przez `gcloud ssh + compose` czy build→push obrazu do Artifact Registry → pull na VM? (szkielet zakłada compose na VM).
- Czy `gh workflow run` dozwolone dla agenta (semi-auto), czy zawsze ręczny klik? (decyzja: ręczny — zgodnie z „z palca").
- CI (lint/test na PR) — osobno, wpięte w backlog PR-feature (`pr-review-loop-*`), nie w tym CD.

## 7. Build tasks (dodane do BUILD-BACKLOG → Faza D)
T-D4a workflowy deploy-vm/deploy-lambda + `scripts/notify-linear.mjs`; T-D4b aktualizacja roli `deployer` (prepare+prompt+verify) w prd-testing/agent-4-test.
