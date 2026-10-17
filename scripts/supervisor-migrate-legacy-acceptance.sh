#!/bin/sh
# scripts/supervisor-migrate-legacy-acceptance.sh — the FOC-839 legacy
# migration acceptance on a COPY of the VM data volume (PRD §5, plan §2 slice B).
#
# Usage:
#   sh scripts/supervisor-migrate-legacy-acceptance.sh <copy-of-volume> [<workspace>]
#
# <copy-of-volume> is a COPY of the container's /data volume — the script
# normalises the argument (trailing slashes stripped, resolved with
# `cd && pwd -P`) and refuses the live /data, /, and an empty result.
# <workspace> (optional) is exported as FENIX_WORK_WORKSPACE so the task keys
# resolve against the same workspace the production run used (workspaceNameFor
# defaults to `jointhubs` when the argument is omitted); the summary line
# prints the workspace that was used. It points the
# two path seams at the copy — exactly the envs the paths derive from
# (scripts/fenix-paths.mjs / scripts/utils.mjs):
#
#   LA_DATA_HOME              → the task-sessions store, the legacy
#                               session.json and the global current-run pointer
#                               (<dataHome>/supervisor/…)
#   LA_SUPERVISOR_STATE_HOME  → the run dirs (<copy>/state/supervisor, the
#                               container's value for /data/state/supervisor;
#                               falls back to <copy>/.state/supervisor when a
#                               copy carries the repo-local layout)
#
# then:
#
#   1. dry run  — computes the plan, writes nothing;
#   2. --apply  — attaches and marks;
#   3. --apply --json — asserts idempotence: attached 0 and marked 0.
#
# Prints the three counts (attached / read-only / skipped) per pass and the
# final verdict. Exit 0 on success, 1 on any mismatch.
#
# POSIX sh, no bashisms beyond `set -eu`.

set -eu

usage() {
  echo "usage: sh scripts/supervisor-migrate-legacy-acceptance.sh <copy-of-volume> [<workspace>]" >&2
  echo "  <copy-of-volume> must be a COPY of the data volume — /data, / and an empty path are refused" >&2
  echo "  <workspace>       optional; exported as FENIX_WORK_WORKSPACE (default: jointhubs)" >&2
  exit 2
}

COPY="${1:-}"
[ -n "$COPY" ] || usage
# Normalise before comparing: strip trailing slashes, refuse the live volume
# by name, then resolve the path physically (this also catches a symlink
# pointing at the live /data). An empty result (the argument was "/", e.g.)
# is refused like the live volume.
COPY=$(printf '%s' "$COPY" | sed 's:/*$::')
[ -n "$COPY" ] || { echo "refusing to run against the live volume root — pass a COPY of the volume" >&2; exit 2; }
[ "$COPY" != "/data" ] || { echo "refusing to run against the live /data — pass a COPY of the volume" >&2; exit 2; }
COPY=$(CDPATH= cd -- "$COPY" 2>/dev/null && pwd -P) || { echo "not a directory: $1" >&2; exit 2; }
[ "$COPY" != "/" ] || { echo "refusing to run against the live volume root — pass a COPY of the volume" >&2; exit 2; }
[ "$COPY" != "/data" ] || { echo "refusing to run against the live /data — pass a COPY of the volume" >&2; exit 2; }

WORKSPACE="${2:-}"
if [ -n "$WORKSPACE" ]; then
  FENIX_WORK_WORKSPACE="$WORKSPACE"
  export FENIX_WORK_WORKSPACE
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLI="$SCRIPT_DIR/supervisor-migrate-legacy.mjs"

# The state home inside the copy: the container layout first, the repo-local
# layout second. Neither present → the copy holds no runs; the migration will
# report that honestly.
if [ -d "$COPY/state/supervisor" ]; then
  STATE_HOME="$COPY/state/supervisor"
elif [ -d "$COPY/.state/supervisor" ]; then
  STATE_HOME="$COPY/.state/supervisor"
else
  STATE_HOME="$COPY/state/supervisor"
fi

LA_DATA_HOME="$COPY"
LA_SUPERVISOR_STATE_HOME="$STATE_HOME"
export LA_DATA_HOME LA_SUPERVISOR_STATE_HOME

echo "== pass 1: dry run =="
DRY_OUT=$(node "$CLI")
echo "$DRY_OUT"
DRY_COUNTS=$(echo "$DRY_OUT" | head -n 1)
echo "== pass 2: apply =="
APPLY_OUT=$(node "$CLI" --apply)
echo "$APPLY_OUT"
echo "== pass 3: apply again (idempotence, --json) =="
JSON_OUT=$(node "$CLI" --apply --json)
echo "$JSON_OUT"

ATTACHED_2=$(printf '%s' "$JSON_OUT" | node -e 'let s="";process.stdin.on("data",(c)=>{s+=c});process.stdin.on("end",()=>{const r=JSON.parse(s);console.log(r.attached.length)})')
MARKED_2=$(printf '%s' "$JSON_OUT" | node -e 'let s="";process.stdin.on("data",(c)=>{s+=c});process.stdin.on("end",()=>{const r=JSON.parse(s);console.log(r.readOnly.length)})')

APPLY_COUNTS=$(echo "$APPLY_OUT" | head -n 1)

echo ""
echo "dry run:  $DRY_COUNTS"
echo "apply:    $APPLY_COUNTS"
echo "re-apply: attached $ATTACHED_2, read-only $MARKED_2 (expected 0 and 0)"
echo "workspace: ${WORKSPACE:-jointhubs (default, FENIX_WORK_WORKSPACE unset)}"

if [ "$ATTACHED_2" != "0" ] || [ "$MARKED_2" != "0" ]; then
  echo "FAIL: the second --apply was not idempotent" >&2
  exit 1
fi

echo "OK: legacy migration acceptance passed"
