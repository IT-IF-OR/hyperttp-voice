export declare const PCM_SAMPLE_RATE = 48000;
export declare const PCM_FRAME_SAMPLES = 960;
export declare const PCM_FRAME_MS = 20;
export declare const PCM_FRAME_BYTES = 3840;
export declare const DEFAULT_MAX_CHUNK_BYTES: number;
export type AudioSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
export interface PcmOptions {
    channels?: 1 | 2;
    tail?: "pad" | "error";
    maxChunkBytes?: number;
    signal?: AbortSignal;
}
export declare function abortError(signal: AbortSignal): unknown;
/** Observe late rejection too, without leaving abort listeners attached. */
export declare function abortable<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T>;
export declare function releaseIterator(iterator: AsyncIterator<Uint8Array>): void;
export declare function audioIterator(source: AudioSource): AsyncIterator<Uint8Array>;
export declare function chunkLimit(value?: number): number;
export declare function validateChunk(chunk: Uint8Array, limit: number): void;
/** 48 kHz interleaved s16le; samples are per channel. Only one partial frame is retained. */
export declare function framePcm(source: AudioSource, options?: PcmOptions): AsyncGenerator<Buffer>;
//# sourceMappingURL=audio.d.ts.map