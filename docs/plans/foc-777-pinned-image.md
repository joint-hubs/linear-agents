# Delivery Plan — FOC-777 `fenix up` / `update` pull the pinned image

Linear: **FOC-777** (M8, parent FOC-768, High). Depends on FOC-775's `publish-image` workflow (PR #116, main
d3633ea) having published at least one tag. Written 2026-10-20 by the delivery owner; recon against main d3633ea
(`fenix` CLI, `compose.yaml`, `Dockerfile:48-70`).

## 0. Today

- `compose.yaml` `x-fenix`: `image: fenix:dev` + `build:` with args `FENIX_UID`/`FENIX_GID` (the launcher sets them
  from `id -u/-g` on Linux, `set_build_uid()` `fenix:58-72`) and `FENIX_CHILD_UID`.
- `cmd_up` builds when `fenix:dev` is missing (`fenix:178-180`); `update)` = `git pull --ff-only` →
  `docker compose build --pull` → restart (`fenix:829-838`); `cmd_test` builds too (`fenix:732-736`).
- The uid stanza (`Dockerfile:50-64`: refuse 0, `groupmod`/`usermod -o`, `chown -R node:node /home/node /opt/fenix
  /data`) and the FOC-802 child-uid stanza run at build time — the GHCR image is built for 1000:1000 (FOC-775's
  note of 2026-10-12).

## 1. Contract

A. **Pinned reference.** `VERSION` file at the repo root (bumped in the release commit that gets tagged);
   `FENIX_IMAGE=ghcr.io/joint-hubs/fenix`; the effective ref = `${FENIX_IMAGE_REF:-$FENIX_IMAGE:$(cat VERSION)}`.
   `compose.yaml` → `image: ${FENIX_IMAGE_REF:-fenix:dev}`; the `build:` block stays for source mode.
B. **Two modes, one switch.** `fenix up|update` default = **pull** the pinned ref; `fenix up --source` /
   `FENIX_SOURCE=1` = build from the clone (today's behaviour — what CI and developers use). `fenix test` keeps
   building from source. A failed pull (tag not published yet, offline) → one-line cause + fix (`--source`), exit
   non-zero; no silent fallback.
C. **Thin uid layer.** On Linux with `id -u:id -g ≠ 1000:1000` the launcher builds `docker/Dockerfile.uid`
   (`ARG BASE; FROM ${BASE}; ARG FENIX_UID FENIX_GID FENIX_CHILD_UID; RUN sh /opt/fenix/docker/set-uid.sh`) tagged
   `fenix:local-<uid>-<gid>` and points `FENIX_IMAGE_REF` at it. The uid and child-uid stanzas move out of the main
   Dockerfile into `docker/set-uid.sh` (one source, both Dockerfiles run it) so the two paths cannot drift.
   Docker Desktop (macOS/Windows) and uid-1000 hosts use the pulled image as is.
D. **Visible.** `fenix doctor` prints `image: <ref> (<digest-short>, pulled | source | thin uid layer on <base>)`;
   `fenix update` prints old → new digest; QUICKSTART "Upgrade" rewritten (pull by default, `--source` for
   developers, what to do when the tag is not out yet); ACCESS one line.
E. **Release order (for FOC-790).** bump `VERSION` → merge → tag `v<VERSION>` → `publish-image` green → only then
   announce; `update` on a checkout whose `VERSION` has no image yet fails loudly (B).

## 2. Slices (Flash, literal contracts)

| Slice | Files |
|---|---|
| A set-uid extraction | `Dockerfile` (stanzas → `RUN sh docker/set-uid.sh`), `docker/set-uid.sh`, `docker/Dockerfile.uid`; `docker/test-isolation.sh` unchanged (proves the child uid still works) |
| B launcher | `fenix` (`VERSION` read, `image_ref()`, `pull_or_build()`, `--source`, the thin-layer build, `update` prints digests, the doctor image line), `compose.yaml` image line, `VERSION` |
| C docs | `docs/QUICKSTART.md` Upgrade + Start notes, `docs/ACCESS.md`, this plan's §5, `docs/state/FOC-777.md` |
| D tests | `scripts/launcher-wrappers.test.mjs` (or a new `fenix-image-ref.test.mjs`) for `image_ref()` precedence and the `--source` switch; a Linux lane step that builds `Dockerfile.uid` on top of `fenix:dev` with uid 1234 and checks `id` inside |

## 3. Verification

CI: the linux job builds `fenix:dev` (source) and the thin layer on top with a non-1000 uid; `test-isolation.sh`
passes on the thin layer. VM (FOC-789's fresh machine, after the first published tag): `./fenix up` with only
Docker → pull → dashboard; `./fenix update` → same digest, no rebuild; a second user (uid 1001) → thin layer.

## 4. Out of scope

Multi-arch (arm64) images; signing/attestation (`provenance: false` by design until FOC-790 decides); the release
notes themselves (FOC-790).

## 5. Results (2026-10-20)

- Three Flash slices in parallel on one worktree (A docker, B launcher, C docs + test), all inside their
  budgets. Flash review → CHANGES-REQUIRED, 10 findings, all applied: the helper path (`fenix keys` / `doctor` /
  `prune` through `in_container_node`) pulled or rebuilt on every call → `ensure_image --if-missing` touches
  nothing when the image is present (the old "build only when `fenix:dev` is missing" promise, kept for the
  pulled image too); a failed pull with a local copy now uses the copy instead of a cold source build; the
  thin-layer build args default the uid/gid like compose does; `set-uid.sh` validates the three ids as digits
  and remaps child-owned files under `/opt/fenix` and `/data` too; `Dockerfile.uid` copies the script itself so
  a base published before FOC-777 still works; `--source` on any other command exits 2 instead of being
  swallowed; `update` reads the "before" digest before `git pull` and labels both refs; the checklist's lane
  parenthetical follows the count (164 parallel + 40 serial). Verified non-issues the review confirmed:
  `find -user <numeric>` without a passwd entry, groupmod-before-usermod ordering, the `fenix` group's files
  surviving the remap, the child referenced by name everywhere (sudoers, helper, isolation lane), compose
  `up -d` not rebuilding because a `build:` key exists.
- Lanes `image-ref` (+4), `launcher-wrappers`, `docs-count-guard`, `config-drift` green; lint 0; `sh -n` on
  both scripts; `state-index` clean. The Docker parts (`set-uid.sh` on a fresh image and as the thin layer with
  uid 1234, the isolation lane on the layer) are proven by the Linux job — no Docker on the delivery owner's
  machine for this branch.
- Deferred: a real `fenix up` pull on a fresh host = FOC-789's run after the first `v*` tag; the
  `v1.0.0-rc.1` tag itself waits for Mateusz's word on who tags.
