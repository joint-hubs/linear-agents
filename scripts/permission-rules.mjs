// Model of Claude Code's documented permission-rule matching for Bash and
// PowerShell commands (https://code.claude.com/docs/en/permissions, read
// 2026-10-15). Claude Code itself is the enforcer at runtime — this module is
// a MODEL used by tests and drift checks only, never as enforcement. Where
// the docs are silent the model is deliberately conservative: it errs toward
// "this rule might match" (over-splitting commands, treating an empty pattern
// as "*") so a drift check can never certify a deny as absent when the real
// matcher might still fire.
//
// PowerShell alias canonicalisation (gci → Get-ChildItem etc.) is OUT OF
// SCOPE: rules match the command text as written. Tokenizer limits (see
// splitSubcommands): no heredocs, no backtick substitution, no backslash
// escapes inside quotes.

// `*` stands in for any text (including spaces and newlines) at any position.
// Build a regex from the literal parts between wildcards; everything else is
// escaped so `$`, `(` etc. in the command text stay literal. The wildcard
// translates to `[\s\S]*` — `.` cannot cross a newline, and a quoted newline
// inside one subcommand (e.g. --body 'a\nb') must not evade the pattern.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Separator sets. Bash: the docs list &&, ||, ;, |&, |, & and newlines.
// PowerShell: |, ;, &&, || and newlines only.
const BASH_SEPARATORS = { two: ["&&", "||", "|&"], one: ["|", "&", ";", "\n", "\r"] };
const POWERSHELL_SEPARATORS = { two: ["&&", "||"], one: ["|", ";", "\n", "\r"] };

// Index of the ")" matching the "(" at openIdx, honouring quotes and nesting;
// -1 when unbalanced (the "(" is then treated as a literal character).
function findClose(text, openIdx) {
  let depth = 0;
  let quote = null;
  for (let j = openIdx; j < text.length; j++) {
    const c = text[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// True when the command contains a separator of the given set outside single/
// double quotes and outside balanced $(…)/(…) regions (their insides are
// separate subcommands at enforcement time, not part of the surrounding
// text). Rules are applied per subcommand — never to a compound text.
function hasTopLevelSeparator(text, { two, one }) {
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i++;
      continue;
    }
    if ((c === "$" && text[i + 1] === "(") || c === "(") {
      const close = findClose(text, i);
      if (close !== -1) {
        i = close + 1;
        continue;
      }
    }
    if (two.includes(text.slice(i, i + 2)) || one.includes(c)) return true;
    i++;
  }
  return false;
}

// Match one pattern against one command piece (the caller trims).
function matchesPattern(pattern, command, caseInsensitive, separators) {
  const cmd = command.trim();
  const pat = pattern.trim();
  const flags = caseInsensitive ? "i" : "";
  // The enforcer splits compound commands first and evaluates each subcommand
  // against the rule; it never applies a rule to the compound text itself
  // ("Bash(safe-cmd *)" must NOT match "safe-cmd && other-cmd" as a whole).
  // The whole-text model therefore refuses such text (quoted separators are
  // protected; $(…)/(…) interiors are opaque — isDenied splits them out).
  if (hasTopLevelSeparator(cmd, separators)) return false;
  if (!pat.includes("*")) {
    if (caseInsensitive) return pat.toLowerCase() === cmd.toLowerCase();
    return pat === cmd;
  }
  // Documented special case: a pattern ending in " *" whose trailing "*" is
  // its ONLY wildcard also matches the bare command without the trailing
  // space ("ls *" matches "ls"). With more than one wildcard the trailing
  // star means "anything after", and the docs' examples say the bare form
  // does NOT match ("* --help *" does not match "npm --help").
  if (pat.endsWith(" *") && pat.indexOf("*") === pat.length - 1) {
    return new RegExp(`^${escapeRegExp(pat.slice(0, -2))}(?: [\\s\\S]*)?$`, flags).test(cmd);
  }
  return new RegExp(`^${pat.split("*").map(escapeRegExp).join("[\\s\\S]*")}$`, flags).test(cmd);
}

// parseRule("Tool(pattern)") → { tool, pattern }.
// Bare "Tool" → { tool, pattern: "*" }. A ":*" suffix at the VERY END of the
// pattern is the same as a trailing " *" ("ls:*" → "ls *"); a ":" anywhere
// else is literal ("git:* push" keeps its colon).
export function parseRule(rule) {
  const s = String(rule);
  const open = s.indexOf("(");
  if (open === -1) return { tool: s.trim(), pattern: "*" };
  const close = s.lastIndexOf(")");
  let pattern = s.slice(open + 1, close > open ? close : s.length).trim();
  if (pattern === "") pattern = "*"; // "Tool()" — docs silent; conservative
  if (pattern.endsWith(":*")) pattern = `${pattern.slice(0, -2)} *`;
  return { tool: s.slice(0, open).trim(), pattern };
}

// Bash rules match the WHOLE trimmed command text, case-sensitively.
export function matchesBashRule(rule, command) {
  const { pattern } = typeof rule === "string" ? parseRule(rule) : rule;
  return matchesPattern(pattern, command, false, BASH_SEPARATORS);
}

// PowerShell rules have the same shape but match case-insensitively. Alias
// canonicalisation (gci → Get-ChildItem) is out of scope: the pattern matches
// the command text as written.
export function matchesPowerShellRule(rule, command) {
  const { pattern } = typeof rule === "string" ? parseRule(rule) : rule;
  return matchesPattern(pattern, command, true, POWERSHELL_SEPARATORS);
}

// Split a command into subcommands the way the docs describe compound-command
// matching: separators "&&", "||", ";", "|&", "|", "&" and newlines, outside
// single and double quotes. Additionally, the INSIDE of "$( … )" command
// substitutions and "( … )" subshells is returned as extra subcommands (the
// shell executes it, so a deny inside a substitution must be visible), while
// the surrounding piece keeps the substitution text verbatim.
//
// Limits (deliberate, small tokenizer): no heredocs, no backtick `…`
// substitution, no backslash escaping (a `\"` inside double quotes is seen as
// a closing quote and may cause a false split), `case`/`for` syntax is not
// parsed beyond the plain separators. Every extra split only makes matching
// more conservative for deny purposes.
export function splitSubcommands(command) {
  return splitTokens(String(command), {
    ...BASH_SEPARATORS,
    // Inside single quotes nothing runs; inside double quotes a $(…) IS still
    // executed by the shell, so it is split out even there.
    substInDoubleQuote: true,
    subst: true,
  });
}

// PowerShell piece-wise split for isDenied: "|", ";", "&&", "||" and newline
// separators only — no bare "&", no substitution/subshell extraction (the
// docs list exactly these separators for compound matching; the model does
// not invent more).
function splitPowerShell(command) {
  return splitTokens(String(command), {
    ...POWERSHELL_SEPARATORS,
    substInDoubleQuote: false,
    subst: false,
  });
}

// Shared small tokenizer. walk() collects the current piece, pushing it on a
// separator; on "$( … )" or "( … )" it recurses into the inside (when the
// mode allows) and keeps the construct verbatim in the surrounding piece.
function splitTokens(text, { two, one, subst, substInDoubleQuote }) {
  const pieces = [];
  const push = (out, raw) => {
    const t = raw.trim();
    if (t) out.push(t);
  };

  const walk = (text, out) => {
    // Top-level pieces of this level go into `out` (in scan order); pieces
    // recovered from substitutions/subshells go into `subs` first and are
    // appended after them, so a surrounding piece always precedes the pieces
    // extracted from its insides.
    const subs = [];
    let token = "";
    let i = 0;
    let quote = null;
    while (i < text.length) {
      const c = text[i];
      if (quote === "'") {
        token += c;
        if (c === "'") quote = null;
        i++;
        continue;
      }
      if (quote === '"' && !(substInDoubleQuote && c === "$" && text[i + 1] === "(")) {
        token += c;
        if (c === '"') quote = null;
        i++;
        continue;
      }
      const pair = text.slice(i, i + 2);
      if (c === '"' || c === "'") { quote = c; token += c; i++; continue; }
      if (two.includes(pair)) {
        push(out, token);
        token = "";
        i += 2;
        continue;
      }
      if (one.includes(c)) {
        push(out, token);
        token = "";
        i++;
        continue;
      }
      if (subst && ((c === "$" && text[i + 1] === "(") || c === "(")) {
        const open = c === "(" ? i : i + 1;
        const close = findClose(text, open);
        if (close !== -1) {
          walk(text.slice(open + 1, close), subs);
          token += text.slice(i, close + 1);
          i = close + 1;
          continue;
        }
      }
      token += c;
      i++;
    }
    push(out, token);
    out.push(...subs);
  };

  walk(text, pieces);
  return pieces;
}

// isDenied(denyList, tool, command) → { denied, rule?, subcommand? }.
// tool is "Bash" or "PowerShell". The command is split into subcommands; for
// each subcommand (in order), the first rule OF THAT TOOL that matches wins.
export function isDenied(denyList, tool, command) {
  if (tool !== "Bash" && tool !== "PowerShell") {
    throw new TypeError(`isDenied: tool must be "Bash" or "PowerShell", got ${JSON.stringify(tool)}`);
  }
  const pieces = tool === "Bash" ? splitSubcommands(command) : splitPowerShell(command);
  for (const sub of pieces) {
    for (const raw of denyList) {
      if (parseRule(raw).tool !== tool) continue;
      const hit = tool === "Bash" ? matchesBashRule(raw, sub) : matchesPowerShellRule(raw, sub);
      if (hit) return { denied: true, rule: raw, subcommand: sub };
    }
  }
  return { denied: false };
}