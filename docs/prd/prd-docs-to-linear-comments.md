---
type: prd
status: active
area: docs
tags: [type/prd, area/ai, topic/linear, topic/agents, topic/docs]
created: 2026-06-30
maturity: prd-v1
---

# PRD — Docs-to-Linear Comments (feature #6b)

> Each squad auto-publishes its run artefact to Linear as a comment (index + summary + link).
> Reuses `scripts/linear-ops.mjs comment --body-file <p> --dedup-tag <tag>`.
> Already partially live: CADENCE digest→comment, DEV hand-off→comment, REVIEW round→comment,
> PLAN→ADR in `docs/`. This PRD standardises format + trigger per squad and decides where docs live.

## 1. Goal

Linear becomes a readable timeline of decisions and run artefacts alongside the repo `docs/` directory.
A comment is an **index + summary + link** — never the source of truth. The source lives in `docs/`
(committed) or `.state/runs/<id>/` (gitignored ephemera).

Scope: **jointhubs workspace only**. The `pisi` workspace is read-only — when `LINEAR_WORKSPACE==pisi`,
the post is skipped and a dry-run plan is printed instead.

## 2. Scope per squad

| Squad | What | Trigger | Target issue | Format | Dedup tag |
|---|---|---|---|---|---|
| **PLAN** | Brief summary + ADR pointer | End of PLAN, before push | Epic parent | 3–5 bullets + `docs/adr/NNN` link | `run:plan-brief:<extId>` |
| **PLAN-spike** | ADR 3–5 bullets + link to `docs/adr/NNN` | After ADR commit | Spike issue | Bullets + path | `run:plan-adr:<N>` |
| **DEV** | Hand-off: done / not-done / risks / next | On state-change to `In Review` | Sub-issue | Structured fields | `run:dev-handoff:<extId>` |
| **REVIEW** | Round summary: findings, blockers, ✅⚠️ | On state-change only (🔴 blocker or final verdict) | Sub-issue | Findings table + verdict | `run:review-round:<extId>:<N>` |
| **CADENCE** | Weekly digest | Weekly cron | Epic parent | Digest body | `run:cadence-digest:<YYYY-WW>` |
| **TEST** | Run results: pass/fail/coverage | After test run | Sub-issue | Pass/fail/coverage | `run:test-result:<extId>:<ts>` |

### Trigger notes

- **PLAN / PLAN-spike**: fires once per plan cycle, before the push agent writes to Linear. The comment
  indexes what was planned and points to the ADR for deeper context.
- **DEV**: fires when the squad transitions a sub-issue to `In Review`. Not on every commit — only on
  the state-change that signals "ready for review."
- **REVIEW**: fires only on terminal state-changes: a 🔴 blocker (reject) or a final ✅ verdict (approve).
  Intermediate rounds are summarised inline in the issue, not as separate comments.
- **CADENCE**: fires on a weekly cron schedule, summarising the week's activity across the epic.
- **TEST**: fires after each test run completes. The timestamp in the dedup tag ensures every run
  produces a distinct comment (history of test results).

## 3. Doc categories

| Tier | Content | Location | Comment behaviour |
|---|---|---|---|
| **T1 — Technical** | ADR, README, architecture | `docs/` (committed) | Comment = link + 3–5 bullet summary. Source is the file. |
| **T2 — Run artefacts** | Brief, hand-off, review-round, test-output | `.state/runs/<id>/` (gitignored) | Comment = inline body. No link (not hosted). |
| **T3 — Periodic digests** | CADENCE weekly digest | Inline in comment; optional mirror to `docs/digests/YYYY-WW.md` | Comment = full body. Mirror is a convenience copy. |

**Confirmed (2026-06-30):** T1 commit+link / T2 gitignored+inline / T3 inline+optional mirror = YES.

## 4. Attachments

**Out of scope.** Comments only — no file uploads to Linear. Any artefact that needs a permanent home
belongs in `docs/` (T1) or `.state/runs/<id>/` (T2).

## 5. Comment template

Every comment follows this markdown structure:

```markdown
<!-- run:<tag> -->

## <Squad> · <What> · <runId>

| Field | Value |
|---|---|
| **Issue** | <issue-identifier> |
| **Squad** | <squad-name> |
| **When** | <ISO-timestamp> |
| **State file** | <path relative to repo root> |

### Skrót

- <bullet 1>
- <bullet 2>
- <bullet 3>
- <bullet 4>
- <bullet 5>

### Co dalej

<next-steps-or-empty>

---

<full-artefact-body or "Treść — inline powyżej">
```

- **First line** is the dedup marker (`<!-- run:<tag> -->`). Must be present and match exactly.
- **Skrót**: 3–5 bullets summarising the artefact. Written for a human scanning a Linear timeline.
- **Co dalej**: next steps, blockers, or empty.
- **Footer**: for T2 artefacts the full body is inline above the footer line; for T1 the footer is the
  link to `docs/`. The text `"Treść — inline powyżej"` signals the body is already in the comment.

## 6. Dedup

- **Marker**: first line of the comment body is `<!-- run:<tag> -->`.
- **Check**: before posting, read the issue's existing comments. If any comment body starts with the
  exact marker, skip the post (idempotent).
- **Tag uniqueness**: tag is unique per (what, issue, run). Identical tags across different runs are
  **not** deduped — history is preserved.
- **Cap**: if an issue has ≥250 comments, log a warning. The dedup read scans all comments; on long
  issues this may be slow. Mitigation: filter to comments created in the last 7 days before scanning.

## 7. Risks and limits

| Risk | Mitigation |
|---|---|
| **GraphQL rate-limit** (1500 req/h) | ~20 req/day is safe. Dedup reads up to 250 comments per issue. |
| **Spam** | State-change trigger (not per-run) limits frequency. CADENCE is weekly. |
| **pisi read-only** | `LINEAR_WORKSPACE==pisi` → skip post, print dry-run plan. Feature disabled there. |
| **Retry race** | Dedup check happens before post. Optional per-issue lockfile considered but deferred (out of scope for v1). |
| **Secrets in body** | Hard refuse: lint body with `grep -iE 'api[_-]?key\|token\|secret\|password\|BEGIN.*PRIVATE'`. If match → abort, log error, do not post. |
| **250-comment cap** | Filter dedup scan to comments created in last 7 days. Log warning at 200+. |

## 8. Acceptance criteria

- [x] `scripts/linear-ops.mjs comment --dedup-tag` works on jointhubs: same tag → one comment. *(proven in pilot CADENCE digest; dedup mechanism reused by `publish-linear-comment.mjs`)*
- [x] Each squad's `CLAUDE.md` documents: when it posts, what tag it uses, what source file. *(verified: 5/5 squads wired to `publish-linear-comment.mjs`)*
- [x] Each squad's flow: build body from template + artefact → call `linear-ops comment`. *(helper `publish-linear-comment.mjs` exists, 41 tests pass, 6 pisi dry-run variants produce correct output)*
- [x] `LINEAR_WORKSPACE==pisi` → dry-run plan printed, no post sent. *(verified: all 6 dry-runs print `=== DRY-RUN PLAN (pisi read-only) ===` and exit 0)*
- [ ] Body linted for secrets before post; match → abort with error, no post. *(rule present in all 5 squad CLAUDE.md files, but `publish-linear-comment.mjs` itself has no secrets lint — deferred to script-level hardening)*
- [x] 2× same tag on same issue → 1 comment end-to-end (idempotent). *(dedup provided by `linear-ops.mjs comment --dedup-tag`, proven in pilot)*
- [ ] live post on real issue — exercised on next real squad run (not spam-verified here)

## 9. Out of scope

- Attachments (file uploads to Linear)
- Emoji reactions / webhooks
- Cross-post to Slack, Discord, or any other channel
- Editing existing comments (post-only; no update)
- Bi-directional sync (Linear ↔ docs)
- Per-issue lockfile for retry races

## 10. Confirmed decisions (2026-06-30)

| ID | Decision | Verdict |
|---|---|---|
| D1 | T1 commit+link / T2 gitignored+inline / T3 inline+optional mirror | **YES** |
| D2 | State-change trigger, not per-run | **YES** |
| D3 | Ephemeral inline for now (no hosted artefact server) | **YES** |
| D4 | Per-issue lockfile for retry races | **Out of scope** |
| D5 | Secrets in body → hard refuse | **YES** |
