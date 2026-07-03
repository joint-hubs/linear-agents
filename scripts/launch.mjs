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

import { join } from 'node:path';
import { spawn } from 'node:child_process';

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
export const KICKOFF_TEMPLATES = {
  plan: [
    'Feature approved do zaplanowania: {taskId} (albo: planning/inbox/<plik>.md).',
    'Przejdź pełny cykl PLAN: discovery → spec (+ADR jeśli decyzja architektoniczna)',
    '→ spec-review → decompose na vertical slices z AC/DoD/estimate(t-shirt).',
    'GATE 1: pokaż brief (≤1 str.) + pytania, czekaj na moje ✅.',
    'GATE 2: pokaż 2–3 przykładowe subtaski z AC, zapytaj "tworzę w Linear?", czekaj ✅.',
    'Po ✅ pushnij do Linear (team FEN) jako epic + subtaski w Todo z dor-ok.',
  ],
  dev: [
    'Weź task {taskId} (Todo, dor-ok). Krok po kroku wg FENIX_WORKFLOW §5:',
    '1) update status → In Progress, assignee @flow, label ai:coded, komentarz 👀.',
    '2) recon: przeczytaj task + AC + powiązany kod (nie zgaduj — niejasne → needs:answer + @Mateusz + stop).',
    '3) zaimplementuj NAJMNIEJSZY pełny slice spełniający AC.',
    '4) self-test (logi/curl/UI; docker → rebuild+redeploy).',
    '5) commit (jeden task = jeden commit, format §3, BEZ Co-Authored-By). NIE pushuj bez mojej zgody.',
    '6) deliver_task → In Review + podsumowanie PL: co zrobione, wyniki testów, jak testować.',
  ],
  review: [
    'Zrób review taska {taskId} (In Review). Trzy przebiegi: first-pass (DeepSeek Pro),',
    'security (Kimi), deep (GLM-5.2). Zwróć verdykt:',
    '- APPROVE → dodaj ai:reviewed + dod-ok, nadaj wersję (label version:<sesja>, patrz §5),',
    '  ustaw stage:testing i przekaż do TEST; komentarz PL z findings (liczba/severity, co przeszło).',
    '- RETURN → wypisz konkretne poprawki, status → In Progress, licznik rundy +1.',
    'Limit 2 rundy DEV↔REVIEW; po 2 bez zbieżności → label escalated + @Mateusz + stop.',
  ],
  test: [
    'Zdeployuj i przetestuj {taskId} (stage:testing, wersja version:<sesja>).',
    '1) deploy nowej wersji na target z config/projects.json (health-check).',
    '2) uruchom scenariusze testowe wg AC + smoke golden path + edge cases.',
    '3) PASS → status Done + dod-ok + komentarz PL (deploy URL, wyniki, health).',
    '   FAIL → auto-rollback, status → In Progress, opis błędu + jak powtórzyć.',
    'Dane testowe syntetyczne (żadnego prod PII).',
  ],
  cadence: [
    'Tygodniowy przebieg CADENCE: zbierz stan tablicy (wszystkie squady),',
    'zrób retro (cycle time, throughput, rundy review, $/task) i wygeneruj',
    'digest po polsku dla Mateusza. Read-only — żadnych zmian scope.',
  ],
};

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
  return [
    '@echo off',
    'REM Auto-generated by telemetry-server POST /api/launch (L1b, control-plane-plan §3.1).',
    `REM Squad: ${squad}  Task: ${taskId}  — window opened by dashboard launch.`,
    `set "LA_TASK_ID=${taskId}"`,
    `call "${launcher}" "${safeKick}"`,
  ].join('\r\n') + '\r\n';
}

// Open a NEW console window running the wrapper .bat. `start "" cmd /k
// <wrapper>` creates the window — the empty quoted arg is `start`'s window
// title (the standard batch idiom: an explicit title prevents `start` from
// treating the first path token as a title if a future clone has spaces).
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
export function spawnLauncher(wrapperPath, cwd) {
  const child = spawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', wrapperPath], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}
