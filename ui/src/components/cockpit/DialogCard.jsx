// DialogCard (FOC-810) — a TUI permission or select dialog rendered for the
// dashboard. The body lines are the capture's lines filtered through
// dialogTextLines() (the title, options, auto-mode nudge, footer and command
// all render elsewhere on the card). A permission dialog shows the command
// in a pre block and offers
// the buttons dialogActions() derived from the options on screen (allow-once /
// allow-always / deny — never auto-mode); "Deny" first reveals an optional
// note telling the Supervisor what to do instead, then a Deny confirm. A
// select dialog only dismisses (Esc). The parent owns busy/error and the
// actual POST; onOpenTerminal switches the panel to the Terminal tab when
// provided.

import { useState } from 'react';
import { dialogActions, dialogTextLines } from '../../cockpitModel';

export default function DialogCard({ dialog, busy, error, onChoose, onOpenTerminal }) {
  const [denyOpen, setDenyOpen] = useState(false);
  const [note, setNote] = useState('');
  if (!dialog) return null;

  const isPermission = dialog.kind === 'permission';
  const actions = dialogActions(dialog);
  // The body lines are filtered (dialogTextLines): the capture repeats the
  // title, the option lines, the auto-mode nudge, the footer and the command
  // — each of those renders elsewhere on the card already.
  const lines = dialogTextLines(dialog);

  const choose = (choice) => {
    if (busy) return;
    // Permission deny gets the note step first; select dismiss goes straight
    // out (the host presses Esc either way).
    if (choice === 'deny' && isPermission && !denyOpen) {
      setDenyOpen(true);
      return;
    }
    onChoose(choice, note.trim() || undefined);
    setNote('');
    setDenyOpen(false);
  };

  return (
    <div className="ck-card">
      <div className="ck-card-title">{dialog.title || 'The Supervisor needs a decision'}</div>
      {lines.map((l, i) => (
        <div key={i} className="ck-card-line">
          {l}
        </div>
      ))}
      {isPermission && dialog.command && <pre className="ck-card-command">{dialog.command}</pre>}
      {dialog.footer && <div className="ck-card-footer">{dialog.footer}</div>}

      <div className="ck-card-actions">
        {actions.map((a) => (
          <button
            key={a.choice}
            type="button"
            className={a.choice === 'deny' ? 'btn-secondary' : 'launch-btn'}
            disabled={busy}
            onClick={() => choose(a.choice)}
          >
            {a.label}
          </button>
        ))}
        {onOpenTerminal && (
          <button type="button" className="link ck-card-link" onClick={onOpenTerminal}>
            Open Terminal
          </button>
        )}
        {error && <span className="ck-card-error">{error}</span>}
      </div>

      {denyOpen && (
        <div className="ck-card-note">
          <input
            type="text"
            className="filter-search"
            style={{ flex: 1 }}
            value={note}
            disabled={busy}
            placeholder="Tell the Supervisor what to do instead (optional)"
            aria-label="Optional note for the deny"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') choose('deny');
            }}
          />
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => choose('deny')}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
