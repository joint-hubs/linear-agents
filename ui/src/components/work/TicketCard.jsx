// The Work board's ticket card (FOC-784 + the labels task). Extracted from
// screens/Work.jsx so the card owns its own rules instead of the screen:
//
// - stage vs run status are two visibly and structurally different things.
//   The stage (Ready/Dev/…, where the ticket sits in the flow) shows as the
//   column position PLUS a muted bordered stage tag; the run status (a child
//   running, a gate waiting, a crash) shows as tone chips with the text
//   always present (spec §7). The stage tag never uses a flag tone, so the
//   two vocabularies cannot be confused by colour alone.
// - Linear labels ride the card as chips; empty is normal and renders
//   nothing (no placeholder).
// - cost / flags / age behave exactly as cardModel dictates; the Start flow
//   stays where it was (the Ready panel's Start button + StartDialog).

import { cardModel } from '../../workModel';
import LabelChip from './LabelChip';
import { Link } from 'react-router-dom';
import { cockpitUrl } from '../../taskCockpitModel';
import './work-labels.css';

export default function TicketCard({ ticket, now, onOpen }) {
  const m = cardModel(ticket, now);
  if (!m.id) return null;
  return (
    <div className="wk-card-entry">
    <button type="button" className="wk-card" onClick={() => onOpen(m.id)}>
      <span className="wk-card-head">
        <span className="wk-card-id">{m.id}</span>
        {m.stageLabel && (
          <span className="wk-card-stage" title={`Stage: ${m.stageLabel}`}>
            {m.stageLabel}
          </span>
        )}
      </span>
      {m.title && <span className="wk-card-title">{m.title}</span>}
      {m.labels.length > 0 && (
        <span className="wk-labels" aria-label="Linear labels">
          {m.labels.map((l) => (
            <LabelChip key={l.id || l.name} label={l} />
          ))}
        </span>
      )}
      {m.flags.length > 0 && (
        <span className="wk-card-flags" aria-label="Run status">
          {m.flags.map((f, i) => (
            <span key={i} className={`ck-chip ck-tone-${f.tone}`}>
              {f.text}
            </span>
          ))}
        </span>
      )}
      <span className="wk-card-meta">
        {m.rounds && <span>{m.rounds}</span>}
        {m.cost && <span>{m.cost}</span>}
        {m.age && <span className="muted">{m.age}</span>}
      </span>
    </button>
    {ticket.taskKey && <Link className="link wk-card-cockpit" to={cockpitUrl(ticket.taskKey)}>Open cockpit →</Link>}
    </div>
  );
}