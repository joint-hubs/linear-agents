#!/bin/sh
# FOC-803 / FOC-802 / FOC-777 / FOC-878: give the image the host user's uid/gid
# and a POOL of unprivileged child identities. ONE script for two callers: the
# main Dockerfile (fresh image, node is still 1000:1000, no files of interest
# yet) and docker/Dockerfile.uid (a thin layer on top of the published image,
# where node, the pool users/groups and their files already exist and must be
# REMAPPED, not recreated). Inputs: FENIX_UID, FENIX_GID (default 1000),
# FENIX_CHILD_UID (default FENIX_UID + 1000), FENIX_CHILD_GID (default
# FENIX_GID + 1000), FENIX_CHILD_POOL (default 16). Never root for any identity.
#
# FOC-878: the pool replaces the single child user. Slot n is user
# fenix-child-<n> with uid FENIX_CHILD_UID + n (slot 0 keeps today's child
# numbers — a pre-pool volume's child-owned files keep their owner), primary
# group fenix-run-<n> with gid FENIX_CHILD_GID + n, supplementary groups fenix
# (read-only access to the shared /data trees stays as it is) and fenix-children
# (the sudoers runas umbrella for fenix-child-share). `node` (the Supervisor) is
# a member of every fenix-run-<n>, so its writes — the cleanup archive,
# `git worktree remove`, the watcher's tee — keep working through the group
# exactly as they did through `fenix`. The thin layer remaps the whole pool by
# number, exactly as it remapped the one user before.
set -eu

digits() {
  case "${2:-}" in
    ''|*[!0-9]*) echo "$1=${2:-} refused — must be a positive integer" >&2; exit 1 ;;
  esac
}
digits FENIX_UID "${FENIX_UID:-1000}"
digits FENIX_GID "${FENIX_GID:-1000}"
if [ -n "${FENIX_CHILD_UID:-}" ]; then digits FENIX_CHILD_UID "$FENIX_CHILD_UID"; fi
if [ -n "${FENIX_CHILD_GID:-}" ]; then digits FENIX_CHILD_GID "$FENIX_CHILD_GID"; fi
if [ -n "${FENIX_CHILD_POOL:-}" ]; then digits FENIX_CHILD_POOL "$FENIX_CHILD_POOL"; fi

want_uid="${FENIX_UID:-1000}"
want_gid="${FENIX_GID:-1000}"
pool="${FENIX_CHILD_POOL:-16}"
if [ "$want_uid" = "0" ] || [ "$want_gid" = "0" ] || [ "$pool" = "0" ]; then
  echo "FENIX_UID/FENIX_GID=0 refused — Fenix never runs as root; run ./fenix as your normal user" >&2
  exit 1
fi

old_uid="$(id -u node)"
old_gid="$(id -g node)"
if [ "$want_uid:$want_gid" != "$old_uid:$old_gid" ]; then
  if [ "$want_gid" != "$old_gid" ]; then
    groupmod -o -g "$want_gid" node
  fi
  if [ "$want_uid" != "$old_uid" ]; then
    usermod -o -u "$want_uid" -g "$want_gid" node
  fi
  # usermod remaps the home directory only; everything else node owned under
  # the old numbers follows by number, so the fenix group's files (the shared
  # /data trees, the FOC-808 cache dirs) keep their group.
  for d in /home/node /opt/fenix /data; do
    [ -e "$d" ] || continue
    find "$d" -xdev -user "$old_uid" -exec chown -h "$want_uid" {} + 2>/dev/null || true
    find "$d" -xdev -group "$old_gid" -exec chgrp -h "$want_gid" {} + 2>/dev/null || true
  done
fi

child_uid_base="${FENIX_CHILD_UID:-$((want_uid + 1000))}"
child_gid_base="${FENIX_CHILD_GID:-$((want_gid + 1000))}"

if ! getent group fenix >/dev/null; then
  if getent group "$want_gid" >/dev/null; then
    groupadd fenix
  else
    groupadd -g "$want_gid" fenix
  fi
fi
# FOC-878: the umbrella group every pool user belongs to — the sudoers runas
# for fenix-child-share names it (%fenix-children), so adding a slot to the
# pool is all it takes to widen the runas.
if ! getent group fenix-children >/dev/null; then
  groupadd fenix-children
fi

n=0
while [ "$n" -lt "$pool" ]; do
  slot_uid=$((child_uid_base + n))
  slot_gid=$((child_gid_base + n))
  user="fenix-child-$n"
  group="fenix-run-$n"
  home="/home/fenix-child-$n"
  if [ "$slot_uid" = "0" ] || [ "$slot_uid" = "$want_uid" ] || [ "$slot_gid" = "0" ]; then
    echo "FENIX_CHILD_UID/GID=$slot_uid/$slot_gid refused — a pool identity must never be root or node's uid (slot $n)" >&2
    exit 1
  fi

  # The group: create fresh, or remap the gid on the thin layer exactly as the
  # single child group's files followed by number before.
  if getent group "$group" >/dev/null; then
    have_gid="$(getent group "$group" | cut -d: -f3)"
    if [ "$have_gid" != "$slot_gid" ]; then
      if getent group "$slot_gid" >/dev/null; then
        echo "FENIX_CHILD_GID+$n=$slot_gid is already taken by $(getent group "$slot_gid" | cut -d: -f1)" >&2
        exit 1
      fi
      groupmod -o -g "$slot_gid" "$group"
      # A run's chowned trees on a persistent volume keep their group by
      # number (the identity.json slot naming survives the remap).
      for d in "$home" /opt/fenix /data; do
        [ -e "$d" ] || continue
        find "$d" -xdev -group "$have_gid" -exec chgrp -h "$slot_gid" {} + 2>/dev/null || true
      done
    fi
  else
    if getent group "$slot_gid" >/dev/null; then
      echo "FENIX_CHILD_GID+$n=$slot_gid is already taken by $(getent group "$slot_gid" | cut -d: -f1)" >&2
      exit 1
    fi
    groupadd -g "$slot_gid" "$group"
  fi

  # The user: create fresh with today's per-child shape (0700 home, the same
  # safe.directory .gitconfig), or remap the uid on the thin layer.
  if getent passwd "$user" >/dev/null; then
    have_uid="$(id -u "$user")"
    if [ "$have_uid" != "$slot_uid" ]; then
      if getent passwd "$slot_uid" >/dev/null; then
        echo "FENIX_CHILD_UID+$n=$slot_uid is already taken by $(getent passwd "$slot_uid" | cut -d: -f1)" >&2
        exit 1
      fi
      usermod -o -u "$slot_uid" "$user"
      # Nothing outside the child's home is child-owned at build time today;
      # the loop keeps that true if a later image changes it.
      for d in "$home" /opt/fenix /data; do
        [ -e "$d" ] || continue
        find "$d" -xdev -user "$have_uid" -exec chown -h "$slot_uid" {} + 2>/dev/null || true
      done
    fi
  else
    if getent passwd "$slot_uid" >/dev/null; then
      echo "FENIX_CHILD_UID+$n=$slot_uid is already taken by $(getent passwd "$slot_uid" | cut -d: -f1)" >&2
      exit 1
    fi
    useradd -u "$slot_uid" -g "$group" -G fenix,fenix-children -d "$home" -m -s /usr/sbin/nologin "$user"
    chmod 0700 "$home"
    printf '[safe]\n\tdirectory = *\n' > "$home/.gitconfig"
    chown "$user:fenix" "$home/.gitconfig"
  fi
  n=$((n + 1))
done

# FOC-878: node joins the shared group exactly as before AND every run group —
# the pool groups exist from container start, so the Supervisor's long-lived
# session can write through them (a group created at run time would be
# invisible to it; that is why the pool is baked into the image).
node_groups="fenix"
n=0
while [ "$n" -lt "$pool" ]; do
  node_groups="$node_groups,fenix-run-$n"
  n=$((n + 1))
done
usermod -aG "$node_groups" node