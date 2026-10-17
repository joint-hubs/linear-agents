#!/bin/sh
# FOC-802: the isolation lane. Runs OUTSIDE the container, as its own root
# process (the container's root — `docker run --user root`, no --privileged):
#   docker run --rm --user root -v <checkout>:/src:ro fenix:dev sh /src/docker/test-isolation.sh
# Inside, it builds the /data volume layout by hand, applies the entrypoint's
# REAL fix_permissions (as node), then drives the REAL privileged path —
# node -> sudo -> fenix-spawn-as-child -> setpriv -> fenix-child — with a fake
# `claude` that probes what a child must and must not reach:
#   must FAIL:   write /data/agents/supervisor/settings.json (EACCES),
#                read /data/run/host.token (EACCES),
#                reach the Supervisor's tmux socket `fenix` (tmux reports a
#                socket/connection error on stderr — a bare non-zero exit is
#                NOT enough, e.g. a missing tmux binary would exit non-zero
#                without proving anything),
#                and write a verdict file
#   must SUCCEED: git commit in its worktree (through the main clone's gitdir),
#                write a gate answer and append edits.jsonl in its run dir
# Exit 0 when every assertion holds, 1 with a readable diff otherwise. The
# helper-refusal cases (worktree outside the root, root-owned env file,
# symlinked worktree / config dir, out-of-scope gitdir) must all exit 97 —
# the helper's dedicated refusal code — without starting anything.
set -eu

SRC=${FENIX_TEST_SRC:-/src}
ENTRYPOINT=/opt/fenix/docker/entrypoint.sh
HELPER=/usr/local/sbin/fenix-spawn-as-child
RUN_DIR=/data/state/supervisor/run-1
CONFIG_DIR=$RUN_DIR/launch/turn-1
WORKTREE=/data/workspaces/la-wt/t1

fail() {
    printf 'FAIL %s\n' "$1" >&2
    exit 1
}
pass() {
    printf 'PASS %s\n' "$1"
}

[ "$(id -u)" = "0" ] || fail 'this script must run as the container root (--user root)'
[ -x "$ENTRYPOINT" ] || fail "no $ENTRYPOINT in the image — rebuild it"
[ -x "$HELPER" ] || fail "no $HELPER in the image — rebuild it"

run_as_node() {
    # Mirror the entrypoint's umask 0002 — production node processes inherit it.
    setpriv --reuid=node --regid=node --init-groups /bin/sh -c "umask 0002; $1"
}

# ── build the /data layout the entrypoint expects (root, then hand to node) ──
mkdir -p /data/agents/supervisor \
    /data/run \
    /data/telemetry \
    /data/state/runs \
    /data/state/supervisor/run-1/gates \
    /data/state/supervisor/run-1/verdicts \
    /data/state/supervisor/run-1/children \
    "$CONFIG_DIR" \
    /data/workspaces/la-wt \
    /data/workspaces/seed-repo
chown -R node:node /data

# The entrypoint's own surface applier — the production code path, not a copy.
run_as_node "$ENTRYPOINT fix-permissions" || fail 'fix_permissions failed as node'
pass 'fix_permissions ran as node'

# Supervisor-only state: node-owned, 0700/0600 — the child must NOT reach it.
run_as_node 'umask 077; printf iso-host-secret > /data/run/host.token; printf "{\"probe\":true}" > /data/agents/supervisor/settings.json'
[ "$(stat -c '%a' /data/run/host.token)" = "600" ] || fail 'host.token is not 0600'

# The Supervisor's tmux server, owned by node (sockets are uid-scoped under
# /tmp/tmux-<uid>/, so a different uid cannot even resolve it). The binary
# must exist in the image or the child-side assertion below would be vacuous.
run_as_node 'command -v tmux' || fail 'tmux is not in the image — the tmux assertion would be vacuous'
run_as_node 'tmux -L fenix new-session -d -s iso-hold "sleep 600"' || fail 'tmux server did not start'
pass 'tmux server running as node'

# A real git repository with a real linked worktree — the commit check goes
# through the main clone's object store, exactly like production children.
run_as_node 'git init -q /data/workspaces/seed-repo \
    && git -C /data/workspaces/seed-repo config user.email fenix-test@example.invalid \
    && git -C /data/workspaces/seed-repo config user.name fenix-test \
    && git -C /data/workspaces/seed-repo commit -q --allow-empty -m seed \
    && git -C /data/workspaces/seed-repo worktree add -q -b iso-t1 /data/workspaces/la-wt/t1' \
    || fail 'seed repo / worktree setup failed'
pass 'seed repo and linked worktree created as node'

# Repos created after the first application get the surface on the next start
# in production — re-apply here (also proves the applier is idempotent).
run_as_node "$ENTRYPOINT fix-permissions" || fail 'second fix_permissions run failed'
pass 'fix_permissions idempotent over state created after the first run'

# The fake claude: a node script probing every surface from the child uid.
cat > "$CONFIG_DIR/fake-claude.mjs" <<'PROBE'
#!/usr/local/bin/node
// FOC-802 isolation probe — runs as fenix-child, reports one JSON object.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const probeWrite = (path) => {
    try {
        appendFileSync(path, "x");
        return "WRITE_ALLOWED";
    } catch (err) {
        return err.code || String(err);
    }
};
const out = { uid: process.getuid() };
out.supervisorSettings = probeWrite("/data/agents/supervisor/settings.json");
out.hostToken = (() => {
    try {
        readFileSync("/data/run/host.token", "utf8");
        return "READ_ALLOWED";
    } catch (err) {
        return err.code || String(err);
    }
})();
// stderr is captured so the assertion can demand a socket/connection error —
// a non-zero exit alone would also fire for a missing binary or a dead
// server, which proves nothing about uid scoping.
const tmux = spawnSync("tmux", ["-L", "fenix", "ls"], { encoding: "utf8" });
out.tmux = tmux.error ? String(tmux.error) : `exit${tmux.status}`;
out.tmuxErr = (tmux.stderr || "").trim();
const git = spawnSync("git", ["-C", process.env.LA_TEST_WORKTREE, "commit", "--allow-empty", "-m", "iso-probe"], { stdio: "ignore" });
out.gitCommit = git.error ? String(git.error) : `exit${git.status}`;
out.gate = probeWrite("/data/state/supervisor/run-1/gates/iso-probe.json");
out.verdict = probeWrite("/data/state/supervisor/run-1/verdicts/iso-probe.json");
out.edits = probeWrite("/data/state/supervisor/run-1/edits.jsonl");
writeFileSync(process.env.LA_TEST_RESULT, JSON.stringify(out, null, 2));
PROBE
chmod 0755 "$CONFIG_DIR/fake-claude.mjs"
chown node:node "$CONFIG_DIR/fake-claude.mjs"

# The watcher's env file: node-owned, exactly 0640, under the run's launch dir.
run_as_node 'umask 027; printf "LA_TEST_WORKTREE=/data/workspaces/la-wt/t1\nLA_TEST_RESULT=/data/state/supervisor/run-1/launch/turn-1/result.json\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n" > /data/state/supervisor/run-1/launch/turn-1/child.env'
[ "$(stat -c '%a' "$CONFIG_DIR/child.env")" = "640" ] || fail 'child.env is not 0640'
[ "$(stat -c '%u' "$CONFIG_DIR/child.env")" = "$(id -u node)" ] || fail 'child.env not owned by node'

# ── the real spawn path: node -> sudo -> helper -> setpriv -> fenix-child ────
run_as_node "sudo -n $HELPER $CONFIG_DIR/child.env $WORKTREE $CONFIG_DIR -- $CONFIG_DIR/fake-claude.mjs" \
    || fail 'the helper spawn failed'
RESULT_JSON=$(cat "$CONFIG_DIR/result.json")
CHILD_UID=$(id -u fenix-child)
printf 'probe result: %s\n' "$RESULT_JSON"

# ── assertions (readable diff on any mismatch) ───────────────────────────────
node -e '
const out = JSON.parse(process.argv[1]);
const childUid = Number(process.argv[2]);
const tmuxErr = String(out.tmuxErr || "");
const tmuxOk = out.tmux !== "exit0"
  && /error connecting|no such file|permission denied/i.test(tmuxErr);
const checks = [
  ["uid is fenix-child", out.uid, childUid],
  ["cannot write supervisor settings", out.supervisorSettings, "EACCES"],
  ["cannot read host.token", out.hostToken, "EACCES"],
  ["git commit in its worktree", out.gitCommit, "exit0"],
  ["write a gate answer", out.gate, "WRITE_ALLOWED"],
  ["write a verdict answer", out.verdict, "WRITE_ALLOWED"],
  ["append edits.jsonl", out.edits, "WRITE_ALLOWED"],
];
let rc = 0;
for (const [name, got, want] of checks) {
  const ok = String(got) === String(want);
  if (ok) { console.log(`PASS ${name}`); continue; }
  console.log(`FAIL ${name}: expected ${want}, got ${got}`);
  rc = 1;
}
if (tmuxOk) { console.log(`PASS cannot reach the supervisor tmux socket (${out.tmux}: ${tmuxErr})`); }
else { console.log(`FAIL tmux socket: expected a non-zero exit whose stderr names the socket/connection, got status=${out.tmux} stderr=${tmuxErr}`); rc = 1; }
process.exit(rc);
' "$RESULT_JSON" "$CHILD_UID" || fail 'isolation assertions failed'
pass 'all isolation assertions hold'

# ── the helper must refuse out-of-scope spawns without starting anything ────
# child.env is consumed by the successful spawn above, so the refusal cases
# get their own node-owned 0640 env file at an otherwise valid path.
run_as_node 'umask 027; printf "LA_TEST_REFUSAL=1\n" > /data/state/supervisor/run-1/launch/turn-1/refusal.env' \
    || fail 'refusal env file setup failed'
REFUSAL_ENV=$CONFIG_DIR/refusal.env

# Worktree outside /data/workspaces/la-wt.
mkdir -p /tmp/iso-evil-worktree
rc=0
run_as_node "sudo -n $HELPER $REFUSAL_ENV /tmp/iso-evil-worktree $CONFIG_DIR -- $CONFIG_DIR/fake-claude.mjs" 2>/dev/null || rc=$?
[ "$rc" = "97" ] || fail "helper accepted a worktree outside /data/workspaces/la-wt (rc=$rc)"
pass 'helper refuses a worktree outside /data/workspaces/la-wt (exit 97)'

# Root-owned env file at an otherwise valid path — the ownership check must trip.
printf 'EVIL=1\n' > "$CONFIG_DIR/env-root.env"
chmod 0640 "$CONFIG_DIR/env-root.env"
rc=0
run_as_node "sudo -n $HELPER $CONFIG_DIR/env-root.env $WORKTREE $CONFIG_DIR -- $CONFIG_DIR/fake-claude.mjs" 2>/dev/null || rc=$?
[ "$rc" = "97" ] || fail "helper accepted an env file it does not own (rc=$rc)"
pass 'helper refuses an env file not owned by node (exit 97)'

# Symlinked arguments: a link named like a legitimate child path pointing at
# Supervisor-only state must be refused before any chown touches the target.
run_as_node "ln -s /data/agents/supervisor $RUN_DIR/launch/turn-evil \
    && ln -s /data/run /data/workspaces/la-wt/evil-link" \
    || fail 'symlink case setup failed'
rc=0
run_as_node "sudo -n $HELPER $REFUSAL_ENV /data/workspaces/la-wt/evil-link $CONFIG_DIR -- $CONFIG_DIR/fake-claude.mjs" 2>/dev/null || rc=$?
[ "$rc" = "97" ] || fail "helper accepted a symlinked worktree (rc=$rc)"
rc=0
run_as_node "sudo -n $HELPER $REFUSAL_ENV $WORKTREE $RUN_DIR/launch/turn-evil -- $CONFIG_DIR/fake-claude.mjs" 2>/dev/null || rc=$?
[ "$rc" = "97" ] || fail "helper accepted a symlinked config dir (rc=$rc)"
[ "$(stat -c '%U %a' /data/agents/supervisor)" = "node 700" ] \
    || fail "/data/agents/supervisor was touched through $RUN_DIR/launch/turn-evil"
[ "$(stat -c '%U %a' /data/run)" = "node 700" ] \
    || fail "/data/run was touched through /data/workspaces/la-wt/evil-link"
pass 'helper refuses symlinked worktree/config-dir, targets stay node:0700 (exit 97)'

# Out-of-scope gitdir: a worktree whose .git file points at another repo's
# .git ROOT (not a worktrees/<basename> dir) must be refused — the chown must
# never land on the main clone's git store.
run_as_node 'mkdir -p /data/workspaces/la-wt/evil-wt \
    && printf "gitdir: /data/workspaces/seed-repo/.git\n" > /data/workspaces/la-wt/evil-wt/.git' \
    || fail 'gitdir case setup failed'
rc=0
run_as_node "sudo -n $HELPER $REFUSAL_ENV /data/workspaces/la-wt/evil-wt $CONFIG_DIR -- $CONFIG_DIR/fake-claude.mjs" 2>/dev/null || rc=$?
[ "$rc" = "97" ] || fail "helper accepted a gitdir outside worktrees/<name> (rc=$rc)"
[ "$(stat -c '%U' /data/workspaces/seed-repo/.git)" = "node" ] \
    || fail "the seed repo's .git root got chowned through an out-of-scope gitdir"
pass 'helper refuses a gitdir pointing at another repo .git, store stays node-owned (exit 97)'

printf 'FOC-802 isolation lane: ALL GREEN\n'