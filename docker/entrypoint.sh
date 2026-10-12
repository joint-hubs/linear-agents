#!/bin/sh
# Fenix container entrypoint: boots the telemetry API, an idle supervisor
# holder (for `fenix attach`), the doctor, a shell, a passthrough command, or
# manages shared repos (repo-add clones into the workspaces root, repo-list
# shows them). The supervisor resumes its last session for the repo directory
# unless started with --new.
# Provider credentials come from Compose secret files under /run/secrets and
# are exported into the environment only — never printed, logged, or echoed.
set -eu

# Export secret files into env vars. A missing or empty file is skipped
# silently — the affected provider simply stays unauthenticated.
load_secrets() {
    for spec in \
        'openrouter_api_key OPENROUTER_API_KEY' \
        'linear_api_key LINEAR_API_KEY' \
        'github_token GITHUB_TOKEN GH_TOKEN'
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

load_secrets
mkdir -p "$LA_TELEMETRY_HOME" "$LA_SUPERVISOR_STATE_HOME" "$LA_SQUAD_HOME" "$GITHUB_ROOT" "$LA_WORKTREE_HOME"

case "${1:-api}" in
    api)
        seed_agents
        cd "$LA_ROOT"
        exec node scripts/telemetry-server.mjs
        ;;
    supervisor)
        resolve_provider
        configure_git
        new_session=0
        if [ "${2:-}" = "--new" ]; then new_session=1; fi
        CLAUDE_CONFIG_DIR="$LA_SQUAD_HOME/supervisor"
        export CLAUDE_CONFIG_DIR
        ANTHROPIC_MODEL="${SUPERVISOR_MODEL:-xiaomi/mimo-v2.6-pro}"
        export ANTHROPIC_MODEL
        LA_SUPERVISOR_REPO="${FENIX_REPO_DIR:-$GITHUB_ROOT}"
        export LA_SUPERVISOR_REPO
        mkdir -p "$LA_SUPERVISOR_REPO"
        cd "$LA_SUPERVISOR_REPO"
        node "$LA_ROOT/scripts/fenix-claude-prefs.mjs" --config-dir "$CLAUDE_CONFIG_DIR" --trust "$LA_SUPERVISOR_REPO"
        # Resume the last Supervisor session for this directory unless --new (D5).
        project_dir="$CLAUDE_CONFIG_DIR/projects/$(printf '%s' "$LA_SUPERVISOR_REPO" | sed 's|[^A-Za-z0-9]|-|g')"
        if [ "$new_session" -eq 0 ] && ls "$project_dir"/*.jsonl >/dev/null 2>&1; then
            exec claude --continue
        fi
        exec claude
        ;;
    idle)
        # Hold the container up so `fenix attach` can reach the supervisor;
        # children are spawned from this container.
        configure_git
        exec sleep infinity
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
    shell)
        exec /bin/bash
        ;;
    *)
        exec "$@"
        ;;
esac
