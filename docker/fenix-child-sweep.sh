#!/bin/sh
# FOC-808 slice B: root-side sweep of stray child processes.
#
# In the container the watcher runs as `node` while the child tree runs as
# `fenix-child` (fenix-spawn-as-child does setpriv --reuid), so /proc/<pid>/
# environ of the strays is EACCES to node and its in-process /proc scan finds
# nothing. This helper runs as root (via sudo, sudoers-fenix-child) and does
# the same scan with real permissions. It validates its inputs itself and
# signals ONLY processes whose environment carries the exact mark.
#
# Usage:
#   fenix-child-sweep.sh <mark> <signal> [exclude-pid...]
#
#   <mark>    LA_CHILD_MARK value, ^[A-Za-z0-9][A-Za-z0-9:_./-]{0,200}$
#   <signal>  TERM or KILL
# Exit codes: 0 = scan ran; 2 = bad arguments. Anything a pid does between
# listing and signalling (vanishing, ESRCH) is not an error — the sweep
# wanted it dead either way.
#
# One line per match is printed to stdout BEFORE any signal, as `pid comm`:
#   4242 postgres
# The caller (supervisor-lib.mjs) parses these lines to know whom it listed,
# waits the grace period, and re-runs with KILL for survivors.
#
# VM probe (integrator, on the VM): create a stray AS fenix-child, then sweep
# it. The full spawn path needs an env file + worktree; a bare setpriv line
# is enough for the probe:
#   docker compose exec -T -u root fenix-supervisor setpriv --reuid=fenix-child \
#     --regid=fenix --init-groups --no-new-privs \
#     env LA_CHILD_MARK=foc808-probe sh -c 'sleep 300' &
#   docker compose exec -T fenix-supervisor sudo -n /usr/local/sbin/fenix-child-sweep \
#     foc808-probe TERM
# (the full spawn path, when needed:
#   docker compose exec -T fenix-supervisor sudo -n /usr/local/sbin/fenix-spawn-as-child
#   <env-file> <worktree> <config-dir> -- claude ... )
set -eu

usage() {
    printf 'fenix-child-sweep: usage: %s <mark> <signal> [exclude-pid...]\n' "$0" >&2
    exit 2
}

[ "$#" -ge 2 ] || usage
mark=$1
signal=$2
shift 2

# mark: alnum first char, then only [A-Za-z0-9:_./-], max 201 chars total.
case $mark in
    [A-Za-z0-9]*) ;;
    *) usage ;;
esac
case $mark in
    *[!A-Za-z0-9:_./-]*) usage ;;
esac
[ "${#mark}" -le 201 ] || usage

case $signal in
    TERM|KILL) ;;
    *) usage ;;
esac

for _p in "$@"; do
    case $_p in
        *[!0-9]*) usage ;;
    esac
done

me=$$
parent=${PPID:-0}

found=0
listed=
for d in /proc/[0-9]*; do
    [ -d "$d" ] || continue
    pid=${d#/proc/}
    [ "$pid" != "1" ] || continue
    [ "$pid" != "$me" ] || continue
    [ "$pid" != "$parent" ] || continue
    skip=0
    for _p in "$@"; do
        [ "$pid" != "$_p" ] || { skip=1; break; }
    done
    [ "$skip" = "0" ] || continue
    [ -r "$d/environ" ] || continue
    # Exact NUL-delimited match: tr splits the entries, -F keeps the mark
    # literal (it may contain glob-significant characters), -x requires the
    # whole line to be LA_CHILD_MARK=<mark>.
    if tr '\0' '\n' < "$d/environ" | grep -Fqx -- "LA_CHILD_MARK=$mark"; then
        comm=$(cat "$d/comm" 2>/dev/null || printf '')
        printf '%s %s\n' "$pid" "$comm"
        listed="$listed $pid"
        found=1
    fi
done

[ "$found" = "1" ] || exit 0

# Signals ONLY what was listed above — never anything else. A pid that died
# between the listing and this kill gives kill a non-zero status; that must
# not abort the sweep over the remaining pids.
for pid in $listed; do
    # Re-check the mark right before the signal: a pid that died after the
    # listing and was reused by an unrelated process must not be signalled.
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -Fqx -- "LA_CHILD_MARK=$mark" || continue
    kill -"$signal" "$pid" 2>/dev/null || true
done
exit 0
