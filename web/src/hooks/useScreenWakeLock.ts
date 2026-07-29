/**
 * Requests a Screen Wake Lock while `active` is true, so the device display
 * doesn't sleep mid-transfer (large files can take a long time, and a
 * sleeping/locked screen throttles or suspends the tab in most browsers -
 * see blueprint-1.0.md and docs/large-file-support-plan.md).
 *
 * Best-effort only: the Wake Lock API is Chromium-only today, requests can
 * be rejected by the browser (e.g. low battery), and the OS/browser always
 * releases the lock automatically when the tab is hidden. This hook
 * re-acquires the lock automatically once the tab becomes visible again
 * while `active` is still true, but it never blocks or throws if the API
 * is unavailable or a request fails.
 */
import { useEffect, useRef, useState } from "react";

export function useScreenWakeLock(active: boolean): { isActive: boolean } {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    if (!active) return;
    if (!navigator.wakeLock) return;

    let cancelled = false;

    async function acquire(): Promise<void> {
      try {
        const sentinel = await navigator.wakeLock!.request("screen");
        if (cancelled) {
          void sentinel.release();
          return;
        }
        sentinelRef.current = sentinel;
        setIsActive(true);
        sentinel.onrelease = () => {
          setIsActive(false);
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
        };
      } catch {
        // Browser declined the request (e.g. low battery, unsupported
        // context); the transfer still proceeds without the wake lock.
        setIsActive(false);
      }
    }

    function handleVisibilityChange(): void {
      // The OS/browser force-releases the lock when the tab is hidden, so
      // re-request it once the tab is visible again while still active.
      if (document.visibilityState === "visible" && !sentinelRef.current) {
        void acquire();
      }
    }

    void acquire();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      setIsActive(false);
      if (sentinel) void sentinel.release();
    };
  }, [active]);

  return { isActive };
}
