#!/usr/bin/env node
/**
 * scripts/gh-screened.mjs — the Supervisor's single screened path for PR text (FOC-512).
 *
 * PR titles/bodies leave through raw `gh` today, guarded only by prose — this
 * wrapper closes the gap the way every other outbound-text chokepoint is
 * closed: egress-screen.mjs screens the text BEFORE anything is spawned, and a
 * hit fails closed, naming the secret by SHAPE (never by value); gh never runs.
 *
 * Verbs (first two argv tokens):
 *   screened     pr create | pr edit | pr comment — text flags (--title/-t,
 *                --body/-b, --body-file/-F, --subject; separated, --flag=value
 *                and attached short form -bVALUE; body file read as UTF-8,
 *                "-" = stdin) are collected, joined "title\n\nbody" (parts
 *                present only) and screened. `pr create` needs an explicit
 *                --title AND a body source; --fill* / --web / --editor /
 *                --template (also -f -w -e -T and short clusters like -df) or
 *                a missing title/body would source text outside this screen →
 *                exit 2; `pr comment` needs a body. `pr edit` with NO text
 *                flag passes through (label/reviewer edits). A text-flag
 *                token the parser cannot recognise fails closed (exit 2).
 *   pass-through pr view|list|checks|diff|status — read-only, no text leaves.
 *   refused      pr merge (its squash/merge text flags are unscreened here —
 *                merging is Mateusz's call; run gh pr merge directly, it goes
 *                through the ask gate) and everything else (api, release,
 *                issue, repo, unknown) — exit 2, gh never started: PR text
 *                has exactly one screened path.
 *
 * Exit: 0 gh clean; 1 blocked or gh killed by a signal; 2 usage (refused verb,
 * unscreened text source, unparseable or value-less text flag); 127 gh not
 * found; otherwise gh's exit code passes through. The gh binary comes from the
 * LA_GH_COMMAND env seam (a JSON array, e.g. ["node","C:/x/fake-gh.mjs"]); default ["gh"].
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { assertEgressClean, EgressBlockedError } from "./egress-screen.mjs";

const SCREENED_VERBS = new Set(["pr create", "pr edit", "pr comment"]);
const PASS_THROUGH_VERBS = new Set(["pr view", "pr list", "pr checks", "pr diff", "pr status"]);

// Flags that would make gh source the text itself (commit info, template,
// editor, browser): refused in every spelling pflag accepts — long, long=value,
// short (-f -w -e -T, with or without an attached value) and a short cluster
// such as -df (draft + fill). A cluster is judged by its letters, so a value
// attached to another short flag (-rTom) is refused too: fail closed, write
// `-r Tom`.
const UNSCREENED_SOURCE_LONG = new Set(["--fill", "--fill-first", "--fill-verbose", "--web", "--editor", "--template"]);
const UNSCREENED_SOURCE_SHORT = new Set(["f", "w", "e", "T"]);

/** The first argv token that would source PR text outside this screen, or null.
 * Tokens after a bare `--` are positionals for gh and are not flags. */
export function unscreenedSourceFlag(argv) {
  let valueOf = null; // the flag whose separated value the next token is
  for (const a of argv) {
    if (valueOf !== null) { valueOf = null; continue; } // a value, not a flag
    if (a === "--") break;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const flag = eq === -1 ? a : a.slice(0, eq);
      if (UNSCREENED_SOURCE_LONG.has(flag)) return a;
      if (eq === -1 && LONG_TEXT_FLAGS.has(flag)) valueOf = flag;
      continue;
    }
    if (a.length < 2 || a[0] !== "-") continue;
    if (SHORT_TEXT_LETTERS.has(a[1])) { if (a.length === 2) valueOf = a; continue; }
    const cluster = a.slice(1);
    if (UNSCREENED_SOURCE_SHORT.has(cluster[0])) return a;
    if (/^[A-Za-z]+$/.test(cluster) && [...cluster].some((c) => UNSCREENED_SOURCE_SHORT.has(c))) return a;
  }
  return null;
}

/** Classify the gh verb (the first two argv tokens). */
export function classifyVerb(argv) {
  const verb = argv.slice(0, 2).join(" ");
  if (SCREENED_VERBS.has(verb)) return { kind: "screened", verb };
  if (PASS_THROUGH_VERBS.has(verb)) return { kind: "passthrough", verb };
  return { kind: "refused", verb };
}

// Long text flags (with gh's --subject alias) and their short spellings.
// Anything starting with one of the long prefixes (or a short-flag token the
// parser below cannot fully recognise) fails closed: unparsed text flags are
// never passed through unscreened.
const LONG_TEXT_FLAGS = new Set(["--title", "--body", "--body-file"]);
const SHORT_TEXT_LETTERS = new Set(["b", "t", "F"]);
const FAIL_CLOSED_PREFIXES = ["--body", "--title", "--body-file", "--subject"];

/**
 * Collect the screenable text from gh's title/body flags; `readFile`/`readStdin`
 * are injectable (tests cover file and stdin sourcing without a real fd).
 * Short flags are recognised in all three spellings gh's pflag accepts:
 * separated (-b VALUE), inline (-b=VALUE) and attached (-bVALUE). Throws on a
 * flag missing its value and on any text-flag token the parser does not
 * recognise — the caller exits 2 either way (fail closed).
 */
export function collectText(argv, { readFile, readStdin }) {
  let title = null;
  let body = null;
  const setTitle = (v) => { title = v; };
  const setBody = (v) => { body = v; };
  const setBodyFile = (p) => { body = p === "-" ? readStdin() : readFile(p); };
  const applyShort = (f, v) => {
    if (f === "t") setTitle(v);
    else if (f === "b") setBody(v);
    else setBodyFile(v);
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const flag = eq === -1 ? a : a.slice(0, eq);
      const inline = eq === -1 ? null : a.slice(eq + 1);
      const readValue = () => {
        if (inline !== null) return inline;
        if (i + 1 >= argv.length) throw new Error(`flag ${flag} requires a value`);
        return argv[++i];
      };
      if (LONG_TEXT_FLAGS.has(flag)) {
        const v = readValue();
        if (flag === "--title") setTitle(v);
        else if (flag === "--body") setBody(v);
        else setBodyFile(v);
      } else if (FAIL_CLOSED_PREFIXES.some((p) => a.startsWith(p))) {
        throw new Error(`unrecognised text flag "${a}" — refusing to pass it through unscreened`);
      }
      // Other long flags (--head, --base, ...) are unrelated to the text.
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && SHORT_TEXT_LETTERS.has(a[1])) {
      const f = a[1];
      if (a.length === 2) {
        if (i + 1 >= argv.length) throw new Error(`flag ${a} requires a value`);
        applyShort(f, argv[++i]);
      } else {
        // Inline (-b=VALUE) or attached (-bVALUE): the rest of the token.
        applyShort(f, a[2] === "=" ? a.slice(3) : a.slice(2));
      }
      continue;
    }
    // Unrelated tokens ("-", -head, positional args) are ignored.
  }
  return { title, body };
}

/** Collect, validate and join the screenable text; exits 2 on an unscreened
 * source, returns null when there is no text (pr edit, labels only). */
function readScreenedText(argv, verb) {
  const unscreened = unscreenedSourceFlag(argv);
  if (unscreened !== null) {
    console.error(`gh-screened: "${unscreened}" would source the text outside this screen — pass --title and --body/--body-file explicitly`);
    process.exit(2);
  }
  try {
    const { title, body } = collectText(argv, {
      readFile: (p) => readFileSync(p, "utf8"),
      readStdin: () => readFileSync(0, "utf8"),
    });
    if (verb === "pr create" && (title === null || body === null)) {
      console.error("gh-screened: pr create needs an explicit --title and a --body/--body-file — a missing one would come from an unscreened source");
      process.exit(2);
    }
    if (verb === "pr comment" && body === null) {
      console.error("gh-screened: pr comment needs a --body/--body-file — the comment text must pass this screen");
      process.exit(2);
    }
    const parts = [];
    if (title !== null) parts.push(title);
    if (body !== null) parts.push(body);
    return parts.length > 0 ? parts.join("\n\n") : null;
  } catch (err) {
    console.error(`gh-screened: ${err.message}`);
    process.exit(2);
  }
}

/** The gh command from the LA_GH_COMMAND env seam (a JSON array); default gh. */
function ghCommand() {
  const seam = process.env.LA_GH_COMMAND;
  if (!seam) return ["gh"];
  try {
    const parsed = JSON.parse(seam);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((x) => typeof x === "string")) {
      throw new Error("expected a JSON array of strings");
    }
    return parsed;
  } catch (err) {
    console.error(`gh-screened: invalid LA_GH_COMMAND (${err.message})`);
    process.exit(2);
  }
}

function runCli(argv) {
  const { kind, verb } = classifyVerb(argv);
  if (kind === "refused") {
    if (verb === "pr merge") {
      console.error('gh-screened: "pr merge" is not screened here — merging is Mateusz\'s call; if the contract allows it, run gh pr merge directly (it goes through the ask gate)');
    } else {
      console.error(`gh-screened: "${verb}" is not a screened verb — read-only gh verbs run through gh directly; PR text goes through pr create|edit|comment`);
    }
    process.exit(2);
  }
  // Pass-through verbs carry no PR text: their flags (--web on pr view, ...)
  // are gh's business, so the text parser never sees them.
  const text = kind === "screened" ? readScreenedText(argv, verb) : null;
  if (text !== null) {
    try {
      assertEgressClean(text, `gh ${verb} title+body`);
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  }
  const cmd = ghCommand();
  const res = spawnSync(cmd[0], [...cmd.slice(1), ...argv], { stdio: "inherit" });
  if (res.error) {
    console.error(`gh-screened: gh not found (${res.error.message})`);
    process.exit(127);
  }
  if (res.signal) process.exit(1);
  process.exit(res.status ?? 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runCli(process.argv.slice(2));
