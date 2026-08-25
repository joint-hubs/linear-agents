import { useState, useEffect, useCallback } from 'react';
import { getSquadConfig, postSquadConfig } from '../api';
import SquadCard from '../components/SquadCard';
import ToolEditorModal from '../components/ToolEditorModal';

const SQUADS = ['plan', 'dev', 'review', 'test', 'cadence'];
const DEFAULT_PROVIDER = 'openrouter';
const PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const BASE_URL_RE = /^https?:\/\/\S+$/;
const AUTH_ENV_RE = /^[A-Z][A-Z0-9_]*$/;

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Normalize agents from old shape (string) to new shape ({model, tools}). */
function normalizeAgents(agents) {
  if (!agents) return agents;
  const out = {};
  for (const [role, val] of Object.entries(agents)) {
    if (typeof val === 'object' && val !== null) {
      out[role] = { model: val.model || '', tools: val.tools || [] };
    } else {
      out[role] = { model: val || '', tools: [] };
    }
  }
  return out;
}

function samePrice(a, b) {
  return (a?.input ?? 0) === (b?.input ?? 0)
    && (a?.output ?? 0) === (b?.output ?? 0)
    && (a?.cacheRead ?? 0) === (b?.cacheRead ?? 0)
    && (a?.cacheWrite ?? 0) === (b?.cacheWrite ?? 0);
}

function countDirty(orig, edit) {
  if (!orig || !edit) return 0;
  let n = 0;

  // Squads: lead, provider, agent models/tools
  for (const s of SQUADS) {
    const o = orig.squads?.[s];
    const e = edit.squads?.[s];
    if (!o || !e) continue;
    if (o.lead !== e.lead) n++;
    if ((o.provider || DEFAULT_PROVIDER) !== (e.provider || DEFAULT_PROVIDER)) n++;
    if (o.agents) {
      for (const [role, agent] of Object.entries(o.agents)) {
        const ea = e.agents?.[role];
        if (!ea) { n++; continue; }
        if (agent.model !== ea.model) n++;
        const ot = JSON.stringify([...(agent.tools || [])].sort());
        const et = JSON.stringify([...(ea.tools || [])].sort());
        if (ot !== et) n++;
      }
    }
  }

  // Providers: add/edit/remove
  const providerNames = new Set([
    ...Object.keys(orig.providers || {}),
    ...Object.keys(edit.providers || {}),
  ]);
  for (const p of providerNames) {
    const o = orig.providers?.[p];
    const e = edit.providers?.[p];
    if (JSON.stringify(o ?? null) !== JSON.stringify(e ?? null)) n++;
  }

  // Pricing: nested per provider
  const pricingProviders = new Set([
    ...Object.keys(orig.pricing || {}),
    ...Object.keys(edit.pricing || {}),
  ]);
  for (const p of pricingProviders) {
    const slugs = new Set([
      ...Object.keys(orig.pricing?.[p] || {}),
      ...Object.keys(edit.pricing?.[p] || {}),
    ]);
    for (const slug of slugs) {
      const o = orig.pricing?.[p]?.[slug];
      const e = edit.pricing?.[p]?.[slug];
      if ((o === undefined) !== (e === undefined)) { n++; continue; }
      if (o && e && !samePrice(o, e)) n++;
    }
  }
  return n;
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

  // Provider editor form (add/edit)
  const [providerForm, setProviderForm] = useState({
    name: '', baseUrl: '', authEnv: '', authStyle: 'token', models: '',
  });
  const [editingProvider, setEditingProvider] = useState(null); // name | null
  const [providerError, setProviderError] = useState(null);

  // Which provider's pricing is shown in the pricing editor
  const [pricingProvider, setPricingProvider] = useState(DEFAULT_PROVIDER);

  // New pricing row form
  const [newSlug, setNewSlug] = useState('');
  const [newInput, setNewInput] = useState('');
  const [newOutput, setNewOutput] = useState('');

  // Tool editor modal
  const [toolEditor, setToolEditor] = useState(null); // {squad, role, tools} | null

  const dirtyCount = countDirty(config, edited);

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setErrorDetails(null);
      const data = await getSquadConfig();
      // Normalize agents to {model, tools} shape (backward-compat with old string-only API)
      const squads = deepClone(data.squads || {});
      for (const s of Object.keys(squads)) {
        if (squads[s].agents) squads[s].agents = normalizeAgents(squads[s].agents);
      }
      setConfig({ ...data, squads });
      setEdited({
        squads: deepClone(squads),
        pricing: deepClone(data.pricing || {}),
        providers: deepClone(data.providers || {}),
      });
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

  const handleProviderChange = (squad, value) => {
    setEdited((prev) => ({
      ...prev,
      squads: {
        ...prev.squads,
        [squad]: { ...prev.squads[squad], provider: value },
      },
    }));
    setPreview(null);
    setSuccess(null);
  };

  const handleAgentChange = (squad, role, value) => {
    setEdited((prev) => {
      const existing = prev.squads[squad]?.agents?.[role];
      const tools = (existing && typeof existing === 'object') ? (existing.tools || []) : [];
      return {
        ...prev,
        squads: {
          ...prev.squads,
          [squad]: {
            ...prev.squads[squad],
            agents: { ...prev.squads[squad].agents, [role]: { model: value, tools } },
          },
        },
      };
    });
    setPreview(null);
    setSuccess(null);
  };

  // ---- provider handlers --------------------------------------------------

  const handleProviderFormChange = (field, value) => {
    setProviderForm((prev) => ({ ...prev, [field]: value }));
    setProviderError(null);
  };

  const handleProviderSubmit = () => {
    const name = providerForm.name.trim();
    if (!PROVIDER_NAME_RE.test(name)) {
      setProviderError('Nazwa providera musi pasować do [a-z][a-z0-9_-]* (np. my_provider).');
      return;
    }
    if (!BASE_URL_RE.test(providerForm.baseUrl.trim())) {
      setProviderError('baseUrl musi być poprawnym URL http(s).');
      return;
    }
    if (!AUTH_ENV_RE.test(providerForm.authEnv.trim())) {
      setProviderError('authEnv musi być nazwą zmiennej środowiskowej (np. MY_API_KEY).');
      return;
    }
    const models = providerForm.models
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const profile = {
      baseUrl: providerForm.baseUrl.trim(),
      authEnv: providerForm.authEnv.trim(),
      authStyle: providerForm.authStyle === 'apikey' ? 'apikey' : 'token',
    };
    if (models.length) profile.models = models;

    setEdited((prev) => ({
      ...prev,
      providers: { ...prev.providers, [name]: profile },
    }));
    setProviderError(null);
    setProviderForm({ name: '', baseUrl: '', authEnv: '', authStyle: 'token', models: '' });
    setEditingProvider(null);
    setPreview(null);
    setSuccess(null);
  };

  const handleEditProvider = (name) => {
    const p = edited?.providers?.[name] || {};
    setProviderForm({
      name,
      baseUrl: p.baseUrl || '',
      authEnv: p.authEnv || '',
      authStyle: p.authStyle || 'token',
      models: (p.models || []).join(', '),
    });
    setEditingProvider(name);
    setProviderError(null);
  };

  const handleRemoveProvider = (name) => {
    if (name === DEFAULT_PROVIDER) {
      setProviderError('Provider "openrouter" jest domyślny i nie może zostać usunięty.');
      return;
    }
    const referencing = SQUADS.filter(
      (s) => (edited?.squads?.[s]?.provider || DEFAULT_PROVIDER) === name,
    );
    if (referencing.length > 0) {
      setProviderError(`Nie można usunąć providera "${name}" — używają go składy: ${referencing.join(', ')}.`);
      return;
    }
    setEdited((prev) => {
      const providers = { ...prev.providers };
      delete providers[name];
      const pricing = { ...prev.pricing };
      delete pricing[name]; // removal also removes its pricing scope
      return { ...prev, providers, pricing };
    });
    if (pricingProvider === name) setPricingProvider(DEFAULT_PROVIDER);
    if (editingProvider === name) {
      setEditingProvider(null);
      setProviderForm({ name: '', baseUrl: '', authEnv: '', authStyle: 'token', models: '' });
    }
    setProviderError(null);
    setPreview(null);
    setSuccess(null);
  };

  const handleCancelProviderEdit = () => {
    setEditingProvider(null);
    setProviderForm({ name: '', baseUrl: '', authEnv: '', authStyle: 'token', models: '' });
    setProviderError(null);
  };

  // ---- pricing handlers ---------------------------------------------------

  const handlePriceChange = (slug, field, value) => {
    setEdited((prev) => {
      const current = prev.pricing[pricingProvider]?.[slug] || {};
      const next = { ...current };
      if (field === 'cacheRead' || field === 'cacheWrite') {
        next[field] = value === '' ? undefined : (Number(value) || 0);
      } else {
        next[field] = Number(value) || 0;
      }
      return {
        ...prev,
        pricing: {
          ...prev.pricing,
          [pricingProvider]: { ...(prev.pricing[pricingProvider] || {}), [slug]: next },
        },
      };
    });
    setPreview(null);
    setSuccess(null);
  };

  const handlePriceSlugChange = (oldSlug, newSlug) => {
    if (!newSlug.trim() || oldSlug === newSlug) return;
    setEdited((prev) => {
      const scope = { ...(prev.pricing[pricingProvider] || {}) };
      scope[newSlug] = { ...scope[oldSlug] };
      delete scope[oldSlug];
      return { ...prev, pricing: { ...prev.pricing, [pricingProvider]: scope } };
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
        [pricingProvider]: {
          ...(prev.pricing[pricingProvider] || {}),
          [slug]: { input: Number(newInput) || 0, output: Number(newOutput) || 0 },
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
      const scope = { ...(prev.pricing[pricingProvider] || {}) };
      delete scope[slug];
      return { ...prev, pricing: { ...prev.pricing, [pricingProvider]: scope } };
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
        providers: edited.providers,
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
        providers: edited.providers,
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

  // ---- tool editor --------------------------------------------------------

  const handleToolsOpen = useCallback((squad, role) => {
    const tools = edited?.squads?.[squad]?.agents?.[role]?.tools || [];
    setToolEditor({ squad, role, tools: [...tools] });
  }, [edited]);

  const handleDiscard = () => {
    if (!config) return;
    setEdited({
      squads: deepClone(config.squads || {}),
      pricing: deepClone(config.pricing || {}),
      providers: deepClone(config.providers || {}),
    });
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

  const providerNames = [...new Set([
    ...Object.keys(edited?.providers || {}),
    ...Object.keys(edited?.pricing || {}),
  ])];
  const activePricingProvider = providerNames.includes(pricingProvider)
    ? pricingProvider
    : DEFAULT_PROVIDER;
  const pricingSlugs = Object.keys(edited?.pricing?.[activePricingProvider] || {}).sort();
  const pricingPlaceholder = activePricingProvider === DEFAULT_PROVIDER
    ? 'provider/model-slug'
    : 'model-id';

  return (
    <div className="page">
      {/* Header */}
      <div className="page-title-row">
        <div>
          <div className="page-title">Konfiguracja składów</div>
          <div className="page-sub">
            Modele LLM per skład · providerzy · cennik · zmiany działają przy następnym uruchomieniu
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
          Tutaj konfigurujesz, które modele LLM są przypisane do poszczególnych składów (plan, dev, review, test, cadence),
          definiujesz providerów oraz uzupełniasz cennik, żeby telemetria mogła poprawnie przeliczać koszty.
        </p>
        <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
          <li>
            <strong>Provider domyślny to OpenRouter.</strong> Możesz dodać własnych providerów mówiących
            protokołem Anthropic Messages API (np. bezpośredni Anthropic, Z.AI). Każdy skład ma swój provider,
            a pola modeli walidują i podpowiadają nazwy zgodne z tym providerem.
          </li>
          <li>
            <strong>Klucz API nigdy nie trafia do konfiguracji ani UI.</strong> Każdy provider ma pole{' '}
            <code>authEnv</code> — nazwę zmiennej środowiskowej, pod którą klucz leży w pliku{' '}
            <code>.env</code> (np. <code>OPENROUTER_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>).
            Wartość klucza wpisujesz tylko tam.
          </li>
          <li>
            <strong>Cennik jest per provider</strong> — ten sam model może kosztować inaczej u różnych providerów.
            Telemetria rozlicza koszty po parze (provider, model).
          </li>
          <li>
            <strong>Zmiana zadziała przy następnym uruchomieniu składu</strong> — nie modyfikuje trwających
            sesji agentów. Jeśli chcesz zmienić model w już działającym agencie, zatrzymaj go i uruchom ponownie.
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

      {/* ---- Providers card ----------------------------------------------- */}
      <div className="section">
        <div className="section-h">Providerzy</div>

        {providerError && (
          <div className="api-banner" style={{ marginBottom: 12 }}>
            {providerError}
          </div>
        )}

        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr className="th">
                <th>Nazwa</th>
                <th>baseUrl</th>
                <th>authEnv</th>
                <th>authStyle</th>
                <th style={{ textAlign: 'right' }}>Modele</th>
                <th style={{ width: 110 }}></th>
              </tr>
            </thead>
            <tbody>
              {providerNames.map((name) => {
                const p = edited?.providers?.[name] || {};
                const isDefault = name === DEFAULT_PROVIDER;
                return (
                  <tr key={name}>
                    <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {name}{isDefault && <span className="muted" style={{ fontSize: 11 }}> (domyślny)</span>}
                    </td>
                    <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{p.baseUrl || '—'}</td>
                    <td className="td" style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{p.authEnv || '—'}</td>
                    <td className="td" style={{ fontSize: 12 }}>{p.authStyle || 'token'}</td>
                    <td className="td" style={{ textAlign: 'right', fontSize: 12 }}>{(p.models || []).length}</td>
                    <td className="td" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn-secondary"
                        style={{ fontSize: 11, padding: '3px 8px', marginRight: 4 }}
                        onClick={() => handleEditProvider(name)}
                      >
                        Edytuj
                      </button>
                      {!isDefault && (
                        <button
                          className="btn-secondary"
                          style={{ fontSize: 11, padding: '3px 8px' }}
                          onClick={() => handleRemoveProvider(name)}
                          title="Usuń providera"
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {providerNames.length === 0 && (
                <tr>
                  <td className="td muted" colSpan={6} style={{ textAlign: 'center' }}>
                    Brak providerów
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Add / edit provider form */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="filter-search"
            style={{ width: 140, fontFamily: 'var(--mono)', fontSize: 12 }}
            value={providerForm.name}
            onChange={(e) => handleProviderFormChange('name', e.target.value)}
            placeholder="nazwa (np. my_llm)"
            disabled={editingProvider !== null}
            aria-label="Nazwa providera"
          />
          <input
            className="filter-search"
            style={{ width: 220, fontFamily: 'var(--mono)', fontSize: 12 }}
            value={providerForm.baseUrl}
            onChange={(e) => handleProviderFormChange('baseUrl', e.target.value)}
            placeholder="https://api.example.com"
            aria-label="baseUrl providera"
          />
          <input
            className="filter-search"
            style={{ width: 180, fontFamily: 'var(--mono)', fontSize: 12 }}
            value={providerForm.authEnv}
            onChange={(e) => handleProviderFormChange('authEnv', e.target.value)}
            placeholder="MY_API_KEY"
            aria-label="authEnv providera (nazwa zmiennej)"
          />
          <select
            className="filter-search"
            style={{ width: 110 }}
            value={providerForm.authStyle}
            onChange={(e) => handleProviderFormChange('authStyle', e.target.value)}
            aria-label="authStyle providera"
          >
            <option value="token">token</option>
            <option value="apikey">apikey</option>
          </select>
          <input
            className="filter-search"
            style={{ width: 200, fontFamily: 'var(--mono)', fontSize: 12 }}
            value={providerForm.models}
            onChange={(e) => handleProviderFormChange('models', e.target.value)}
            placeholder="model-a, model-b (opcjonalne)"
            aria-label="Lista modeli providera"
          />
          <button className="launch-btn" style={{ padding: '6px 14px' }} onClick={handleProviderSubmit}>
            {editingProvider ? 'Zapisz' : 'Dodaj'}
          </button>
          {editingProvider && (
            <button className="btn-secondary" style={{ padding: '6px 12px' }} onClick={handleCancelProviderEdit}>
              Anuluj
            </button>
          )}
        </div>
      </div>

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
              pricing={edited?.pricing || {}}
              providers={edited?.providers || {}}
              onLeadChange={handleLeadChange}
              onProviderChange={handleProviderChange}
              onAgentChange={handleAgentChange}
              onToolsOpen={handleToolsOpen}
            />
          ))}
        </div>
      </div>

      {/* ---- Pricing table (scoped per provider) -------------------------- */}
      <div className="section">
        <div className="section-h">Cennik (USD / 1M tokenów)</div>

        {/* Provider tabs */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          {providerNames.map((name) => (
            <button
              key={name}
              className={name === activePricingProvider ? 'launch-btn' : 'btn-secondary'}
              style={{ padding: '4px 12px', fontSize: 12 }}
              onClick={() => setPricingProvider(name)}
            >
              {name}{name === DEFAULT_PROVIDER ? ' (domyślny)' : ''}
            </button>
          ))}
        </div>

        <table className="table">
          <thead>
            <tr className="th">
              <th>Model</th>
              <th style={{ textAlign: 'right' }}>Input</th>
              <th style={{ textAlign: 'right' }}>Output</th>
              <th style={{ textAlign: 'right' }}>Cache read</th>
              <th style={{ textAlign: 'right' }}>Cache write</th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {pricingSlugs.length === 0 && (
              <tr>
                <td className="td muted" colSpan={6} style={{ textAlign: 'center' }}>
                  Brak wpisów w cenniku dla providera „{activePricingProvider}”
                </td>
              </tr>
            )}
            {pricingSlugs.map((slug) => {
              const p = edited?.pricing?.[activePricingProvider]?.[slug] || {};
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
                  <td className="td" style={{ textAlign: 'right' }}>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="filter-search"
                      style={{ width: 90, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
                      value={p.cacheWrite ?? ''}
                      onChange={(e) => handlePriceChange(slug, 'cacheWrite', e.target.value)}
                      aria-label={`Cena cache write dla ${slug}`}
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
                  placeholder={pricingPlaceholder}
                  aria-label="Nowy model"
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

      {/* ---- Tool editor modal -------------------------------------------- */}
      <ToolEditorModal
        target={toolEditor}
        onClose={() => setToolEditor(null)}
        onSaved={fetchConfig}
      />
    </div>
  );
}
