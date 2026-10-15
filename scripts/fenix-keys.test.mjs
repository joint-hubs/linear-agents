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
    ;;
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
