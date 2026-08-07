---
name: refine
description: Build or enrich a Linear task — /refine ISSUE-ID enriches existing, /refine "text" creates new. Always previews before writing to Linear.
trigger: /refine
---

# /refine — Build a complete Linear task

Two modes:
- `/refine JOI-45` — enrich an existing sparse issue
- `/refine "krótki opis pomysłu"` — create a new issue from scratch

---

## Standard template (used in both modes)

```markdown
## Context
[What and why — 2-3 sentences. What problem? Which area of the codebase?]

## Acceptance Criteria
- [ ] ...

## Definition of Done
- [ ] Tests written and green
- [ ] Code reviewed (if applicable)
- [ ] [project-specific items]

## Technical Notes
**Files:** `path/to/file.py`
**Patterns:** [existing patterns to follow]
**Pitfalls:** [known traps — check project GOTCHAS.md if present]
```

---

## ThoughtMap context (best-effort, both modes)

Before drafting, if `mcp__thoughtmap__search_thoughts` is available, call it
once with the issue title / idea text. ThoughtMap indexes Mateusz's Obsidian
notes and can surface prior research, noted commands, or QA scenarios related
to the topic — fold anything relevant into Context or Technical Notes, citing
the source note path. Skip silently if unavailable or empty; never block the
draft on this.

## Mode A — Enrich existing issue

Triggered when the argument looks like an issue identifier (e.g. `JOI-45`, `PISI-12`).

1. Detect workspace: `PISI` prefix → pisi; else → jointhubs
2. Read the issue and its comments:
   ```
   python C:\Users\mateu\AppData\Local\hermes\scripts\linear_tasks.py [-w pisi] show <ID>
   python C:\Users\mateu\AppData\Local\hermes\scripts\linear_tasks.py [-w pisi] comments <ID>
   ```
3. If the issue mentions specific files or areas — do a quick recon (Glob/Grep, no large file reads)
4. Draft the enriched description using the template above
5. **Show the full markdown to Mateusz and wait for approval before writing**
6. On approval — resolve UUID and update:
   ```python
   import sys; sys.path.insert(0, r"C:\Users\mateu\AppData\Local\hermes\scripts")
   import linear_api as la
   # la.use_workspace("pisi")  # uncomment for pisi
   issue = la.get_issue("<IDENTIFIER>")   # accepts "JOI-45" — returns dict with UUID in ["id"]
   la.update_issue(issue["id"], description="""<markdown>""")
   print(f"Updated {issue['identifier']}: {issue['title']}")
   ```
7. Confirm: "Zaktualizowano [ID]: [title]"

---

## Mode B — Create new issue

Triggered when the argument is free text (not an issue identifier).

1. Ask:
   - **Workspace?** jointhubs / pisi (default: jointhubs; only use pisi if explicitly asked)
   - **Projekt w Linear?** (skip if unknown — can be set later)
   - **Priorytet?** 1=Urgent 2=High 3=Medium 4=Low (default: 3)
2. If a repo path is available or implied — do targeted recon (Glob/Grep) to find relevant files
3. Draft the full issue (title + body using template)
4. **Show the full draft to Mateusz and wait for approval before creating**
5. On approval:
   ```python
   import sys; sys.path.insert(0, r"C:\Users\mateu\AppData\Local\hermes\scripts")
   import linear_api as la
   # la.use_workspace("pisi")  # uncomment for pisi
   me = la.get_viewer()
   result = la.create_issue(
       team_id=la.active_team_id(),
       title="<title>",
       description="""<markdown>""",
       priority=3,
       assignee_id=me["id"],
   )
   print(result["issue"]["url"])
   ```
6. Confirm: "Utworzono [new-ID]: [title] → [URL]"

---

## Rules
- ALWAYS show the full draft before any write to Linear
- Do NOT create issues in pisi unless Mateusz explicitly says so
- AC items must be testable (measurable outcome, not vague intent)
- Technical Notes: cite specific files when found via recon; write "N/A" for pure product/UI issues
- If the issue already has good AC/DoD, preserve them — only fill what's missing
