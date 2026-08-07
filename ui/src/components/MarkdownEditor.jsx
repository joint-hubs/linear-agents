// Inline editor for one prompt document (.md).
//
// Used in three places on the Prompts screen: the squad lead instruction, a role
// instruction, and any context file the prompt chain reaches. Spec:
// docs/ui/prompt-editing.md
//
// Save flow mirrors the kickoff editor that already lives on this screen —
// "Podgląd zmian" (dry run) then "Zapisz" — so there is one pattern to learn,
// not two.

import { useState, useEffect } from 'react';
import { getPromptFile, postPromptFile } from '../api';

/**
 * Line endings are not content. Files in this repo are a mix of CRLF and LF,
 * while a <textarea> always hands back LF — so comparing raw strings marks
 * every line of a CRLF file as changed. Compare in LF space; the backend
 * restores the file's own ending on write.
 */
const toLF = (s) => (s || '').replace(/\r\n/g, '\n');

/**
 * Trim the common head and tail so the preview shows only what actually moved.
 * A 450-line FENIX_WORKFLOW.md edited in three places should read as three
 * lines, not as 450.
 */
function changedRegion(before, after) {
  const a = toLF(before).split('\n');
  const b = toLF(after).split('\n');

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;

  return {
    removed: a.slice(head, a.length - tail),
    added: b.slice(head, b.length - tail),
    atLine: head + 1,
  };
}

export default function MarkdownEditor({ path, label, onSaved }) {
  // The raw file is always fetched here rather than accepted from a caller.
  // getPromptRole() strips frontmatter before returning a body — saving that
  // back would silently delete a role's `model:` and `tools:` lines.
  const [body, setBody] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let alive = true;
    setBody(null);
    setEditing(false);
    setChecked(false);
    setError(null);
    setSuccess(false);
    getPromptFile(path)
      .then((d) => {
        if (!alive) return;
        setBody(d.body);
        setDraft(d.body);
      })
      .catch((e) => alive && setError(e.message || String(e)));
    return () => { alive = false; };
  }, [path]);

  const dirty = body !== null && toLF(draft) !== toLF(body);
  const region = dirty ? changedRegion(body, draft) : null;

  const submit = async (dryRun) => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await postPromptFile({ path, body: draft, dryRun });
      if (dryRun) {
        setChecked(true);
      } else {
        setBody(draft);          // the file on disk is now the draft
        setSuccess(true);
        setChecked(false);
        setEditing(false);
        if (onSaved) await onSaved();
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  if (body === null) {
    return (
      <div className="muted" style={{ fontSize: 12, padding: '8px 0' }}>
        {error ? `Błąd: ${error}` : 'Ładowanie…'}
      </div>
    );
  }

  if (!editing) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          {label && (
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>{label}</div>
          )}
          <code className="muted" style={{ background: 'none', padding: 0, fontSize: 10.5 }}>
            {path}
          </code>
          <span style={{ flex: 1 }} />
          {success && (
            <span className="badge badge-ok" style={{ fontSize: 10.5 }}>✓ zapisano</span>
          )}
          <button
            className="btn-secondary"
            style={{ fontSize: 11, padding: '3px 10px' }}
            onClick={() => setEditing(true)}
          >
            Edytuj
          </button>
        </div>
        <pre
          style={{
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius)',
            padding: 10,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 320,
            overflow: 'auto',
            margin: 0,
          }}
        >
          {body || '(pusty plik)'}
        </pre>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        {label && (
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>{label}</div>
        )}
        <code className="muted" style={{ background: 'none', padding: 0, fontSize: 10.5 }}>
          {path}
        </code>
      </div>

      {error && <div className="banner banner-warn">Błąd: {error}</div>}

      <textarea
        className="filter-search"
        style={{
          width: '100%',
          minHeight: 320,
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
          lineHeight: 1.55,
          resize: 'vertical',
        }}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setChecked(false);
          setSuccess(false);
        }}
        aria-label={`Treść pliku ${path}`}
        spellCheck={false}
      />

      {checked && region && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
            Zmiana od linii {region.atLine}
            <span className="muted" style={{ fontWeight: 400 }}>
              {' '}· −{region.removed.length} / +{region.added.length}
            </span>
          </div>
          <pre
            style={{
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius)',
              padding: 10,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 240,
              overflow: 'auto',
              margin: 0,
            }}
          >
            {region.removed.map((l, i) => (
              <div key={'r' + i} style={{ color: 'var(--danger)' }}>− {l}</div>
            ))}
            {region.added.map((l, i) => (
              <div key={'a' + i} style={{ color: 'var(--ok)' }}>+ {l}</div>
            ))}
          </pre>
        </div>
      )}

      {checked && !dirty && (
        <div className="empty" style={{ padding: '10px 14px', fontSize: 12, marginTop: 8 }}>
          Brak zmian — plik zostanie nietknięty.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
        <button
          className="btn-secondary"
          onClick={() => {
            setDraft(body);
            setEditing(false);
            setChecked(false);
            setError(null);
          }}
          disabled={saving}
        >
          Anuluj
        </button>
        <button className="btn-secondary" onClick={() => submit(true)} disabled={saving || !dirty}>
          {saving ? 'Sprawdzanie…' : 'Podgląd zmian'}
        </button>
        <button className="launch-btn" onClick={() => submit(false)} disabled={saving || !dirty}>
          {saving ? 'Zapisywanie…' : 'Zapisz'}
        </button>
      </div>
    </div>
  );
}
