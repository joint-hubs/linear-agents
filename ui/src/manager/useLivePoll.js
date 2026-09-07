// Live snapshot polling for the Manager overlay (FOC-225 slice 2).
//
// Behavior contract (fenix-manager.md §5):
//   - one immediate fetch when enabled, then a tick every intervalMs (5 s)
//     while enabled AND tick (Setup mode seeds one snapshot for the History
//     tab and pauses the ticking; Live mode ticks);
//   - never two overlapping requests — a tick during an in-flight fetch is
//     skipped (shouldPoll);
//   - on failure: keep the LAST-KNOWN snapshot (the overlay freezes, it never
//     blanks), surface the error, and back off ×2 per consecutive failure
//     (cap 60 s); success resets the backoff;
//   - paused while the tab is hidden; a visibility→visible transition and a
//     re-enable fetch immediately;
//   - every fetch is cancellable (AbortController) and aborted on unmount.
//
// The scheduling decisions live in manager/live.js as pure functions so the
// plain-node tests can pin them; this hook is glue.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getManagerSnapshot } from '../api';
import { POLL_BASE_MS, nextPollIntervalMs, shouldPoll } from './live';

export default function useLivePoll({ enabled = false, tick = enabled, intervalMs = POLL_BASE_MS, fetcher = getManagerSnapshot } = {}) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [lastSuccessAt, setLastSuccessAt] = useState(null);
  const [inFlight, setInFlight] = useState(false);

  const inFlightRef = useRef(false);
  const backoffRef = useRef(intervalMs);
  const abortRef = useRef(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;

  const runFetch = useCallback(async () => {
    if (inFlightRef.current) return; // skip — never overlap
    inFlightRef.current = true;
    setInFlight(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const next = await fetcher(controller.signal);
      if (controller.signal.aborted) return;
      setSnapshot(next);
      setError(null);
      setLastSuccessAt(new Date());
      backoffRef.current = intervalRef.current; // success resets backoff
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return;
      setError(err); // last-known snapshot stays mounted
      backoffRef.current = nextPollIntervalMs(backoffRef.current, { base: intervalRef.current });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      inFlightRef.current = false;
      setInFlight(false);
    }
  }, [fetcher]);

  // Activate/deactivate: immediate fetch on enable; abort + quiet on disable.
  useEffect(() => {
    if (!enabled) return undefined;
    runFetch();
    return () => {
      abortRef.current?.abort();
      inFlightRef.current = false;
    };
  }, [enabled, runFetch]);

  // Tick loop. The interval is re-created whenever the backoff changes —
  // backoffRef alone cannot reschedule a setInterval, so backoffMs is state
  // kept in sync with the ref here. tick=false (Setup) seeds one snapshot
  // and pauses the repetition.
  const [backoffMs, setBackoffMs] = useState(intervalMs);
  useEffect(() => {
    setBackoffMs(backoffRef.current);
  }, [lastSuccessAt, error]);
  useEffect(() => {
    if (!enabled || !tick) return undefined;
    const id = setInterval(() => {
      if (shouldPoll({ enabled: enabledRef.current, inFlight: inFlightRef.current, hidden: document.hidden })) {
        runFetch();
      }
    }, backoffMs);
    return () => clearInterval(id);
  }, [enabled, tick, backoffMs, runFetch]);

  // Resume on refocus: a hidden tab stops ticking; becoming visible again
  // fetches at once (if nothing is in flight). Only while ticking.
  useEffect(() => {
    if (!enabled || !tick) return undefined;
    const onVisible = () => {
      if (!document.hidden && shouldPoll({ enabled: true, inFlight: inFlightRef.current, hidden: false })) {
        runFetch();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, tick, runFetch]);

  // Entering Live mode fetches immediately (the 5 s tick would otherwise show
  // Setup-era data). Transition-guarded so mount doesn't double-fetch.
  const tickRef = useRef(tick);
  useEffect(() => {
    if (tick && !tickRef.current) {
      if (shouldPoll({ enabled: true, inFlight: inFlightRef.current, hidden: document.hidden })) {
        runFetch();
      }
    }
    tickRef.current = tick;
  }, [tick, runFetch]);

  // Manual refresh (Retry button) — same skip rules as a tick.
  const refresh = useCallback(() => {
    if (shouldPoll({ enabled: enabledRef.current, inFlight: inFlightRef.current, hidden: document.hidden })) {
      runFetch();
    }
  }, [runFetch]);

  return { snapshot, error, lastSuccessAt, inFlight, refresh };
}
