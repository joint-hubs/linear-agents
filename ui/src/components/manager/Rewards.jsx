// Rewards surface for the Manager screen (FOC-225 slice 3).
//
// Three pieces, one discipline (fenix-manager-rewards.md §6):
//   - RewardsHeaderChip — compact ★ L{level} · {xp} XP next to the squad
//     selector; title carries the product-rules label from the payload.
//     Renders NOTHING while loading, on error or when the squad has no
//     records — the header never invents an XP state.
//   - AchievementsPanel — the Achievements tab: squad XP/level/badges, the
//     ≤10 newest ledger records, the awaiting-verified-evidence state and the
//     squad-level-only note. Nothing pending renders as earned.
//   - RatingControl — the ONLY human-authoring surface for ratings (Inspector
//     History rows, per ended run with a task): stage a 1..5 selection, then
//     an explicit Save. Per-endpoint errors surface verbatim. A rating never
//     carries points and never averages with the acceptance verdict.
//
// Motion: none is added — chips, badges and tables are static; a reduced-
// motion preference therefore has nothing to silence here.

import { useEffect, useState } from 'react';
import {
  formatXp,
  heldCount,
  ratingForRun,
  recordMeta,
  recordPoints,
  rulesLabel,
  shortWhen,
  squadRewardsView,
} from '../../manager/rewards.js';

// Header chip for the selected squad — icon + text, never color alone.
export function RewardsHeaderChip({ rewards, squadKey }) {
  const view = squadRewardsView(rewards?.data, squadKey);
  if (view.state !== 'ready') return null;
  const label = rulesLabel(view.rules);
  return (
    <span className="mgr-rewards-chip" title={label ? `product rules — ${label}` : 'verified-delivery XP'}>
      <span className="mgr-rewards-chip-star" aria-hidden="true">★</span>
      L{view.level} · {formatXp(view.xp)} XP
    </span>
  );
}

// Records table (≤10, server-bound): newest first, each row icon + text.
function RecordsTable({ records }) {
  return (
    <table className="mgr-table mgr-table-tight">
      <thead>
        <tr>
          <th scope="col">Kind</th>
          <th scope="col">Task</th>
          <th scope="col">Points</th>
          <th scope="col">When</th>
          <th scope="col">Evidence</th>
        </tr>
      </thead>
      <tbody>
        {records.map((r) => {
          const meta = recordMeta(r);
          const points = recordPoints(r);
          return (
            <tr key={r.id}>
              <td>
                <span className="mgr-rewards-kind" title={meta.label}>
                  <span aria-hidden="true">{meta.glyph}</span> {meta.label}
                </span>
              </td>
              <td>{r.taskId || '—'}</td>
              <td className="mgr-cell-mono">{points ?? '—'}</td>
              <td>{shortWhen(r.recordedAt) || '—'}</td>
              <td className="mgr-cell-mono mgr-rewards-evidence" title={r.evidenceId || ''}>
                {r.evidenceId || '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function AchievementsPanel({ rewards, squadKey }) {
  const view = squadRewardsView(rewards?.data, squadKey);
  const label = view.rules ? rulesLabel(view.rules) : null;
  const held = heldCount(rewards?.data);

  return (
    <div className="mgr-rewards" data-testid="mgr-achievements">
      {view.state === 'loading' && <p className="mgr-muted">loading rewards…</p>}

      {view.state === 'error' && (
        <div className="mgr-save-error" role="alert">
          <p className="mgr-error-title">Rewards could not be loaded</p>
          <p>{rewards?.error?.message || 'GET /api/manager/rewards failed.'}</p>
          <button type="button" className="mgr-btn mgr-btn-sm" onClick={rewards?.reload}>
            Retry
          </button>
        </div>
      )}

      {view.state === 'awaiting' && (
        <div className="mgr-rewards-awaiting" role="note">
          <p className="mgr-rewards-awaiting-title">
            <span aria-hidden="true">◌</span> awaiting verified evidence
          </p>
          <p className="mgr-muted">
            No verified deliveries are on record for <strong>{squadKey}</strong> yet. XP appears only when
            supervisor verdict rounds are ingested into the ledger — never from runs, costs or exit codes.
          </p>
        </div>
      )}

      {view.state === 'ready' && (
        <>
          <p className="mgr-rewards-xp">
            <span className="mgr-rewards-chip-star" aria-hidden="true">★</span> L{view.level} ·{' '}
            {formatXp(view.xp)} XP
          </p>
          <p className="mgr-rewards-badge-row" aria-label="badges">
            {view.badges.map((b) => (
              <span
                key={b.id}
                className={`mgr-rw-badge${b.earned ? ' mgr-rw-badge-earned' : ' mgr-rw-badge-locked'}`}
                title={b.earned ? `earned — ${b.need} distinct verified deliver${b.need === 1 ? 'y' : 'ies'}` : `locked — needs ${b.need} distinct verified deliveries`}
              >
                <span aria-hidden="true">{b.glyph}</span> {b.label}
              </span>
            ))}
          </p>
          {view.records.length > 0 ? (
            <RecordsTable records={view.records} />
          ) : (
            <p className="mgr-empty-note">no ledger records for this squad</p>
          )}
        </>
      )}

      {view.state !== 'loading' && view.state !== 'error' && (
        <div className="mgr-rewards-notes">
          <p className="mgr-muted">
            <span aria-hidden="true">ⓘ</span> squad-level only — per-role attribution is not available
            in v1. Role participation is <strong>awaiting evidence</strong> and stays unattributed; nothing
            is inferred from costs, exit codes or tool usage.
          </p>
          {label && (
            <p className="mgr-muted">
              <span aria-hidden="true">ⓘ</span> XP arithmetic follows the product rules — {label}. XP is a
              bookkeeping view of verified deliveries, not a training signal.
            </p>
          )}
          {held > 0 && (
            <p className="mgr-warn-note" role="note">
              <span aria-hidden="true">◌</span> {held} accepted deliver{held === 1 ? 'y is' : 'ies are'} held
              at an unresolved credit subject — listed once a producing run links up. Not attributed to any
              squad, not counted as XP.
            </p>
          )}
          {(rewards?.data?.ingest?.missing || []).length > 0 && (
            <p className="mgr-muted">
              Ingest documented {(rewards.data.ingest.missing || []).length} bound/field gap
              {(rewards.data.ingest.missing || []).length === 1 ? '' : 's'} in the scanned window (latest
              pass {shortWhen(rewards.data.ingest?.at) || '—'}).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Stage-then-explicit-apply rating authoring (Inspector History rows). The
// select seeds from the recorded rating ("rate…" when unrated) and Save stays
// disabled until a DIFFERENT selection or note is staged — every save writes
// a new latest record (supersession), never a silent duplicate. This is a
// subjective human record on an append-only audit ledger — no preview/apply
// two-step like config, because there is nothing destructive to preview.
//
// onDirty has the shape (runId, isDirty): several History rows carry their
// own control at once, so the screen-level unsaved guard tracks a per-row
// Set — reverting one row must not release the guard for another.
export function RatingControl({ squadKey, run, saved, onSave, onDirty, busy, error }) {
  const savedValue = saved ? String(saved.rating) : '';
  const savedNote = saved?.note || '';
  const [value, setValue] = useState(savedValue);
  const [note, setNote] = useState(savedNote);

  // Re-seed whenever the ledger record behind this row changes (the save's
  // reload lands, or the snapshot swaps rows): staged state always starts
  // from what is actually recorded.
  useEffect(() => {
    setValue(savedValue);
    setNote(savedNote);
  }, [savedValue, savedNote, run?.runId]);

  // The screen-level unsaved guard mirrors the staged delta; releasing it on
  // unmount (row swap, tab change) is mandatory.
  const dirty = value !== '' && (value !== savedValue || note !== savedNote);
  useEffect(() => {
    onDirty?.(run.runId, dirty);
  }, [run.runId, dirty, onDirty]);
  useEffect(() => () => onDirty?.(run.runId, false), [run.runId, onDirty]);

  const save = async () => {
    if (!dirty) return;
    const ok = await onSave({
      subject: squadKey,
      taskId: run.taskId,
      runId: run.runId,
      rating: Number(value),
      note: note.trim() ? note.trim() : null,
    });
    if (ok) {
      // Clear the staged delta; the reload's re-seed restores the saved record.
      setValue('');
      setNote('');
    }
  };

  return (
    <div className="mgr-rating">
      <label className="mgr-sr-only" htmlFor={`mgr-rate-${run.runId}`}>
        {`manager rating for ${run.taskId || run.runId}`}
      </label>
      <select
        id={`mgr-rate-${run.runId}`}
        className="mgr-select mgr-rating-select"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      >
        <option value="">rate…</option>
        {[5, 4, 3, 2, 1].map((n) => (
          <option key={n} value={n}>
            {'★'.repeat(n)} {n}
          </option>
        ))}
      </select>
      <input
        className="mgr-input mgr-rating-note"
        value={note}
        maxLength={500}
        placeholder="note (optional)"
        onChange={(e) => setNote(e.target.value)}
        aria-label={`note for the manager rating of ${run.taskId || run.runId}`}
      />
      <button type="button" className="mgr-btn mgr-btn-sm" onClick={save} disabled={!dirty || busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {error && (
        <span className="mgr-rating-error" role="alert">
          <span aria-hidden="true">⚠</span> {error.message}
        </span>
      )}
    </div>
  );
}

// Display form for an existing rating on a History row: "★ 4 · note" or the
// honest "not rated" — never 0/5.
export function RatingDisplay({ rating }) {
  if (!rating) return <span className="mgr-muted">not rated</span>;
  return (
    <span className="mgr-rating-display" title={rating.note || 'manager rating (subjective)'}>
      <span aria-hidden="true">★</span> {rating.rating}
      {rating.note ? <span className="mgr-muted"> · {rating.note}</span> : null}
    </span>
  );
}

// Convenience used by History: does this row get an authoring control?
// Ended runs with a task only — there is nothing to rate mid-flight, and a
// rating without a task has no evidence anchor.
export function rateableRun(run) {
  return !!run && run.endedAt != null && !!run.taskId;
}

export { ratingForRun };
