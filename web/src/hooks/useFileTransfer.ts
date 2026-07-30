/**
 * React binding that wires `sendFiles`/`FileReceiver` to a given
 * `RTCDataChannel`. Exposes send/receive progress for the file currently in
 * flight, a batch offer awaiting accept/decline, a running history of
 * completed transfers, and any transfer-level error so `App.tsx` can
 * render them.
 */
import { useEffect, useRef, useState } from "react";
import {
  FileReceiver,
  type BatchOfferInfo,
  type FileReceiveProgress,
  type ReceivingFileInfo,
} from "../lib/file-receiver";
import {
  sendFiles,
  type BatchSendItem,
  type FileSendProgress,
  TransferCancelledError,
  TransferDeclinedError,
  TransferDecisionTimeoutError,
} from "../lib/file-sender";
import { logEvent } from "../lib/diagnostics";

export interface TransferHistoryEntry {
  id: string;
  direction: "sent" | "received";
  name: string;
  relativePath: string;
  size: number;
  status: "complete" | "failed";
}

interface SendingFileState {
  name: string;
  relativePath: string;
  fileIndex: number;
  fileCount: number;
  progress: FileSendProgress;
}

interface ReceivingFileState extends ReceivingFileInfo {
  progress: FileReceiveProgress;
}

export interface OutgoingOfferState {
  fileCount: number;
  totalBytes: number;
  stage: "preparing" | "waiting-for-accept";
}

export interface TransferTelemetry {
  bytesPerSecond: number;
  etaSeconds: number | null;
}

interface OutgoingRuntimeControls {
  paused: boolean;
  cancelled: boolean;
  pauseWaiters: Array<() => void>;
}

function toTelemetry(
  startedAt: number | null,
  bytesDone: number,
  totalBytes: number,
): TransferTelemetry | null {
  if (startedAt === null) return null;
  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
  const bytesPerSecond = bytesDone / elapsedSeconds;
  const remainingBytes = Math.max(totalBytes - bytesDone, 0);
  const etaSeconds =
    bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null;
  return { bytesPerSecond, etaSeconds };
}

let nextHistoryId = 0;

export function useFileTransfer(dataChannel: RTCDataChannel | null) {
  const [sendingFile, setSendingFile] = useState<SendingFileState | null>(null);
  const [outgoingOffer, setOutgoingOffer] = useState<OutgoingOfferState | null>(
    null,
  );
  const [incomingOffer, setIncomingOffer] = useState<BatchOfferInfo | null>(
    null,
  );
  const [receivingFile, setReceivingFile] = useState<ReceivingFileState | null>(
    null,
  );
  const [isOutgoingPaused, setIsOutgoingPaused] = useState(false);
  const [isIncomingPaused, setIsIncomingPaused] = useState(false);
  const [sendingTelemetry, setSendingTelemetry] =
    useState<TransferTelemetry | null>(null);
  const [receivingTelemetry, setReceivingTelemetry] =
    useState<TransferTelemetry | null>(null);
  const [history, setHistory] = useState<TransferHistoryEntry[]>([]);
  const [transferError, setTransferError] = useState<string | null>(null);
  const receiverRef = useRef<FileReceiver | null>(null);
  const outgoingControlsRef = useRef<OutgoingRuntimeControls>({
    paused: false,
    cancelled: false,
    pauseWaiters: [],
  });
  const sendingStartedAtRef = useRef<number | null>(null);
  const receivingStartedAtRef = useRef<number | null>(null);

  function addHistoryEntry(entry: Omit<TransferHistoryEntry, "id">): void {
    nextHistoryId += 1;
    setHistory((previous) => [
      ...previous,
      { ...entry, id: String(nextHistoryId) },
    ]);
  }

  useEffect(() => {
    if (!dataChannel) return;

    // A fresh channel means a fresh session (e.g. the peer left and this
    // side rejoined) — don't carry over a stale error like "Sender
    // cancelled transfer." from the previous connection.
    setTransferError(null);
    setIsIncomingPaused(false);

    const receiver = new FileReceiver(dataChannel, {
      onOffer: setIncomingOffer,
      onFileStart: (info) => {
        receivingStartedAtRef.current = Date.now();
        setReceivingFile({
          ...info,
          progress: { bytesReceived: 0, totalBytes: info.size },
        });
        setReceivingTelemetry({ bytesPerSecond: 0, etaSeconds: null });
      },
      onProgress: (progress) => {
        const telemetry = toTelemetry(
          receivingStartedAtRef.current,
          progress.bytesReceived,
          progress.totalBytes,
        );
        if (telemetry) setReceivingTelemetry(telemetry);

        setReceivingFile((current) =>
          current ? { ...current, progress } : current,
        );
      },
      onFileComplete: (info) => {
        addHistoryEntry({
          direction: "received",
          name: info.name,
          relativePath: info.relativePath,
          size: info.size,
          status: "complete",
        });
        setReceivingFile(null);
        setReceivingTelemetry(null);
        receivingStartedAtRef.current = null;
      },
      onBatchComplete: () => {
        setIncomingOffer(null);
      },
      onError: (message) => {
        setTransferError(message);
        // Clear any in-progress receiver UI (offer/progress/telemetry) so a
        // sender-side cancel or error doesn't leave the receiver's panel
        // stuck showing a transfer that will never complete.
        setIncomingOffer(null);
        setReceivingFile(null);
        setReceivingTelemetry(null);
        receivingStartedAtRef.current = null;
      },
      onPauseChange: setIsIncomingPaused,
    });
    receiverRef.current = receiver;

    return () => {
      receiver.dispose();
      receiverRef.current = null;
    };
  }, [dataChannel]);

  async function send(items: BatchSendItem[]): Promise<void> {
    if (!dataChannel || items.length === 0) return;
    logEvent("send", "send-called", {
      itemCount: items.length,
      channelState: dataChannel.readyState,
    });
    setTransferError(null);
    setSendingTelemetry(null);

    outgoingControlsRef.current = {
      paused: false,
      cancelled: false,
      pauseWaiters: [],
    };
    setIsOutgoingPaused(false);

    const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
    setOutgoingOffer({
      fileCount: items.length,
      totalBytes,
      stage: "preparing",
    });

    // Yield one microtask so the UI can paint "Preparing transfer..." without
    // depending on requestAnimationFrame (which can be heavily throttled or
    // paused when the tab isn't foregrounded).
    await Promise.resolve();
    logEvent("send", "preparing-state-painted");

    try {
      await sendFiles(
        items,
        dataChannel,
        {
          onBatchPreparing: (info) => {
            logEvent("send", "batch-preparing", info);
            setOutgoingOffer({ ...info, stage: "preparing" });
          },
          onBatchOfferSent: (info) => {
            logEvent("send", "batch-offer-sent", info);
            setOutgoingOffer({ ...info, stage: "waiting-for-accept" });
          },
          onFileStart: (item, fileIndex, fileCount) => {
            if (fileIndex === 0) logEvent("send", "batch-accepted");
            setOutgoingOffer(null);
            sendingStartedAtRef.current = Date.now();
            setSendingTelemetry({ bytesPerSecond: 0, etaSeconds: null });
            setSendingFile({
              name: item.file.name,
              relativePath: item.relativePath,
              fileIndex,
              fileCount,
              progress: { bytesSent: 0, totalBytes: item.file.size },
            });
          },
          onFileProgress: (progress) => {
            const telemetry = toTelemetry(
              sendingStartedAtRef.current,
              progress.bytesSent,
              progress.totalBytes,
            );
            if (telemetry) setSendingTelemetry(telemetry);

            setSendingFile((current) =>
              current ? { ...current, progress } : current,
            );
          },
          onFileComplete: (item) => {
            addHistoryEntry({
              direction: "sent",
              name: item.file.name,
              relativePath: item.relativePath,
              size: item.file.size,
              status: "complete",
            });
          },
        },
        {
          waitIfPaused: async () => {
            if (!outgoingControlsRef.current.paused) return;
            await new Promise<void>((resolve) => {
              outgoingControlsRef.current.pauseWaiters.push(resolve);
            });
          },
          isCancelled: () => outgoingControlsRef.current.cancelled,
        },
      );
    } catch (error) {
      logEvent("send", "send-failed", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      // Notify the receiver so it can clear its pending UI (accept/decline
      // popup or any in-progress receive panel) for sender-side failures that
      // the receiver would not already know about locally. Do not echo a
      // decline back to the receiver, or it overwrites the receiver's own
      // more accurate local error (for example, unsupported folder picker on
      // iPhone/iPad browsers).
      if (
        dataChannel.readyState === "open" &&
        !(error instanceof TransferDeclinedError)
      ) {
        const msg =
          error instanceof TransferCancelledError
            ? "Sender cancelled transfer."
            : error instanceof TransferDecisionTimeoutError
              ? "Transfer offer expired — the receiver did not respond in time."
              : "Sender encountered an error.";
        dataChannel.send(
          JSON.stringify({ type: "transfer-error", message: msg }),
        );
      }

      setTransferError(
        error instanceof Error ? error.message : "Failed to send files.",
      );
    } finally {
      outgoingControlsRef.current.cancelled = true;
      for (const wake of outgoingControlsRef.current.pauseWaiters.splice(0)) {
        wake();
      }
      setIsOutgoingPaused(false);
      setOutgoingOffer(null);
      setSendingFile(null);
      setSendingTelemetry(null);
      sendingStartedAtRef.current = null;
    }
  }

  /** Best-effort notification so the receiver's UI can mirror pause state. */
  function notifyPauseState(paused: boolean): void {
    if (dataChannel?.readyState !== "open") return;
    try {
      dataChannel.send(
        JSON.stringify({
          type: paused ? "transfer-paused" : "transfer-resumed",
        }),
      );
    } catch {
      // The channel may be closing mid-send; the receiver will find out
      // via the channel's own close handling instead.
    }
  }

  function pauseOutgoing(): void {
    if (!sendingFile) return;
    outgoingControlsRef.current.paused = true;
    setIsOutgoingPaused(true);
    notifyPauseState(true);
  }

  function resumeOutgoing(): void {
    outgoingControlsRef.current.paused = false;
    setIsOutgoingPaused(false);
    for (const wake of outgoingControlsRef.current.pauseWaiters.splice(0)) {
      wake();
    }
    notifyPauseState(false);
  }

  function cancelOutgoing(): void {
    outgoingControlsRef.current.cancelled = true;
    for (const wake of outgoingControlsRef.current.pauseWaiters.splice(0)) {
      wake();
    }
  }

  function clearTransferError(): void {
    setTransferError(null);
  }

  function acceptIncoming(): void {
    setIncomingOffer(null);
    void receiverRef.current?.accept();
  }

  function declineIncoming(): void {
    receiverRef.current?.decline();
    setIncomingOffer(null);
  }

  return {
    send,
    sendingFile,
    outgoingOffer,
    isOutgoingPaused,
    isIncomingPaused,
    sendingTelemetry,
    receivingTelemetry,
    pauseOutgoing,
    resumeOutgoing,
    cancelOutgoing,
    clearTransferError,
    incomingOffer,
    acceptIncoming,
    declineIncoming,
    receivingFile,
    history,
    transferError,
  };
}
