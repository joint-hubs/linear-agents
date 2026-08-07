import { useState, useEffect, useCallback, useRef } from 'react';
import { getPrompts, getPromptRole } from '../api';
import { LogDrawer } from './Flow.jsx';
// SquadLeaf/RoleLeaf were extracted to components/ (code-audit-2026-07-30 §4)
// — this file had grown past 1100 lines with SquadLeaf alone at ~560.
import SquadLeaf from '../components/SquadLeaf';
import RoleLeaf from '../components/RoleLeaf';
import ExternalPrompts from '../components/ExternalPrompts';

// Extra tree leaf, added client-side (not part of /api/prompts): orchestrator
// (~/.claude) and Hermes prompt documents. docs/ui/prompt-editing-external.md §5.
const EXTERNAL_INTENT = { id: 'external', label: 'Prompty globalne i Hermes', squad: null };

// ---------------------------------------------------------------------------
// Tree node button — accessible, focus-visible
// ---------------------------------------------------------------------------

function TreeButton({ active, children, onClick, style = {}, indent = 0 }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: active ? 'var(--surface-2)' : 'transparent',
        border: 'none',
        borderRadius: 'var(--radius)',
        padding: '7px 10px',
        paddingLeft: 10 + indent * 16,
        fontSize: 13,
        color: active ? 'var(--text)' : 'var(--text-2)',
        cursor: 'pointer',
        fontWeight: active ? 600 : 400,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div
      className={toast.ok ? 'toast toast-ok' : 'toast toast-fail'}
      style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 1000 }}
    >
      {toast.ok
        ? `Uruchomiono ${toast.squad} dla ${toast.taskId} — okno agenta otwarte. Przebieg pojawi się w Live.`
        : `Błąd uruchamiania: ${toast.error}`}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function Prompts() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Tree selection
  const [selIntent, setSelIntent] = useState(null); // intent id
  const [selSquad, setSelSquad] = useState(null); // squad key (only for 'single' path)
  const [selRole, setSelRole] = useState(null); // role key (only for 'single' path)

  // Right panel state
  const [taskId, setTaskId] = useState('');
  const [roleData, setRoleData] = useState(null); // fetched role/lead data
  const [roleLoading, setRoleLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  // Log drawer
  const [logRun, setLogRun] = useState(null);

  // Fetch prompts tree on mount.
  useEffect(() => {
    let alive = true;
    getPrompts()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message || String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  // Auto-dismiss toast.
  useEffect(() => {
    if (!toast) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
    return () => { if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, [toast]);

  // Fetch role data when a role leaf is selected.
  useEffect(() => {
    if (!selRole || !selSquad) {
      setRoleData(null);
      return;
    }
    let alive = true;
    setRoleLoading(true);
    getPromptRole(selSquad, selRole)
      .then((d) => alive && setRoleData(d))
      .catch(() => alive && setRoleData(null))
      .finally(() => alive && setRoleLoading(false));
    return () => { alive = false; };
  }, [selRole, selSquad]);

  // Reset dependent selections when navigating up the tree.
  const selectIntent = useCallback((id) => {
    setSelIntent(id);
    setSelSquad(null);
    setSelRole(null);
    setRoleData(null);
  }, []);

  const selectSquad = useCallback((s) => {
    setSelSquad(s);
    setSelRole(null);
    setRoleData(null);
  }, []);

  const selectRole = useCallback((r) => {
    setSelRole(r);
  }, []);

  const handleLaunchResult = useCallback((res) => {
    setToast(res);
  }, []);

  // --- Loading / error states ---
  if (loading) {
    return (
      <div className="page">
        <div className="empty">Ładowanie…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="api-banner">{error}</div>
      </div>
    );
  }

  const intents = [...(data?.intents || []), EXTERNAL_INTENT];
  const squads = data?.squads || {};
  const squadKeys = Object.keys(squads).sort();

  // Determine what to show in the right panel.
  const isSinglePath = selIntent === 'single';
  const isExternal = selIntent === 'external';
  const activeSquad = isSinglePath ? selSquad : selIntent;
  const squadData = activeSquad && !isExternal ? squads[activeSquad] : null;

  // Breadcrumb for right panel.
  let breadcrumb = null;
  if (isExternal) {
    breadcrumb = (
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        <strong>{EXTERNAL_INTENT.label}</strong>
      </span>
    );
  } else if (isSinglePath && selRole && selSquad) {
    breadcrumb = (
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        Pojedyncza rola → <strong>{selSquad}</strong> → <strong>{selRole}</strong>
      </span>
    );
  } else if (isSinglePath && selSquad) {
    breadcrumb = (
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        Pojedyncza rola → <strong>{selSquad}</strong> (wybierz rolę)
      </span>
    );
  } else if (isSinglePath) {
    breadcrumb = (
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        Pojedyncza rola (wybierz skład)
      </span>
    );
  } else if (selIntent && squadData) {
    const intentLabel = (intents.find((i) => i.id === selIntent) || {}).label || selIntent;
    breadcrumb = (
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        <strong>{intentLabel}</strong>
      </span>
    );
  }

  return (
    <div className="page">
      <div className="page-title-row">
        <div>
          <div className="page-title">Prompty</div>
          <div className="page-sub">
            Interaktywne drzewo decyzyjne · wybierz co chcesz zrobić, system przygotuje prompt
          </div>
        </div>
      </div>

      {/* Help */}
      <details
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '14px 18px',
          marginBottom: 24,
          fontSize: 13,
          color: 'var(--text-2)',
          lineHeight: 1.7,
        }}
      >
        <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
          Jak to działa?
        </summary>
        <p style={{ margin: '8px 0 0' }}>
          <strong>Co robisz Ty:</strong> wybierasz w drzewie po lewej, co chcesz zrobić, wpisujesz
          numer zadania Linear (np. JOI-53) i klikasz <em>Kopiuj</em> (dostajesz prompt do schowka)
          albo <em>Uruchom</em> (system otwiera nowe okno konsoli z agentem).
        </p>
        <p style={{ margin: '8px 0 0' }}>
          <strong>Co robi system:</strong> sprawdza poprawność składu i numeru zadania, składa prompt
          z szablonu, zapisuje tymczasowy plik <code>.bat</code>, otwiera NOWE okno konsoli na tym
          komputerze i uruchamia w nim skład. Nadaje przebiegowi identyfikator, dzięki czemu widać go
          w Live, Runs i Flow.
        </p>
        <p style={{ margin: '8px 0 0' }}>
          <strong>Czego system NIE robi:</strong> nie hostuje agenta (agent działa w Twoim terminalu),
          nie odpowiada za Ciebie na pytania agenta (bramki GATE obsługujesz sam), nie działa zdalnie
          — tylko lokalnie.
        </p>
      </details>

      {/* Two-column layout */}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        {/* ---- LEFT: Decision tree ---- */}
        <div
          style={{
            width: 280,
            flexShrink: 0,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '12px 0',
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              padding: '0 14px 10px',
              borderBottom: '1px solid var(--border)',
              marginBottom: 6,
            }}
          >
            Co chcesz zrobić?
          </div>

          {intents.map((intent) => {
            const isActive = selIntent === intent.id;
            const hasChildren = intent.id === 'single';
            const isSquadIntent = intent.squad != null;

            return (
              <div key={intent.id}>
                <TreeButton
                  active={isActive}
                  onClick={() => selectIntent(intent.id)}
                >
                  {intent.label}
                </TreeButton>

                {/* Expand squads under "single" */}
                {hasChildren && isActive && (
                  <div style={{ borderTop: '1px solid var(--border)', marginTop: 2, paddingTop: 2 }}>
                    {squadKeys.map((sk) => {
                      const isSquadActive = selSquad === sk;
                      return (
                        <div key={sk}>
                          <TreeButton
                            active={isSquadActive}
                            indent={1}
                            onClick={() => selectSquad(sk)}
                          >
                            {sk}
                          </TreeButton>
                          {/* Expand roles under selected squad */}
                          {isSquadActive && squads[sk] && (
                            <div>
                              {(squads[sk].roles || []).map((r) => {
                                const isRoleActive = selRole === r.role;
                                return (
                                  <TreeButton
                                    key={r.role}
                                    active={isRoleActive}
                                    indent={2}
                                    onClick={() => selectRole(r.role)}
                                  >
                                    {r.role}
                                  </TreeButton>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ---- RIGHT: Leaf content ---- */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: 18,
          }}
        >
          {!selIntent && (
            <div className="empty">Wybierz opcję z drzewa po lewej, żeby zobaczyć szczegóły.</div>
          )}

          {/* External prompts (orchestrators + Hermes) — client-side leaf, no /api/prompts data */}
          {isExternal && (
            <>
              <div style={{ marginBottom: 16 }}>{breadcrumb}</div>
              <ExternalPrompts />
            </>
          )}

          {/* Squad leaf (direct intent or squad selected under "single") */}
          {selIntent && !isSinglePath && !isExternal && squadData && (
            <>
              <div style={{ marginBottom: 16 }}>{breadcrumb}</div>
              <SquadLeaf
                squad={selIntent}
                data={squadData}
                taskId={taskId}
                setTaskId={setTaskId}
                onLaunchResult={handleLaunchResult}
                onOpenLog={setLogRun}
              />
            </>
          )}

          {/* Squad leaf under "single" path (squad selected, no role yet) */}
          {isSinglePath && selSquad && !selRole && squadData && (
            <>
              <div style={{ marginBottom: 16 }}>{breadcrumb}</div>
              <SquadLeaf
                squad={selSquad}
                data={squadData}
                taskId={taskId}
                setTaskId={setTaskId}
                onLaunchResult={handleLaunchResult}
                onOpenLog={setLogRun}
              />
            </>
          )}

          {/* Role leaf under "single" path */}
          {isSinglePath && selRole && (
            <>
              <div style={{ marginBottom: 16 }}>{breadcrumb}</div>
              {roleLoading && <div className="muted">Ładowanie instrukcji roli…</div>}
              {!roleLoading && !roleData && (
                <div className="banner banner-warn">Nie udało się załadować instrukcji roli.</div>
              )}
              {roleData && (
                <RoleLeaf squad={selSquad} role={selRole} data={roleData} />
              )}
            </>
          )}

          {/* Intent selected but no squad data (shouldn't happen) */}
          {selIntent && !isSinglePath && !isExternal && !squadData && (
            <div className="banner banner-warn">Brak danych dla tego składu.</div>
          )}
        </div>
      </div>

      {/* Toast */}
      <Toast toast={toast} />

      {/* Log drawer */}
      {logRun && (
        <LogDrawer
          squad={{ label: logRun.squad || '—' }}
          node={{ key: '_lead', label: 'Lead' }}
          run={logRun}
          onClose={() => setLogRun(null)}
        />
      )}
    </div>
  );
}
