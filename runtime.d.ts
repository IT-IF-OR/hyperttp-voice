import { MiniEmitter } from "hemmiter";
import { type AudioSource } from "./audio.js";
import { type OpusCodec } from "./codec.js";
export interface AudioSink {
    sendOpus(packet: Buffer, samples?: number, signal?: AbortSignal): void | Promise<void>;
    endTransmission?(): void | Promise<void>;
}
export interface VoiceRuntimeOptions {
    channels?: 1 | 2;
    bitrate?: number;
    tail?: "pad" | "error";
    maxChunkBytes?: number;
    diagnostics?: boolean;
    /** The runtime owns and closes codecs returned by this factory. */
    codecFactory?: (channels: 1 | 2) => OpusCodec;
}
export type PlayOptions = {
    signal?: AbortSignal;
} & ({
    format?: "pcm";
} | {
    format: "opus";
    samples: 960;
});
export interface AudioDiagnostics {
    frames: number;
    samples: number;
    bytes: number;
    processMs: number;
}
export type AudioEndReason = "completed" | "stopped" | "aborted" | "error";
export interface VoiceRuntimeEvents {
    audioStart: [];
    audioPause: [];
    audioResume: [];
    audioEnd: [reason: AudioEndReason];
    error: [error: Error];
}
export declare class VoiceRuntime extends MiniEmitter<VoiceRuntimeEvents> {
    private readonly sink;
    private readonly options;
    private codec;
    private controller;
    private task;
    private paused;
    private destroyed;
    private wake;
    private deadline;
    private counters;
    constructor(sink: AudioSink, options?: VoiceRuntimeOptions);
    get state(): "idle" | "playing" | "paused" | "destroyed";
    get diagnostics(): Readonly<AudioDiagnostics> | undefined;
    play(source: AudioSource, options?: PlayOptions): Promise<void>;
    pause(): void;
    resume(): void;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    private ready;
    private run;
}
export declare function createVoiceRuntime(sink: AudioSink, options?: VoiceRuntimeOptions): VoiceRuntime;
//# sourceMappingURL=runtime.d.ts.map