---
name: task-list-is-ephemeral
description: TaskCreate/TaskUpdate task lists do not survive session close — always mirror long-running work state into docs/STATE.md
metadata:
  type: feedback
---

The in-session task list (TaskCreate/TaskUpdate) lives **only in memory** — closing Claude Code destroys it. It is NOT persisted to disk. A fresh session starts with an empty task list regardless of how many tasks the previous session tracked.

**Why:** Mateusz asked (2026-06-16, office F1–F12 sharing work) whether the task list would survive a session restart. It would not. The list is ephemeral UI state; the only durable bookmarks are files on disk (code, git status, docs/STATE.md).

**How to apply:**
- For any multi-session work, mirror the real state into `docs/STATE.md` (CLAUDE.md already mandates this: "Stan długiej pracy w docs/STATE.md"). Put a clearly-marked "AKTUALNA PRACA" section at the top.
- The STATE entry must be self-contained: what's done, what's in progress (with exact files + verification commands), what's next, decisions not to re-litigate, and a ready-to-paste startup prompt for the next session.
- The task list is still useful *within* a session for tracking immediate work — just never treat it as the source of truth across sessions.
- Related: [[au]] project, [[workflow]].
