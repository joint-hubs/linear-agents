// Repositories panel (FOC-786, spec §4.6) — the shared clones with branch@head,
// dirty, CodeGraph index state, extra worktrees and the mapped Linear project.
// "Add repository" starts a background clone: the job is polled every 1 s
// while it runs (git's --progress tail), and the list refreshes once it ends.
// Unmap asks first — it removes the Linear project mapping only, the files
// stay on disk.

import { useEffect, useState } from 'react';
import { usePoll } from '../../hooks/usePoll';
import { getSettingsRepos, addSettingsRepo, getRepoJob, unmapSettingsRepo } from '../../api';
import { repoRows, jobProgressText, jobActive } from '../../settingsModel';

export default function ReposPanel() {
  const { data, error, refresh } = usePoll((signal) => getSettingsRepos(signal), 5000, []);
  const [url, setUrl] = useState('');
  const [project, setProject] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [job, setJob] = useState(null); // the clone job being watched
  const [confirming, setConfirming] = useState(null); // repo name pending unmap
  const [mapError, setMapError] = useState(null);

  // While a clone runs, poll the job every 1 s; when it ends, refresh the list
  // once. A failed tick is transient — the next tick retries.
  useEffect(() => {
    if (!job || !jobActive(job)) return undefined;
    const id = setInterval(async () => {
      try {
        const next = await getRepoJob(job.id);
        setJob(next);
        if (next && !jobActive(next)) refresh();
      } catch {
        /* transient — retried on the next tick */
      }
    }, 1000);
    return () => clearInterval(id);
  }, [job, refresh]);

  const add = async (e) => {
    e.preventDefault();
    if (!url.trim() || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const r = await addSettingsRepo(url.trim(), project.trim() || undefined);
      if (r && r.jobId) setJob(await getRepoJob(r.jobId));
      setUrl('');
      setProject('');
      refresh();
    } catch (err) {
      setAddError((err.data && err.data.error) || err.message);
    } finally {
      setAdding(false);
    }
  };

  const unmap = async (name) => {
    setConfirming(null);
    setMapError(null);
    try {
      await unmapSettingsRepo(name);
      refresh();
    } catch (err) {
      setMapError((err.data && err.data.error) || err.message);
    }
  };

  const rows = repoRows(data?.repos);

  return (
    <div>
      <form className="st-form" onSubmit={add} style={{ marginBottom: 12 }}>
        <div className="st-row">
          <label style={{ flex: 2 }}>
            Repository URL (cloned into {data?.root || 'the repos root'})
            <input
              className="st-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://github.com/org/repo.git"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label style={{ flex: 1 }}>
            Linear project (optional)
            <input
              className="st-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={project}
              onChange={(e) => setProject(e.target.value)}
            />
          </label>
          <button type="submit" className="launch-btn" disabled={adding || !url.trim()}>
            Add repository
          </button>
        </div>
        {addError && <div className="st-tone-danger">{addError}</div>}
        {job && jobProgressText(job) && (
          <div className="muted st-mono" style={{ fontSize: 11.5 }}>
            {jobProgressText(job)}
          </div>
        )}
      </form>

      {error && (
        <div className="banner banner-warn" style={{ marginBottom: 10 }}>
          Repositories unavailable: {(error.data && error.data.error) || error.message} — showing
          the last data.
        </div>
      )}
      {mapError && (
        <div className="banner banner-warn" style={{ marginBottom: 10 }}>Unmap failed: {mapError}</div>
      )}

      <table className="st-table">
        <thead>
          <tr>
            <th>Repository</th>
            <th>HEAD</th>
            <th>State</th>
            <th>Index</th>
            <th>Linear project</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No repositories cloned yet.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.name || r.origin}>
              <td>
                <span className="st-label">{r.name}</span>
                {r.origin && <div className="muted st-mono" style={{ fontSize: 11 }}>{r.origin}</div>}
                {r.error && <div className="st-tone-danger" style={{ fontSize: 11 }}>{r.error}</div>}
              </td>
              <td className="st-mono">{r.headLabel}</td>
              <td>
                <span className={`st-chip st-tone-${r.dirty ? 'danger' : 'ok'}`}>{r.dirtyText}</span>{' '}
                <span className="muted">{r.worktreesText}</span>
              </td>
              <td className={r.indexText === 'index ready' ? 'st-tone-ok' : 'st-tone-danger'}>
                {r.indexText}
              </td>
              <td>{r.project || <span className="muted">—</span>}</td>
              <td className="st-actions">
                {confirming === r.name ? (
                  <>
                    <span className="muted">unmap {r.name}?</span>
                    <button type="button" className="btn-secondary" onClick={() => unmap(r.name)}>
                      Unmap
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setConfirming(r.name)}
                    disabled={!r.project}
                    title={r.project ? 'Remove the Linear project mapping' : 'No project mapped'}
                  >
                    Unmap
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted" style={{ marginTop: 8, fontSize: 11.5 }}>
        Unmap removes the Linear project mapping only — the cloned files stay on disk.
      </div>
    </div>
  );
}
