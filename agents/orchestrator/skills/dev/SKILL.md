---
name: dev
description: Start development from a Linear issue — reads AC/DoD/tech context, asks which repo, does recon, plans, implements.
trigger: /dev
---

# /dev — Linear issue → development

Two modes:
- `/dev` — show In Progress issues from both workspaces, ask which one
- `/dev JOI-45` or `/dev PISI-12` — jump straight to that issue

---

## Step 1 — Resolve the issue

**With ID:**
- Prefix `PISI` → workspace pisi; anything else → jointhubs (default)
- Read: `python C:\Users\mateu\AppData\Local\hermes\scripts\linear_tasks.py [-w pisi] show <ID>`
- Comments: `python C:\Users\mateu\AppData\Local\hermes\scripts\linear_tasks.py [-w pisi] comments <ID>`

**Without ID:**
- Run both workspaces and show a merged numbered list:
  ```
  python C:\Users\mateu\AppData\Local\hermes\scripts\linear_tasks.py list --state-type started --limit 20
  python C:\Users\mateu\AppData\Local\hermes\scripts\linear_tasks.py -w pisi list --state-type started --limit 20
  ```
- Ask: "Który task bierzemy?"

## Step 2 — Parse the issue

Extract:
- **Goal** — what is being built/fixed
- **Acceptance Criteria** — list of checkboxes (infer from description if absent)
- **Definition of Done** — completion conditions
- **Technical Notes** — files, patterns, pitfalls

## Step 3 — Ask for the repo

"W którym repo pracujemy? (ścieżka lub `.` dla bieżącego katalogu)"

Use the answer as `cwd` for all file reads and edits.

## Step 4 — Recon

Explore only what the issue points to (Glob + Grep + Read targeted files).
Do NOT read the whole codebase. Focus: where does the change land?

## Step 4b — ThoughtMap context (best-effort)

If the `mcp__thoughtmap__search_thoughts` tool is available, call it once with
the issue title + key terms (project name, entity names from the issue body).
ThoughtMap indexes Mateusz's Obsidian notes — this can surface commands he's
noted for this kind of task, QA scenarios he already wrote and reuses, or
research notes related to the issue that aren't in the repo. Fold anything
relevant into the plan in Step 5, with the source note path as provenance.
Skip silently if the tool isn't available or returns nothing useful — this
step must never block or fail the rest of `/dev`.

## Step 5 — Plan

Summarize: which files change, key decisions, implementation order.
Ask: "Plan gotowy — implementujemy?"

## Step 6 — Implement

Make the changes. Follow existing patterns. No explanatory comments.
No extra abstractions beyond what the task requires.

## Step 7 — Finish

- What changed (1-3 bullets, specific files/functions)
- How to test (exact steps for Mateusz)
- Propose commit per skill `git-checkpoint` — do NOT commit automatically
