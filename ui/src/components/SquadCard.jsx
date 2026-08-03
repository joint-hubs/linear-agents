// One editable squad card: lead model, per-role models, tool grants.
//
// Extracted from screens/SquadConfig.jsx (code-review-2026-08-03 §6) — that
// file was 1016 lines with the screen component alone at 813. SQUAD_LABELS,
// SQUAD_COLOR and hasPrice came along because nothing outside this card used
// them.

const SQUAD_LABELS = {
  plan: 'Plan',
  dev: 'Dev',
  review: 'Review',
  test: 'Test',
  cadence: 'Cadence',
};

const SQUAD_COLOR = {
  plan: 'var(--sq-plan)',
  dev: 'var(--sq-dev)',
  review: 'var(--sq-review)',
  test: 'var(--sq-test)',
  cadence: 'var(--sq-cadence)',
};

/** A model with no pricing entry silently reports $0 in telemetry — warn on it. */
function hasPrice(slug, pricing) {
  return !!(pricing && pricing[slug]);
}

export default function SquadCard({
  squad,
  data,
  edited,
  pricing,
  onLeadChange,
  onAgentChange,
  onToolsOpen,
}) {
  const s = edited || data;
  if (!s) return null;

  const leadSlug = s.lead || '';
  const agents = s.agents || {};
  const color = SQUAD_COLOR[squad] || 'var(--border-strong)';

  return (
    <div className="card" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="card-h" style={{ color }}>{SQUAD_LABELS[squad] || squad}</div>

      {/* Lead row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 10px',
          borderRadius: 7,
          background: 'var(--surface-2)',
          marginBottom: 4,
        }}
      >
        <label
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--text)',
            minWidth: 100,
          }}
        >
          Lead
        </label>
        <input
          className="filter-search"
          style={{ flex: 1 }}
          value={leadSlug}
          onChange={(e) => onLeadChange(squad, e.target.value)}
          aria-label={`Lead model dla ${SQUAD_LABELS[squad]}`}
          placeholder="provider/model-slug"
        />
        {!hasPrice(leadSlug, pricing) && leadSlug && (
          <span
            style={{
              color: 'var(--warn)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'help',
              flex: 'none',
            }}
            title="Ten model nie ma wpisu w cenniku — telemetria pokaże dla niego $0"
          >
            ⚠ brak ceny
          </span>
        )}
      </div>

      {/* Agent rows */}
      {Object.entries(agents).map(([role, agent]) => {
        const modelSlug = typeof agent === 'object' && agent ? agent.model || '' : (agent || '');
        return (
        <div
          key={role}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '5px 10px',
          }}
        >
          <label
            style={{
              fontSize: 12.5,
              color: 'var(--text-2)',
              minWidth: 100,
            }}
          >
            {role}
          </label>
          <input
            className="filter-search"
            style={{ flex: 1 }}
            value={modelSlug}
            onChange={(e) => onAgentChange(squad, role, e.target.value)}
            aria-label={`Model dla ${role} w ${SQUAD_LABELS[squad]}`}
            placeholder="provider/model-slug"
          />
          {!hasPrice(modelSlug, pricing) && modelSlug && (
            <span
              style={{
                color: 'var(--warn)',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'help',
                flex: 'none',
              }}
              title="Ten model nie ma wpisu w cenniku — telemetria pokaże dla niego $0"
            >
              ⚠ brak ceny
            </span>
          )}
          <button
            className="btn-secondary"
            style={{ fontSize: 11, padding: '3px 8px', flex: 'none' }}
            onClick={() => onToolsOpen && onToolsOpen(squad, role)}
            title={`Edytuj narzędzia dla ${role}`}
          >
            Narzędzia
          </button>
        </div>
        );
      })}

      {Object.keys(agents).length === 0 && (
        <div className="muted" style={{ padding: '5px 10px', fontSize: 12 }}>
          Brak subagentów
        </div>
      )}
    </div>
  );
}
