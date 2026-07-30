/**
 * Binary chunk framing and control-message types for the file transfer
 * protocol that runs entirely over the WebRTC DataChannel established in
 * `session-connection.ts`. The signaling server never sees any of this -
 * these types exist only between the two browsers.
 *
 * A transfer always covers a "batch" of one or more files (a single file
 * is simply a batch of one), which keeps the protocol and the receiving
 * code path uniform whether the user picks one file, several files, or an
 * entire folder:
 *
 *  1. Sender sends `batch-info` (file count + total size).
 *  2. Receiver surfaces an accept/decline prompt. Accepting calls
 *     `showDirectoryPicker()` to choose a destination folder - this must
 *     happen inside the click handler, since Chrome only allows the File
 *     System Access API's pickers to be shown while handling a user
 *     gesture - then replies with `batch-accept` (or `batch-decline`).
 *  3. Once accepted, the sender streams each file in turn: `file-info`,
 *     then binary chunk frames, then `transfer-complete`.
 *  4. After the last file's `transfer-complete`, the sender sends
 *     `batch-complete`.
 *
 * Wire format:
 *  - Control messages are sent as JSON text frames.
 *  - Chunk payloads are sent as binary frames: a 4-byte little-endian chunk
 *    index followed by the raw chunk bytes. Using a binary frame (instead of
 *    base64-in-JSON) avoids ~33% size/CPU overhead for what is the vast
 *    majority of bytes transferred.
 *  - The DataChannel is ordered and reliable by default, so control and
 *    chunk frames always arrive in the order they were sent.
 */

/** Chrome's default SCTP association max-message-size (bytes per `send()` call). */
const MAX_MESSAGE_BYTES = 256 * 1024;

const CHUNK_HEADER_BYTES = 4;

/** Chunk payload size, kept under `MAX_MESSAGE_BYTES` once the frame header
 * is added - sending a frame larger than the negotiated max-message-size
 * throws `Failed to execute 'send' on 'RTCDataChannel'`. */
export const CHUNK_SIZE = MAX_MESSAGE_BYTES - CHUNK_HEADER_BYTES;

/** Pause sending once this many buffered bytes are queued, to avoid
 * unbounded memory growth in the browser's DataChannel send buffer. */
export const HIGH_WATER_MARK = CHUNK_SIZE * 16;

/** Resume sending once the buffered amount drops back to this level. */
export const LOW_WATER_MARK = CHUNK_SIZE * 4;

export interface BatchInfoMessage {
  type: "batch-info";
  fileCount: number;
  totalBytes: number;
}

export interface BatchAcceptMessage {
  type: "batch-accept";
}

export interface BatchDeclineMessage {
  type: "batch-decline";
}

export interface BatchCompleteMessage {
  type: "batch-complete";
}

export interface FileInfoMessage {
  type: "file-info";
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  /** Path relative to the transfer root, e.g. `"photos/beach.jpg"` for a
   * folder transfer; equal to `name` for a plain (non-folder) file. */
  relativePath: string;
}

export interface TransferCompleteMessage {
  type: "transfer-complete";
}

export interface TransferErrorMessage {
  type: "transfer-error";
  message: string;
}

/** Sender paused/resumed streaming; lets the receiver mirror the paused state in its UI. */
export interface TransferPausedMessage {
  type: "transfer-paused";
}

export interface TransferResumedMessage {
  type: "transfer-resumed";
}

export type TransferControlMessage =
  | BatchInfoMessage
  | BatchAcceptMessage
  | BatchDeclineMessage
  | BatchCompleteMessage
  | FileInfoMessage
  | TransferCompleteMessage
  | TransferErrorMessage
  | TransferPausedMessage
  | TransferResumedMessage;

/** Prepends a chunk index header to a payload, producing a single binary frame. */
export function encodeChunkFrame(
  chunkIndex: number,
  payload: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(CHUNK_HEADER_BYTES + payload.length);
  new DataView(frame.buffer).setUint32(0, chunkIndex, true);
  frame.set(payload, CHUNK_HEADER_BYTES);
  return frame;
}

/** Splits a received binary frame back into its chunk index and payload. */
export function decodeChunkFrame(frame: ArrayBuffer): {
  chunkIndex: number;
  payload: Uint8Array<ArrayBuffer>;
} {
  const chunkIndex = new DataView(frame).getUint32(0, true);
  return { chunkIndex, payload: new Uint8Array(frame, CHUNK_HEADER_BYTES) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Splits a `relativePath` from an untrusted peer into safe path segments,
 * rejecting `.`/`..`/empty segments so a malicious peer can't use a crafted
 * path (e.g. `"../../etc/passwd"`) to escape the destination directory
 * chosen via `showDirectoryPicker()`. Returns `null` if the path is unsafe.
 */
export function splitRelativePath(relativePath: string): string[] | null {
  const segments = relativePath.split("/");
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return segments;
}

/** Validates untrusted JSON from the peer before treating it as a control message. */
export function parseControlMessage(
  raw: string,
): TransferControlMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(value)) return null;

  switch (value.type) {
    case "batch-info": {
      const { fileCount, totalBytes } = value;
      if (typeof fileCount !== "number" || fileCount < 1) return null;
      if (typeof totalBytes !== "number" || totalBytes < 0) return null;
      return { type: "batch-info", fileCount, totalBytes };
    }
    case "batch-accept":
      return { type: "batch-accept" };
    case "batch-decline":
      return { type: "batch-decline" };
    case "batch-complete":
      return { type: "batch-complete" };
    case "file-info": {
      const { name, size, mimeType, totalChunks, relativePath } = value;
      if (typeof name !== "string" || typeof size !== "number" || size < 0)
        return null;
      if (typeof mimeType !== "string" || typeof totalChunks !== "number")
        return null;
      if (typeof relativePath !== "string") return null;
      return {
        type: "file-info",
        name,
        size,
        mimeType,
        totalChunks,
        relativePath,
      };
    }
    case "transfer-complete":
      return { type: "transfer-complete" };
    case "transfer-error":
      return typeof value.message === "string"
        ? { type: "transfer-error", message: value.message }
        : null;
    case "transfer-paused":
      return { type: "transfer-paused" };
    case "transfer-resumed":
      return { type: "transfer-resumed" };
    default:
      return null;
  }
}
