// Generic poll hook (FOC-783) — one immediate fetch, then a tick every
// intervalMs; paused while the tab is hidden (a visibility→visible transition
// fetches at once); every fetch is cancellable and aborted on unmount. The
// fetcher receives an AbortSignal and returns the parsed body (or throws).
//
// A tick during an in-flight fetch is skipped — never two overlapping
// requests. On failure the error is surfaced and the last data stays mounted.
//
// deps behaves like a useEffect deps array: changing it re-arms the poll
// (immediate fetch + fresh interval). Pass [] for a screen-lifetime poll.

import { useCallback, useEffect, useRef, useState } from 'react';

export function usePoll(fetcher, intervalMs, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const inFlightRef = useRef(false);
  const abortRef = useRef(null);

  const run = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const next = await fetcherRef.current(controller.signal);
      if (controller.signal.aborted) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return;
      setError(err);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    run();
    const id = setInterval(() => {
      if (!document.hidden) run();
    }, intervalMs);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
      inFlightRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Coming back to a visible tab fetches immediately (the interval alone would
  // wait out the remaining delay).
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden && !inFlightRef.current) run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [run]);

  const refresh = useCallback(() => {
    if (!document.hidden) run();
  }, [run]);

  return { data, error, loading, refresh };
}
