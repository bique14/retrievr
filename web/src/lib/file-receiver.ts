/**
 * Receives a batch of one or more files sent by `sendFiles` over an
 * `RTCDataChannel`, streaming each chunk straight to disk via the File
 * System Access API so the receiver never buffers a whole file in memory
 * either.
 *
 * Chrome only allows `showDirectoryPicker()` to be called while handling a
 * user gesture, so the picker can't be shown automatically the instant
 * `batch-info` arrives. Instead, the offer is surfaced via `onOffer` and
 * the caller must invoke `accept()` from a click handler; only then is the
 * picker shown and a `batch-accept` sent back so the sender starts
 * streaming files. Every file in the batch is then written under that one
 * chosen directory, recreating subfolders from each file's `relativePath`.
 *
 * Writes are serialized through a promise queue: DataChannel `message`
 * events can fire faster than disk writes complete, and
 * `FileSystemWritableFileStream.write()` calls must not overlap or chunks
 * can land out of order on disk.
 */
import {
  decodeChunkFrame,
  parseControlMessage,
  splitRelativePath,
  type BatchAcceptMessage,
  type BatchDeclineMessage,
} from "./transfer-protocol";
import { logEvent } from "./diagnostics";

export interface FileReceiveProgress {
  bytesReceived: number;
  totalBytes: number;
}

export interface BatchOfferInfo {
  fileCount: number;
  totalBytes: number;
}

export interface ReceivingFileInfo {
  name: string;
  relativePath: string;
  size: number;
  fileIndex: number;
  fileCount: number;
}

export interface FileReceiverCallbacks {
  /** Called once a batch offer arrives; waits here until `accept()` or `decline()` is called. */
  onOffer(info: BatchOfferInfo): void;
  /** Called once a given file within the (already-accepted) batch starts writing. */
  onFileStart(info: ReceivingFileInfo): void;
  onProgress(progress: FileReceiveProgress): void;
  onFileComplete(info: ReceivingFileInfo): void;
  onBatchComplete(): void;
  onError(message: string): void;
}

export class FileReceiver {
  private readonly channel: RTCDataChannel;
  private readonly callbacks: FileReceiverCallbacks;
  private pendingOffer: BatchOfferInfo | null = null;
  private directoryHandle: FileSystemDirectoryHandle | null = null;
  private fileCount = 0;
  private currentFile: ReceivingFileInfo | null = null;
  private writable: FileSystemWritableFileStream | null = null;
  private bytesReceived = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(channel: RTCDataChannel, callbacks: FileReceiverCallbacks) {
    this.channel = channel;
    this.callbacks = callbacks;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", this.handleMessageEvent);
  }

  /**
   * Shows the destination-folder picker and, once chosen, tells the sender
   * to start streaming. Must be called synchronously from a user gesture
   * (e.g. a button's onClick), or Chrome rejects `showDirectoryPicker()`.
   */
  async accept(): Promise<void> {
    const offer = this.pendingOffer;
    if (!offer) return;

    logEvent("receive", "accept-clicked");
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch {
      // User dismissed the picker; treat it the same as an explicit decline.
      logEvent("receive", "directory-picker-dismissed");
      this.decline();
      return;
    }
    logEvent("receive", "directory-picker-resolved");

    this.pendingOffer = null;
    this.directoryHandle = handle;
    this.fileCount = offer.fileCount;
    this.channel.send(
      JSON.stringify({ type: "batch-accept" } satisfies BatchAcceptMessage),
    );
    logEvent("receive", "batch-accept-sent");
  }

  /** Rejects the pending batch offer and tells the sender to stop. */
  decline(): void {
    if (!this.pendingOffer) return;
    this.pendingOffer = null;
    this.channel.send(
      JSON.stringify({ type: "batch-decline" } satisfies BatchDeclineMessage),
    );
  }

  /** Detaches from the channel; safe to call once the transfer is done. */
  dispose(): void {
    this.channel.removeEventListener("message", this.handleMessageEvent);
  }

  private readonly handleMessageEvent = (
    event: MessageEvent<string | ArrayBuffer>,
  ): void => {
    // Chain onto the queue so writes are always processed strictly in
    // arrival order, even if disk I/O is slower than message delivery.
    this.queue = this.queue
      .then(() => this.handleMessage(event.data))
      .catch((error: unknown) => {
        this.callbacks.onError(
          error instanceof Error ? error.message : "Unknown transfer error.",
        );
      });
  };

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === "string") {
      await this.handleControlMessage(data);
      return;
    }
    await this.handleChunk(data);
  }

  /** Resolves (creating as needed) the nested file handle for a validated relative path. */
  private async resolveFileHandle(
    root: FileSystemDirectoryHandle,
    segments: string[],
  ): Promise<FileSystemFileHandle> {
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    const fileName = segments[segments.length - 1];
    if (fileName === undefined) throw new Error("Empty file path.");
    return dir.getFileHandle(fileName, { create: true });
  }

  /** Closes any open writable and clears all in-progress batch/file state. */
  private async resetBatchState(): Promise<void> {
    await this.writable?.close().catch(() => {
      // The writable may already be closed/aborted (e.g. sender cancelled
      // mid-write); nothing more to do here.
    });
    this.writable = null;
    this.directoryHandle = null;
    this.currentFile = null;
    this.fileCount = 0;
    this.bytesReceived = 0;
  }

  private async handleControlMessage(raw: string): Promise<void> {
    const message = parseControlMessage(raw);
    if (!message) return; // ignore malformed frames rather than crashing the session

    switch (message.type) {
      case "batch-info": {
        logEvent("receive", "batch-info-received", {
          fileCount: message.fileCount,
          totalBytes: message.totalBytes,
        });
        if (this.pendingOffer || this.directoryHandle) {
          this.callbacks.onError(
            "Received a new transfer while another was in progress.",
          );
          return;
        }
        this.pendingOffer = {
          fileCount: message.fileCount,
          totalBytes: message.totalBytes,
        };
        this.callbacks.onOffer(this.pendingOffer);
        return;
      }

      case "file-info": {
        if (!this.directoryHandle) {
          this.callbacks.onError(
            "Received file data before the transfer was accepted.",
          );
          return;
        }
        const segments = splitRelativePath(message.relativePath);
        if (!segments) {
          this.callbacks.onError(
            `Refusing unsafe file path: "${message.relativePath}".`,
          );
          return;
        }

        const fileIndex = this.currentFile ? this.currentFile.fileIndex + 1 : 0;
        this.currentFile = {
          name: message.name,
          relativePath: message.relativePath,
          size: message.size,
          fileIndex,
          fileCount: this.fileCount,
        };
        this.bytesReceived = 0;

        const handle = await this.resolveFileHandle(
          this.directoryHandle,
          segments,
        );
        this.writable = await handle.createWritable();
        this.callbacks.onFileStart(this.currentFile);
        return;
      }

      case "transfer-complete": {
        await this.writable?.close();
        this.writable = null;
        if (this.currentFile) this.callbacks.onFileComplete(this.currentFile);
        return;
      }

      case "batch-complete": {
        await this.resetBatchState();
        this.callbacks.onBatchComplete();
        return;
      }

      case "transfer-error":
        await this.resetBatchState();
        this.callbacks.onError(message.message);
        return;

      // Accept/decline are sent by receivers, not to them; a receiver only
      // ever sees these echoed back if it also happens to be sending a
      // batch on the same channel, in which case sendFiles' own listener
      // (not this one) is responsible for consuming them.
      case "batch-accept":
      case "batch-decline":
        return;
    }
  }

  private async handleChunk(frame: ArrayBuffer): Promise<void> {
    if (!this.writable) return; // stray chunk before file-info or after completion

    const { payload } = decodeChunkFrame(frame);
    await this.writable.write(payload);
    this.bytesReceived += payload.length;
    this.callbacks.onProgress({
      bytesReceived: this.bytesReceived,
      totalBytes: this.currentFile?.size ?? 0,
    });
  }
}
