# Linear Issue Templates

This directory contains Markdown templates for Linear issue bodies. They are consumed by
[`scripts/bootstrap-linear.mjs`](../../scripts/bootstrap-linear.mjs) to seed Linear issue templates
idempotently during workspace setup.

## Template types

| File          | `type:` label | Purpose                              |
|---------------|---------------|--------------------------------------|
| `feature.md`  | `type:feature`| User-visible feature or improvement  |
| `bug.md`      | `type:bug`    | Defect or regression                 |
| `spike.md`    | `type:spike`  | Research, decision, ADR output       |
| `tech.md`     | `type:tech`   | Tech-debt, refactor, infrastructure  |

## Conventions

- **Body language**: English (codebase standard).
- **Sections**: each template follows the same skeleton with type-specific deviations.
- **Labels**: type labels are set by the template file choice; additional labels (`needs:*`, `risk:*`,
  `ai:*`, flags) are applied by agents during the workflow, not baked into templates.
- **Estimates**: t-shirt scale (XS / S / M / L / XL). XL → re-decompose into smaller slices.
- **Relations**: parent/sub links are set by the decomposer agent at creation time, not in templates.

## Adding a new template

1. Create `<name>.md` in this directory.
2. Add the `type:*` label that matches the file's purpose.
3. Update `bootstrap-linear.mjs` to include the new file in its upsert loop.
