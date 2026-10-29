import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { framePcm } from "../src/audio.js";

async function* chunks(...values: Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* values;
}
async function collect(source: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const result: Buffer[] = [];
  for await (const frame of source) result.push(frame);
  return result;
}

describe("PCM framing", () => {
  it("reassembles arbitrary byte boundaries without corrupting or aliasing frames", async () => {
    const pcm = Buffer.alloc(3840 * 4);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
    async function* split(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < pcm.length; i += 127) yield pcm.subarray(i, i + 127);
    }
    const frames = await collect(framePcm(split()));
    expect(frames.map((frame) => frame.length)).toEqual([3840, 3840, 3840, 3840]);
    expect(Buffer.concat(frames)).toEqual(pcm);
  });

  it("pads aligned tails, supports mono, and rejects partial samples even when padding", async () => {
    const frames = await collect(framePcm(chunks(Buffer.from([1, 2])), { channels: 1 }));
    expect(frames[0]?.length).toBe(1920);
    expect(frames[0]?.subarray(0, 4)).toEqual(Buffer.from([1, 2, 0, 0]));
    await expect(collect(framePcm(chunks(Buffer.alloc(4)), { tail: "error" }))).rejects.toThrow(
      "incomplete",
    );
    await expect(collect(framePcm(chunks(Buffer.alloc(3))))).rejects.toThrow("partial sample");
    await expect(collect(framePcm(chunks(Buffer.alloc(2))))).rejects.toThrow("partial sample");
    expect(await collect(framePcm(chunks()))).toEqual([]);
  });

  it("accepts Web and Node streams", async () => {
    const web = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(3840));
        controller.close();
      },
    });
    expect(await collect(framePcm(web))).toHaveLength(1);
    expect(await collect(framePcm(Readable.from([Buffer.alloc(3840)])))).toHaveLength(1);
    expect(web.locked).toBe(false);
  });

  it("bounds input chunks and pulls only as frames are requested", async () => {
    let pulls = 0;
    async function* input(): AsyncGenerator<Uint8Array> {
      pulls++;
      yield Buffer.alloc(3840 * 3);
      pulls++;
    }
    const frames = framePcm(input());
    await frames.next();
    await frames.next();
    expect(pulls).toBe(1);
    await frames.return(undefined);
    await expect(collect(framePcm(chunks(Buffer.alloc(9)), { maxChunkBytes: 8 }))).rejects.toThrow(
      "maxChunkBytes",
    );
  });

  it("cancels a pending read without waiting for return", async () => {
    const controller = new AbortController();
    let returned = false;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: () => {
          returned = true;
          return new Promise(() => {});
        },
      }),
    };
    const frames = framePcm(source, { signal: controller.signal });
    const next = frames.next();
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    expect(returned).toBe(true);
  });
});
