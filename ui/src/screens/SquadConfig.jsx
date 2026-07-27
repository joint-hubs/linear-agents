import { useState, useEffect, useCallback } from 'react';
import { getSquadConfig, postSquadConfig } from '../api';

const SQUADS = ['plan', 'dev', 'review', 'test', 'cadence'];
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

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function hasPrice(slug, pricing) {
  return !!(pricing && pricing[slug]);
}

function countDirty(orig, edit) {
  if (!orig || !edit) return 0;
  let n = 0;
  for (const s of SQUADS) {
    const o = orig.squads?.[s];
    const e = edit.squads?.[s];
    if (!o || !e) continue;
    if (o.lead !== e.lead) n++;
    if (o.agents) {
      for (const [role, model] of Object.entries(o.agents)) {
        if (e.agents?.[role] !== model) n++;
      }
    }
  }
  const slugs = new Set([
    ...Object.keys(orig.pricing || {}),
    ...Object.keys(edit.pricing || {}),
  ]);
  for (const slug of slugs) {
    const o = orig.pricing?.[slug];
    const e = edit.pricing?.[slug];
    if (!o && e) { n++; continue; }
    if (o && !e) { n++; continue; }
    if (o.input !== e.input || o.output !== e.output || (o.cacheRead || 0) !== (e.cacheRead || 0)) n++;
  }
  return n;
}

// ---- Squad card (one per squad) -------------------------------------------

function SquadCard({ squad, data, edited, pricing, onLeadChange, onAgentChange }) {
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
      {Object.entries(agents).map(([role, model]) => (
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
            value={model || ''}
            onChange={(e) => onAgentChange(squad, role, e.target.value)}
            aria-label={`Model dla ${role} w ${SQUAD_LABELS[squad]}`}
            placeholder="provider/model-slug"
          />
          {!hasPrice(model, pricing) && model && (
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
      ))}

      {Object.keys(agents).length === 0 && (
        <div className="muted" style={{ padding: '5px 10px', fontSize: 12 }}>
          Brak subagentów
        </div>
      )}
    </div>
  );
}

// ---- Main screen ----------------------------------------------------------

export default function SquadConfig() {
  const [config, setConfig] = useState(null);       // server state
  const [edited, setEdited] = useState(null);       // working copy
  const [preview, setPreview] = useState(null);     // dry-run result
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [errorDetails, setErrorDetails] = useState(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(null);

  // New pricing row form
  const [newSlug, setNewSlug] = useState('');
  const [newInput, setNewInput] = useState('');
  const [newOutput, setNewOutput] = useState('');

  const dirtyCount = countDirty(config, edited);

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setErrorDetails(null);
      const data = await getSquadConfig();
      setConfig(data);
      setEdited({ squads: deepClone(data.squads || {}), pricing: deepClone(data.pricing || {}) });
      setPreview(null);
      setSuccess(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // ---- squad field handlers (clear preview on any edit) -------------------

  const handleLeadChange = (squad, value) => {
    setEdited((prev) => ({
      ...prev,
      squads: {
        ...prev.squads,
        [squad]: { ...prev.squads[squad], lead: value },
      },
    }));
    setPreview(null);
    setSuccess(null);
  };

  const handleAgentChange = (squad, role, value) => {
    setEdited((prev) => ({
      ...prev,
      squads: {
        ...prev.squads,
        [squad]: {
          ...prev.squads[squad],
          agents: { ...prev.squads[squad].agents, [role]: value },
        },
      },
    }));
    setPreview(null);
    setSuccess(null);
  };

  // ---- pricing handlers ---------------------------------------------------

  const handlePriceChange = (slug, field, value) => {
    setEdited((prev) => ({
      ...prev,
      pricing: {
        ...prev.pricing,
        [slug]: {
          ...prev.pricing[slug],
          [field]: field === 'cacheRead' ? (value === '' ? undefined : Number(value) || 0) : Number(value) || 0,
        },
      },
    }));
    setPreview(null);
    setSuccess(null);
  };

  const handlePriceSlugChange = (oldSlug, newSlug) => {
    if (!newSlug.trim() || oldSlug === newSlug) return;
    setEdited((prev) => {
      const p = { ...prev.pricing };
      p[newSlug] = { ...p[oldSlug] };
      delete p[oldSlug];
      return { ...prev, pricing: p };
    });
    setPreview(null);
    setSuccess(null);
  };

  const handleAddPricing = () => {
    const slug = newSlug.trim();
    if (!slug) return;
    setEdited((prev) => ({
      ...prev,
      pricing: {
        ...prev.pricing,
        [slug]: {
          input: Number(newInput) || 0,
          output: Number(newOutput) || 0,
        },
      },
    }));
    setNewSlug('');
    setNewInput('');
    setNewOutput('');
    setPreview(null);
    setSuccess(null);
  };

  const handleRemovePricing = (slug) => {
    setEdited((prev) => {
      const p = { ...prev.pricing };
      delete p[slug];
      return { ...prev, pricing: p };
    });
    setPreview(null);
    setSuccess(null);
  };

  // ---- actions ------------------------------------------------------------

  const handlePreview = async () => {
    setSaving(true);
    setError(null);
    setErrorDetails(null);
    setSuccess(null);
    try {
      const result = await postSquadConfig({
        squads: edited.squads,
        pricing: edited.pricing,
        dryRun: true,
      });
      setPreview(result);
    } catch (e) {
      setError(e.message);
      setErrorDetails(e.data?.details || null);
    } finally {
      setSaving(false);
    }
  };

  const handleApply = async () => {
    setSaving(true);
    setError(null);
    setErrorDetails(null);
    setSuccess(null);
    try {
      const result = await postSquadConfig({
        squads: edited.squads,
        pricing: edited.pricing,
        dryRun: false,
      });
      setSuccess(result);
      setPreview(null);
      // Refresh from server
      await fetchConfig();
    } catch (e) {
      setError(e.message);
      setErrorDetails(e.data?.details || null);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!config) return;
    setEdited({ squads: deepClone(config.squads || {}), pricing: deepClone(config.pricing || {}) });
    setPreview(null);
    setSuccess(null);
    setError(null);
    setErrorDetails(null);
  };

  // ---- render -------------------------------------------------------------

  if (loading) {
    return (
      <div className="page">
        <div className="empty">Ładowanie konfiguracji…</div>
      </div>
    );
  }

  if (error && !config) {
    return (
      <div className="page">
        <div className="api-banner">{error}</div>
      </div>
    );
  }

  const pricing = config?.pricing || {};
  const pricingSlugs = Object.keys(edited?.pricing || {}).sort();

  return (
    <div className="page">
      {/* Header */}
      <div className="page-title-row">
        <div>
          <div className="page-title">Konfiguracja składów</div>
          <div className="page-sub">
            Modele LLM per skład · cennik OpenRouter · zmiany działają przy następnym uruchomieniu
          </div>
        </div>
        {dirtyCount > 0 && (
          <span className="badge badge-warn" style={{ flex: 'none' }}>
            {dirtyCount} niezapisanych zmian
          </span>
        )}
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
          Tutaj konfigurujesz, które modele LLM są przypisane do poszczególnych składów (plan, dev, review, test, cadence)
          oraz uzupełniasz cennik OpenRouter, żeby telemetria mogła poprawnie przeliczać koszty.
        </p>
        <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
          <li>
            <strong>Provider to zawsze OpenRouter.</strong> W pola poniżej wklejasz samą nazwę modelu
            (np. <code>anthropic/claude-opus-4.8</code>, <code>z-ai/glm-5.2</code>), bez URL-i i bez przedrostka
            „openrouter/".
          </li>
          <li>
            <strong>Zmiana zadziała przy następnym uruchomieniu składu</strong> — nie modyfikuje trwających
            sesji agentów. Jeśli chcesz zmienić model w już działającym agencie, zatrzymaj go i uruchom ponownie.
          </li>
          <li>
            Cennik służy tylko do rozliczeń w panelu — nie wpływa na to, który model jest faktycznie wywoływany.
            Modele bez wpisu w cenniku będą pokazywać $0 w telemetrii.
          </li>
        </ul>
      </details>

      {/* Error banner */}
      {error && (
        <div className="api-banner" style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: errorDetails ? 6 : 0 }}>{error}</div>
          {errorDetails && errorDetails.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
              {errorDetails.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Success banner */}
      {success && (
        <div
          className="banner"
          style={{
            background: 'var(--ok-soft)',
            borderColor: '#a3d5b3',
            color: 'var(--ok)',
            marginBottom: 16,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            ✓ Konfiguracja zapisana. Zmiany zadziałają przy następnym uruchomieniu składu.
          </div>
          {success.changed && success.changed.length > 0 && (
            <div style={{ fontSize: 12.5 }}>
              Zmienione pliki:{' '}
              {success.changed.map((c) => (
                <code key={c.file} style={{ marginRight: 8 }}>
                  {c.file}
                </code>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Warnings (non-blocking) */}
      {preview?.warnings && preview.warnings.length > 0 && (
        <div className="banner banner-warn" style={{ marginBottom: 16 }}>
          {preview.warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      {/* ---- Squad cards -------------------------------------------------- */}
      <div className="section">
        <div className="section-h">Składy</div>
        <div className="grid grid-2">
          {SQUADS.map((squad) => (
            <SquadCard
              key={squad}
              squad={squad}
              data={config?.squads?.[squad]}
              edited={edited?.squads?.[squad]}
              pricing={pricing}
              onLeadChange={handleLeadChange}
              onAgentChange={handleAgentChange}
            />
          ))}
        </div>
      </div>

      {/* ---- Pricing table ------------------------------------------------ */}
      <div className="section">
        <div className="section-h">Cennik (USD / 1M tokenów)</div>
        <table className="table">
          <thead>
            <tr className="th">
              <th>Slug modelu</th>
              <th style={{ textAlign: 'right' }}>Input</th>
              <th style={{ textAlign: 'right' }}>Output</th>
              <th style={{ textAlign: 'right' }}>Cache read</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {pricingSlugs.length === 0 && (
              <tr>
                <td className="td muted" colSpan={5} style={{ textAlign: 'center' }}>
                  Brak wpisów w cenniku
                </td>
              </tr>
            )}
            {pricingSlugs.map((slug) => {
              const p = edited?.pricing?.[slug] || {};
              return (
                <tr key={slug}>
                  <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                    <input
                      className="filter-search"
                      style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 11.5 }}
                      value={slug}
                      onChange={(e) => handlePriceSlugChange(slug, e.target.value)}
                      aria-label="Nazwa modelu"
                    />
                  </td>
                  <td className="td" style={{ textAlign: 'right' }}>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="filter-search"
                      style={{ width: 90, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                      value={p.input ?? ''}
                      onChange={(e) => handlePriceChange(slug, 'input', e.target.value)}
                      aria-label={`Cena input dla ${slug}`}
                    />
                  </td>
                  <td className="td" style={{ textAlign: 'right' }}>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="filter-search"
                      style={{ width: 90, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                      value={p.output ?? ''}
                      onChange={(e) => handlePriceChange(slug, 'output', e.target.value)}
                      aria-label={`Cena output dla ${slug}`}
                    />
                  </td>
                  <td className="td" style={{ textAlign: 'right' }}>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="filter-search"
                      style={{ width: 90, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                      value={p.cacheRead ?? ''}
                      onChange={(e) => handlePriceChange(slug, 'cacheRead', e.target.value)}
                      aria-label={`Cena cache read dla ${slug}`}
                      placeholder="—"
                    />
                  </td>
                  <td className="td" style={{ textAlign: 'center' }}>
                    <button
                      className="btn-secondary"
                      style={{ padding: '3px 8px', fontSize: 11 }}
                      onClick={() => handleRemovePricing(slug)}
                      aria-label={`Usuń ${slug} z cennika`}
                      title="Usuń z cennika"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}

            {/* Add new row */}
            <tr>
              <td className="td">
                <input
                  className="filter-search"
                  style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 11.5 }}
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  placeholder="provider/model-slug"
                  aria-label="Nowy slug modelu"
                />
              </td>
              <td className="td" style={{ textAlign: 'right' }}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="filter-search"
                  style={{ width: 90, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  value={newInput}
                  onChange={(e) => setNewInput(e.target.value)}
                  placeholder="0.00"
                  aria-label="Cena input nowego modelu"
                />
              </td>
              <td className="td" style={{ textAlign: 'right' }}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="filter-search"
                  style={{ width: 90, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                  value={newOutput}
                  onChange={(e) => setNewOutput(e.target.value)}
                  placeholder="0.00"
                  aria-label="Cena output nowego modelu"
                />
              </td>
              <td className="td" style={{ textAlign: 'right' }}>
                <span className="muted" style={{ fontSize: 11 }}>—</span>
              </td>
              <td className="td" style={{ textAlign: 'center' }}>
                <button
                  className="launch-btn"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                  onClick={handleAddPricing}
                  disabled={!newSlug.trim()}
                  aria-label="Dodaj model do cennika"
                >
                  Dodaj
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ---- Actions ------------------------------------------------------ */}
      <div style={{ display: 'flex', gap: 8, marginTop: 24, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn-secondary"
          onClick={handlePreview}
          disabled={saving || dirtyCount === 0}
        >
          {saving ? 'Wysyłanie…' : 'Podgląd zmian'}
        </button>
        <button
          className="launch-btn"
          onClick={handleApply}
          disabled={saving || !preview}
        >
          {saving ? 'Zapisywanie…' : 'Zastosuj'}
        </button>
        <button
          className="btn-secondary"
          onClick={handleDiscard}
          disabled={saving || dirtyCount === 0}
        >
          Odrzuć zmiany
        </button>
        {dirtyCount > 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            {dirtyCount} {dirtyCount === 1 ? 'zmiana' : dirtyCount < 5 ? 'zmiany' : 'zmian'} do zapisania
          </span>
        )}
      </div>

      {/* ---- Preview results ---------------------------------------------- */}
      {preview && (
        <div className="section">
          <div className="section-h">
            Podgląd zmian {preview.dryRun && <span className="muted">(dry run)</span>}
          </div>
          {preview.changed && preview.changed.length === 0 && (
            <div className="empty">Brak zmian do zastosowania.</div>
          )}
          {preview.changed && preview.changed.length > 0 && (
            <table className="table">
              <thead>
                <tr className="th">
                  <th>Plik</th>
                  <th>Przed</th>
                  <th>Po</th>
                </tr>
              </thead>
              <tbody>
                {preview.changed.map((c) => (
                  <tr key={c.file}>
                    <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {c.file}
                    </td>
                    <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--danger)' }}>
                      {c.before}
                    </td>
                    <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ok)' }}>
                      {c.after}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
