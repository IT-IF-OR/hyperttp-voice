import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceRuntime, type AudioEndReason } from "../src/runtime.js";
import type { OpusCodec } from "../src/codec.js";

async function* chunks(...values: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* values;
}
const packet = Buffer.from([0xf8, 0xff, 0xfe]);
const opus = { format: "opus", samples: 960 } as const;
function fakeCodec(): OpusCodec {
  return {
    encode: vi.fn(() => packet),
    decode: vi.fn(() => Buffer.alloc(3840)),
    setBitrate: vi.fn(),
    close: vi.fn(),
  };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("voice runtime", () => {
  it("bypasses codecs for preencoded packets, paces them, and reports diagnostics", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const factory = vi.fn(fakeCodec);
    const runtime = createVoiceRuntime(
      {
        sendOpus: (value, samples) => {
          expect(value).toEqual(packet);
          expect(samples).toBe(960);
          times.push(performance.now());
        },
      },
      { codecFactory: factory, diagnostics: true },
    );
    const events: string[] = [];
    runtime.on("audioStart", () => events.push("start"));
    runtime.on("audioEnd", (reason) => events.push(reason));
    const play = runtime.play(chunks(packet, packet, packet), opus);
    await vi.advanceTimersByTimeAsync(100);
    await play;
    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(20);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(20);
    expect(factory).not.toHaveBeenCalled();
    expect(runtime.diagnostics).toMatchObject({ frames: 3, samples: 2880, bytes: 9 });
    expect(runtime.diagnostics?.processMs).toBeGreaterThanOrEqual(0);
    expect(events).toEqual(["start", "completed"]);
    await runtime.destroy();
  });

  it("does not add sink processing time to every 20ms frame interval", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const runtime = createVoiceRuntime({
      async sendOpus() {
        times.push(performance.now());
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      },
    });
    const playback = runtime.play(chunks(packet, packet, packet, packet, packet), opus);
    await vi.advanceTimersByTimeAsync(200);
    await playback;
    expect(times.map((time) => time - times[0]!)).toEqual([0, 20, 40, 60, 80]);
    await runtime.destroy();
  });

  it("creates a PCM encoder only on demand, frames PCM, and closes once", async () => {
    vi.useFakeTimers();
    const codec = fakeCodec();
    const factory = vi.fn(() => codec);
    const send = vi.fn();
    const runtime = createVoiceRuntime(
      { sendOpus: send },
      { codecFactory: factory, channels: 1, bitrate: 64_000 },
    );
    await runtime.play(chunks());
    expect(factory).not.toHaveBeenCalled();
    const play = runtime.play(chunks(Buffer.alloc(1920), Buffer.alloc(2)));
    await vi.advanceTimersByTimeAsync(100);
    await play;
    expect(factory).toHaveBeenCalledWith(1);
    expect(codec.setBitrate).toHaveBeenCalledWith(64_000);
    expect(codec.encode).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(runtime.diagnostics).toBeUndefined();
    await Promise.all([runtime.destroy(), runtime.destroy()]);
    expect(codec.close).toHaveBeenCalledTimes(1);
    await expect(runtime.play(chunks())).rejects.toThrow("destroyed");
  });

  it("honors sink backpressure and never catches up after a slow send", async () => {
    vi.useFakeTimers();
    let pulls = 0;
    let finish: (() => void) | undefined;
    const times: number[] = [];
    async function* source(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 3; i++) {
        pulls++;
        yield packet;
      }
    }
    const runtime = createVoiceRuntime({
      sendOpus: () => {
        times.push(performance.now());
        if (times.length === 1)
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
      },
    });
    const play = runtime.play(source(), opus);
    await vi.advanceTimersByTimeAsync(200);
    expect(pulls).toBe(1);
    expect(times).toHaveLength(1);
    finish?.();
    await vi.advanceTimersByTimeAsync(19);
    expect(times).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await play;
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(220);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(20);
    await runtime.destroy();
  });

  it("pauses pulls and sends, resumes without bursts, and rejects concurrent play", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const runtime = createVoiceRuntime({ sendOpus: send });
    const events: string[] = [];
    runtime.on("audioPause", () => events.push("pause"));
    runtime.on("audioResume", () => events.push("resume"));
    const play = runtime.play(chunks(packet, packet), opus);
    await expect(runtime.play(chunks(packet), opus)).rejects.toThrow("already active");
    await vi.advanceTimersByTimeAsync(0);
    runtime.pause();
    runtime.pause();
    await vi.advanceTimersByTimeAsync(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(runtime.state).toBe("paused");
    runtime.resume();
    runtime.resume();
    await vi.advanceTimersByTimeAsync(19);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await play;
    expect(events).toEqual(["pause", "resume"]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(runtime.state).toBe("idle");
    await runtime.destroy();
  });

  it("stop interrupts pending next and noncooperative return without hanging", async () => {
    let returned = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: () => {
          returned++;
          return new Promise(() => {});
        },
      }),
    };
    const runtime = createVoiceRuntime({ sendOpus: vi.fn() });
    const ends: AudioEndReason[] = [];
    runtime.on("audioEnd", (reason) => ends.push(reason));
    const play = runtime.play(source, opus);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all([runtime.stop(), runtime.stop()]);
    await play;
    expect(returned).toBe(1);
    expect(ends).toEqual(["stopped"]);
    expect(runtime.state).toBe("idle");
    await runtime.play(chunks(), opus);
    await runtime.destroy();
  });

  it("aborts pending PCM reads, cleans the source, and preserves the abort reason", async () => {
    const controller = new AbortController();
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: returned }),
    };
    const runtime = createVoiceRuntime({ sendOpus: vi.fn() });
    const end = vi.fn();
    runtime.on("audioEnd", end);
    const play = runtime.play(source, { signal: controller.signal });
    const rejected = expect(play).rejects.toThrow("cancelled");
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("cancelled"));
    await rejected;
    expect(returned).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith("aborted");
    await runtime.destroy();
  });

  it("surfaces errors once and enforces packet size and explicit duration", async () => {
    const failure = new Error("sink failed");
    const runtime = createVoiceRuntime(
      {
        sendOpus: () => {
          throw failure;
        },
      },
      { maxChunkBytes: 8 },
    );
    const error = vi.fn();
    const end = vi.fn();
    runtime.on("error", error);
    runtime.on("audioEnd", end);
    await expect(runtime.play(chunks(packet), opus)).rejects.toBe(failure);
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(end).toHaveBeenCalledWith("error");
    await expect(runtime.play(chunks(Buffer.alloc(9)), opus)).rejects.toThrow("maxChunkBytes");
    // Exercise runtime validation for untyped JavaScript callers.
    await expect(
      runtime.play(chunks(packet), { format: "opus" } as unknown as typeof opus),
    ).rejects.toThrow("explicit");
    await runtime.destroy();
  });

  it("stops while paused and while a sink promise is stuck", async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => new Promise<void>(() => {}));
    const runtime = createVoiceRuntime({ sendOpus: send });
    const play = runtime.play(chunks(packet, packet), opus);
    await vi.advanceTimersByTimeAsync(0);
    runtime.pause();
    await runtime.stop();
    await play;
    expect(send).toHaveBeenCalledOnce();
    expect(runtime.state).toBe("idle");
    await runtime.destroy();
  });

  it("does not send a read resolved during pause and cancels Web readers", async () => {
    vi.useFakeTimers();
    let deliver: ((value: IteratorResult<Uint8Array>) => void) | undefined;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      }),
    };
    const send = vi.fn();
    const runtime = createVoiceRuntime({ sendOpus: send });
    const play = runtime.play(source, opus);
    await vi.advanceTimersByTimeAsync(0);
    runtime.pause();
    deliver?.({ done: false, value: packet });
    await vi.advanceTimersByTimeAsync(100);
    expect(send).not.toHaveBeenCalled();
    await runtime.stop();
    await play;
    const cancel = vi.fn();
    const web = new ReadableStream<Uint8Array>({ cancel });
    const webPlay = runtime.play(web, opus);
    await vi.advanceTimersByTimeAsync(0);
    await runtime.stop();
    await webPlay;
    expect(cancel).toHaveBeenCalledOnce();
    expect(web.locked).toBe(false);
    await runtime.destroy();
  });

  it("plays actual native-encoded PCM through a fake sink", async () => {
    const packets: Buffer[] = [];
    const runtime = createVoiceRuntime({
      sendOpus: (value) => {
        packets.push(value);
      },
    });
    await runtime.play(chunks(Buffer.alloc(3840)));
    expect(packets).toHaveLength(1);
    expect(packets[0]?.length).toBeGreaterThan(0);
    await runtime.destroy();
  });
});
