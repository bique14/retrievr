# Large File Support Plan (50–100GB) + Resume/Reconnect

Status: **not implemented yet** — this is a hand-off brief for whoever (human or
AI) picks up this work next. It assumes familiarity with [blueprint-1.0.md](blueprint-1.0.md)
and the current codebase under `web/src/lib/` (`file-sender.ts`, `file-receiver.ts`,
`file-chunk-reader.ts`, `transfer-protocol.ts`) and `web/src/hooks/useFileTransfer.ts`.

## 1. Why this is needed

The current implementation streams files chunk-by-chunk in both directions
(never buffers a whole file in memory), so memory is **not** the bottleneck
for huge files. The real problems for 50–100GB transfers are:

- **No resume.** If the DataChannel drops, the tab is closed, the OS sleeps,
  or either peer refreshes, the whole batch must restart from byte 0.
- **No pause/cancel.** The user cannot pause a multi-hour transfer and
  continue later.
- **No persisted transfer state.** Progress lives only in React state; a
  page reload loses everything, including which files/bytes were already
  written to disk.
- **No integrity check.** Nothing verifies that what landed on disk matches
  what was sent (bit flips, partial writes, out-of-order chunk bugs would go
  unnoticed).
- **No visibility into stall/failure** beyond the existing offer/decline
  timeout — a mid-transfer stall (e.g. ICE renegotiation, Wi-Fi drop) has no
  user-facing recovery path today.
- A single JS/browser tab session realistically running for hours is
  fragile: background tab throttling, OS sleep, and browser process limits
  all become relevant at this scale (Screen Wake Lock, added in this same
  change, only mitigates the "screen sleeps" case — it does not fix dropped
  connections).

Increasing `VITE_MAX_BATCH_GB`/`VITE_MAX_BATCH_BYTES` (see
`web/src/lib/file-sender.ts`) only removes the size _ceiling_; it does not
address any of the above.

## 2. Scope of "resumable" for this app

Two distinct failure modes need to be covered:

1. **Same-session hiccup**: DataChannel momentarily backs up or ICE
   renegotiates but the `RTCPeerConnection`/`RTCDataChannel` recovers on its
   own. Today this is implicitly "handled" by backpressure
   (`bufferedamountlow`), but a full ICE failure still tears the channel
   down with no retry.
2. **Full reconnect**: the signaling WebSocket and/or WebRTC connection is
   lost entirely (tab refresh, sleep/wake, network change) and a brand new
   `RTCPeerConnection` must be re-established, after which the transfer
   should continue from where it left off — not from byte 0.

This plan targets **(2)** as the primary goal, since it's what makes
50–100GB transfers practically usable. (1) should also be addressed as a
lower-effort improvement (see Task 7).

## 3. Required protocol changes (`web/src/lib/transfer-protocol.ts`)

Add new control message types (naming is a suggestion, keep the existing
`kebab/dash-free camelCase-in-JSON` style already used in this file):

- `transfer-session-id` (or embed a `transferId` field on the existing
  `batch-info` message) — a stable identifier for one logical batch transfer
  that survives reconnects. Generate with `crypto.randomUUID()` or
  `randomBytes(...).toString('base64url')` (same pattern as session IDs in
  `server/src/protocol.ts`).
- `resume-request { transferId, receivedBytesPerFile: Record<relativePath, number> }`
  — sent by the receiver right after a signaling reconnect, if it has local
  state for an in-progress `transferId`.
- `resume-offer { transferId, fileCount, totalBytes }` — sender's response
  confirming it still has the batch queued and where it will resume from.
- `resume-decline { transferId, reason }` — sender no longer has the batch
  (e.g. the sending tab was closed) or the file changed size/mtime since
  last attempt (safety check — see Task 5).
- `file-seek { relativePath, fromByte }` — tells the sender to restart
  streaming a specific file from a byte offset instead of from the start.
- Consider a lightweight per-chunk sequence number (already implicit via
  chunk framing in `encodeChunkFrame`/`decodeChunkFrame` — check whether the
  existing 4-byte header already includes an index; if not, add one) so the
  receiver can detect gaps/duplicates after a resume handshake.

## 4. Required persistence layer (new)

Add a small persistence module, e.g. `web/src/lib/transfer-state-store.ts`,
backed by `IndexedDB` (not `localStorage` — this needs structured data and
larger capacity). Responsibilities:

- Persist, per `transferId`: batch metadata (file list, sizes,
  `relativePath`s, total bytes), and per-file `bytesWritten` checkpoints.
- Update checkpoints incrementally as chunks are written (batch these
  writes — e.g. every N MB or every second — don't hit IndexedDB per chunk,
  that will itself become a bottleneck).
- Provide `loadInProgressTransfer(): PersistedTransfer | null` on startup so
  the receiver can offer to resume.
- Provide a cleanup path: delete the record on `batch-complete`, and expire
  abandoned records after some TTL (e.g. 24h) so stale entries don't pile up.
- On the **receiver** side, resuming also requires re-opening the same
  `FileSystemFileHandle`/`FileSystemDirectoryHandle`. Directory handles
  themselves _can_ be persisted across sessions via `IndexedDB` (structured
  clone supports `FileSystemHandle` in Chromium) — this needs to be
  verified against the current Chrome version in use, and permission may
  need to be re-requested via `handle.requestPermission({ mode: "readwrite" })`
  after reload, since permission grants don't necessarily survive a reload.
- On the **sender** side, resuming means re-opening the same `File` object
  — but a `File` handle from an `<input>` picker is **not** valid after a
  page reload (the browser invalidates it). This means:
  - Full-page-reload resume on the sender side is only possible if the
    sender also used the File System Access API to pick files (i.e. swap
    the plain `<input type="file">` flow for `showOpenFilePicker()`, which
    _does_ yield a re-openable `FileSystemFileHandle`), **or**
  - Resume is scoped to "same tab session, connection dropped and
    recovered" rather than "survives a full page reload" on the sender
    side. Decide and document which guarantee is actually being built —
    this materially changes scope. Recommendation: support "reconnect
    within the same tab" as the primary case, and treat "resume after
    sender reloads the page" as a stretch goal gated on switching the
    sender's file-picking flow to `showOpenFilePicker()`.

## 5. Integrity checks

- Before resuming a file, compare `File.size` and `File.lastModified`
  (sender side) against what was recorded when the transfer started; if
  either differs, refuse to resume that file and restart it (the file
  changed on disk).
- Add a per-file checksum (Web Crypto `SHA-256`, streamed via
  `crypto.subtle.digest` piecewise, or a rolling hash) computed on the
  sender as chunks are read and on the receiver as chunks are written.
  Compare at `transfer-complete` time; on mismatch, surface a clear error
  and offer to retry that single file rather than the whole batch.
- This was already a stated goal in blueprint-1.0.md ("Web Crypto API /
  SHA-256") but is not implemented yet — bundle it with this work since
  resume and integrity-checking share the same "verify what's actually on
  disk" concern.

## 6. UI/UX work (`web/src/App.tsx`, `web/src/hooks/useFileTransfer.ts`)

- Pause / Resume / Cancel controls for the active transfer (currently there
  is only a passive progress bar).
- On reconnect, show a distinct state: "Resuming transfer... (42% already
  received)" instead of silently restarting.
- Persist enough UI state (or re-derive it from the IndexedDB store) so a
  reloaded receiver tab can show "You have an incomplete transfer, resume?"
  even if the sender isn't connected yet.
- Surface throughput/ETA — genuinely useful once transfers run for
  minutes/hours, and cheap to add (rolling average of bytes/sec from
  existing progress callbacks).
- Decide what "declining a resume" looks like in the history list — should
  probably show a distinct `status: "incomplete"` in
  `TransferHistoryEntry` (currently only `"complete" | "failed"`).

## 7. Lower-effort improvements worth doing alongside (or before) full resume

These don't require the full protocol/persistence work above and can land
independently:

- **Reconnect the signaling WebSocket automatically** (`SignalingClient` /
  `SessionConnection` in `web/src/lib/`) with backoff, instead of the
  session going straight to `"disconnected"` on any drop. Currently a
  dropped WebSocket = dead session with no retry.
- **ICE restart**: when `RTCPeerConnection.connectionState` becomes
  `"disconnected"` (not yet `"failed"`), attempt an ICE restart
  (`createOffer({ iceRestart: true })`) before giving up. Today
  `webrtc-connection.ts`'s `onConnectionStateChange` likely only reacts to
  `"failed"`/`"closed"` — worth double-checking and handling
  `"disconnected"` too, since that's often recoverable.
- **Bump `BATCH_DECISION_TIMEOUT_MS`** (currently 60s in `file-sender.ts`)
  configurable via env, similar to the `MAX_BATCH_BYTES` change already
  made, so very large batches with a slow/away receiver don't spuriously
  time out.
- **Transfer-level heartbeat**: send a small periodic ping over the
  DataChannel during long-running transfers so a silently-dead connection
  is detected within seconds rather than only surfacing when
  `bufferedAmount` never drains.

## 8. Suggested implementation order

1. Task 7 items (signaling reconnect + ICE restart + configurable timeout) —
   cheap, immediately improves reliability for transfers of any size.
2. Protocol additions (Section 3) + `transfer-state-store.ts` (Section 4),
   scoped to "reconnect within the same tab" only (no cross-reload resume).
3. Wire resume into `file-sender.ts` / `file-receiver.ts` /
   `useFileTransfer.ts`, with UI for pause/resume/cancel (Section 6).
4. Integrity checks (Section 5).
5. Stretch: cross-reload resume via `showOpenFilePicker()` +
   `FileSystemDirectoryHandle` persistence + permission re-request flow.

## 9. Explicitly out of scope for this plan

- TURN server support (still assumed STUN-only, per existing project scope
  notes carried over from earlier sessions).
- Mobile/Safari support for any of the above (File System Access API and
  Screen Wake Lock support both vary significantly there).
- Multi-peer/broadcast transfers (this app is 1:1 only).
- Server-side relay/fallback for when P2P fails entirely — the project's
  stated goal is that files never touch the server.
