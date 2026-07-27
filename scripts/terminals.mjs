// scripts/terminals.mjs
// Terminal window management — list, focus, stop agent console windows.
//
// Primary API (PID-based — reliable, used by dashboard):
//   isProcessAlive(pid)        → boolean
//   flashWindowByPid(pid,opts) → { ok, error? }  — taskbar flash (default UI path)
//   focusWindowByPid(pid)      → { ok, error? }  — blocked by Windows for bg processes
//   stopByPid(pid)             → { ok, error? }
//   listTerminals(runs, opts)  → array of terminal entries (uses consolePid)
//
// Legacy API (title-based — unreliable with Windows Terminal tabs and
// Claude Code overwriting the title to "✳ Claude Code" after agent start):
//   isWindowAlive(title)       → boolean
//   focusWindow(title)         → { ok, error? }
//   stopWindow(title)          → { ok, error? }

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a PowerShell snippet and return its trimmed stdout ("" on failure).
 *
 * The script is written to a temp .ps1 and executed with -File rather than
 * passed via -Command. Inline commands travel through cmd.exe, which mangles
 * any embedded double quote: `[DllImport("user32.dll")]` arrived at the C#
 * compiler as `[DllImport(" user32.dll\)]` and every Add-Type P/Invoke failed
 * to compile. A file has no quoting layer at all.
 */
function ps(command) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), "fenix-ps-"));
    const file = join(dir, "cmd.ps1");
    writeFileSync(file, command, "utf8");
    const out = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${file}"`,
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    return out.trim();
  } catch {
    return "";
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir cleanup is best-effort */
      }
    }
  }
}

/** Validate: pid must be a positive integer. Never inject unvalidated values. */
function validPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

// ---------------------------------------------------------------------------
// Primary API — PID-based (reliable)
// ---------------------------------------------------------------------------

/**
 * Check whether a process with the given PID exists.
 *
 * @param {number} pid  Process ID (positive integer)
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!validPid(pid)) return false;
  try {
    const out = ps(`Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id`);
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * Flash the taskbar button for a console window by its process PID.
 *
 * Uses Win32 FlashWindowEx via PowerShell Add-Type. Unlike SetForegroundWindow,
 * Windows does NOT block taskbar flashing from background processes — this is
 * the system-allowed way to get the user's attention. The default UI path for
 * the dashboard terminal panel.
 *
 * @param {number} pid  Process ID (positive integer)
 * @param {object} [opts]
 * @param {number} [opts.count=0]  Flash count (0 = until user switches to window)
 * @returns {{ ok: boolean, error?: string }}
 */
export function flashWindowByPid(pid, opts = {}) {
  if (!validPid(pid)) {
    return { ok: false, error: "PID musi być dodatnią liczbą całkowitą" };
  }
  try {
    const handleStr = ps(
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle`
    );
    if (!handleStr || handleStr === "0") {
      return {
        ok: false,
        error: "proces nie ma własnego okna (może działać jako karta w Windows Terminal lub VS Code)",
      };
    }

    const count = opts.count ?? 0;
    // FLASHW_ALL = 3 (taskbar + caption), FLASHW_TIMERNOFG = 12 (flash until
    // foreground). Combined = 15. uCount=0 means flash until the user switches.
    const dwFlags = 15; // FLASHW_ALL | FLASHW_TIMERNOFG

    const result = ps(`
      Add-Type -Name Win32Flash -Namespace TerminalFlash -MemberDefinition @'
        [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        public struct FLASHWINFO {
          public uint cbSize;
          public System.IntPtr hwnd;
          public uint dwFlags;
          public uint uCount;
          public uint dwTimeout;
        }
'@
      $fwi = New-Object TerminalFlash.Win32Flash+FLASHWINFO
      $fwi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($fwi)
      $fwi.hwnd = [IntPtr]::new(${handleStr})
      $fwi.dwFlags = ${dwFlags}
      $fwi.uCount = ${count}
      $fwi.dwTimeout = 0
      [TerminalFlash.Win32Flash]::FlashWindowEx([ref]$fwi)
    `);

    // FlashWindowEx returns the window's state BEFORE the call, not success:
    // nonzero only if the caption was already drawn as active. "False" is the
    // normal answer for a background window — the flash still happened. Treat
    // any completed call as success; only a thrown/empty result is a failure.
    if (result === "True" || result === "False") {
      return { ok: true, wasActive: result === "True" };
    }
    return { ok: false, error: "nie udało się wywołać FlashWindowEx" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Bring a console window to the foreground by its process PID.
 *
 * Uses Win32 ShowWindow + SetForegroundWindow via PowerShell Add-Type.
 * **In practice, Windows blocks SetForegroundWindow from background processes**
 * — the default UI path is `flashWindowByPid` (taskbar flash), which Windows
 * allows. Kept for potential foreground-server use.
 *
 * @param {number} pid  Process ID (positive integer)
 * @returns {{ ok: boolean, error?: string }}
 */
export function focusWindowByPid(pid) {
  if (!validPid(pid)) {
    return { ok: false, error: "PID musi być dodatnią liczbą całkowitą" };
  }
  try {
    // Get the MainWindowHandle for this PID
    const handleStr = ps(
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle`
    );
    if (!handleStr || handleStr === "0") {
      return {
        ok: false,
        error: "proces nie ma własnego okna (może działać jako karta w Windows Terminal lub VS Code)",
      };
    }

    // Win32: restore + bring to foreground
    const result = ps(`
      Add-Type -Name Win32Focus -Namespace TerminalFocus -MemberDefinition @'
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@
      $h = [IntPtr]::new(${handleStr})
      $r1 = [TerminalFocus.Win32Focus]::ShowWindow($h, 9)
      $r2 = [TerminalFocus.Win32Focus]::SetForegroundWindow($h)
      "$r1 $r2"
    `);

    if (result.includes("True")) return { ok: true };
    return { ok: false, error: "nie udało się aktywować okna (ShowWindow/SetForegroundWindow zwróciły false)" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Kill a process by its PID.
 *
 * @param {number} pid  Process ID (positive integer)
 * @returns {{ ok: boolean, error?: string }}
 */
export function stopByPid(pid) {
  if (!validPid(pid)) {
    return { ok: false, error: "PID musi być dodatnią liczbą całkowitą" };
  }
  try {
    if (!isProcessAlive(pid)) {
      return { ok: false, error: "proces o podanym PID nie istnieje" };
    }
    ps(`Stop-Process -Id ${pid} -Force`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Build a terminal list from run manifests.
 *
 * Uses `run.consolePid` for alive detection (PID-based, reliable).
 * `windowTitle` is kept as a display label only — never used for detection.
 *
 * @param {Array<object>} runs   Array of aggregateRun results (from scanRuns())
 * @param {object} [opts]
 * @param {number} [opts.finishedLimit=15]  Max finished (endedAt set) entries
 * @param {function} [opts.probe]  Process-alive probe (pid: number) => boolean.
 *   Injected for testing; defaults to the real isProcessAlive.
 * @returns {Array<object>}  Sorted: alive first (desc startedAt), then finished (desc startedAt)
 */
export function listTerminals(runs, opts = {}) {
  const finishedLimit = opts.finishedLimit ?? 15;
  const probe = opts.probe || isProcessAlive;

  const alive = [];
  const finished = [];

  for (const run of runs) {
    const hasPid = validPid(run.consolePid);
    const entry = {
      runId: run.runId,
      squad: run.squad || null,
      taskId: run.taskId || null,
      startedAt: run.startedAt || null,
      endedAt: run.endedAt || null,
      status: run.status || null,
      windowTitle: run.windowTitle || null,
      consolePid: hasPid ? run.consolePid : null,
      launchedBy: run.launchedBy || null,
      cwd: run.cwd || null,
      alive: false,
      canFocus: false,
      canSignal: false,
      costUSD: run.totals?.costUSD ?? null,
      partialCostUSD: run.totals?.partialCostUSD ?? null,
      unpricedUsageCount: run.totals?.unpricedUsageCount ?? 0,
    };

    if (run.endedAt) {
      // Finished runs are never alive — no PowerShell call needed.
      finished.push(entry);
    } else {
      // Only probe running runs (no endedAt). Performance-critical guard:
      // finished runs skip the PowerShell call entirely.
      if (hasPid) {
        entry.alive = probe(run.consolePid);
        entry.canFocus = entry.alive;
        entry.canSignal = entry.alive;
      }
      // Without consolePid: alive stays false, canFocus/canSignal stay false.
      // No probe call — nothing to check.
      alive.push(entry);
    }
  }

  // Sort: alive first (desc startedAt), then finished (desc startedAt)
  alive.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  finished.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));

  // Trim finished to limit
  const trimmedFinished = finished.slice(0, finishedLimit);

  return [...alive, ...trimmedFinished];
}

// ---------------------------------------------------------------------------
// Legacy API — title-based (unreliable, kept for manual-launch edge cases)
// ---------------------------------------------------------------------------

function escapePsString(str) {
  return str.replace(/'/g, "''");
}

function findWindowPid(title) {
  const safe = escapePsString(title);
  return ps(
    `Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim() -eq '${safe}' } | Select-Object -First 1 -ExpandProperty Id`,
  );
}

/**
 * Check whether a window with the given title exists.
 *
 * **Unreliable**: Windows Terminal appends a trailing space; Claude Code
 * overwrites the title to "✳ Claude Code" after agent start. Prefer
 * `isProcessAlive(consolePid)` for dashboard-launched agents.
 *
 * @param {string} title  Window title
 * @returns {boolean}
 */
export function isWindowAlive(title) {
  if (!title || typeof title !== "string") return false;
  try {
    return findWindowPid(title).length > 0;
  } catch {
    return false;
  }
}

/**
 * Bring a window to the foreground by title.
 *
 * **Unreliable**: AppActivate matches by prefix and returns false from
 * non-interactive Node. Prefer `focusWindowByPid(consolePid)`.
 *
 * @param {string} title  Window title
 * @returns {{ ok: boolean, error?: string }}
 */
export function focusWindow(title) {
  if (!title || typeof title !== "string") {
    return { ok: false, error: "tytuł okna jest wymagany" };
  }
  try {
    const pid = findWindowPid(title);
    if (!pid) return { ok: false, error: "okno nie istnieje" };
    const safe = escapePsString(title);
    const out = ps(`(New-Object -ComObject WScript.Shell).AppActivate('${safe}')`);
    if (out === "True") return { ok: true };
    return { ok: false, error: "nie udało się aktywować okna" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Kill the process owning a window with the given title.
 *
 * **Unreliable**: title-based matching. Prefer `stopByPid(consolePid)`.
 *
 * @param {string} title  Window title
 * @returns {{ ok: boolean, error?: string }}
 */
export function stopWindow(title) {
  if (!title || typeof title !== "string") {
    return { ok: false, error: "tytuł okna jest wymagany" };
  }
  try {
    const pid = findWindowPid(title);
    if (!pid) return { ok: false, error: "okno nie istnieje" };
    ps(`Stop-Process -Id ${pid} -Force`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
