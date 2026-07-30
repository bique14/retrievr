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
  const [showUploadMenu, setShowUploadMenu] = useState(false);
  const uploadMenuRef = useRef<HTMLDivElement>(null);
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
    if (!showUploadMenu) return;

    function handleOutsideClick(event: MouseEvent): void {
      if (!uploadMenuRef.current) return;
      if (
        event.target instanceof Node &&
        !uploadMenuRef.current.contains(event.target)
      ) {
        setShowUploadMenu(false);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [showUploadMenu]);

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
    setShowUploadMenu(false);
  }

  function openFilePicker(): void {
    clearTransferError();
    logEvent("ui", "file-picker-open-clicked", { kind: "files" });
    setPickerPending({ kind: "files", startedAt: Date.now() });
    setPickerElapsedSeconds(0);
    setShowUploadMenu(false);
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
        <figure className="hero-sprite-wrap" aria-hidden="true">
          <img
            className="hero-sprite"
            src={goldenRetrieverSprite}
            alt=""
            width={280}
            height={192}
          />
        </figure>
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
              Best results: keep both devices on the same Wi-Fi network when
              creating or joining a session.
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
            </div>
            {role === "host" && (
              <div className="share-qr">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="QR code for joining this session"
                    width={170}
                    height={170}
                  />
                ) : (
                  <p className="share-qr-fallback">Generating QR...</p>
                )}
              </div>
            )}
          </section>
        )}

        {status === "connected" && (
          <section className="transfer">
            <div className="upload-panel">
              <div className="upload-menu-wrap" ref={uploadMenuRef}>
                <button
                  type="button"
                  className="upload-trigger"
                  onClick={() => setShowUploadMenu((current) => !current)}
                  disabled={isUploadBusy}
                >
                  Upload
                </button>
                {showUploadMenu && (
                  <div
                    className="upload-menu"
                    role="menu"
                    aria-label="Upload options"
                  >
                    <button type="button" onClick={openFilePicker}>
                      Files
                    </button>
                  </div>
                )}
              </div>

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

function TransferBeacon({
  mode,
  path,
}: {
  mode: "sending" | "receiving";
  path: string;
}) {
  return (
    <div className={`beacon beacon--${mode}`} aria-live="polite">
      <p className="beacon-label">
        {mode === "sending" ? "Sending" : "Receiving"}: {path}
      </p>
      <div className="beacon-rail">
        <span className="beacon-node" />
        <span className="beacon-line" />
        <span className="beacon-node" />
        <span className="beacon-packet beacon-packet--one" />
        <span className="beacon-packet beacon-packet--two" />
        <span className="beacon-packet beacon-packet--three" />
      </div>
    </div>
  );
}

export default App;
