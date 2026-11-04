#!/bin/sh
# Lint and the full test suite on Linux, inside the Fenix image (FOC-774).
#   docker run --rm -v <checkout>:/src:ro -v <scratch>/candidate.tar:/src.tar:ro \
#     -e FENIX_TEST_ARCHIVE=/src.tar fenix:dev sh /src/docker/test-in-container.sh [test-all args]
# Tests need a real git repository (dev-branch, supervisor-cleanup) and must
# never write into the host tree, so they run in a throwaway copy of the tree.
# Preferred input (FOC-1238): the host archived HEAD with `git archive` and
# mounted the tarball read-only — FENIX_TEST_ARCHIVE names its container path
# (`fenix test` does this). The tested tree is then exactly the committed
# candidate (FOC-1222): no write hitting the checkout while the gate runs can
# change what is tested. Without the tarball, a readable git repository is
# cloned with its uncommitted changes laid on top; a linked worktree cannot be
# cloned from inside the container (its .git points at a host path) and is
# tar-snapshotted instead — safe only while nothing writes into the checkout.
set -eu

SRC="${FENIX_TEST_SRC:-/src}"
WORK="$(mktemp -d /tmp/fenix-test.XXXXXX)"

git config --global --add safe.directory '*'
git config --global user.email fenix-test@example.invalid
git config --global user.name fenix-test

if [ -n "${FENIX_TEST_ARCHIVE:-}" ]; then
  # FOC-1238: the host handed over the committed candidate as a tarball
  # (git archive HEAD, mounted read-only). Extract it as the throwaway
  # repository — the tested tree is exactly HEAD.
  tar -xf "$FENIX_TEST_ARCHIVE" -C "$WORK"
  git -C "$WORK" init -q
  git -C "$WORK" add -A
  git -C "$WORK" commit -qm "fenix test snapshot"
elif git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  git clone -q "$SRC" "$WORK"
  # Uncommitted work: copy modified and untracked (not ignored) files, drop deleted ones.
  (cd "$SRC" && git ls-files -z -m -o --exclude-standard | tar --null --ignore-failed-read -T - -cf -) | tar -C "$WORK" -xf -
  (cd "$SRC" && git ls-files -z -d) | (cd "$WORK" && xargs -0 -r rm -f --)
else
  # A linked worktree (its .git points at a host path the container cannot see)
  # or no git at all: snapshot the tree and make it a repository of its own.
  echo "INFO $SRC is not a readable git repository here (linked worktree?) — testing a snapshot"
  tar -C "$SRC" --exclude=.git --exclude=node_modules --exclude=./ui/dist --exclude=./.codegraph \
    --exclude=./.cache --exclude=./.state --exclude=./.fenix --exclude=./.claude/worktrees \
    --exclude=./coverage --exclude=./tmp --exclude=__pycache__ -cf - . | tar -C "$WORK" -xf -
  git -C "$WORK" init -q
  git -C "$WORK" add -A
  git -C "$WORK" commit -qm "fenix test snapshot"
fi

cd "$WORK"
# The image's node_modules is linked in below; .gitignore's `node_modules/`
# matches directories only, so hide the symlink from git (and from the
# scanners that list files through git) in this throwaway copy.
echo "node_modules" >> .git/info/exclude
if cmp -s package-lock.json /opt/fenix/package-lock.json; then
  ln -s /opt/fenix/node_modules node_modules
else
  echo "WARN the image's dependencies differ from this checkout — installing; rebuild the image (fenix update) to skip this"
  npm ci --no-audit --no-fund
fi

# The image points these at the /data volume; the suite must use its own temp state.
# The list lives in scripts/test-runtime-env.json (FOC-990) — scripts/test-run.mjs
# strips the same one, so a child running the suite directly matches CI. A plain
# assignment, so `set -e` stops the script if the list cannot be read.
runtime_env="$(node -p "JSON.parse(require('fs').readFileSync('scripts/test-runtime-env.json','utf8')).unset.join(' ')")"
# shellcheck disable=SC2086
unset $runtime_env
export LA_ROOT="$WORK"

rc=0
node scripts/lint.mjs || rc=1
# The generated index block must match docs/state/ (FOC-1224) — CI holds the
# line so a journal that lands without a regen fails the lint job.
node scripts/state-index.mjs --check || rc=1
node scripts/test-all.mjs "$@" || rc=1
exit "$rc"
