// AskCard (FOC-810) — the Supervisor's AskUserQuestion rendered for the
// dashboard, in place of the TUI: one block per question with its header chip,
// radio buttons for single-select and checkboxes for multiSelect, each option
// with its description in muted text, and an "Other" free-text field for
// single-select questions (typing it selects it — askAnswers lets the text
// win). Submit stays disabled until askAnswers() accepts the selection; the
// parent owns busy/error and the actual POST.

import { useId, useState } from 'react';
import { askAnswers } from '../../cockpitModel';

const EMPTY_SEL = { choices: [], text: '' };

export default function AskCard({ ask, busy, error, onSubmit }) {
  // Radio groups are document-scoped outside a form — the panel card and the
  // inbox card can be mounted at once, so the names must not collide.
  const uid = useId();
  const questions = (ask && ask.questions) || [];
  // { [questionIndex]: { choices: [optionIndex…], text } } — the shape
  // askAnswers consumes.
  const [selection, setSelection] = useState({});

  const setSel = (qi, patch) =>
    setSelection((prev) => ({ ...prev, [qi]: { ...EMPTY_SEL, ...(prev[qi] || {}), ...patch } }));

  const check = askAnswers(ask, selection);

  const submit = () => {
    if (!check.ok || busy) return;
    onSubmit(check.answers);
  };

  return (
    <div className="ck-card">
      <div className="ck-card-title">The Supervisor is asking you</div>
      {questions.length === 0 && <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>No questions in this ask.</div>}
      {questions.map((q, qi) => {
        const sel = selection[qi] || EMPTY_SEL;
        const multi = !!q.multiSelect;
        const chosen = (oi) => sel.choices.includes(oi);
        return (
          <div key={qi} className="ck-card-q">
            {q.header && <span className="chip ck-mono-small">{q.header}</span>}
            <div className="ck-card-q-text">{q.question}</div>
            <div className="ck-card-options">
              {(q.options || []).map((o, oi) => (
                <label key={oi} className="ck-card-opt">
                  <input
                    type={multi ? 'checkbox' : 'radio'}
                    name={uid + '-q' + qi}
                    checked={chosen(oi)}
                    disabled={busy}
                    onChange={() =>
                      multi
                        ? setSel(qi, {
                            choices: chosen(oi)
                              ? sel.choices.filter((c) => c !== oi)
                              : [...sel.choices, oi],
                          })
                        : setSel(qi, { choices: [oi], text: '' })
                    }
                  />
                  <span>
                    {o.label}
                    {o.description && <span className="ck-card-opt-desc">{o.description}</span>}
                  </span>
                </label>
              ))}
              {!multi && (
                <label className="ck-card-opt">
                  <span className="ck-card-opt-label">Other</span>
                  <input
                    type="text"
                    className="filter-search"
                    style={{ flex: 1, minWidth: 160 }}
                    value={sel.text}
                    disabled={busy}
                    placeholder="Type your own answer…"
                    aria-label={'Free-text answer for question ' + (qi + 1)}
                    onChange={(ev) => setSel(qi, { text: ev.target.value, choices: [] })}
                  />
                </label>
              )}
            </div>
          </div>
        );
      })}
      <div className="ck-card-actions">
        <button
          type="button"
          className="launch-btn"
          disabled={!check.ok || busy || questions.length === 0}
          onClick={submit}
        >
          {busy ? 'Sending…' : 'Submit answers'}
        </button>
        {error && <span className="ck-card-error">{error}</span>}
      </div>
    </div>
  );
}
