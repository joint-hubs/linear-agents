// "Prompty globalne i Hermes" — orchestrator (~/.claude) and Hermes assistant
// (%LOCALAPPDATA%\hermes) prompt documents, reached via @rootId/rel paths.
// Spec: docs/ui/prompt-editing-external.md

import { useState, useEffect } from 'react';
import { getPromptRoots } from '../api';
import MarkdownEditor from './MarkdownEditor';

// Fixed order: orchestrators before Hermes, regardless of API response order.
const ROOT_ORDER = ['claude', 'hermes'];

export default function ExternalPrompts() {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState(null);
  const [openPath, setOpenPath] = useState(null);

  useEffect(() => {
    let alive = true;
    getPromptRoots()
      .then((d) => alive && setFiles(d.files || []))
      .catch((e) => alive && setError(e.message || String(e)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return <div className="banner banner-warn">Błąd: {error}</div>;
  }

  if (!files) {
    return <div className="muted">Ładowanie…</div>;
  }

  if (files.length === 0) {
    return <div className="empty">Brak plików promptów spoza repo.</div>;
  }

  const groups = ROOT_ORDER.map((rootId) => {
    const items = files.filter((f) => f.rootId === rootId);
    return items.length > 0 ? { rootId, label: items[0].label, hint: items[0].hint, items } : null;
  }).filter(Boolean);

  return (
    <div>
      {groups.map((group) => (
        <div key={group.rootId} style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{group.label}</div>
          {group.hint && (
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>
              {group.hint}
            </div>
          )}

          {group.items.map((f) => {
            const isOpen = openPath === f.path;
            return (
              <div key={f.path} style={{ borderBottom: '1px solid var(--border)' }}>
                <div
                  onClick={() => setOpenPath(isOpen ? null : f.path)}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    padding: '6px 4px',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    className="muted"
                    style={{ fontFamily: 'var(--mono)', fontSize: 10, width: 16, flexShrink: 0 }}
                  >
                    {isOpen ? '▾' : '▸'}
                  </span>

                  <code
                    style={{
                      background: 'none',
                      padding: 0,
                      fontSize: 12,
                      fontFamily: 'var(--mono)',
                      color: 'var(--text)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {f.rel}
                  </code>

                  <span style={{ flex: 1 }} />

                  {f.lines != null && (
                    <span className="muted" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>
                      {f.lines} linii
                    </span>
                  )}
                </div>

                {isOpen && (
                  <div style={{ margin: '0 0 10px 28px' }}>
                    <MarkdownEditor path={f.path} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
