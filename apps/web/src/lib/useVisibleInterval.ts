// Excerpted from a private production codebase for portfolio purposes; some imports/dependencies intentionally omitted.
"use client";

import { useEffect, useRef } from "react";

/**
 * Run `callback` every `intervalMs` while the tab is visible. Pause when
 * the tab is hidden, resume on visibilitychange. Cleans up on unmount.
 *
 * Used by every auto-refreshing surface (dashboard, schedule, /me/hours,
 * header sync dot) so background tabs don't burn API quota and the
 * cleanup contract is consistent.
 *
 * The callback is captured in a ref so callers don't need to memoize it —
 * the latest version is always invoked at tick time without resetting
 * the interval.
 */
export function useVisibleInterval(callback: () => void, intervalMs: number): void {
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  }, [callback]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => cbRef.current(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisible = () => (document.hidden ? stop() : start());
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
}
