import { describe, expect, it } from "vitest";
import { createOpusCodec } from "../src/codec.js";

describe("native libopus-node codec", () => {
  for (const channels of [1, 2] as const) {
    it(`encodes and decodes actual 48kHz ${channels}-channel audio`, () => {
      const codec = createOpusCodec({ channels, bitrate: 64_000 });
      const pcm = Buffer.alloc(960 * channels * 2);
      for (let i = 0; i < 960; i++) {
        const sample = Math.round(Math.sin((i * 2 * Math.PI * 440) / 48_000) * 12_000);
        for (let channel = 0; channel < channels; channel++)
          pcm.writeInt16LE(sample, (i * channels + channel) * 2);
      }
      const packet = codec.encode(pcm);
      expect(packet.length).toBeGreaterThan(0);
      const decoded = codec.decode(packet);
      expect(decoded.length).toBe(pcm.length);
      expect(decoded.some((byte) => byte !== 0)).toBe(true);
      codec.setBitrate(96_000);
      expect(codec.decode(codec.encode(pcm)).length).toBe(pcm.length);
      codec.close();
      codec.close();
      expect(() => codec.encode(pcm)).toThrow("closed");
      expect(() => codec.decode(packet)).toThrow("closed");
      expect(() => codec.setBitrate(64_000)).toThrow("closed");
    });
  }

  it("validates PCM sizes, empty packets, and bitrates before native calls", () => {
    const codec = createOpusCodec();
    expect(() => codec.encode(Buffer.alloc(1920))).toThrow("20ms");
    expect(() => codec.decode(Buffer.alloc(0))).toThrow("empty");
    expect(() => codec.setBitrate(NaN)).toThrow("bitrate");
    expect(() => codec.setBitrate(0)).toThrow("bitrate");
    codec.close();
  });
});
