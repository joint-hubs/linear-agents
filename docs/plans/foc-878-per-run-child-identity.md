# FOC-878 — per-run child identity in the container

Status: **accepted 2026-11-07** (Mateusz). Delivered on branch `foc-878-dev-ee47527427dd` —
the delivery journal is `docs/state/FOC-878.md`. This document is the design basis of the
implementation; every resolved ambiguity and deviation is recorded in the journal.

## 1. What is true today (FOC-802)

- Every child of every run runs as ONE uid, `fenix-child`, primary group `fenix`; `node` (the
  Supervisor) is a member of `fenix`.
- `fenix-spawn-as-child` (root for milliseconds via sudo) validates the spawn and hands over the
  worktree, its `.git/worktrees/<name>` dir and the launch dir to `fenix-child:fenix` with setgid
  dirs and `g+rw` — so `node` keeps writing them through the group.
- The run dir `<stateHome>/<run>/` is `node`-owned `0755`; its shared subdirs `children/`, `gates/`,
  `verdicts/`, `launch/` are `02775` group `fenix` (`ensureRunDir`); `edits.jsonl` at the run root
  is appended with mode `0664`. Children write their tees, gates, verdicts, launch state and edit
  rows there.
- `child.env` (provider keys) is `0640 fenix-child:fenix` after the handover, for the milliseconds
  until the child shell unlinks it.

The documented residual (`docs/plans/foc-802-child-isolation.md`, security review 2026-10-16):
**a compromised child of run A can write run B's `gates/`, `verdicts/`, `edits.jsonl`, read run B's
`child.env` during its lifetime, and — because it IS the same uid — write run B's worktree.** The
Supervisor's own files, `host.token` and the tmux socket are protected; the child-to-child boundary
is not.

## 2. The invariant to establish

A child of run A, however compromised, cannot write run B's gates, verdicts, edits, launch state,
tees or worktree, and cannot read run B's `child.env`. The Supervisor (`node`) keeps every write it
has today. Nothing a child writes for its own run changes shape.

Two observations drive the design:

1. **The uid is the identity.** Files the child must own (worktree, gitdir, launch dir, env file)
   are protected by ownership, so a per-run **group** alone does nothing against another child
   that carries the same uid. Per-run identity means a per-run **uid**.
2. **`node` cannot join groups at run time.** Supplementary groups are fixed when a process starts;
   the Supervisor's session and its watchers are long-lived, so a group created by the helper at
   first spawn is invisible to them. Anything `node` must write through a group needs a group that
   existed when the container started — a **static pool**.

## 3. Variants

| | A. uid pool per run | B. group per run (ACL or dynamic group) | C. narrow write helper |
|---|---|---|---|
| Idea | `fenix-child-0..N-1` baked into the image; a run is assigned one on its first spawn and every child of the run uses it | keep one uid, give each run its own group/ACL on the shared subdirs | children never write run state directly; a setuid helper writes on their behalf after validating the run |
| Closes the worktree / env-file hole | yes (ownership) | **no** — same uid still owns every worktree and env file | no — same uid |
| Closes the shared-subdir hole | only with a per-run group or ACL on the subdirs | yes | yes |
| `node` keeps writing | yes if the run group is from a static pool `node` already belongs to | dynamic groups: **no** (see §2.2); ACLs: yes, but ACLs need an acl-capable mount — true for Docker named volumes (ext4 in the VM), **not** for Windows bind mounts | yes |
| Image change | users + groups at build, `set-uid.sh` remaps a pool, sudoers runas group for `fenix-child-share` | none for dynamic groups; `setfacl` in the image for ACLs | a third sudo command |
| Verdict | **necessary** | insufficient alone; its pool form is the complement of A | does not address the identity problem; a child can forge its own env, so the helper cannot derive the run from it |

**Recommendation: A + B in their static-pool form, no ACLs** — one uid/gid pair per run from a pool
baked into the image. Ownership protects what the child owns, the run group protects what `node`
owns and the child must write, and `node` is a member of every pool group from container start.

## 4. The design (A + B, static pools)

**Image (`set-uid.sh`, Dockerfile, `Dockerfile.uid`).** `FENIX_CHILD_POOL` (default 16) identities:
users `fenix-child-<n>` with uid `FENIX_CHILD_UID + n` (the first keeps today's numbers), primary
group `fenix-run-<n>` (gid `FENIX_CHILD_GID + n`), supplementary group `fenix` (read-only access to
the shared `/data` trees stays as it is), home `/home/fenix-child-<n>` `0700` with the same
`.gitconfig` as today. A `fenix-children` group holds all of them. `node` is added to every
`fenix-run-<n>`. `set-uid.sh` remaps the whole pool on the thin layer exactly as it remaps the one
user today. Sudoers: `fenix-child-share` runs as `(%fenix-children)` instead of `(fenix-child)`.

**Run identity (`fenix-spawn-as-child`).** On a run's first spawn the helper (root) chooses the slot:
the lowest `n` whose `fenix-child-<n>` has no live process AND no other run's `identity.json` names
it (`/proc` scan + a scan of `<stateHome>/*/identity.json` for runs with live children per their
registry); writes `<stateHome>/<run>/identity.json` `{ "slot": n, "user": "fenix-child-<n>",
"group": "fenix-run-<n>", "assignedAt": … }` as root, `0644 root:root` — children cannot rewrite it;
and chowns the run's shared subdirs to `node:fenix-run-<n>` `02770`, `edits.jsonl` to
`node:fenix-run-<n>` `0660` (created if missing). Every later spawn of the same run reads
`identity.json` and refuses (exit 97) if the slot's uid does not match. Pool exhausted → refuse with
`identity-pool-exhausted`; the Supervisor surfaces it as a hold, never a silent fallback to a shared
uid.

**Handover.** Unchanged in shape, different identity: worktree, gitdir and launch dir →
`fenix-child-<n>:fenix-run-<n>`, dirs `2770`, files `0660`. `node` is in `fenix-run-<n>`, so its
writes (cleanup archive, `git worktree remove`, the watcher's tee) keep working; `fenix-child-<m>` of
another run is neither owner nor member → no access. `child.env` → `0600 fenix-child-<n>`: readable
by the owner only; the watcher writes it as `node` `0640` before the handover exactly as today, the
helper tightens it to `0600` after the chown. Scratch and caches: `/tmp/fenix-child-<uid>` and
`/home/node/.cache/fenix-child-<n>` are per uid already by construction; the entrypoint's
`fix_cache_permissions` loop covers the pool directory names.

**Library (`supervisor-lib.mjs`).** `ensureRunDir` keeps creating the four subdirs; on POSIX it
leaves the group to the helper (the helper owns the `chgrp` as root to keep one writer of the
identity; `node` could do it too, being a member of the pool groups). A run with no `identity.json`
(legacy, or a run that never spawned) keeps today's `02775 fenix` surface — nothing breaks for old
runs.

**Status.** `supervisor-status` shows `identity: fenix-child-<n> (slot n)` per run from
`identity.json`, and `- (shared fenix-child)` for a legacy run; the registry gets `identity` on each
child's entry at spawn so a child's own view is on record.

**Sweep.** `fenix-child-sweep` already signals by mark, not by uid — it works for every pool user
after one check that its `/proc` scan is not filtered on the single name.

## 5. Acceptance (the ticket's AC, made executable)

`docker/test-isolation.sh` gains a two-run block, run as root in CI like today's probes:

1. Spawn a child for run A and one for run B through the real helper (fake claude): the two
   `identity.json` files name different slots; `id -u` inside each probe matches its slot.
2. From run A's child: writing `<B>/gates/x.json`, `<B>/verdicts/x.json`, appending `<B>/edits.jsonl`
   and creating a file in run B's worktree all fail with EACCES; reading `<B>/launch/<child>/child.env`
   fails with EACCES (the file is kept alive for the probe).
3. From run A's child: its own gate, verdict, edits row and worktree write succeed — the FOC-802
   probes keep passing on the pool identity.
4. As `node`: writing into run A's and run B's subdirs and worktrees succeeds (the `fenix-run-<n>`
   membership).
5. Pool exhausted (`FENIX_CHILD_POOL=1`, two runs): the second run's spawn is refused with
   `identity-pool-exhausted`, nothing modified.

Plus: `supervisor-status` shows the identity; the thin uid layer (`Dockerfile.uid`, CI step "Thin
uid layer") remaps the whole pool and the isolation lane passes on it too.

## 6. Out of scope (as the ticket says)

Sandboxing (bubblewrap/firejail), the api container, secret hygiene of the child env, and a uid per
**child** (per run is the boundary the incident needs; per child would multiply the pool with no
extra protection against the cross-run case).

## 7. Risks and costs

- **Pool size vs concurrency.** 16 slots cover FOC-1076's three concurrent sessions many times over;
  a slot is reusable once its run has no live child and the next run claims it. Exhaustion is loud.
- **Image rebuild and remap.** Every install needs `fenix update`; `set-uid.sh` remaps 16 users
  instead of one — the thin-layer CI step proves it. Existing runs (no `identity.json`) keep the
  shared surface until they end; nothing migrates in place.
- **Security review.** The helper grows (slot choice, identity file, tightened modes) and stays the
  only privileged path; the sudoers change is one runas group. A second REVIEW pass with the FOC-802
  checklist (symlink gates, TOCTOU re-check, no-new-privs exec) is part of the ticket, not optional.
- **Estimate.** Medium-large: two DEV rounds are likely (image + helper + lib, then status + the
  isolation probes), each with the container isolation lane as its gate. Order inside the ticket:
  (1) image pool + `set-uid.sh` + sudoers, (2) helper identity + handover modes + `identity.json`,
  (3) `ensureRunDir` + `edits.jsonl` group, (4) status + registry, (5) `test-isolation.sh` probes
  1–5, (6) docs (`docs/plans/foc-802-child-isolation.md` residual closed,
  `multi-supervisor-isolation-prd.md`, e2e checklist). Nothing in `agents/*/settings.json` or
  `config/autonomy.json` moves.

## 8. Decision asked

Accept A + B (static uid/gid pools, no ACLs) as the FOC-878 design, with the acceptance block in §5
as the ticket's Done-when. On acceptance the delivery owner kicks the ticket off to DEV with this
document as the spec; REVIEW walks the FOC-802 checklist on the helper.
