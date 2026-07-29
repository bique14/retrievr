/**
 * Reads a `File` as a sequence of fixed-size `Uint8Array` chunks using the
 * Streams API, so the sender never holds the whole file in memory at once -
 * only a small rolling buffer (see blueprint-1.0.md section 17).
 */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);
  return combined;
}

export async function* readFileInChunks(
  file: File,
  chunkSize: number,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const reader = file.stream().getReader();
  let pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) pending = concat(pending, value);

      while (pending.length >= chunkSize) {
        yield pending.subarray(0, chunkSize);
        pending = pending.subarray(chunkSize);
      }

      if (done) {
        if (pending.length > 0) yield pending;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
