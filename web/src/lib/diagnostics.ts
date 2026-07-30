/**
 * Tiny shared console logger used only to diagnose reports of long delays
 * between picking a file and the accept/decline UI appearing on either
 * side. All scopes share one timeline (`performance.timeOrigin`) so logs
 * from different modules/tabs can be lined up by elapsed time. Console-only
 * by design - no UI surface, safe to leave in place permanently.
 */
export function logEvent(
  scope: string,
  event: string,
  details: Record<string, unknown> = {},
): void {
  const elapsedMs = Math.round(performance.now());
  const wallClockMs = Date.now();
  console.info(`[goodboyexpress:${scope}] +${elapsedMs}ms ${event}`, {
    wallClockMs,
    wallClockIso: new Date(wallClockMs).toISOString(),
    ...details,
  });
}
