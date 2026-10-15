// Tool profiles UI (P2 slice) — ONE staging surface for the user-owned
// tool-profiles registry (scripts/tool-profiles.mjs, served by
// scripts/tool-routes.mjs): the Thoughtmap MCP server connection and the
// per-squad leadTools lists.
//
// The staged copy here is deliberately SEPARATE from the shared squad-config
// working copy the Manager's edit bar owns: different endpoint, different
// payload, clearly labelled "tool profiles". Same mechanics though — edits
// stage locally, a dry-run preview shows the change rows, and only an
// explicit Apply click writes (PUT with a compare-and-swap expectedRevision;
// a stale revision is refused with an honest conflict message, never applied).
//
// Worker role tools are NOT edited here — the agents/<squad>/agents/<role>.md
// frontmatter stays canonical and the Profile tab's ToolsEditor keeps staging
// through the shared squad-config writer. This panel never touches
// roleOverrides. The tool-list layers staged here are the registry's full
// inheritance chain — globalTools (base for every squad) → squadTools.<squad>
// → leadTools.<squad> (the lead's leaf, edited in the Inspector) — all with
// the same Inherit / None / Explicit modes.
//
// Honesty rules carried over from the backend slice:
//   - "verified" means the real adapter initialized and answered one read-only
//     search roundtrip (POST /api/tool-profiles/test) — never a REST health
//     claim; changing any connection input resets the verification.
//   - Discovered tool names come from the probe's tools/list, failures carry
//     the stage that failed, the code and the dependency hint (e.g.
//     python-unavailable) — "configured but unverifiable" is rendered, not
//     faked green.
//   - Config and check output are scrubbed before rendering: a secret-shaped
//     value never reaches the screen.
//   - Applies touch the NEXT launched process only; running processes keep
//     their current tools. Provider keys stay in /squad-config — out of scope.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { getTools } from '../../api';
import {
  CONNECTION_FIELDS,
  SQUAD_NAME_RE,
  buildProbeBody,
  buildProfilePayload,
  catalogNames,
  connectionInputsChanged,
  describeCheck,
  dirtyPaths,
  effectiveLead,
  getToolProfiles,
  getToolProfilesCatalog,
  globalValue,
  leadValue,
  mergeCatalogs,
  normalizeTpError,
  postToolProfilesTest,
  previewIsValid,
  putToolProfiles,
  redactChanges,
  redactDeep,
  squadValue,
  stagedFingerprint,
  stagedFromConfig,
  toolMode,
  toolValueForMode,
} from '../../toolProfilesModel.js';
import { splitKnownTools } from '../../squadConfig/workingCopy.js';

const IDLE_SAVE = { phase: 'idle', op: null, result: null, error: null };

const CONNECTION_LABELS = {
  baseUrl: 'Thoughtmap API URL',
  ollamaBaseUrl: 'Ollama base URL',
  embeddingModel: 'Embedding model',
  clustersPath: 'Clusters artifact path',
};

// ─── Store hook (screen-level state — shared by the panel and the inspector) ─

export function useToolProfilesStore() {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [readAt, setReadAt] = useState(null);
  const [staged, setStaged] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewFp, setPreviewFp] = useState(null);
  const [save, setSave] = useState(IDLE_SAVE);
  const [verify, setVerify] = useState(null); // {busy, check, configured, form, formKey, error}
  const [rawCatalog, setRawCatalog] = useState(null); // {native, tp} — merged lazily below

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { config: cfg } = await getToolProfiles();
      setConfig(cfg);
      setStaged(stagedFromConfig(cfg));
      setReadAt(new Date());
      setPreview(null);
      setPreviewFp(null);
      setVerify(null); // a fresh read — the old probe result no longer pairs with the form
      setSave((prev) => (prev.phase === 'ok' ? prev : IDLE_SAVE));
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const fp = useMemo(() => (staged ? stagedFingerprint(staged) : null), [staged]);
  const fpRef = useRef(fp);
  useEffect(() => {
    fpRef.current = fp;
  }, [fp]);

  const dirty = useMemo(() => dirtyPaths(staged, config), [staged, config]);

  // Any edit invalidates a previous dry run and the staged-bar outcome.
  const afterStage = useCallback(() => {
    setPreview(null);
    setPreviewFp(null);
    setSave((prev) => (prev.phase === 'ok' ? prev : IDLE_SAVE));
  }, []);

  const stageThoughtmap = useCallback(
    (field, value) => {
      setStaged((prev) => (prev ? { ...prev, thoughtmap: { ...prev.thoughtmap, [field]: value } } : prev));
      afterStage();
    },
    [afterStage]
  );

  const stageLeadTools = useCallback(
    (squad, value) => {
      setStaged((prev) => (prev ? { ...prev, leadTools: { ...prev.leadTools, [squad]: value } } : prev));
      afterStage();
    },
    [afterStage]
  );

  const stageGlobalTools = useCallback(
    (value) => {
      setStaged((prev) => (prev ? { ...prev, globalTools: value } : prev));
      afterStage();
    },
    [afterStage]
  );

  const stageSquadTools = useCallback(
    (squad, value) => {
      setStaged((prev) => (prev ? { ...prev, squadTools: { ...prev.squadTools, [squad]: value } } : prev));
      afterStage();
    },
    [afterStage]
  );

  // The connection inputs changed since the last verification → reset it.
  // Toggling `enabled` alone does not (the probe ignores that flag).
  useEffect(() => {
    setVerify((prev) => {
      if (!prev || prev.busy || !staged) return prev;
      if (!connectionInputsChanged(staged.thoughtmap, prev.form)) return prev;
      return null;
    });
  }, [staged]);

  const previewChanges = useCallback(async () => {
    if (!staged || !config) return;
    const snapshotFp = fp;
    setSave({ phase: 'busy', op: 'preview', result: null, error: null });
    try {
      const result = await putToolProfiles(buildProfilePayload(staged, config, true));
      setSave(IDLE_SAVE);
      if (fpRef.current !== snapshotFp) return; // staged on while in flight — drop the stale dry run
      setPreview(result);
      setPreviewFp(snapshotFp);
    } catch (err) {
      setPreview(null);
      setPreviewFp(null);
      setSave({ phase: 'error', op: 'preview', result: null, error: normalizeTpError(err) });
    }
  }, [staged, config, fp]);

  const applyChanges = useCallback(async () => {
    // Apply only after a dry run of the CURRENT staged snapshot.
    if (!staged || !config || !preview || !previewIsValid(previewFp, fp)) return;
    setSave({ phase: 'busy', op: 'apply', result: null, error: null });
    try {
      const result = await putToolProfiles(buildProfilePayload(staged, config, false));
      setPreview(null);
      setPreviewFp(null);
      setSave({ phase: 'ok', op: 'apply', result, error: null });
      await reload(); // applied state is server truth — staging resets
    } catch (err) {
      setSave({ phase: 'error', op: 'apply', result: null, error: normalizeTpError(err) });
    }
  }, [staged, config, preview, previewFp, fp, reload]);

  const discardChanges = useCallback(() => {
    if (!config) return;
    setStaged(stagedFromConfig(config));
    setPreview(null);
    setPreviewFp(null);
    setSave(IDLE_SAVE);
    // verification survives only if the configured inputs still match it —
    // the reset effect above re-checks on the next render.
  }, [config]);

  // Explicit, read-only connectivity test against the CURRENT connection
  // inputs. Never writes config; the response carries stages/names/timing
  // only — found note content never leaves the probe.
  const testConnection = useCallback(async () => {
    if (!staged) return;
    const body = buildProbeBody(staged.thoughtmap);
    const formKey = stagedFingerprint(body);
    setVerify({ busy: true, check: null, configured: null, form: body, formKey, error: null });
    try {
      const result = await postToolProfilesTest(body);
      setVerify((prev) =>
        prev && prev.formKey === formKey
          ? { busy: false, check: result?.check ?? null, configured: result?.configured ?? null, form: body, formKey, error: null }
          : prev
      );
    } catch (err) {
      setVerify((prev) =>
        prev && prev.formKey === formKey
          ? { busy: false, check: null, configured: null, form: body, formKey, error: normalizeTpError(err) }
          : prev
      );
    }
  }, [staged]);

  // Merged tool catalog (native /api/tools + MCP names), loaded lazily on
  // first need and shared by all three editors. The merge re-runs against the
  // STAGED enabled flag: a Thoughtmap enable staged in this session makes the
  // mcp__thoughtmap__* tools selectable in the SAME Apply — the fetched
  // catalog's serverEnabled describes the last server read, not the pending
  // change. Before the staged copy exists the catalog's own flag decides.
  const catalogRequested = useRef(false);
  const ensureCatalog = useCallback(async () => {
    if (rawCatalog || catalogRequested.current) return;
    catalogRequested.current = true;
    try {
      const [native, tp] = await Promise.all([
        getTools(),
        getToolProfilesCatalog().catch(() => null), // the MCP half is optional — native still works
      ]);
      setRawCatalog({ native, tp });
    } catch {
      catalogRequested.current = false; // allow a retry on the next open
    }
  }, [rawCatalog]);

  const catalog = useMemo(() => {
    if (!rawCatalog) return null;
    const mcpEnabled = staged ? staged.thoughtmap?.enabled : undefined;
    return mergeCatalogs(rawCatalog.native, rawCatalog.tp, { mcpEnabled });
  }, [rawCatalog, staged]);

  return {
    config,
    loading,
    loadError,
    readAt,
    staged,
    stagedFp: fp,
    dirty,
    dirtyCount: dirty.length,
    preview,
    previewFp,
    save,
    verify,
    catalog,
    ensureCatalog,
    reload,
    stageThoughtmap,
    stageLeadTools,
    stageGlobalTools,
    stageSquadTools,
    previewChanges,
    applyChanges,
    discardChanges,
    testConnection,
  };
}

// ─── Shared pieces ───────────────────────────────────────────────────────────

function StagedBar({ store, label }) {
  const {
    staged,
    config,
    dirtyCount,
    preview,
    previewFp,
    stagedFp,
    save,
    previewChanges,
    applyChanges,
    discardChanges,
    reload,
  } = store;
  if (!staged || !config) return null;
  const canApply = !!preview && previewIsValid(previewFp, stagedFp);
  return (
    <div className="mgr-editbar" aria-label={`Staged tool profile changes — ${label}`}>
      <div className="mgr-editbar-row">
        {dirtyCount > 0 ? (
          <span className="mgr-chip mgr-chip-warn">
            <span aria-hidden="true">✎</span> {dirtyCount} staged tool-profile change
            {dirtyCount === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="mgr-muted">no staged tool-profile changes</span>
        )}
        <span className="mgr-editbar-note">
          tool profiles are a separate registry from squad-config — written only by the Apply click below,
          applies to the <strong>next launched</strong> process (running processes keep their tools)
        </span>
        <div className="mgr-editbar-actions">
          <button
            type="button"
            className="mgr-btn mgr-btn-sm"
            onClick={previewChanges}
            disabled={dirtyCount === 0 || save.phase === 'busy'}
          >
            {save.phase === 'busy' && save.op === 'preview' ? 'Checking…' : 'Preview changes'}
          </button>
          <button
            type="button"
            className="mgr-btn mgr-btn-sm mgr-btn-primary"
            onClick={applyChanges}
            disabled={!canApply || save.phase === 'busy'}
            title="apply is enabled after a dry-run preview of the current staged changes"
          >
            {save.phase === 'busy' && save.op === 'apply' ? 'Applying…' : 'Apply'}
          </button>
          <button
            type="button"
            className="mgr-btn mgr-btn-sm"
            onClick={discardChanges}
            disabled={dirtyCount === 0 || save.phase === 'busy'}
          >
            Discard
          </button>
        </div>
      </div>

      {save.error && (
        <div className="mgr-save-error" role="alert">
          <p className="mgr-error-title">
            {save.op === 'apply'
              ? 'Apply failed — nothing was written; your staged changes are still here.'
              : 'Preview failed — nothing was written.'}
          </p>
          <p>{save.error.message}</p>
          {save.error.details.length > 0 && (
            <ul>
              {save.error.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          {/revision conflict/.test(save.error.message) && (
            <button
              type="button"
              className="mgr-btn mgr-btn-sm"
              onClick={reload}
              title="re-reads the registry and rebuilds staging from the current server state — staged edits are discarded"
            >
              Reload registry (discards staged edits)
            </button>
          )}
        </div>
      )}

      {save.phase === 'ok' && save.op === 'apply' && save.result && (
        <div className="mgr-save-ok" role="status">
          <p className="mgr-save-ok-title">
            ✓ Tool profiles saved (revision {save.result.config?.revision}) — applies on the next launched
            process; running processes are unchanged.
          </p>
        </div>
      )}

      {preview && (
        <div className="mgr-preview">
          <p className="mgr-preview-title">Preview (dry run — nothing has been written yet)</p>
          {redactChanges(preview.changes).length > 0 ? (
            <table className="mgr-table mgr-table-tight">
              <thead>
                <tr>
                  <th scope="col">Path</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {redactChanges(preview.changes).map((c) => (
                  <tr key={c.path}>
                    <td className="mgr-cell-mono">{c.path}</td>
                    <td className="mgr-cell-mono mgr-diff-before">{JSON.stringify(c.before)}</td>
                    <td className="mgr-cell-mono mgr-diff-after">{JSON.stringify(c.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mgr-empty-note">No changes to apply — the staged copy matches the server state.</p>
          )}
          {save.error?.message?.includes('revision conflict') && (
            <p className="mgr-warn-note" role="note">
              <span aria-hidden="true">⚠</span> the registry changed under this editor (expectedRevision
              conflict) — Discard or re-read, re-stage, and preview again before applying.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// One probe outcome: configured (what the registry holds) vs verified (what
// the probe actually proved), the discovered tool names, and honest failures
// including the dependency hint.
function CheckResult({ verify, stale }) {
  const check = useMemo(() => describeCheck(verify.check), [verify.check]);
  if (!check) return null;
  return (
    <div className="mgr-modeledit-meta" style={{ display: 'block' }}>
      {verify.configured && (
        <p className="mgr-muted">
          probe ran against:{' '}
          {CONNECTION_FIELDS.map((f, i) => (
            <span key={f}>
              {i > 0 && ', '}
              <code>{f}</code> <code>{redactDeep(verify.configured[f]) ?? '—'}</code>
            </span>
          ))}
        </p>
      )}
      {check.ok ? (
        <p role="status">
          <span aria-hidden="true">✓</span> <strong>verified</strong> — the adapter initialized, listed its
          tools and answered one read-only search in {check.ms} ms (all {check.passedCount} stages passed).
        </p>
      ) : (
        <p role="alert" className="mgr-warn-note">
          <span aria-hidden="true">✗</span> <strong>not verified</strong> — {check.passedCount}/3 MCP
          handshake stages passed
          {check.failure?.code ? ` (code: ${check.failure.code})` : ''}
          {check.failure?.error ? `: ${check.failure.error}` : ''}
          {check.failure?.hint ? (
            <>
              <br />
              <span className="mgr-muted">dependency: {check.failure.hint}</span>
            </>
          ) : null}
        </p>
      )}
      {check.tools.length > 0 ? (
        <p>
          tools discovered ({check.tools.length}):{' '}
          {check.tools.map((t) => (
            <code key={t} className="mgr-tool-list">
              {t}{' '}
            </code>
          ))}
        </p>
      ) : (
        check.ok && <p className="mgr-muted">the adapter listed no tools</p>
      )}
      {stale && (
        <p className="mgr-warn-note" role="note">
          <span aria-hidden="true">⚠</span> the connection inputs changed since this test — the verification
          above no longer describes them. Test again before trusting it.
        </p>
      )}
    </div>
  );
}

// ─── Shared editor pieces (global / squad / lead use the same controls) ─────

/** The Inherit / None / Explicit radio group — one mode is shown at a time,
 *  never blended. `onSelect` receives the mode name. */
function ModeRadios({ idPrefix, group, mode, onSelect, labels }) {
  return (
    <fieldset style={{ margin: '6px 0', border: 'none', padding: 0 }}>
      <legend className="mgr-muted">tool list mode</legend>
      <div role="radiogroup" aria-label={group}>
        {labels.map(([value, labelText]) => (
          <div key={value}>
            <input
              type="radio"
              id={`${idPrefix}-mode-${value}`}
              name={`${idPrefix}-mode`}
              checked={mode === value}
              onChange={() => onSelect(value)}
            />
            <label htmlFor={`${idPrefix}-mode-${value}`} style={{ marginLeft: '6px' }}>
              {labelText}
            </label>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

/** The catalog checkbox table: known names toggle, catalog-unknown names ride
 *  along locked (preserved as configured, never granted while unavailable).
 *  `onChange` receives the new full list. */
function ToolCatalogPicker({ catalog, list, onChange, toolLabel }) {
  const names = catalogNames(catalog);
  const split = splitKnownTools(list, names);
  const toggle = (name) => {
    const base = split.editable.includes(name)
      ? split.editable.filter((x) => x !== name)
      : [...split.editable, name];
    onChange([...base, ...split.preserved]);
  };
  return (
    <div>
      {!catalog && <p className="mgr-muted">loading tools catalog…</p>}
      {catalog && names.length === 0 && <p className="mgr-empty-note">no catalog data</p>}
      {catalog && names.length > 0 && (
        <table className="mgr-table mgr-table-tight">
          <thead>
            <tr>
              <th scope="col" aria-label="Selected" />
              <th scope="col">Tool</th>
              <th scope="col">What it does</th>
            </tr>
          </thead>
          <tbody>
            {names.map((name) => {
              const t = catalog.tools[name];
              const isMcp = t.source === 'mcp';
              return (
                <tr key={name} style={isMcp ? { background: 'var(--warn-soft)' } : undefined}>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={split.editable.includes(name)}
                      onChange={() => toggle(name)}
                      aria-label={`${toolLabel} ${name}`}
                    />
                  </td>
                  <td className="mgr-cell-mono">
                    {name}
                    {isMcp && <span className="mgr-muted"> (MCP)</span>}
                  </td>
                  <td>{t.description || '—'}</td>
                </tr>
              );
            })}
            {split.preserved.map((name) => (
              <tr key={`preserved-${name}`}>
                <td style={{ textAlign: 'center' }}>
                  <input type="checkbox" checked disabled aria-label={`Preserved ${toolLabel.toLowerCase()} ${name}`} />
                </td>
                <td className="mgr-cell-mono">{name}</td>
                <td>
                  <span className="mgr-muted">
                    not in the enabled catalog — preserved as configured, never granted while
                    unavailable
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!catalog?.mcpAvailable && (
        <p className="mgr-muted">
          The Thoughtmap MCP server is not enabled in the staged copy — its{' '}
          <code>mcp__thoughtmap__*</code> tools stay unavailable (preserved if configured, never
          granted). Stage the enable in the connection form above and its tools become selectable
          in the <strong>same Apply</strong>.
        </p>
      )}
    </div>
  );
}

// ─── Global tools: the base layer of the inheritance chain ──────────────────

export function GlobalToolsEditor({ store }) {
  const { config, staged, catalog, ensureCatalog, stageGlobalTools, dirty } = store;

  useEffect(() => {
    ensureCatalog();
  }, [ensureCatalog]);

  if (!staged || !config) return null;
  const stagedTouched = dirty.includes('globalTools');
  const effective = staged.globalTools ?? null;
  const mode = toolMode(effective);
  const list = Array.isArray(effective) ? effective : [];

  return (
    <section className="mgr-leadtools" aria-label="Global tool list" style={{ margin: '12px 0' }}>
      <h3 style={{ fontSize: '0.95rem', margin: '4px 0' }}>Global tools — base layer</h3>
      <p className="mgr-inspector-note">
        The base for <strong>every</strong> squad: a lead falls through to it when neither
        <code> leadTools.&lt;squad&gt;</code> nor <code>squadTools.&lt;squad&gt;</code> is set, and a
        worker when its frontmatter names no tools. null = inherit (CLI default tools),{' '}
        <code>[]</code> = explicit none — they are different values and both are honest here.
      </p>

      <ModeRadios
        idPrefix="mgr-globaltools"
        group="Global tools mode"
        mode={mode}
        onSelect={(value) => stageGlobalTools(toolValueForMode(value, list))}
        labels={[
          ['inherit', 'inherit — every squad keeps the CLI default tools (entry removed on apply)'],
          ['none', 'explicit none — launch with no tools'],
          ['explicit', 'explicit list — the base for squads with no more specific layer'],
        ]}
      />

      {mode === 'explicit' && (
        <ToolCatalogPicker
          catalog={catalog}
          list={list}
          onChange={stageGlobalTools}
          toolLabel="Global tool"
        />
      )}

      <div className="mgr-modeledit-meta">
        {stagedTouched ? (
          <span className="mgr-chip mgr-chip-warn">
            <span aria-hidden="true">✎</span> staged:{' '}
            {mode === 'inherit' ? 'inherit (entry removed)' : mode === 'none' ? 'explicit none' : `${list.length} tools`}
          </span>
        ) : (
          <span className="mgr-muted">
            as configured: {toolMode(globalValue(config)) === 'inherit' ? 'inherit' : `${list.length} tools`}
          </span>
        )}
        {stagedTouched && <span className="mgr-muted">— preview (dry run) and Apply live in the staged bar above</span>}
      </div>
    </section>
  );
}

// ─── Per-squad middle layer: squadTools.<squad> ──────────────────────────────

export function SquadToolsEditor({ store }) {
  const { config, staged, catalog, ensureCatalog, stageSquadTools, dirty } = store;
  const [squadInput, setSquadInput] = useState('');

  useEffect(() => {
    ensureCatalog();
  }, [ensureCatalog]);

  const squad = squadInput.trim();
  const shapeOk = SQUAD_NAME_RE.test(squad);
  const path = `squadTools.${squad}`;
  // An entry present in the staged copy decides (an explicitly staged null is
  // "inherit"); otherwise the server state reads through.
  const touchedEntry = staged && Object.prototype.hasOwnProperty.call(staged.squadTools || {}, squad);
  const effective = touchedEntry ? staged.squadTools[squad] : squadValue(config, squad);
  const mode = toolMode(effective);
  const list = Array.isArray(effective) ? effective : [];
  const resolution = shapeOk && config ? effectiveLead(config, squad) : null;
  const dirtyPath = dirty.includes(path);

  return (
    <section className="mgr-leadtools" aria-label="Per-squad tool list" style={{ margin: '12px 0' }}>
      <h3 style={{ fontSize: '0.95rem', margin: '4px 0' }}>Squad tools — middle layer</h3>
      <p className="mgr-inspector-note">
        One squad's base list, sitting between global and lead layers: a lead resolves{' '}
        <code>leadTools.&lt;squad&gt;</code> first, then this, then global; a worker's frontmatter
        stays canonical and this fills in only when the frontmatter names no tools. Worker
        roleOverrides are never staged here.
      </p>

      <label htmlFor="mgr-squadtools-squad" style={{ display: 'block' }}>
        Squad name
      </label>
      <input
        id="mgr-squadtools-squad"
        className="mgr-input"
        value={squadInput}
        onChange={(e) => setSquadInput(e.target.value)}
        placeholder="e.g. dev"
        spellCheck={false}
        style={{ maxWidth: '280px' }}
      />
      {squad !== '' && !shapeOk && (
        <p className="mgr-warn-note" role="alert">
          <span aria-hidden="true">⚠</span> not a squad name (lowercase letters, digits, dashes;
          starts with a letter) — stage nothing until it is. The server also accepts only
          configured squads (plus <code>supervisor</code>); a wrong name is refused at preview.
        </p>
      )}

      {shapeOk && (
        <>
          <ModeRadios
            idPrefix="mgr-squadtools"
            group={`Squad tools mode for ${squad}`}
            mode={mode}
            onSelect={(value) => stageSquadTools(squad, toolValueForMode(value, list))}
            labels={[
              ['inherit', 'inherit — no squad-level list (falls through to globalTools)'],
              ['none', 'explicit none — squads in this name launch with no tools'],
              ['explicit', 'explicit list'],
            ]}
          />

          {mode === 'explicit' && (
            <ToolCatalogPicker
              catalog={catalog}
              list={list}
              onChange={(value) => stageSquadTools(squad, value)}
              toolLabel="Squad tool"
            />
          )}

          <div className="mgr-modeledit-meta">
            {dirtyPath ? (
              <span className="mgr-chip mgr-chip-warn">
                <span aria-hidden="true">✎</span> staged:{' '}
                {mode === 'inherit'
                  ? 'inherit (entry removed)'
                  : mode === 'none'
                    ? 'explicit none'
                    : `${list.length} tools`}
              </span>
            ) : (
              <span className="mgr-muted">
                as configured: {toolMode(squadValue(config, squad)) === 'inherit' ? 'inherit' : `${list.length} tools`}
              </span>
            )}
            {dirtyPath && <span className="mgr-muted">— preview (dry run) and Apply live in the staged bar above</span>}
          </div>
          {resolution && (
            <p className="mgr-muted">
              this squad's lead currently resolves to:{' '}
              {resolution.source === 'native'
                ? 'CLI defaults (no layer is set)'
                : `${toolMode(resolution.value) === 'none' ? 'explicit none' : `${resolution.value.length} tools`} via ${resolution.source}`}
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ─── The Manager-screen panel: connection form + test + staged bar ──────────

export function ToolProfilesPanel({ store }) {
  const {
    config,
    loading,
    loadError,
    readAt,
    staged,
    verify,
    reload,
    stageThoughtmap,
    testConnection,
    dirtyCount,
  } = store;
  const uid = useId();

  const configured = useMemo(() => (config ? redactDeep(config) : null), [config]);

  return (
    <section className="mgr-toolprofiles" aria-label="Tool profiles — MCP server and the global, squad and lead tool lists">
      <h2 className="mgr-toolprofiles-title" style={{ fontSize: '1rem', margin: '8px 0 4px' }}>
        Tool profiles
      </h2>
      <p className="mgr-inspector-note">
        Which MCP servers and tool lists squads get — a separate user-owned registry (not
        squad-config, not agent frontmatter). The Thoughtmap MCP server serves the{' '}
        <code>mcp__thoughtmap__*</code> tools; staging its enable makes them selectable for leads
        and worker tool editors in the same Apply. Tool lists resolve per lead as{' '}
        <code>leadTools.&lt;squad&gt;</code> → <code>squadTools.&lt;squad&gt;</code> →{' '}
        <code>globalTools</code> → CLI defaults; worker frontmatter stays canonical. Changes apply
        on the <strong>next launched</strong> process — running processes keep their current tools.
        Provider keys stay in <code>/squad-config</code> (out of scope here).
      </p>

      {loading && (
        <p className="mgr-muted" role="status">
          loading tool profiles…
        </p>
      )}

      {loadError && (
        <div className="mgr-error" role="alert">
          <p className="mgr-error-title">Cannot reach the tool-profiles API</p>
          <p>
            GET <code>/api/tool-profiles</code> failed ({loadError.message}). The lead tool-profile registry
            is unread — nothing here can be staged until it answers.
          </p>
          <button type="button" className="mgr-btn" onClick={reload}>
            Retry
          </button>
        </div>
      )}

      {configured && staged && (
        <>
          <StagedBar store={store} label="tool profiles" />

          <div style={{ margin: '8px 0' }}>
            <input
              type="checkbox"
              id={`${uid}-enabled`}
              checked={staged.thoughtmap.enabled}
              onChange={(e) => stageThoughtmap('enabled', e.target.checked)}
            />
            <label htmlFor={`${uid}-enabled`} style={{ marginLeft: '6px' }}>
              Enable the Thoughtmap MCP server
            </label>
            {configured.mcp?.thoughtmap?.enabled !== undefined && (
              <span className="mgr-muted" style={{ marginLeft: '10px' }}>
                configured: {String(configured.mcp.thoughtmap.enabled)}
              </span>
            )}
          </div>

          {CONNECTION_FIELDS.map((field) => {
            const inputId = `${uid}-${field}`;
            const changed = staged.thoughtmap[field] !== (config.mcp?.thoughtmap?.[field] ?? '');
            return (
              <div key={field} style={{ margin: '6px 0' }}>
                <label htmlFor={inputId} style={{ display: 'block' }}>
                  {CONNECTION_LABELS[field]}
                </label>
                <input
                  id={inputId}
                  className="mgr-input"
                  style={{ width: '100%', maxWidth: '480px' }}
                  value={staged.thoughtmap[field] ?? ''}
                  onChange={(e) => stageThoughtmap(field, e.target.value)}
                  spellCheck={false}
                  aria-describedby={`${inputId}-cfg`}
                />
                <div id={`${inputId}-cfg`} className="mgr-modeledit-meta">
                  <span className="mgr-muted">
                    configured: <code>{String(configured.mcp?.thoughtmap?.[field] ?? '—')}</code>
                  </span>
                  {changed && (
                    <span className="mgr-chip mgr-chip-warn">
                      <span aria-hidden="true">✎</span> staged
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          <div style={{ margin: '10px 0' }}>
            <button
              type="button"
              className="mgr-btn mgr-btn-sm"
              onClick={testConnection}
              disabled={verify?.busy}
              title="read-only: starts the real adapter once and answers one search — writes nothing"
            >
              {verify?.busy ? 'Testing…' : 'Test connection'}
            </button>
            {readAt && (
              <span className="mgr-muted" style={{ marginLeft: '10px' }}>
                registry read {readAt.toLocaleTimeString()}
              </span>
            )}
            <p className="mgr-muted">
              read-only probe: initializes the real MCP adapter (initialize → tools/list → one synthetic
              search) — never a REST health claim, and found content never leaves the probe.
            </p>
            {verify?.error && (
              <p className="mgr-warn-note" role="alert">
                <span aria-hidden="true">⚠</span> test request failed: {verify.error.message}
              </p>
            )}
            {verify?.check && (
              <CheckResult
                verify={verify}
                stale={connectionInputsChanged(staged.thoughtmap, verify.form)}
              />
            )}
            {!verify?.check && !verify?.busy && (
              <p className="mgr-muted">not verified in this session — configured values are shown, not proven.</p>
            )}
          </div>

          <GlobalToolsEditor store={store} />
          <SquadToolsEditor store={store} />
        </>
      )}
    </section>
  );
}

// ─── Inspector control: leadTools for one squad (shared staged copy) ────────

export function LeadToolsEditor({ store, squad, squadKeys }) {
  const { config, staged, catalog, ensureCatalog, stageLeadTools, dirty } = store;
  const [selected, setSelected] = useState(squad || squadKeys?.[0] || null);

  useEffect(() => {
    if (squad) setSelected(squad);
  }, [squad]);

  useEffect(() => {
    ensureCatalog();
  }, [ensureCatalog]);

  if (!selected) return null;
  const stagedValue = staged?.leadTools?.[selected];
  const touched = stagedValue !== undefined;
  const effective = touched ? stagedValue : leadValue(config, selected);
  const mode = toolMode(effective);
  const list = Array.isArray(effective) ? effective : [];
  const dirtyPath = dirty.includes(`leadTools.${selected}`);
  const resolution = config ? effectiveLead(config, selected) : null;

  const stage = (value) => stageLeadTools(selected, value);

  return (
    <div className="mgr-leadtools" style={{ margin: '4px 0' }}>
      <label htmlFor="mgr-leadtools-squad" style={{ display: 'block' }}>
        Lead tools profile — squad
      </label>
      <select
        id="mgr-leadtools-squad"
        className="mgr-select"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        style={{ maxWidth: '280px' }}
      >
        {(squadKeys || []).map((key) => (
          <option key={key} value={key}>
            {key}
          </option>
        ))}
      </select>

      <ModeRadios
        idPrefix="mgr-leadtools"
        group={`Lead tools mode for ${selected}`}
        mode={mode}
        onSelect={(value) => stage(toolValueForMode(value, list))}
        labels={[
          ['inherit', 'inherit — CLI default tools (no explicit list)'],
          ['none', 'explicit none — launch with no tools'],
          ['explicit', 'explicit list'],
        ]}
      />

      {mode === 'explicit' && (
        <ToolCatalogPicker
          catalog={catalog}
          list={list}
          onChange={stage}
          toolLabel="Lead tool"
        />
      )}

      <div className="mgr-modeledit-meta">
        {touched && dirtyPath ? (
          <span className="mgr-chip mgr-chip-warn">
            <span aria-hidden="true">✎</span> staged:{' '}
            {mode === 'inherit' ? 'inherit (entry removed)' : mode === 'none' ? 'explicit none' : `${list.length} tools`}
          </span>
        ) : (
          <span className="mgr-muted">
            as configured: {toolMode(leadValue(config, selected)) === 'inherit' ? 'inherit' : `${list.length} tools`}
          </span>
        )}
        {dirtyPath && <span className="mgr-muted">— preview (dry run) and Apply live in the Tool profiles panel below</span>}
      </div>
      {resolution && (
        <p className="mgr-muted">
          this squad's lead currently resolves to:{' '}
          {resolution.source === 'native'
            ? 'CLI defaults (no layer is set)'
            : `${toolMode(resolution.value) === 'none' ? 'explicit none' : `${resolution.value.length} tools`} via ${resolution.source}`}
        </p>
      )}
      <p className="mgr-muted mgr-modeledit-hint">
        null = inherit, <code>[]</code> = explicit none — they are different values and both are honest
        here. Applies on the <strong>next launched</strong> lead process; the running lead keeps its
        current tools. Worker role tools stay in role frontmatter — this edits the lead only.
      </p>
    </div>
  );
}