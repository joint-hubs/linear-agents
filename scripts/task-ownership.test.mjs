// scripts/task-ownership.test.mjs — task ownership (FOC-848): the config
// loader's precedence and fail-closed behaviour, the verdict function every
// enforcement point shares, the refusal message contract, the hold writer,
// and the CLI's show/check exits.
//
// Isolation: LA_SUPERVISOR_STATE_HOME is redirected to a mkdtemp dir at module
// load (same seam as supervisor-holds.test.mjs); LA_SETTINGS_FILE points at a
// temp settings file so the overlay rung never reads the repo's real overlay;
// the env-file rung is exercised through explicit env objects and temp files.
// Nothing touches the repo's real .state/ or .fenix/config.
//
// Run: node --test scripts/task-ownership.test.mjs

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_OWNER,
  OwnershipConfigError,
  OWNER_ID_RE,
  checkOwnership,
  currentOwner,
  loadOwnership,
  ownershipRefusal,
  recordOwnershipHold,
} from "./task-ownership.mjs";
import { holdsPath, readHolds } from "./supervisor-lib.mjs";

const execFileP = promisify(execFile);
const CLI = fileURLToPath(new URL("./task-ownership.mjs", import.meta.url));

// ── module-load isolation ────────────────────────────────────────────────────

const STATE_HOME = mkdtempSync(join(tmpdir(), "la-task-own-"));
process.env.LA_SUPERVISOR_STATE_HOME = STATE_HOME;

const TEMP = mkdtempSync(join(tmpdir(), "la-task-own-cfg-"));
// The overlay rung must never see the repo's real settings.json; an empty
// settings file means "no ownership key" → the loader falls through.
const EMPTY_SETTINGS = join(TEMP, "settings-empty.json");
writeFileSync(EMPTY_SETTINGS, "{}\n", "utf8");
process.env.LA_SETTINGS_FILE = EMPTY_SETTINGS;

// LA_TASK_OWNERSHIP_CONFIG must not leak from the developer's shell into the
// loader's precedence ladder — the ladder under test is built per test.
delete process.env.LA_TASK_OWNERSHIP_CONFIG;

const writeConfig = (name, data) => {
  const path = join(TEMP, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data), "utf8");
  return path;
};

const RESTRICTED = {
  version: 1,
  owners: {
    supervisor: { linearProjects: ["proj-sup", "Fenix"] },
    orchestrator: { linearProjects: ["proj-orch"] },
  },
  unlisted: "ask",
};

const ISSUE = (project) => ({ identifier: "FOC-512", project });

// ── loadOwnership — precedence and fail-closed ───────────────────────────────

test("loadOwnership: no env file, no overlay key → the shipped default, unrestricted", () => {
  const config = loadOwnership({ env: {} });
  assert.equal(config.source, "shipped");
  assert.deepEqual(config.owners, {});
  assert.equal(config.unlisted, "allow");
  assert.equal(config.version, 1);
  assert.equal(config.restricted, false);
});

test("loadOwnership: the env file wins over the overlay", () => {
  const envPath = writeConfig("ownership-env.json", {
    version: 1,
    owners: { orchestrator: { linearProjects: ["env-project"] } },
    unlisted: "allow",
  });
  const overlayPath = writeConfig("settings-overlay.json", JSON.stringify({
    routing: {},
    ownership: { owners: { supervisor: { linearProjects: ["overlay-project"] } } },
  }));
  const saved = process.env.LA_TASK_OWNERSHIP_CONFIG;
  const savedSettings = process.env.LA_SETTINGS_FILE;
  process.env.LA_TASK_OWNERSHIP_CONFIG = envPath;
  process.env.LA_SETTINGS_FILE = overlayPath;
  try {
    const config = loadOwnership();
    assert.equal(config.source, "env");
    assert.deepEqual(config.owners.orchestrator.linearProjects, ["env-project"]);
    assert.equal(config.owners.supervisor, undefined, "the overlay's owners must not merge in");
    assert.equal(config.restricted, true);
  } finally {
    process.env.LA_TASK_OWNERSHIP_CONFIG = saved;
    process.env.LA_SETTINGS_FILE = savedSettings;
  }
});

test("loadOwnership: the settings overlay key is honoured when no env file is set", () => {
  const overlayPath = writeConfig("settings-overlay-2.json", JSON.stringify({
    routing: { web: { lead: "Claude" } },
    // version omitted — optional in the overlay; the loader normalizes to 1.
    ownership: { owners: { supervisor: { linearProjects: ["overlay-project"] } }, unlisted: "ask" },
  }));
  const saved = process.env.LA_SETTINGS_FILE;
  process.env.LA_SETTINGS_FILE = overlayPath;
  try {
    const config = loadOwnership({ env: {} });
    assert.equal(config.source, "overlay");
    assert.equal(config.version, 1);
    assert.deepEqual(config.owners.supervisor.linearProjects, ["overlay-project"]);
    assert.equal(config.unlisted, "ask");
    assert.equal(config.restricted, true);
  } finally {
    process.env.LA_SETTINGS_FILE = saved;
  }
});

test("loadOwnership: a settings file with no ownership key falls through to shipped", () => {
  const config = loadOwnership({ env: {} });
  assert.equal(config.source, "shipped");
});

test("loadOwnership: unreadable env file → config-unreadable, never a fallback", () => {
  assert.throws(
    () => loadOwnership({ env: { LA_TASK_OWNERSHIP_CONFIG: join(TEMP, "no-such-file.json") } }),
    (err) => err instanceof OwnershipConfigError && err.code === "config-unreadable",
  );
});

test("loadOwnership: invalid JSON → config-invalid, naming the path", () => {
  const path = writeConfig("ownership-broken.json", "{ not json");
  assert.throws(
    () => loadOwnership({ env: { LA_TASK_OWNERSHIP_CONFIG: path } }),
    (err) =>
      err instanceof OwnershipConfigError &&
      err.code === "config-invalid" &&
      err.message.includes(path) &&
      err.message.includes("not valid JSON"),
  );
});

test("loadOwnership: schema violations → config-invalid", () => {
  const cases = [
    ["bad unlisted", { version: 1, owners: {}, unlisted: "maybe" }],
    ["bad owner id", { version: 1, owners: { "Orchestrator!": { linearProjects: ["x"] } } }],
    ["empty project list", { version: 1, owners: { supervisor: { linearProjects: [] } } }],
    ["empty project string", { version: 1, owners: { supervisor: { linearProjects: [""] } } }],
    ["extra entry key", { version: 1, owners: { supervisor: { linearProjects: ["x"], lead: "y" } } }],
    ["extra top key", { version: 1, owners: {}, sneaky: true }],
    ["wrong version", { version: 2, owners: {} }],
    ["missing version in a file", { owners: {} }],
    ["missing owners", { version: 1 }],
  ];
  for (const [label, data] of cases) {
    const path = writeConfig(`ownership-bad-${label.replace(/\W+/g, "-")}.json`, data);
    assert.throws(
      () => loadOwnership({ env: { LA_TASK_OWNERSHIP_CONFIG: path } }),
      (err) => err instanceof OwnershipConfigError && err.code === "config-invalid",
      `case "${label}" must be refused`,
    );
  }
});

test("loadOwnership: an invalid overlay is fail-closed, not a fall-through to shipped", () => {
  const overlayPath = writeConfig("settings-overlay-bad.json", JSON.stringify({
    ownership: { owners: { supervisor: { linearProjects: [] } } },
  }));
  const saved = process.env.LA_SETTINGS_FILE;
  process.env.LA_SETTINGS_FILE = overlayPath;
  try {
    assert.throws(
      () => loadOwnership({ env: {} }),
      (err) => err instanceof OwnershipConfigError && err.code === "config-invalid",
    );
  } finally {
    process.env.LA_SETTINGS_FILE = saved;
  }
});

// ── currentOwner ─────────────────────────────────────────────────────────────

test("currentOwner: unset or blank LA_TASK_OWNER → the default; a malformed one throws", () => {
  assert.equal(currentOwner({}), DEFAULT_OWNER);
  assert.equal(currentOwner({ LA_TASK_OWNER: "  " }), DEFAULT_OWNER);
  assert.equal(currentOwner({ LA_TASK_OWNER: "orchestrator" }), "orchestrator");
  assert.throws(
    () => currentOwner({ LA_TASK_OWNER: "Orchestrator!" }),
    (err) => err instanceof OwnershipConfigError && err.code === "owner-id-invalid",
  );
});

test("currentOwner: LA_TASK_OWNER drives checkOwnership's default owner", () => {
  const saved = process.env.LA_TASK_OWNER;
  process.env.LA_TASK_OWNER = "orchestrator";
  try {
    const result = checkOwnership(ISSUE({ id: "proj-orch" }), { config: RESTRICTED });
    assert.equal(result.owner, "orchestrator");
    assert.equal(result.verdict, "owned");
  } finally {
    if (saved === undefined) delete process.env.LA_TASK_OWNER;
    else process.env.LA_TASK_OWNER = saved;
  }
});

// ── checkOwnership — the verdict table ───────────────────────────────────────

test("checkOwnership: an unrestricted install allows everything", () => {
  const config = loadOwnership({ env: {} }); // shipped default
  for (const project of [{ id: "proj-orch" }, "Foreign Project", null]) {
    const result = checkOwnership(ISSUE(project), { owner: "supervisor", config });
    assert.equal(result.verdict, "unrestricted");
    assert.equal(result.allowed, true);
  }
});

test("checkOwnership: owned by id and by exact name", () => {
  const byId = checkOwnership(ISSUE({ id: "proj-sup", name: "Something Else" }), { owner: "supervisor", config: RESTRICTED });
  assert.equal(byId.verdict, "owned");
  assert.equal(byId.allowed, true);

  const byName = checkOwnership(ISSUE({ id: "proj-other", name: "Fenix" }), { owner: "supervisor", config: RESTRICTED });
  assert.equal(byName.verdict, "owned");
  assert.equal(byName.allowed, true);
  assert.deepEqual(byName.project, { id: "proj-other", name: "Fenix" });
});

test("checkOwnership: a bare-string project is treated as the name", () => {
  const owned = checkOwnership(ISSUE("Fenix"), { owner: "supervisor", config: RESTRICTED });
  assert.equal(owned.verdict, "owned");
  const foreign = checkOwnership(ISSUE("Orchestrator's Project"), { owner: "supervisor", config: { ...RESTRICTED, owners: { ...RESTRICTED.owners, orchestrator: { linearProjects: ["Orchestrator's Project"] } } } });
  assert.equal(foreign.verdict, "foreign");
});

test("checkOwnership: a project of another owner is foreign and never allowed", () => {
  const result = checkOwnership(ISSUE({ id: "proj-orch", name: "Joint Flows" }), { owner: "supervisor", config: RESTRICTED });
  assert.equal(result.verdict, "foreign");
  assert.equal(result.allowed, false);
  assert.equal(result.ownedBy, "orchestrator");
});

test("checkOwnership: unlisted follows the policy — ask refuses, allow passes", () => {
  const ask = checkOwnership(ISSUE({ id: "proj-unknown" }), { owner: "supervisor", config: RESTRICTED });
  assert.equal(ask.verdict, "unlisted");
  assert.equal(ask.allowed, false);
  assert.equal(ask.policy, "ask");

  const allow = checkOwnership(ISSUE({ id: "proj-unknown" }), {
    owner: "supervisor",
    config: { ...RESTRICTED, unlisted: "allow" },
  });
  assert.equal(allow.verdict, "unlisted");
  assert.equal(allow.allowed, true);
  assert.equal(allow.policy, "allow");
});

test("checkOwnership: a null or missing project on a restricted install is unlisted", () => {
  for (const issue of [ISSUE(null), {}]) {
    const result = checkOwnership(issue, { owner: "supervisor", config: RESTRICTED });
    assert.equal(result.verdict, "unlisted");
    assert.equal(result.allowed, false);
    assert.equal(result.project, null);
  }
});

test("checkOwnership: a project claimed by two owners throws project-ambiguous", () => {
  const byId = {
    version: 1,
    owners: {
      supervisor: { linearProjects: ["proj-both"] },
      orchestrator: { linearProjects: ["proj-both"] },
    },
    unlisted: "allow",
  };
  assert.throws(
    () => checkOwnership(ISSUE({ id: "proj-both" }), { owner: "supervisor", config: byId }),
    (err) => err instanceof OwnershipConfigError && err.code === "project-ambiguous",
  );
  // A cross-shape claim counts too: one owner lists the id, the other the name.
  const cross = {
    version: 1,
    owners: {
      supervisor: { linearProjects: ["proj-id"] },
      orchestrator: { linearProjects: ["The Name"] },
    },
    unlisted: "allow",
  };
  assert.throws(
    () => checkOwnership(ISSUE({ id: "proj-id", name: "The Name" }), { owner: "supervisor", config: cross }),
    (err) => err instanceof OwnershipConfigError && err.code === "project-ambiguous",
  );
});

// ── ownershipRefusal ─────────────────────────────────────────────────────────

test("ownershipRefusal: foreign names the issue, the project, both owners and the fix", () => {
  const result = checkOwnership(ISSUE({ id: "proj-orch", name: "Joint Flows" }), { owner: "supervisor", config: RESTRICTED });
  const refusal = ownershipRefusal(result, "FOC-512");
  assert.equal(refusal.code, "ownership-foreign");
  assert.match(refusal.message, /^FOC-512 \(project "Joint Flows"\) is owned by orchestrator — acting owner supervisor must not take it/);
  assert.match(refusal.message, /\.fenix\/config\/settings\.json/);
});

test("ownershipRefusal: unlisted names the policy; an allowed verdict is a caller bug", () => {
  const result = checkOwnership(ISSUE({ id: "proj-unknown", name: "Mystery" }), { owner: "supervisor", config: RESTRICTED });
  const refusal = ownershipRefusal(result, "FOC-7");
  assert.equal(refusal.code, "ownership-unlisted");
  assert.match(refusal.message, /is not listed under owner supervisor \(unlisted policy: ask\)/);

  const owned = checkOwnership(ISSUE({ id: "proj-sup" }), { owner: "supervisor", config: RESTRICTED });
  assert.throws(() => ownershipRefusal(owned, "FOC-512"));
});

// ── recordOwnershipHold ──────────────────────────────────────────────────────

test("recordOwnershipHold: no run id → null, no store touched", () => {
  const result = checkOwnership(ISSUE({ id: "proj-orch" }), { owner: "supervisor", config: RESTRICTED });
  assert.equal(recordOwnershipHold({ runId: null, issueId: "FOC-512", result }), null);
});

test("recordOwnershipHold: writes a store-valid hold the CLI could have written", () => {
  const runId = "test-own-hold-1";
  const result = checkOwnership(ISSUE({ id: "proj-orch", name: "Joint Flows" }), { owner: "supervisor", config: RESTRICTED });
  const hold = recordOwnershipHold({ runId, issueId: "FOC-512", result });

  assert.match(hold.id, /^hold-\d+$/);
  assert.equal(hold.origin, "ownership");
  assert.equal(hold.state, "open");
  assert.match(hold.question, /FOC-512/, "the question names the issue — the idempotency key");
  assert.match(hold.question, /owned by orchestrator/);
  assert.equal(hold.impact, "medium");
  assert.equal(hold.blocks, null);
  assert.deepEqual(hold.history.map((h) => h.event), ["created"]);
  // Zero-cost decision options; validateHoldStore ran inside writeHolds.
  assert.deepEqual(
    hold.options.map((o) => o.label),
    ["Leave the ticket to its owner (skip)", "Reassign the project in .fenix/config/settings.json (Mateusz)"],
  );
  for (const option of hold.options) {
    assert.equal(option.costUsd, 0, "a refusal is a decision, priced at zero");
  }

  // Reading the store back runs validateHoldStore — the same contract the
  // guard and the CLI enforce.
  const store = readHolds(runId);
  assert.equal(store.holds.length, 1);
  assert.equal(store.holds[0].id, hold.id);
});

test("recordOwnershipHold: idempotent per run+issue — the second call returns the same hold", () => {
  const runId = "test-own-hold-2";
  const result = checkOwnership(ISSUE({ id: "proj-orch" }), { owner: "supervisor", config: RESTRICTED });
  const first = recordOwnershipHold({ runId, issueId: "FOC-512", result });
  const second = recordOwnershipHold({ runId, issueId: "FOC-512", result });
  assert.equal(second.id, first.id);
  const store = readHolds(runId);
  assert.equal(store.holds.length, 1, "no duplicate hold for the same issue");

  // A different issue in the same run gets its own hold.
  const other = recordOwnershipHold({ runId, issueId: "FOC-999", result });
  assert.notEqual(other.id, first.id);
  assert.equal(readHolds(runId).holds.length, 2);
});

test("recordOwnershipHold: FOC-5 is not swallowed by an open FOC-51 hold — the id is matched, not substring-searched", () => {
  const runId = "test-own-hold-4";
  const result = checkOwnership(ISSUE({ id: "proj-orch" }), { owner: "supervisor", config: RESTRICTED });
  const fiftyOne = recordOwnershipHold({ runId, issueId: "FOC-51", result });
  const five = recordOwnershipHold({ runId, issueId: "FOC-5", result });
  assert.notEqual(five.id, fiftyOne.id, "a prefix of another issue id gets its own hold");
  assert.equal(fiftyOne.issueId, "FOC-51", "the hold records its issue id for the idempotency match");
  assert.equal(five.issueId, "FOC-5");
  assert.equal(readHolds(runId).holds.length, 2);

  // Retrying FOC-5 is still idempotent — the same hold comes back.
  const again = recordOwnershipHold({ runId, issueId: "FOC-5", result });
  assert.equal(again.id, five.id);
  assert.equal(readHolds(runId).holds.length, 2);
});

test("recordOwnershipHold: refuses to record a hold for an allowed verdict", () => {
  const owned = checkOwnership(ISSUE({ id: "proj-sup" }), { owner: "supervisor", config: RESTRICTED });
  assert.throws(() => recordOwnershipHold({ runId: "test-own-hold-3", issueId: "FOC-512", result: owned }));
  assert.equal(existsSync(holdsPath("test-own-hold-3")), false, "no store was created");
});

// ── CLI ──────────────────────────────────────────────────────────────────────

const childEnv = (over = {}) => ({
  ...process.env,
  LA_SETTINGS_FILE: EMPTY_SETTINGS,
  LA_TASK_OWNER: "", // the default owner, whatever the developer's shell says
  ...over,
});
const runCli = (args, over = {}) =>
  execFileP(process.execPath, [CLI, ...args], { env: childEnv(over), windowsHide: true });

test("CLI show: prints the resolved config, its source and the acting owner", async () => {
  const envPath = writeConfig("ownership-show.json", RESTRICTED);
  const { stdout } = await runCli(["show"], { LA_TASK_OWNERSHIP_CONFIG: envPath });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.actingOwner, "supervisor");
  assert.equal(parsed.config.source, "env");
  assert.equal(parsed.config.restricted, true);
  assert.deepEqual(parsed.config.owners.supervisor.linearProjects, ["proj-sup", "Fenix"]);
});

test("CLI show: a broken config fails loudly with the code", async () => {
  const path = writeConfig("ownership-show-bad.json", "{ not json");
  await assert.rejects(runCli(["show"], { LA_TASK_OWNERSHIP_CONFIG: path }), (err) => {
    assert.equal(err.code, 1);
    const parsed = JSON.parse(err.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "config-invalid");
    return true;
  });
});

test("CLI check --issue-file: an owned ticket exits 0 with the verdict", async () => {
  const envPath = writeConfig("ownership-check.json", RESTRICTED);
  const issuePath = writeConfig("issue-owned.json", ISSUE({ id: "proj-sup", name: "Fenix" }));
  const { stdout } = await runCli(
    ["check", "--issue", "FOC-512", "--issue-file", issuePath, "--owner", "supervisor"],
    { LA_TASK_OWNERSHIP_CONFIG: envPath },
  );
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verdict, "owned");
});

test("CLI check --issue-file: a foreign ticket exits 1 with the refusal", async () => {
  const envPath = writeConfig("ownership-check-foreign.json", RESTRICTED);
  const issuePath = writeConfig("issue-foreign.json", ISSUE({ id: "proj-orch", name: "Joint Flows" }));
  await assert.rejects(
    runCli(["check", "--issue", "FOC-512", "--issue-file", issuePath, "--owner", "supervisor"], {
      LA_TASK_OWNERSHIP_CONFIG: envPath,
    }),
    (err) => {
      assert.equal(err.code, 1);
      const parsed = JSON.parse(err.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.verdict, "foreign");
      assert.equal(parsed.refusal.code, "ownership-foreign");
      return true;
    },
  );
});

test("CLI check: LA_TASK_OWNER sets the acting owner when --owner is absent", async () => {
  const envPath = writeConfig("ownership-check-owner.json", RESTRICTED);
  const issuePath = writeConfig("issue-orch.json", ISSUE({ id: "proj-orch" }));
  const { stdout } = await runCli(["check", "--issue-file", issuePath], {
    LA_TASK_OWNERSHIP_CONFIG: envPath,
    LA_TASK_OWNER: "orchestrator",
  });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.owner, "orchestrator");
});

test("CLI check: --owner without a value fails naming the flag, not leaking true", async () => {
  const envPath = writeConfig("ownership-check-owner-flag.json", RESTRICTED);
  const issuePath = writeConfig("issue-owned-2.json", ISSUE({ id: "proj-sup", name: "Fenix" }));
  await assert.rejects(
    runCli(["check", "--issue", "FOC-512", "--issue-file", issuePath, "--owner"], {
      LA_TASK_OWNERSHIP_CONFIG: envPath,
    }),
    (err) => {
      assert.equal(err.code, 1);
      const parsed = JSON.parse(err.stdout);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /--owner/);
      return true;
    },
  );
});

// ── config project entries: trimmed, never empty ─────────────────────────────

test("loadOwnership: linearProjects entries are trimmed, so an entry with a trailing space matches the payload name", () => {
  const path = writeConfig("ownership-trim.json", {
    version: 1,
    owners: { supervisor: { linearProjects: ["Fenix "] } },
    unlisted: "ask",
  });
  const config = loadOwnership({ env: { LA_TASK_OWNERSHIP_CONFIG: path } });
  assert.deepEqual(config.owners.supervisor.linearProjects, ["Fenix"]);
  const result = checkOwnership(ISSUE({ id: "proj-x", name: "Fenix" }), { owner: "supervisor", config });
  assert.equal(result.verdict, "owned");
});

test("loadOwnership: a linearProjects entry that is empty after trimming is config-invalid", () => {
  const path = writeConfig("ownership-blank.json", {
    version: 1,
    owners: { supervisor: { linearProjects: ["   "] } },
  });
  assert.throws(
    () => loadOwnership({ env: { LA_TASK_OWNERSHIP_CONFIG: path } }),
    (err) =>
      err instanceof OwnershipConfigError &&
      err.code === "config-invalid" &&
      err.message.includes("supervisor"),
  );
});

test("checkOwnership: a Unicode project name matches exactly, unaltered", () => {
  const name = "Fenix — wydanie 1.0 i kontrola kosztów";
  const config = { version: 1, owners: { supervisor: { linearProjects: [name] } }, unlisted: "ask" };
  const owned = checkOwnership(ISSUE({ id: "proj-fenix", name }), { owner: "supervisor", config });
  assert.equal(owned.verdict, "owned");
  // The em dash is not a hyphen — a near-miss name must not match.
  const nearMiss = checkOwnership(ISSUE({ id: "proj-fenix", name: "Fenix - wydanie 1.0 i kontrola kosztów" }), {
    owner: "supervisor",
    config,
  });
  assert.equal(nearMiss.verdict, "unlisted");
});
