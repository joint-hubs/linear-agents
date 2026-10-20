#!/bin/sh
# FOC-803 / FOC-802 / FOC-777: give the image the host user's uid/gid and an
# unprivileged child identity. ONE script for two callers: the main Dockerfile
# (fresh image, node is still 1000:1000, no files of interest yet) and
# docker/Dockerfile.uid (a thin layer on top of the published image, where
# node, fenix-child, group fenix and their files already exist and must be
# REMAPPED, not recreated). Inputs: FENIX_UID, FENIX_GID (default 1000),
# FENIX_CHILD_UID (default FENIX_UID + 1000). Never root for either identity.
set -eu

digits() {
  case "${2:-}" in
    ''|*[!0-9]*) echo "$1=${2:-} refused — must be a positive integer" >&2; exit 1 ;;
  esac
}
digits FENIX_UID "${FENIX_UID:-1000}"
digits FENIX_GID "${FENIX_GID:-1000}"
if [ -n "${FENIX_CHILD_UID:-}" ]; then digits FENIX_CHILD_UID "$FENIX_CHILD_UID"; fi

want_uid="${FENIX_UID:-1000}"
want_gid="${FENIX_GID:-1000}"
if [ "$want_uid" = "0" ] || [ "$want_gid" = "0" ]; then
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

child_uid="${FENIX_CHILD_UID:-$((want_uid + 1000))}"
if [ "$child_uid" = "0" ] || [ "$child_uid" = "$want_uid" ]; then
  echo "FENIX_CHILD_UID=$child_uid refused — the child uid must differ from node's and never be root" >&2
  exit 1
fi
if ! getent group fenix >/dev/null; then
  if getent group "$want_gid" >/dev/null; then
    groupadd fenix
  else
    groupadd -g "$want_gid" fenix
  fi
fi
if getent passwd fenix-child >/dev/null; then
  # The thin layer: the child exists from the base image — remap its uid.
  have="$(id -u fenix-child)"
  if [ "$have" != "$child_uid" ]; then
    if getent passwd "$child_uid" >/dev/null; then
      echo "FENIX_CHILD_UID=$child_uid is already taken by $(getent passwd "$child_uid" | cut -d: -f1)" >&2
      exit 1
    fi
    usermod -o -u "$child_uid" fenix-child
    # Nothing outside the child's home is child-owned at build time today; the
    # loop keeps that true if a later image changes it.
    for d in /home/fenix-child /opt/fenix /data; do
      [ -e "$d" ] || continue
      find "$d" -xdev -user "$have" -exec chown -h "$child_uid" {} + 2>/dev/null || true
    done
  fi
else
  if getent passwd "$child_uid" >/dev/null; then
    echo "FENIX_CHILD_UID=$child_uid is already taken by $(getent passwd "$child_uid" | cut -d: -f1)" >&2
    exit 1
  fi
  useradd -u "$child_uid" -g fenix -d /home/fenix-child -m -s /usr/sbin/nologin fenix-child
  chmod 0700 /home/fenix-child
  printf '[safe]\n\tdirectory = *\n' > /home/fenix-child/.gitconfig
  chown fenix-child:fenix /home/fenix-child/.gitconfig
fi
usermod -aG fenix node
