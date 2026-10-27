// scripts/fenix-keys.test.mjs — the `fenix keys` wizard regression (M5):
// the provider choice is staged in memory and the settings overlay is written
// only AFTER the candidate key passed its check — a failed or cancelled
// wizard leaves the previous settings and secrets untouched.
//
// Integration, not unit: the REAL fenix launcher runs (copied into a temp
// dir) against a fake `docker` shim on PATH. The shim records invocations,
// runs the real in-repo scripts (fenix-settings.mjs, provider-resolve.mjs)
// with node, and answers key-check.mjs with a canned JSON line — no network,
// no containers, no real credentials. Shell syntax of the launcher is pinned
// by `sh -n` on the same copy.
//
// Run: node --test scripts/fenix-keys.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FENIX_SRC = join(REPO_ROOT, "fenix");

/** Git Bash's sh on Windows, /bin/sh elsewhere. */
function findSh() {
  if (process.platform !== "win32") return "/bin/sh";
  const probe = spawnSync("sh", ["-c", "exit 0"], { windowsHide: true });
  if (!probe.error) return "sh";
  const gitSh = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
  assert.ok(existsSync(gitSh), "no sh on PATH and no Git Bash sh found");
  return gitSh;
}

/** Windows paths into the sh world: forward slashes, no backslashes. */
function shPath(p) {
  return p.replace(/\\/g, "/");
}

const FAKE_DOCKER = `#!/bin/sh
# Fake docker for fenix-keys.test.mjs — records the invocation, runs the real
# in-repo scripts with node, answers the live key check with a canned line
# (no network). The key arrives on stdin and is consumed, never echoed.
printf '%s\\n' "docker $*" >> "\$FENIX_SHIM_LOG"
case " \$* " in
  *" image inspect "*) exit 0 ;;
  # FOC-777: the image pre-steps of fenix up (pull / compose build / the thin uid layer build) are no-ops here — the tests are about keys and prompts, not images.
  *" pull "*) exit 0 ;;
  *" compose build"*) exit 0 ;;
  " build "*) exit 0 ;;
  *" info "*) exit 0 ;;
  *" compose version "*) exit 0 ;;
  *" up "*) printf 'fake docker: refusing to start the stack\\n' >&2; exit 1 ;;
esac
script=""
idx=0
i=0
for a in "\$@"; do
  case "\$a" in
    /opt/fenix/*) script="\$a"; idx=\$i; break ;;
  esac
  i=\$((i + 1))
done
if [ -z "\$script" ]; then
  printf 'fake docker: unexpected invocation: %s\\n' "\$*" >&2
  exit 1
fi
shift \$((idx + 1))
case "\$script" in
  *fenix-settings.mjs)
    if [ "\$1" = "set" ] && [ "\$FENIX_FAKE_SETTINGS_FAIL" = "1" ]; then exit 1; fi
    if [ "\$1" = "set" ] && [ -n "\${FENIX_FAKE_SETTINGS_RC:-}" ]; then
      printf 'settings saved (canned)\\n'
      exit "\$FENIX_FAKE_SETTINGS_RC"
    fi
    ;;
  *fenix-integrations.mjs)
    if [ -n "\${FENIX_FAKE_INTEGRATIONS_RC:-}" ]; then
      printf 'atlas=on\\npisi=off\\nmemory=off\\nsource=default\\n'
      exit "\$FENIX_FAKE_INTEGRATIONS_RC"
    fi
    ;;
  *fenix-retention.mjs)
    # Canned: the launcher tests assert the FORWARDING and the exit-code
    # pass-through, not the node CLI itself (owned by the FOC-780 node work).
    printf '{"canned": true}\\n'
    exit "\${FENIX_FAKE_RETENTION_EXIT:-0}" ;;
  *key-check.mjs)
    key=\$(cat 2>/dev/null) || key=""
    if [ -n "\${FENIX_FAKE_REJECT_KEY:-}" ] && [ "\$key" = "\$FENIX_FAKE_REJECT_KEY" ]; then
      printf '{"ok":false,"reason":"key rejected (HTTP 401)"}\\n'
      exit 0
    fi
    if [ "\${FENIX_FAKE_CHECK:-ok}" = "reject" ]; then
      printf '{"ok":false,"reason":"key rejected (HTTP 401)"}\\n'
    else
      printf '{"ok":true,"reason":"key accepted (HTTP 200)"}\\n'
    fi
    exit 0
    ;;
esac
exec node "\$FENIX_REPO_ROOT/\${script#/opt/fenix/}" "\$@"
`;

function makeHome(name) {
  const dir = mkdtempSync(join(tmpdir(), `fenix-keys-${name}-`));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, { encoding: "utf8", mode: 0o755 });
  // Copy the REAL launcher (normalize line endings for sh) so nothing in the
  // test touches the repo's own .fenix directory.
  writeFileSync(join(dir, "fenix"), readFileSync(FENIX_SRC, "utf8").replace(/\r\n/g, "\n"), "utf8");
  return { dir, bin };
}

function writeSettingsFile(dir, settings) {
  const path = join(dir, "settings.json");
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return path;
}

function readSettingsFile(dir) {
  return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
}

function keyCheckCalls(dir) {
  const log = readFileSync(join(dir, "shim.log"), "utf8");
  return log
    .split("\n")
    .filter((l) => l.includes("key-check.mjs"))
    .map((l) => l.slice("docker ".length));
}

/**
 * Runs the real fenix launcher (`fenix keys`) in the temp home with the fake
 * docker shim; `input` are the prompt answers, one per line.
 */
function runKeysWizard({ home, bin, settingsPath, input, fakeCheck, rejectKey, failSettings }) {
  const inputPath = join(home, "input.txt");
  writeFileSync(inputPath, `${input.join("\n")}\n`, "utf8");
  const shimLog = join(home, "shim.log");
  writeFileSync(shimLog, "", "utf8");
  const env = {
    ...process.env,
    PATH: `${shPath(bin)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    LA_SETTINGS_FILE: shPath(settingsPath),
    FENIX_REPO_ROOT: shPath(REPO_ROOT),
    FENIX_SHIM_LOG: shPath(shimLog),
    ...(fakeCheck ? { FENIX_FAKE_CHECK: fakeCheck } : {}),
    ...(failSettings ? { FENIX_FAKE_SETTINGS_FAIL: "1" } : {}),
    ...(rejectKey ? { FENIX_FAKE_REJECT_KEY: rejectKey } : {}),
  };
  const res = spawnSync(findSh(), [shPath(join(home, "fenix")), "keys"], {
    env,
    input: input.join("\n") + "\n",
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
  });
  return res;
}

const OPENROUTER_SETTINGS = { provider: { active: "openrouter", custom: null }, routing: {} };
const CANDIDATE_URL = "https://candidate.example/api";

/**
 * Runs the real fenix launcher with arbitrary arguments (non-interactive
 * commands like `fenix integrations`, retention forwarding, the `up`
 * first-run flow) in the temp home with the fake docker shim. `input` is
 * forwarded on stdin (piped stdin = the non-interactive flows);
 * `LA_SETTINGS_FILE` is set only when `settingsPath` is given.
 */
function runFenix({ home, bin, args, settingsPath, input = "", extraEnv = {} }) {
  const shimLog = join(home, "shim.log");
  writeFileSync(shimLog, "", "utf8");
  const env = {
    ...process.env,
    PATH: `${shPath(bin)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    FENIX_REPO_ROOT: shPath(REPO_ROOT),
    FENIX_SHIM_LOG: shPath(shimLog),
    ...(settingsPath ? { LA_SETTINGS_FILE: shPath(settingsPath) } : {}),
    ...extraEnv,
  };
  return spawnSync(findSh(), [shPath(join(home, "fenix")), ...args], {
    env,
    input,
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
  });
}

/** `docker compose run ...` lines for one script, from the shim log. */
function forwardCalls(dir, scriptName) {
  return readFileSync(join(dir, "shim.log"), "utf8")
    .split("\n")
    .filter((l) => l.includes(scriptName));
}
test("fenix launcher passes `sh -n` (syntax check)", () => {
  const res = spawnSync(findSh(), ["-n", FENIX_SRC], { encoding: "utf8", windowsHide: true });
  assert.equal(res.status, 0, `sh -n fenix failed: ${res.stderr}`);
});

test("M5 custom wizard: rejected key attempts leave the previous provider untouched", () => {
  const { dir, bin } = makeHome("reject-custom");
  try {
    const settingsPath = writeSettingsFile(dir, OPENROUTER_SETTINGS);
    const res = runKeysWizard({
      home: dir,
      bin,
      settingsPath,
      input: ["custom", CANDIDATE_URL, "token", "model-candidate", "bad-key-1", "bad-key-2", "bad-key-3"],
      fakeCheck: "reject",
    });
    assert.equal(res.status, 5, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /rejected: key rejected/);
    // The overlay was NOT touched: previous provider still active, no custom block.
    const settings = readSettingsFile(dir);
    assert.equal(settings.provider.active, "openrouter");
    assert.equal(settings.provider.custom, null);
    // Every check ran against the CANDIDATE (staged), three attempts total.
    const calls = keyCheckCalls(dir);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.ok(call.includes(`--base-url ${CANDIDATE_URL}`), call);
      assert.ok(call.includes("--auth-style token"), call);
      assert.ok(call.includes("--model model-candidate"), call);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M5 builtin provider: rejected key attempts leave provider.active alone", () => {
  const { dir, bin } = makeHome("reject-builtin");
  try {
    const settingsPath = writeSettingsFile(dir, OPENROUTER_SETTINGS);
    const res = runKeysWizard({
      home: dir,
      bin,
      settingsPath,
      input: ["nebul", "bad-key-1", "bad-key-2", "bad-key-3"],
      fakeCheck: "reject",
    });
    assert.equal(res.status, 5, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const settings = readSettingsFile(dir);
    assert.equal(settings.provider.active, "openrouter");
    const calls = keyCheckCalls(dir);
    assert.equal(calls.length, 3);
    for (const call of calls) assert.ok(call.includes("--provider nebul"), call);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M5 successful custom wizard writes the staged provider only after the check", () => {
  const { dir, bin } = makeHome("ok-custom");
  try {
    const settingsPath = writeSettingsFile(dir, OPENROUTER_SETTINGS);
    const res = runKeysWizard({
      home: dir,
      bin,
      settingsPath,
      input: [
        "custom",
        CANDIDATE_URL,
        "apikey",
        "model-candidate",
        "fixture-provider-key",
        "fixture-linear-key",
        "fixture-github-token",
        "FOC",
      ],
    });
    assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const settings = readSettingsFile(dir);
    assert.equal(settings.provider.active, "custom");
    assert.deepEqual(settings.provider.custom, {
      baseUrl: CANDIDATE_URL,
      authStyle: "apikey",
      keyName: "PROVIDER_API_KEY",
      tiers: {},
      defaultModel: "model-candidate",
    });
    // The secret was stored, and the check ran against the candidate config.
    assert.equal(
      readFileSync(join(dir, ".fenix", "secrets", "provider_api_key"), "utf8").trim(),
      "fixture-provider-key",
    );
    const calls = keyCheckCalls(dir);
    assert.ok(calls.length >= 1);
    const providerCall = calls.find((c) => c.includes("--base-url"));
    assert.ok(providerCall, calls.join("\n"));
    assert.ok(providerCall.includes(`--base-url ${CANDIDATE_URL}`), providerCall);
    assert.ok(providerCall.includes("--auth-style apikey"), providerCall);
    assert.ok(providerCall.includes("--model model-candidate"), providerCall);
    // The wizard ran to the end: team key recorded in fenix.env.
    assert.match(readFileSync(join(dir, ".fenix", "fenix.env"), "utf8"), /^LINEAR_TEAM_KEY=FOC$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M5 kept stored key must validate against the candidate, not the old provider", () => {
  const { dir, bin } = makeHome("stored-key");
  try {
    const settingsPath = writeSettingsFile(dir, OPENROUTER_SETTINGS);
    const secretsDir = join(dir, ".fenix", "secrets");
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(join(secretsDir, "provider_api_key"), "old-provider-key\n", "utf8");
    const res = runKeysWizard({
      home: dir,
      bin,
      settingsPath,
      input: [
        "custom",
        CANDIDATE_URL,
        "apikey",
        "model-candidate",
        // The overwrite prompt: keep the stored key...
        "n",
        // ...the stored key fails the CANDIDATE check, so a new key is asked.
        "new-provider-key",
        "fixture-linear-key",
        "fixture-github-token",
        "FOC",
      ],
      rejectKey: "old-provider-key",
    });
    assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /does not work with this choice/);
    assert.equal(
      readFileSync(join(dir, ".fenix", "secrets", "provider_api_key"), "utf8").trim(),
      "new-provider-key",
    );
    const settings = readSettingsFile(dir);
    assert.equal(settings.provider.active, "custom");
    assert.equal(settings.provider.custom.authStyle, "apikey");
    // Two provider checks ran (stored key, then the new one), both against
    // the candidate — never the old provider. The rest are linear/github/team.
    const calls = keyCheckCalls(dir).filter((c) => c.includes("--base-url"));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(call.includes(`--base-url ${CANDIDATE_URL}`), call);
      assert.ok(call.includes("--model model-candidate"), call);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M5 successful builtin switch: provider.active changes only after the check", () => {
  const { dir, bin } = makeHome("ok-builtin");
  try {
    const settingsPath = writeSettingsFile(dir, OPENROUTER_SETTINGS);
    const res = runKeysWizard({
      home: dir,
      bin,
      settingsPath,
      input: [
        "nebul",
        "fixture-provider-key",
        "fixture-linear-key",
        "fixture-github-token",
        "FOC",
      ],
    });
    assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const settings = readSettingsFile(dir);
    assert.equal(settings.provider.active, "nebul");
    const calls = keyCheckCalls(dir);
    assert.ok(calls.some((c) => c.includes("--provider nebul")), calls.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("provider wizard restores the old key when the overlay cannot be saved", () => {
  const { dir, bin } = makeHome("settings-write-failure");
  try {
    const settingsPath = writeSettingsFile(dir, OPENROUTER_SETTINGS);
    const secretsDir = join(dir, ".fenix", "secrets");
    mkdirSync(secretsDir, { recursive: true });
    const keyPath = join(secretsDir, "provider_api_key");
    writeFileSync(keyPath, "previous-provider-key\n");
    const res = runKeysWizard({home: dir, bin, settingsPath, failSettings: true,
      input: ["custom", CANDIDATE_URL, "token", "model-candidate", "y", "candidate-key"]});
    assert.equal(res.status, 1, res.stderr);
    assert.deepEqual(readSettingsFile(dir), OPENROUTER_SETTINGS);
    assert.equal(readFileSync(keyPath, "utf8").trim(), "previous-provider-key");
    assert.match(res.stderr, /restored/i);
    assert.equal((res.stdout + res.stderr).includes("candidate-key"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- fenix integrations (FOC-772) -------------------------------------------

function dockerCalls(dir) {
  // The shim also logs the launcher's image pre-steps: the `docker image
  // inspect` probe and, since FOC-777, the `fenix up` pre-steps (`pull`,
  // `compose build`, the thin uid layer `build`) — only the actual
  // in-container node invocations matter here.
  return readFileSync(join(dir, "shim.log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .filter((l) => !l.includes(" image inspect "))
    .filter((l) => !/^docker (pull|compose build|build)/.test(l));
}

test("fenix integrations (show) forwards to the node CLI and passes the exit code through", () => {
  const { dir, bin } = makeHome("integrations-show");
  try {
    const res = runFenix({
      home: dir,
      bin,
      args: ["integrations"],
      extraEnv: { FENIX_FAKE_INTEGRATIONS_RC: "0" },
    });
    assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const calls = dockerCalls(dir);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("/opt/fenix/scripts/fenix-integrations.mjs show"), calls[0]);
    assert.match(res.stdout, /atlas=on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fenix integrations enable atlas forwards the settings set with the right JSON", () => {
  const { dir, bin } = makeHome("integrations-enable");
  try {
    const res = runFenix({
      home: dir,
      bin,
      args: ["integrations", "enable", "atlas"],
      extraEnv: { FENIX_FAKE_SETTINGS_RC: "0" },
    });
    assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const calls = dockerCalls(dir);
    assert.equal(calls.length, 1);
    assert.ok(
      calls[0].includes('/opt/fenix/scripts/fenix-settings.mjs set integrations {"atlas":true}'),
      calls[0],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fenix integrations enable nebul exits 2 with the hint and runs nothing", () => {
  const { dir, bin } = makeHome("integrations-nebul");
  try {
    const res = runFenix({ home: dir, bin, args: ["integrations", "enable", "nebul"] });
    assert.equal(res.status, 2, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /nebul/i);
    assert.match(res.stderr, /provider/i);
    assert.deepEqual(dockerCalls(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fenix integrations disable bogus exits 2 and runs nothing", () => {
  const { dir, bin } = makeHome("integrations-bogus");
  try {
    const res = runFenix({ home: dir, bin, args: ["integrations", "disable", "bogus"] });
    assert.equal(res.status, 2, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /unknown integration: bogus/);
    assert.deepEqual(dockerCalls(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider wizard hides nebul from the listing unless it is already active", () => {
  // Fresh install (active=openrouter): the menu lists no nebul, but typing it
  // still validates and switches.
  const fresh = makeHome("wizard-nebul-hidden");
  try {
    const settingsPath = writeSettingsFile(fresh.dir, OPENROUTER_SETTINGS);
    const res = runKeysWizard({
      home: fresh.dir,
      bin: fresh.bin,
      settingsPath,
      input: ["", "fixture-provider-key", "fixture-linear-key", "fixture-github-token", "FOC"],
    });
    assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.ok(!/^nebul\b/m.test(res.stdout), `nebul listed:\n${res.stdout}`);
    assert.match(res.stdout, /Available providers:/);
    assert.match(res.stdout, /openrouter/);
  } finally {
    rmSync(fresh.dir, { recursive: true, force: true });
  }
  // Active=nebul: the parked provider is back in the menu.
  const parked = makeHome("wizard-nebul-active");
  try {
    const settingsPath = writeSettingsFile(parked.dir, {
      provider: { active: "nebul", custom: null },
      routing: {},
    });
    const res = runKeysWizard({
      home: parked.dir,
      bin: parked.bin,
      settingsPath,
      input: ["", "fixture-provider-key", "fixture-linear-key", "fixture-github-token", "FOC"],
    });
    assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /^nebul\b/m);
  } finally {
    rmSync(parked.dir, { recursive: true, force: true });
  }
});

test("FOC-1053: fresh install — the provider prompt defaults to openrouter, never the string \"null\"", () => {
  // `settings_get provider.active` prints the literal "null" for the unset
  // value (fenix-settings.mjs get serialises a stored JSON null that way, so
  // `retention` can tell "keepDays: null" from an absent key). The wizard must
  // treat that word as "no value": the prompt shows [openrouter] and Enter
  // picks openrouter — not the unknown provider "null".
  const { dir, bin } = makeHome("wizard-fresh-default");
  try {
    // Fresh install: no settings overlay on disk at all.
    const settingsPath = join(dir, "settings.json");
    assert.equal(existsSync(settingsPath), false);
    const res = runKeysWizard({
      home: dir,
      bin,
      settingsPath,
      input: ["", "fixture-provider-key", "fixture-linear-key", "fixture-github-token", "FOC"],
    });
    assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /Provider \[openrouter\]:/, res.stdout);
    assert.ok(!res.stdout.includes("Provider [null]"), `the literal "null" was offered:\n${res.stdout}`);
    assert.ok(!/Unknown provider: null/.test(res.stdout), res.stdout);
    // Enter really chose openrouter: the live check ran against it.
    const calls = keyCheckCalls(dir);
    assert.ok(calls.some((c) => c.includes("--provider openrouter")), calls.join("\n"));
    assert.ok(!calls.some((c) => c.includes("--provider null")), calls.join("\n"));
    // …and the choice was committed.
    assert.equal(readSettingsFile(dir).provider.active, "openrouter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Same promise for a stored literal "null" (valid by provider.active's
  // pattern, but never a real provider): it is not offered and not selectable.
  const stored = makeHome("wizard-stored-null");
  try {
    const settingsPath = writeSettingsFile(stored.dir, {
      provider: { active: "null", custom: null },
      routing: {},
    });
    const res = runKeysWizard({
      home: stored.dir,
      bin: stored.bin,
      settingsPath,
      input: ["", "fixture-provider-key", "fixture-linear-key", "fixture-github-token", "FOC"],
    });
    assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /Provider \[openrouter\]:/, res.stdout);
    assert.ok(!/Unknown provider: null/.test(res.stdout), res.stdout);
    const calls = keyCheckCalls(stored.dir);
    assert.ok(calls.some((c) => c.includes("--provider openrouter")), calls.join("\n"));
  } finally {
    rmSync(stored.dir, { recursive: true, force: true });
  }
});

test("FOC-780: `fenix retention` with no verb forwards `show` to the in-container node CLI", () => {
  const { dir, bin } = makeHome("retention-default");
  try {
    const res = runFenix({ home: dir, bin, settingsPath: writeSettingsFile(dir, {}), args: ["retention"] });
    assert.equal(res.status, 0, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const calls = forwardCalls(dir, "fenix-retention.mjs");
    assert.equal(calls.length, 1, calls.join("\n"));
    assert.match(
      calls[0],
      /compose run --rm --no-deps -T --entrypoint node fenix-api --disable-warning=ExperimentalWarning \/opt\/fenix\/scripts\/fenix-retention\.mjs show$/,
      calls[0],
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FOC-780: `fenix retention prune --dry-run` forwards the args and passes the exit code through", () => {
  const { dir, bin } = makeHome("retention-refused");
  try {
    const res = runFenix({
      home: dir,
      bin,
      settingsPath: writeSettingsFile(dir, {}),
      args: ["retention", "prune", "--dry-run"],
      // The canned node CLI refuses (exit 1 = keep-everything refusal).
      extraEnv: { FENIX_FAKE_RETENTION_EXIT: "1" },
    });
    assert.equal(res.status, 1, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const calls = forwardCalls(dir, "fenix-retention.mjs");
    assert.equal(calls.length, 1, calls.join("\n"));
    assert.match(
      calls[0],
      /fenix-retention\.mjs prune --dry-run$/,
      calls[0],
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FOC-780: `fenix up` skips the retention question when stdin is not a TTY", () => {
  const { dir, bin } = makeHome("retention-skip");
  try {
    // Keys present, so the key wizard does not run and cannot muddy the log.
    const secretsDir = join(dir, ".fenix", "secrets");
    mkdirSync(secretsDir, { recursive: true });
    for (const f of ["openrouter_api_key", "linear_api_key", "github_token"]) {
      writeFileSync(join(secretsDir, f), "fixture\n", "utf8");
    }
    const res = runFenix({
      home: dir,
      bin,
      settingsPath: writeSettingsFile(dir, {}),
      args: ["up"],
      input: "", // piped stdin: non-interactive, keep-all stays the default
    });
    // The fake docker refuses `compose up`, so cmd_up aborts right after the
    // question point — before the health wait or any browser open.
    assert.equal(res.status, 1, `exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /refusing to start the stack/);
    const log = readFileSync(join(dir, "shim.log"), "utf8");
    // The stack start was reached, i.e. the flow got past the question point…
    assert.ok(log.includes("compose up -d"), log);
    // …and the retention question never touched the settings overlay.
    assert.equal(forwardCalls(dir, "fenix-settings.mjs").length, 0, log);
    assert.equal(forwardCalls(dir, "fenix-retention.mjs").length, 0, log);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
