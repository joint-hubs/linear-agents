// Right panel of the Prompts screen when a single role (not a whole squad) is
// selected: the launch command, model + tool grants, and the role's raw
// instruction file.
// Extracted from screens/Prompts.jsx (code-audit-2026-07-30 §4).

import { useState, useRef } from 'react';
import PromptContext from './PromptContext';
import MarkdownEditor from './MarkdownEditor';

export default function RoleLeaf({ squad, role, data }) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  const cmd = 'bin\\agent.bat ' + squad + ' ' + role;
  const hasWrite = (data.tools || []).some(
    (t) => t === 'Bash' || t === 'Edit' || t === 'Write'
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div>
      {/* Command */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--text-2)' }}>
          Komenda
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '6px 10px',
              fontSize: 12.5,
              fontFamily: 'var(--mono)',
            }}
          >
            {cmd}
          </code>
          <button className="btn-secondary" onClick={handleCopy} style={{ fontSize: 12 }}>
            {copied ? '✓ Skopiowano' : 'Kopiuj'}
          </button>
        </div>
      </div>

      {/* Model + tools */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-2)' }}>
          Model i uprawnienia
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
          <span
            style={{
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius)',
              padding: '4px 10px',
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            {data.model || '—'}
          </span>
          {hasWrite ? (
            <span className="badge badge-warn" style={{ fontSize: 11 }}>
              może zmieniać kod
            </span>
          ) : (
            <span className="badge badge-ok" style={{ fontSize: 11 }}>
              tylko do odczytu
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {(data.tools || []).map((t) => (
            <span
              key={t}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: '2px 8px',
                fontSize: 11,
                fontFamily: 'var(--mono)',
              }}
            >
              {t}
            </span>
          ))}
        </div>
      </div>

      {/* Context files this role's instruction pulls in */}
      <PromptContext squad={squad} role={role} />

      {/* Role instruction — the editor loads the raw file, frontmatter included */}
      <MarkdownEditor
        label="Instrukcja roli"
        path={`agents/${squad}/agents/${role}.md`}
      />
    </div>
  );
}
