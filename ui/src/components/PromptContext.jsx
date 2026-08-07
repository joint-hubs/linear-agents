// "Kontekst promptu" — every file a squad's (or a role's) prompt pulls in.
//
// The kickoff prompt is a one-liner that delegates to CLAUDE.md, which in turn
// points at PRDs, scripts and configs. Without this panel the dashboard shows
// the top of that chain and nothing underneath.
// Spec: docs/ui/prompt-context-tracing.md

import { useState, useEffect, useCallback } from 'react';
import { getPromptRefs, getPromptFile } from '../api';
import MarkdownEditor from './MarkdownEditor';

/**
 * Only prompt prose is editable here — the documents the agent reads. Scripts,
 * JSON config and runtime state are reachable from a prompt but are not prompts;
 * an editor that can overwrite linear-ops.mjs is no longer a prompt editor.
 */
function isEditable(item) {
  return (
    (item.kind === 'auto' || item.kind === 'read') &&
    item.exists === true &&
    !item.isTemplate &&
    item.path.endsWith('.md')
  );
}

// Order matters: what the agent knows at turn 0 comes first, what it is merely
// told to go and find comes second.
const KIND_META = {
  auto: {
    label: 'Ładowane automatycznie',
    hint: 'Jest w kontekście agenta od pierwszej tury — nie musi o to prosić.',
  },
  read: {
    label: 'Do przeczytania',
    hint: 'Prompt wskazuje ten plik. Agent otwiera go sam — albo nie.',
  },
  config: {
    label: 'Dane',
    hint: 'Czytane przez narzędzia, nie przez agenta wprost.',
  },
  tool: {
    label: 'Narzędzia',
    hint: 'Skrypty wołane przez agenta. Wykonywane, nie czytane.',
  },
  state: {
    label: 'Stan przebiegu',
    hint: 'Artefakty runtime. Brak pliku między przebiegami jest normalny.',
  },
};

const KIND_ORDER = ['auto', 'read', 'config', 'tool', 'state'];

function FileRow({ item, expanded, onToggle, body, loading }) {
  const readable = item.exists && !item.isTemplate;
  const editable = isEditable(item);

  let badge = null;
  if (item.isTemplate) {
    badge = <span className="badge" style={{ fontSize: 10 }}>wzorzec</span>;
  } else if (item.exists === false) {
    badge = (
      <span
        className={item.kind === 'state' ? 'badge' : 'badge badge-fail'}
        style={{ fontSize: 10 }}
      >
        {item.kind === 'state' ? 'nieaktywny' : 'brak pliku'}
      </span>
    );
  }

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div
        onClick={readable ? onToggle : undefined}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '6px 4px',
          cursor: readable ? 'pointer' : 'default',
        }}
      >
        <span
          className="muted"
          style={{ fontFamily: 'var(--mono)', fontSize: 10, width: 16, flexShrink: 0 }}
        >
          {readable ? (expanded ? '▾' : '▸') : ' '}
        </span>

        <code
          style={{
            background: 'none',
            padding: 0,
            fontSize: 12,
            fontFamily: 'var(--mono)',
            color: item.exists === false && item.kind !== 'state' ? 'var(--danger)' : 'var(--text)',
            wordBreak: 'break-all',
          }}
        >
          {item.path}
        </code>

        {badge}

        <span style={{ flex: 1 }} />

        {item.lines != null && (
          <span className="muted" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>
            {item.lines} linii
          </span>
        )}
      </div>

      {/* Provenance — which prompt document points here. */}
      {item.referencedBy.length > 0 && (
        <div
          className="muted"
          style={{ fontSize: 10.5, paddingLeft: 28, paddingBottom: 6, wordBreak: 'break-all' }}
        >
          ← {item.referencedBy.join(', ')}
        </div>
      )}

      {expanded && editable && (
        <div style={{ margin: '0 0 10px 28px' }}>
          <MarkdownEditor path={item.path} />
        </div>
      )}

      {expanded && !editable && (
        <pre
          style={{
            margin: '0 0 8px 28px',
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
          }}
        >
          {loading ? 'Ładowanie…' : body}
        </pre>
      )}
    </div>
  );
}

export default function PromptContext({ squad, role = null }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

  // path -> { body } | { loading: true } | { error }
  const [files, setFiles] = useState({});
  const [expanded, setExpanded] = useState({});

  // Fetch the graph lazily — only once the section is actually opened.
  useEffect(() => {
    if (!open || data || error) return;
    let alive = true;
    getPromptRefs(squad, role)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message || String(e)));
    return () => {
      alive = false;
    };
  }, [open, squad, role, data, error]);

  // Reset when the selection changes.
  useEffect(() => {
    setData(null);
    setError(null);
    setFiles({});
    setExpanded({});
  }, [squad, role]);

  const toggleFile = useCallback(
    (path) => {
      setExpanded((prev) => {
        const next = { ...prev, [path]: !prev[path] };
        // Fetch content on first open only — and not at all for editable rows,
        // where MarkdownEditor loads the raw file itself.
        const row = (data?.refs || []).find((r) => r.path === path);
        if (next[path] && !files[path] && !(row && isEditable(row))) {
          setFiles((f) => ({ ...f, [path]: { loading: true } }));
          getPromptFile(path)
            .then((d) => setFiles((f) => ({ ...f, [path]: { body: d.body } })))
            .catch((e) =>
              setFiles((f) => ({ ...f, [path]: { body: `(nie udało się wczytać: ${e.message})` } }))
            );
        }
        return next;
      });
    },
    [files]
  );

  const grouped = data
    ? KIND_ORDER.map((kind) => ({
        kind,
        items: data.refs.filter((r) => r.kind === kind),
      })).filter((g) => g.items.length > 0)
    : [];

  return (
    <details
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '10px 14px',
        marginBottom: 16,
        fontSize: 13,
      }}
      open={open}
      onToggle={(e) => setOpen(e.target.open)}
    >
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
        Kontekst promptu
        {data && (
          <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
            {data.stats.total} plików
            {data.stats.missing > 0 && (
              <span style={{ color: 'var(--danger)' }}>
                {' · '}
                {data.stats.missing} zepsutych odwołań
              </span>
            )}
          </span>
        )}
      </summary>

      {!data && !error && (
        <div className="muted" style={{ padding: '8px 0' }}>Ładowanie…</div>
      )}
      {error && (
        <div style={{ padding: '8px 0', color: 'var(--danger)', fontSize: 12 }}>
          Błąd: {error}
        </div>
      )}

      {data && (
        <div style={{ marginTop: 10 }}>
          <p className="muted" style={{ fontSize: 11.5, marginTop: 0, marginBottom: 12 }}>
            Prompt kickoff odsyła do instrukcji, a instrukcja odsyła dalej. To jest cały ten
            łańcuch — kliknij plik, żeby zobaczyć treść.
          </p>

          {grouped.map(({ kind, items }) => (
            <div key={kind} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 1 }}>
                {KIND_META[kind].label}
                <span className="muted" style={{ fontWeight: 400 }}> · {items.length}</span>
              </div>
              <div className="muted" style={{ fontSize: 10.5, marginBottom: 4 }}>
                {KIND_META[kind].hint}
              </div>
              {items.map((item) => (
                <FileRow
                  key={item.path}
                  item={item}
                  expanded={Boolean(expanded[item.path])}
                  onToggle={() => toggleFile(item.path)}
                  loading={files[item.path]?.loading}
                  body={files[item.path]?.body}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
