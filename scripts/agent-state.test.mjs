// scripts/agent-state.test.mjs — FOC-727 slice 1/5: the agent working-state store.
//
// Everything runs against mkdtemp scratch dirs with a per-test SQLite path
// (openAgentState(path) for the API, LA_AGENT_STATE_DB for the CLI) removed
// afterwards — no ports, no socket binds, no real-repo writes, no telemetry
// DB. The CLI children print a node:sqlite ExperimentalWarning on stderr, so
// error assertions slice the payload from the first `{` to the last `}`
// (tolerating the warning and pretty-printed JSON), never "stderr is empty".
// Run:
//   node --test scripts/agent-state.test.mjs

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENT_KEY_CAP,
  RENDER_MAX_BYTES,
  RENDER_MAX_LINES,
  VALUE_MAX_BYTES,
  AgentStateError,
  agentStatePath,
  getFact,
  historyFacts,
  listFacts,
  openAgentState,
  pruneFacts,
  renderFacts,
  retireFact,
  runCli,
  setFact,
} from "./agent-state.mjs";

const SCRIPT = fileURLToPath(new URL("./agent-state.mjs", import.meta.url));

// Fake clock steps: NOW < NOW2 < NOW3 < LATER — every test that needs a later
// timestamp picks from these so ISO expectations stay literal and greppable.
const NOW = "2026-01-01T00:00:00.000Z";
const NOW2 = "2026-01-01T00:01:00.000Z";
const NOW3 = "2026-01-01T00:03:00.000Z";
const LATER = "2026-01-01T00:05:00.000Z";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "agent-state-"));
}

function openStore(dir) {
  return openAgentState(join(dir, "agent-state.sqlite"));
}

function errorCode(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AgentStateError, `expected AgentStateError, got ${err}`);
    return err;
  }
  assert.fail("expected the call to throw AgentStateError");
}

function dbCount(store, table) {
  return store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
}

function allRows(store, sql) {
  return store.db.prepare(sql).all();
}

function cliEnv(dbPath, extra = {}) {
  return { ...process.env, LA_AGENT_STATE_DB: dbPath, ...extra };
}

function runCliSync(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

// The node:sqlite ExperimentalWarning precedes any JSON error payload on
// stderr, and the error payload itself is pretty-printed — slice from the
// first `{` to the last `}` instead of trusting line boundaries.
function errorJson(text) {
  const s = String(text || "");
  return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
}

function sinkStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  return {
    stream,
    text: () => chunks.map((c) => c.toString()).join(""),
  };
}

test("constants and exports match the documented caps", () => {
  assert.equal(AGENT_KEY_CAP, 50);
  assert.equal(VALUE_MAX_BYTES, 2048);
  assert.equal(RENDER_MAX_LINES, 60);
  assert.equal(RENDER_MAX_BYTES, 6144);
  for (const fn of [
    agentStatePath,
    openAgentState,
    setFact,
    getFact,
    listFacts,
    retireFact,
    pruneFacts,
    historyFacts,
    renderFacts,
    runCli,
  ]) {
    assert.equal(typeof fn, "function");
  }
});

test("agentStatePath honours LA_AGENT_STATE_DB over the state root", () => {
  const dir = tempRoot();
  try {
    // the override is resolved, so a relative LA_AGENT_STATE_DB anchors at cwd
    const custom = "rel/dir/x.sqlite";
    assert.equal(agentStatePath({ LA_AGENT_STATE_DB: custom }), resolve(custom));
    assert.equal(
      agentStatePath({ LA_STATE_ROOT: join(dir, "state") }),
      resolve(join(dir, "state", "agent-state", "agent-state.sqlite"))
    );
    // the explicit db wins over the state root
    assert.equal(
      agentStatePath({ LA_AGENT_STATE_DB: custom, LA_STATE_ROOT: join(dir, "state") }),
      resolve(custom)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set: agent tier defaults, actor default, and expiry variants", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const res = setFact(store, {
        namespace: "supervisor:d1",
        key: "active_issue",
        value: "FOC-1",
        reason: "boot",
        now: NOW,
      });
      assert.equal(res.op, "set");
      assert.equal(res.row.tier, "agent");
      assert.equal(res.row.status, "active");
      assert.equal(res.row.source, "agent");
      assert.equal(res.row.scope, "task");
      assert.equal(res.row.created_at, NOW);
      assert.equal(res.row.updated_at, NOW);
      assert.equal(res.row.version, 1);
      assert.equal(res.row.expires_at, null);
      assert.equal(res.row.read_count, 0);

      const hist = historyFacts(store, { namespace: "supervisor:d1", key: "active_issue" });
      assert.equal(hist.rows.length, 1);
      assert.equal(hist.rows[0].op, "set");
      assert.equal(hist.rows[0].actor, "cli"); // actor defaults to "cli"
      assert.equal(hist.rows[0].before, null);
      assert.equal(JSON.parse(hist.rows[0].after).value, "FOC-1");

      const withTtl = setFact(store, {
        namespace: "supervisor:d1",
        key: "ttl_key",
        value: "v",
        reason: "r",
        ttlSeconds: 60,
        now: NOW,
      });
      assert.equal(withTtl.row.expires_at, NOW2);
      const withIso = setFact(store, {
        namespace: "supervisor:d1",
        key: "iso_key",
        value: "v",
        reason: "r",
        expiresAt: "2026-02-01T00:00:00.000Z",
        now: NOW,
      });
      assert.equal(withIso.row.expires_at, "2026-02-01T00:00:00.000Z");
      const withoutExpiry = setFact(store, {
        namespace: "supervisor:d1",
        key: "plain_key",
        value: "v",
        reason: "r",
        now: NOW,
      });
      assert.equal(withoutExpiry.row.expires_at, null);

      const acted = setFact(store, {
        namespace: "supervisor:d1",
        key: "acted",
        value: "v",
        reason: "r",
        actor: "agent-x",
        now: NOW,
      });
      assert.equal(acted.op, "set");
      const actedHist = historyFacts(store, { namespace: "supervisor:d1", key: "acted" });
      assert.equal(actedHist.rows[0].actor, "agent-x");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set: a non-ISO expiresAt or now is refused and nothing is written", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:iso";
      const badExpiry = errorCode(() =>
        setFact(store, { namespace: ns, key: "k", value: "v", reason: "r", expiresAt: "not-a-date", now: NOW })
      );
      assert.equal(badExpiry.code, "FIELD_INVALID");
      assert.equal(badExpiry.exitCode, 2);
      const badNow = errorCode(() =>
        setFact(store, { namespace: ns, key: "k", value: "v", reason: "r", now: "garbage" })
      );
      assert.equal(badNow.code, "FIELD_INVALID");
      assert.equal(badNow.exitCode, 2);
      assert.equal(dbCount(store, "facts"), 0);
      assert.equal(dbCount(store, "facts_history"), 0);

      // a parseable expiry is normalised to a full ISO string
      const res = setFact(store, {
        namespace: ns,
        key: "k",
        value: "v",
        reason: "r",
        expiresAt: "2026-02-01T00:00:00Z",
        now: NOW,
      });
      assert.equal(res.row.expires_at, "2026-02-01T00:00:00.000Z");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set: an update keeps created_at, bumps version, and reactivates a retired key", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:upd";
      setFact(store, { namespace: ns, key: "k", value: "v1", reason: "r", now: NOW });
      const upd = setFact(store, { namespace: ns, key: "k", value: "v2", reason: "r2", now: LATER });
      assert.equal(upd.op, "update");
      assert.equal(upd.row.created_at, NOW); // kept
      assert.equal(upd.row.updated_at, LATER);
      assert.equal(upd.row.version, 2);

      retireFact(store, { namespace: ns, key: "k", reason: "done", now: LATER });
      const back = setFact(store, { namespace: ns, key: "k", value: "v3", reason: "r3", now: LATER });
      assert.equal(back.op, "update");
      assert.equal(back.row.status, "active"); // a retired agent key can be re-set
      assert.ok(back.row.version >= 3);

      const hist = historyFacts(store, { namespace: ns, key: "k" });
      assert.deepEqual(hist.rows.map((r) => r.op), ["set", "update", "retire", "update"]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set: agent tier requires a reason", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const err = errorCode(() =>
        setFact(store, { namespace: "supervisor:why", key: "k", value: "v", now: NOW })
      );
      assert.equal(err.code, "REASON_REQUIRED");
      assert.equal(err.exitCode, 1);
      assert.equal(dbCount(store, "facts"), 0);
      assert.equal(dbCount(store, "facts_history"), 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set: base tier requires evidence and source, scope defaults to run", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:base";
      const noEvidence = errorCode(() =>
        setFact(store, { namespace: ns, key: "b1", value: "v", tier: "base", now: NOW })
      );
      assert.equal(noEvidence.code, "EVIDENCE_REQUIRED");
      const noSource = errorCode(() =>
        setFact(store, {
          namespace: ns,
          key: "b1",
          value: "v",
          tier: "base",
          evidence: "docs/anchor.md",
          now: NOW,
        })
      );
      assert.equal(noSource.code, "FIELD_INVALID");

      const res = setFact(store, {
        namespace: ns,
        key: "b1",
        value: "v",
        tier: "base",
        source: "config",
        evidence: "docs/anchor.md",
        now: NOW,
      });
      assert.equal(res.op, "set");
      assert.equal(res.row.tier, "base");
      assert.equal(res.row.source, "config");
      assert.equal(res.row.scope, "run"); // base scope default
      assert.equal(res.row.status, "active");

      // vocabulary enforcement on the other fields
      assert.equal(
        errorCode(() =>
          setFact(store, { namespace: ns, key: "k2", value: "v", reason: "r", source: "bogus", now: NOW })
        ).code,
        "FIELD_INVALID"
      );
      assert.equal(
        errorCode(() =>
          setFact(store, { namespace: ns, key: "k3", value: "v", reason: "r", tier: "middle", now: NOW })
        ).code,
        "FIELD_INVALID"
      );
      assert.equal(
        errorCode(() =>
          setFact(store, { namespace: ns, key: "k4", value: "v", reason: "r", scope: "day", now: NOW })
        ).code,
        "FIELD_INVALID"
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set: an existing base key cannot be re-set as agent (BASE_KEY_PROTECTED)", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:lock";
      setFact(store, {
        namespace: ns,
        key: "anchor",
        value: "doc",
        tier: "base",
        source: "config",
        evidence: "docs/anchor.md",
        now: NOW,
      });
      const factsBefore = JSON.stringify(allRows(store, "SELECT * FROM facts ORDER BY namespace, key"));
      const histBefore = JSON.stringify(allRows(store, "SELECT * FROM facts_history ORDER BY id"));
      const err = errorCode(() =>
        setFact(store, { namespace: ns, key: "anchor", value: "hijack", reason: "r", now: LATER })
      );
      assert.equal(err.code, "BASE_KEY_PROTECTED");
      assert.equal(err.exitCode, 1);
      // nothing changed — not the row, not the history
      assert.equal(JSON.stringify(allRows(store, "SELECT * FROM facts ORDER BY namespace, key")), factsBefore);
      assert.equal(JSON.stringify(allRows(store, "SELECT * FROM facts_history ORDER BY id")), histBefore);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set: the 51st active agent key in a namespace is refused (AGENT_KEY_CAP)", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:cap";
      for (let i = 0; i < AGENT_KEY_CAP; i++) {
        setFact(store, {
          namespace: ns,
          key: `k${String(i).padStart(2, "0")}`,
          value: "v",
          reason: "fill",
          now: NOW,
        });
      }
      const err = errorCode(() =>
        setFact(store, { namespace: ns, key: "overflow", value: "v", reason: "r", now: NOW })
      );
      assert.equal(err.code, "AGENT_KEY_CAP");
      assert.equal(err.exitCode, 1);
      assert.equal(dbCount(store, "facts"), AGENT_KEY_CAP);
      assert.equal(dbCount(store, "facts_history"), AGENT_KEY_CAP); // nothing written

      // updating an existing key is not capped
      const upd = setFact(store, { namespace: ns, key: "k00", value: "v2", reason: "r", now: LATER });
      assert.equal(upd.op, "update");

      // after retiring one, a new key is accepted
      retireFact(store, { namespace: ns, key: "k01", reason: "make-room", now: LATER });
      const ok = setFact(store, { namespace: ns, key: "overflow", value: "v", reason: "r", now: LATER });
      assert.equal(ok.op, "set");
      assert.equal(dbCount(store, "facts"), AGENT_KEY_CAP + 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set: value over 2048 UTF-8 bytes is refused (VALUE_TOO_LONG)", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:size";
      const tooLong = errorCode(() =>
        setFact(store, {
          namespace: ns,
          key: "big",
          value: "a".repeat(VALUE_MAX_BYTES + 1),
          reason: "r",
          now: NOW,
        })
      );
      assert.equal(tooLong.code, "VALUE_TOO_LONG");
      assert.equal(tooLong.exitCode, 1);

      // the boundary itself is fine
      const fits = setFact(store, {
        namespace: ns,
        key: "fits",
        value: "a".repeat(VALUE_MAX_BYTES),
        reason: "r",
        now: NOW,
      });
      assert.equal(fits.op, "set");

      // byte length, not code-point count: 1025 two-byte chars = 2050 bytes
      const multibyte = errorCode(() =>
        setFact(store, { namespace: ns, key: "wide", value: "é".repeat(1025), reason: "r", now: NOW })
      );
      assert.equal(multibyte.code, "VALUE_TOO_LONG");
      assert.equal(dbCount(store, "facts"), 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("set: a secret-shaped value is refused before anything is written", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const err = errorCode(() =>
        setFact(store, {
          namespace: "supervisor:leak",
          key: "leak",
          value: "-----BEGIN PRIVATE KEY-----\nabc",
          reason: "r",
          now: NOW,
        })
      );
      assert.equal(err.code, "VALUE_SECRET_SHAPED");
      assert.equal(err.exitCode, 1);
      assert.equal(dbCount(store, "facts"), 0);
      assert.equal(dbCount(store, "facts_history"), 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("namespace and key validation reject malformed identifiers with exitCode 2", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:valid";
      const badNamespaces = [
        "",
        "bogus",
        "supervisor:",
        "supervisor:a b",
        "child:a",
        "child:a/",
        "child:a/b/c",
        "session:a/b",
      ];
      for (const bad of badNamespaces) {
        const err = errorCode(() =>
          setFact(store, { namespace: bad, key: "k", value: "v", reason: "r", now: NOW })
        );
        assert.equal(err.code, "NAMESPACE_INVALID", `namespace ${JSON.stringify(bad)}`);
        assert.equal(err.exitCode, 2, `namespace ${JSON.stringify(bad)}`);
      }
      const goodNamespaces = ["supervisor:r1", "child:c1/w1", "session:s-1.2_3"];
      for (const [i, good] of goodNamespaces.entries()) {
        const res = setFact(store, { namespace: good, key: "k", value: "v", reason: "r", now: NOW });
        assert.equal(res.op, "set", `namespace ${good}`);
      }

      const badKeys = ["", "Upper", "1abc", "has-hyphen", "has space", "a".repeat(65)];
      for (const bad of badKeys) {
        const err = errorCode(() =>
          setFact(store, { namespace: ns, key: bad, value: "v", reason: "r", now: NOW })
        );
        assert.equal(err.code, "KEY_INVALID", `key ${JSON.stringify(bad)}`);
        assert.equal(err.exitCode, 2, `key ${JSON.stringify(bad)}`);
      }
      const goodKeys = ["a", "a".repeat(64), "k_1"];
      for (const good of goodKeys) {
        const res = setFact(store, { namespace: ns, key: good, value: "v", reason: "r", now: NOW });
        assert.equal(res.op, "set", `key ${good}`);
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getFact bumps read_count/last_read_at, writes no history, and honours includeRetired", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:reads";
      setFact(store, { namespace: ns, key: "k", value: "v", reason: "r", now: NOW });
      const histAfterSet = historyFacts(store, { namespace: ns, key: "k" }).rows.length;

      const g1 = getFact(store, { namespace: ns, key: "k", now: NOW2 });
      assert.equal(g1.row.value, "v");
      assert.equal(g1.row.read_count, 1);
      assert.equal(g1.row.last_read_at, NOW2);
      const g2 = getFact(store, { namespace: ns, key: "k", now: NOW3 });
      assert.equal(g2.row.read_count, 2);
      assert.equal(g2.row.last_read_at, NOW3);
      assert.equal(historyFacts(store, { namespace: ns, key: "k" }).rows.length, histAfterSet);

      const missing = errorCode(() => getFact(store, { namespace: ns, key: "nope", now: NOW3 }));
      assert.equal(missing.code, "NOT_FOUND");

      retireFact(store, { namespace: ns, key: "k", reason: "done", now: LATER });
      const retired = errorCode(() => getFact(store, { namespace: ns, key: "k", now: LATER }));
      assert.equal(retired.code, "NOT_FOUND");
      const withRetired = getFact(store, { namespace: ns, key: "k", includeRetired: true, now: LATER });
      assert.equal(withRetired.row.status, "retired");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listFacts orders base first then key ascending and honours filters", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:list";
      const base = (key) =>
        setFact(store, {
          namespace: ns,
          key,
          value: "v",
          tier: "base",
          source: "config",
          evidence: "docs/x.md",
          now: NOW,
        });
      base("b_key");
      base("a_key");
      setFact(store, { namespace: ns, key: "z_key", value: "v", reason: "r", now: NOW });
      setFact(store, { namespace: ns, key: "x_key", value: "v", reason: "r", now: NOW });
      setFact(store, { namespace: ns, key: "m_key", value: "v", reason: "r", now: NOW });
      retireFact(store, { namespace: ns, key: "m_key", reason: "done", now: NOW2 });

      const active = listFacts(store, { namespace: ns }).rows;
      assert.deepEqual(active.map((r) => r.key), ["a_key", "b_key", "x_key", "z_key"]);
      assert.equal(active[0].tier, "base");

      const all = listFacts(store, { namespace: ns, status: "all" }).rows;
      assert.equal(all.length, 5);
      assert.deepEqual(
        new Set(all.map((r) => r.key)),
        new Set(["a_key", "b_key", "m_key", "x_key", "z_key"])
      );
      assert.deepEqual(
        listFacts(store, { namespace: ns, tier: "base" }).rows.map((r) => r.key),
        ["a_key", "b_key"]
      );

      setFact(store, { namespace: ns, key: "turn_key", value: "v", reason: "r", scope: "turn", now: NOW });
      assert.deepEqual(
        listFacts(store, { namespace: ns, scope: "turn" }).rows.map((r) => r.key),
        ["turn_key"]
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retireFact protects base keys byte-identically and refuses unknown keys", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:keep";
      setFact(store, {
        namespace: ns,
        key: "anchor",
        value: "doc",
        tier: "base",
        source: "config",
        evidence: "docs/anchor.md",
        now: NOW,
      });
      const factsBefore = JSON.stringify(allRows(store, "SELECT * FROM facts ORDER BY namespace, key"));
      const histBefore = JSON.stringify(allRows(store, "SELECT * FROM facts_history ORDER BY id"));
      const err = errorCode(() =>
        retireFact(store, { namespace: ns, key: "anchor", reason: "nope", now: LATER })
      );
      assert.equal(err.code, "BASE_KEY_PROTECTED");
      assert.equal(JSON.stringify(allRows(store, "SELECT * FROM facts ORDER BY namespace, key")), factsBefore);
      assert.equal(JSON.stringify(allRows(store, "SELECT * FROM facts_history ORDER BY id")), histBefore);

      const missing = errorCode(() =>
        retireFact(store, { namespace: ns, key: "nope", reason: "r", now: LATER })
      );
      assert.equal(missing.code, "NOT_FOUND");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retireFact retires an agent key once and records one history row", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:retire";
      setFact(store, { namespace: ns, key: "k", value: "v", reason: "r", now: NOW });
      const r1 = retireFact(store, { namespace: ns, key: "k", reason: "done", actor: "me", now: LATER });
      assert.equal(r1.changed, true);
      assert.equal(r1.row.status, "retired");
      const hist = historyFacts(store, { namespace: ns, key: "k" }).rows;
      assert.equal(hist.length, 2);
      assert.equal(hist[1].op, "retire");
      assert.equal(hist[1].actor, "me");

      const r2 = retireFact(store, { namespace: ns, key: "k", reason: "again", now: LATER });
      assert.equal(r2.changed, false);
      assert.equal(historyFacts(store, { namespace: ns, key: "k" }).rows.length, 2); // no new row
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneFacts retires expired and scoped agent keys, never base keys", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:prune";
      setFact(store, { namespace: ns, key: "expired", value: "v", reason: "r", ttlSeconds: 60, now: NOW });
      setFact(store, { namespace: ns, key: "fresh", value: "v", reason: "r", now: NOW });
      setFact(store, { namespace: ns, key: "scoped", value: "v", reason: "r", scope: "turn", now: NOW });
      setFact(store, {
        namespace: ns,
        key: "anchor",
        value: "doc",
        tier: "base",
        source: "config",
        evidence: "docs/anchor.md",
        expiresAt: "2020-01-01T00:00:00.000Z", // long past — base is still never pruned
        now: NOW,
      });

      const r1 = pruneFacts(store, { namespace: ns, now: "2026-01-01T00:02:00.000Z" });
      assert.deepEqual(r1.retired, ["expired"]);
      const status = (key) =>
        store.db.prepare("SELECT status FROM facts WHERE namespace = ? AND key = ?").get(ns, key).status;
      assert.equal(status("fresh"), "active");
      assert.equal(status("scoped"), "active");
      assert.equal(status("anchor"), "active");
      assert.deepEqual(
        historyFacts(store, { namespace: ns, key: "expired" }).rows.map((r) => r.op),
        ["set", "prune"]
      );

      const r2 = pruneFacts(store, { namespace: ns, scope: "turn", now: LATER });
      assert.deepEqual(r2.retired, ["scoped"]);
      assert.equal(status("anchor"), "active");

      const r3 = pruneFacts(store, { namespace: ns, now: LATER });
      assert.deepEqual(r3.retired, []); // idempotent
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("historyFacts returns the full op chain ascending with parseable snapshots", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:hist";
      setFact(store, { namespace: ns, key: "k", value: "v1", reason: "r", now: NOW });
      setFact(store, { namespace: ns, key: "k", value: "v2", reason: "r", now: LATER });
      retireFact(store, { namespace: ns, key: "k", reason: "done", now: LATER });

      const h = historyFacts(store, { namespace: ns, key: "k" });
      assert.equal(h.rows.length, 3);
      assert.deepEqual(h.rows.map((r) => r.op), ["set", "update", "retire"]);
      assert.ok(h.rows[0].id < h.rows[1].id && h.rows[1].id < h.rows[2].id);
      assert.equal(h.rows[0].before, null);
      assert.equal(JSON.parse(h.rows[0].after).value, "v1");
      assert.equal(JSON.parse(h.rows[1].before).value, "v1"); // the OLD value
      assert.equal(JSON.parse(h.rows[1].after).value, "v2");
      assert.equal(JSON.parse(h.rows[2].after).status, "retired");

      // two more rows on a sibling key; the limit keeps the MOST RECENT rows
      // (here: the two k2 ops), still delivered ascending by id
      setFact(store, { namespace: ns, key: "k2", value: "v1", reason: "r", now: NOW });
      setFact(store, { namespace: ns, key: "k2", value: "v2", reason: "r", now: LATER });
      const full = historyFacts(store, { namespace: ns }).rows;
      assert.equal(full.length, 5);
      const limited = historyFacts(store, { namespace: ns, limit: 2 }).rows;
      assert.equal(limited.length, 2);
      assert.deepEqual(limited.map((r) => r.id), [full[3].id, full[4].id]);
      assert.deepEqual(limited.map((r) => r.op), ["set", "update"]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderFacts formats lines, escapes newlines, and leaves read_count alone", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:render";
      setFact(store, {
        namespace: ns,
        key: "anchor",
        value: "doc",
        tier: "base",
        source: "config",
        evidence: "docs/anchor.md",
        now: NOW,
      });
      setFact(store, { namespace: ns, key: "task_state", value: "line1\nline2", reason: "r", now: NOW });
      setFact(store, { namespace: ns, key: "crlf_state", value: "a\r\nb", reason: "r", now: NOW });
      getFact(store, { namespace: ns, key: "task_state", now: NOW2 });
      const readsBefore = store.db
        .prepare("SELECT read_count FROM facts WHERE namespace = ? AND key = ?")
        .get(ns, "task_state").read_count;

      const r = renderFacts(store, { namespace: ns });
      assert.equal(r.omitted, 0);
      const lines = r.text.split("\n");
      assert.equal(lines[0], "=== WORKING STATE ===");
      assert.ok(
        lines.some((l) => l === `anchor: doc  (config, updated ${NOW})`),
        `base line missing: ${r.text}`
      );
      assert.ok(
        lines.some((l) => l === `task_state: line1\\nline2  (agent, updated ${NOW})`),
        `escaped agent line missing: ${r.text}`
      );
      // \r\n is four literal characters: backslash r backslash n
      assert.ok(
        lines.some((l) => l === `crlf_state: a\\r\\nb  (agent, updated ${NOW})`),
        `crlf-escaped agent line missing: ${r.text}`
      );
      assert.ok(!lines.some((l) => /^\d+ more — use agent-state get$/.test(l))); // no tail line
      assert.equal(r.lines, lines.length);

      // deterministic for the same store
      assert.equal(renderFacts(store, { namespace: ns }).text, r.text);

      const readsAfter = store.db
        .prepare("SELECT read_count FROM facts WHERE namespace = ? AND key = ?")
        .get(ns, "task_state").read_count;
      assert.equal(readsAfter, readsBefore); // render does not bump read_count
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderFacts orders base alphabetical then agents by read/update recency", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:order";
      const base = (key) =>
        setFact(store, {
          namespace: ns,
          key,
          value: "v",
          tier: "base",
          source: "config",
          evidence: "docs/x.md",
          now: NOW,
        });
      base("b_base");
      base("a_base");
      setFact(store, { namespace: ns, key: "k3", value: "v", reason: "r", now: NOW });
      setFact(store, { namespace: ns, key: "k4", value: "v", reason: "r", now: LATER });
      setFact(store, { namespace: ns, key: "k1", value: "v", reason: "r", now: NOW });
      setFact(store, { namespace: ns, key: "k2", value: "v", reason: "r", now: NOW });
      // control last_read_at: k2 read last, then k1, then k4, then k3
      getFact(store, { namespace: ns, key: "k3", now: NOW });
      getFact(store, { namespace: ns, key: "k4", now: NOW2 });
      getFact(store, { namespace: ns, key: "k1", now: NOW3 });
      getFact(store, { namespace: ns, key: "k2", now: LATER });

      const r = renderFacts(store, { namespace: ns });
      const keys = r.text.split("\n").slice(1).map((l) => l.split(":")[0]);
      assert.deepEqual(keys, ["a_base", "b_base", "k2", "k1", "k4", "k3"]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderFacts caps at maxLines with a tail line and keeps every base key", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:capped";
      const baseKeys = ["base_a", "base_b", "base_c"];
      for (const key of baseKeys) {
        setFact(store, {
          namespace: ns,
          key,
          value: "v",
          tier: "base",
          source: "config",
          evidence: "docs/x.md",
          now: NOW,
        });
      }
      for (let i = 0; i < 50; i++) {
        setFact(store, {
          namespace: ns,
          key: `a${String(i).padStart(2, "0")}`,
          value: "v",
          reason: "fill",
          now: NOW,
        });
      }

      // The 50-key agent cap bounds one namespace at 50 active agent keys, so
      // the line cap is exercised through the maxLines parameter — the cap
      // logic under test is the same one the 60 default feeds.
      const r = renderFacts(store, { namespace: ns, maxLines: 20 });
      assert.ok(r.omitted > 0, `omitted=${r.omitted}`);
      const lines = r.text.split("\n");
      assert.match(lines[lines.length - 1], /^\d+ more — use agent-state get$/);
      for (const key of baseKeys) {
        assert.ok(lines.some((l) => l.startsWith(`${key}:`)), `base key ${key} missing`);
      }
      assert.ok(lines.length <= 20 + 1, `lines=${lines.length}`);

      // at the default 60 lines the whole namespace fits — no tail line
      const full = renderFacts(store, { namespace: ns });
      assert.equal(full.omitted, 0);
      assert.ok(!full.text.split("\n").some((l) => /^\d+ more — use agent-state get$/.test(l)));
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderFacts caps by bytes before lines when values are large", () => {
  const dir = tempRoot();
  try {
    const store = openStore(dir);
    try {
      const ns = "supervisor:bytes";
      setFact(store, {
        namespace: ns,
        key: "anchor",
        value: "doc",
        tier: "base",
        source: "config",
        evidence: "docs/anchor.md",
        now: NOW,
      });
      for (let i = 0; i < 20; i++) {
        setFact(store, {
          namespace: ns,
          key: `big${String(i).padStart(2, "0")}`,
          value: "x".repeat(500),
          reason: "fill",
          now: NOW,
        });
      }
      const r = renderFacts(store, { namespace: ns });
      // ~540 bytes per line: 20 lines ≈ 10.8 KB > RENDER_MAX_BYTES, so the
      // byte cap must fire well before the 60-line cap
      assert.ok(r.omitted > 0, `omitted=${r.omitted}`);
      const lines = r.text.split("\n");
      // the tail line counts inside both caps, not on top of them
      assert.ok(lines.length <= RENDER_MAX_LINES, `lines=${lines.length}`);
      assert.ok(lines.some((l) => l.startsWith("anchor:")), "base key missing");
      assert.ok(Buffer.byteLength(r.text, "utf8") <= RENDER_MAX_BYTES, "render over the byte cap");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli runs in-process against injected streams", async () => {
  const dir = tempRoot();
  const dbPath = join(dir, "agent-state.sqlite");
  try {
    const out = sinkStream();
    const errOut = sinkStream();
    const code = await runCli(
      ["set", "--namespace", "supervisor:inproc", "--key", "k", "--value", "v", "--reason", "r", "--json"],
      { env: { ...process.env, LA_AGENT_STATE_DB: dbPath }, stdout: out.stream, stderr: errOut.stream }
    );
    assert.equal(code, 0);
    const ok = JSON.parse(out.text());
    assert.equal(ok.ok, true);
    assert.equal(ok.verb, "set");

    const refusedOut = sinkStream();
    const refusedErr = sinkStream();
    const refused = await runCli(
      ["set", "--namespace", "supervisor:inproc", "--key", "k2", "--value", "v", "--json"],
      {
        env: { ...process.env, LA_AGENT_STATE_DB: dbPath },
        stdout: refusedOut.stream,
        stderr: refusedErr.stream,
      }
    );
    assert.equal(refused, 1);
    const err = errorJson(refusedErr.text());
    assert.equal(err.ok, false);
    assert.equal(err.code, "REASON_REQUIRED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: set/get round-trip --json", () => {
  const dir = tempRoot();
  const env = cliEnv(join(dir, "agent-state.sqlite"));
  try {
    const set1 = runCliSync(
      ["set", "--namespace", "supervisor:r1", "--key", "active_issue", "--value", "FOC-1", "--reason", "test", "--json"],
      env
    );
    assert.equal(set1.status, 0, `stderr: ${set1.stderr}`);
    const setJson = JSON.parse(set1.stdout);
    assert.equal(setJson.ok, true);
    assert.equal(setJson.verb, "set");
    assert.equal(setJson.op, "set");
    assert.equal(setJson.row.namespace, "supervisor:r1");
    assert.equal(setJson.row.value, "FOC-1");

    const get1 = runCliSync(["get", "--namespace", "supervisor:r1", "--key", "active_issue", "--json"], env);
    assert.equal(get1.status, 0, `stderr: ${get1.stderr}`);
    assert.equal(JSON.parse(get1.stdout).row.value, "FOC-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: retiring a base key exits 1 with BASE_KEY_PROTECTED on stderr", () => {
  const dir = tempRoot();
  const env = cliEnv(join(dir, "agent-state.sqlite"));
  try {
    const seed = runCliSync(
      [
        "set", "--namespace", "supervisor:guard", "--key", "anchor", "--value", "doc",
        "--tier", "base", "--source", "config", "--evidence", "docs/anchor.md", "--json",
      ],
      env
    );
    assert.equal(seed.status, 0, `stderr: ${seed.stderr}`);
    const ret = runCliSync(
      ["retire", "--namespace", "supervisor:guard", "--key", "anchor", "--reason", "nope", "--json"],
      env
    );
    assert.equal(ret.status, 1);
    const errJson = errorJson(ret.stderr);
    assert.equal(errJson.ok, false);
    assert.equal(errJson.code, "BASE_KEY_PROTECTED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: set without --reason exits 1 with REASON_REQUIRED", () => {
  const dir = tempRoot();
  const env = cliEnv(join(dir, "agent-state.sqlite"));
  try {
    const res = runCliSync(
      ["set", "--namespace", "supervisor:why", "--key", "no_reason", "--value", "v", "--json"],
      env
    );
    assert.equal(res.status, 1);
    assert.equal(errorJson(res.stderr).code, "REASON_REQUIRED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: usage errors exit 2 (unknown verb, missing namespace, bad namespace)", () => {
  const dir = tempRoot();
  const env = cliEnv(join(dir, "agent-state.sqlite"));
  try {
    const unknown = runCliSync(["frobnicate", "--json"], env);
    assert.equal(unknown.status, 2);
    const noNs = runCliSync(["set", "--key", "k", "--value", "v", "--reason", "r", "--json"], env);
    assert.equal(noNs.status, 2);
    const badNs = runCliSync(
      ["set", "--namespace", "bogus", "--key", "k", "--value", "v", "--reason", "r", "--json"],
      env
    );
    assert.equal(badNs.status, 2);
    assert.equal(errorJson(badNs.stderr).code, "NAMESPACE_INVALID");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: --expires-at not-a-date exits 2 with FIELD_INVALID", () => {
  const dir = tempRoot();
  const env = cliEnv(join(dir, "agent-state.sqlite"));
  try {
    const res = runCliSync(
      [
        "set", "--namespace", "supervisor:iso", "--key", "k", "--value", "v",
        "--reason", "r", "--expires-at", "not-a-date", "--json",
      ],
      env
    );
    assert.equal(res.status, 2);
    assert.equal(errorJson(res.stderr).code, "FIELD_INVALID");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: a non-ISO LA_AGENT_STATE_NOW exits 2 with a usage message", () => {
  const dir = tempRoot();
  const dbPath = join(dir, "agent-state.sqlite");
  try {
    const res = runCliSync(
      ["set", "--namespace", "supervisor:clock", "--key", "k", "--value", "v", "--reason", "r", "--ttl", "60", "--json"],
      cliEnv(dbPath, { LA_AGENT_STATE_NOW: "garbage" })
    );
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes("LA_AGENT_STATE_NOW"), `stderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: --ttl '' and --ttl 1.5 exit 2 as non-integers", () => {
  const dir = tempRoot();
  const env = cliEnv(join(dir, "agent-state.sqlite"));
  try {
    for (const bad of ["", "1.5"]) {
      const res = runCliSync(
        ["set", "--namespace", "supervisor:ttl", "--key", "k", "--value", "v", "--reason", "r", "--ttl", bad, "--json"],
        env
      );
      assert.equal(res.status, 2, `--ttl '${bad}': stderr ${res.stderr}`);
      assert.ok(res.stderr.includes("--ttl must be a non-negative integer"), `stderr: ${res.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: an extra positional after the verb exits 2", () => {
  const dir = tempRoot();
  const env = cliEnv(join(dir, "agent-state.sqlite"));
  try {
    const res = runCliSync(["get", "extra", "--namespace", "supervisor:pos", "--key", "k", "--json"], env);
    assert.equal(res.status, 2);
    assert.ok(res.stderr.includes("unexpected positional argument: extra"), `stderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: invalid --status, --tier, and --limit each exit 2", () => {
  const dir = tempRoot();
  const env = cliEnv(join(dir, "agent-state.sqlite"));
  try {
    const badStatus = runCliSync(["list", "--namespace", "supervisor:vocab", "--status", "bogus", "--json"], env);
    assert.equal(badStatus.status, 2);
    const badTier = runCliSync(
      ["set", "--namespace", "supervisor:vocab", "--key", "k", "--value", "v", "--reason", "r", "--tier", "bogus", "--json"],
      env
    );
    assert.equal(badTier.status, 2);
    const badLimit = runCliSync(["history", "--namespace", "supervisor:vocab", "--limit", "x", "--json"], env);
    assert.equal(badLimit.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: prune honours the fake clock and --scope, returning the retired keys", () => {
  const dir = tempRoot();
  const dbPath = join(dir, "agent-state.sqlite");
  const t0 = "2026-01-01T00:00:00.000Z";
  const t2 = "2026-01-01T00:02:00.000Z";
  try {
    const envT0 = cliEnv(dbPath, { LA_AGENT_STATE_NOW: t0 });
    const withTtl = runCliSync(
      ["set", "--namespace", "supervisor:clock", "--key", "ttl_thing", "--value", "v", "--reason", "r", "--ttl", "60", "--json"],
      envT0
    );
    assert.equal(withTtl.status, 0, `stderr: ${withTtl.stderr}`);
    const scoped = runCliSync(
      ["set", "--namespace", "supervisor:clock", "--key", "scoped_thing", "--value", "v", "--reason", "r", "--json"],
      envT0
    );
    assert.equal(scoped.status, 0, `stderr: ${scoped.stderr}`);

    // two minutes later the 60 s ttl is long past; both keys are default scope task
    const pr = runCliSync(
      ["prune", "--namespace", "supervisor:clock", "--scope", "task", "--json"],
      cliEnv(dbPath, { LA_AGENT_STATE_NOW: t2 })
    );
    assert.equal(pr.status, 0, `stderr: ${pr.stderr}`);
    const prJson = JSON.parse(pr.stdout);
    assert.ok(Array.isArray(prJson.retired));
    assert.deepEqual([...prJson.retired].sort(), ["scoped_thing", "ttl_thing"]);

    const store = openAgentState(dbPath);
    try {
      for (const key of ["ttl_thing", "scoped_thing"]) {
        const row = store.db.prepare("SELECT status FROM facts WHERE namespace = ? AND key = ?").get("supervisor:clock", key);
        assert.equal(row.status, "retired", `key ${key}`);
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: render prints the working-state header", () => {
  const dir = tempRoot();
  const env = cliEnv(join(dir, "agent-state.sqlite"));
  try {
    const seed = runCliSync(
      ["set", "--namespace", "supervisor:show", "--key", "active_issue", "--value", "FOC-1", "--reason", "test", "--json"],
      env
    );
    assert.equal(seed.status, 0, `stderr: ${seed.stderr}`);
    const rendered = runCliSync(["render", "--namespace", "supervisor:show"], env);
    assert.equal(rendered.status, 0, `stderr: ${rendered.stderr}`);
    assert.ok(rendered.stdout.startsWith("=== WORKING STATE ==="), `stdout: ${rendered.stdout}`);
    assert.ok(rendered.stdout.includes("active_issue: FOC-1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: history returns the op chain for one key", () => {
  const dir = tempRoot();
  const env = cliEnv(join(dir, "agent-state.sqlite"));
  try {
    const steps = [
      ["set", "--namespace", "supervisor:chain", "--key", "chained", "--value", "v1", "--reason", "r", "--json"],
      ["set", "--namespace", "supervisor:chain", "--key", "chained", "--value", "v2", "--reason", "r", "--json"],
      ["retire", "--namespace", "supervisor:chain", "--key", "chained", "--reason", "done", "--json"],
    ];
    for (const args of steps) {
      const res = runCliSync(args, env);
      assert.equal(res.status, 0, `${args[0]}: stderr ${res.stderr}`);
    }
    const hist = runCliSync(["history", "--namespace", "supervisor:chain", "--key", "chained", "--json"], env);
    assert.equal(hist.status, 0, `stderr: ${hist.stderr}`);
    const rows = JSON.parse(hist.stdout).rows;
    assert.ok(Array.isArray(rows));
    assert.deepEqual(rows.map((r) => r.op), ["set", "update", "retire"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two concurrent writer processes leave an intact store (100 facts, 100 history rows)", async () => {
  const dir = tempRoot();
  const dbPath = join(dir, "agent-state.sqlite");
  try {
    // The cap is 50 active agent keys per namespace, so each writer gets its
    // own namespace and writes exactly 50 keys — 100 facts rows in total.
    const driver = (namespace, prefix) => `
import { openAgentState, setFact } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
const store = openAgentState(${JSON.stringify(dbPath)});
for (let i = 0; i < 50; i++) {
  setFact(store, {
    namespace: ${JSON.stringify(namespace)},
    key: ${JSON.stringify(prefix)} + "_" + i,
    value: "v" + i,
    reason: "load",
    now: "2026-01-01T00:00:00.000Z",
  });
}
store.close();
`;
    const run = (namespace, prefix) =>
      new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", driver(namespace, prefix)],
          { stdio: ["ignore", "ignore", "pipe"] }
        );
        let errText = "";
        child.stderr.on("data", (chunk) => {
          errText += chunk;
        });
        child.on("close", (code) => resolvePromise({ code, errText }));
        child.on("error", rejectPromise);
      });

    const [a, b] = await Promise.all([
      run("supervisor:load_a", "a"),
      run("supervisor:load_b", "b"),
    ]);
    assert.equal(a.code, 0, `writer A stderr: ${a.errText}`);
    assert.equal(b.code, 0, `writer B stderr: ${b.errText}`);

    const store = openAgentState(dbPath);
    try {
      assert.equal(dbCount(store, "facts"), 100);
      assert.equal(dbCount(store, "facts_history"), 100);
      assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      store.close();
    }

    // Phase 2 — the cap under a race: seed 49 active agent keys, then two
    // children at the same time each try to land ONE distinct 50th key in the
    // namespace. Exactly one wins; the loser gets AGENT_KEY_CAP and still
    // exits 0 so the supervisor can react to the outcome, not the crash.
    const raceNs = "supervisor:race";
    const seeder = openAgentState(dbPath);
    try {
      for (let i = 0; i < AGENT_KEY_CAP - 1; i++) {
        setFact(seeder, {
          namespace: raceNs,
          key: `seed_${String(i).padStart(2, "0")}`,
          value: "v",
          reason: "seed",
          now: "2026-01-01T00:00:00.000Z",
        });
      }
    } finally {
      seeder.close();
    }

    const racer = (key) => `
import { AgentStateError, openAgentState, setFact } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
const store = openAgentState(${JSON.stringify(dbPath)});
try {
  setFact(store, {
    namespace: ${JSON.stringify(raceNs)},
    key: ${JSON.stringify(key)},
    value: "v",
    reason: "race",
    now: "2026-01-01T00:00:00.000Z",
  });
  console.log("ok");
} catch (error) {
  if (error instanceof AgentStateError && error.code === "AGENT_KEY_CAP") {
    console.log("cap");
  } else {
    console.error(error.message);
    process.exit(1);
  }
}
store.close();
`;
    const race = (key) =>
      new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", racer(key)],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        let outText = "";
        let errText = "";
        child.stdout.on("data", (chunk) => {
          outText += chunk;
        });
        child.stderr.on("data", (chunk) => {
          errText += chunk;
        });
        child.on("close", (code) => resolvePromise({ code, outText, errText }));
        child.on("error", rejectPromise);
      });

    const [raceA, raceB] = await Promise.all([race("a_cap"), race("b_cap")]);
    assert.equal(raceA.code, 0, `racer A stderr: ${raceA.errText}`);
    assert.equal(raceB.code, 0, `racer B stderr: ${raceB.errText}`);
    assert.deepEqual([raceA.outText.trim(), raceB.outText.trim()].sort(), ["cap", "ok"]);

    const raceStore = openAgentState(dbPath);
    try {
      const active = raceStore.db
        .prepare("SELECT count(*) AS n FROM facts WHERE namespace = ? AND tier = 'agent' AND status = 'active'")
        .get(raceNs).n;
      assert.equal(active, AGENT_KEY_CAP);
      const landed = raceStore.db
        .prepare("SELECT count(*) AS n FROM facts WHERE namespace = ? AND key IN ('a_cap','b_cap')")
        .get(raceNs).n;
      assert.equal(landed, 1);
      const history = raceStore.db
        .prepare("SELECT count(*) AS n FROM facts_history WHERE namespace = ?")
        .get(raceNs).n;
      assert.equal(history, AGENT_KEY_CAP); // 49 seeds + exactly one winner
      assert.equal(raceStore.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      raceStore.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});