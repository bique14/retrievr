/**
 * Tracks which sessions exist and whether their second peer has joined yet.
 *
 * Peer sockets themselves are never stored here - message delivery is
 * handled entirely through Bun's WebSocket pub/sub (see `sessionTopic`), so
 * this store only needs to answer "does this session exist" and "is it
 * full", plus expire sessions nobody joined in time.
 */
import { SESSION_TTL_MS } from "./protocol";

interface SessionRecord {
  guestJoined: boolean;
  expiryTimer: ReturnType<typeof setTimeout>;
}

export type JoinResult =
  | { ok: true }
  | { ok: false; code: "SESSION_NOT_FOUND" | "SESSION_FULL" };

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  create(sessionId: string): void {
    const expiryTimer = setTimeout(
      () => this.expire(sessionId),
      SESSION_TTL_MS,
    );
    this.sessions.set(sessionId, { guestJoined: false, expiryTimer });
  }

  join(sessionId: string): JoinResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, code: "SESSION_NOT_FOUND" };
    if (session.guestJoined) return { ok: false, code: "SESSION_FULL" };

    // Both peers are now present, so the "unjoined" expiry no longer applies.
    clearTimeout(session.expiryTimer);
    session.guestJoined = true;
    return { ok: true };
  }

  /** Called when either peer disconnects - a 1:1 session cannot continue. */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.expiryTimer);
    this.sessions.delete(sessionId);
  }

  private expire(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
