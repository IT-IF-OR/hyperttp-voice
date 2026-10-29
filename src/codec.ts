import { OpusEncoder } from "libopus-node";
import { PCM_SAMPLE_RATE, PCM_FRAME_SAMPLES } from "./audio.js";

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
export class NativeOpusCodec implements OpusCodec {
  private encoder: InstanceType<typeof OpusEncoder> | undefined;
  readonly channels: 1 | 2;

  constructor(options: OpusCodecOptions = {}) {
    this.channels = options.channels ?? 2;
    if (this.channels !== 1 && this.channels !== 2) throw new RangeError("channels must be 1 or 2");
    this.encoder = new OpusEncoder(PCM_SAMPLE_RATE, this.channels);
    if (options.bitrate !== undefined) this.setBitrate(options.bitrate);
  }

  private native(): InstanceType<typeof OpusEncoder> {
    if (!this.encoder) throw new Error("Opus codec is closed");
    return this.encoder;
  }

  encode(pcm: Buffer): Buffer {
    const encoder = this.native();
    if (pcm.length !== PCM_FRAME_SAMPLES * this.channels * 2)
      throw new RangeError("PCM must contain exactly 20ms of s16le audio");
    return Buffer.from(encoder.encode(pcm));
  }

  decode(opus: Buffer): Buffer {
    const encoder = this.native();
    if (!opus.length) throw new RangeError("Opus packet must not be empty");
    return Buffer.from(encoder.decode(opus));
  }

  setBitrate(bitrate: number): void {
    const encoder = this.native();
    if (!Number.isInteger(bitrate) || bitrate < 500 || bitrate > 512_000)
      throw new RangeError("bitrate must be 500..512000 bits per second");
    encoder.setBitrate(bitrate);
  }

  close(): void {
    this.encoder = undefined;
  }
}

export function createOpusCodec(options: OpusCodecOptions = {}): OpusCodec {
  return new NativeOpusCodec(options);
}
