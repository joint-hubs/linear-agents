// Tests for scripts/gh-screened.mjs — run with: node scripts/gh-screened.test.mjs
//
// FOC-512: the wrapper screens PR text (title+body) through egress-screen.mjs
// BEFORE gh is ever spawned, refuses verbs/text-sources the screen would never
// see, and passes gh's exit code through untouched on the clean path. The fake
// gh is a temp Node script that appends its argv to a log file — a blocked run
// must leave that log unwritten, proving gh was never started.
//
// The secret-shaped fixture is ASSEMBLED AT RUNTIME from split literals (same
// convention as egress-screen.test.mjs): fake by construction, and a
// contiguous literal in THIS file would trip the repo-wide secretlint scan.

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const WRAPPER = join(__dirname, "gh-screened.mjs");

const { classifyVerb, collectText, restEditNumber, unscreenedSourceFlag } = await import(pathToFileURL(WRAPPER).href);

// Fake constructions — NOT credentials. Split literals, never contiguous.
const FAKE_SK_OR = "sk-or-".concat("v1-", "0123456789abcdef", "0123456789abcdef", "0123456789abcdef", "0123456789abcdef");
const SECRET_FRAGMENT = "0123456789abcdef";

// ---------------------------------------------------------------------------
// Test harness (mirrors scripts/egress-screen.test.mjs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

function makeFakeGh(dir) {
  const fakePath = join(dir, "fake-gh.mjs");
  writeFileSync(
    fakePath,
    [
      'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
      "const argv = process.argv.slice(2);",
      'appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(argv) + "\\n", "utf8");',
      // FOC-1000: `-F body=@file` — keep what was in the file and whether it still exists later.
      'const bodyArg = argv.find((a) => a.startsWith("body=@"));',
      'if (bodyArg) appendFileSync(process.env.FAKE_GH_LOG + ".body", readFileSync(bodyArg.slice(6), "utf8"), "utf8");',
      // FOC-1000: one verb can be made to fail with a given stderr (the sunset-API message).
      'if (process.env.FAKE_GH_FAIL_VERB && process.env.FAKE_GH_FAIL_VERB === argv.slice(0, 2).join(" ")) {',
      '  process.stderr.write(process.env.FAKE_GH_FAIL_STDERR || "failed\\n");',
      "  process.exit(1);",
      "}",
      "process.exit(Number(process.env.FAKE_GH_EXIT || 0));",
    ].join("\n"),
    "utf8",
  );
  return fakePath;
}

// Spawns the wrapper with LA_GH_COMMAND pointing at the fake gh. Each run gets
// its own fresh log file; `r.log()` returns the file's text or null when the
// wrapper never reached gh (which is the assertion for every blocked run).
let runSeq = 0;
function runWrapper(args, { env = {} } = {}) {
  runSeq++;
  const log = join(TEMP_DIR, `gh-log-${runSeq}.txt`);
  rmSync(log, { force: true });
  const res = spawnSync(NODE, [WRAPPER, ...args], {
    encoding: "utf-8",
    timeout: 60000,
    env: {
      ...process.env,
      LA_GH_COMMAND: JSON.stringify([NODE, FAKE_GH]),
      FAKE_GH_LOG: log,
      FAKE_GH_EXIT: "0",
      ...env,
    },
  });
  return {
    status: res.status,
    out: res.stdout || "",
    err: res.stderr || "",
    log: () => (existsSync(log) ? readFileSync(log, "utf8") : null),
  };
}

const lastLogArgv = (log) => {
  const lines = log.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
};

const TEMP_DIR = mkdtempSync(join(tmpdir(), "gh-screened-test-"));
const FAKE_GH = makeFakeGh(TEMP_DIR);

// ---------------------------------------------------------------------------
// 1. Blocked --body: exit 1, gh never started, shape-only refusal
// ---------------------------------------------------------------------------

console.log("spawn: secret-shaped --body is BLOCKED before gh starts");
{
  const r = runWrapper(["pr", "create", "--title", "Run report", "--body", `see ${FAKE_SK_OR} for details`]);
  assert(r.status === 1, "exit 1 (blocked)");
  assert(r.log() === null, "gh never started (log file never written)");
  assert(r.err.includes("[egress-blocked]"), "stderr carries the typed marker");
  assert(r.err.includes("Blocked (first hit):"), "last-line shape summary present");
  assert(r.err.includes("gh pr create title+body"), "label names the screened verb");
  assert(!r.err.includes(FAKE_SK_OR) && !r.err.includes(SECRET_FRAGMENT), "stderr contains no token-body fragment");
}

// ---------------------------------------------------------------------------
// 2. Blocked --body-file: the file's contents are screened too
// ---------------------------------------------------------------------------

console.log("spawn: secret-shaped --body-file is BLOCKED before gh starts");
{
  const bodyFile = join(TEMP_DIR, "blocked-body.md");
  writeFileSync(bodyFile, `context\n${FAKE_SK_OR}\n`, "utf8");
  const r = runWrapper(["pr", "create", "--title", "Run report", "--body-file", bodyFile]);
  assert(r.status === 1, "exit 1 (blocked)");
  assert(r.log() === null, "gh never started (log file never written)");
  assert(r.err.includes("[egress-blocked]") && r.err.includes("Blocked (first hit):"), "typed refusal with shape summary");
  assert(!r.err.includes(SECRET_FRAGMENT), "stderr contains no token-body fragment");
}

// ---------------------------------------------------------------------------
// 3. Clean title+body: gh runs with the EXACT argv, exit 0
// ---------------------------------------------------------------------------

console.log("spawn: clean title+body reaches gh with the untouched argv");
{
  const args = ["pr", "create", "--title", "Add widget", "--body", "Does the thing.\n\nFixes FOC-512 cleanly."];
  const r = runWrapper(args);
  assert(r.status === 0, "exit 0 (clean)");
  assert(r.log() !== null, "gh ran (log written)");
  assert(JSON.stringify(lastLogArgv(r.log())) === JSON.stringify(args), "log holds exactly the argv given");
}

// ---------------------------------------------------------------------------
// 4. Exit-code passthrough: gh's own status survives the wrapper
// ---------------------------------------------------------------------------

console.log("spawn: gh's exit code passes through");
{
  const r = runWrapper(["pr", "create", "--title", "T", "--body", "clean"], { env: { FAKE_GH_EXIT: "3" } });
  assert(r.status === 3, "gh exit 3 → wrapper exit 3");
  assert(r.log() !== null, "gh ran (log written)");
}

// ---------------------------------------------------------------------------
// 5. Refused verb: gh api exits 2, gh never started
// ---------------------------------------------------------------------------

console.log("spawn: gh api is refused (exit 2, gh never started)");
{
  const r = runWrapper(["api", "repos/x/pulls"]);
  assert(r.status === 2, "exit 2 (refused verb)");
  assert(r.log() === null, "gh never started (log file never written)");
  assert(r.err.includes("not a screened verb"), "stderr explains the refusal");
}

// ---------------------------------------------------------------------------
// 6. Read-only passthrough: pr view runs unscreened
// ---------------------------------------------------------------------------

console.log("spawn: pr view passes through to gh unscreened");
{
  const args = ["pr", "view", "76"];
  const r = runWrapper(args);
  assert(r.status === 0, "exit 0 (passthrough)");
  assert(JSON.stringify(lastLogArgv(r.log())) === JSON.stringify(args), "fake gh received that argv");
}

// ---------------------------------------------------------------------------
// 7. Unscreened text source on pr create: --fill exits 2
// ---------------------------------------------------------------------------

console.log("spawn: pr create --fill is refused (body would come from gh itself)");
{
  const r = runWrapper(["pr", "create", "--fill"]);
  assert(r.status === 2, "exit 2 (unscreened text source)");
  assert(r.log() === null, "gh never started (log file never written)");
}

// ---------------------------------------------------------------------------
// 8. pr comment without a body exits 2
// ---------------------------------------------------------------------------

console.log("spawn: pr comment without a body is refused");
{
  const r = runWrapper(["pr", "comment", "76"]);
  assert(r.status === 2, "exit 2 (missing body)");
  assert(r.log() === null, "gh never started (log file never written)");
}

// ---------------------------------------------------------------------------
// 9. Missing gh binary → exit 127
// ---------------------------------------------------------------------------

console.log("spawn: missing gh binary exits 127");
{
  const r = runWrapper(["pr", "create", "--title", "T", "--body", "clean"], {
    env: { LA_GH_COMMAND: JSON.stringify([join(TEMP_DIR, "no-such-gh.exe")]) },
  });
  assert(r.status === 127, "spawn failure → exit 127");
  assert(r.err.includes("gh not found"), "stderr names the failure");
}

// ---------------------------------------------------------------------------
// 10. Unit: classifyVerb and collectText (no spawning)
// ---------------------------------------------------------------------------

console.log("unit: classifyVerb");
{
  for (const v of ["create", "edit", "comment"]) {
    assert(classifyVerb(["pr", v]).kind === "screened", `pr ${v} is screened`);
  }
  for (const v of ["view", "list", "checks", "diff", "status"]) {
    assert(classifyVerb(["pr", v]).kind === "passthrough", `pr ${v} is pass-through`);
  }
  for (const argv of [["api", "repos/x/pulls"], ["release", "create", "v1"], ["issue", "list"], ["repo", "view"], ["pr", "merge"], ["pr"], [], ["--version"]]) {
    assert(classifyVerb(argv).kind === "refused", `refused: ${JSON.stringify(argv)}`);
  }
}

console.log("unit: collectText");
{
  const io = { readFile: (p) => `FILE:${p}`, readStdin: () => "STDIN" };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  assert(eq(collectText(["--title", "T", "--body", "B"], io), { title: "T", body: "B" }), "--title/--body separated form");
  assert(eq(collectText(["--title=Eq T", "-b", "B"], io), { title: "Eq T", body: "B" }), "--title= inline and -t short form");
  assert(eq(collectText(["-t", "T2"], io), { title: "T2", body: null }), "-t alone");
  assert(eq(collectText(["--body=Inline body"], io), { title: null, body: "Inline body" }), "--body= inline form");
  assert(eq(collectText(["--body-file", "P"], io), { title: null, body: "FILE:P" }), "--body-file reads the file");
  assert(eq(collectText(["-F", "P"], io), { title: null, body: "FILE:P" }), "-F reads the file");
  assert(eq(collectText(["--body-file=P"], io), { title: null, body: "FILE:P" }), "--body-file=P inline form");
  assert(eq(collectText(["--body-file", "-"], io), { title: null, body: "STDIN" }), "--body-file - reads stdin");
  assert(eq(collectText(["--body-file=-"], io), { title: null, body: "STDIN" }), "--body-file=- reads stdin");
  assert(eq(collectText(["-b", "B"], io), { title: null, body: "B" }), "-b separated form");
  assert(eq(collectText(["-b=B"], io), { title: null, body: "B" }), "-b= inline form");
  assert(eq(collectText(["-bB"], io), { title: null, body: "B" }), "-bB attached form");
  assert(eq(collectText(["-t=T"], io), { title: "T", body: null }), "-t= inline form");
  assert(eq(collectText(["-tT"], io), { title: "T", body: null }), "-tT attached form");
  assert(eq(collectText(["-F=P"], io), { title: null, body: "FILE:P" }), "-F= inline form reads the file");
  assert(eq(collectText(["-FP"], io), { title: null, body: "FILE:P" }), "-FP attached form reads the file");
  assert(eq(collectText([], io), { title: null, body: null }), "no text flags → nulls");
  assert(eq(collectText(["pr", "create", "--head", "x", "--title", "T"], io), { title: "T", body: null }), "unrelated flags are ignored");
  let threw = false;
  try {
    collectText(["--body"], io);
  } catch {
    threw = true;
  }
  assert(threw, "a flag missing its value throws");
  let threwShort = false;
  try {
    collectText(["-b"], io);
  } catch {
    threwShort = true;
  }
  assert(threwShort, "a short flag missing its value throws");
  let threwSubject = false;
  try {
    collectText(["--subject", "T"], io);
  } catch {
    threwSubject = true;
  }
  assert(threwSubject, "--subject (unparsed text flag) fails closed");
}

console.log("unit: unscreenedSourceFlag");
{
  const hits = [
    [["pr", "create", "-f", "--title", "x", "--body", "y"], "-f"],
    [["pr", "create", "--fill=true", "--title", "x", "--body", "y"], "--fill=true"],
    [["pr", "create", "-w"], "-w"],
    [["pr", "create", "-e"], "-e"],
    [["pr", "create", "-T", "pr.md"], "-T"],
    [["pr", "create", "-Tpr.md"], "-Tpr.md"],
    [["pr", "create", "--template", "pr.md"], "--template"],
    [["pr", "create", "-df"], "-df"],
    [["pr", "create", "-rTom"], "-rTom"],
  ];
  for (const [argv, token] of hits) {
    assert(unscreenedSourceFlag(argv) === token, `unscreened source → ${token}: ${JSON.stringify(argv)}`);
  }
  const cleans = [
    ["pr", "create", "--title", "x", "--body", "y", "-d"],
    // The -f here is the body VALUE after -b (pflag consumes the next token),
    // not a flag — it must not be judged.
    ["pr", "create", "--title", "x", "--body", "y", "-b", "-f"],
    // Tokens after a bare -- are positionals for gh.
    ["pr", "create", "--title", "x", "--body", "y", "--", "-f"],
  ];
  for (const argv of cleans) {
    assert(unscreenedSourceFlag(argv) === null, `clean → null: ${JSON.stringify(argv)}`);
  }
}

// ---------------------------------------------------------------------------
// 11. pr edit: no text flag passes through; text IS screened; --web refused
// ---------------------------------------------------------------------------

console.log("spawn: pr edit passthrough/screen/refuse split");
{
  const args = ["pr", "edit", "76", "--add-label", "bug"];
  const r = runWrapper(args);
  assert(r.status === 0, "label-only edit passes through (exit 0)");
  assert(JSON.stringify(lastLogArgv(r.log())) === JSON.stringify(args), "fake gh received that argv");

  const screened = runWrapper(["pr", "edit", "76", "--body", `see ${FAKE_SK_OR}`]);
  assert(screened.status === 1, "pr edit WITH text is screened (exit 1)");
  assert(screened.log() === null, "gh never started for the screened edit");
  assert(!screened.err.includes(SECRET_FRAGMENT), "stderr contains no token-body fragment");

  const web = runWrapper(["pr", "edit", "76", "--web"]);
  assert(web.status === 2, "pr edit --web is refused (unscreened text source)");
  assert(web.log() === null, "gh never started for --web");
}

// ---------------------------------------------------------------------------
// 12. Short text-flag spellings are screened; pr merge is refused
// ---------------------------------------------------------------------------

console.log("spawn: short text-flag spellings are screened; pr merge is refused");
{
  const rEq = runWrapper(["pr", "edit", "76", `-b=${FAKE_SK_OR}`]);
  assert(rEq.status === 1, "pr edit -b=<secret> is screened (exit 1)");
  assert(rEq.log() === null, "gh never started for -b=<secret>");
  assert(!rEq.err.includes(SECRET_FRAGMENT), "stderr contains no token-body fragment");

  const rAttached = runWrapper(["pr", "edit", "76", `-b${FAKE_SK_OR}`]);
  assert(rAttached.status === 1, "pr edit -b<secret> (attached) is screened (exit 1)");
  assert(rAttached.log() === null, "gh never started for the attached short flag");
  assert(!rAttached.err.includes(SECRET_FRAGMENT), "stderr contains no token-body fragment");

  const shortBodyFile = join(TEMP_DIR, "short-flag-body.md");
  writeFileSync(shortBodyFile, `context\n${FAKE_SK_OR}\n`, "utf8");
  const rFile = runWrapper(["pr", "edit", "76", `-F=${shortBodyFile}`]);
  assert(rFile.status === 1, "pr edit -F=<file with secret> is screened (exit 1)");
  assert(rFile.log() === null, "gh never started for -F=<file>");
  assert(!rFile.err.includes(SECRET_FRAGMENT), "stderr contains no token-body fragment");

  const cleanArgs = ["pr", "edit", "76", "-t=clean", "-b=clean"];
  const rClean = runWrapper(cleanArgs);
  assert(rClean.status === 0, "pr edit -t=clean -b=clean passes (exit 0)");
  assert(rClean.log() !== null, "gh ran for the clean short-flag edit");
  assert(JSON.stringify(lastLogArgv(rClean.log())) === JSON.stringify(cleanArgs), "fake gh received exactly that argv");

  const rMerge = runWrapper(["pr", "merge", "76", "--squash", "--subject", "T", "--body", "x"]);
  assert(rMerge.status === 2, "pr merge with text flags is refused (exit 2)");
  assert(rMerge.log() === null, "gh never started for pr merge with text flags");
  assert(rMerge.err.includes('"pr merge" is not screened here'), "stderr explains the merge refusal");

  const rMergeBare = runWrapper(["pr", "merge", "76"]);
  assert(rMergeBare.status === 2, "bare pr merge is refused (exit 2)");
  assert(rMergeBare.log() === null, "gh never started for bare pr merge");
}

// ---------------------------------------------------------------------------
// 13. Unscreened text sources on screened verbs: exit 2, gh never started
// ---------------------------------------------------------------------------

console.log("spawn: --fill/-w/-e/-T/--template/cluster forms are refused (exit 2, gh never started)");
{
  const refusals = [
    ["pr", "create", "-f", "--title", "t", "--body", "b"],
    ["pr", "create", "--title", "t", "--body", "b", "-w"],
    ["pr", "create", "--title", "t", "--body", "b", "--template", "x.md"],
    ["pr", "create", "--title", "t", "--body", "b", "-df"],
  ];
  for (const args of refusals) {
    const r = runWrapper(args);
    assert(r.status === 2, `exit 2 (unscreened text source): ${JSON.stringify(args)}`);
    assert(r.log() === null, "gh never started (log file never written)");
  }
  const rComment = runWrapper(["pr", "comment", "76", "--body", "b", "-e"]);
  assert(rComment.status === 2, "pr comment -e exits 2 (unscreened text source)");
  assert(rComment.log() === null, "gh never started for pr comment -e");
}

// ---------------------------------------------------------------------------
// 14. Pass-through verbs skip the text parser entirely
// ---------------------------------------------------------------------------

console.log("spawn: pr view --web passes through to gh");
{
  const args = ["pr", "view", "76", "--web"];
  const r = runWrapper(args);
  assert(r.status === 0, "exit 0 (passthrough)");
  assert(JSON.stringify(lastLogArgv(r.log())) === JSON.stringify(args), "fake gh received exactly that argv");
}

// ---------------------------------------------------------------------------
// 15. Tokens after a bare -- are positionals: they pass through untouched
// ---------------------------------------------------------------------------

console.log("spawn: pr create ... -- -f passes through (-f after -- is a positional)");
{
  const args = ["pr", "create", "--title", "t", "--body", "b", "--", "-f"];
  const r = runWrapper(args);
  assert(r.status === 0, "exit 0 (the -f after -- is a positional)");
  assert(JSON.stringify(lastLogArgv(r.log())) === JSON.stringify(args), "fake gh received exactly that argv");
}

// ---------------------------------------------------------------------------
// 16. FOC-1000: an old gh fails `pr edit` on the sunset Projects (classic) API —
//     the wrapper retries it as a REST PATCH, screened text only
// ---------------------------------------------------------------------------

const CLASSIC_ERR = "GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience (repository.pullRequest.projectCards)\n";
const classicFail = { FAKE_GH_FAIL_VERB: "pr edit", FAKE_GH_FAIL_STDERR: CLASSIC_ERR };

console.log("unit: restEditNumber");
{
  assert(restEditNumber(["pr", "edit", "139", "--title", "T", "--body-file", "b.md"]) === "139", "number + title + body-file");
  assert(restEditNumber(["pr", "edit", "7", "-t", "T", "-b", "B"]) === "7", "short separated flags");
  assert(restEditNumber(["pr", "edit", "7", "--title=T", "-bB", "-F=b.md"]) === "7", "inline and attached spellings");
  assert(restEditNumber(["pr", "edit", "7", "--add-label", "x"]) === null, "a label edit has no REST equivalent here");
  assert(restEditNumber(["pr", "edit", "7", "--base", "main", "--title", "T"]) === null, "--base is not mapped");
  assert(restEditNumber(["pr", "edit", "my-branch", "--title", "T"]) === null, "a branch instead of a number is not mapped");
  assert(restEditNumber(["pr", "edit", "https://github.com/o/r/pull/7", "--title", "T"]) === null, "a URL instead of a number is not mapped");
  assert(restEditNumber(["pr", "edit", "7", "--title", "8"]) === "7", "a numeric title value is a flag value, not the number");
}

console.log("spawn: pr edit on the sunset-API failure retries as a REST PATCH");
{
  const bodyFile = join(TEMP_DIR, "rest-body.md");
  writeFileSync(bodyFile, "Line one.\n\nLine two with `code`.\n", "utf8");
  const r = runWrapper(["pr", "edit", "139", "--title", "New title", "--body-file", bodyFile], { env: classicFail });
  const lines = (r.log() ?? "").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert(r.status === 0, "exit 0 (the REST retry succeeded)");
  assert(lines.length === 2, "gh ran twice: pr edit, then the REST call");
  assert(lines[0]?.[0] === "pr" && lines[0]?.[1] === "edit", "first the original pr edit, argv untouched");
  const api = lines[1] ?? [];
  assert(api[0] === "api" && api.includes("PATCH"), "second call is gh api -X PATCH");
  assert(api.includes("repos/{owner}/{repo}/pulls/139"), "targets the PR by number, repo from gh's placeholders");
  assert(api.includes("title=New title"), "the title travels as -f title=...");
  const bodyArg = api.find((a) => a.startsWith("body=@")) ?? "";
  assert(bodyArg !== "" && !bodyArg.includes(bodyFile), "the body travels as a temp file, not the caller's file");
  assert(readFileSync(`${join(TEMP_DIR, "gh-log-" + runSeq + ".txt")}.body`, "utf8") === "Line one.\n\nLine two with `code`.\n", "the temp file held the exact body");
  assert(!existsSync(bodyArg.slice(6)), "the temp body file is removed after the run");
  assert(r.err.includes("Projects (classic)"), "gh's own error is still shown");
  assert(r.err.includes("retrying #139 as REST PATCH"), "the retry is announced on stderr");
}

console.log("spawn: the REST retry works for a title-only edit and a --body literal");
{
  const t = runWrapper(["pr", "edit", "5", "--title", "Only title"], { env: classicFail });
  const tApi = lastLogArgv(t.log());
  assert(t.status === 0 && tApi[0] === "api", "title-only: retried via api");
  assert(tApi.includes("title=Only title") && !tApi.some((a) => a.startsWith("body=@")), "title-only: no body field");
  const b = runWrapper(["pr", "edit", "5", "--body", "Literal body"], { env: classicFail });
  const bApi = lastLogArgv(b.log());
  assert(b.status === 0 && bApi[0] === "api" && !bApi.some((a) => a.startsWith("title=")), "body-only: no title field");
  assert(readFileSync(`${join(TEMP_DIR, "gh-log-" + runSeq + ".txt")}.body`, "utf8") === "Literal body", "body-only: literal body in the temp file");
}

console.log("spawn: no REST retry for other failures, other flags, or a clean run");
{
  const other = runWrapper(["pr", "edit", "5", "--title", "T"], { env: { FAKE_GH_FAIL_VERB: "pr edit", FAKE_GH_FAIL_STDERR: "GraphQL: Could not resolve to a PullRequest\n" } });
  assert(other.status === 1, "another gh failure keeps its exit code");
  assert((other.log() ?? "").trim().split("\n").length === 1, "and is not retried");
  const labels = runWrapper(["pr", "edit", "5", "--title", "T", "--add-label", "x"], { env: classicFail });
  assert(labels.status === 1 && (labels.log() ?? "").trim().split("\n").length === 1, "classic error + a label flag: no REST equivalent, gh's failure stands");
  const clean = runWrapper(["pr", "edit", "5", "--title", "T"]);
  assert(clean.status === 0 && (clean.log() ?? "").trim().split("\n").length === 1, "a clean pr edit runs once");
  const view = runWrapper(["pr", "view", "5"], { env: { FAKE_GH_FAIL_VERB: "pr view", FAKE_GH_FAIL_STDERR: CLASSIC_ERR } });
  assert(view.status === 1 && (view.log() ?? "").trim().split("\n").length === 1, "other verbs never retry");
}

console.log("spawn: the egress screen still comes first on the pr edit path");
{
  const r = runWrapper(["pr", "edit", "5", "--body", `see ${FAKE_SK_OR}`], { env: classicFail });
  assert(r.status === 1 && r.log() === null, "a secret-shaped body is blocked before any gh call, retry included");
}

// ---------------------------------------------------------------------------
rmSync(TEMP_DIR, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} assertions passed.`);
if (failed > 0) process.exit(1);
