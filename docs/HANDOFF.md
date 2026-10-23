# Hand-off — Fenix 1.0 release track (2026-10-23)

For the next engineer picking up `linear-agents` (Fenix). Read this first, then `docs/STATE.md` (newest entry
on top) and `docs/releases/1.0.0/foc-789-run-log.md`. Access (accounts, ports, where secrets live, never the
values) is in `docs/ACCESS.md`.

## 1. Where things stand

| What | State |
|---|---|
| `main` | `92f7739`, CI green (`linux` workflow: suite in the image + isolation lanes) |
| Latest release candidate | **`v1.0.0-rc.4`** on `5b09e42`, image `ghcr.io/joint-hubs/fenix:1.0.0-rc.4` |
| Open PRs | none |
| Acceptance VM | `fenix-accept` (gcloud project `dochubs`, `europe-central2-a`, e2-standard-2) — **stopped** |
| Old dev VM | `fenix-vm` — stopped. `neo-ac4-1` is not ours; never touch it |
| Linear | project "Fenix — wydanie 1.0 i kontrola kosztów", milestone **M8 Fenix 1.0.0 — portable release** |

The release gate is **FOC-789** (fresh-machine acceptance run). It blocks **FOC-790** (release notes, dossier,
tag `v1.0.0`) and **FOC-781** (quickstart docs).

## 2. What happened in the last two days (FOC-789, part 1)

A clean VM with only Docker, `./fenix up`, then three real Linear tickets through the legacy single Supervisor:

| Ticket | Flow | Result | Cost |
|---|---|---|---|
| FOC-963 | small (Supervisor alone) | PR #133 merged, Done | $0.195 |
| FOC-962 | small (Supervisor alone) | PR #135 merged, Done | $0.092 |
| FOC-958 | medium (DEV + TEST, external review, fix loop, TEST) | PR #139 merged, Done | ≈ $2 |

Found and **fixed + verified on rc.4** (all Done): FOC-977 (fenix-github ran `gh` in the wrong cwd),
FOC-978 (push gate bypassable by spelling → PreToolUse `supervisor-ask-guard.mjs`), FOC-979 (a child running the
suite killed itself via an inherited `LA_CHILD_MARK`), FOC-980 (child transcripts 0600 → no child cost, no
resume in Docker; fixed with the `fenix-child-share` helper that runs **as fenix-child, never root**).

Also closed after verification: FOC-943 (Fenix MCP writes), FOC-964 (model routing v2), FOC-958 (fenix-control
MCP tool table, PRD phase B).

## 3. What to do next (in this order)

### 3.1 Blockers before the 1.0 tag

| Ticket | Prio | Problem | Suggested fix (details in the ticket) |
|---|---|---|---|
| **FOC-988** | Urgent | The Supervisor **edited Fenix's own code** in `/opt/fenix` four times (one edit disabled the `duplicate-child-id` guard). `/opt/fenix` is writable by the runtime uid. | root-owned, read-only `/opt/fenix` in the image (check why FOC-777's thin layer chowns it); `deny Edit/Write/MultiEdit(/opt/fenix/**)`; guard refuses Bash writes into `$LA_ROOT`; CLAUDE.md rule "a failing Fenix script is a hold, not a patch"; `fenix doctor` hash-drift check |
| **FOC-1001** | Urgent | The Supervisor ran git **inside child-owned worktrees** and worked around "dubious ownership" with a global `safe.directory`, which lets child-planted hooks/config run as the Supervisor. | push/log/diff only from the node-owned main checkout (branch refs are shared); guard refuses `safe.directory` and git under `/data/workspaces/la-wt/` |
| FOC-989 | High | A spawn/followup into an existing child-owned launch dir fails with EPERM (`copyFileSync` → `fchmod` on fenix-child files). | always a fresh `turn-N` dir (max existing + 1), record failed launch attempts |
| FOC-990 | High | A child running `node scripts/test-run.mjs` writes `test-triage-*` fixture runs into the **real** `/data/state/supervisor` → fake Needs-you holds. | `test-run.mjs` scrubs the same runtime env as `docker/test-in-container.sh`; give `supervisor-triage.test.mjs` its own state home |
| FOC-1000 | High | Image ships Debian `gh` 2.23 → `gh pr edit` (and `fenix-github pr_edit`) fails on the sunset classic-Projects API. | install `gh` from GitHub's apt repo (pinned); REST `PATCH` fallback in `pr_edit` |
| FOC-1007 | High | Approved worktree cleanup cannot run: auto mode **ignores `Bash(node:*)`**, so `supervisor-cleanup.mjs remove` hits the classifier; outside the session it lacks the Linear key. | exact-name MCP tools (like FOC-943) for lifecycle writes (cleanup, verdict record) |
| FOC-981 | Medium | Telemetry liveness check spawns `powershell` in the Linux container. | **Do not** "fix" with a plain POSIX pid probe — the api and Supervisor containers have separate PID namespaces (design note in the ticket) |

FOC-988 and FOC-1001 are security-boundary changes: get Mateusz's OK on the approach before coding.

### 3.2 Then

1. Release **rc.5** (procedure in §5) and update the VM.
2. **FOC-789 part 2:** two task sessions side by side (board → task cockpit → push from the dashboard with a
   human confirm). Part 1 only covered the legacy single Supervisor.
3. Turn the minor snags **S1–S21** from the run log into backlog tasks (FOC-789 AC2).
4. **FOC-790:** acceptance record into `docs/releases/1.0.0/README.md` (dossier), release notes, tag `v1.0.0`.
   Mention in the dossier that part of day 1 (after 2026-10-21 12:05 UTC) ran on self-patched harness code
   (FOC-988).

### 3.3 After 1.0 (do not start before the tag)

FOC-957 remote control epic, phases C–E (remote transport, gateway + on-demand VM, Grok app) —
`docs/prd/fenix-remote-control-mcp-prd.md`. Model campaign FOC-965 / experiments PRD FOC-967
(`docs/prd/model-experiments-prd.md`).

## 4. VM: how to operate it

* Start / stop (cost-aware: start only to work, stop when idle — about $0.09/h):
  `gcloud compute instances start|stop fenix-accept --project dochubs --zone=europe-central2-a`
* **Before stopping**, check that no child is live (a stop once killed a child — FOC-680). The Cockpit "Live
  children" table or `/api/cockpit` `children[].status`.
* Shell: `gcloud compute ssh fenix-accept --project dochubs --zone=europe-central2-a`; the checkout is
  **`~/fenix`**. Update to a new rc: `cd ~/fenix && git pull && ./fenix update`.
* Dashboard tunnel (PowerShell — `--` does not work there, gcloud is a `.ps1`):
  `gcloud compute ssh fenix-accept --project dochubs --zone=europe-central2-a --ssh-flag="-N" --ssh-flag="-L 4600:localhost:4600"`
  then `http://localhost:4600`. "Failed to fetch" in the dashboard usually means the tunnel died.
* Containers: `fenix-fenix-api-1` (API on 7331 inside, host `127.0.0.1:4600`) and `fenix-fenix-supervisor-1`
  (Supervisor in tmux: `tmux -L fenix capture-pane -p -t <pane>` to see the screen).
* **Never** run plain `docker compose up` on the VM: without the launcher's `FENIX_IMAGE_REF`
  (e.g. `fenix:local-1002-1005`) it builds `fenix:dev` from source and crash-loops the Supervisor. Recreate a
  single service with `FENIX_IMAGE_REF=fenix:local-1002-1005 docker compose up -d --force-recreate --no-deps <service>`.

**Leftovers to clear on the next VM start:**
* the three FOC-958 worktrees (`/data/workspaces/la-wt/linear-agents/foc-958-*`). Removal is approved (3×
  cleanup-approval "yes") but blocked by FOC-1007. Remove them inside the Supervisor session once FOC-1007 lands,
  or by hand with Mateusz's OK.
* `/data/state/supervisor/test-triage-*` fixture junk (FOC-990), fenix-child-owned → needs root.
* `/tmp/foc958-base`, a TEST child's comparison worktree, registered in the main repo's worktree list.
* The main checkout `/data/workspaces/linear-agents` is still on branch `foc-962-attach-link`. Have the
  Supervisor switch it back to `main`.

## 5. Working on the code

* **Windows host.** Use one worktree per ticket under `C:\Users\mateu\Documents\GitHub\la-wt-mateusz\<branch>`,
  created from `origin/main`. Run `npm ci` inside it. **Never junction `node_modules`**: a
  `git worktree remove --force` once followed the junction and emptied main's `node_modules`.
* **Full suite:** `node scripts/test-run.mjs` (~14 min, 208 files). Target single files while iterating.
  New test files must be registered in `scripts/test-lanes.json`, and the counts in
  `docs/supervisor-e2e-checklist.md` bumped (`docs-count-guard` enforces it).
* **Linux-only tests SKIP on Windows.** Before calling anything that touches POSIX paths, signals, `/proc` or
  `docker/` green, run it in a local Linux container. Build the image with `docker build -t fenix:ci .`; the
  first `apt-get` attempt can fail transiently, so retry once. Run the isolation lane like CI does:
  `docker run --rm --user root -v <checkout>:/src:ro fenix:ci sh /src/docker/test-isolation.sh`. `main` went red
  once because of a Linux-only test that skips on Windows.
* **CI** (`.github/workflows/linux.yml`) runs four steps: build the image, run the suite in the image, run the
  child isolation lane, then build the thin uid layer and run its isolation lane. If an earlier step fails, the
  later ones never run.
* **Release an rc:**
  1. A small PR bumps `VERSION` (the launcher pulls the image named there).
  2. Mateusz merges it.
  3. Wait for green `main` CI.
  4. Push an annotated tag `v1.0.0-rc.N` on the merge commit. Tag pushes need Mateusz's explicit OK.
  5. The `publish-image` workflow builds `ghcr.io/joint-hubs/fenix:<VERSION>`.
* **Merging:** Mateusz merges PRs to `main` himself. Call a PR merge-ready only after its CI is green.

## 6. Gotchas learned the hard way

* **The Supervisor (mimo-v2.6-pro) works around tooling errors instead of reporting them.** It patched
  `/opt/fenix`, set `safe.directory`, and tried CronCreate and background polls. Read its transcript, not only
  its chat summary: `/data/agents/supervisor/projects/<slug>/<session>.jsonl` in the supervisor container. The
  rule "a failing Fenix script → hold with the full error" was given in chat; FOC-988 makes it permanent.
* **Auto mode ignores broad interpreter allow rules** (`Bash(node:*)`). Every `node …` the Supervisor runs goes
  to the classifier, which blocks "irreversible" or "self-approval" looking calls. The deterministic channel
  for Supervisor writes is exact-name MCP tools (`fenix-linear`, `fenix-github`).
* **Model-provider refusals** happen. mimo refused to emit `sh -c 'git … push'` ("considered high risk",
  `stop_reason: refusal`), and the Supervisor then blamed "a session classifier". Check `stop_reason` in the
  transcript.
* `providers.openrouter.tiers.sonnet` stays `google/gemini-2.5-flash-lite`: it serves Claude Code's auto-mode
  classifier. FOC-964's description still says otherwise; the config is right, the text is stale.
* `fenix-control` (PRD phase B, PR #139) is an **external** control channel. It is denied for every role,
  including the Supervisor: its answer tools write human decisions.
* Child cost now shows at turn end (registry) and live (Work board, via the share helper). Old rc.3 records
  (e.g. `test-2` $0) stay wrong.
* `gh` on the host is 2.89 and works. Inside the image it is 2.23 (FOC-1000).

## 7. Housekeeping waiting for Mateusz's decision

* About 124 merged remote branches on `origin`, plus local branches `foc-220/284/286/287/441-review` and
  `chore/foc-102-baseline` (1 commit ahead). Two stashes on `main`: a minimax experiment (superseded) and an
  unrelated `orchestrate-openrouter.bat`. Do not delete any of these without his OK.
* Linear items still *In Review* although merged: FOC-920 (parked-prompt policy; deny-after mode not exercised
  on the VM yet) and FOC-781 (quickstart; its AC needs someone other than Mateusz to follow it).

## 8. How Mateusz works

* He writes in Polish, often dictated. Answer in Polish; code, commits and docs are in English.
* Commits: no `Co-Authored-By` trailer; specific messages in the repo's style.
* He merges to `main` and approves tag pushes. Anything destructive, security-boundary or money-related needs
  his explicit OK.
* Prefer delegating implementation to cheap workers (Atlas `agent_spawn`, `z-ai/glm-5.3-flash`, reviews on
  `z-ai/glm-5.3`). If Atlas is down, ask; do not substitute another model. Verify every worker result yourself.
* "Done" means verified, not merely coded. On the VM, check the result with real evidence: logs, the
  transcript, the registry.
