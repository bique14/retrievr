/**
 * Session create/join UI plus batch file transfer: pick files or an entire
 * folder, send them over the WebRTC DataChannel, and track a running
 * history of what has been sent and received.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import QRCode from "qrcode";
import goldenRetrieverSprite from "./assets/golden-retriever-sprite.svg";
import { useFileTransfer } from "./hooks/useFileTransfer";
import { useQrScanner } from "./hooks/useQrScanner";
import { useScreenWakeLock } from "./hooks/useScreenWakeLock";
import { useSessionConnection } from "./hooks/useSessionConnection";
import type { BatchSendItem } from "./lib/file-sender";
import { formatBytes } from "./lib/format-bytes";
import { logEvent } from "./lib/diagnostics";
import type { ConnectionStatus } from "./lib/session-connection";
import "./App.css";

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  idle: "Idle",
  "connecting-signaling": "Connecting to signaling server…",
  "waiting-for-peer": "Waiting for the other device to join…",
  "connecting-webrtc": "Establishing peer-to-peer connection…",
  connected: "Connected",
  disconnected: "Disconnected",
  error: "Something went wrong",
};

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function toBatchItems(files: FileList): BatchSendItem[] {
  return Array.from(files).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

function normalizeScannedSessionId(raw: string): string | null {
  const trimmed = raw.trim();
  return SESSION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function App() {
  const {
    status,
    sessionId,
    role,
    errorMessage,
    dataChannel,
    createSession,
    joinSession,
    close,
  } = useSessionConnection();
  const {
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
  } = useFileTransfer(dataChannel);
  const [joinInput, setJoinInput] = useState("");
  const [joinedSessionId, setJoinedSessionId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const pickerTimeoutRef = useRef<number | null>(null);
  const pickerReturnCheckRef = useRef<number | null>(null);
  const isSending = sendingFile !== null || outgoingOffer !== null;
  const activeTransfer = sendingFile ?? receivingFile;
  const displaySessionId =
    sessionId ?? (role === "guest" ? joinedSessionId : null);
  const channelState = dataChannel?.readyState ?? "pending";
  const isTransferInFlight =
    outgoingOffer !== null || sendingFile !== null || receivingFile !== null;
  const { isActive: wakeLockActive } = useScreenWakeLock(isTransferInFlight);
  const [offerElapsedSeconds, setOfferElapsedSeconds] = useState(0);
  const [pickerPending, setPickerPending] = useState<{
    kind: "files";
    startedAt: number;
  } | null>(null);
  const [pickerElapsedSeconds, setPickerElapsedSeconds] = useState(0);
  const isUploadBusy = isSending || pickerPending !== null;

  // Dark mode — persisted to localStorage
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const savedTheme =
        localStorage.getItem("goodboyexpress-theme") ??
        localStorage.getItem("retrievr-theme");
      return savedTheme === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });

  // Toast notifications
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const prevStatusRef = useRef<typeof status>(status);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [scanPanelOpen, setScanPanelOpen] = useState(false);
  const [scanJoinPending, setScanJoinPending] = useState(false);
  const [scanJoinCandidateId, setScanJoinCandidateId] = useState<string | null>(
    null,
  );
  const scanDedupRef = useRef<{
    sessionId: string;
    timestampMs: number;
  } | null>(null);
  const lastHistoryToastIdRef = useRef<string | null>(null);

  const showToast = useCallback((message: string, durationMs = 5000): void => {
    if (toastTimerRef.current !== null)
      window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => setToast(null), durationMs);
  }, []);

  const {
    videoRef: scanVideoRef,
    isActive: scanActive,
    errorMessage: scanError,
    start: startScan,
    stop: stopScan,
  } = useQrScanner({
    onDecode: (text) => {
      const scannedSessionId = normalizeScannedSessionId(text);

      if (!scannedSessionId) {
        logEvent("ui", "qr-scan-invalid", { reason: "format" });
        showToast("Invalid QR code for this app.");
        return;
      }

      if (status !== "idle") {
        logEvent("ui", "qr-scan-invalid", {
          reason: "blocked-by-state",
          status,
        });
        showToast("Finish the current connection flow before scanning again.");
        return;
      }

      const now = Date.now();
      const previous = scanDedupRef.current;
      if (
        previous &&
        previous.sessionId === scannedSessionId &&
        now - previous.timestampMs < 4000
      ) {
        logEvent("ui", "qr-scan-invalid", { reason: "duplicate" });
        return;
      }

      scanDedupRef.current = { sessionId: scannedSessionId, timestampMs: now };
      logEvent("ui", "qr-scan-success", { sessionId: scannedSessionId });

      stopScan();
      setScanPanelOpen(false);
      setJoinInput(scannedSessionId);
      setScanJoinCandidateId(scannedSessionId);
      showToast("QR scanned. Confirm to join this session.");
    },
  });

  function clearPickerPending(reason: string): void {
    if (pickerTimeoutRef.current !== null) {
      window.clearTimeout(pickerTimeoutRef.current);
      pickerTimeoutRef.current = null;
    }
    if (pickerReturnCheckRef.current !== null) {
      window.clearTimeout(pickerReturnCheckRef.current);
      pickerReturnCheckRef.current = null;
    }
    setPickerPending((current) => {
      if (!current) return current;
      logEvent("ui", "file-picker-pending-cleared", {
        kind: current.kind,
        reason,
      });
      return null;
    });
    setPickerElapsedSeconds(0);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("goodboyexpress-theme", theme);
    } catch {
      // storage may be unavailable in private-browsing contexts
    }
  }, [theme]);

  useEffect(() => {
    if (prevStatusRef.current === "connected" && status === "disconnected") {
      showToast("The other device has disconnected.");
      // Fully reset local join state when a live session drops.
      setJoinInput("");
      setJoinedSessionId(null);
      // Reset the session so sessionId and role are cleared
      close();
    }
    if (status === "error" && errorMessage) {
      showToast(errorMessage);
      // Recover to the initial UI so the user can immediately retry joining.
      setJoinedSessionId(null);
      close();
    }
    prevStatusRef.current = status;
  }, [status, errorMessage, close, showToast]);

  useEffect(() => {
    if (status === "idle" || status === "connected" || status === "error") {
      setScanJoinPending(false);
    }
  }, [status]);

  useEffect(() => {
    if (status === "idle") return;
    setScanJoinCandidateId(null);
  }, [status]);

  useEffect(() => {
    if (status === "idle") return;
    if (!scanPanelOpen) return;
    stopScan();
    setScanPanelOpen(false);
  }, [status, scanPanelOpen, stopScan]);

  // Cleanup toast timer on unmount
  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null)
        window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!displaySessionId) {
      setQrDataUrl(null);
      setQrModalOpen(false);
      return;
    }

    let cancelled = false;
    void QRCode.toDataURL(displaySessionId, {
      margin: 1,
      width: 220,
      errorCorrectionLevel: "M",
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [displaySessionId]);

  useEffect(() => {
    if (!scanError) return;
    logEvent("ui", "qr-scan-fail", { message: scanError });
    showToast(scanError);
  }, [scanError, showToast]);

  useEffect(() => {
    if (!qrModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQrModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [qrModalOpen]);

  useEffect(() => {
    const latest = history[history.length - 1];
    if (!latest) return;
    if (latest.id === lastHistoryToastIdRef.current) return;
    lastHistoryToastIdRef.current = latest.id;
    if (latest.status !== "complete") return;

    const directionLabel = latest.direction === "sent" ? "Sent" : "Received";
    showToast(
      `${directionLabel} ${latest.relativePath} (${formatBytes(latest.size)})`,
      3600,
    );
  }, [history, showToast]);

  useEffect(() => {
    if (!outgoingOffer) {
      setOfferElapsedSeconds(0);
      return;
    }

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setOfferElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [outgoingOffer]);

  useEffect(() => {
    if (!pickerPending) return;

    const interval = window.setInterval(() => {
      setPickerElapsedSeconds(
        Math.floor((Date.now() - pickerPending.startedAt) / 1000),
      );
    }, 1000);

    function scheduleAutoClearIfNoSelection(): void {
      if (pickerReturnCheckRef.current !== null) {
        window.clearTimeout(pickerReturnCheckRef.current);
      }
      // Give the browser a short window to dispatch `change` if the user did
      // actually pick files; if no transfer has started by then, treat the
      // picker dismissal as an implicit cancel.
      pickerReturnCheckRef.current = window.setTimeout(() => {
        pickerReturnCheckRef.current = null;
        const filesCount = filesInputRef.current?.files?.length ?? 0;
        if (filesCount > 0) return;
        if (outgoingOffer || sendingFile) return;
        clearPickerPending("picker-dismissed");
      }, 350);
    }

    function handleWindowFocus(): void {
      scheduleAutoClearIfNoSelection();
    }

    function handleVisibilityChange(): void {
      if (document.visibilityState === "visible") {
        scheduleAutoClearIfNoSelection();
      }
    }

    pickerTimeoutRef.current = window.setTimeout(() => {
      clearPickerPending("timeout");
    }, 60_000);

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (pickerTimeoutRef.current !== null) {
        window.clearTimeout(pickerTimeoutRef.current);
        pickerTimeoutRef.current = null;
      }
      if (pickerReturnCheckRef.current !== null) {
        window.clearTimeout(pickerReturnCheckRef.current);
        pickerReturnCheckRef.current = null;
      }
    };
  }, [pickerPending, outgoingOffer, sendingFile]);

  useEffect(() => {
    // Clear picker-pending once the transfer pipeline has actually started.
    // Doing it here (instead of inside handleFilesChosen) prevents a blank-UI
    // frame where both pickerPending and outgoingOffer are null simultaneously.
    if (!pickerPending) return;
    if (!outgoingOffer && !sendingFile) return;
    clearPickerPending("transfer-started");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerPending, outgoingOffer, sendingFile]);

  useEffect(() => {
    if (!outgoingOffer) {
      logEvent("ui", "outgoing-offer-cleared");
      return;
    }

    logEvent("ui", "outgoing-offer-state", {
      stage: outgoingOffer.stage,
      fileCount: outgoingOffer.fileCount,
      totalBytes: outgoingOffer.totalBytes,
    });
  }, [outgoingOffer]);

  useEffect(() => {
    if (!incomingOffer) return;

    logEvent("ui", "incoming-offer-visible", {
      fileCount: incomingOffer.fileCount,
      totalBytes: incomingOffer.totalBytes,
    });

    const originalTitle = document.title;
    const alertTitle = "Incoming transfer - GoodBoyExpress";
    let titleTimer: number | null = null;

    if (document.hidden) {
      try {
        window.focus();
      } catch {
        // Browser may block programmatic focus when tab is in background.
      }

      if ("Notification" in window && Notification.permission === "granted") {
        const notification = new Notification("Incoming transfer", {
          body: `${incomingOffer.fileCount} file${incomingOffer.fileCount === 1 ? "" : "s"} (${formatBytes(incomingOffer.totalBytes)})`,
        });
        window.setTimeout(() => notification.close(), 4500);
      }

      let toggle = false;
      titleTimer = window.setInterval(() => {
        document.title = toggle ? alertTitle : originalTitle;
        toggle = !toggle;
      }, 900);
    }

    return () => {
      if (titleTimer !== null) window.clearInterval(titleTimer);
      document.title = originalTitle;
    };
  }, [incomingOffer]);

  async function openScanPanel(): Promise<void> {
    if (status !== "idle") {
      showToast("Open QR scanner only when no active connection is running.");
      return;
    }

    logEvent("ui", "qr-scan-start");
    setScanPanelOpen(true);
    const started = await startScan();
    if (!started) setScanPanelOpen(false);
  }

  function closeScanPanel(): void {
    logEvent("ui", "qr-scan-cancel");
    stopScan();
    setScanPanelOpen(false);
  }

  function cancelScanJoinCandidate(): void {
    if (!scanJoinCandidateId) return;
    logEvent("ui", "qr-scan-confirm-cancel", {
      sessionId: scanJoinCandidateId,
    });
    scanDedupRef.current = null;
    setScanJoinCandidateId(null);
  }

  function confirmScanJoinCandidate(): void {
    if (!scanJoinCandidateId) return;
    if (status !== "idle") {
      showToast("Open QR scanner only when no active connection is running.");
      setScanJoinCandidateId(null);
      return;
    }

    logEvent("ui", "qr-scan-confirm-join", {
      sessionId: scanJoinCandidateId,
    });
    setScanJoinPending(true);
    setJoinedSessionId(scanJoinCandidateId);
    setScanJoinCandidateId(null);
    showToast("QR scanned. Connecting...");
    joinSession(scanJoinCandidateId);
  }

  function handleCreateSession(): void {
    setJoinedSessionId(null);
    stopScan();
    setScanPanelOpen(false);
    createSession();
  }

  function handleJoinSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = joinInput.trim();
    if (!trimmed) return;
    stopScan();
    setScanPanelOpen(false);
    setJoinedSessionId(trimmed);
    joinSession(trimmed);
  }

  function handleFilesChosen(event: ChangeEvent<HTMLInputElement>): void {
    const { files } = event.target;
    const firstFile = files?.item(0) ?? null;
    logEvent("ui", "file-input-changed", {
      fileCount: files?.length ?? 0,
      firstFileName: firstFile?.name ?? null,
      firstFileSize: firstFile?.size ?? null,
      firstFileLastModified: firstFile?.lastModified ?? null,
    });
    const items = files && files.length > 0 ? toBatchItems(files) : [];
    // For empty selection clear immediately; for actual files the effect that
    // watches outgoingOffer will clear it once the transfer pipeline starts.
    if (items.length === 0) clearPickerPending("empty-selection");
    event.target.value = ""; // allow re-selecting the same file(s) later
    if (items.length > 0) void send(items);
  }

  function openFilePicker(): void {
    clearTransferError();
    logEvent("ui", "file-picker-open-clicked", { kind: "files" });
    setPickerPending({ kind: "files", startedAt: Date.now() });
    setPickerElapsedSeconds(0);
    filesInputRef.current?.click();
  }

  async function copySessionId(): Promise<void> {
    if (!displaySessionId) return;
    try {
      await navigator.clipboard.writeText(displaySessionId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main id="session">
      <button
        type="button"
        className="theme-toggle"
        onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        aria-label={
          theme === "light" ? "Switch to dark mode" : "Switch to light mode"
        }
      >
        {theme === "light" ? "🌙" : "☀️"}
      </button>
      <section className="hero">
        <span className="hero-pill">Peer-to-peer transfer</span>
        <h1>GoodBoyExpress</h1>
        <p className="subtitle">
          Fast browser-to-browser file delivery with zero cloud upload.
        </p>
        <HeroPlayground />
      </section>

      <section className="surface">
        <section className="status-card">
          <p className="status-label">{STATUS_LABELS[status]}</p>
          {role && <p className="role">Role: {role}</p>}
          <p className="role">Channel: {channelState}</p>
          {displaySessionId && (
            <p className="role">Session: {displaySessionId}</p>
          )}
          {wakeLockActive && (
            <p className="role role--wake-lock">Screen: staying awake</p>
          )}
          {errorMessage && <p className="error">{errorMessage}</p>}
        </section>

        {status === "idle" && (
          <section className="onboarding">
            <p className="network-tip" role="note">
              <span className="network-tip-icon" aria-hidden="true">
                🐾
              </span>
              <span className="network-tip-text">
                <strong>Delivery tip</strong>
                Keep both devices on the same Wi-Fi so the pup can find its
                way between them.
              </span>
            </p>
            <button
              type="button"
              className="primary-cta"
              onClick={handleCreateSession}
            >
              Create session
            </button>

            <div className="onboarding-divider">
              <span>or</span>
            </div>

            <form className="join-form" onSubmit={handleJoinSubmit}>
              <label htmlFor="join-session-input">Join with session ID</label>
              <div className="join-form-row">
                <input
                  id="join-session-input"
                  type="text"
                  placeholder="Paste session ID"
                  value={joinInput}
                  onChange={(event) => setJoinInput(event.target.value)}
                />
                <button type="submit">Join</button>
              </div>
              <button
                type="button"
                className="scan-toggle"
                onClick={() =>
                  scanPanelOpen ? closeScanPanel() : void openScanPanel()
                }
                disabled={scanJoinPending}
              >
                {scanPanelOpen ? "Close scanner" : "Scan QR to join"}
              </button>

              {scanPanelOpen && (
                <section className="scan-panel" aria-live="polite">
                  <div className="scan-video-wrap">
                    <video
                      ref={scanVideoRef}
                      className="scan-video"
                      muted
                      playsInline
                    />
                  </div>
                  <p className="scan-hint">
                    {scanActive
                      ? "Point your camera at the session QR code."
                      : "Starting camera..."}
                  </p>
                  <div className="scan-actions">
                    {!scanActive && (
                      <button
                        type="button"
                        onClick={() => void openScanPanel()}
                      >
                        Retry camera
                      </button>
                    )}
                    <button type="button" onClick={closeScanPanel}>
                      Cancel
                    </button>
                  </div>
                </section>
              )}
            </form>
          </section>
        )}

        {displaySessionId && (
          <section className="share">
            <p>Session ID</p>
            <div className="share-row">
              <code>{displaySessionId}</code>
              <button type="button" onClick={() => void copySessionId()}>
                {copied ? "Copied" : "Copy"}
              </button>
              {role === "host" && (
                <button
                  type="button"
                  onClick={() => setQrModalOpen(true)}
                  disabled={!qrDataUrl}
                  aria-haspopup="dialog"
                >
                  QR
                </button>
              )}
            </div>
          </section>
        )}

        {qrModalOpen && qrDataUrl && (
          <div
            className="qr-modal-overlay"
            role="presentation"
            onClick={() => setQrModalOpen(false)}
          >
            <div
              className="qr-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Session QR code"
              onClick={(event) => event.stopPropagation()}
            >
              <img
                src={qrDataUrl}
                alt="QR code for joining this session"
                width={220}
                height={220}
              />
              <code>{displaySessionId}</code>
              <p className="qr-modal-hint">
                Scan with the other device to join this session.
              </p>
              <button type="button" onClick={() => setQrModalOpen(false)}>
                Close
              </button>
            </div>
          </div>
        )}

        {status === "connected" && (
          <section className="transfer">
            <div className="upload-panel">
              <button
                type="button"
                className="upload-trigger"
                onClick={openFilePicker}
                disabled={isUploadBusy}
              >
                Upload files
              </button>

              <input
                ref={filesInputRef}
                type="file"
                multiple
                onChange={handleFilesChosen}
                disabled={isUploadBusy}
                className="hidden-picker"
              />
            </div>

            {activeTransfer && (
              <TransferBeacon
                mode={sendingFile ? "sending" : "receiving"}
                path={activeTransfer.relativePath}
                paused={
                  sendingFile ? isOutgoingPaused : isIncomingPaused
                }
              />
            )}

            {outgoingOffer && (
              <div className="pending-transfer" aria-live="polite">
                <p className="pending-transfer-title">
                  {outgoingOffer.stage === "preparing"
                    ? "Preparing transfer..."
                    : "Waiting for receiver to accept..."}
                </p>
                <p className="pending-transfer-body">
                  {outgoingOffer.fileCount} file
                  {outgoingOffer.fileCount === 1 ? "" : "s"} ·{" "}
                  {formatBytes(outgoingOffer.totalBytes)}
                  {outgoingOffer.stage === "waiting-for-accept" && (
                    <>
                      {" "}
                      · waiting {offerElapsedSeconds}s
                      {offerElapsedSeconds >= 8 && (
                        <span className="pending-transfer-hint">
                          {" "}
                          (slow networks can take up to ~20s on the first
                          transfer)
                        </span>
                      )}
                    </>
                  )}
                </p>
                <TransferBeacon
                  mode="sending"
                  path={
                    outgoingOffer.stage === "preparing"
                      ? "Checking transfer"
                      : "Offer sent"
                  }
                />
                <div className="transfer-controls transfer-controls--single">
                  <button
                    type="button"
                    className="btn-cancel"
                    onClick={cancelOutgoing}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {pickerPending && !outgoingOffer && !sendingFile && (
              <div
                className="pending-transfer pending-transfer--picker"
                aria-live="polite"
              >
                <p className="pending-transfer-title">
                  Preparing selected {pickerPending.kind}...
                </p>
                <p className="pending-transfer-body">
                  Browser/OS is still processing your selection · waiting{" "}
                  {pickerElapsedSeconds}s
                  {pickerElapsedSeconds >= 6 && (
                    <span className="pending-transfer-hint">
                      {" "}
                      (can be slower for cloud-synced, network, or scanned
                      files)
                    </span>
                  )}
                </p>
                <TransferBeacon mode="sending" path="Preparing file handle" />
                <div className="transfer-controls transfer-controls--single">
                  <button
                    type="button"
                    className="btn-cancel"
                    onClick={() => clearPickerPending("user-cancelled")}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {sendingFile && (
              <>
                <TransferProgress
                  label={`Sending (${sendingFile.fileIndex + 1}/${sendingFile.fileCount}) "${sendingFile.relativePath}"… ${formatBytes(sendingFile.progress.bytesSent)} / ${formatBytes(sendingFile.progress.totalBytes)}`}
                  fraction={
                    sendingFile.progress.bytesSent /
                    sendingFile.progress.totalBytes
                  }
                />
                <TransferMeta telemetry={sendingTelemetry} />
                <div className="transfer-controls">
                  {isOutgoingPaused ? (
                    <button
                      type="button"
                      className="btn-resume"
                      onClick={resumeOutgoing}
                    >
                      Resume
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-pause"
                      onClick={pauseOutgoing}
                    >
                      Pause
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-cancel"
                    onClick={cancelOutgoing}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {receivingFile && (
              <>
                <TransferProgress
                  label={`Receiving (${receivingFile.fileIndex + 1}/${receivingFile.fileCount}) "${receivingFile.relativePath}"… ${formatBytes(receivingFile.progress.bytesReceived)} / ${formatBytes(receivingFile.progress.totalBytes)}`}
                  fraction={
                    receivingFile.progress.bytesReceived /
                    receivingFile.progress.totalBytes
                  }
                />
                <TransferMeta telemetry={receivingTelemetry} />
              </>
            )}

            {transferError && <p className="error">{transferError}</p>}

            {history.length > 0 && (
              <ul className="history">
                {history.map((entry) => (
                  <li key={entry.id} className="history-item">
                    <span
                      className={`history-direction history-direction--${entry.direction}`}
                    >
                      {entry.direction === "sent" ? "↑" : "↓"}
                    </span>
                    <span className="history-name">{entry.relativePath}</span>
                    <span className="history-size">
                      {formatBytes(entry.size)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </section>

      {incomingOffer && (
        <div className="offer-modal-backdrop" role="presentation">
          <section
            className="offer-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="incoming-transfer-title"
          >
            <p className="offer-modal-kicker">Incoming transfer request</p>
            <h2 id="incoming-transfer-title">Accept files?</h2>
            <p>
              {incomingOffer.fileCount} file
              {incomingOffer.fileCount === 1 ? "" : "s"} ·{" "}
              {formatBytes(incomingOffer.totalBytes)}
            </p>
            <div className="offer-actions offer-actions--modal">
              <button
                type="button"
                className="btn-decline"
                onClick={declineIncoming}
              >
                Decline
              </button>
              <button
                type="button"
                className="btn-accept"
                onClick={acceptIncoming}
              >
                Accept
              </button>
            </div>
          </section>
        </div>
      )}

      {scanJoinCandidateId && (
        <div className="offer-modal-backdrop" role="presentation">
          <section
            className="offer-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scan-join-confirm-title"
          >
            <p className="offer-modal-kicker">QR scan found a session</p>
            <h2 id="scan-join-confirm-title">Join this session?</h2>
            <p>
              Session ID: <code>{scanJoinCandidateId}</code>
            </p>
            <div className="offer-actions offer-actions--modal">
              <button
                type="button"
                className="btn-decline"
                onClick={cancelScanJoinCandidate}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-accept"
                onClick={confirmScanJoinCandidate}
              >
                Join
              </button>
            </div>
          </section>
        </div>
      )}

      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </main>
  );
}

function Toast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="toast" role="alert">
      <span className="toast-message">{message}</span>
      <button
        type="button"
        className="toast-close"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "calculating...";
  if (seconds < 60) return `${Math.max(Math.round(seconds), 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function TransferMeta({
  telemetry,
}: {
  telemetry: { bytesPerSecond: number; etaSeconds: number | null } | null;
}) {
  if (!telemetry) return null;
  return (
    <p className="transfer-meta">
      Speed {formatBytes(Math.round(telemetry.bytesPerSecond))}/s · ETA{" "}
      {formatEta(telemetry.etaSeconds)}
    </p>
  );
}

function TransferProgress({
  label,
  fraction,
}: {
  label: string;
  fraction: number;
}) {
  const percent = Math.round(fraction * 100);
  return (
    <div className="progress">
      <p>{label}</p>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function RunningDogSvg({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 132 84"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* tail */}
      <path
        className="dog-tail"
        d="M30 40C22 33 16 25 17 15"
        stroke="#D79D53"
        strokeWidth="9"
        strokeLinecap="round"
      />
      {/* far-side legs */}
      <rect className="dog-leg dog-leg--back-far" x="38" y="54" width="8" height="24" rx="4" fill="#B9762C" />
      <rect className="dog-leg dog-leg--front-far" x="76" y="54" width="8" height="24" rx="4" fill="#B9762C" />
      {/* body */}
      <ellipse cx="60" cy="48" rx="33" ry="19" fill="#D99A4A" />
      <ellipse cx="78" cy="52" rx="14" ry="13" fill="#E6B468" />
      {/* near-side legs */}
      <rect className="dog-leg dog-leg--back-near" x="48" y="54" width="8" height="24" rx="4" fill="#C57A31" />
      <rect className="dog-leg dog-leg--front-near" x="86" y="54" width="8" height="24" rx="4" fill="#C57A31" />
      {/* head */}
      <circle cx="97" cy="30" r="16" fill="#E5B363" />
      <ellipse cx="88" cy="21" rx="7" ry="11" transform="rotate(-24 88 21)" fill="#BF7A33" />
      <ellipse cx="109" cy="34" rx="9" ry="7" fill="#F7D59A" />
      <circle cx="103" cy="26" r="2.6" fill="#2E2118" />
      <circle cx="116.5" cy="31.5" r="2.8" fill="#2E2118" />
      {/* parcel carried in the mouth */}
      <g className="dog-parcel">
        <rect x="108" y="38" width="19" height="14" rx="2.5" fill="#B9772F" />
        <rect x="116" y="38" width="3.5" height="14" fill="#F1DDB6" />
        <rect x="108" y="43.5" width="19" height="3" fill="#F1DDB6" opacity="0.85" />
      </g>
    </svg>
  );
}

/**
 * Hero mascot playground: one master 16s timeline drives the dog running
 * right, jumping, running back left, jumping, trotting to the center,
 * sitting down, and barking ("Woof!") before looping. The run/sit poses
 * are two stacked elements crossfaded by the same timeline so the gallop
 * animation never has to pause mid-cycle.
 *
 * Easter eggs:
 * - Click the dog for a startled hop; five rapid clicks trigger zoomies.
 * - Drag files over the page and the dog chases the cursor, expecting a
 *   game of fetch ("Got it!" on drop).
 * - Between midnight and 5 AM the pup is asleep in the middle of the
 *   stage (Zzz…).
 */
function HeroPlayground() {
  const stageRef = useRef<HTMLDivElement>(null);
  const dogRef = useRef<HTMLDivElement>(null);
  const clickTimesRef = useRef<number[]>([]);
  const reactTimerRef = useRef<number | null>(null);
  const lastFetchXRef = useRef<number | null>(null);
  const [reaction, setReaction] = useState<"boop" | "zoomies" | null>(null);
  const [say, setSay] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [isAsleep, setIsAsleep] = useState(() => new Date().getHours() < 5);

  const react = (
    kind: "boop" | "zoomies",
    text: string,
    durationMs: number,
  ) => {
    if (reactTimerRef.current !== null) {
      window.clearTimeout(reactTimerRef.current);
    }
    setReaction(kind);
    setSay(text);
    reactTimerRef.current = window.setTimeout(() => {
      setReaction(null);
      setSay(null);
      reactTimerRef.current = null;
    }, durationMs);
  };

  const handleDogClick = () => {
    // A click can land inside the post-drop "Got it!" window; since it
    // replaces the timer that would end fetch mode, end it here too.
    setIsFetching(false);
    lastFetchXRef.current = null;
    const now = Date.now();
    const recent = clickTimesRef.current.filter((t) => now - t < 2500);
    recent.push(now);
    clickTimesRef.current = recent;
    if (recent.length >= 5) {
      clickTimesRef.current = [];
      react("zoomies", "Zoomies!!", 1900);
    } else {
      react("boop", isAsleep ? "…zzz" : "Woof!?", 950);
    }
  };

  // The pup keeps human hours: asleep between midnight and 5 AM.
  useEffect(() => {
    const id = window.setInterval(() => {
      setIsAsleep(new Date().getHours() < 5);
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(
    () => () => {
      if (reactTimerRef.current !== null) {
        window.clearTimeout(reactTimerRef.current);
      }
    },
    [],
  );

  // Fetch mode: while files are dragged over the window the dog chases
  // the cursor along the stage; dropping earns a triumphant "Got it!".
  // preventDefault also stops the browser from navigating to a dropped
  // file anywhere on the page.
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");

    const endFetch = () => {
      setIsFetching(false);
      lastFetchXRef.current = null;
    };

    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setIsFetching(true);
      const stage = stageRef.current;
      const dog = dogRef.current;
      if (!stage || !dog) return;
      const rect = stage.getBoundingClientRect();
      if (rect.width === 0) return;
      const dogWidth = dog.offsetWidth;
      const clamped = Math.min(
        Math.max(event.clientX - rect.left - dogWidth / 2, 0),
        Math.max(rect.width - dogWidth, 0),
      );
      const pct = (clamped / rect.width) * 100;
      const last = lastFetchXRef.current;
      if (last !== null && Math.abs(pct - last) > 0.5) {
        dog.style.setProperty("--fetch-dir", pct > last ? "1" : "-1");
      }
      lastFetchXRef.current = pct;
      dog.style.setProperty("--fetch-x", `${pct}%`);
    };

    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (reactTimerRef.current !== null) {
        window.clearTimeout(reactTimerRef.current);
      }
      setReaction("boop");
      setSay("Got it!");
      reactTimerRef.current = window.setTimeout(() => {
        setReaction(null);
        setSay(null);
        reactTimerRef.current = null;
        endFetch();
      }, 1400);
    };

    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) endFetch();
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragend", endFetch);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragend", endFetch);
    };
  }, []);

  const stageClasses = [
    "hero-stage",
    isAsleep ? "hero-stage--sleep" : "",
    isFetching ? "hero-stage--fetch" : "",
    reaction !== null ? "hero-stage--paused" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={stageRef} className={stageClasses} aria-hidden="true">
      <div ref={dogRef} className="hero-dog" onClick={handleDogClick}>
        <div className="hero-dog-jump">
          <div
            className={`hero-dog-react${
              reaction !== null ? ` hero-react--${reaction}` : ""
            }`}
          >
            <div className="hero-dog-flip">
              <div className="hero-pose hero-pose--run">
                <RunningDogSvg className="hero-run-svg" />
              </div>
              <img
                className="hero-pose hero-pose--sit"
                src={goldenRetrieverSprite}
                alt=""
                width={110}
                height={115}
              />
            </div>
          </div>
          <span className="hero-woof hero-woof--one">Woof!</span>
          <span className="hero-woof hero-woof--two">Woof woof!</span>
          {say !== null && <span className="hero-say">{say}</span>}
          {isAsleep && !isFetching && say === null && (
            <span className="hero-zzz">Zzz…</span>
          )}
        </div>
      </div>
    </div>
  );
}

function CourierDog() {
  return (
    <div className="courier-dog" aria-hidden="true">
      <RunningDogSvg className="courier-dog-svg" />
      <img
        className="courier-dog-sit"
        src={goldenRetrieverSprite}
        alt=""
        width={110}
        height={115}
      />
    </div>
  );
}

function TransferBeacon({
  mode,
  path,
  paused = false,
}: {
  mode: "sending" | "receiving";
  path: string;
  paused?: boolean;
}) {
  return (
    <div
      className={`beacon beacon--${mode}${paused ? " beacon--paused" : ""}`}
      aria-live="polite"
    >
      <p className="beacon-label">
        {mode === "sending" ? "Sending" : "Receiving"}: {path}
        {paused && " (paused)"}
      </p>
      <div className="beacon-rail">
        <span className="beacon-node" />
        <span className="beacon-line" />
        <span className="beacon-node" />
        <CourierDog />
      </div>
    </div>
  );
}

export default App;
