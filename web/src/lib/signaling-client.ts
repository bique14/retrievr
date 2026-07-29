/**
 * Thin typed wrapper around a signaling WebSocket connection. Handles JSON
 * (de)serialization only - connection orchestration lives in
 * `SessionConnection`.
 */
import type { ClientMessage, ServerMessage } from "../protocol";

export class SignalingClient {
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  onOpen(handler: () => void): void {
    this.socket.addEventListener("open", handler);
  }

  onMessage(handler: (message: ServerMessage) => void): void {
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;

      try {
        handler(JSON.parse(event.data) as ServerMessage);
      } catch {
        // Ignore malformed frames rather than crashing the session.
      }
    });
  }

  onClose(handler: (event: CloseEvent) => void): void {
    this.socket.addEventListener("close", handler);
  }

  close(): void {
    this.socket.close();
  }
}
