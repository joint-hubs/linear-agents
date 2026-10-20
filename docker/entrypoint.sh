#!/bin/sh
# Fenix container entrypoint: boots the telemetry API, the Supervisor session
# host (one Supervisor process in tmux, served on :7332 — FOC-783), an attach
# client for the Supervisor's tmux session, the doctor, the agent permission
# inspector (agent-tools), a shell, a passthrough
# command, or manages shared repos (repo-add clones into the workspaces root,
# repo-list shows them). The Supervisor resumes its last session for the repo
# directory unless started with --new.
# Provider credentials come from Compose secret files under /run/secrets and
# are exported into the environment only — never printed, logged, or echoed.
set -eu

# Export secret files into env vars. A missing or empty file is skipped
# silently — the affected provider simply stays unauthenticated.
load_secrets() {
    for spec in \
        'openrouter_api_key OPENROUTER_API_KEY' \
        'linear_api_key LINEAR_API_KEY' \
        'linear_api_key_pisi LINEAR_API_KEY_PISI' \
        'github_token GITHUB_TOKEN GH_TOKEN' \
        'provider_api_key PROVIDER_API_KEY'
    do
        secret_file="/run/secrets/${spec%% *}"
        if [ -s "$secret_file" ]; then
            secret_value="$(cat "$secret_file" | tr -d '\r')"
            for env_name in ${spec#* }; do
                export "$env_name=$secret_value"
            done
        fi
    done
}

# provider-resolve.mjs prints cmd-style lines like:
#   set "ANTHROPIC_BASE_URL=https://openrouter.ai/api"
# Parsed without eval: sed extracts NAME and VALUE into separate variables.
# The output is staged through a temp file so the read loop stays in this
# shell (exports survive) and no second round of expansion touches the value.
resolve_provider() {
    provider_tmp="$(mktemp)"
    if ! node "$LA_ROOT/scripts/provider-resolve.mjs" > "$provider_tmp"; then
        rm -f "$provider_tmp"
        printf '%s\n' 'fenix: provider resolution failed — run: fenix doctor' >&2
        exit 2
    fi
    while IFS= read -r provider_line || [ -n "$provider_line" ]; do
        case $provider_line in
            'set "'*)
                provider_name="$(printf '%s\n' "$provider_line" | sed -n 's/^set "\([A-Z0-9_]*\)=.*/\1/p')"
                provider_value="$(printf '%s\n' "$provider_line" | sed -n 's/^set "[A-Z0-9_]*=\(.*\)"/\1/p')"
                if [ -n "$provider_name" ]; then
                    export "$provider_name=$provider_value"
                fi
                ;;
        esac
    done < "$provider_tmp"
    rm -f "$provider_tmp"
}

# Git over HTTPS answers GitHub from GITHUB_TOKEN in this process's env —
# the helper below is stored in ~/.gitconfig, the token never is.
configure_git() {
    git config --global credential.https://github.com.helper \
        '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'
    node "$LA_ROOT/scripts/fenix-git-identity.mjs" || true
}

# Squad config on the volume follows the image unless you edited it (dpkg rule, D3).
seed_agents() {
    node "$LA_ROOT/scripts/fenix-seed-agents.mjs" --from "$LA_ROOT/agents" --to "$LA_SQUAD_HOME"
}

# Claude Code creates a squad's .claude.json on its first run. Create it now —
# `claude config list` makes no model call — so per-spawn MCP approvals
# (CodeGraph) can land on the volume before the first child (FOC-799).
init_claude_configs() {
    for d in "$LA_SQUAD_HOME"/*/; do
        case "$(basename "$d")" in _shared) continue ;; esac
        [ -f "${d}.claude.json" ] && continue
        (cd /tmp && CLAUDE_CONFIG_DIR="${d%/}" timeout 30 claude config list >/dev/null 2>&1) || true
    done
}

# A child turn that started before this container did cannot be alive here —
# its watcher died with the previous container. Mark it crashed (FOC-799).
mark_orphans() {
    node "$LA_ROOT/scripts/supervisor-orphans.mjs" --container || true
}

# FOC-802: children spawned by the Supervisor run as `fenix-child` (own uid,
# group `fenix`), not as `node`. Apply the shared-write surface idempotently on
# every start: the trees children must write get group `fenix`, setgid dirs and
# g+rwX; the Supervisor-only paths get 0700. Runs as node (the owner of /data,
# and a member of fenix, so chgrp needs no root). Best effort — a chmod failure
# warns but never aborts the container; a fresh volume gets fixed as it fills.
# `FENIX_CHILD_ISOLATION` (default on) does NOT gate this: the entrypoint
# prepares the surface regardless, only the watcher decides whether to use it.
fix_permissions() {
    try() {
        "$@" || printf 'fenix: fix_permissions: failed: %s\n' "$*" >&2
    }
    try mkdir -p /data/run
    try chmod 0700 /data/run
    for node_only in /data/agents/supervisor /data/supervisor; do
        if [ -d "$node_only" ]; then
            try chmod 0700 "$node_only"
        fi
    done
    for shared_tree in /data/state/supervisor /data/telemetry /data/workspaces /data/state/runs; do
        if [ -d "$shared_tree" ]; then
            try chgrp -R fenix "$shared_tree"
            try chmod -R g+rwX "$shared_tree"
            try find "$shared_tree" -type d -exec chmod g+s {} +
        fi
    done
    # The run dirs' own JSON state (children.json, triage.json, intake.json,
    # holds, budget, waker) stays node-owned and NOT group-writable — children
    # must read it, never write it. Depth 2 from the state home is exactly the
    # top level of each run dir; gates/verdicts files live one level deeper and
    # keep their group write.
    if [ -d /data/state/supervisor ]; then
        try find /data/state/supervisor -mindepth 2 -maxdepth 2 -type f -name '*.json' -exec chmod g-w {} +
    fi
    umask 0002
    printf 'fenix: child isolation surface applied (group fenix, setgid + g+rwX on the shared /data trees; FENIX_CHILD_ISOLATION=%s)\n' "${FENIX_CHILD_ISOLATION:-on}" >&2
}

load_secrets
mkdir -p "$LA_TELEMETRY_HOME" "$LA_SUPERVISOR_STATE_HOME" "$LA_SQUAD_HOME" "$GITHUB_ROOT" "$LA_WORKTREE_HOME"
# FOC-808: cache subdirs (env from the Dockerfile), the per-child tmp root and
# the docker-socket dir when a socket is mounted.
mkdir -p "$XDG_CACHE_HOME" "$npm_config_cache" "$PIP_CACHE_DIR" "$UV_CACHE_DIR" \
    "$PLAYWRIGHT_BROWSERS_PATH" /tmp/fenix-child 2>/dev/null || true

# FOC-808: make the cache volume and the child tmp root group-writable for
# `fenix-child` with the same setgid pattern fix_permissions uses on the /data
# shared trees (FOC-802). Top level + one level only — a full -R walk over a
# years-old npm cache would stall every start. Best effort, like fix_permissions.
fix_cache_permissions() {
    try() {
        "$@" || printf 'fenix: fix_cache_permissions: failed: %s\n' "$*" >&2
    }
    for tree in "${XDG_CACHE_HOME:-/home/node/.cache}" /tmp/fenix-child; do
        [ -d "$tree" ] || continue
        try chgrp fenix "$tree"
        try chmod 0775 "$tree"
        try chmod g+s "$tree"
        for sub in "$tree"/*; do
            [ -d "$sub" ] || continue
            try chgrp fenix "$sub"
            try chmod 0775 "$sub"
            try chmod g+s "$sub"
        done
    done
}

case "${1:-api}" in
    api)
        fix_permissions
        fix_cache_permissions
        seed_agents
        init_claude_configs
        # FOC-779: regenerate the registered start/watch artifacts before the
        # API takes over (ui/dist is skipped here — the image ships it). A
        # failing generator never blocks the start; the 60 s server tick and
        # Settings > Artifacts report what stayed stale.
        node "$LA_ROOT/scripts/artifact-registry.mjs" refresh --in-container || echo "artifacts: refresh reported failures (see above)"
        cd "$LA_ROOT"
        exec node scripts/telemetry-server.mjs
        ;;
    host)
        # Supervisor session host (FOC-783), extended into the task-session
        # multiplexer (PRD task-workspace-supervisors): one server on :7332
        # fronts the legacy global supervisor (while no task session exists)
        # and one isolated controller per managed task session. Same startup
        # work the old idle/supervisor cases ran before holding the container up.
        fix_permissions
        fix_cache_permissions
        resolve_provider
        configure_git
        mark_orphans
        exec node "$LA_ROOT/scripts/task-session-host.mjs" serve
        ;;
    idle)
        # Alias of host — kept for old compose files that say command: ["idle"].
        exec "$0" host
        ;;
    attach|supervisor)
        # Attach a terminal to the running Supervisor's tmux session.
        # `supervisor` is kept for backward compatibility: it used to start
        # claude itself, now only the host does, so no path can start a second
        # claude on the same session. With managed task sessions the attach
        # MUST match that session's tmux identity — an ambiguous or empty
        # selection is reported, never silently attached to the global pane.
        ensure_args=""
        if [ "${2:-}" = "--new" ]; then ensure_args="--new"; fi
        if [ "${2:-}" = "--session" ]; then
            target="$(node "$LA_ROOT/scripts/task-session-host.mjs" attach-target --session "${3:-}")" || exit 2
        else
            target="$(node "$LA_ROOT/scripts/task-session-host.mjs" attach-target)" || exit 2
        fi
        case "$(printf '%s' "$target" | sed -n 's/.*"mode":"\([a-z-]*\)".*/\1/p')" in
            session)
                attach_session="$(printf '%s' "$target" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p')"
                if ! node "$LA_ROOT/scripts/supervisor-host.mjs" ensure $ensure_args --session "$attach_session"; then
                    printf '%s\n' 'fenix: the Supervisor host is not ready — check: fenix logs fenix-supervisor' >&2
                    exit 1
                fi
                printf 'Attaching to task session %s — Ctrl-b d detaches, it keeps running.\n' "$attach_session"
                exec tmux -L "fenix-$attach_session" attach-session -t "$attach_session"
                ;;
            selection-required)
                printf '%s\n' 'fenix: several task sessions exist — pick one explicitly (fenix attach --session <id>)' >&2
                printf '%s\n' "$target" >&2
                exit 1
                ;;
            *)
                # legacy: no managed task sessions — the global supervisor pane.
                if ! node "$LA_ROOT/scripts/supervisor-host.mjs" ensure $ensure_args; then
                    printf '%s\n' 'fenix: the Supervisor host is not ready — check: fenix logs fenix-supervisor' >&2
                    exit 1
                fi
                printf '%s\n' 'Attaching to the Supervisor — Ctrl-b d detaches, it keeps running.'
                exec tmux -L fenix attach-session -t supervisor
                ;;
        esac
        ;;
    supervisor-run)
        # Run the Supervisor claude inside the host's tmux session. ONLY the
        # host calls this (`entrypoint.sh supervisor-run [--new]`): running it
        # elsewhere would start a second claude on the same session.
        # The pane does NOT necessarily inherit the host's provider env: the
        # tmux server may have been started by `fenix attach`'s
        # `docker compose exec` process, which never ran resolve_provider — so
        # the pane's claude resolves the provider HERE, just before it execs.
        new_session=0
        if [ "${2:-}" = "--new" ]; then new_session=1; fi
        # A managed task session (FENIX_SUPERVISOR_SESSION_ID set by the host)
        # MUST NOT share the squad config dir: a `claude --continue` there
        # would cross-resume another task's native conversation history. Its
        # isolated dir under the session home is seeded ONCE from the global
        # supervisor config (prompt/settings/agents/skills only — never
        # .claude.json or projects/), and resuming the same session keeps
        # that history. The legacy global supervisor keeps the squad dir.
        if [ -n "${FENIX_SUPERVISOR_SESSION_ID:-}" ]; then
            CLAUDE_CONFIG_DIR="$(node "$LA_ROOT/scripts/task-session-host.mjs" config-dir --session "$FENIX_SUPERVISOR_SESSION_ID")" || {
                printf '%s\n' 'fenix: invalid supervisor session id - refusing to start a managed pane' >&2
                exit 2
            }
        else
            CLAUDE_CONFIG_DIR="$LA_SQUAD_HOME/supervisor"
        fi
        export CLAUDE_CONFIG_DIR
        LA_SUPERVISOR_REPO="${FENIX_REPO_DIR:-$GITHUB_ROOT}"
        export LA_SUPERVISOR_REPO
        mkdir -p "$LA_SUPERVISOR_REPO"
        cd "$LA_SUPERVISOR_REPO"
        resolve_provider
        # Evaluated after resolve_provider: LA_PROVIDER_DEFAULT_MODEL comes from
        # the provider entry's defaultModel (FOC-773). The Settings overlay's
        # routing.supervisor.lead sits between SUPERVISOR_MODEL and it; the old
        # hard-coded x-ai/grok-4.7 stays the last-resort fallback. A
        # broken settings.json is ignored — the CLI fails loudly and the chain
        # falls through.
        settings_model="$(node "$LA_ROOT/scripts/fenix-settings.mjs" get routing.supervisor.lead 2>/dev/null || true)"
        ANTHROPIC_MODEL="${SUPERVISOR_MODEL:-${settings_model:-${LA_PROVIDER_DEFAULT_MODEL:-x-ai/grok-4.7}}}"
        export ANTHROPIC_MODEL
        node "$LA_ROOT/scripts/fenix-claude-prefs.mjs" --config-dir "$CLAUDE_CONFIG_DIR" --trust "$LA_SUPERVISOR_REPO"
        # FOC-807: the waker, guard, briefing and telemetry hooks read the run id
        # from the claude process env — export the same trio (LA_SUPERVISOR_RUN,
        # RUN_ID, LA_RUN_ID) the Windows launcher sets. Resolve failure keeps
        # today's behaviour: start without the id, the Cockpit shows no waker.
        run_new_arg=""
        if [ "$new_session" -eq 1 ]; then run_new_arg="--new"; fi
        # The resolve exit code decides the legacy branch's behaviour: 0 → run
        # id exported; 3 → FOC-901 scoped-only refusal (live managed task
        # sessions) — fail closed like the managed branch, with the CLI's
        # refusal message already on stderr; anything else → today's
        # warn-and-continue (the pane starts without a run id).
        run_rc=0
        run_out="$(node "$LA_ROOT/scripts/supervisor-current-run.mjs" resolve $run_new_arg --model "$ANTHROPIC_MODEL")" || run_rc=$?
        if [ "$run_rc" -eq 0 ]; then
            run_id="${run_out%% *}"
            run_source="${run_out#* }"
            export LA_SUPERVISOR_RUN="$run_id" RUN_ID="$run_id" LA_RUN_ID="$run_id"
            printf 'fenix: Supervisor run %s (%s)\n' "$run_id" "$run_source" >&2
            # A brand-new run registers in the shared manifest store — never on a
            # resume, where `start` would blindly overwrite the existing manifest.
            if [ "$run_source" = "new" ]; then
                if ! node "$LA_ROOT/scripts/run-manifest.mjs" start "$run_id" supervisor "$LA_SUPERVISOR_REPO" >/dev/null 2>&1; then
                    printf 'fenix: run-manifest start failed for %s - telemetry may miss this run\n' "$run_id" >&2
                fi
            fi
        elif [ -n "${FENIX_SUPERVISOR_SESSION_ID:-}" ]; then
            # Scoped identity resolution failed (missing context or an owner
            # mismatch) — fail closed: a managed pane NEVER starts without its
            # own run id, and never silently adopts another task's run.
            printf '%s\n' 'fenix: scoped run resolution failed - refusing to start a managed Supervisor without its own run id' >&2
            exit 2
        elif [ "$run_rc" -eq 3 ]; then
            # FOC-901: an unscoped session may not adopt or run next to live
            # managed task sessions. The refusal message (each session, its
            # scoped command and the override) was printed to stderr by the CLI.
            printf '%s\n' 'fenix: live managed task sessions own this container - refusing to start an unscoped Supervisor (start it scoped, or set FENIX_SUPERVISOR_LEGACY=1)' >&2
            exit 2
        else
            printf '%s\n' 'fenix: no Supervisor run id - waker, guard and briefing stay off' >&2
        fi
        # Resume the last Supervisor session for this directory unless --new (D5).
        project_dir="$CLAUDE_CONFIG_DIR/projects/$(printf '%s' "$LA_SUPERVISOR_REPO" | sed 's|[^A-Za-z0-9]|-|g')"
        if [ "$new_session" -eq 0 ] && ls "$project_dir"/*.jsonl >/dev/null 2>&1; then
            exec node "$LA_ROOT/scripts/supervisor-launch.mjs" --continue
        fi
        exec node "$LA_ROOT/scripts/supervisor-launch.mjs"
        ;;
    repo-add)
        shift
        repo_url="${1:-}"
        if [ -z "$repo_url" ]; then
            printf '%s\n' 'usage: repo-add <git-url|owner/name> [--project <Linear project>]' >&2
            exit 2
        fi
        shift
        project=""
        if [ "${1:-}" = "--project" ]; then project="${2:-}"; fi
        case $repo_url in
            http*://*|git@*|ssh://*) ;;
            */*) repo_url="https://github.com/$repo_url.git" ;;
        esac
        repo_name="$(basename "$repo_url" .git)"
        if [ -e "$GITHUB_ROOT/$repo_name" ]; then
            printf 'fenix: %s already exists in %s\n' "$repo_name" "$GITHUB_ROOT" >&2
            exit 3
        fi
        configure_git
        git clone "$repo_url" "$GITHUB_ROOT/$repo_name"
        if [ -n "$project" ]; then
            node "$LA_ROOT/scripts/fenix-projects.mjs" add --linear-project "$project" --repo "\${GITHUB_ROOT}/$repo_name"
        fi
        ;;
    repo-list)
        for d in "$GITHUB_ROOT"/*/; do
            [ -d "$d.git" ] || continue
            printf '%s\t%s\t%s\n' "$(basename "$d")" "$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)" "$(git -C "$d" remote get-url origin 2>/dev/null)"
        done
        node "$LA_ROOT/scripts/fenix-projects.mjs" list || true
        ;;
    doctor)
        shift
        cd "$LA_ROOT"
        exec node scripts/fenix-doctor.mjs "$@"
        ;;
    agent-tools)
        shift
        cd "$LA_ROOT"
        exec node scripts/agent-tools.mjs "$@"
        ;;
    fix-permissions)
        # Test/ops entry to the FOC-802/FOC-808 surface appliers without
        # starting any service: `docker/entrypoint.sh fix-permissions` applies
        # them and exits.
        fix_permissions
        fix_cache_permissions
        ;;
    shell)
        exec /bin/bash
        ;;
    *)
        exec "$@"
        ;;
esac
