/**
 * Signaling server: pairs exactly two browser peers per session and relays
 * SDP/ICE messages between them so they can establish a direct WebRTC
 * DataChannel. It never sees file data - only see blueprint-1.0.md section 2.
 */
import { randomBytes } from "node:crypto";
import { parseClientMessage } from "./message-parser";
import {
  MAX_MESSAGE_BYTES,
  SESSION_ID_BYTES,
  sessionTopic,
  type ServerMessage,
  type SessionRole,
} from "./protocol";
import { CreateSessionRateLimiter } from "./rate-limiter";
import { SessionStore } from "./session-store";

const PORT = Number(process.env.PORT ?? 8787);

interface SocketData {
  sessionId: string | null;
  role: SessionRole | null;
  ip: string;
}

const sessions = new SessionStore();
const createSessionLimiter = new CreateSessionRateLimiter();
setInterval(() => createSessionLimiter.sweepExpired(), 60 * 1000);

function logInfo(event: string, details: Record<string, unknown> = {}): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [info] ${event}`, details);
}

function logWarn(event: string, details: Record<string, unknown> = {}): void {
  const timestamp = new Date().toISOString();
  console.warn(`[${timestamp}] [warn] ${event}`, details);
}

function send(
  ws: Bun.ServerWebSocket<SocketData>,
  message: ServerMessage,
): void {
  ws.send(JSON.stringify(message));
}

function broadcast(
  ws: Bun.ServerWebSocket<SocketData>,
  topic: string,
  message: ServerMessage,
): void {
  ws.publish(topic, JSON.stringify(message));
}

function sendError(
  ws: Bun.ServerWebSocket<SocketData>,
  code: Extract<ServerMessage, { type: "error" }>["code"],
  message: string,
): void {
  logWarn("send-error", {
    code,
    message,
    sessionId: ws.data.sessionId,
    role: ws.data.role,
    ip: ws.data.ip,
  });
  send(ws, { type: "error", code, message });
}

function generateSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString("base64url");
}

const server = Bun.serve<SocketData>({
  port: PORT,

  fetch(request, server) {
    if (new URL(request.url).pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json" },
      });
    }
    const ip = server.requestIP(request)?.address ?? "unknown";
    logInfo("http-upgrade-attempt", { ip, url: request.url });
    if (server.upgrade(request, { data: { sessionId: null, role: null, ip } }))
      return;
    logWarn("http-upgrade-failed", { ip, url: request.url });
    return new Response(
      "GoodBoyExpress signaling server: WebSocket endpoint only",
      {
        status: 400,
      },
    );
  },

  websocket: {
    maxPayloadLength: MAX_MESSAGE_BYTES,

    open(ws) {
      logInfo("ws-open", { ip: ws.data.ip });
    },

    message(ws, raw) {
      logInfo("ws-message", {
        ip: ws.data.ip,
        sessionId: ws.data.sessionId,
        role: ws.data.role,
        kind: typeof raw,
      });

      if (typeof raw !== "string") {
        sendError(ws, "INVALID_MESSAGE", "Binary frames are not supported.");
        return;
      }

      const message = parseClientMessage(raw);
      if (!message) {
        sendError(ws, "INVALID_MESSAGE", "Invalid session ID.");
        return;
      }

      switch (message.type) {
        case "create-session": {
          if (ws.data.sessionId !== null) {
            sendError(ws, "INVALID_MESSAGE", "Already in a session.");
            return;
          }

          if (!createSessionLimiter.tryConsume(ws.data.ip)) {
            sendError(
              ws,
              "RATE_LIMITED",
              "Too many sessions created. Try again shortly.",
            );
            return;
          }

          const sessionId = generateSessionId();
          sessions.create(sessionId);
          ws.data.sessionId = sessionId;
          ws.data.role = "host";
          ws.subscribe(sessionTopic(sessionId));
          logInfo("session-created", {
            sessionId,
            role: ws.data.role,
            ip: ws.data.ip,
          });
          send(ws, { type: "session-created", sessionId });
          return;
        }

        case "join-session": {
          if (ws.data.sessionId !== null) {
            sendError(ws, "INVALID_MESSAGE", "Already in a session.");
            return;
          }

          const result = sessions.join(message.sessionId);
          if (!result.ok) {
            sendError(ws, result.code, "Unable to join session.");
            return;
          }

          const topic = sessionTopic(message.sessionId);
          ws.data.sessionId = message.sessionId;
          ws.data.role = "guest";
          ws.subscribe(topic);
          logInfo("session-joined", {
            sessionId: message.sessionId,
            role: ws.data.role,
            ip: ws.data.ip,
          });
          send(ws, { type: "session-joined", role: "guest" });
          broadcast(ws, topic, { type: "peer-joined" });
          return;
        }

        case "signal": {
          if (ws.data.sessionId === null) {
            sendError(
              ws,
              "NOT_IN_SESSION",
              "Join or create a session before signaling.",
            );
            return;
          }

          broadcast(ws, sessionTopic(ws.data.sessionId), {
            type: "signal",
            payload: message.payload,
          });
          logInfo("signal-relayed", {
            sessionId: ws.data.sessionId,
            role: ws.data.role,
            ip: ws.data.ip,
            signalKind: message.payload.kind,
          });
          return;
        }
      }
    },

    close(ws, code, reason) {
      logInfo("ws-close", {
        ip: ws.data.ip,
        sessionId: ws.data.sessionId,
        role: ws.data.role,
        code,
        reason,
      });

      if (ws.data.sessionId === null) return;

      const topic = sessionTopic(ws.data.sessionId);
      sessions.close(ws.data.sessionId);
      // `ws` is already disconnected here, so publish through `server`
      // (the closure-captured instance below) rather than `ws.publish`.
      server.publish(
        topic,
        JSON.stringify({ type: "peer-left" } satisfies ServerMessage),
      );
      logInfo("session-closed", { sessionId: ws.data.sessionId });
    },
  },
});

logInfo("server-started", { url: `ws://localhost:${server.port}` });
