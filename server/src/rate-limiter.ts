/**
 * Fixed-window rate limiter for session creation, keyed by client IP.
 * Prevents a single client from exhausting server memory by spamming
 * `create-session` (blueprint-1.0.md section 20: "Rate Limit การสร้าง Session").
 */
const WINDOW_MS = 60 * 1000;
const MAX_CREATES_PER_WINDOW = 10;

interface Window {
  count: number;
  resetAt: number;
}

export class CreateSessionRateLimiter {
  private readonly windows = new Map<string, Window>();

  /** Returns true if the request is allowed, false if the client should be rejected. */
  tryConsume(clientIp: string): boolean {
    const now = Date.now();
    const window = this.windows.get(clientIp);

    if (!window || now >= window.resetAt) {
      this.windows.set(clientIp, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }

    if (window.count >= MAX_CREATES_PER_WINDOW) return false;

    window.count += 1;
    return true;
  }

  /** Periodically drops expired windows so the map does not grow unbounded. */
  sweepExpired(): void {
    const now = Date.now();
    for (const [clientIp, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(clientIp);
    }
  }
}
