#!/bin/sh
# Fenix container entrypoint: boots the telemetry API, an idle supervisor
# holder (for `fenix attach`), the doctor, a shell, or a passthrough command.
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

load_secrets
mkdir -p "$LA_TELEMETRY_HOME" "$LA_SUPERVISOR_STATE_HOME" /data/workspaces

case "${1:-api}" in
    api)
        cd "$LA_ROOT"
        exec node scripts/telemetry-server.mjs
        ;;
    supervisor)
        resolve_provider
        CLAUDE_CONFIG_DIR="$LA_ROOT/agents/supervisor"
        export CLAUDE_CONFIG_DIR
        ANTHROPIC_MODEL="${SUPERVISOR_MODEL:-xiaomi/mimo-v2.6-pro}"
        export ANTHROPIC_MODEL
        LA_SUPERVISOR_REPO="${FENIX_REPO_DIR:-$LA_ROOT}"
        export LA_SUPERVISOR_REPO
        cd "$LA_SUPERVISOR_REPO"
        exec claude
        ;;
    idle)
        # Hold the container up so `fenix attach` can reach the supervisor.
        exec sleep infinity
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
