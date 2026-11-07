#!/bin/sh
# FOC-802: the only privileged path in the image. `node` (the Supervisor's
# user) runs it via sudo; it validates the spawn against the Supervisor's own
# roots, hands the worktree / gitdir / launch dir to the child identity, and
# execs `claude` as that child with a clean environment rebuilt from the
# watcher's env file. Runs as root for milliseconds — nothing it starts keeps
# root: the final exec is setpriv into the child with no-new-privs.
#
# FOC-878: the child identity is PER RUN. The image bakes a static pool
# (fenix-child-<n>, primary group fenix-run-<n>, supplementary fenix + the
# %fenix-children umbrella — fenix-set-uid). On a run's first spawn this
# helper claims the lowest free slot for the run, records it in
# <stateHome>/<run>/identity.json (root-owned 0644: only this helper may write
# it) and hands the run's shared surface to the run group; every later spawn
# of the same run re-reads the file and refuses on any mismatch. A child of
# run A is then neither owner nor member of anything run B owns — and node, a
# member of every fenix-run-<n>, keeps every write it has today.
#
# Exit codes: 97 = refused by the isolation helper (any validation failure,
# before anything is modified, and the env-export failure inside the child
# shell; an identity claimed in the same invocation is rolled back on every
# refusal, so a refusal leaves nothing behind). The watcher's fail-closed
# check keys on 97; plain 2 is never used here because a legitimate claude
# exit 2 would be indistinguishable from a refusal.
#
# Usage:
#   fenix-spawn-as-child <env-file> <worktree> <config-dir> -- <argv...>
#
# The image roots are HARDCODED on purpose: sudo strips the caller's env, so
# LA_WORKTREE_HOME / LA_SUPERVISOR_STATE_HOME cannot be trusted through it
# (and the Dockerfile bakes the same values into ENV). They are exactly the
# image's ENV: LA_WORKTREE_HOME=/data/workspaces/la-wt,
# LA_SUPERVISOR_STATE_HOME=/data/state/supervisor. FENIX_CHILD_POOL is the one
# deliberate exception: the sudoers env_keep passes it through (the image pins
# it in ENV), and every slot it names is re-validated against /etc/passwd
# below — a spoofed larger pool buys nothing.
set -eu

WORKTREE_ROOT=/data/workspaces/la-wt
STATE_HOME=/data/state/supervisor
POOL_DEFAULT=16

# FOC-878: the identity claimed in THIS invocation. Every refusal after the
# claim rolls it back (the identity file is the only thing the helper wrote;
# the shared-surface chowns are idempotent and re-applied by the next spawn).
identity_file=''
identity_fresh=0

refuse() {
    if [ "$identity_fresh" = 1 ] && [ -n "$identity_file" ]; then
        rm -f -- "$identity_file"
    fi
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
# resolved live so FOC-803's remapped FENIX_UID works unchanged. (The helper
# tightens the mode to 0600 after handing it to the run's child — the child is
# then the owner, and another run's child shares neither owner nor group.)
node_uid=$(id -u node)
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

# ── re-check immediately before the first modification (TOCTOU narrowing) ────
# Everything above was decided by stat/readlink at validation time; a racing
# writer could have swapped in a symlink or a different owner/mode since.
# Re-verify the invariants the handover depends on — canonical paths and an
# untouched env file — right before the identity claim below: every refusal
# so far has modified nothing, and it stays that way.
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

# ── FOC-878: claim the run's identity — one pool slot per run ────────────────
# The run dir is <STATE_HOME>/<run_id> (proven a real directory by the config
# dir's canonical check above: <run> is one of its path components). Its
# identity.json names the slot this helper assigned on the run's first spawn;
# the file is root-owned 0644, so only this path ever writes it.
pool="${FENIX_CHILD_POOL:-$POOL_DEFAULT}"
case $pool in ''|*[!0-9]*) refuse "FENIX_CHILD_POOL is not a positive integer: '$pool'" ;; esac
run_dir="$STATE_HOME/$run_id"
identity_file="$run_dir/identity.json"

# Live uids under /proc: a slot whose uid has ANY live process is taken,
# whatever the identity files say — a stray of a run whose dir was removed
# still owns its slot until it dies or is swept.
live_uids=' '
for _proc in /proc/[0-9]*; do
    [ -d "$_proc" ] || continue
    live_uids="$live_uids$(stat -c '%u' "$_proc" 2>/dev/null || printf ' none ') "
done

# Slots named by OTHER runs' identity.json (the file is one line written by
# this helper: {"slot":n,"user":"fenix-child-n","group":"fenix-run-n",…}).
# A run's identity lasts as long as its run dir — the /proc check alone would
# let two alternating runs claim the same slot between turns (a run between
# turns has no live child), which is exactly the boundary FOC-878 holds. An
# unparseable foreign file names nothing we can attribute; it is skipped with
# a warning rather than allowed to brick every spawn.
other_slots=' '
for _ident in "$STATE_HOME"/*/identity.json; do
    [ -f "$_ident" ] || continue
    _irun=${_ident#"$STATE_HOME"/}
    _irun=${_irun%%/*}
    [ "$_irun" != "$run_id" ] || continue
    _islot=$(sed -n 's/.*"slot":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$_ident" 2>/dev/null)
    case $_islot in
        ''|*[!0-9]*)
            printf 'fenix-spawn-as-child: unreadable identity file, ignored: %s\n' "$_ident" >&2 ;;
        *) other_slots="$other_slots$_islot " ;;
    esac
done

# slot_taken <slot> <uid>: a live process under the slot uid, or another run's
# identity.json naming it.
slot_taken() {
    case " $other_slots " in *" $1 "*) return 0 ;; esac
    case "$live_uids" in *" $2 "*) return 0 ;; esac
    return 1
}

if [ -L "$identity_file" ]; then
    refuse "identity.json is a symlink: $identity_file"
fi
if [ -f "$identity_file" ]; then
    # A later spawn of this run: the identity is on record. It must be exactly
    # its own slot's derivation — the user and group the file names have to be
    # the ones THIS image gives slot n (a thin-layer remap keeps the names, so
    # a legitimate remap never trips this; a hand-edited or corrupt file does).
    ident_slot=$(sed -n 's/.*"slot":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$identity_file")
    ident_user=$(sed -n 's/.*"user":[[:space:]]*"\([^"]*\)".*/\1/p' "$identity_file")
    ident_group=$(sed -n 's/.*"group":[[:space:]]*"\([^"]*\)".*/\1/p' "$identity_file")
    case $ident_slot in ''|*[!0-9]*) refuse "identity.json has no readable slot: $identity_file" ;; esac
    [ "$ident_user" = "fenix-child-$ident_slot" ] || \
        refuse "identity.json user ($ident_user) does not match its slot ($ident_slot): $identity_file"
    [ "$ident_group" = "fenix-run-$ident_slot" ] || \
        refuse "identity.json group ($ident_group) does not match its slot ($ident_slot): $identity_file"
    [ "$ident_slot" -lt "$pool" ] || \
        refuse "identity.json names slot $ident_slot, outside this image's pool of $pool: $identity_file"
    id -u "$ident_user" >/dev/null 2>&1 || \
        refuse "identity.json names $ident_user, which does not exist in this image: $identity_file"
    slot=$ident_slot
else
    # The run's first spawn: claim the lowest free slot. The pool users come
    # from the image (fenix-set-uid); a slot number without a user is skipped,
    # so a FENIX_CHILD_POOL larger than the image's userdb only shrinks the
    # pool. Exhaustion is loud — the Supervisor surfaces it as a hold, never a
    # silent fallback to a shared identity — and refuses before writing
    # anything.
    slot=''
    _n=0
    while [ "$_n" -lt "$pool" ]; do
        _suid=$(id -u "fenix-child-$_n" 2>/dev/null || printf 'none')
        if [ "$_suid" != "none" ] && ! slot_taken "$_n" "$_suid"; then
            slot=$_n
            break
        fi
        _n=$((_n + 1))
    done
    [ -n "$slot" ] || \
        refuse "identity-pool-exhausted: all $pool child identity slots are in use (FENIX_CHILD_POOL)"
    assigned_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    identity_tmp="$run_dir/identity.json.new.$$"
    printf '{"slot":%s,"user":"fenix-child-%s","group":"fenix-run-%s","assignedAt":"%s"}\n' \
        "$slot" "$slot" "$slot" "$assigned_at" > "$identity_tmp" 2>/dev/null || \
        refuse "cannot write identity file: $identity_file"
    chmod 0644 "$identity_tmp"
    mv -f "$identity_tmp" "$identity_file"
    identity_fresh=1
    # Cross-run race: two spawns may have chosen the same free slot in the
    # same milliseconds (the checks above say "free", not "staying free").
    # Re-scan the other runs' identity files — if one of them names our slot
    # now, back off entirely (refuse rolls our claim back) and let the next
    # spawn retry with the slot visible as taken.
    for _ident in "$STATE_HOME"/*/identity.json; do
        [ -f "$_ident" ] || continue
        _irun=${_ident#"$STATE_HOME"/}
        _irun=${_irun%%/*}
        [ "$_irun" != "$run_id" ] || continue
        _islot=$(sed -n 's/.*"slot":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$_ident" 2>/dev/null)
        if [ "$_islot" = "$slot" ]; then
            refuse "identity slot $slot was claimed concurrently by run $_irun — retry the spawn"
        fi
    done
fi

CHILD_USER="fenix-child-$slot"
CHILD_GROUP="fenix-run-$slot"
child_uid=$(id -u "$CHILD_USER") || refuse "no $CHILD_USER user in this image (slot $slot)"
# getent, not `id -g`: the group's gid by NAME — `id -g` resolves a user.
child_gid=$(getent group "$CHILD_GROUP" | cut -d: -f3)
[ -n "$child_gid" ] || refuse "no $CHILD_GROUP group in this image (slot $slot)"

# The run's shared surface gets the run group: the four shared subdirs
# (node:fenix-run-<n>, 02770 — the run's children and node are the group's
# only members) and edits.jsonl (node:fenix-run-<n>, 0660, created if
# missing). Files created before this run met the pool keep their old group:
# nothing migrates in place — the run's own child (supplementary fenix) keeps
# its legacy access, other runs' children keep today's, accepted until the
# run ends. Every check the apply depends on runs first, in full, so the
# changes below are the last thing to happen, never a partial surface.
for shared_sub in children gates verdicts launch; do
    _sub="$run_dir/$shared_sub"
    [ -e "$_sub" ] || continue
    [ -L "$_sub" ] && refuse "run subdir is a symlink: $_sub"
    [ -d "$_sub" ] || refuse "run subdir is not a directory: $_sub"
done
if [ -e "$run_dir/edits.jsonl" ]; then
    [ -L "$run_dir/edits.jsonl" ] && refuse "edits.jsonl is a symlink: $run_dir/edits.jsonl"
    [ -f "$run_dir/edits.jsonl" ] || refuse "edits.jsonl is not a regular file: $run_dir/edits.jsonl"
fi
for shared_sub in children gates verdicts launch; do
    _sub="$run_dir/$shared_sub"
    [ -d "$_sub" ] || continue
    chown node:"$CHILD_GROUP" "$_sub"
    chmod 02770 "$_sub"
done
if [ -e "$run_dir/edits.jsonl" ]; then
    chown node:"$CHILD_GROUP" "$run_dir/edits.jsonl"
    chmod 0660 "$run_dir/edits.jsonl"
else
    ( set -C; : > "$run_dir/edits.jsonl" ) 2>/dev/null || \
        refuse "cannot create $run_dir/edits.jsonl"
    chown node:"$CHILD_GROUP" "$run_dir/edits.jsonl"
    chmod 0660 "$run_dir/edits.jsonl"
fi

# ── re-check the identity right before the handover (TOCTOU narrowing) ──────
# identity.json sits in a node-owned dir: it could have been replaced since it
# was validated and applied. The handover must not proceed on an identity
# that is no longer the one applied above; a fresh claim rolls back (refuse
# removes it), so the next spawn reclaims cleanly. The userdb checks re-pin
# uid/gid in case anything remapped the pool mid-flight.
[ -f "$identity_file" ] || refuse "identity file vanished under us: $identity_file"
_re_slot=$(sed -n 's/.*"slot":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$identity_file" 2>/dev/null)
[ "$_re_slot" = "$slot" ] || \
    refuse "identity file changed under us (slot now $_re_slot): $identity_file"
[ "$(id -u "$CHILD_USER" 2>/dev/null || printf 'none')" = "$child_uid" ] || \
    refuse "the pool user $CHILD_USER changed under us (expected uid $child_uid)"
[ "$(getent group "$CHILD_GROUP" | cut -d: -f3)" = "$child_gid" ] || \
    refuse "the pool group $CHILD_GROUP changed under us (expected gid $child_gid)"

# ── handover: the child identity owns what it must write ─────────────────────
# The worktree, its gitdir (only the worktrees/<name> directory — see H2
# above), and the launch config dir. Group fenix-run-<n> + setgid dirs + g+rw
# keep the Supervisor (node, member of every fenix-run-<n>) able to write;
# fenix-child-<m> of another run is neither owner nor member — no access.
# All three are roots validated above — never anything wider.
handover() {
    # --no-dereference: even with everything canonical above, root must never
    # follow a link that raced in after the re-check — a raced-in symlink is
    # chowned as the link itself, never as its target. find does not follow
    # links, so the chmod passes never descend through one either. FOC-878:
    # dirs land at exactly 2770, files at exactly 0660 — the additive g+rwX
    # alone kept the old other-rx (2775/0664), and other-run children must not
    # even traverse this run's trees.
    chown -R --no-dereference "$CHILD_USER:$CHILD_GROUP" "$1"
    find "$1" -type d -exec chmod g+rwxs,o-rwx {} +
    find "$1" -type f -exec chmod g+rw,o-rwx {} +
}
handover "$worktree"
[ -z "$gitdir" ] || handover "$gitdir"
handover "$config_dir"
chown --no-dereference "$CHILD_USER:$CHILD_GROUP" "$env_file"
# 0600, not the 0640 the watcher wrote: after the chown the file belongs to
# the run's child — owner-only. Another run's child shares neither the owner
# nor a group with it (a kept group-r would make every fenix member a
# reader), which is the child.env half of the FOC-878 invariant.
chmod 0600 "$env_file"

# Private scratch dir for the child (Claude Code temp files). When the env
# file carries its own TMPDIR under /tmp/fenix-child/ (the per-child dir the
# watcher makes, FOC-808 slice B), that value wins: validate the prefix and
# that no path component is "..", then create/hand it over exactly like the
# default. Anything else — unset, outside the prefix, containing .. — falls
# back to today's default /tmp/fenix-child-<uid> scratch, per uid and so per
# run by construction. Without this the forced TMPDIR below would override
# the per-child dir and every child would share one scratch.
child_tmp="/tmp/fenix-child-$child_uid"
child_tmp_mode=0700
env_tmpdir=$(sed -n 's/^TMPDIR=//p' "$env_file" | head -n 1)
if [ -n "$env_tmpdir" ] &&
   case $env_tmpdir in /tmp/fenix-child/*) true ;; *) false ;; esac &&
   ! has_dotdot "$env_tmpdir"; then
    child_tmp=$env_tmpdir
    # The per-child dir is setgid + group-writable: the watcher (node, a member
    # of group fenix) removes it at turn end, and the child's umask 0002 keeps
    # what it creates inside group-accessible. The default scratch stays 0700.
    child_tmp_mode=2770
    # The parent is normally made by the entrypoint (fix_cache_permissions:
    # group fenix, setgid, 0775). When the watcher had to create it, node's
    # 0700 would stop a child from entering its own dir — normalise it. Group
    # fenix, NOT the run group: every pool child and node are members, so any
    # run's child can reach its own per-child dir under this shared root; the
    # per-child dirs themselves stay owned by their maker.
    [ -L /tmp/fenix-child ] && refuse 'child tmp root is a symlink'
    mkdir -p /tmp/fenix-child
    chgrp fenix /tmp/fenix-child
    chmod 2775 /tmp/fenix-child
fi
# chmod follows symlinks (there is no lchmod): a planted link would get its
# TARGET re-moded as root. Refuse a link, never follow it.
[ -L "$child_tmp" ] && refuse 'child tmp dir is a symlink'
mkdir -p "$child_tmp"
chown "$CHILD_USER:$CHILD_GROUP" "$child_tmp"
chmod "$child_tmp_mode" "$child_tmp"

# FOC-808: the child's package caches live on the fenix-cache volume like
# node's (so they survive `fenix update` and `fenix prune` sizes them), but in
# a subtree the run's pool user owns — shared with nothing, so neither side
# trips over the other's 0755 directories. The image-wide cache env (Dockerfile
# ENV) would otherwise point the child at node-owned paths. FOC-878: per slot
# (fenix-child-<n>), so a slot reused by a later run keeps working through the
# same uid and no two concurrent runs ever share a cache subtree.
child_cache="/home/node/.cache/fenix-child-$slot"
[ -L "$child_cache" ] && refuse 'child cache dir is a symlink'
mkdir -p "$child_cache"
chown "$CHILD_USER:$CHILD_GROUP" "$child_cache"
chmod 2770 "$child_cache"

# ── exec: drop to the child identity with a clean env ────────────────────────
# The env file is KEY=VALUE lines written by the watcher (values may contain
# spaces, never newlines — the file format is line-delimited). It is applied
# INSIDE the child identity by an env -i sh that reads it line by line and
# exports each line as one argument — no eval, no word splitting on values.
# It is removed as soon as it has been sourced: it holds provider keys, the
# launch dir is owned by the run's child by then, so the unlink succeeds (the
# watcher keeps its own cleanup as belt and braces). HOME/umask are forced
# last so the env file cannot override them; TMPDIR is forced to the dir
# chosen above — the env file's own TMPDIR when it validated under
# /tmp/fenix-child/, the default scratch otherwise. The five cache variables
# are forced to the child's own subtree of the cache volume (see child_cache
# above). Any env failure exits 97
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
        child_cache_dir=$1
        shift
        child_home=$1
        shift
        : "${PATH:=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
        export PATH
        HOME="$child_home" TMPDIR="$child_tmp_dir" \
        XDG_CACHE_HOME="$child_cache_dir" \
        npm_config_cache="$child_cache_dir/npm" \
        PIP_CACHE_DIR="$child_cache_dir/pip" \
        UV_CACHE_DIR="$child_cache_dir/uv" \
        PLAYWRIGHT_BROWSERS_PATH="$child_cache_dir/ms-playwright" \
        exec "$@"
    ' sh "$env_file" "$child_tmp" "$child_cache" "/home/fenix-child-$slot" "$@"
