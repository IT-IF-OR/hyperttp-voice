export const PCM_SAMPLE_RATE = 48_000;
export const PCM_FRAME_SAMPLES = 960;
export const PCM_FRAME_MS = 20;
export const PCM_FRAME_BYTES = 3840;
export const DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024;

export type AudioSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
export interface PcmOptions {
  channels?: 1 | 2;
  tail?: "pad" | "error";
  maxChunkBytes?: number;
  signal?: AbortSignal;
}

export function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Audio playback aborted", "AbortError");
}

/** Observe late rejection too, without leaving abort listeners attached. */
export function abortable<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

export function releaseIterator(iterator: AsyncIterator<Uint8Array>): void {
  // Async generators may queue return() behind a never-settling next().
  try {
    void Promise.resolve(iterator.return?.()).catch(() => {});
  } catch {
    /* best effort */
  }
}

export function audioIterator(source: AudioSource): AsyncIterator<Uint8Array> {
  if (!("getReader" in source)) return source[Symbol.asyncIterator]();
  const reader = source.getReader();
  let closed = false;
  const release = (): void => {
    if (!closed) {
      closed = true;
      reader.releaseLock();
    }
  };
  return {
    async next() {
      try {
        const result = await reader.read();
        if (result.done) {
          release();
          return { done: true, value: undefined };
        }
        return { done: false, value: result.value };
      } catch (error) {
        release();
        throw error;
      }
    },
    async return() {
      try {
        await reader.cancel();
      } finally {
        release();
      }
      return { done: true, value: undefined };
    },
  };
}

export function chunkLimit(value = DEFAULT_MAX_CHUNK_BYTES): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError("maxChunkBytes must be a positive safe integer");
  return value;
}

export function validateChunk(chunk: Uint8Array, limit: number): void {
  if (!(chunk instanceof Uint8Array)) throw new TypeError("Audio chunks must be Uint8Array");
  if (chunk.byteLength > limit) throw new RangeError("Audio chunk exceeds maxChunkBytes");
}

/** 48 kHz interleaved s16le; samples are per channel. Only one partial frame is retained. */
export async function* framePcm(
  source: AudioSource,
  options: PcmOptions = {},
): AsyncGenerator<Buffer> {
  const channels = options.channels ?? 2;
  if (channels !== 1 && channels !== 2) throw new RangeError("channels must be 1 or 2");
  const tail = options.tail ?? "pad";
  if (tail !== "pad" && tail !== "error") throw new RangeError("tail must be pad or error");
  const limit = chunkLimit(options.maxChunkBytes);
  const frameBytes = PCM_FRAME_SAMPLES * channels * 2;
  const iterator = audioIterator(source);
  let frame = Buffer.alloc(frameBytes);
  let used = 0;
  let done = false;
  try {
    while (true) {
      if (options.signal?.aborted) throw abortError(options.signal);
      const result = await abortable(iterator.next(), options.signal);
      if (result.done) {
        done = true;
        break;
      }
      const chunk = result.value;
      validateChunk(chunk, limit);
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (options.signal?.aborted) throw abortError(options.signal);
        const length = Math.min(frameBytes - used, chunk.byteLength - offset);
        frame.set(chunk.subarray(offset, offset + length), used);
        used += length;
        offset += length;
        if (used === frameBytes) {
          yield frame;
          frame = Buffer.alloc(frameBytes);
          used = 0;
        }
      }
    }
    if (used % (channels * 2) !== 0)
      throw new Error("PCM ends with a partial sample (interleaved sample frame)");
    if (used) {
      if (tail === "error") throw new Error("PCM ends with an incomplete 20ms frame");
      yield frame;
    }
  } finally {
    if (!done) releaseIterator(iterator);
  }
}
