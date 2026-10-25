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
// Two more classes guard the Supervisor's boundary INSIDE the Fenix container
// only (FENIX_IN_CONTAINER=1 — natively the Supervisor works in the very repo
// whose code it edits and there is no child uid to protect):
//   · FOC-988 — Fenix's own code (LA_ROOT, /opt/fenix in the image). The
//     Supervisor patched it four times on the FOC-789 run, once disabling the
//     duplicate-child-id guard. Bash writes into that tree ask: redirects,
//     sed -i, tee, cp/mv/install/ln/rsync onto it, rm/chmod/touch/patch/truncate
//     of it, dd of=, and an inline interpreter (node -e, python -c, perl -e …)
//     that names the tree next to a write call. Edit/Write are denied in
//     settings.json. The filesystem is deliberately NOT read-only (Mateusz,
//     2026-10-23), so `node script.mjs` writing there is the residual gap —
//     `fenix doctor` reports the drift.
//   · FOC-1001 — git inside a child-owned worktree (LA_WORKTREE_HOME). The child
//     controls the tree and its per-worktree gitdir; a Supervisor git there with
//     safe.directory set runs child-planted config (core.fsmonitor was shown to
//     execute) as the Supervisor. `git config … safe.directory`, `-c
//     safe.directory=…`, GIT_CONFIG_* naming it, and any git whose `-C`,
//     `--git-dir`, `--work-tree`, preceding `cd`, or session cwd is under the
//     worktree root ask. The sanctioned way to READ such a tree is the scripts'
//     own sanitised invocation (supervisor-lib childTreeGit); pushes go from the
//     main checkout, where the branch ref is shared.
//
// Contract with the harness:
//   · stdin  : `{ tool_name, cwd?, tool_input: { command } }`
//   · stdout : on a match, one ask decision JSON; otherwise nothing. Ever.
//   · exit   : 0 always — an internal error must not block the Supervisor, but
//     it fails toward asking when the raw input clearly names `git` and `push`.
//
// Run: wired in agents/supervisor/settings.json as
//   node "$LA_ROOT/scripts/supervisor-ask-guard.mjs"

import { posix } from "node:path";
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

// Walk git's global options before the subcommand. Returns the index of the
// first token that is not a global option (or an option's value), plus the
// values the FOC-1001 boundary check needs: every -C directory in order, the
// --git-dir / --work-tree values, and every -c key=value.
function parseGitGlobals(tokens) {
  const out = { subIdx: 1, dirs: [], gitDirs: [], configs: [] };
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "--namespace" || t === "--exec-path") {
      const value = tokens[i + 1];
      if (value !== undefined) {
        if (t === "-C") out.dirs.push(value);
        else if (t === "-c") out.configs.push(value);
        else if (t === "--git-dir" || t === "--work-tree") out.gitDirs.push(value);
      }
      i += 2; // both take one value
      continue;
    }
    if (t.startsWith("--git-dir=") || t.startsWith("--work-tree=") || t.startsWith("--namespace=") || t.startsWith("--exec-path=")) {
      if (t.startsWith("--git-dir=") || t.startsWith("--work-tree=")) out.gitDirs.push(t.slice(t.indexOf("=") + 1));
      i += 1;
      continue;
    }
    if (/^-[Cc]./.test(t)) {
      if (t[1] === "C") out.dirs.push(t.slice(2));
      else out.configs.push(t.slice(2));
      i += 1; // attached value: -C<path>, -c<key=val>
      continue;
    }
    if (t === "--no-pager" || t === "-P" || t === "--bare" || t === "--literal-pathspecs" || t === "--no-replace-objects") {
      i += 1; // flagless global: more options may follow
      continue;
    }
    break; // first non-global token = the subcommand position
  }
  out.subIdx = i;
  return out;
}

// Drop git's global options before the subcommand. Returns the index of the
// first token that is not a global option (or an option's value).
function skipGitGlobals(tokens) {
  return parseGitGlobals(tokens).subIdx;
}

// ── the container boundary (FOC-988 / FOC-1001) ───────────────────────────────
// Everything below is inert unless the caller says it is inside the Fenix
// container (ctx.container) — see the header.

const CODE_ROOT_DEFAULT = "/opt/fenix";
const WORKTREE_ROOT_DEFAULT = "/data/workspaces/la-wt";

const trimRoot = (p) => posix.normalize(String(p)).replace(/\/+$/, "") || "/";
const codeRootOf = (ctx) => trimRoot(ctx?.env?.LA_ROOT || CODE_ROOT_DEFAULT);
const worktreeRootOf = (ctx) => trimRoot(ctx?.env?.LA_WORKTREE_HOME || WORKTREE_ROOT_DEFAULT);

// `$LA_ROOT` / `${LA_ROOT}` (and the worktree home) are the spellings the
// Supervisor actually types; expand them, leave every other variable alone.
function expandKnownVars(token, ctx) {
  return token
    .replace(/\$\{?LA_ROOT\}?/g, codeRootOf(ctx))
    .replace(/\$\{?LA_WORKTREE_HOME\}?/g, worktreeRootOf(ctx));
}

// Absolute posix path of `token` relative to `cwd`, or null when it cannot be
// resolved (an unknown variable, ~, command substitution residue).
function resolveAgainst(token, cwd, ctx) {
  if (typeof token !== "string" || token === "") return null;
  const expanded = expandKnownVars(token, ctx);
  if (/[$~`]/.test(expanded)) return null;
  const base = typeof cwd === "string" && cwd.startsWith("/") ? cwd : null;
  if (!expanded.startsWith("/") && base === null) return null;
  return posix.resolve(base ?? "/", expanded);
}

const isUnder = (abs, root) => abs !== null && (abs === root || abs.startsWith(`${root}/`));
const strictlyUnder = (abs, root) => abs !== null && abs.startsWith(`${root}/`);

const underCode = (token, ctx) => isUnder(resolveAgainst(token, ctx.cwd, ctx), codeRootOf(ctx));

// Redirect targets in a simple command: `> f`, `>f`, `>> f`, `2>f`, `&>f`, `>| f`.
// An fd duplication (`2>&1`, `>&2`) names no file.
function redirectTargets(tokens) {
  const targets = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const bare = /^(?:[0-9]*|&)>>?\|?$/.exec(t);
    if (bare) {
      if (tokens[i + 1] !== undefined) targets.push(tokens[i + 1]);
      continue;
    }
    const attached = /^(?:[0-9]*|&)>>?\|?(.+)$/.exec(t);
    if (attached && !attached[1].startsWith("&")) targets.push(attached[1]);
  }
  return targets;
}

const WRITE_ANY_ARG = new Set(["rm", "unlink", "rmdir", "truncate", "chmod", "chown", "chgrp", "touch", "patch", "shred", "mkdir", "tee", "mv"]);
const WRITE_DEST_LAST = new Set(["cp", "install", "rsync", "ln"]);
const INLINE_INTERPRETERS = new Set(["node", "nodejs", "python", "python3", "py", "perl", "ruby", "php"]);
const INLINE_FLAGS = new Set(["-e", "--eval", "-c", "-p", "-E", "-r"]);
// open() only counts with a write/append/exclusive mode as its second argument.
const MUTATING_CALL = /(?:write|append|unlink|rename|copyfile|rmdir|mkdir|truncate|chmod|symlink|\brm\b|sed\s+-i|fs\.rm|shutil|os\.remove|open\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+])/i;

// FOC-988: does this simple command (wrappers already stripped; `args` follow
// `program`) write into Fenix's own code?
function writesIntoCode(tokens, start, program, ctx) {
  for (const target of redirectTargets(tokens)) {
    if (underCode(target, ctx)) return true;
  }
  const args = tokens.slice(start + 1);
  const plain = args.filter((a) => !a.startsWith("-") && !/^\w+=/.test(a));
  if (program === "sed") {
    const inPlace = args.some((a) => a === "--in-place" || a.startsWith("--in-place=") || (/^-[A-Za-z]+/.test(a) && !a.startsWith("--") && a.slice(1).includes("i")));
    return inPlace && plain.some((a) => underCode(a, ctx));
  }
  if (program === "dd") return args.some((a) => a.startsWith("of=") && underCode(a.slice(3), ctx));
  if (WRITE_ANY_ARG.has(program)) return plain.some((a) => underCode(a, ctx));
  if (WRITE_DEST_LAST.has(program)) {
    const targetDir = args.findIndex((a) => a === "-t" || a === "--target-directory");
    if (targetDir !== -1 && args[targetDir + 1] !== undefined && underCode(args[targetDir + 1], ctx)) return true;
    const attached = args.find((a) => a.startsWith("--target-directory="));
    if (attached && underCode(attached.slice(attached.indexOf("=") + 1), ctx)) return true;
    return plain.length > 0 && underCode(plain[plain.length - 1], ctx);
  }
  // perl -pi / ruby -i edit the named files in place.
  if ((program === "perl" || program === "ruby") && args.some((a) => /^-[A-Za-z]*i/.test(a)) && plain.some((a) => underCode(a, ctx))) return true;
  if (INLINE_INTERPRETERS.has(program)) {
    const flagAt = args.findIndex((a) => INLINE_FLAGS.has(a) || /^-[A-Za-z]*[epc]$/.test(a));
    const code = flagAt === -1 ? "" : args.slice(flagAt + 1).join(" ");
    const names = code.includes(codeRootOf(ctx)) || /\bLA_ROOT\b/.test(code);
    return names && MUTATING_CALL.test(code);
  }
  return false;
}

// FOC-1001: a git command that crosses the child-worktree boundary. `assigns`
// are the leading VAR=value tokens the caller stripped.
function gitBoundaryVerdict(gitTokens, assigns, ctx) {
  const globals = parseGitGlobals(gitTokens);
  const safeDirKey = /^safe\.directory/i;
  const mentionsSafeDir =
    globals.configs.some((c) => safeDirKey.test(c)) ||
    assigns.some((a) => /safe\.directory/i.test(a)) ||
    (gitTokens[globals.subIdx] === "config" && gitTokens.slice(globals.subIdx + 1).some((a) => /safe\.directory/i.test(a)));
  if (mentionsSafeDir) {
    return {
      ticket: "FOC-1001",
      op: "git safe.directory",
      reason: "trusting a directory lets whatever its owner planted (core.fsmonitor, hooks) run as the Supervisor — push and read from the main checkout instead",
    };
  }
  const root = worktreeRootOf(ctx);
  let dir = ctx.cwd;
  for (const d of globals.dirs) dir = resolveAgainst(d, dir, ctx) ?? dir;
  const candidates = [dir, ...globals.gitDirs.map((g) => resolveAgainst(g, ctx.cwd, ctx))];
  if (candidates.some((c) => strictlyUnder(typeof c === "string" ? posix.normalize(c) : null, root))) {
    return {
      ticket: "FOC-1001",
      op: "git in a child worktree",
      reason: "a child owns that tree and its gitdir; git run there executes child-controlled config as the Supervisor — read it through the supervisor-* scripts, push from the main checkout",
    };
  }
  return null;
}

// Track `cd <dir>` across the simple commands of one command line.
function trackCd(tokens, state) {
  if (tokens[0] !== "cd" || tokens[1] === undefined || tokens[1] === "-") return;
  const target = resolveAgainst(tokens[1], state.cwd, state);
  state.cwd = target ?? state.cwd;
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

function classifySimple(tokens, depth, ctx) {
  if (!tokens.length) return null;

  // Strip leading wrappers (with their flags), VAR=value assignments and
  // env-style assignments until the real command. Wrappers nest, so re-test.
  // The assignments are kept: GIT_CONFIG_* naming safe.directory is a boundary
  // crossing too (FOC-1001).
  let start = 0;
  const assigns = [];
  while (start < tokens.length) {
    const t = tokens[start];
    if (VAR_ASSIGN.test(t)) {
      assigns.push(t);
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
      return inner ? classifyDangerous(inner, depth + 1, ctx) : null;
    }
    if (SHELLS.has(basename(cmd))) {
      for (let j = start + 1; j < tokens.length; j++) {
        const t = tokens[j];
        if (t === "--") break;
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) {
          const inner = tokens.slice(j + 1).join(" ");
          return inner ? classifyDangerous(inner, depth + 1, ctx) : null;
        }
        if (!t.startsWith("-")) break; // first operand without -c: no inner command
      }
    }
  }

  const program = basename(cmd);

  // FOC-988: a write into Fenix's own code, whatever the program (container only).
  if (ctx.container === true && writesIntoCode(tokens, start, program, ctx)) {
    return {
      ticket: "FOC-988",
      op: "write to Fenix's own code",
      reason: `${codeRootOf(ctx)} is the image's code, never yours to change — a failing Fenix script is a hold with the error, not a patch`,
    };
  }

  if (program === "git") {
    // FOC-1001: crossing into a child-owned worktree / trusting a directory.
    if (ctx.container === true) {
      const boundary = gitBoundaryVerdict(tokens.slice(start), assigns, ctx);
      if (boundary) return boundary;
    }
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

// classifyDangerous(command, depth?, ctx?) → null | { op, reason, ticket? }
//   ctx = { container: bool, cwd?: string, env?: object } — the FOC-988 /
//   FOC-1001 boundary classes run only with container === true. The caller's
//   object is not mutated: `cd` tracking works on a copy.
export function classifyDangerous(command, depth = 0, ctx = {}) {
  const state = { ...ctx };
  const simpleCommands = tokenize(stripHeredocs(command));
  for (const tokens of simpleCommands) {
    const verdict = classifySimple(tokens, depth, state);
    if (verdict) return verdict;
    trackCd(tokens, state);
  }
  return null;
}

// ── hook entry point ───────────────────────────────────────────────────────────

function askDecision(op, reason, ticket = "FOC-978") {
  return (
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask",' +
    `"permissionDecisionReason":${JSON.stringify(`${ticket}: ${op} needs your approval (${reason})`)}}}`
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

  // FOC-988 / FOC-1001: the boundary classes know where they are from the
  // hook's own environment and the session cwd the harness reports.
  const ctx = {
    container: process.env.FENIX_IN_CONTAINER === "1",
    cwd: typeof hook.cwd === "string" ? hook.cwd : undefined,
    env: process.env,
  };

  let verdict = null;
  try {
    verdict = classifyDangerous(command, 0, ctx);
  } catch {
    // internal error: fail toward asking only when the input clearly names
    // both git and push — otherwise stay silent and let the harness decide.
    const lowered = command.toLowerCase();
    if (lowered.includes("push") && lowered.includes("git"))
      verdict = { op: "git push (?)", reason: "guard internal error — failing toward asking" };
  }
  if (verdict) process.stdout.write(askDecision(verdict.op, verdict.reason, verdict.ticket) + "\n");
}

// Run only when executed directly (not when imported by the test).
const invokedAs = process.argv[1] ? process.argv[1].replace(/\\/g, "/").toLowerCase() : "";
const thisFile = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
if (invokedAs.endsWith("supervisor-ask-guard.mjs") && thisFile.endsWith(invokedAs)) {
  main().catch(() => {});
}
