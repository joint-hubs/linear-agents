# Plan — FOC-788: Human push and open PR from the dashboard, with explicit confirm

Ticket: `FOC-788` (M8 / FOC-768). Source of truth for scope: the ticket body (AC below). This plan
records the four decisions Mateusz made on 2026-10-15 and the contracts they imply.

## 1. Decisions (Mateusz, 2026-10-15 — his words, recorded)

1. **What gets pushed:** the **task branch** (`foc-N-slug` from the task's worktree) → `git push` to
   `origin`, and **Open PR** targets **`main`**. (Option (a) of the question set.)
2. **"Checks state" = the local verification result** — the run-state verdicts and child outcomes,
   **not** GitHub checks (this repo has no CI; GitHub check status would always be empty). The
   preview shows this evidence before the confirm (AC-2).
3. **Audit sinks: telemetry + Linear comment + JSON (append-only record). The decision can be taken
   by the user OR by an AI.** So the confirm record carries the actor (`human` | `ai`) and who it
   was; both are explicit confirms, never automatic.
4. **The same `GITHUB_TOKEN`** (the compose secret) may be used for push auth and PR creation.

## 2. Scope and AC (unchanged from the ticket)

* "Push branch" and "Open PR" actions on a landed ticket: diff summary, target, checks state,
  explicit confirm; **never automatic, never merge**.
* AC-1: push / PR happen only after the confirm click; the action is logged with who confirmed.
* AC-2: a failing check is shown before the confirm.
* Out of scope: merging; auto-merge. Also out of scope here: any change to the Supervisor's own
  push/PR policy (`agents/supervisor/CLAUDE.md` keeps its push-approval gate; this feature does not
  weaken it — the AI actor path is the transport, the caller's policy decides when to use it).

## 3. What already exists (verified recon — no re-exploration)

* **Ticket facts** (`collectTicketFacts`, `scripts/work-board.mjs:236`) already carry everything the
  preview needs: per-child `branch`, `baseRevision`, `worktree`, `squad`, `status`; per-round
  `verdicts` (`PASS | FAIL | UNKNOWN` from `verdicts/<taskid>-roundN.json`); gates; interventions.
* **Action pattern** to mirror: `GET /api/work/tickets/:id/start-preview` → `POST .../start` with a
  body that must carry the preview's own text (`scripts/work-routes.mjs:472-562`) plus
  `writeGuards` (`scripts/cockpit-routes.mjs:178` — 127.0.0.1-only + same-origin loopback).
* **Repo layout in the container:** shared clones at `$GITHUB_ROOT` (`/data/workspaces`), worktrees
  at `$GITHUB_ROOT/la-wt` (`scripts/fenix-repos.mjs`, `scripts/fenix-paths.mjs`). Both live on the
  shared `fenix-data:/data` volume, so the API container can run `git` against them.
* **Token:** compose secret `github_token` (mounted file; `LA_SECRETS_DIR=/fenix-secrets` for the
  vault). `scripts/fenix-git-identity.mjs` already reads `GITHUB_TOKEN` and never prints it.
* **Egress screen:** `scripts/egress-screen.mjs` — its own docs name PR bodies as the chokepoint.
  The generated PR body is repo content leaving the machine; it goes through the same screen.

## 4. Contracts

### 4.1 Preview — `GET /api/work/tickets/:id/publish-preview?action=push|pr`

Read-only, safe for the UI to poll. Answers `200` with:

```json
{
  "ticket": "FOC-123",
  "action": "push",
  "checkout": {
    "branch": "foc-123-slug",
    "worktree": "/data/workspaces/la-wt/foc-123-slug",
    "repoPath": "/data/workspaces/linear-agents",
    "remote": "origin",
    "remoteUrl": "https://github.com/joint-hubs/linear-agents",
    "base": "main",
    "head": "9f458fb…",
    "baseRevision": "1654543…"
  },
  "diff": { "commits": 18, "files": 12, "insertions": 101, "deletions": 2,
            "commitSubjects": ["…"], "dirty": false },
  "checks": { "latest": "PASS", "failing": [], "verdicts": [{"round": 1, "verdict": "PASS", "at": "…"}],
              "children": [{"childId": "dev-1", "status": "completed"}] },
  "confirmToken": "sha256(…)"
}
```

* `checkout` is **discovered, never invented**: the ticket's children are looked up for one whose
  recorded worktree exists and whose live HEAD is on that child's recorded `branch`. Among those,
  the pick prefers a **work-carrying** branch (commits beyond the base); when several share one head
  sha — a review/test pin at the dev candidate — the `dev` child's branch name wins (the task branch
  the work was authored on); diverged carriers pick the most recent child. With nothing to publish
  the latest qualifier stands and the preview honestly shows `commits: 0`. Absence → `404 { error:
  "no-checkout", reason }` (`no-children` | `branch-or-worktree-unrecorded` | `worktree-missing` |
  `head-mismatch` | `head-unreadable`) and **no action is offered**. Fail-closed is the design, not
  an error path.
  *(Refined 2026-10-15 after reading spawn: every attempt owns its own branch —
  `foc-N-<slug>-<attemptHash>`, `supervisor-spawn.mjs:408-410` — children do not share one task
  branch, so a review/test pin can sit at base while the dev branch carries the work. The earlier
  "latest child" wording would have picked the pin; the work-carrying preference is what makes the
  buttons push the work.)*
* `checks` is the local evidence (decision 2). `latest: "FAIL"` (or any `failing[]`) is what AC-2
  is about: the confirm dialog must render it before the button.
* `confirmToken = sha256(action + ticket + branch + head + base)` — binds the confirm to the exact
  state the human saw. A moved `head` between preview and confirm answers `409 { error:
  "stale-preview" }` and the UI re-previews.

### 4.2 Act — `POST /api/work/tickets/:id/push` / `POST .../pr`

Body: `{ "confirmToken": "…", "actor": "human" | "ai", "actorId": "…" }`.

* `writeGuards` first (127.0.0.1 + same-origin), then body cap, then the token check — the same
  three-step shape as `POST .../start`.
* The body must carry the preview's `confirmToken` for the current state (as `start` requires the
  preview's text) — a stray or replayed body can never act.
* `actor` is required and recorded verbatim (decision 3). The UI sends `human`; an agent calling the
  same endpoint sends `ai` with its `actorId` (session/agent id). No other way in; nothing calls
  these endpoints without a request (never automatic).
* **push** runs `git -C <worktree> push origin <branch>:<branch>` — the exact refspec, no `--force`,
  no tags, no `--all`. Divergence is reported as the git error; force is never offered.
* **pr** creates the PR via the GitHub REST API (`POST /repos/{owner}/{repo}/pulls`, `head` = branch,
  `base` = `main`) with a generated title/body; the body passes `egress-screen.mjs` before it
  leaves. Never merge — the merge button does not exist.
* **Auth:** the token is read from the compose secret file at call time. `git` gets it through a
  one-shot credential helper (stdin/stdout, never argv, never env, never a URL — the token never
  lands in `.git/config`, the remote URL or a log line); the REST call sends it as a header on our
  own `fetch`. The token value is never echoed, not even in errors.
* Success answers `{ ok: true, action, actor, head, prUrl? }`; failure answers the git/API error
  **with the secret-scrubbed text** and logs the outcome either way.

### 4.3 Audit (decision 3)

One logical record, three sinks, written before the success response returns:

1. **JSON** — append-only JSONL (the record): `{ ts, ticket, action, branch, head, base, target,
   actor, actorId, confirmToken, ok, error?, prUrl?, diff }`.
2. **Telemetry** — one fact row in the existing store (`scripts/telemetry-store.mjs`, no second
   analytics store), carrying the same identity fields.
3. **Linear comment** — on the issue: what was pushed/opened, **the branch and the head sha**,
   **who confirmed** (`human`/`ai` + id), the PR URL. No secrets, no token, no file content (the
   egress rule for comments stands). **Decided 2026-10-15 (Mateusz: "tak w komentarzu linear podaj
   tez nazwe galezi"): the comment names the branch.** A managed ref
   (`foc-788-push-pr-from-dashboard-1a2b3c4d5e6f`, 43 chars, 4.2 bits/char) trips
   `egress-screen.mjs`'s high-entropy family as a token shape (measured 2026-10-15, probe in S2),
   so naming it rides a **narrow managed-git-ref exemption** in that screen — this is the one
   security-control change in this feature, taken on Mateusz's explicit sign-off (2026-10-15).
   The gate is the spawn shape itself (`<teamKey>-<n>-<slug>-<hash12>` — `dev-branch.mjs`
   `buildBranchName` + `supervisor-spawn.mjs`'s 12-hex attempt hash), family-E-only, and
   deliberately narrower than FOC-733's Q2-B slug gate: a Linear **title** slug has no attempt
   hash, so the Q2-B corpus stays blocked in bare prose exactly as Q2-B decided (pinned in
   `egress-screen.test.mjs` §9). Accepted residual, same class as Q2-B's: a passphrase spelled in
   that exact shape sails through family E. A ref that does **not** fit the shape (renamed
   branches, legacy pre-attempt-hash names) refuses the comment fail-closed, with the refusal in
   the audit result rather than the issue stream. The PR title/body stay sha-identified — the PR's
   `head` field carries the ref. The branch name lives in the JSONL record and the telemetry row
   as before.

## 5. UI (`ui/src/components/work/TicketPanel.jsx`, `workModel.js`)

* Two actions in the existing `wk-actions` block: **Push branch**, **Open PR** — rendered only when
  `publish-preview` answered with a checkout (nothing to click when there is no checkout).
* The confirm dialog shows: diff summary (commits/files/±), target (`base`), the **checks state
  first** when anything fails (AC-2), the actor ("You"), and the confirm button. A failing check is
  shown prominently but does not hard-block the click — the human decides (the AC says *shown*, not
  *blocked*).
* **Default, easy to override:** the actions are offered whenever a checkout is identified, and the
  dialog labels the ticket's stage. The ticket text says "on a landed ticket"; gating on the board's
  `landed` column (Linear `completed`) would make the buttons appear only *after* the PR already
  merged — i.e. too late for the flow the feature exists for. If Mateusz wants the hard gate, it is
  one condition in the preview.
* Errors are spelled out, never a bare failure: `no-checkout`, `stale-preview`, `push-refused`
  (with the git reason), `pr-failed` (with the API reason).

## 6. Slices (smallest verticals first)

* **S1 — `scripts/publish-actions.mjs` (core, pure + seams).** Checkout discovery from facts, diff
  summary, checks derivation, confirm-token bind/re-check. Tests against a local bare repo fixture
  (created in a temp dir; **never the network**).
* **S2 — executors + audit.** Push via the credential helper (secret file seam), PR via a fetch seam
  (fake GitHub in tests), `egress-screen.mjs` on the body, the three audit sinks. Tests: fake bare
  remote proves the exact refspec and the no-force rule; the fake API proves the PR shape; a leak
  canary proves the token never appears in argv/env/logs/records.
* **S3 — routes.** `publish-preview` + `push` + `pr` in `scripts/work-routes.mjs`, same guard/body
  shape as `start`. Route tests (existing `work-routes.test.mjs` harness): guards, token binding,
  stale-head 409, no-checkout 404.
* **S4 — UI.** Actions, confirm dialog, actor "human", error states; model tests (the plain-node
  harness used by `workModel.js` tests) + Vite build.
* **S5 — verification.** Suites green (Linux + Windows lanes), image rebuild + redeploy, browser walk
  on the acceptance stack against a **local bare remote and a fake PR endpoint** (mock-first,
  never a real GitHub call from a test). Real-provider evidence is a **separate, human run**: Mateusz
  clicks push/PR on a real ticket from the dashboard — I never push on my own.

## 7. Risks / boundaries

* **Token exposure** is the one real hazard: the token must never reach argv, env, a remote URL, a
  log line or the audit record. S2's leak canary is the guard; review looks at the credential path
  first.
* **Never merge, never force, never automatic** — enforced in the executor (exact refspec) and in
  the route (token + guards), not by UI convention.
* **Egress screen vs. branch names (measured and decided 2026-10-15):** a managed ref trips the
  high-entropy family as a token shape; the Linear comment names it under the narrow
  managed-git-ref exemption in `egress-screen.mjs` — the one security-control change in this
  feature, on Mateusz's sign-off, gate = the spawn shape (see §4.3). Any ref outside that shape
  is refused fail-closed rather than waved through; the JSONL/telemetry record keeps the branch
  name either way.
* **The AI actor widens who can confirm** (decision 3): the transport records it faithfully; the
  Supervisor's own push-approval gate keeps deciding when its side calls this endpoint. No cron, no
  hook, no watcher calls these routes.

## 8. Delivery status (2026-10-15) — S1–S5 DONE

* **S1 — DONE.** `scripts/publish-actions.mjs` + `publish-actions.test.mjs`: checkout discovery from
  one ticket's facts (`no-checkout` with a named reason, fail-closed), diff summary, checks
  derivation (all FAIL rounds surfaced, latest = highest round — AC-2's data), confirm token bound
  to `[action, ticket, branch, head, base]` and re-checked against the live state.
* **S2 — DONE.** `scripts/publish-exec.mjs` + `scripts/git-credential-fenix.mjs`: push via the
  credential-helper secret-file seam (the token never reaches argv/env/logs/records — leak canary
  green), PR via the fetch seam, audit trio (`buildPublishRecord` + `recordPublishAction`: JSONL +
  telemetry + Linear comment with the branch name) under the managed-git-ref egress exemption.
* **S3 — DONE.** `GET /api/work/tickets/:id/publish-preview` and `POST …/push|pr` in
  `scripts/work-routes.mjs` — same guard/body shape as `start`. `work-routes.test.mjs` 86/86 on a
  real git fixture (the pushurl trick: GitHub-shaped fetch URL for the PR path, local bare push URL
  for an offline real push).
* **S4 — DONE.** `PublishDialog.jsx` + `publishDialogModel` + the panel's Push branch / Open PR
  actions (rendered only with a discoverable checkout); 64/64 model tests, Vite build green.
* **S5 — DONE.** Full suite ×2 (171/174; the three red files reproduce at the branch's bare HEAD
  without this feature's diff — see STATE (37); every surface of this feature is green in both
  runs). Image `fenix:task-workspace-candidate` rebuilt (`sha256:b16d882c…`) and stack
  `fenix-task-workspace` redeployed (both healthy). Curl walk on `127.0.0.1:4602` — 9/9: preview
  200 with checkout/diff/checks/confirmToken (fixture `WORK-99`, remote = local bare inside the
  container), `400` bad-action / not-a-ticket-id / confirmToken-required / bad-actor, `404`
  no-checkout, `409` stale-preview on push and pr, `403` foreign origin; witnesses: the fixture
  bare carries 0 refs and no `publish-actions.jsonl` row exists. The browser confirm-walk and the
  real-provider evidence are Mateusz's separate human run (§6 S5) — no publish with a valid
  confirmToken was ever posted outside the test fixture.
