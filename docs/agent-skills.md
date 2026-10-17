# Agent skills — vendored, shared, and tracked (FOC-898 P1-A)

Every child agent receives a baseline set of **shared skills** at launch, plus
whatever its own squad ships. The Supervisor additionally carries a tracked
copy, because its `CLAUDE_CONFIG_DIR` is the repo's own `agents/supervisor`.

## Where skills live

- `agents/_shared/skills/<name>/SKILL.md` — the source of truth. Copied into
  **every** child's launch dir per turn by `agent-launch-profile.mjs`
  (`sharedSkillsDir` → `<destDir>/skills/`), before the squad's own `skills/`
  is copied — so a squad file at the same relative path **overwrites** the
  shared one. A missing `_shared/skills` is silently fine.
- `agents/supervisor/skills/<name>/` — a tracked byte-copy of **every**
  shared skill above (mirrored by `node scripts/shared-skills.mjs
  check|sync`), carried by the Supervisor's config dir (native:
  `agents/supervisor`; Docker: the seeded copy under `LA_SQUAD_HOME`). Only
  the third-party `archify/` and `diagram-design/` there stay gitignored.

## Skills

| Name              | Upstream                                           | Upstream path                  | Commit    | License | Triggered by |
|-------------------|----------------------------------------------------|--------------------------------|-----------|---------|--------------|
| `grilling`        | https://github.com/mattpocock/skills               | `skills/productivity/grilling` | `49dd158` | MIT     | Supervisor before answering a plan-approval gate; `plan` before GATE 1 |
| `grill-me`        | https://github.com/mattpocock/skills               | `skills/productivity/grill-me` | `49dd158` | MIT     | User-invoked only (`disable-model-invocation: true`) — the model cannot self-trigger it |
| `codegraph-expert`| — (own skill, no upstream)                         | —                              | —         | —       | Recon/review/planning roles |
| `working-state`   | — (own skill, no upstream)                         | —                              | —         | —       | Every Supervisor child + the Supervisor (contract lines in each role's CLAUDE.md) |

Each vendored `SKILL.md` carries a provenance comment right after its
frontmatter; the MIT license text sits next to it (`../grilling` for `grill-me`).
Own skills (no upstream) carry neither.

## Keeping the two copies identical

Two copies of the same bytes drift when someone edits one side. Catch and fix:

```
node scripts/shared-skills.mjs check   # exit 1 on any missing/differs/extra file
node scripts/shared-skills.mjs sync    # copy _shared over the Supervisor copy; never deletes
```

`check` is also pinned by `scripts/shared-skills.test.mjs` against the real
repo tree, so tracked copies cannot drift unnoticed.

## How to add a skill

1. Create `agents/_shared/skills/<name>/SKILL.md` (vendored: add the
   provenance comment and the LICENSE file).
2. `node scripts/shared-skills.mjs sync` — lays the tracked copy into
   `agents/supervisor/skills/<name>/`.
3. Add the trigger line(s) to the owning squad's `CLAUDE.md` (e.g.
   `agents/supervisor/CLAUDE.md`) — a skill nobody is told to run never runs.
4. `node scripts/shared-skills.mjs check` — must pass; the test suite re-proves it.
