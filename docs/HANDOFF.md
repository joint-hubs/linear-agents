# Hand-off — Fenix 1.0 release track (2026-10-23)

For the next engineer picking up `linear-agents` (Fenix). Read this first, then `docs/STATE.md` (newest entry
on top) and `docs/releases/1.0.0/foc-789-run-log.md`. Access (accounts, ports, where secrets live, never the
values) is in `docs/ACCESS.md`.

## 1. Where things stand

| What | State |
|---|---|
| `main` | `f1c0ad5` (2026-10-25) — all six blockers merged (#143–#147), rc.5 pin (#150), FOC-477 plan.spec pin (#151); CI green (`linux` workflow: suite in the image + isolation lanes) |
| Latest release candidate | **`v1.0.0-rc.5`** on `ea9b81e`, image `ghcr.io/joint-hubs/fenix:1.0.0-rc.5` (digest `sha256:82f88f0f2da8…`) |
| Open PRs | #152 — three snags from the rc.5 VM walk (FOC-1047 cleanup repo resolution, FOC-1048 doctor false WARN, FOC-1049 `LA_PROJECTS_FILE` in the suite) → rc.6 |
| Acceptance VM | `fenix-accept` (gcloud project `dochubs`, `europe-central2-a`, e2-standard-2) — see the last line of §3.1 for its state |
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

### 3.1 Blockers before the 1.0 tag — code done 2026-10-23, VM walk on rc.5 done 2026-10-25

| Ticket | State | What shipped | Check on the VM (rc.5) |
|---|---|---|---|
| FOC-990 | #143 merged | `supervisor-triage.test` pins its own state; `scripts/test-runtime-env.json` is the one runtime-env list for `test-run.mjs` and `test-in-container.sh`; the Cockpit ignores `test-*` run dirs | a child running `node scripts/test-run.mjs` leaves nothing in `/data/state/supervisor`, `/data/workspaces`, `/data/telemetry` (before/after `ls`); Needs-you count unchanged |
| FOC-989 | #144 merged | `freshLaunchDir`: spawn/followup never prepare into an existing launch dir (`turn-N`, else `turn-N-rK`) | a followup re-run after an `exit 1` launch starts without a manual step |
| FOC-1000 | #145 merged | `gh` from GitHub's apt repo (floor 2.89.0 checked at build), REST `PATCH` retry for `pr edit` in `gh-screened`, `fenix doctor` flags a gh below the floor | `mcp__fenix-github__pr_edit` updates a PR body; `fenix doctor` prints the gh version |
| FOC-1007 | #146 merged | MCP tool `mcp__fenix-lifecycle__cleanup_remove` (one exact allow rule), `fenix cleanup <list\|propose\|remove>` for the operator | the three FOC-958 worktrees go: the Supervisor's cleanup runs with no classifier refusal; `./fenix cleanup remove …` works from the host |
| **FOC-988** | #147 open | deny `Edit/Write/MultiEdit/NotebookEdit(//opt/fenix/**)`; the ask guard asks on Bash writes into `$LA_ROOT` (container only); image manifest + `fenix doctor` check `fenix code`; CLAUDE.md rule | a Supervisor Edit to `/opt/fenix/scripts/x.mjs` is **refused by real Claude Code**, `sed -i … /opt/fenix/…` asks; `fenix doctor` reports a manual change |
| **FOC-1001** | #147 open | the guard asks on `safe.directory` and on git under `LA_WORKTREE_HOME`; `supervisor-lib` `git()` reads child trees one-shot and sanitised; CLAUDE.md rules (push from the main checkout) | `git config --global --add safe.directory …` and `git -C /data/workspaces/la-wt/<x> push` raise the guard; the push/review/verdict flow works on a recreated container without any `safe.directory` |
| FOC-981 | untouched, Medium | — | **Do not** "fix" with a plain POSIX pid probe — the api and Supervisor containers have separate PID namespaces (design note in the ticket). Can wait for after rc.5 |

**Result of the walk (2026-10-25, `fenix-accept` on rc.5; evidence in `foc-789-run-log.md` "Day 3"):**

| Ticket | Result |
|---|---|
| FOC-990 | **Verified → Done.** The full suite as `fenix-child` with the container env: 0 new entries in `/data/state/supervisor` (763 → 763), `/data/telemetry` (208 → 208), `/data/workspaces` (10685 → 10685); Cockpit needs-you 0 with 74 old `test-*` run dirs present. Residual: `LA_PROJECTS_FILE` leaked into the suite (`team-routes.test` red) → FOC-1049 / #152 |
| FOC-1000 | **Verified → Done.** Image `gh` 2.103.2 (floor 2.89), printed by `fenix doctor`; `mcp__fenix-github__pr_edit` on PR #151 executed through the real Supervisor session |
| FOC-988 | **Verified → Done.** Real Claude Code: `Write` and `Edit` on `/opt/fenix/scripts/…` → "File is in a directory that is denied by your permission settings"; `sed -i` on `/opt/fenix/…` is **denied** by a Bash rule (stricter than the "asks" above); nothing was written, manifest 578/578. `fenix doctor` reports a tampered file as FAIL and a planted one as WARN. Found: it also WARNs on `config/models.map` after every healthy start → FOC-1048 / #152 |
| FOC-1001 | **Guard verified; end-to-end flow still open (In Review).** `git config --global --add safe.directory …` and `git -C <child worktree> push --dry-run` both raised an approval prompt in the real session (answered No, nothing ran); reads of child trees work with no `safe.directory` (`dirtyCount`, `commitsAhead`, a readable HEAD). Not exercised: a real push/review/verdict flow on a recreated container → FOC-789 part 2 |
| FOC-989 | **Partly verified (In Review).** `freshLaunchDir` on the real stale launch dirs of run `…8cf1`: `dev-1` turn 1 → `turn-1-r1`, turn 2 stays `turn-2`. A real followup after an `exit 1` launch was not run (it needs a model turn) |
| FOC-1007 | **Tool verified, removal open (In Review).** `cleanup_remove` is allowed with no classifier refusal and re-checks both keys. Found: the default repo resolution fails from a child tree (FOC-1047 / #152; works with `repo`). The three 2026-10-22 approvals are void (they were given while every read failed — the question said "<git status failed…>"); fresh gates `gate-dev-1-2`, `gate-test-2-2`, `gate-test-3-2` wait in Needs-you |

Decisions of 2026-10-23 (Mateusz) that shape #147: `/opt/fenix` is **not** made read-only (the controls are the deny
rules, the Bash guard and the manifest check — so `node some-script.mjs` writing there is the known residual,
caught by `fenix doctor`); the guard **asks**, it does not deny; the Cockpit drift line is [FOC-1008], a read-only
Supervisor gitconfig is [FOC-1009]. Also filed: [FOC-1010], `supervisor-followup.test` "legacy registry entry
without provider" flakes under load (registry race in the test; quiet runs are green).

Measured while building FOC-1001: with `extensions.worktreeConfig` on, `safe.directory=<tree>` alone **executes a
child-planted `core.fsmonitor` as `node`**; the one-shot form (`core.hooksPath=/dev/null`, `core.fsmonitor=false`)
does not. The isolation lane asserts both.

### 3.2 Then

1. ~~rc.5 and the walk of §3.1~~ — done 2026-10-25 (results above). Still open from it: Mateusz answers the three cleanup gates (then the Supervisor removes the FOC-958 worktrees), #152 merged (→ rc.6), FOC-1001's end-to-end flow and FOC-989's real followup ride on part 2.
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

**Leftovers (state after the 2026-10-25 walk):**
* the three FOC-958 worktrees (`/data/workspaces/la-wt/linear-agents/foc-958-*`): the 2026-10-22 approvals are
  void (see the FOC-1007 line in §3.1); fresh gates wait in Needs-you. After Mateusz answers them: the Supervisor
  calls `cleanup_remove` for each child (pass `repo: /data/workspaces/linear-agents` until #152 is in the image),
  or `./fenix cleanup remove --run 2026-10-21T09-09-28-146-supervisor-8cf1 --child <id> --repo /data/workspaces/linear-agents`.
  dev-1's only "uncommitted" path is an untracked `node_modules`.
* `/data/state/supervisor/test-*` fixture junk from before FOC-990: 74 run dirs, fenix-child-owned → needs root and
  Mateusz's OK; the Cockpit ignores them, so it is only clutter.
* ~~`/tmp/foc958-base`~~ — the directory was gone; the dead entry is pruned (`git worktree prune`).
* ~~main checkout on `foc-962-attach-link`~~ — back on `main` (`f1c0ad5`), clean.
* the checkout `~/fenix` on the VM has two stray untracked files, `=` and `unpacking` (a shell redirect typo).

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
