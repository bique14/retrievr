/**
 * Wraps a single `RTCPeerConnection` configured for STUN-only connectivity
 * (no TURN relay - see blueprint-1.0.md section 21 for the trade-off this
 * implies for peers behind restrictive NATs).
 */
import type { IceCandidateData, SdpDescription } from "../protocol";
import { logEvent } from "./diagnostics";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export interface WebrtcConnectionCallbacks {
  onIceCandidate(candidate: IceCandidateData): void;
  onDataChannel(channel: RTCDataChannel): void;
  onConnectionStateChange(state: RTCPeerConnectionState): void;
}

/** Best-effort candidate type extraction (host/srflx/prflx/relay) for diagnostics only. */
function candidateType(candidate: string): string {
  const match = /typ (\w+)/.exec(candidate);
  return match?.[1] ?? "unknown";
}

export class WebrtcConnection {
  private readonly peer: RTCPeerConnection;
  private remoteDescriptionSet = false;
  /**
   * ICE candidates can arrive over signaling before `setRemoteDescription`
   * has completed (common when the other peer is a phone whose SDP answer
   * is slower than its candidate trickle). Calling `addIceCandidate` in
   * that window throws and silently loses the candidate, so they are
   * queued here and flushed once the remote description is in place.
   */
  private readonly pendingRemoteCandidates: IceCandidateData[] = [];

  private log(event: string, details: Record<string, unknown> = {}): void {
    // Kept as plain console output (no UI surface) so it's cheap and always
    // available in devtools when diagnosing real-network connection delays -
    // see blueprint-1.0.md / repo memory notes on the "10-30s before
    // accept/decline" investigation. Shares the page-load timeline with
    // session-connection.ts/useFileTransfer.ts/file-receiver.ts logs so they
    // can be lined up by elapsed time.
    logEvent("webrtc", event, details);
  }

  constructor(callbacks: WebrtcConnectionCallbacks) {
    this.peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.log("peerconnection-created");

    this.peer.addEventListener("icecandidate", (event) => {
      if (!event.candidate) {
        this.log("ice-gathering-finished (null candidate)");
        return;
      }
      this.log("ice-candidate", {
        type: candidateType(event.candidate.candidate),
        protocol: event.candidate.protocol,
      });
      callbacks.onIceCandidate({
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
      });
    });

    this.peer.addEventListener("icegatheringstatechange", () => {
      this.log("ice-gathering-state", { state: this.peer.iceGatheringState });
    });

    this.peer.addEventListener("iceconnectionstatechange", () => {
      this.log("ice-connection-state", { state: this.peer.iceConnectionState });
    });

    this.peer.addEventListener("datachannel", (event) => {
      this.log("datachannel-received");
      callbacks.onDataChannel(event.channel);
    });

    this.peer.addEventListener("connectionstatechange", () => {
      this.log("connection-state", { state: this.peer.connectionState });
      callbacks.onConnectionStateChange(this.peer.connectionState);
    });
  }

  createDataChannel(label: string): RTCDataChannel {
    return this.peer.createDataChannel(label);
  }

  async createOffer(): Promise<SdpDescription> {
    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    return { type: "offer", sdp: offer.sdp ?? "" };
  }

  async createAnswer(remoteOffer: SdpDescription): Promise<SdpDescription> {
    await this.peer.setRemoteDescription(remoteOffer);
    await this.drainPendingCandidates();
    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    return { type: "answer", sdp: answer.sdp ?? "" };
  }

  async acceptAnswer(remoteAnswer: SdpDescription): Promise<void> {
    await this.peer.setRemoteDescription(remoteAnswer);
    await this.drainPendingCandidates();
  }

  async addRemoteIceCandidate(candidate: IceCandidateData): Promise<void> {
    if (!this.remoteDescriptionSet) {
      this.pendingRemoteCandidates.push(candidate);
      this.log("ice-candidate-queued", {
        queued: this.pendingRemoteCandidates.length,
      });
      return;
    }
    await this.peer.addIceCandidate(candidate);
  }

  private async drainPendingCandidates(): Promise<void> {
    this.remoteDescriptionSet = true;
    const queued = this.pendingRemoteCandidates.splice(0);
    if (queued.length > 0) {
      this.log("ice-candidate-queue-drain", { count: queued.length });
    }
    for (const candidate of queued) {
      await this.peer.addIceCandidate(candidate);
    }
  }

  close(): void {
    this.peer.close();
  }
}
