# Supervisor — manual e2e checklist (FOC-116, spec §8.12)

The scripted suite (`node scripts/test-all.mjs`, 30 files) proves the parts against a mock
`claude`. It cannot prove the one thing this epic is actually about: that **Mateusz never opens a
child terminal**. That is a claim about a human session, so it gets walked by hand, once, on a
throwaway issue, before first real use.

Walk it after merge and before the first real issue (§9 rollout). One pass covers all ten
acceptance criteria; the order below is the order they occur naturally in a single run, not the
order they are numbered.

> **Ground rule for the whole walk.** The moment you type into a child window, the run has failed
> AC-1 — finish the walk, but record it. The child terminal is the thing this epic exists to
> remove; a walk that quietly used one proves the opposite of what it claims.

---

## 0. Setup

```bash
node scripts/linear-query.mjs team FOC          # confirm the workspace answers
node scripts/test-all.mjs                       # 30/30 before you start; a red suite invalidates the walk
git diff --stat -- agents/orchestrator          # AC-10, see below
```

Create a throwaway Linear issue in FOC with a real but trivial body (one acceptance criterion,
something a DEV child can actually finish — a one-line script change with a test). Do **not** reuse
a real issue: the walk deliberately forces a crash and a failed review, and both leave comments.

Then, and only then:

```bash
bin\supervisor.bat
```

The launcher prints `run=<RUN_ID>`. Everything below runs inside that session, so `LA_SUPERVISOR_RUN`
is already in the environment and `--run` can be omitted.

---

## The ten criteria

### AC-10 — Orchestrator untouched
**Check first, because it needs no session at all.** The DoD is literal: `git diff -- agents/orchestrator`
must be empty across the whole epic.

```bash
git diff --stat origin/main..HEAD -- agents/orchestrator
```

- [ ] Output is empty.
- [ ] `bin\orchestrate.bat` still starts and picks up work standalone.

*Measured 2026-08-26 on this branch: 0 files. The squads' own CLAUDE.md files DID change — that is
§1.6 and it is AC-10-compatible, because those changes are inert unless `LA_SUPERVISOR=1`, which
only `supervisor-spawn.mjs` sets.*

### AC-2 — Explicit triage, before anything spawns
```bash
node scripts/supervisor-triage.mjs propose --issue <ID>
```

- [ ] The proposal names a `node` that exists in `config/graph.json`, with its `autonomy`.
- [ ] The Supervisor shows you the rationale, the `unknowns[]` **and** the confidence — not just the verdict.
- [ ] You confirm or override; the Supervisor then records it.
- [ ] `.state/supervisor/<run>/triage.json` exists before any child does.

Force the refusal once, to see fail-closed working:

- [ ] `supervisor-spawn.mjs` on a run with no `triage.json` exits 1 and spawns nothing.
- [ ] `record --verdict dev --confidence 50` is refused — under 70 the verdict must be `ask`.

### AC-5 — Gate relay (one GATE 1 answer)
Triage a *planning* issue so a PLAN child runs and reaches GATE 1.

- [ ] The PLAN child **ends its turn** at the gate instead of waiting. Its status becomes
      `waiting_gate` — a clean exit with an open question, not a failure.
- [ ] It did **not** set a Linear `needs:*` label. Supervised mode is a third mode: no REPL wait
      and no `needs:*`.
- [ ] `supervisor-gate.mjs list --status pending` shows the gate; the Supervisor reads the question
      to you **verbatim**.
- [ ] You answer in the Supervisor session. It records first, delivers second:
      `answer --gate <id> --text "..."` then `followup --child <id> --gate <id> --prompt "..."`.
- [ ] The child continues from the same session (its `sessionId` is unchanged).

Try the order backwards once — [ ] `followup --gate` on a still-`pending` gate is refused.

### AC-4 — Follow-up resumes, never restarts
- [ ] After any turn ends, `supervisor-followup.mjs --child <id> --prompt "..."` resumes the
      **same** session (`--resume <sessionId>`).
- [ ] The answer appears in the **same** tee file, and `turns[]` grew by one.
- [ ] A follow-up while the child is still `running` is refused.

### AC-1 — Sole interlocutor (the whole walk)
- [ ] From `bin\supervisor.bat` to the terminal state, you never typed in a child window.
- [ ] Every child ran headless, in its own worktree, with no console.
- [ ] The issue reached a terminal state: done, or escalated **with a specific question**.

This is the only criterion you cannot check at a single moment — tick it at the end, honestly.

### AC-3 — Concurrent children
- [ ] With the DEV child's turn ended (`exited`, resumable), spawn a REVIEW child.
- [ ] DEV's `sessionId` in the registry is unchanged and DEV is still resumable while REVIEW runs.
- [ ] Each child's `worktree` in the registry is a different path.

Two simultaneously live `-p` turns are permitted but not required. One live child per run is a
**policy** guard (`MAX_LIVE_CHILDREN_PER_RUN`), lifted by FOC-161, not a technical limit —
worktrees already make it safe.

### AC-6 — Review loop, capped (one forced REVIEW fail)
Force it: put an obvious blocking defect in the DEV output, or answer the review gate with a FAIL.

- [ ] REVIEW returns FAIL → the Supervisor resumes **DEV** with the findings (`--review-loop`),
      not a fresh spawn.
- [ ] The issue is **never** marked Done on a failed review.
- [ ] Drive it to the cap: the third `--review-loop` resume is refused (exit 1), no third DEV turn
      starts, and the Supervisor presents **both positions** to you rather than picking one.

### AC-9 — Crash honesty (one forced crash)
Kill a child mid-turn from Task Manager or `taskkill /PID <pid> /T /F`.

- [ ] The watcher marks it `crashed` with the real `exitCode`.
- [ ] The Supervisor shows you the **tail** of the tee — actual events, not a paraphrase.
- [ ] **No silent retry.** The registry still shows one child and one turn. You are asked:
      resume / respawn fresh / abandon.

The subtle failure to watch for: a `waiting_gate` child looks idle and its tee goes quiet forever
(it is waiting on you). It must **not** be reported as stalled.

### AC-7 — Push/PR blocked (one push-approval)
- [ ] A child attempting `git push` or `gh pr create` is refused by the harness deny-rule before
      git runs.
- [ ] The push happens only after you answer a `push-approval` gate — and the **Supervisor** runs
      it, never the child.

**Honesty note, and it is part of the criterion:** deny-rules are Claude-settings enforcement, not a
sandbox. `cmd /c git push`, `powershell -c`, `git -C <path> push` and wrapper scripts all walk past
them. The human gate is the real control; the deny list removes the accidental push, not the
determined one. Verified empirically 2026-08-26: a real child under `--permission-mode
bypassPermissions` was refused — deny outranks bypass.

### AC-8 — No secrets in Linear
- [ ] Read every comment the run posted. No tokens, keys, passwords, connection strings.
- [ ] Snippets the Supervisor showed you came from `supervisor-status.mjs` and are redacted.
      (Gate text is **not** redacted, deliberately — a relay through a redactor is not a relay.
      The control there is "never put secrets in Linear comments", not filtering.)

---

## Worktree cleanup (FOC-167) — walk it at the end

Not one of AC-1…AC-10; it is the lifecycle that closes the run, and the only place in the system
that may delete a checkout.

- [ ] With the issue **not yet** Done, `cleanup propose` refuses and emits **no gate**.
- [ ] Once TEST passes and the issue is Done, `propose` writes a `cleanup-approval` gate. The
      Supervisor reads you the **dirty paths verbatim** — those are the files that die.
- [ ] Answer with something qualified ("yes, but keep the log") once: `remove` refuses.
- [ ] Touch a file in the worktree after approving: `remove` refuses, because the tree moved since
      the yes.
- [ ] Answer cleanly, then `remove`: the checkout is gone from disk **and** from `git worktree list`,
      and the branch plus its commits are still there.

---

## What to do with a failed box

Do not fix it inside the walk. Note the box, the command, and what actually happened, then finish
the remaining boxes — a walk abandoned at the first failure tells you about one criterion instead
of ten. File each failure as its own issue under FOC-116.

---

## PR description material

Everything below belongs in the FOC-116 PR body.

### Rollout
Single PR. Nothing changes for existing flows until someone runs `bin\supervisor.bat`. No data
migration, no schema change, no dashboard change. Feature flag is implicit — the launcher itself.

### Squad CLAUDE.md rules amended (§1.6, FOC-125)

Each of the four squads gained an identical `<supervised_mode>` section, and **15 existing rules**
were ridered with `**Unless \`LA_SUPERVISOR=1\`** — see *Supervised mode*.` rather than rewritten:
`plan` 5, `dev` 4, `review` 3, `test` 3. DEV additionally has a `### DEV only` subsection covering
its single resume path.

The rules touched fall into four groups:

| Group | What changes under supervision |
|---|---|
| `needs:*` + walk away | Becomes a gate record. No Linear label, no REPL wait — a third mode. |
| "notify Mateusz" | Becomes a `question` gate. A child cannot reach him directly. |
| WIP files (`.state/*-wip.json`) | Crash checkpoint only, never a resume trigger — the Supervisor resumes the session. |
| Loop caps / escalation | Same cap, now also enforced in tooling (`supervisor-followup.mjs --review-loop`). |

All of it is **inert unless `LA_SUPERVISOR=1`**, which only `supervisor-spawn.mjs` sets. That is
what keeps AC-10 true while the squad prompts changed.

### Verification
- `node scripts/test-all.mjs` → 30/30 files (§8.1–8.11).
- This checklist, walked once on a throwaway issue (§8.12).
- `git diff -- agents/orchestrator` empty (AC-10).

### Rollback
Revert the PR. `.state/supervisor/` is disposable. Existing squads are bitwise-unchanged in
behaviour when unsupervised. Worktrees left under `../la-wt/` are reclaimed with
`supervisor-cleanup.mjs`, or by hand with `git worktree remove` once you have read what is in them.

### ADR status
ADR-0009 stays **Proposed**. It is accepted at GATE 2, which is a separate decision — this PR does
not accept it.
