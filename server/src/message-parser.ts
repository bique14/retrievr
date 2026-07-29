/**
 * Strict validation for untrusted client input. The server must never trust
 * the shape of incoming JSON, so every field is checked explicitly rather
 * than relying on TypeScript casts.
 */
import type {
  ClientMessage,
  IceCandidateData,
  SdpDescription,
  SignalPayload,
} from "./protocol";

/** Matches ids produced by `randomBytes(16).toString('base64url')`. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

function isSdpDescription(value: unknown): value is SdpDescription {
  if (typeof value !== "object" || value === null) return false;
  const { type, sdp } = value as Record<string, unknown>;
  return (
    (type === "offer" || type === "answer") &&
    typeof sdp === "string" &&
    sdp.length > 0
  );
}

function isIceCandidateData(value: unknown): value is IceCandidateData {
  if (typeof value !== "object" || value === null) return false;
  const { candidate, sdpMid, sdpMLineIndex } = value as Record<string, unknown>;
  return (
    typeof candidate === "string" &&
    (sdpMid === null || typeof sdpMid === "string") &&
    (sdpMLineIndex === null || typeof sdpMLineIndex === "number")
  );
}

function isSignalPayload(value: unknown): value is SignalPayload {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "sdp")
    return isSdpDescription((value as { description?: unknown }).description);
  if (kind === "ice-candidate") {
    return isIceCandidateData((value as { candidate?: unknown }).candidate);
  }
  return false;
}

/** Parses and validates a raw WebSocket message, returning `null` if invalid. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) return null;
  const type = (value as Record<string, unknown>).type;

  switch (type) {
    case "create-session":
      return { type: "create-session" };

    case "join-session": {
      const sessionId = (value as Record<string, unknown>).sessionId;
      return isValidSessionId(sessionId)
        ? { type: "join-session", sessionId }
        : null;
    }

    case "signal": {
      const payload = (value as Record<string, unknown>).payload;
      return isSignalPayload(payload) ? { type: "signal", payload } : null;
    }

    default:
      return null;
  }
}
