#!/bin/sh
# FOC-802: the isolation lane. Runs OUTSIDE the container, as its own root
# process (the container's root — `docker run --user root`, no --privileged):
#   docker run --rm --user root -v <checkout>:/src:ro fenix:dev sh /src/docker/test-isolation.sh
# Inside, it builds the /data volume layout by hand, applies the entrypoint's
# REAL fix_permissions (as node), then drives the REAL privileged path —
# node -> sudo -> fenix-spawn-as-child -> setpriv -> the run's fenix-child-<n>
# — with a fake
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
#
# FOC-980: the transcript-share helper is exercised directly through its
# production sudo path (node -> sudo -n -u fenix-child-0) against a hostile
# fixture: child-controlled filenames (a newline with /etc/passwd-like text,
# a glob character), a symlink to a root-owned file, and refusals for /etc,
# a ".." path, a symlinked launch dir and a root run (the share helper's
# refusal code is 2).
#
# FOC-878: a two-run block drives the per-run identity probes — different pool
# slots for two runs through the real helper, cross-run EACCES on gates,
# verdicts, edits.jsonl, the worktree and the kept-alive child.env, node
# keeping every write, supervisor-status reporting the run identity, and pool
# exhaustion refusing (exit 97) while modifying nothing.
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
# FOC-980: the transcript-share helper must be installed and root-owned like
# the spawn helper — the sudoers check below keys on its path.
SHARE_HELPER=/usr/local/sbin/fenix-child-share
[ -x "$SHARE_HELPER" ] || fail "no $SHARE_HELPER in the image — rebuild it"

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
// FOC-802 isolation probe — runs as its run's pool user, reports one JSON object.
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

# ── the real spawn path: node -> sudo -> helper -> setpriv -> fenix-child-0 ──
run_as_node "sudo -n $HELPER $CONFIG_DIR/child.env $WORKTREE $CONFIG_DIR -- $CONFIG_DIR/fake-claude.mjs" \
    || fail 'the helper spawn failed'
RESULT_JSON=$(cat "$CONFIG_DIR/result.json")
# FOC-878: the first spawn of the container claims pool slot 0 (lowest free).
CHILD_UID=$(id -u fenix-child-0)
printf 'probe result: %s\n' "$RESULT_JSON"

# ── assertions (readable diff on any mismatch) ───────────────────────────────
node -e '
const out = JSON.parse(process.argv[1]);
const childUid = Number(process.argv[2]);
const tmuxErr = String(out.tmuxErr || "");
const tmuxOk = out.tmux !== "exit0"
  && /error connecting|no such file|permission denied/i.test(tmuxErr);
const checks = [
  ["uid is fenix-child-0 (run pool slot 0)", out.uid, childUid],
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

# ── FOC-980: the transcript-share helper, against a hostile fixture ──────────
# Production path: node -> sudo -n -u fenix-child-<n> -> fenix-child-share <dir>.
# The runas is the run's own pool user (FOC-878), resolved by supervisor-lib's
# runChildShareHelper from the run's identity.json — the fixture claims slot 0
# below, exactly as the container's spawn helper writes it. The helper runs as
# the child user, never root: the transcripts are child-owned files and the
# owner may chmod its own files, so a raced-in symlink can only touch files
# the child could chmod anyway. The fixture proves both halves of that design:
# filenames the child controls reach chmod as single find arguments (the old
# `for f in $(find …)` loop would have word-split the newline-carrying path so
# that one token is $SHARE_TARGET itself — the `root 600` assertion below
# proves that split never happens — and would have glob-expanded the star
# name), and a symlink to a root-owned 0600 file is never followed.
SHARE_RUN=/data/state/supervisor/t980run
SHARE_DIR=$SHARE_RUN/launch/dev-9/turn-0
SHARE_PROJECT=$SHARE_DIR/projects/p
SHARE_TARGET=/data/state/supervisor/t980share-target
mkdir -p "$SHARE_PROJECT" || fail 'share fixture setup failed'
# The run's identity (slot 0) as the spawn helper writes it — what the lib's
# childShareRunas reads to pick the runas.
printf '{"slot":0,"user":"fenix-child-0","group":"fenix-run-0","assignedAt":"2026-11-07T00:00:00.000Z"}\n' > "$SHARE_RUN/identity.json"
chmod 0644 "$SHARE_RUN/identity.json"
printf '{"transcript":true}' > "$SHARE_PROJECT/s.jsonl"
# The real word-splitting attack is a child-created DIRECTORY whose name
# contains a newline: split on it, one token of the find output is exactly
# $SHARE_TARGET below — the chmod would then land on a root-owned file.
NL='
'
weird_dir="$SHARE_PROJECT/zz${NL}/data/state/supervisor"
mkdir -p "$weird_dir" || fail 'share fixture setup failed (weird dir)'
weird="$weird_dir/t980share-target${NL}.jsonl"
printf 'x' > "$weird"
printf 'x' > "$SHARE_PROJECT/star-*.jsonl"
chmod 0600 "$SHARE_PROJECT/s.jsonl" "$weird" "$SHARE_PROJECT/star-*.jsonl"
printf 'root-secret' > "$SHARE_TARGET"
chmod 0600 "$SHARE_TARGET"
ln -s "$SHARE_TARGET" "$SHARE_PROJECT/link.jsonl"
# The transcripts carry the child's own identity (FOC-878): owner
# fenix-child-0, primary group fenix-run-0 — the group node is a member of,
# which is exactly what the share helper widens for.
chown -R fenix-child-0:fenix-run-0 "$SHARE_DIR"
pass 'share fixture created (0600 fenix-child-0 files, newline/star names, symlink)'

rc=0
SHARE_COUNT=$(run_as_node "sudo -n -u fenix-child-0 $SHARE_HELPER $SHARE_DIR") || rc=$?
[ "$rc" = "0" ] || fail "the share helper failed (rc=$rc)"
[ "$SHARE_COUNT" = "3" ] || fail "share helper reported $SHARE_COUNT files changed, expected 3"
[ "$(stat -c '%a' "$SHARE_PROJECT/s.jsonl")" = "640" ] \
    || fail "s.jsonl is not 0640 after the share ($(stat -c '%a' "$SHARE_PROJECT/s.jsonl"))"
[ "$(stat -c '%a' "$weird")" = "640" ] \
    || fail 'the newline-named file was not widened as a single path'
[ "$(stat -c '%a' "$SHARE_PROJECT/star-*.jsonl")" = "640" ] \
    || fail 'the glob-named file was not widened as a single path'
[ "$(stat -c '%U' "$SHARE_PROJECT/s.jsonl")" = "fenix-child-0" ] \
    || fail 'the share changed the file ownership'
[ "$(stat -c '%U %a' "$SHARE_TARGET")" = "root 600" ] \
    || fail "the root-owned symlink target was touched ($(stat -c '%U %a' "$SHARE_TARGET"))"
pass 'share helper widened only the real fenix-child-0 files, root target untouched'

# Refusals — each must exit 2 (the share helper's refusal code) before any
# chmod runs. First /etc: not a supervisor launch dir.
rc=0
run_as_node "sudo -n -u fenix-child-0 $SHARE_HELPER /etc" 2>/dev/null || rc=$?
[ "$rc" = "2" ] || fail "share helper accepted /etc (rc=$rc)"
# A path with ..: refused even though realpath would canonicalize it back to
# the same directory — the lexical argument is never trusted.
rc=0
run_as_node "sudo -n -u fenix-child-0 $SHARE_HELPER $SHARE_DIR/../turn-0" 2>/dev/null || rc=$?
[ "$rc" = "2" ] || fail "share helper accepted a .. path (rc=$rc)"
# A symlinked launch dir: the lexical name matches the run regex, the
# canonical path does not — the realpath check must trip.
# The launch dir is root-created, so this symlink must be made by root —
# a node-run ln -s here cannot create it.
ln -s "$SHARE_DIR" "$SHARE_RUN/launch/dev-evil" || fail 'symlink fixture setup failed'
rc=0
run_as_node "sudo -n -u fenix-child-0 $SHARE_HELPER $SHARE_RUN/launch/dev-evil" 2>/dev/null || rc=$?
[ "$rc" = "2" ] || fail "share helper accepted a symlinked launch dir (rc=$rc)"
# A root run would resurrect the arbitrary-file chmod the runas design exists
# to prevent — refused outright, even on a perfectly valid directory.
rc=0
"$SHARE_HELPER" "$SHARE_DIR" 2>/dev/null || rc=$?
[ "$rc" = "2" ] || fail "share helper accepted a root run (rc=$rc)"
pass 'share helper refuses /etc, .., a symlinked launch dir, and a root run'

rm -rf "$SHARE_RUN" "$SHARE_TARGET"

# ── FOC-878: one pool identity per run — two runs, one container ─────────────
# The accepted design's cross-run probes (§5), driven through the REAL helper
# path (node -> sudo -> helper -> setpriv -> the run's own fenix-child-<n>).
# run-1 above claimed slot 0; two fresh runs claim two different slots, run
# A's child proves from its own uid that nothing of run B's is reachable,
# node — a member of every fenix-run-<n> — keeps every write,
# supervisor-status reports the run identity, and pool exhaustion refuses
# (exit 97) while modifying nothing.
RUN_A=/data/state/supervisor/run-2
RUN_B=/data/state/supervisor/run-3
RUN_C=/data/state/supervisor/run-4
WT_A=/data/workspaces/la-wt/t2
WT_B=/data/workspaces/la-wt/t3
LAUNCH_A=$RUN_A/launch/dev-a/turn-1
LAUNCH_B=$RUN_B/launch/dev-b/turn-1
LAUNCH_C=$RUN_C/launch/dev-c/turn-1
UID_BASE=$(id -u fenix-child-0)
RUN_A_ID=$(basename "$RUN_A")
PATH_LINE='PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

for r in "$RUN_A" "$RUN_B" "$RUN_C"; do
    mkdir -p "$r/children" "$r/gates" "$r/verdicts"
done
mkdir -p "$LAUNCH_A" "$LAUNCH_B" "$LAUNCH_C"
run_as_node 'git -C /data/workspaces/seed-repo worktree add -q -b iso-t2 /data/workspaces/la-wt/t2 \
    && git -C /data/workspaces/seed-repo worktree add -q -b iso-t3 /data/workspaces/la-wt/t3' \
    || fail 'run-2/run-3 worktree setup failed'
chown -R node:node "$RUN_A" "$RUN_B" "$RUN_C"

# Run B's light probe: claims its slot, writes its own surface, records its uid.
cat > "$LAUNCH_B/probe-b.mjs" <<'PROBE_B'
#!/usr/local/bin/node
// FOC-878 probe B — runs as run B's own pool user.
import { appendFileSync, writeFileSync } from "node:fs";
const probeWrite = (path) => {
    try { appendFileSync(path, "x"); return "WRITE_ALLOWED"; } catch (err) { return err.code || String(err); }
};
const out = { uid: process.getuid() };
out.ownGate = probeWrite(process.env.LA_TEST_GATES);
out.ownEdits = probeWrite(process.env.LA_TEST_EDITS);
writeFileSync(process.env.LA_TEST_RESULT, JSON.stringify(out, null, 2));
PROBE_B

# Run A's hostile probe: everything of run B's must be EACCES from A's uid.
cat > "$LAUNCH_A/probe-a.mjs" <<'PROBE_A'
#!/usr/local/bin/node
// FOC-878 probe A — runs as run A's own pool user, reaching for run B.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const probeWrite = (path) => {
    try { appendFileSync(path, "x"); return "WRITE_ALLOWED"; } catch (err) { return err.code || String(err); }
};
const probeRead = (path) => {
    try { readFileSync(path, "utf8"); return "READ_ALLOWED"; } catch (err) { return err.code || String(err); }
};
const out = { uid: process.getuid() };
// Probe 3: the own-run writes a child needs — gate, verdict, edits, worktree.
out.ownGate = probeWrite(process.env.LA_TEST_GATES);
out.ownVerdict = probeWrite(process.env.LA_TEST_VERDICTS);
out.ownEdits = probeWrite(process.env.LA_TEST_EDITS);
out.ownWorktree = probeWrite(process.env.LA_TEST_WORKTREE_FILE);
// Probe 2: run B's gates, verdicts, edits, worktree and kept-alive child.env.
out.crossGate = probeWrite(process.env.LA_TEST_B_GATES);
out.crossVerdict = probeWrite(process.env.LA_TEST_B_VERDICTS);
out.crossEdits = probeWrite(process.env.LA_TEST_B_EDITS);
out.crossWorktree = probeWrite(process.env.LA_TEST_B_WORKTREE_FILE);
out.crossEnv = probeRead(process.env.LA_TEST_B_CHILD_ENV);
writeFileSync(process.env.LA_TEST_RESULT, JSON.stringify(out, null, 2));
PROBE_A
chmod 0755 "$LAUNCH_A/probe-a.mjs" "$LAUNCH_B/probe-b.mjs"
chown -R node:node "$RUN_A" "$RUN_B"

run_as_node "umask 027; printf 'LA_TEST_GATES=$RUN_B/gates/b-probe.json\nLA_TEST_EDITS=$RUN_B/edits.jsonl\nLA_TEST_RESULT=$LAUNCH_B/result-b.json\n$PATH_LINE\n' > $LAUNCH_B/child.env" \
    || fail 'run B env file setup failed'
[ "$(stat -c '%a' "$LAUNCH_B/child.env")" = "640" ] || fail 'run B child.env is not 0640'

# Spawn B FIRST: its surface (subdirs at the run group, edits.jsonl) must
# exist before A's hostile probe reaches for it.
run_as_node "sudo -n $HELPER $LAUNCH_B/child.env $WT_B $LAUNCH_B -- $LAUNCH_B/probe-b.mjs" \
    || fail 'run B spawn through the helper failed'
RESULT_B=$(cat "$LAUNCH_B/result-b.json")

# B's kept-alive env file for the read probe: a second-turn env file exactly
# as the watcher writes it (node-owned 0640) that no spawn consumes.
run_as_node "umask 0002; mkdir -p $RUN_B/launch/dev-b/turn-2 && umask 027; printf 'KEPT=1\n$PATH_LINE\n' > $RUN_B/launch/dev-b/turn-2/child.env" \
    || fail 'run B kept-alive env setup failed'

run_as_node "umask 027; printf 'LA_TEST_GATES=$RUN_A/gates/a-probe.json\nLA_TEST_VERDICTS=$RUN_A/verdicts/a-probe.json\nLA_TEST_EDITS=$RUN_A/edits.jsonl\nLA_TEST_WORKTREE_FILE=$WT_A/probe-a.txt\nLA_TEST_B_GATES=$RUN_B/gates/cross-probe.json\nLA_TEST_B_VERDICTS=$RUN_B/verdicts/cross-probe.json\nLA_TEST_B_EDITS=$RUN_B/edits.jsonl\nLA_TEST_B_WORKTREE_FILE=$WT_B/cross-probe.txt\nLA_TEST_B_CHILD_ENV=$RUN_B/launch/dev-b/turn-2/child.env\nLA_TEST_RESULT=$LAUNCH_A/result-a.json\n$PATH_LINE\n' > $LAUNCH_A/child.env" \
    || fail 'run A env file setup failed'
[ "$(stat -c '%a' "$LAUNCH_A/child.env")" = "640" ] || fail 'run A child.env is not 0640'
run_as_node "sudo -n $HELPER $LAUNCH_A/child.env $WT_A $LAUNCH_A -- $LAUNCH_A/probe-a.mjs" \
    || fail 'run A spawn through the helper failed'
RESULT_A=$(cat "$LAUNCH_A/result-a.json")

SLOT_A=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_A/identity.json','utf8')).slot")
SLOT_B=$(node -p "JSON.parse(require('fs').readFileSync('$RUN_B/identity.json','utf8')).slot")

# ── FOC-878 assertions: slots, cross-run EACCES, own-run writes ──────────────
node -e '
const a = JSON.parse(process.argv[1]);
const b = JSON.parse(process.argv[2]);
const slotA = Number(process.argv[3]);
const slotB = Number(process.argv[4]);
const uidBase = Number(process.argv[5]);
const checks = [
  ["run A child runs its slot uid", a.uid, uidBase + slotA],
  ["run B child runs its slot uid", b.uid, uidBase + slotB],
  ["the two runs hold different slots", slotA < slotB || slotB < slotA, true],
  ["A writes its own gate", a.ownGate, "WRITE_ALLOWED"],
  ["A writes its own verdict", a.ownVerdict, "WRITE_ALLOWED"],
  ["A appends its own edits.jsonl", a.ownEdits, "WRITE_ALLOWED"],
  ["A creates a file in its own worktree", a.ownWorktree, "WRITE_ALLOWED"],
  ["A cannot write B gate", a.crossGate, "EACCES"],
  ["A cannot write B verdict", a.crossVerdict, "EACCES"],
  ["A cannot append B edits.jsonl", a.crossEdits, "EACCES"],
  ["A cannot create a file in B worktree", a.crossWorktree, "EACCES"],
  ["A cannot read B child.env", a.crossEnv, "EACCES"],
  ["B writes its own gate", b.ownGate, "WRITE_ALLOWED"],
  ["B appends its own edits.jsonl", b.ownEdits, "WRITE_ALLOWED"],
];
let rc = 0;
for (const [name, got, want] of checks) {
  const ok = String(got) === String(want);
  if (ok) { console.log(`PASS ${name}`); continue; }
  console.log(`FAIL ${name}: expected ${want}, got ${got}`);
  rc = 1;
}
process.exit(rc);
' "$RESULT_A" "$RESULT_B" "$SLOT_A" "$SLOT_B" "$UID_BASE" || fail 'FOC-878 cross-run assertions failed'

# The helper's own surface claims, read back from the tree.
[ "$(stat -c '%U:%G %a' "$RUN_A/children")" = "node:fenix-run-$SLOT_A 2770" ] \
    || fail "run A children dir is not node:fenix-run-$SLOT_A 2770 ($(stat -c '%U:%G %a' "$RUN_A/children"))"
[ "$(stat -c '%U:%G %a' "$RUN_A/edits.jsonl")" = "node:fenix-run-$SLOT_A 660" ] \
    || fail "run A edits.jsonl is not node:fenix-run-$SLOT_A 0660 ($(stat -c '%U:%G %a' "$RUN_A/edits.jsonl"))"
[ "$(stat -c '%U:%G' "$WT_A")" = "fenix-child-$SLOT_A:fenix-run-$SLOT_A" ] \
    || fail "run A worktree is not owned by its pool identity ($(stat -c '%U:%G' "$WT_A"))"
[ "$(stat -c '%U:%G' "$RUN_A/identity.json")" = "root:root" ] || fail 'identity.json is not root:root'
[ "$(stat -c '%a' "$RUN_A/identity.json")" = "644" ] || fail 'identity.json is not 0644'
pass "two runs hold different pool slots ($SLOT_A vs $SLOT_B); cross-run writes and reads are EACCES"

# Probe 4: node keeps every write — into both runs' subdirs and worktrees.
run_as_node "printf x >> $RUN_A/gates/node-probe.json && printf x >> $RUN_B/gates/node-probe.json && printf x >> $RUN_A/verdicts/node-probe.json && printf x >> $RUN_B/verdicts/node-probe.json && printf x >> $RUN_A/edits.jsonl && printf x >> $RUN_B/edits.jsonl && touch $WT_A/node-probe.txt && touch $WT_B/node-probe.txt" \
    || fail 'node lost a write into a run surface (probe 4)'
pass 'node still writes into both runs: subdirs, edits.jsonl, worktrees'

# §5: supervisor-status reports the run's identity on its parseable channels —
# the run-level `identity` JSON field and the container-only stderr line. The
# state home is the container's, and FENIX_IN_CONTAINER gates the note on.
rc=0
stat_out=$(run_as_node "LA_SUPERVISOR_STATE_HOME=/data/state/supervisor FENIX_IN_CONTAINER=1 node $SRC/scripts/supervisor-status.mjs --run $RUN_A_ID 2>&1 1>/dev/null") || rc=$?
[ "$rc" = "0" ] || fail "supervisor-status failed on the lane fixture (rc=$rc): $stat_out"
printf '%s\n' "$stat_out" | grep -q "identity: fenix-child-$SLOT_A (slot $SLOT_A)" \
    || fail "supervisor-status stderr did not report the run identity: $stat_out"
pass "supervisor-status reports the run identity (fenix-child-$SLOT_A, slot $SLOT_A)"

# Probe 5: pool exhaustion refuses and leaves NOTHING modified — a fresh run
# with FENIX_CHILD_POOL=1 cannot get a slot (slot 0 of the shrunk pool is
# held), the refusal is exit 97 with the identity-pool-exhausted reason, and
# neither the fresh run's dirs nor the reused worktree argument changed.
run_as_node "umask 027; printf 'LA_TEST_REFUSAL=1\n$PATH_LINE\n' > $LAUNCH_C/child.env" \
    || fail 'run C env file setup failed'
# The surface snapshot the refusal must leave untouched (the dirs carry the
# setgid bit from the state home — compare against what is there, not a
# hand-picked mode).
RUN_C_BEFORE=$(stat -c '%U %G %a' "$RUN_C/children")
rc=0
exh=$(run_as_node "env FENIX_CHILD_POOL=1 sudo -n $HELPER $LAUNCH_C/child.env $WT_A $LAUNCH_C -- $LAUNCH_A/probe-a.mjs" 2>&1) || rc=$?
[ "$rc" = "97" ] || fail "pool exhaustion was not a refusal 97 (rc=$rc): $exh"
printf '%s\n' "$exh" | grep -q 'identity-pool-exhausted' || fail "the refusal did not name identity-pool-exhausted: $exh"
[ ! -e "$RUN_C/identity.json" ] || fail 'the exhaustion refusal left an identity.json behind'
[ ! -e "$RUN_C/edits.jsonl" ] || fail 'the exhaustion refusal created edits.jsonl'
[ "$(stat -c '%U %G %a' "$RUN_C/children")" = "$RUN_C_BEFORE" ] \
    || fail "the exhaustion refusal modified run C ($(stat -c '%U %G %a' "$RUN_C/children") was $RUN_C_BEFORE)"
[ "$(stat -c %U "$WT_A")" = "fenix-child-$SLOT_A" ] \
    || fail 'the exhaustion refusal touched the worktree argument'
pass 'pool exhaustion refuses (exit 97, identity-pool-exhausted) and modifies nothing'

# FOC-1001/988: production node processes run with HOME=/home/node; this lane's
# root shell has HOME=/root, which node cannot read (git would warn about it).
as_node_home() {
    run_as_node "export HOME=/home/node; $1"
}

# ── FOC-1001: the Supervisor reads a child-owned worktree without trusting it ─
# By now the worktree and its per-worktree gitdir belong to fenix-child-0 (the
# real handover). git run there as node stops at "dubious ownership"; the
# workaround the Supervisor used on the FOC-789 run — a safe.directory — lets
# whatever the child planted run as node. The scripts read such a tree through
# supervisor-lib's one-shot, sanitised invocation instead.
WT_GITDIR=/data/workspaces/seed-repo/.git/worktrees/t1
[ "$(stat -c %U "$WORKTREE")" = "fenix-child-0" ] || fail "the worktree is not child-owned ($(stat -c %U "$WORKTREE")) — the handover precondition is gone"
[ -d "$WT_GITDIR" ] || fail "no per-worktree gitdir at $WT_GITDIR"
rc=0
out=$(as_node_home "git -C $WORKTREE status --porcelain 2>&1") || rc=$?
[ "$rc" != "0" ] && printf '%s' "$out" | grep -q 'dubious ownership' \
    || fail "plain git in a child-owned worktree did not stop at dubious ownership (rc=$rc): $out"
pass 'plain git in a child-owned worktree stops at dubious ownership'

# What a hostile child plants: a command in the per-worktree config. It is only
# read when the repository enables extensions.worktreeConfig, so enable it —
# the worst case — and make the planted file the child's.
as_node_home 'git -C /data/workspaces/seed-repo config extensions.worktreeConfig true' || fail 'could not enable extensions.worktreeConfig'
printf '[core]\n\tfsmonitor = "echo planted > /tmp/iso-fsmonitor; true"\n' > "$WT_GITDIR/config.worktree"
chown fenix-child-0:fenix-run-0 "$WT_GITDIR/config.worktree"

# Control: trusting the tree by hand (what the Supervisor did) runs the plant.
rm -f /tmp/iso-fsmonitor
as_node_home "git -c safe.directory=$WORKTREE -C $WORKTREE status --porcelain >/dev/null 2>&1" || true
if [ -f /tmp/iso-fsmonitor ]; then
    pass 'control: safe.directory alone executes the child-planted core.fsmonitor as node (the hazard is real)'
else
    printf 'INFO control: this git did not run the planted fsmonitor — the sanctioned path is asserted below regardless\n'
fi
rm -f /tmp/iso-fsmonitor

# The sanctioned path: supervisor-lib's git() — safe.directory for this call and
# this tree only, hooks and fsmonitor off. It must read the tree and run nothing.
rc=0
head=$(as_node_home "node --input-type=module -e \"import { git } from '/opt/fenix/scripts/supervisor-lib.mjs'; process.stdout.write(git(['rev-parse', 'HEAD'], '$WORKTREE'))\"") || rc=$?
[ "$rc" = "0" ] && [ "${#head}" = "40" ] || fail "supervisor-lib git() could not read the child-owned worktree (rc=$rc): $head"
rc=0
as_node_home "node --input-type=module -e \"import { git, dirtyTreeReport } from '/opt/fenix/scripts/supervisor-lib.mjs'; git(['status', '--porcelain'], '$WORKTREE'); const d = dirtyTreeReport('$WORKTREE'); if (d.some((l) => l.startsWith('<git status failed'))) { console.error(d.join('\n')); process.exit(3); }\"" || rc=$?
[ "$rc" = "0" ] || fail "status / dirtyTreeReport through the sanctioned path failed (rc=$rc)"
[ ! -f /tmp/iso-fsmonitor ] || fail 'the sanctioned read EXECUTED the child-planted core.fsmonitor'
pass 'supervisor-lib reads the child-owned worktree (rev-parse, status, dirtyTreeReport) and runs nothing the child planted'

# `fenix cleanup` and the Supervisor's cleanup tool find the main checkout from a child's tree: the
# first entry of `git worktree list`. It is a read, so it takes the same one-shot form (rc.5 VM walk:
# without it the default repo resolution died on "dubious ownership").
rc=0
main=$(as_node_home "node --input-type=module -e \"import { listWorktrees } from '/opt/fenix/scripts/supervisor-lib.mjs'; process.stdout.write(listWorktrees('$WORKTREE')[0].path)\"") || rc=$?
[ "$rc" = "0" ] && [ "$main" = "/data/workspaces/seed-repo" ] || fail "listWorktrees from the child-owned worktree did not resolve the main checkout (rc=$rc): $main"
[ ! -f /tmp/iso-fsmonitor ] || fail 'listWorktrees EXECUTED the child-planted core.fsmonitor'
pass 'listWorktrees from a child-owned worktree resolves the main checkout, running nothing the child planted'

rc=0
trusted=$(as_node_home 'git config --global --get-all safe.directory 2>&1') || rc=$?
[ "$rc" != "0" ] && [ -z "$trusted" ] || fail "a persistent safe.directory exists after the reads: $trusted"
pass 'no safe.directory was written anywhere by the reads'

# The Supervisor's own Bash hook, in the real image: both boundary classes ask.
hook() { printf '%s' "$1" | FENIX_IN_CONTAINER=1 LA_ROOT=/opt/fenix LA_WORKTREE_HOME=/data/workspaces/la-wt node /opt/fenix/scripts/supervisor-ask-guard.mjs; }
hook "{\"tool_name\":\"Bash\",\"cwd\":\"/data/workspaces\",\"tool_input\":{\"command\":\"git config --global --add safe.directory $WORKTREE\"}}" | grep -q 'FOC-1001: git safe.directory' \
    || fail 'the guard did not ask for git config safe.directory'
hook "{\"tool_name\":\"Bash\",\"cwd\":\"/data/workspaces\",\"tool_input\":{\"command\":\"git -C $WORKTREE push -u origin iso-t1\"}}" | grep -q 'FOC-1001: git in a child worktree' \
    || fail 'the guard did not ask for git inside a child worktree'
[ -z "$(hook '{"tool_name":"Bash","cwd":"/data/workspaces","tool_input":{"command":"git -C /data/workspaces/seed-repo log --oneline"}}')" ] \
    || fail 'the guard spoke for git in the main checkout'
pass 'the ask guard raises FOC-1001 for safe.directory and for git in a child worktree, and stays silent for the main checkout'

# ── FOC-988: Fenix's own code — the guard asks, the manifest detects ─────────
hook "{\"tool_name\":\"Bash\",\"cwd\":\"/data/workspaces\",\"tool_input\":{\"command\":\"sed -i s/a/b/ /opt/fenix/scripts/supervisor-spawn.mjs\"}}" | grep -q "FOC-988: write to Fenix's own code" \
    || fail 'the guard did not ask for a Bash write into /opt/fenix'
pass 'the ask guard raises FOC-988 for a Bash write into /opt/fenix'

MANIFEST=/usr/local/share/fenix/manifest.json
[ -f "$MANIFEST" ] || fail "no $MANIFEST in the image — the drift check has nothing to compare with"
[ "$(stat -c '%U:%a' "$MANIFEST")" = "root:444" ] || fail "the manifest is not root:0444 ($(stat -c '%U:%a' "$MANIFEST"))"
as_node_home "test ! -w $(dirname "$MANIFEST") && test ! -w $MANIFEST" || fail 'the runtime user can write the manifest or its directory'
pass 'the image manifest is root-owned and not writable by the runtime user'

# On a fresh image (and on the thin uid layer — content hashes only) it is clean.
rc=0
out=$(as_node_home 'node /opt/fenix/scripts/fenix-manifest.mjs check 2>&1') || rc=$?
[ "$rc" = "0" ] || fail "a fresh image does not match its own manifest (rc=$rc): $out"
pass 'fenix-manifest check is clean on the fresh image'

# The tree is writable by design (Edit/Write are denied and Bash asks, the
# filesystem is not the control) — so a patch made anyway must be DETECTED.
as_node_home 'printf "\n// patched at runtime\n" >> /opt/fenix/scripts/supervisor-spawn.mjs' || fail 'could not simulate a runtime patch'
rc=0
out=$(as_node_home 'node /opt/fenix/scripts/fenix-manifest.mjs check 2>&1') || rc=$?
[ "$rc" = "1" ] && printf '%s' "$out" | grep -q 'modified  scripts/supervisor-spawn.mjs' \
    || fail "a patched file was not reported (rc=$rc): $out"
doctor=$(as_node_home 'cd /opt/fenix && node scripts/fenix-doctor.mjs --json 2>/dev/null' || true)
printf '%s' "$doctor" | node -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => { const c = JSON.parse(s).checks.find((x) => x.name === "fenix code"); process.exit(c && c.status === "fail" && /supervisor-spawn\.mjs \(modified\)/.test(c.detail) ? 0 : 1); });' \
    || fail "fenix doctor did not report the patched file: $doctor"
pass 'a runtime patch to /opt/fenix is reported by fenix-manifest check and by fenix doctor'

printf 'FOC-802 isolation lane: ALL GREEN\n'