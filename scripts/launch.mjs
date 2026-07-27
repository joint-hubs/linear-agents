// scripts/launch.mjs
// Pure launch logic for POST /api/launch (L1b, control-plane-plan §3.1 + §5).
// Extracted from telemetry-server.mjs so it can be unit-tested directly
// (validation, kickoff prompt, wrapper .bat, loopback check) without spinning
// up the HTTP server. The route in telemetry-server.mjs imports these and
// layers the IO (write .state/ wrapper, spawn cmd window) on top.
//
// Security shape (§5): launch = remote code execution by definition, so the
// inputs are locked down — 127.0.0.1 origin, squad allowlist, taskId regex.
// No arbitrary arguments ever reach the spawned shell.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROMPTS_PATH = join(__dir, '..', 'config', 'prompts.json');

// Squads with a launcher (bin/<squad>.bat) AND a HOW-TO §4 kickoff template.
export const SQUAD_ALLOWLIST = ['plan', 'dev', 'review', 'test', 'cadence'];

// Linear identifier shape — strict, so a crafted taskId can't smuggle cmd
// metacharacters into the wrapper .bat (it's interpolated into `set` + `call`).
export const TASK_ID_RE = /^[A-Z]+-\d+$/;

// HOW-TO-RUN-AGENTS §4 kickoff templates, one per squad. Newlines collapsed to
// " | " so the whole prompt fits on a single cmd line (a .bat `call` can't span
// lines). {taskId} is substituted at prompt-build time. Verbatim from §4 —
// the agent starts with identical instructions whether launched from the
// dashboard or by hand.
//
// Primary source: config/prompts.json (editable from dashboard). If the file is
// missing, unparsable, or missing a squad, we fall back to these defaults so
// agent launch NEVER breaks on a config typo.
//
// A kickoff is a TRIGGER, not a second definition of the loop. The loop lives in
// agents/<squad>/CLAUDE.md, the models in agents/<squad>/agents/*.md +
// config/models.json, the team in LINEAR_TEAM_KEY. Restating any of those here
// creates a copy that silently drifts from the original — which is exactly what
// happened: this fallback named "DeepSeek Pro / Kimi / GLM-5.2" for the review
// passes and hardcoded "team FEN", so editing a model in the dashboard left the
// prompt pointing at the old one. Keep these lines pointing AT the source.
export const DEFAULT_KICKOFF_TEMPLATES = {
  plan: [
    'Feature approved do zaplanowania: {taskId} (albo: planning/inbox/<plik>.md).',
    'Przejdź pełny cykl PLAN wg swojego CLAUDE.md (sekcja Pętla), z bramkami GATE 1 i GATE 2.',
    'Push idzie do teamu z LINEAR_TEAM_KEY — nie zakładaj innego.',
  ],
  dev: [
    'Weź task {taskId}. Pełna pętla jest w Twoim CLAUDE.md (sekcja Pętla) —',
    'od resume-checku po hand-off. Trzymaj się jej, nie improwizuj kolejności.',
    'Przypomnienie o dwóch rzeczach, na których najłatwiej się potknąć:',
    'niejasne AC → needs:answer + @Mateusz i STOP (nie zgaduj);',
    'NIE pushuj bez mojej zgody.',
  ],
  review: [
    'Zrób review taska {taskId} (In Review) wg swojego CLAUDE.md (sekcja Pipeline).',
    'Trzy przebiegi równolegle, potem scal w Conventional Comments i wydaj werdykt.',
    'Modele przebiegów bierzesz z agents/review/agents/*.md — nie wybieraj ich sam.',
  ],
  test: [
    'Zdeployuj i przetestuj {taskId} (stage:testing) wg swojego CLAUDE.md (sekcja Pętla).',
    'Target deployu z config/projects.json, health-check obowiązkowy,',
    'przy failu auto-rollback. Dane testowe syntetyczne (żadnego prod PII).',
  ],
  cadence: [
    'Tygodniowy przebieg CADENCE wg swojego CLAUDE.md: collector → retro → digest.',
    'Digest po polsku dla Mateusza. Read-only — żadnych zmian scope.',
  ],
};

// Lazy-loaded from config/prompts.json, with in-module cache.
// Use reloadKickoffTemplates() after writing the file from the dashboard UI.
let _kickoffCache = null;

function _loadKickoffFromFile() {
  try {
    if (!existsSync(PROMPTS_PATH)) {
      console.error('[launch] config/prompts.json not found — using built-in defaults');
      return { ...DEFAULT_KICKOFF_TEMPLATES };
    }
    const raw = readFileSync(PROMPTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.kickoff) {
      console.error('[launch] config/prompts.json missing "kickoff" section — using built-in defaults');
      return { ...DEFAULT_KICKOFF_TEMPLATES };
    }
    const result = {};
    for (const squad of SQUAD_ALLOWLIST) {
      const lines = parsed.kickoff[squad];
      if (!Array.isArray(lines) || lines.length === 0) {
        console.error(`[launch] config/prompts.json: squad "${squad}" missing or empty — using built-in default`);
        result[squad] = [...DEFAULT_KICKOFF_TEMPLATES[squad]];
      } else {
        result[squad] = [...lines];
      }
    }
    return result;
  } catch (err) {
    console.error(`[launch] config/prompts.json parse error: ${err.message} — using built-in defaults`);
    return { ...DEFAULT_KICKOFF_TEMPLATES };
  }
}

export let KICKOFF_TEMPLATES = _loadKickoffFromFile();

/** Force re-read of config/prompts.json. Call after the dashboard writes it. */
export function reloadKickoffTemplates() {
  _kickoffCache = null;
  KICKOFF_TEMPLATES = _loadKickoffFromFile();
}

// Pure validation. Returns {ok,...} or {ok:false, status, error}. Never throws.
// AC2: bad taskId or off-allowlist squad → 400, and the caller spawns nothing
// (it only spawns after ok:true && !dryRun && target!=='vm').
//
// Note (D-Q1, review round 1): control-plane-plan §3.1 payload is
// {taskId, squad, target, mode} — `mode` is intentionally NOT validated or
// propagated here; its semantics are deferred to L2/L3 and the AC doesn't
// mention it. Extra body fields are silently ignored, so a `mode` value never
// reaches the spawned shell. Wire it when its meaning is specified.
export function validateLaunch(body) {
  const taskId = String((body && body.taskId) || '').trim();
  if (!TASK_ID_RE.test(taskId)) {
    return { ok: false, status: 400, error: `invalid taskId: must match ${TASK_ID_RE.source}` };
  }
  const squad = String((body && body.squad) || '').trim().toLowerCase();
  if (!SQUAD_ALLOWLIST.includes(squad)) {
    return { ok: false, status: 400, error: `invalid squad: must be one of ${SQUAD_ALLOWLIST.join(', ')}` };
  }
  const target = String((body && body.target) || 'local').trim().toLowerCase();
  if (target !== 'local' && target !== 'vm') {
    return { ok: false, status: 400, error: "invalid target: must be 'local' or 'vm'" };
  }
  const dryRun = (body && body.dryRun) === true;
  return { ok: true, taskId, squad, target, dryRun };
}

// Build the single-line kickoff prompt for a squad+task. Pure → unit-testable.
export function kickoffPrompt(squad, taskId) {
  const lines = KICKOFF_TEMPLATES[squad] || [];
  return lines.join(' | ').replaceAll('{taskId}', taskId);
}

// Window title for the spawned cmd.exe window. Uses "-" (not "·") so the
// value is batch-safe and matches LA_WINDOW_TITLE exactly — the terminal panel
// matches windows by this string.
// Format: "fenix - <squad> - <taskId>" or "fenix - <squad>" when taskId is null/empty.
export function windowTitle(squad, taskId) {
  if (taskId) return `fenix - ${squad} - ${taskId}`;
  return `fenix - ${squad}`;
}

// AC3: launch is 127.0.0.1 only. Binding to 127.0.0.1 is the real enforcement
// (no external socket); this check makes rejection observable and defends if
// the server is ever fronted by a proxy (X-Forwarded-* is intentionally NOT
// honored — launch must be a direct local call).
export function isLocalOrigin(remoteAddress) {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

// D-S1 (review round 1, 🟠 security): the remoteAddress check alone can't tell
// the dashboard apart from a malicious website in Mateusz's browser — both have
// remoteAddress=127.0.0.1 because the browser runs locally. A cross-site page
// can `fetch('http://127.0.0.1:7331/api/launch', ...)` and the bind/remoteAddress
// checks pass, spawning a credential-bearing agent (CSRF). Browsers always send
// an `Origin` header on POST, so when it's present we require it to be loopback
// too. Absent Origin (curl, the server's own --smoke, server-to-server) is
// allowed — non-browser clients can't mount a browser-CSRF vector. This is
// defense-in-depth on the launch crown jewel (§5) before JOI-70 wires the UI.
const ALLOWED_ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;
export function isAllowedOrigin(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGIN_RE.test(origin);
}

// Build the wrapper .bat content. The wrapper sets LA_TASK_ID and calls the
// squad launcher with the kickoff prompt as the initial claude argument. We
// write a .bat file (instead of spawning `start ... <cmd>` directly from Node)
// so the multi-word prompt never goes through Node's cmd.exe arg-quoting — the
// prompt lives inside the .bat as a single quoted argument, where cmd's
// redirection chars (< > & |) are literal because they're inside quotes.
export function buildLaunchBat(squad, taskId, kickoff, rootPath) {
  const launcher = join(rootPath, 'bin', `${squad}.bat`);
  // Defensive: templates contain no double-quotes, but swap any to single so
  // the quoted argument can't be broken out of.
  const safeKick = kickoff.replace(/"/g, "'");
  // Title set via `title` command inside the wrapper — works regardless of
  // how the window was spawned (conhost, Windows Terminal, or bare cmd).
  // Must match LA_WINDOW_TITLE exactly so the terminal panel can find the window.
  const batTitle = windowTitle(squad, taskId);
  return [
    '@echo off',
    `title ${batTitle}`,
    'REM Auto-generated by telemetry-server POST /api/launch (L1b, control-plane-plan §3.1).',
    `REM Squad: ${squad}  Task: ${taskId}  — window opened by dashboard launch.`,
    'set "LA_LAUNCHED_BY=dashboard"',
    `set "LA_WINDOW_TITLE=${batTitle}"`,
    `set "LA_TASK_ID=${taskId}"`,
    `call "${launcher}" "${safeKick}"`,
  ].join('\r\n') + '\r\n';
}

// Open a NEW console window running the wrapper .bat.
//
// We route through conhost.exe to force a standalone console window — without
// it, `start` opens a tab in Windows Terminal (the user's default terminal),
// which means: (a) the window title belongs to WindowsTerminal.exe, not cmd.exe,
// (b) only the active tab is detectable, and (c) Windows Terminal appends a
// trailing space to the title. conhost.exe gives each agent its own HWND with
// the title set by the wrapper's `title` command, which the terminal panel
// matches against LA_WINDOW_TITLE.
//
// We use `shell: true` (cmd /c) instead of the args-array form because Node's
// arg-quoting mangles arguments with embedded quotes — the args-array approach
// fails to spawn conhost.exe at all. With `shell: true`, the entire command is
// a single string passed to cmd.exe, which handles quoting natively.
//
// Fallback: if conhost.exe is not found at the system path, we fall back to
// the old `start "" cmd /k` form and log a warning — the terminal panel won't
// detect the window, but the agent still launches.
//
// `cmd /k` keeps the window open after the launcher exits so any error stays
// visible. detached + unref so the spawned window outlives the server process.
//
// D-N1 (review round 1) note on the path-quoting trap: the review suggested
// quoting the path too (`start "launch" cmd /k "<path>"`), but Node's Windows
// arg-quoting mangles an arg that contains embedded `"` chars (it triggers
// escape mode and corrupts the command line) — verified: that form FAILS to
// spawn (marker .bat never runs). The path is therefore left UNquoted, which
// works because the wrapper path has NO spaces (validated squad/taskId +
// no-space repo root + `.state`). Full spaced-path support isn't achievable
// through Node's arg array; the no-space precondition is enforced upstream
// (TASK_ID_RE + SQUAD_ALLOWLIST + a no-space repo root) and documented here.
// With `shell: true` we bypass Node's arg-quoting entirely — the command string
// goes straight to cmd.exe, so quoting would be safe, but we keep the path
// unquoted for consistency with the D-N1 invariant.
//
// The `title` parameter is kept for backward compatibility but is no longer
// used for the `start` title — the real window title is set inside the wrapper
// via the `title` batch command, which works regardless of how the window was
// spawned.
const CONHOST_PATH = 'C:\\Windows\\System32\\conhost.exe';
const _useConhost = existsSync(CONHOST_PATH);

export function spawnLauncher(wrapperPath, cwd, title) {
  // `start ""` — empty title prevents `start` from misinterpreting the first
  // path token as a title. The real title is set inside the wrapper .bat.
  const cmd = _useConhost
    ? `start "" C:\\Windows\\System32\\conhost.exe cmd /k ${wrapperPath}`
    : `start "" cmd /k ${wrapperPath}`;

  if (!_useConhost) {
    console.error('[launch] conhost.exe not found — falling back to default terminal (terminal panel may not detect this window)');
  }

  const child = spawn(cmd, [], {
    shell: true,
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}
