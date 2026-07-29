/**
 * Orchestrates a single 1:1 transfer session: connects to the signaling
 * server, exchanges SDP/ICE through it, and brings up a WebRTC DataChannel.
 * Framework-agnostic - see `useSessionConnection` for the React binding.
 */
import type {
  ClientMessage,
  ServerMessage,
  SessionRole,
  SignalPayload,
} from "../protocol";
import { SignalingClient } from "./signaling-client";
import { WebrtcConnection } from "./webrtc-connection";
import { logEvent } from "./diagnostics";

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ?? "ws://localhost:8787";
const DATA_CHANNEL_LABEL = "retrievr-transfer";

export type ConnectionStatus =
  | "idle"
  | "connecting-signaling"
  | "waiting-for-peer"
  | "connecting-webrtc"
  | "connected"
  | "disconnected"
  | "error";

export interface SessionConnectionState {
  status: ConnectionStatus;
  sessionId: string | null;
  role: SessionRole | null;
  errorMessage: string | null;
  dataChannel: RTCDataChannel | null;
}

export type SessionConnectionListener = (state: SessionConnectionState) => void;

export const INITIAL_SESSION_CONNECTION_STATE: SessionConnectionState = {
  status: "idle",
  sessionId: null,
  role: null,
  errorMessage: null,
  dataChannel: null,
};

export class SessionConnection {
  private signaling: SignalingClient | null = null;
  private webrtc: WebrtcConnection | null = null;
  private state: SessionConnectionState = INITIAL_SESSION_CONNECTION_STATE;
  private readonly listeners = new Set<SessionConnectionListener>();
  private suppressSignalingClose = false;

  private log(event: string, details: Record<string, unknown> = {}): void {
    // See webrtc-connection.ts for the matching ICE-level diagnostics - both
    // logs together let us pinpoint whether a slow connect is stuck waiting
    // on signaling (WebSocket) or on ICE/STUN when diagnosing real-network
    // reports of a slow accept/decline popup.
    logEvent("session", event, details);
  }

  /** Subscribes to state changes, immediately replaying the current state. */
  subscribe(listener: SessionConnectionListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  createSession(): void {
    this.teardown();
    this.setState({ status: "connecting-signaling" });
    this.connectSignaling({ type: "create-session" });
  }

  joinSession(sessionId: string): void {
    this.teardown();
    this.setState({ status: "connecting-signaling" });
    this.connectSignaling({ type: "join-session", sessionId });
  }

  close(): void {
    this.teardown();
    this.setState(INITIAL_SESSION_CONNECTION_STATE);
  }

  private connectSignaling(initialMessage: ClientMessage): void {
    this.log("signaling-connect-start", { url: SIGNALING_URL });
    const signaling = new SignalingClient(SIGNALING_URL);
    this.signaling = signaling;

    signaling.onOpen(() => {
      this.log("signaling-open");
      signaling.send(initialMessage);
    });
    signaling.onMessage((message) => {
      this.log("signaling-message", { type: message.type });
      this.handleServerMessage(message);
    });
    signaling.onClose(() => {
      this.log("signaling-close");
      if (this.suppressSignalingClose) return;
      this.signaling = null;
      // `close()` resets to INITIAL_SESSION_CONNECTION_STATE (idle). If the
      // socket close event arrives slightly later, do not overwrite that
      // intentional reset with "disconnected".
      if (this.state.status === "idle") return;
      if (this.state.status === "error") return;
      if (this.state.dataChannel?.readyState === "open") return;
      this.setState({ status: "disconnected" });
    });
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "session-created": {
        this.setState({
          sessionId: message.sessionId,
          role: "host",
          status: "waiting-for-peer",
          errorMessage: null,
        });
        const webrtc = this.setupWebrtc();
        this.attachDataChannel(webrtc.createDataChannel(DATA_CHANNEL_LABEL));
        return;
      }

      case "session-joined":
        this.setState({
          role: "guest",
          status: "connecting-webrtc",
          errorMessage: null,
        });
        this.setupWebrtc();
        return;

      case "peer-joined":
        this.log("peer-joined");
        this.setState({ status: "connecting-webrtc" });
        void this.sendOffer();
        return;

      case "signal":
        void this.handleSignal(message.payload);
        return;

      case "peer-left":
        this.setState({ status: "disconnected" });
        return;

      case "error":
        this.setState({ status: "error", errorMessage: message.message });
        return;
    }
  }

  private setupWebrtc(): WebrtcConnection {
    const webrtc = new WebrtcConnection({
      onIceCandidate: (candidate) => {
        this.signaling?.send({
          type: "signal",
          payload: { kind: "ice-candidate", candidate },
        });
      },
      onDataChannel: (channel) => this.attachDataChannel(channel),
      onConnectionStateChange: (connectionState) => {
        if (connectionState === "failed" || connectionState === "closed") {
          this.setState({ status: "disconnected" });
        }
      },
    });
    this.webrtc = webrtc;
    return webrtc;
  }

  private attachDataChannel(channel: RTCDataChannel): void {
    channel.addEventListener("open", () => {
      this.log("datachannel-open");
      this.setState({ status: "connected", dataChannel: channel });
    });
    channel.addEventListener("close", () => {
      this.log("datachannel-close");
      this.setState({ status: "disconnected", dataChannel: null });
    });
  }

  private async sendOffer(): Promise<void> {
    if (!this.webrtc || !this.signaling) return;
    const description = await this.webrtc.createOffer();
    this.log("offer-sent");
    this.signaling.send({
      type: "signal",
      payload: { kind: "sdp", description },
    });
  }

  private async handleSignal(payload: SignalPayload): Promise<void> {
    if (!this.webrtc || !this.signaling) return;

    if (payload.kind === "ice-candidate") {
      await this.webrtc.addRemoteIceCandidate(payload.candidate);
      return;
    }

    if (payload.description.type === "offer") {
      const answer = await this.webrtc.createAnswer(payload.description);
      this.signaling.send({
        type: "signal",
        payload: { kind: "sdp", description: answer },
      });
      return;
    }

    await this.webrtc.acceptAnswer(payload.description);
  }

  private teardown(): void {
    this.state.dataChannel?.close();
    this.webrtc?.close();
    this.webrtc = null;

    this.suppressSignalingClose = true;
    this.signaling?.close();
    this.suppressSignalingClose = false;
    this.signaling = null;
  }

  private setState(patch: Partial<SessionConnectionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
