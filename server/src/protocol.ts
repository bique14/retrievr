/**
 * Signaling protocol shared between the web client and the signaling server.
 *
 * The server only ever relays these messages between exactly two peers - it
 * never inspects file data. Kept in sync manually with `web/src/protocol.ts`
 * (no shared package exists yet; see blueprint-1.0.md section 24 for the
 * longer-term project structure).
 */

/** 128-bit session id, so it cannot be brute-forced or guessed. */
export const SESSION_ID_BYTES = 16;

/** A created session expires if no second peer joins within this window. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** Hard cap on a single signaling message, to bound memory per connection. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

export type SessionRole = 'host' | 'guest';

/**
 * SDP and ICE payloads are re-declared here (instead of importing the DOM
 * `RTCSessionDescriptionInit` / `RTCIceCandidateInit` types) so the server
 * has no dependency on `lib.dom`. The shapes are structurally compatible
 * with their DOM counterparts, so the browser client can pass them through
 * without conversion.
 */
export interface SdpDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface IceCandidateData {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type SignalPayload =
  | { kind: 'sdp'; description: SdpDescription }
  | { kind: 'ice-candidate'; candidate: IceCandidateData };

export type ClientMessage =
  | { type: 'create-session' }
  | { type: 'join-session'; sessionId: string }
  | { type: 'signal'; payload: SignalPayload };

export type ErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_FULL'
  | 'NOT_IN_SESSION'
  | 'RATE_LIMITED'
  | 'INVALID_MESSAGE';

export type ServerMessage =
  | { type: 'session-created'; sessionId: string }
  | { type: 'session-joined'; role: SessionRole }
  | { type: 'peer-joined' }
  | { type: 'signal'; payload: SignalPayload }
  | { type: 'peer-left' }
  | { type: 'error'; code: ErrorCode; message: string };

/** Derives the Bun pub/sub topic name for a given session id. */
export function sessionTopic(sessionId: string): string {
  return `session:${sessionId}`;
}
