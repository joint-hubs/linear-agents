#!/bin/sh
# FOC-802: the only privileged path in the image. `node` (the Supervisor's
# user) runs it via sudo; it validates the spawn against the Supervisor's own
# roots, hands the worktree / gitdir / launch dir to the child identity, and
# execs `claude` as `fenix-child` with a clean environment rebuilt from the
# watcher's env file. Runs as root for milliseconds — nothing it starts keeps
# root: the final exec is setpriv into fenix-child with no-new-privs.
#
# Exit codes: 97 = refused by the isolation helper (any validation failure,
# before anything is modified, and the env-export failure inside the child
# shell). The watcher's fail-closed check keys on 97; plain 2 is never used
# here because a legitimate claude exit 2 would be indistinguishable from a
# refusal.
#
# Usage:
#   fenix-spawn-as-child <env-file> <worktree> <config-dir> -- <argv...>
#
# The image roots are HARDCODED on purpose: sudo strips the caller's env, so
# LA_WORKTREE_HOME / LA_SUPERVISOR_STATE_HOME cannot be trusted through it
# (and the Dockerfile bakes the same values into ENV). They are exactly the
# image's ENV: LA_WORKTREE_HOME=/data/workspaces/la-wt,
# LA_SUPERVISOR_STATE_HOME=/data/state/supervisor.
set -eu

WORKTREE_ROOT=/data/workspaces/la-wt
STATE_HOME=/data/state/supervisor
CHILD_USER=fenix-child
CHILD_GROUP=fenix

refuse() {
    printf 'fenix-spawn-as-child: refused: %s\n' "$1" >&2
    exit 97
}

# True when any path COMPONENT of $1 is exactly ".." (a trailing "..." in a
# filename is fine; climbing out of the root is not). Subshell body keeps the
# IFS / globbing changes local.
has_dotdot() (
    set -f
    IFS=/
    for _c in $1; do
        [ "$_c" = ".." ] && return 0
    done
    return 1
)

# A path is only trusted when it is exactly what it says: no symlink as the
# final component (the -L check) and no symlink in an intermediate one
# (readlink -f resolves every component; if the result differs from the
# lexical argument, some component is a link). Everything root touches below
# is gated on this — a symlinked argument would otherwise point the root
# chown at whatever the link targets.
canonical() {
    if [ -L "$1" ]; then return 1; fi
    [ "$(readlink -f -- "$1")" = "$1" ]
}

[ "$#" -ge 5 ] || refuse 'usage: fenix-spawn-as-child <env-file> <worktree> <config-dir> -- <argv...>'
env_file=$1
worktree=$2
config_dir=$3
[ "$4" = "--" ] || refuse 'the 4th argument must be the -- separator'
shift 4
[ "$#" -ge 1 ] || refuse 'empty argv after --'

# ── validation (nothing is started or modified before every check passes) ────
[ "$(id -u)" = "0" ] || refuse 'must run as root (via sudo)'

# Symlink gate first, for all three paths, before any other validation: the
# decision "is this the path I was given" must not depend on later checks.
for _p in "$env_file" "$worktree" "$config_dir"; do
    canonical "$_p" || refuse "path is a symlink or not canonical: $_p"
done

[ -f "$env_file" ] || refuse "env file is not a regular file: $env_file"
[ -d "$worktree" ] || refuse "worktree is not a directory: $worktree"
[ -d "$config_dir" ] || refuse "config dir is not a directory: $config_dir"

has_dotdot "$env_file" && refuse 'env file path contains ..'
if [ "$worktree" = "$WORKTREE_ROOT" ] || [ "$worktree" = "$WORKTREE_ROOT/" ]; then
    refuse 'worktree is the root itself'
fi
case $worktree in "$WORKTREE_ROOT"/*) ;;
    *) refuse "worktree not under $WORKTREE_ROOT: $worktree" ;;
esac
has_dotdot "$worktree" && refuse 'worktree path contains ..'

# The config dir must be <stateHome>/<run>/launch/... — the launch directory of
# one run — and the env file must live under that same run's launch dir.
case $config_dir in "$STATE_HOME"/*/launch/*) ;;
    *) refuse "config dir not under $STATE_HOME/<run>/launch: $config_dir" ;;
esac
has_dotdot "$config_dir" && refuse 'config dir path contains ..'
run_rel=${config_dir#"$STATE_HOME"/}
run_id=${run_rel%%/*}
case $run_id in ''|.|..) refuse 'bad run id in config dir path' ;; esac
case $env_file in "$STATE_HOME"/"$run_id"/launch/*) ;;
    *) refuse "env file not under run $run_id's launch dir: $env_file" ;;
esac

# argv[0]: the claude binary (resolved on the child's PATH) or an absolute
# path under the app, /usr/local, or the supervisor state home (where a fake
# claude for the isolation test lives). Never anything else.
child_argv0=$1
case $child_argv0 in
    claude) ;;
    /opt/fenix/*|/usr/local/*|"$STATE_HOME"/*) has_dotdot "$child_argv0" && refuse 'argv[0] path contains ..' ;;
    *) refuse "argv[0] must be claude or under /opt/fenix, /usr/local or $STATE_HOME: $child_argv0" ;;
esac

# Env file: written by the watcher, owner node, exactly 0640. Owner uid is
# resolved live so FOC-803's remapped FENIX_UID works unchanged.
node_uid=$(id -u node)
child_uid=$(id -u "$CHILD_USER") || refuse "no $CHILD_USER user in this image"
env_owner=$(stat -c '%u' "$env_file")
env_mode=$(stat -c '%a' "$env_file")
[ "$env_owner" = "$node_uid" ] || refuse "env file not owned by node (uid $node_uid): $env_file"
[ "$env_mode" = "640" ] || refuse "env file mode is $env_mode, expected 0640: $env_file"

# H2: the worktree's gitdir is scoped to exactly this worktree's
# administrative directory in the main clone —
# /data/workspaces/<repo>/.git/worktrees/<name> with <name> equal to the
# worktree's basename and <repo> a single path component. Anything else
# (another repo's .git root, another worktree's dir, a path outside
# /data/workspaces) would let a child that already owns its worktree rewrite
# the .git file and redirect the root chown onto a whole git store. Only the
# worktrees/<name> directory is handed over; the object store stays reachable
# through the group fenix setgid permissions set by fix_permissions.
gitdir=''
if [ -f "$worktree/.git" ]; then
    if [ -L "$worktree/.git" ]; then
        refuse "the worktree's .git is a symlink: $worktree/.git"
    fi
    gitdir=$(sed -n 's/^gitdir:[[:space:]]*//p' "$worktree/.git")
    [ -n "$gitdir" ] || refuse "cannot parse gitdir from $worktree/.git"
    case $gitdir in /*) ;; *) refuse "gitdir in $worktree/.git is not absolute: $gitdir" ;; esac
    case $gitdir in /data/workspaces/*/.git/worktrees/*) ;;
        *) refuse "gitdir must be /data/workspaces/<repo>/.git/worktrees/<name>: $gitdir" ;;
    esac
    has_dotdot "$gitdir" && refuse 'gitdir path contains ..'
    _grepo=${gitdir#"/data/workspaces/"}
    _grepo=${_grepo%%/.git/worktrees/*}
    case $_grepo in ''|.|..|.*|*/*)
        refuse "gitdir repo must be a single path component: $_grepo" ;;
    esac
    _gname=${gitdir##*/.git/worktrees/}
    [ "$_gname" = "${worktree##*/}" ] || \
        refuse "gitdir worktree name ($_gname) does not match the worktree (${worktree##*/})"
    canonical "$gitdir" || refuse "gitdir is a symlink or not canonical: $gitdir"
    [ -d "$gitdir" ] || refuse "gitdir is not a directory: $gitdir"
fi

# ── re-check immediately before the handover (TOCTOU narrowing) ──────────────
# Everything above was decided by stat/readlink at validation time; a racing
# writer could have swapped in a symlink or a different owner/mode since.
# Re-verify the invariants the chown depends on — canonical paths and an
# untouched env file — right before the first chown runs.
for _p in "$env_file" "$worktree" "$config_dir"; do
    canonical "$_p" || refuse "path changed under us (symlink?): $_p"
done
[ -f "$env_file" ] || refuse "env file is no longer a regular file: $env_file"
[ "$(stat -c '%u' "$env_file")" = "$node_uid" ] || \
    refuse "env file owner changed since validation: $env_file"
[ "$(stat -c '%a' "$env_file")" = "640" ] || \
    refuse "env file mode changed since validation: $env_file"
if [ -n "$gitdir" ]; then
    canonical "$gitdir" || refuse "gitdir changed under us (symlink?): $gitdir"
fi

# ── handover: the child identity owns what it must write ─────────────────────
# The worktree, its gitdir (only the worktrees/<name> directory — see H2
# above), and the launch config dir. Group fenix + setgid dirs + g+rw keep
# the Supervisor (node, member of fenix) able to write. All three are roots
# validated above — never anything wider.
handover() {
    # --no-dereference: even with everything canonical above, root must never
    # follow a link that raced in after the re-check — a raced-in symlink is
    # chowned as the link itself, never as its target. find does not follow
    # links, so the chmod passes never descend through one either.
    chown -R --no-dereference "$CHILD_USER:$CHILD_GROUP" "$1"
    find "$1" -type d -exec chmod g+rwxs {} +
    find "$1" -type f -exec chmod g+rw {} +
}
handover "$worktree"
[ -z "$gitdir" ] || handover "$gitdir"
handover "$config_dir"
chown --no-dereference "$CHILD_USER:$CHILD_GROUP" "$env_file"
chmod 0640 "$env_file"

# Private scratch dir for the child (Claude Code temp files).
child_tmp="/tmp/fenix-child-$child_uid"
mkdir -p "$child_tmp"
chown "$CHILD_USER:$CHILD_GROUP" "$child_tmp"
chmod 0700 "$child_tmp"

# ── exec: drop to the child identity with a clean env ────────────────────────
# The env file is KEY=VALUE lines written by the watcher (values may contain
# spaces, never newlines — the file format is line-delimited). It is applied
# INSIDE the child identity by an env -i sh that reads it line by line and
# exports each line as one argument — no eval, no word splitting on values.
# It is removed as soon as it has been sourced: it holds provider keys, the
# launch dir is owned by fenix-child by then, so the unlink succeeds (the
# watcher keeps its own cleanup as belt and braces). HOME/TMPDIR/umask are
# forced last so the env file cannot override them. Any env failure exits 97
# — the watcher's fail-closed signal, unambiguous against claude's own 2.
exec setpriv --reuid="$CHILD_USER" --regid="$CHILD_GROUP" --init-groups \
    --inh-caps=-all --no-new-privs \
    /usr/bin/env -i /bin/sh -c '
        umask 0002
        while IFS= read -r envline || [ -n "$envline" ]; do
            case $envline in ""|"#"*) continue ;; esac
            case $envline in -*) exit 97 ;; esac
            export "$envline" || exit 97
        done < "$1"
        rm -f -- "$1"
        shift
        child_tmp_dir=$1
        shift
        : "${PATH:=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
        export PATH
        HOME=/home/fenix-child TMPDIR="$child_tmp_dir" exec "$@"
    ' sh "$env_file" "$child_tmp" "$@"