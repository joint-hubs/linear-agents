// Terminal view (FOC-783) — a read-write xterm client of the Supervisor's tmux
// session over /api/supervisor/terminal. Server→client frames are terminal
// output; client→server frames are JSON only: {"t":"i","d":input} and
// {"t":"r","c":cols,"r":rows}. Closing the socket detaches this client only.
//
// Close 1013 = the host is still starting, 1011 = unavailable; either shows a
// reconnect button with the reason. Disposes everything on unmount.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { terminalSocketUrl } from '../../api';
import '@xterm/xterm/css/xterm.css';

// IBM Plex Mono first (spec §7 type), then the existing --mono stack. CSS
// custom properties don't resolve inside canvas measuring, so the stack is
// repeated here with the same fallbacks theme.css uses. The trailing
// symbol fallbacks cover TUI glyphs (❯ ─ ⏵ ✻ ●) IBM Plex Mono lacks —
// without them xterm renders those cells as "_".
const FONT_FAMILY =
  "'IBM Plex Mono', 'Cascadia Code', Consolas, 'SF Mono', " +
  "'Cascadia Mono', 'Segoe UI Symbol', 'Apple Symbols', 'DejaVu Sans Mono', " +
  "'Noto Sans Symbols 2', monospace";

const CLOSE_REASONS = {
  1013: 'the Supervisor host is starting — try again in a moment',
  1011: 'the terminal is unavailable',
  1006: 'the connection was lost',
};

export default function TerminalView() {
  const hostRef = useRef(null);
  const [attempt, setAttempt] = useState(0); // reconnect re-runs the effect
  const [closed, setClosed] = useState(null); // { code, reason }

  useEffect(() => {
    setClosed(null);
    const host = hostRef.current;
    if (!host) return undefined;

    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 5000,
      customGlyphs: true, // xterm draws box-drawing/blocks itself, not via the font
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      // zero-size container before layout — the ResizeObserver below re-fits
    }

    let ws = null;
    let disposed = false;

    const sendResize = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
      }
    };

    ws = new WebSocket(terminalSocketUrl(term.cols, term.rows));
    ws.onopen = sendResize;
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') term.write(ev.data);
    };
    ws.onclose = (ev) => {
      if (disposed) return;
      setClosed({
        code: ev.code,
        reason:
          CLOSE_REASONS[ev.code] ||
          'the terminal closed (code ' + ev.code + (ev.reason ? ': ' + ev.reason : '') + ')',
      });
    };

    // Local typing goes out as an input frame; nothing else is ever sent.
    term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'i', d: data }));
      }
    });
    term.onResize(sendResize);

    // Keep the grid matched to the panel size.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // not laid out yet
      }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      ro.disconnect();
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      term.dispose();
    };
  }, [attempt]);

  return (
    <div className="ck-terminal">
      <div className="ck-terminal-host" ref={hostRef} aria-label="Supervisor terminal" />
      {closed && (
        <div className="ck-terminal-overlay">
          <div>Terminal disconnected — {closed.reason}.</div>
          <button type="button" className="btn-secondary" onClick={() => setAttempt((a) => a + 1)}>
            Reconnect
          </button>
        </div>
      )}
    </div>
  );
}
