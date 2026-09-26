import { useState, useEffect, useCallback } from 'react';
import { getAnalysisPanel } from '../../api';

// One analysis panel's lifecycle. Fetches on mount and whenever filters/name
// change, aborting the previous request (AbortController) so a stale response
// can never overwrite a newer one. The thrown Error is stored as-is, so it
// keeps .status/.code from apiFetch — panels switch on error.code
// (cache_building → friendly "being built" copy).
//
// reloadKey: bump it to force a refetch with identical filters (used by the
// Analysis screen after a cache rebuild completes).
//
// Returns { data, caveats, echoedFilters, loading, error, reload } —
// echoedFilters is the server's own filters echo, for honest display.
export function useAnalysisPanel(name, filters, reloadKey = 0) {
  const [state, setState] = useState({
    data: null, caveats: [], echoedFilters: null, loading: true, error: null,
  });
  const [tick, setTick] = useState(0);
  // Stable identity for the effect: filters is a fresh object per render in
  // the parent, so compare by value, not reference.
  const filtersKey = JSON.stringify(filters || {});

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    getAnalysisPanel(name, JSON.parse(filtersKey), controller.signal)
      .then((res) => {
        if (!active) return;
        setState({
          data: res?.data ?? null,
          caveats: Array.isArray(res?.caveats) ? res.caveats : [],
          echoedFilters: res?.filters ?? null,
          loading: false,
          error: null,
        });
      })
      .catch((err) => {
        // Abort from a superseded request is not an error state.
        if (!active || controller.signal.aborted) return;
        setState({ data: null, caveats: [], echoedFilters: null, loading: false, error: err });
      });
    return () => { active = false; controller.abort(); };
  }, [name, filtersKey, tick, reloadKey]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
