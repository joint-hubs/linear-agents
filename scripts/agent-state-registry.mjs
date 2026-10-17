// agent-state-registry.mjs — the validated base-key registry (FOC-728, task 2/5).
//
// config/agent-state.json declares, per role set, which base keys exist and
// the deterministic resolver chains that fill them. The file is Mateusz-owned;
// loadRegistry fail-closes on anything it cannot fully validate, so a
// hand-edit can never half-apply. keysForRole orders the `all` set first,
// then the role's own set (supervisor, or child for the squad roles).

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

import { AgentStateError } from "./agent-state.mjs";

export const REGISTRY_VERSION = 1;
export const RESOLVER_KINDS = [
  "arg",
  "env",
  "current-run",
  "registry",
  "git",
  "git-basename",
  "linear",
  "projects-config",
  "state-md",
  "const",
  "template",
];
export const SQUAD_ROLES = ["plan", "dev", "review", "test"];

const KEY_PATTERN = "^[a-z][a-z0-9_]{0,63}$";
const ENV_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";

// Same seam discipline as fenix-paths: read the env at call time, never cache
// at import, so tests can point LA_ROOT (and LA_AGENT_STATE_REGISTRY) anywhere.
export function laRoot(env = process.env) {
  if (env.LA_ROOT) return resolve(env.LA_ROOT);
  return resolve(fileURLToPath(new URL("..", import.meta.url)));
}

export function registryPath(env = process.env) {
  if (env.LA_AGENT_STATE_REGISTRY) return resolve(env.LA_AGENT_STATE_REGISTRY);
  return join(laRoot(env), "config", "agent-state.json");
}

const ENTRY_SCHEMA = {
  type: "object",
  required: ["description", "resolvers", "askIfMissing", "refresh"],
  additionalProperties: false,
  properties: {
    description: { type: "string", minLength: 1 },
    resolvers: { type: "array", items: { type: "object", required: ["kind"], additionalProperties: true } },
    askIfMissing: { type: "boolean" },
    refresh: { enum: ["once", "always"] },
  },
};

const ROLE_SET_SCHEMA = {
  type: "object",
  propertyNames: { pattern: KEY_PATTERN },
  additionalProperties: ENTRY_SCHEMA,
};

export const REGISTRY_SCHEMA = {
  type: "object",
  required: ["version", "roles"],
  additionalProperties: false,
  properties: {
    _doc: { type: "string" },
    version: { const: REGISTRY_VERSION },
    roles: {
      type: "object",
      required: ["all", "supervisor", "child"],
      additionalProperties: false,
      properties: {
        all: ROLE_SET_SCHEMA,
        supervisor: ROLE_SET_SCHEMA,
        child: ROLE_SET_SCHEMA,
      },
    },
  },
};

// The kind enum and each kind's required args are enforced in code (not in the
// schema) so the error names the offending key in registry notation:
// roles.child.issue.resolvers[1]: unknown kind "foo".
const KIND_REQUIRED_ARGS = {
  arg: ["name"],
  env: ["name"],
  "current-run": [],
  registry: ["field"],
  git: ["fact"],
  "git-basename": [],
  linear: ["issueKey", "field"],
  "projects-config": ["field"],
  "state-md": ["label"],
  const: ["value"],
  template: ["value"],
};

const KIND_ENUMS = {
  git: { arg: "fact", values: ["root", "branch", "head"] },
  registry: { arg: "field", values: ["worktree", "branch", "baseRevision", "taskId", "squad", "candidate"] },
  linear: { arg: "field", values: ["title", "project", "projectMilestone", "parent", "team"] },
  "projects-config": { arg: "field", values: ["linearProject", "workspace", "teamKey"] },
};

let compiled = null;
function validator() {
  if (!compiled) compiled = new Ajv({ allErrors: false }).compile(REGISTRY_SCHEMA);
  return compiled;
}

// Every kind's allowed sibling fields — anything else is a typo and is named.
const KIND_FIELDS = {
  arg: ["kind", "name"],
  env: ["kind", "name"],
  "current-run": ["kind"],
  registry: ["kind", "field"],
  git: ["kind", "fact"],
  "git-basename": ["kind"],
  linear: ["kind", "issueKey", "field"],
  "projects-config": ["kind", "field"],
  "state-md": ["kind", "label"],
  const: ["kind", "value"],
  template: ["kind", "value"],
};

// Keys are the registry's own namespace: a bad one is named in registry
// notation (roles.<set>: key "Bad-Key" …), not in ajv's path-only wording, so
// this runs as a code loop ahead of the ajv check.
function validateKeyNames(parsed, path) {
  const roles = parsed?.roles;
  if (roles == null || typeof roles !== "object") return; // ajv reports the shape
  for (const set of ["all", "supervisor", "child"]) {
    const entries = roles[set];
    if (entries == null || typeof entries !== "object") continue;
    for (const key of Object.keys(entries)) {
      if (!new RegExp(KEY_PATTERN).test(key)) {
        throw new AgentStateError(
          "REGISTRY_INVALID",
          `${path}: roles.${set}: key ${JSON.stringify(key)} must match ${KEY_PATTERN}`,
        );
      }
    }
  }
}

function validateKinds(parsed, path) {
  for (const set of ["all", "supervisor", "child"]) {
    // issueKey/template placeholders may reference keys of the same set or of
    // the shared `all` set — anything else is a typo and is named.
    const declared = new Set([
      ...Object.keys(parsed.roles.all ?? {}),
      ...(set === "all" ? [] : Object.keys(parsed.roles[set] ?? {})),
    ]);
    for (const [key, entry] of Object.entries(parsed.roles[set])) {
      entry.resolvers.forEach((resolver, index) => {
        const at = `roles.${set}.${key}.resolvers[${index}]`;
        if (typeof resolver.kind !== "string") {
          throw new AgentStateError("REGISTRY_INVALID", `${path}: ${at}: missing "kind"`);
        }
        const kind = resolver.kind;
        if (!RESOLVER_KINDS.includes(kind)) {
          throw new AgentStateError("REGISTRY_INVALID", `${path}: ${at}: unknown kind ${JSON.stringify(kind)}`);
        }
        const absent = KIND_REQUIRED_ARGS[kind].filter(
          (name) => typeof resolver[name] !== "string" || resolver[name] === "",
        );
        if (absent.length > 0) {
          throw new AgentStateError(
            "REGISTRY_INVALID",
            `${path}: ${at}: kind "${kind}" needs ${absent.map((n) => `"${n}"`).join(", ")}`,
          );
        }
        const spec = KIND_ENUMS[kind];
        if (spec && !spec.values.includes(resolver[spec.arg])) {
          throw new AgentStateError(
            "REGISTRY_INVALID",
            `${path}: ${at}: kind "${kind}" ${spec.arg} must be one of ${spec.values.join("|")}, ` +
              `got ${JSON.stringify(resolver[spec.arg])}`,
          );
        }
        if (kind === "arg" && resolver.name !== "role") {
          throw new AgentStateError(
            "REGISTRY_INVALID",
            `${path}: ${at}: arg name must be "role", got ${JSON.stringify(resolver.name)}`,
          );
        }
        if (kind === "env" && !new RegExp(ENV_NAME_PATTERN).test(resolver.name)) {
          throw new AgentStateError(
            "REGISTRY_INVALID",
            `${path}: ${at}: env name ${JSON.stringify(resolver.name)} must match ${ENV_NAME_PATTERN}`,
          );
        }
        const unknownField = Object.keys(resolver).find((field) => !KIND_FIELDS[kind].includes(field));
        if (unknownField != null) {
          throw new AgentStateError(
            "REGISTRY_INVALID",
            `${path}: ${at}: unknown field ${JSON.stringify(unknownField)} for kind "${kind}"`,
          );
        }
        if (kind === "linear" && !declared.has(resolver.issueKey)) {
          throw new AgentStateError(
            "REGISTRY_INVALID",
            `${path}: ${at}: issueKey ${JSON.stringify(resolver.issueKey)} is not a declared key`,
          );
        }
        if (kind === "template") {
          for (const match of String(resolver.value).matchAll(/\{([^{}]+)\}/g)) {
            if (!declared.has(match[1])) {
              throw new AgentStateError(
                "REGISTRY_INVALID",
                `${path}: ${at}: template placeholder "${match[0]}" is not a declared key`,
              );
            }
          }
        }
      });
    }
  }
}

function validateNoDuplicates(parsed, path) {
  const sets = ["all", "supervisor", "child"];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      for (const key of Object.keys(parsed.roles[sets[i]])) {
        if (key in parsed.roles[sets[j]]) {
          throw new AgentStateError(
            "REGISTRY_INVALID",
            `${path}: duplicate key "${key}" in roles.${sets[i]} and roles.${sets[j]}`,
          );
        }
      }
    }
  }
}

export function loadRegistry(path = registryPath()) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new AgentStateError("REGISTRY_INVALID", `${path}: cannot be read (${err.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AgentStateError("REGISTRY_INVALID", `${path}: not readable JSON (${err.message})`);
  }
  const check = validator();
  validateKeyNames(parsed, path);
  if (!check(parsed)) {
    const detail = (check.errors ?? [])
      .map((e) => `${e.instancePath || "/"}: ${e.message}`)
      .join("; ");
    throw new AgentStateError("REGISTRY_INVALID", `${path}: ${detail}`);
  }
  validateKinds(parsed, path);
  validateNoDuplicates(parsed, path);
  return parsed;
}

export function roleSet(role) {
  if (role !== "supervisor" && !SQUAD_ROLES.includes(role)) {
    throw new AgentStateError(
      "FIELD_INVALID",
      `role must be supervisor or one of ${SQUAD_ROLES.join("|")}, got ${JSON.stringify(role)}`,
    );
  }
  return role === "supervisor" ? "supervisor" : "child";
}

export function keysForRole(registry, role) {
  const set = roleSet(role);
  return [...Object.entries(registry.roles.all), ...Object.entries(registry.roles[set])];
}
