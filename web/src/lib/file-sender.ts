/**
 * Sends a batch of one or more files over an already-open `RTCDataChannel`,
 * chunked and flow-controlled so the DataChannel's internal send buffer
 * never grows unbounded (blueprint-1.0.md section 12). A single file is
 * simply a batch of one, so this is the only send path in the app.
 *
 * The receiver only agrees to the transfer once, for the whole batch
 * (`batch-accept`/`batch-decline`), because `showDirectoryPicker()` on the
 * other end can only be triggered by a user gesture - individual files
 * within an accepted batch stream straight through with no further
 * gating.
 */
import { readFileInChunks } from "./file-chunk-reader";
import {
  CHUNK_SIZE,
  HIGH_WATER_MARK,
  LOW_WATER_MARK,
  encodeChunkFrame,
  parseControlMessage,
  type BatchCompleteMessage,
  type BatchInfoMessage,
  type FileInfoMessage,
  type TransferCompleteMessage,
} from "./transfer-protocol";

export interface BatchSendItem {
  file: File;
  /** Path relative to the transfer root; equal to `file.name` outside of folder transfers. */
  relativePath: string;
}

export interface FileSendProgress {
  bytesSent: number;
  totalBytes: number;
}

export interface BatchSendCallbacks {
  onBatchPreparing?(info: { fileCount: number; totalBytes: number }): void;
  onBatchOfferSent?(info: { fileCount: number; totalBytes: number }): void;
  onFileStart(item: BatchSendItem, fileIndex: number, fileCount: number): void;
  onFileProgress(progress: FileSendProgress): void;
  onFileComplete(
    item: BatchSendItem,
    fileIndex: number,
    fileCount: number,
  ): void;
}

export interface TransferRuntimeControls {
  waitIfPaused(): Promise<void>;
  isCancelled(): boolean;
}

/** Thrown when the receiver declines the transfer (or dismisses the destination picker). */
export class TransferDeclinedError extends Error {
  constructor() {
    super("The other device declined the transfer.");
    this.name = "TransferDeclinedError";
  }
}

/** Browser-only transfers this large are too fragile without resume/recovery. */
const DEFAULT_MAX_BATCH_BYTES = 20 * 1024 * 1024 * 1024;

function resolveMaxBatchBytes(): number {
  const rawBytes = import.meta.env.VITE_MAX_BATCH_BYTES;
  if (rawBytes) {
    const parsed = Number(rawBytes);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const rawGigabytes = import.meta.env.VITE_MAX_BATCH_GB;
  if (rawGigabytes) {
    const parsed = Number(rawGigabytes);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1024 * 1024 * 1024;
    }
  }

  return DEFAULT_MAX_BATCH_BYTES;
}

export const MAX_BATCH_BYTES = resolveMaxBatchBytes();

const BATCH_DECISION_TIMEOUT_MS = 60_000;

export class TransferTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(
      `Transfer is too large for the current browser-based flow. The limit is ${Math.round(maxBytes / (1024 * 1024 * 1024))} GB per batch.`,
    );
    this.name = "TransferTooLargeError";
  }
}

export class TransferDecisionTimeoutError extends Error {
  constructor() {
    super(
      "The receiver did not respond in time. Ask them to keep this tab open and try again.",
    );
    this.name = "TransferDecisionTimeoutError";
  }
}

export class TransferCancelledError extends Error {
  constructor() {
    super("Transfer cancelled by sender.");
    this.name = "TransferCancelledError";
  }
}

/** Resolves once the channel's buffered amount has drained back down. */
function waitForBufferedAmountLow(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount <= LOW_WATER_MARK) return Promise.resolve();

  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
    channel.addEventListener("bufferedamountlow", function handleLow() {
      channel.removeEventListener("bufferedamountlow", handleLow);
      resolve();
    });
  });
}

/** Resolves true/false once the receiver responds to the pending batch offer. */
function waitForBatchDecision(
  channel: RTCDataChannel,
  controls?: TransferRuntimeControls,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      if (cancelPoll !== null) window.clearInterval(cancelPoll);
      channel.removeEventListener("message", handleMessage);
      reject(new TransferDecisionTimeoutError());
    }, BATCH_DECISION_TIMEOUT_MS);

    const cancelPoll =
      controls === undefined
        ? null
        : window.setInterval(() => {
            if (!controls.isCancelled()) return;
            window.clearTimeout(timeout);
            if (cancelPoll !== null) window.clearInterval(cancelPoll);
            channel.removeEventListener("message", handleMessage);
            reject(new TransferCancelledError());
          }, 120);

    function handleMessage(event: MessageEvent<string | ArrayBuffer>): void {
      if (typeof event.data !== "string") return;
      const message = parseControlMessage(event.data);
      if (message?.type !== "batch-accept" && message?.type !== "batch-decline")
        return;

      window.clearTimeout(timeout);
      if (cancelPoll !== null) window.clearInterval(cancelPoll);
      channel.removeEventListener("message", handleMessage);
      resolve(message.type === "batch-accept");
    }
    channel.addEventListener("message", handleMessage);
  });
}

async function sendOneFile(
  item: BatchSendItem,
  channel: RTCDataChannel,
  onProgress: (progress: FileSendProgress) => void,
  controls?: TransferRuntimeControls,
): Promise<void> {
  const { file, relativePath } = item;
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  channel.send(
    JSON.stringify({
      type: "file-info",
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
      totalChunks,
      relativePath,
    } satisfies FileInfoMessage),
  );

  let bytesSent = 0;
  let chunkIndex = 0;

  for await (const payload of readFileInChunks(file, CHUNK_SIZE)) {
    if (controls?.isCancelled()) throw new TransferCancelledError();
    if (controls) await controls.waitIfPaused();

    if (channel.bufferedAmount > HIGH_WATER_MARK) {
      await waitForBufferedAmountLow(channel);
    }

    channel.send(encodeChunkFrame(chunkIndex, payload));
    bytesSent += payload.length;
    chunkIndex += 1;
    onProgress({ bytesSent, totalBytes: file.size });
  }

  channel.send(
    JSON.stringify({
      type: "transfer-complete",
    } satisfies TransferCompleteMessage),
  );
}

/** Sends a batch of files/folder entries, waiting for the receiver's acceptance first. */
export async function sendFiles(
  items: BatchSendItem[],
  channel: RTCDataChannel,
  callbacks: BatchSendCallbacks,
  controls?: TransferRuntimeControls,
): Promise<void> {
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);

  if (totalBytes > MAX_BATCH_BYTES) {
    throw new TransferTooLargeError(MAX_BATCH_BYTES);
  }

  callbacks.onBatchPreparing?.({ fileCount: items.length, totalBytes });

  channel.send(
    JSON.stringify({
      type: "batch-info",
      fileCount: items.length,
      totalBytes,
    } satisfies BatchInfoMessage),
  );

  callbacks.onBatchOfferSent?.({ fileCount: items.length, totalBytes });

  const accepted = await waitForBatchDecision(channel, controls);
  if (!accepted) throw new TransferDeclinedError();

  for (const [index, item] of items.entries()) {
    if (controls?.isCancelled()) throw new TransferCancelledError();
    if (controls) await controls.waitIfPaused();

    callbacks.onFileStart(item, index, items.length);
    await sendOneFile(item, channel, callbacks.onFileProgress, controls);
    callbacks.onFileComplete(item, index, items.length);
  }

  channel.send(
    JSON.stringify({ type: "batch-complete" } satisfies BatchCompleteMessage),
  );
}
