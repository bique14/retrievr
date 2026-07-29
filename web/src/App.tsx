/**
 * Session create/join UI plus batch file transfer: pick files or an entire
 * folder, send them over the WebRTC DataChannel, and track a running
 * history of what has been sent and received.
 */
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useFileTransfer } from "./hooks/useFileTransfer";
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

function toBatchItems(files: FileList): BatchSendItem[] {
  return Array.from(files).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
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
  const folderInputRef = useRef<HTMLInputElement>(null);
  const pickerTimeoutRef = useRef<number | null>(null);
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
    kind: "files" | "folder";
    startedAt: number;
  } | null>(null);
  const [pickerElapsedSeconds, setPickerElapsedSeconds] = useState(0);
  const isUploadBusy = isSending || pickerPending !== null;

  // Dark mode — persisted to localStorage
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return localStorage.getItem("retrievr-theme") === "dark"
        ? "dark"
        : "light";
    } catch {
      return "light";
    }
  });

  // Toast notifications
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const prevStatusRef = useRef<typeof status>(status);

  function clearPickerPending(reason: string): void {
    if (pickerTimeoutRef.current !== null) {
      window.clearTimeout(pickerTimeoutRef.current);
      pickerTimeoutRef.current = null;
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
      localStorage.setItem("retrievr-theme", theme);
    } catch {
      // storage may be unavailable in private-browsing contexts
    }
  }, [theme]);

  useEffect(() => {
    if (prevStatusRef.current === "connected" && status === "disconnected") {
      if (toastTimerRef.current !== null)
        window.clearTimeout(toastTimerRef.current);
      setToast("The other device has disconnected.");
      toastTimerRef.current = window.setTimeout(() => setToast(null), 5000);
      // Fully reset local join state when a live session drops.
      setJoinInput("");
      setJoinedSessionId(null);
      // Reset the session so sessionId and role are cleared
      close();
    }
    if (status === "error" && errorMessage) {
      if (toastTimerRef.current !== null)
        window.clearTimeout(toastTimerRef.current);
      setToast(errorMessage);
      toastTimerRef.current = window.setTimeout(() => setToast(null), 5000);
      // Recover to the initial UI so the user can immediately retry joining.
      setJoinedSessionId(null);
      close();
    }
    prevStatusRef.current = status;
  }, [status, errorMessage, close]);

  // Cleanup toast timer on unmount
  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null)
        window.clearTimeout(toastTimerRef.current);
    };
  }, []);

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

    pickerTimeoutRef.current = window.setTimeout(() => {
      clearPickerPending("timeout");
    }, 60_000);

    return () => {
      window.clearInterval(interval);
      if (pickerTimeoutRef.current !== null) {
        window.clearTimeout(pickerTimeoutRef.current);
        pickerTimeoutRef.current = null;
      }
    };
  }, [pickerPending]);

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
    const alertTitle = "Incoming transfer - retrievr";
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

  function handleCreateSession(): void {
    setJoinedSessionId(null);
    createSession();
  }

  function handleJoinSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = joinInput.trim();
    if (!trimmed) return;
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
    logEvent("ui", "file-picker-open-clicked", { kind: "files" });
    setPickerPending({ kind: "files", startedAt: Date.now() });
    setPickerElapsedSeconds(0);
    setShowUploadMenu(false);
    filesInputRef.current?.click();
  }

  function openFolderPicker(): void {
    logEvent("ui", "file-picker-open-clicked", { kind: "folder" });
    setPickerPending({ kind: "folder", startedAt: Date.now() });
    setPickerElapsedSeconds(0);
    setShowUploadMenu(false);
    folderInputRef.current?.click();
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
        <h1>retrievr</h1>
        <p className="subtitle">
          Fast browser-to-browser file delivery with zero cloud upload.
        </p>
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
                    <button type="button" onClick={openFolderPicker}>
                      Folder
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
              <input
                ref={folderInputRef}
                type="file"
                // @ts-expect-error -- non-standard attribute, only recognized by Chromium
                webkitdirectory=""
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
