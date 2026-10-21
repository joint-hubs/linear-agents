#!/bin/sh
# FOC-980: child-side share of the child's transcript files (runs as the
# child user — the owner may chmod its own files; never root).
#
# In the container (FOC-802 isolation) a child's Claude Code writes its
# transcript <config-dir>/projects/<slug>/<session>.jsonl as fenix-child with
# mode 0600. The Supervisor (node, group fenix) cannot read those, so turn-end
# cost pricing and supervisor-followup history copy both come up empty when
# the file was created after the launch handover. This helper runs as the
# child user (via `sudo -u fenix-child`, sudoers-fenix-child) and grants group
# read on the transcript files — nothing more: g+r only, never g+w, the child
# keeps its own writes. Running as the child user is deliberate: the files are
# fenix-child-owned, and the owner may chmod its own files — so even a symlink
# raced in during the traversal can only touch files the child could chmod
# anyway; root rights would buy nothing but a wider blast radius.
#
# Usage:
#   fenix-child-share.sh <launch-dir>
#
#   <launch-dir>  the child's launch config dir (…/launch/<childId>/turn-N)
#                 or the child dir itself (…/launch/<childId>)
# Exit codes: 0 = ran (count of files changed on stdout); 2 = bad arguments.
#
# The image root is HARDCODED on purpose: sudo strips the caller's env, so the
# same STATE_HOME as fenix-spawn-as-child is baked in here.
set -eu

STATE_HOME=/data/state/supervisor
# FOC-980: the runas identity, the same CHILD_USER fenix-spawn-as-child spawns
# with. The sudoers entry keys on this name (node -> sudo -u fenix-child).
SHARE_RUNAS=fenix-child

refuse() {
    printf 'fenix-child-share: refused: %s\n' "$1" >&2
    exit 2
}

usage() {
    printf 'fenix-child-share: usage: %s <launch-dir>\n' "$0" >&2
    exit 2
}

[ "$#" -eq 1 ] || usage
dir=$1

# The child identity IS the security model: the transcripts are fenix-child
# files and the owner may chmod its own files, so a raced-in symlink can only
# ever point the chmod at something the child could chmod anyway. A root run
# would resurrect the arbitrary-file chmod the loop below is designed against,
# so it is refused outright (root calling sudo -u is the production path).
[ "$(id -un)" = "$SHARE_RUNAS" ] || refuse "this helper runs as $SHARE_RUNAS, not as $(id -un)"

# A path is only trusted when it is exactly what it says: no symlink anywhere
# in the path (realpath resolves every component; if the result differs from
# the lexical argument, some component is a link or the target does not exist)
# and no ".." as a path component. find below does not follow links (-P), so a
# raced-in symlink inside the dir is chmod'ed as the link itself, never as its
# target — but the argument itself must be canonical before anything runs.
[ "$(realpath -e -- "$dir")" = "$dir" ] || refuse "path is a symlink or not canonical: $dir"

has_dotdot() (
    set -f
    IFS=/
    for _c in $1; do
        [ "$_c" = ".." ] && return 0
    done
    return 1
)
has_dotdot "$dir" && refuse 'path contains ..'

[ -d "$dir" ] || refuse "not a directory: $dir"

# Only the launch dirs of a run: <STATE_HOME>/<run>/launch/<childId> and its
# per-turn <...>/launch/<childId>/turn-N. Anything else is refused.
run_re="^$STATE_HOME/[A-Za-z0-9._-]+/launch/[A-Za-z0-9._-]+(/turn-[0-9]+)?\$"
if ! printf '%s' "$dir" | grep -Eq "$run_re"; then
    refuse "dir not under $STATE_HOME/<run>/launch/<childId>[/turn-N]: $dir"
fi

# Grant group read on transcript files that lack it. -type f excludes
# symlinks (find -P never follows links anyway), so only real files change.
# chmod g+r on an already group-readable file is a no-op, but the ! -perm
# filter keeps the count honest and the chmod list short.
#
# No shell word-splitting: the filenames are the child's, so they reach chmod
# only as find's own arguments (a name with a newline or a `*` is data, never
# a second path or a glob — the old `for f in $(find …)` would have made this
# helper chmod arbitrary files for root). If a file vanishes between find's
# traversal and the chmod, the whole batch exits non-zero and prints nothing —
# the count errs toward zero, never inflates. Best effort by design.
changed=$(find -P "$dir" -type f -name '*.jsonl' ! -perm -g+r -exec chmod g+r -- {} + -print | wc -l)

printf '%s\n' "$changed"
exit 0
