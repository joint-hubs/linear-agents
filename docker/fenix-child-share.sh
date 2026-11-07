#!/bin/sh
# FOC-980: child-side share of the child's transcript files (runs as the
# child user — the owner may chmod its own files; never root).
#
# In the container (FOC-802 isolation) a child's Claude Code writes its
# transcript <config-dir>/projects/<slug>/<session>.jsonl as its run's pool
# user (fenix-child-<n>, FOC-878) with mode 0600. The Supervisor (node, member
# of every fenix-run-<n>) cannot read those, so turn-end cost pricing and
# supervisor-followup history copy both come up empty when the file was created
# after the launch handover. This helper runs as that same pool user (via
# `sudo -u fenix-child-<n>` — sudoers-fenix-child names the %fenix-children
# umbrella so one entry covers the whole pool) and grants group read on the
# transcript files — nothing more: g+r only, never g+w, the child keeps its own
# writes. Running as the child's own user is deliberate: the files are
# child-owned, and the owner may chmod its own files — so even a symlink raced
# in during the traversal can only touch files the child could chmod anyway;
# root rights would buy nothing but a wider blast radius.
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
# FOC-980 / FOC-878: the runas identity is the run's own pool user,
# fenix-child-<n> — resolved per run from the run's identity.json by the lib
# (supervisor-lib.mjs), never assumed here. The check below accepts any pool
# user and refuses everything else, root first of all; which pool user a run
# belongs to is the lib's call.

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

# The child identity IS the security model: the transcripts are child files
# and the owner may chmod its own files, so a raced-in symlink can only
# ever point the chmod at something the child could chmod anyway. A root run
# would resurrect the arbitrary-file chmod the loop below is designed against,
# so it is refused outright (root calling sudo -u is the production path);
# so is any non-pool user.
case $(id -un) in
    fenix-child-*) ;;
    *) refuse "this helper runs as the run's fenix-child-<n> pool user, not as $(id -un)" ;;
esac

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
# helper chmod arbitrary files for root). The count is one dot per file
# selected for the chmod: with `-exec … {} +` the -exec primary is always
# true, so this is best effort, not proof each chmod succeeded — and
# -printf '.' keeps a newline inside a filename from inflating the count.
changed=$(find -P "$dir" -type f -name '*.jsonl' ! -perm -g+r -exec chmod g+r -- {} + -printf '.' | wc -c)

printf '%s\n' "$changed"
exit 0
