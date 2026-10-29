import { MiniEmitter } from "hemmiter";
import {
  abortable,
  abortError,
  audioIterator,
  chunkLimit,
  framePcm,
  releaseIterator,
  validateChunk,
  PCM_FRAME_SAMPLES,
  type AudioSource,
  type PcmOptions,
} from "./audio.js";
import { createOpusCodec, type OpusCodec } from "./codec.js";

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
} & ({ format?: "pcm" } | { format: "opus"; samples: 960 });
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

export class VoiceRuntime extends MiniEmitter<VoiceRuntimeEvents> {
  private readonly options: VoiceRuntimeOptions;
  private codec: OpusCodec | undefined;
  private controller: AbortController | undefined;
  private task: Promise<void> | undefined;
  private paused = false;
  private destroyed = false;
  private wake: (() => void) | undefined;
  private deadline = 0;
  private counters: AudioDiagnostics = { frames: 0, samples: 0, bytes: 0, processMs: 0 };

  constructor(
    private readonly sink: AudioSink,
    options: VoiceRuntimeOptions = {},
  ) {
    super();
    const channels = options.channels ?? 2;
    if (channels !== 1 && channels !== 2) throw new RangeError("channels must be 1 or 2");
    chunkLimit(options.maxChunkBytes);
    if (options.tail !== undefined && options.tail !== "pad" && options.tail !== "error")
      throw new RangeError("tail must be pad or error");
    this.options = { ...options };
  }

  get state(): "idle" | "playing" | "paused" | "destroyed" {
    return this.destroyed
      ? "destroyed"
      : this.controller
        ? this.paused
          ? "paused"
          : "playing"
        : "idle";
  }

  get diagnostics(): Readonly<AudioDiagnostics> | undefined {
    return this.options.diagnostics ? { ...this.counters } : undefined;
  }

  play(source: AudioSource, options: PlayOptions = {}): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error("Voice runtime is destroyed"));
    if (this.controller) return Promise.reject(new Error("Audio playback is already active"));
    if (options.format === "opus" && options.samples !== PCM_FRAME_SAMPLES)
      return Promise.reject(new RangeError("Opus playback requires explicit samples: 960 (20ms)"));
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
    const controller = new AbortController();
    this.controller = controller;
    this.paused = false;
    this.deadline = 0;
    this.counters = { frames: 0, samples: 0, bytes: 0, processMs: 0 };
    const externalAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", externalAbort, { once: true });
    // Defer work so task/controller exist even inside lifecycle listeners.
    const task = Promise.resolve()
      .then(() => this.run(source, options, controller))
      .finally(() => {
        options.signal?.removeEventListener("abort", externalAbort);
        if (this.task === task) this.task = undefined;
      });
    this.task = task;
    return task;
  }

  pause(): void {
    if (!this.controller || this.paused || this.controller.signal.aborted) return;
    this.paused = true;
    this.wake?.();
    this.emit("audioPause");
  }

  resume(): void {
    if (!this.controller || !this.paused || this.controller.signal.aborted) return;
    this.paused = false;
    this.deadline = performance.now() + 20;
    this.wake?.();
    this.emit("audioResume");
  }

  async stop(): Promise<void> {
    const task = this.task;
    this.controller?.abort();
    this.wake?.();
    // play() reports failures; stop is an idempotent cleanup operation.
    await task?.catch(() => {});
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.stop();
    this.codec?.close();
    this.codec = undefined;
    this.removeAllListeners();
  }

  private async ready(signal: AbortSignal): Promise<void> {
    while (true) {
      if (signal.aborted) throw abortError(signal);
      const delay = this.deadline - performance.now();
      if (!this.paused && delay <= 0) return;
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          if (this.wake === finish) this.wake = undefined;
          resolve();
        };
        this.wake = finish;
        signal.addEventListener("abort", finish, { once: true });
        if (!this.paused) timer = setTimeout(finish, Math.max(1, delay));
        if (signal.aborted) finish();
      });
    }
  }

  private async run(
    source: AudioSource,
    options: PlayOptions,
    controller: AbortController,
  ): Promise<void> {
    const signal = controller.signal;
    let iterator: AsyncIterator<Uint8Array> | undefined;
    let done = false;
    let reason: AudioEndReason = "completed";
    let transmissionEnded = false;
    try {
      this.emit("audioStart");
      if (signal.aborted) throw abortError(signal);
      const pcmOptions: PcmOptions = {
        channels: this.options.channels ?? 2,
        tail: this.options.tail ?? "pad",
        maxChunkBytes: chunkLimit(this.options.maxChunkBytes),
        signal,
      };
      iterator = options.format === "opus" ? audioIterator(source) : framePcm(source, pcmOptions);
      while (true) {
        await this.ready(signal);
        const result = await abortable(iterator.next(), signal);
        if (result.done) {
          done = true;
          break;
        }
        validateChunk(
          result.value,
          options.format === "opus" ? chunkLimit(this.options.maxChunkBytes) : Infinity,
        );
        await this.ready(signal);
        const start = performance.now();
        const scheduled = this.deadline;
        // Rebase after source starvation; never replay missed slots in a burst.
        const nextDeadline = (scheduled > 0 && start - scheduled < 20 ? scheduled : start) + 20;
        let packet: Buffer;
        if (options.format === "opus") {
          if (!result.value.byteLength) throw new RangeError("Opus packet must not be empty");
          packet = Buffer.from(result.value);
        } else {
          if (!this.codec) {
            this.codec =
              this.options.codecFactory?.(this.options.channels ?? 2) ??
              createOpusCodec({ channels: this.options.channels ?? 2 });
            if (this.options.bitrate !== undefined) this.codec.setBitrate(this.options.bitrate);
          }
          packet = this.codec.encode(Buffer.from(result.value));
        }
        await abortable(
          Promise.resolve(this.sink.sendOpus(packet, PCM_FRAME_SAMPLES, signal)),
          signal,
        );
        const finished = performance.now();
        // Normal encode/send latency belongs inside the 20ms slot, not after it.
        // A stalled sink starts a new schedule; resume may have already reset it.
        if (this.deadline === scheduled)
          this.deadline = finished >= nextDeadline ? finished + 20 : nextDeadline;
        if (this.options.diagnostics) {
          this.counters.frames++;
          this.counters.samples += PCM_FRAME_SAMPLES;
          this.counters.bytes += packet.length;
          this.counters.processMs += performance.now() - start;
        }
      }
      transmissionEnded = true;
      await this.sink.endTransmission?.();
    } catch (error) {
      if (signal.aborted) {
        reason = options.signal?.aborted ? "aborted" : "stopped";
        if (reason === "aborted") throw abortError(options.signal!);
      } else {
        reason = "error";
        const failure = error instanceof Error ? error : new Error(String(error));
        this.emit("error", failure);
        throw failure;
      }
    } finally {
      if (iterator && !done) releaseIterator(iterator);
      try {
        if (!transmissionEnded) await this.sink.endTransmission?.();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.emit("error", failure);
      } finally {
        if (this.controller === controller) this.controller = undefined;
        this.paused = false;
        this.emit("audioEnd", reason);
      }
    }
  }
}

export function createVoiceRuntime(
  sink: AudioSink,
  options: VoiceRuntimeOptions = {},
): VoiceRuntime {
  return new VoiceRuntime(sink, options);
}
