// scripts/supervisor-ask-guard.mjs — PreToolUse hook that forces the human gate
// on dangerous Bash spellings (FOC-978).
//
// Proven gap on the VM: the Supervisor ran `git -C /data/workspaces/linear-agents
// push -u origin <branch>`. The permissions.ask prefix rules ("Bash(git push:*)",
// "Bash(gh pr merge:*)", ...) are literal prefixes and matched nothing — the
// auto-mode classifier let the push through and the human-approval prompt never
// appeared. This hook is the belt under those suspenders: before any Bash call,
// it re-derives the underlying op the way a shell would (tokenizer, no execution)
// and forces `permissionDecision: "ask"` when the op is one of the gated ones,
// whatever prefix spelling it arrived in.
//
// What the classifier covers (every row pinned in supervisor-ask-guard.test.mjs):
//   · ops: git push, git clean, git reset --hard, git branch -D, gh pr merge,
//     rm -rf.
//   · git globals before the subcommand: -C/-c (attached values too), --git-dir,
//     --work-tree, --namespace, --exec-path, --no-pager, -P, --bare, ...
//   · wrappers, nesting included: sudo, env (VAR=val), nohup, time, timeout
//     (its duration operand), nice, exec, xargs, stdbuf, ionice, chrt, setsid,
//     command.
//   · shells at any path (sh/bash/dash/zsh/ash/ksh) with any short flag cluster
//     containing c (-c, -lc, -ec, -xc), up to three levels deep; eval recurses
//     the same way.
//   · command separators: &&, ||, ;, |, newlines, a single background & (but
//     not the &> / >& / 2>&1 redirect spellings), subshell ( ), braces { },
//     command substitution $( ) and ` ` — quoted mentions stay data.
//   · heredoc bodies are stripped before tokenizing, so `cat <<EOF` data lines
//     are never classified as commands.
// Known residual gaps, deliberately out of scope: `find -delete`, `node -e`
// spawning git, scripts that push internally. The human gate on the
// push-approval is the real control; this hook only widens the net.
//
// Contract with the harness:
//   · stdin  : `{ tool_name, tool_input: { command } }`
//   · stdout : on a match, one ask decision JSON; otherwise nothing. Ever.
//   · exit   : 0 always — an internal error must not block the Supervisor, but
//     it fails toward asking when the raw input clearly names `git` and `push`.
//
// Run: wired in agents/supervisor/settings.json as
//   node "$LA_ROOT/scripts/supervisor-ask-guard.mjs"

import { fileURLToPath } from "node:url";

// ── heredoc stripping ──────────────────────────────────────────────────────────
// A line containing `<<MARK` (also `<<-`, quoted or bare) makes every following
// line shell DATA until a line equal to MARK — `cat <<EOF\ngit push\nEOF` must
// not classify the body as a command. Approximation: the marker regex runs on
// the raw line without parsing quotes.

function stripHeredocs(command) {
  if (!command.includes("<<")) return command;
  const lines = command.split("\n");
  const kept = [];
  const markers = [];
  for (const line of lines) {
    if (markers.length) {
      if (line.trim() === markers[0]) markers.shift();
      continue; // heredoc body (and its terminator) is data, not commands
    }
    const re = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
    let m;
    while ((m = re.exec(line))) markers.push(m[2]);
    kept.push(line);
  }
  return kept.join("\n");
}

// ── tokenizer ──────────────────────────────────────────────────────────────────
// Splits a shell command line into tokens, respecting single/double quotes and
// backslash escapes, and cuts simple commands at &&, ||, ;, |, a single
// background &, newlines, and — outside quotes — ( ) { } ` and $( so the inner
// command is classified. Redirect spellings (&>, >& / 2>&1) stay one token.
// No shell is ever executed.

function tokenize(command) {
  const simpleCommands = [];
  let cur = [];
  let tok = "";
  let i = 0;
  const flushToken = () => {
    if (tok !== "" || cur.length) {
      if (tok !== "") cur.push(tok);
      tok = "";
    }
  };
  const flushCommand = () => {
    flushToken();
    if (cur.length) simpleCommands.push(cur);
    cur = [];
  };
  while (i < command.length) {
    const ch = command[i];
    if (ch === "'") {
      // single quotes: everything literal until the closing quote
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        tok += command.slice(i + 1);
        i = command.length;
      } else {
        tok += command.slice(i + 1, end);
        i = end + 1;
      }
      continue;
    }
    if (ch === '"') {
      // double quotes: honour backslash escapes, keep everything else literal
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) {
          tok += command[i + 1];
          i += 2;
        } else {
          tok += command[i];
          i++;
        }
      }
      i++; // closing quote
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      tok += command[i + 1];
      i += 2;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      flushCommand();
      i += 2;
      continue;
    }
    if (ch === "&") {
      // background separator — unless it is part of a redirect (&> / >& / 2>&1)
      if (command[i + 1] === ">" || tok.endsWith(">")) {
        tok += ch;
        i++;
        continue;
      }
      flushCommand();
      i++;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      flushCommand();
      i += 2;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n" || ch === "\r") {
      flushCommand();
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "`") {
      flushCommand();
      i++;
      continue;
    }
    if (
      (ch === "{" || ch === "}") &&
      (tok === "" || /[\s;|&]/.test(command[i + 1] ?? " "))
    ) {
      // brace only splits when it stands alone at a word edge, not mid-word
      flushCommand();
      i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flushToken();
      i++;
      continue;
    }
    tok += ch;
    i++;
  }
  flushCommand();
  return simpleCommands;
}

// ── per-simple-command classification ─────────────────────────────────────────

const WRAPPERS = new Set([
  "env", "sudo", "command", "nohup", "time", "stdbuf", "ionice", "chrt",
  "setsid", "timeout", "nice", "exec", "xargs",
]);
// Wrapper flags that swallow the next token as their value.
const WRAPPER_VALUE_FLAGS = {
  sudo: ["-u", "-g", "-C"],
  nice: ["-n"],
  env: ["-u", "-C"],
  timeout: ["-s", "-k"],
  ionice: ["-c", "-n"],
  stdbuf: ["-i", "-o", "-e"],
  exec: ["-a"],
  xargs: ["-I", "-n", "-P", "-s"],
};
const VAR_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ash", "ksh"]);
const GIT_SUBCOMMANDS = new Set([
  "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle",
  "checkout", "cherry", "cherry-pick", "citool", "clean", "clone", "commit", "describe",
  "diff", "fetch", "format-patch", "gc", "grep", "gui", "init", "instaweb", "log",
  "maintenance", "merge", "mergetool", "mv", "notes", "pull", "push", "range-diff",
  "rebase", "reflog", "remote", "repack", "replace", "request-pull", "reset", "restore",
  "revert", "rm", "shortlog", "show", "show-branch", "sparse-checkout", "stage",
  "stash", "status", "submodule", "switch", "symbolic-ref", "tag", "whatchanged", "worktree",
]);

// basename("C:\\Program\\git.exe") / basename("/usr/bin/git") → "git"
function basename(path) {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

// Drop git's global options before the subcommand. Returns the index of the
// first token that is not a global option (or an option's value).
function skipGitGlobals(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "--namespace" || t === "--exec-path") {
      i += 2; // both take one value
      continue;
    }
    if (t.startsWith("--git-dir=") || t.startsWith("--work-tree=") || t.startsWith("--namespace=") || t.startsWith("--exec-path=")) {
      i += 1;
      continue;
    }
    if (/^-[Cc]./.test(t)) {
      i += 1; // attached value: -C<path>, -c<key=val>
      continue;
    }
    if (t === "--no-pager" || t === "-P" || t === "--bare" || t === "--literal-pathspecs" || t === "--no-replace-objects") {
      i += 1; // flagless global: more options may follow
      continue;
    }
    return i; // first non-global token = the subcommand position
  }
  return i;
}

// Drop gh's repo selectors. Returns the index of the first non-selector token.
function skipGhGlobals(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-R" || t === "--repo") return i + 2;
    if (t.startsWith("--repo=")) return i + 1;
    return i;
  }
  return i;
}

function classifySimple(tokens, depth) {
  if (!tokens.length) return null;

  // Strip leading wrappers (with their flags), VAR=value assignments and
  // env-style assignments until the real command. Wrappers nest, so re-test.
  let start = 0;
  while (start < tokens.length) {
    const t = tokens[start];
    if (VAR_ASSIGN.test(t)) {
      start++;
      continue;
    }
    if (!WRAPPERS.has(t)) break;
    start++;
    const valueFlags = WRAPPER_VALUE_FLAGS[t] ?? [];
    while (start < tokens.length) {
      const f = tokens[start];
      if (f === "--") {
        start++; // end of the wrapper's options
        break;
      }
      if (!f.startsWith("-") || f === "-") break;
      start++;
      if (valueFlags.includes(f)) start++; // flag with a separate value
    }
    if (t === "timeout" && start < tokens.length && !tokens[start].startsWith("-")) {
      start++; // timeout's first operand is the duration, not the command
    }
  }
  if (start >= tokens.length) return null;
  const cmd = tokens[start];

  // sh -c '<cmd>' / bash -lc "<cmd>" / eval '...' — classify the inner string,
  // up to three levels deep.
  if (depth < 3) {
    if (cmd === "eval") {
      const inner = tokens.slice(start + 1).join(" ");
      return inner ? classifyDangerous(inner, depth + 1) : null;
    }
    if (SHELLS.has(basename(cmd))) {
      for (let j = start + 1; j < tokens.length; j++) {
        const t = tokens[j];
        if (t === "--") break;
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) {
          const inner = tokens.slice(j + 1).join(" ");
          return inner ? classifyDangerous(inner, depth + 1) : null;
        }
        if (!t.startsWith("-")) break; // first operand without -c: no inner command
      }
    }
  }

  const program = basename(cmd);

  if (program === "git") {
    const subIdx = skipGitGlobals(tokens.slice(start));
    if (subIdx >= tokens.slice(start).length) return null;
    const rest = tokens.slice(start).slice(subIdx);
    const sub = rest[0];
    if (!GIT_SUBCOMMANDS.has(sub)) return null;
    const args = rest.slice(1);
    if (sub === "push") return { op: "git push", reason: "push needs the push-approval gate" };
    if (sub === "clean") return { op: "git clean", reason: "wipes untracked files" };
    if (sub === "reset" && args.includes("--hard"))
      return { op: "git reset --hard", reason: "hard history rewrite" };
    if (sub === "branch") {
      let deleteLong = false;
      let forceLong = false;
      let clusterD = false;
      let clusterF = false;
      for (const a of args) {
        if (a === "--delete") deleteLong = true;
        else if (a === "--force") forceLong = true;
        else if (a.startsWith("-") && !a.startsWith("--")) {
          if (a.slice(1).includes("D")) clusterD = true;
          if (a.slice(1).includes("f")) clusterF = true;
        }
      }
      if (clusterD || (deleteLong && (forceLong || clusterF)))
        return { op: "git branch -D", reason: "force-deletes a branch" };
    }
    return null;
  }

  if (program === "gh") {
    const subIdx = skipGhGlobals(tokens.slice(start));
    if (subIdx >= tokens.slice(start).length) return null;
    const rest = tokens.slice(start).slice(subIdx);
    if (rest[0] === "pr" && rest[1] === "merge")
      return { op: "gh pr merge", reason: "merging is the delivery owner's call" };
    return null;
  }

  if (program === "rm") {
    let recursive = false;
    let force = false;
    for (const a of tokens.slice(start + 1)) {
      if (a === "--recursive") recursive = true;
      else if (a === "--force") force = true;
      else if (a.startsWith("-") && !a.startsWith("--")) {
        const cluster = a.slice(1);
        if (cluster.includes("r") || cluster.includes("R")) recursive = true;
        if (cluster.includes("f")) force = true;
      }
    }
    if (recursive && force) return { op: "rm -rf", reason: "recursive force delete" };
  }

  return null;
}

// classifyDangerous(command) → null | { op, reason }
export function classifyDangerous(command, depth = 0) {
  const simpleCommands = tokenize(stripHeredocs(command));
  for (const tokens of simpleCommands) {
    const verdict = classifySimple(tokens, depth);
    if (verdict) return verdict;
  }
  return null;
}

// ── hook entry point ───────────────────────────────────────────────────────────

function askDecision(op, reason) {
  return (
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask",' +
    `"permissionDecisionReason":"FOC-978: ${op} needs your approval (${reason})"}}`
  );
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let hook = null;
  try {
    hook = JSON.parse(raw);
  } catch {
    return; // not our shape — stay silent
  }
  if (!hook || hook.tool_name !== "Bash") return;
  const command = hook?.tool_input?.command;
  if (typeof command !== "string" || command === "") return;

  let verdict = null;
  try {
    verdict = classifyDangerous(command);
  } catch {
    // internal error: fail toward asking only when the input clearly names
    // both git and push — otherwise stay silent and let the harness decide.
    const lowered = command.toLowerCase();
    if (lowered.includes("push") && lowered.includes("git"))
      verdict = { op: "git push (?)", reason: "guard internal error — failing toward asking" };
  }
  if (verdict) process.stdout.write(askDecision(verdict.op, verdict.reason) + "\n");
}

// Run only when executed directly (not when imported by the test).
const invokedAs = process.argv[1] ? process.argv[1].replace(/\\/g, "/").toLowerCase() : "";
const thisFile = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
if (invokedAs.endsWith("supervisor-ask-guard.mjs") && thisFile.endsWith(invokedAs)) {
  main().catch(() => {});
}
