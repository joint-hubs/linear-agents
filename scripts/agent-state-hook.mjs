// agent-state-hook.mjs — the SessionStart hook that re-injects the WORKING
// STATE block (FOC-729, task 3/5). Fired on startup, resume, clear and compact
// for the Supervisor and every squad child; namespace and role come from the
// inherited env (LA_SUPERVISOR_RUN / LA_SUPERVISOR_CHILD / FENIX_STAGE).
//
// Resolve runs OFFLINE — Linear keys and the fixture are stripped from the env
// handed to the resolvers — because a context-loss moment must never wait on
// the network. Any failure prints exactly one line and exits 0: a hook that
// fails must never fail the session it hooks into.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentStatePath, openAgentState, renderFacts } from "./agent-state.mjs";
import { resolveRole, runIdOfNamespace } from "./agent-state-resolve.mjs";
import { SQUAD_ROLES, loadRegistry, registryPath } from "./agent-state-registry.mjs";
import { runDir } from "./supervisor-lib.mjs";
import { readCurrentRun } from "./supervisor-current-run.mjs";

const unavailable = (message) => ({
  code: 0,
  text: `WORKING STATE unavailable: ${message}`,
  record: null,
});

// LA_AGENT_STATE_NOW pins the clock like in the other CLIs; an unparsable value
// is a thrown error so the outer catch renders the one-line unavailable form.
function pinnedNow(env) {
  const raw = env.LA_AGENT_STATE_NOW;
  if (raw == null || raw === "") return new Date().toISOString();
  if (!Number.isFinite(Date.parse(raw))) {
    throw new Error("LA_AGENT_STATE_NOW must be an ISO date");
  }
  return raw;
}

/**
 * Run one hook invocation. Always resolves { code: 0, text, record } — the
 * caller prints `text` verbatim; `record` is the JSONL row written under the
 * run dir (or null when the namespace has no run dir, the dir is gone, or the
 * append failed — the block still prints).
 */
export async function runHook({ argv = [], env = process.env, stdin = "", now } = {}) {
  try {
    let payload;
    try {
      payload = JSON.parse(stdin);
    } catch {
      payload = {};
    }
    if (payload == null || typeof payload !== "object") payload = {};
    const source = typeof payload.source === "string" && payload.source ? payload.source : "startup";

    // ── namespace and role, from the env alone ───────────────────────────────
    let namespace;
    let role;
    if (env.LA_SUPERVISOR_CHILD) {
      if (!env.LA_SUPERVISOR_RUN) return unavailable("no run id");
      namespace = `child:${env.LA_SUPERVISOR_RUN}/${env.LA_SUPERVISOR_CHILD}`;
      role = env.FENIX_STAGE;
      if (!SQUAD_ROLES.includes(role)) return unavailable(`unknown role "${role}"`);
    } else {
      let runId = env.LA_SUPERVISOR_RUN || null;
      if (!runId) {
        // A missing or unreadable current-run pointer is "no run id", not a crash.
        // A pointer at a run whose directory is gone is not adopted either: the
        // resolve would become the first thing to recreate that directory.
        try {
          const pointer = readCurrentRun();
          if (pointer?.runId && existsSync(runDir(pointer.runId))) runId = pointer.runId;
        } catch {
          runId = null;
        }
      }
      if (!runId) return unavailable("no run id");
      namespace = `supervisor:${runId}`;
      role = "supervisor";
    }

    const at = now ?? pinnedNow(env);

    // The hook never touches the network and never reads a fixture: the resolvers
    // see this env with every Linear credential removed, so Linear facts arrive
    // only through spawn seeding, an explicit resolve, or a hold answer.
    const offlineEnv = { ...env };
    delete offlineEnv.LINEAR_API_KEY;
    delete offlineEnv.LINEAR_API_KEY_PISI;
    delete offlineEnv.LINEAR_WORKSPACE;
    delete offlineEnv.LA_AGENT_STATE_LINEAR_FIXTURE;

    let resolved = [];
    let missing = [];
    let store;
    let resolvedDone = false;
    try {
      store = openAgentState(agentStatePath(env));
      const registry = loadRegistry(registryPath(env));
      ({ resolved, missing } = await resolveRole(store, {
        registry,
        role,
        namespace,
        env: offlineEnv,
        cwd: env.PWD || process.cwd(),
        now: at,
        actor: "agent-state-hook",
      }));
      resolvedDone = true;
      // Test seam — both vars must be set, so a stray LA_AGENT_STATE_HOOK_FAIL_RENDER
      // on a real session can never trip it.
      if (env.LA_AGENT_STATE_TEST_SEAMS === "1" && env.LA_AGENT_STATE_HOOK_FAIL_RENDER === "1") {
        throw new Error("injected render failure (test seam)");
      }
      const { text, lines, omitted } = renderFacts(store, { namespace });
      const bytes = Buffer.byteLength(text, "utf8");

      // Record own-invocation, one row per render — the measurement input for
      // FOC-731. Best effort: a failed append must not cost the block.
      let record = null;
      const nsRunId = runIdOfNamespace(namespace);
      if (nsRunId && existsSync(runDir(nsRunId))) {
        record = {
          at,
          namespace,
          role,
          source,
          lines,
          omitted,
          bytes,
          resolved: resolved.length,
          missing: missing.length,
        };
        try {
          appendFileSync(join(runDir(nsRunId), "agent-state-renders.jsonl"), `${JSON.stringify(record)}\n`);
        } catch {
          record = null;
        }
      }
      return { code: 0, text, record };
    } catch (err) {
      if (resolvedDone) {
        // Resolve already succeeded, so the invocation itself is measured even
        // when a later step failed — a zero-count row carrying the error keeps
        // the FOC-731 denominator honest. The append failure itself is swallowed.
        try {
          const nsRunId = runIdOfNamespace(namespace);
          if (nsRunId && existsSync(runDir(nsRunId))) {
            appendFileSync(
              join(runDir(nsRunId), "agent-state-renders.jsonl"),
              `${JSON.stringify({
                at,
                namespace,
                role,
                source,
                lines: 0,
                omitted: 0,
                bytes: 0,
                resolved: resolved.length,
                missing: missing.length,
                error: err?.message ?? String(err),
              })}\n`,
            );
          }
        } catch {
          // nothing to do — the unavailable line below still prints
        }
      }
      return unavailable(err?.code ? `${err.message} (${err.code})` : err?.message ?? String(err));
    } finally {
      if (store) {
        try {
          store.close();
        } catch {
          // nothing to do — the block already printed or the outer catch ran
        }
      }
    }
  } catch (err) {
    return unavailable(err?.code ? `${err.message} (${err.code})` : err?.message ?? String(err));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The hook runner always pipes the payload, so stdin is a pipe here; a manual
  // TTY invocation needs `< /dev/null` (or an echo pipe) or this read blocks.
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    stdin = "";
  }
  runHook({ argv: process.argv.slice(2), env: process.env, stdin })
    .then(({ text }) => {
      process.stdout.write(`${text}\n`);
      process.exitCode = 0;
    })
    .catch((err) => {
      // Unreachable while runHook catches everything — kept as the last guard.
      process.stdout.write(`WORKING STATE unavailable: ${err?.message ?? String(err)}\n`);
      process.exitCode = 0;
    });
}