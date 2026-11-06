export interface OpusCodec {
    encode(pcm: Buffer): Buffer;
    decode(opus: Buffer): Buffer;
    setBitrate(bitrate: number): void;
    close(): void;
}
export interface OpusCodecOptions {
    channels?: 1 | 2;
    bitrate?: number;
}
/** The binding has no destroy API: close releases our reference for native GC. */
export declare class NativeOpusCodec implements OpusCodec {
    private encoder;
    readonly channels: 1 | 2;
    constructor(options?: OpusCodecOptions);
    private native;
    encode(pcm: Buffer): Buffer;
    decode(opus: Buffer): Buffer;
    setBitrate(bitrate: number): void;
    close(): void;
}
export declare function createOpusCodec(options?: OpusCodecOptions): OpusCodec;
//# sourceMappingURL=codec.d.ts.map