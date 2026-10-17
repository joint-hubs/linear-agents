---
name: working-state
description: Read a known fact from the agent working state before searching for it; store a fact you will need again in this task; retire it when done.
---

# working-state

The `=== WORKING STATE ===` block injected at SessionStart is the rendered view
of the agent-state store — it is already in your context, so read it first.

## The four commands

One line each; the namespace is derived from your session environment — never
pass `--namespace`. `$LA_ROOT` is set in your environment.

```bash
node "$LA_ROOT/scripts/agent-state.mjs" get --key branch
node "$LA_ROOT/scripts/agent-state.mjs" set --key branch --value "foc-730-working-state-skill" --reason "branch resolved from the worktree" --scope task
node "$LA_ROOT/scripts/agent-state.mjs" retire --key branch --reason "handed off to REVIEW"
node "$LA_ROOT/scripts/agent-state.mjs" list
```

- `get` a known parameter BEFORE searching the context, Linear or git for it:
  issue, branch, worktree, base revision, milestone, epic, run id, role,
  acceptance-criteria reference.
- `set` an agent key the moment you learn something you will need again in
  this task — always with a one-line `--reason`; `--scope task` is the default
  for task facts, `--scope turn` keeps the fact for this turn only, and
  `--ttl <seconds>` sets an explicit expiry.
- `retire --key` when the value has been used and is not needed again.
- `list` shows what the namespace holds when the block was cut short.

## Limits and rules

- Caps: 50 active agent keys per namespace, 2048 UTF-8 bytes per value.
- NEVER store secrets (the CLI refuses secret-shaped values), long text (store
  a path instead), or anything already covered by a base key (the CLI refuses).
- Raw writes to the store file are denied in your permission list — only the
  CLI writes, and every change it makes is recorded in the store's history.